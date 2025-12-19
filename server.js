// server.js
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { existsSync, mkdirSync, createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/* ===================== Config ===================== */

const widgetHtml = readFileSync("public/enhancer-widget-v1.html", "utf8");

// Your HitPaw proxy service
const PHOTO_PROXY_URL =
  process.env.PHOTO_PROXY_URL ||
  "https://hitpaw-enhancer.onrender.com/enhance-photo";

// Public base url of THIS server (used to build https file URLs)
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://hitpaw-photo-enhancer-app.onrender.com";

// Widget domain (must be unique)
const WIDGET_DOMAIN =
  process.env.WIDGET_DOMAIN || "https://hitpaw-photo-enhancer-app-shiyao1122";

// Writable directory (Render: /tmp is safest)
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/uploads";
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

/* ===================== Schemas ===================== */

// 1) upload_image tool input
// Accepts https URL or data:image/...;base64,... (recommended when user uploaded image)
const uploadInputSchema = z.object({
  image: z
    .string()
    .describe(
      [
        "Image to upload and convert into a PUBLIC https URL.",
        "Accepts:",
        "- data:image/...;base64,... (recommended for uploaded images)",
        "- https://... (remote image URL)",
        "Do NOT pass /mnt/data/... here because this server is remote and cannot access ChatGPT's local filesystem."
      ].join("\n")
    ),
});

// 2) enhance_photo tool input (optional; model should call upload_image first if needed)
const enhanceInputSchema = z.object({
  image_url: z
    .string()
    .optional()
    .describe(
      [
        "PUBLIC https URL of the image to enhance.",
        "If user uploaded an image, FIRST call upload_image with that image, then call enhance_photo with the returned url.",
        "Do NOT use /mnt/data/... with this remote tool."
      ].join("\n")
    ),
});

/* ===================== Shared Reply ===================== */

const replyWithResult = ({ originalUrl, enhancedUrl, status, message, extra }) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: {
    originalUrl: originalUrl ?? "",
    enhancedUrl: enhancedUrl ?? "",
    status: status ?? "",
    message: message ?? "",
    ...(extra || {}),
  },
});

/* ===================== Helpers ===================== */

function isHttpsUrl(v = "") {
  return /^https:\/\//.test(v);
}
function isHttpUrl(v = "") {
  return /^https?:\/\//.test(v);
}
function isDataUrl(v = "") {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(v);
}
function isMntPath(v = "") {
  return /^\/mnt\/data\//.test(v);
}
function ensureHttpsOrEmpty(v = "") {
  return isHttpsUrl(v) ? v : "";
}

function guessExtFromMime(mime) {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".bin";
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
  if (!match) throw new Error("Invalid data URL.");
  const mime = match[1];

  let b64 = match[2].trim().replace(/\s+/g, "");
  // base64url -> base64
  b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
  // padding
  const mod = b64.length % 4;
  if (mod === 2) b64 += "==";
  else if (mod === 3) b64 += "=";
  else if (mod === 1) throw new Error("Invalid base64 (likely truncated).");

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new Error("Invalid base64 characters.");
  }

  const buf = Buffer.from(b64, "base64");
  if (!buf || buf.length === 0) throw new Error("Invalid base64: decoded empty.");

  // size guard (optional)
  const MAX_BYTES = 10 * 1024 * 1024; // 10MB
  if (buf.length > MAX_BYTES) {
    throw new Error("Image too large. Please use a smaller image.");
  }

  return { mime, buf };
}

async function saveUploadBuffer(buf, mime, originalName = "upload") {
  const extFromName = path.extname(originalName);
  const ext = extFromName || guessExtFromMime(mime);
  const id = crypto.randomBytes(16).toString("hex");
  const filename = `${id}${ext}`;
  const filePath = path.join(UPLOAD_DIR, filename);
  await fsp.writeFile(filePath, buf);

  return {
    id,
    filename,
    filePath,
    url: `${PUBLIC_BASE_URL}/files/${filename}`,
  };
}

// Fetch an https image and store it
async function fetchAndStoreImage(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status} ${resp.statusText}`);

  const ct = resp.headers.get("content-type") || "";
  if (!ct.startsWith("image/")) {
    throw new Error(`URL is not an image (content-type: ${ct || "unknown"})`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return saveUploadBuffer(buf, ct.split(";")[0].trim(), "fetched");
}

/* ===================== HitPaw Proxy Call ===================== */

async function callPhotoProxy(imageUrl) {
  const resp = await fetch(PHOTO_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ image_url: imageUrl }),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Proxy HTTP error: ${resp.status} ${text}`);

  const data = JSON.parse(text);
  return {
    status: data.data?.status ?? "COMPLETED",
    originalUrl: data.data?.original_url,
    enhancedUrl: data.data?.enhanced_url,
  };
}

/* ===================== MCP Server ===================== */

function createPhotoEnhancerServer() {
  const server = new McpServer({ name: "photo-enhancer-app", version: "1.2.0" });

  const widgetUri = "ui://widget/photo-enhancer-v1.html";

  // Widget resource
  server.registerResource("photo-enhancer-widget-v1", widgetUri, {}, async () => ({
    contents: [
      {
        uri: widgetUri,
        mimeType: "text/html+skybridge",
        text: widgetHtml,
        _meta: {
          "openai/widgetPrefersBorder": true,
          "openai/widgetDomain": WIDGET_DOMAIN,
          "openai/widgetCSP": {
            // must allow where images come from
            resource_domains: [
              PUBLIC_BASE_URL,
              "https://ai-hitpaw-us.oss-accelerate.aliyuncs.com",
              "https://i.ibb.co",
            ],
            connect_domains: [
              PUBLIC_BASE_URL,
              "https://hitpaw-enhancer.onrender.com",
            ],
          },
        },
      },
    ],
  }));

  /* -------- Tool 1: upload_image -------- */
  server.registerTool(
    "upload_image",
    {
      title: "Upload Image",
      description: [
        "Upload an image and return a PUBLIC https URL hosted by this app.",
        "Use this FIRST when the user uploaded an image in chat, then pass the returned url to enhance_photo.",
        "Do NOT pass /mnt/data/... because this tool runs on a remote server."
      ].join(" "),
      inputSchema: uploadInputSchema,
      _meta: {
        "openai/toolInvocation/invoking": "Uploading image",
        "openai/toolInvocation/invoked": "Image uploaded",
      },
    },
    async (args) => {
      const input = (args?.image || "").trim();

      try {
        if (!input) {
          return replyWithResult({
            status: "ERROR",
            message:
              "No image provided. Provide a data:image/... base64 string or an https image URL.",
            extra: { url: "" },
          });
        }

        if (isMntPath(input)) {
          // remote server cannot read it
          return replyWithResult({
            status: "ERROR",
            message:
              "Cannot access /mnt/data/... on a remote server. Please provide the image as data:image/... base64 or an https URL.",
            extra: { url: "" },
          });
        }

        let saved;
        if (isDataUrl(input)) {
          const { mime, buf } = parseDataUrl(input);
          saved = await saveUploadBuffer(buf, mime, "uploaded");
        } else if (isHttpUrl(input)) {
          saved = await fetchAndStoreImage(input);
        } else {
          return replyWithResult({
            status: "ERROR",
            message:
              "Unsupported image format. Use data:image/...;base64,... or https://...",
            extra: { url: "" },
          });
        }

        return replyWithResult({
          status: "COMPLETED",
          message: "Uploaded.",
          extra: { url: saved.url },
        });
      } catch (err) {
        return replyWithResult({
          status: "ERROR",
          message: err?.message ?? "Upload failed.",
          extra: { url: "" },
        });
      }
    }
  );

  /* -------- Tool 2: enhance_photo -------- */
  server.registerTool(
    "enhance_photo",
    {
      title: "Enhance Photo (HitPaw)",
      description: [
        "Enhance an image via HitPaw proxy.",
        "Input MUST ultimately be a PUBLIC https URL.",
        "If user uploaded an image, FIRST call upload_image to get a public url, THEN call enhance_photo.",
        "If you only have data:image/... base64, you may pass it directly and the server will host it before enhancing."
      ].join(" "),
      inputSchema: enhanceInputSchema,
      _meta: {
        "openai/outputTemplate": widgetUri,
        "openai/toolInvocation/invoking": "Enhancing photo",
        "openai/toolInvocation/invoked": "Enhanced photo",
      },
    },
    async (args) => {
      const input = (args?.image_url || "").trim();

      if (!input) {
        return replyWithResult({
          originalUrl: "",
          enhancedUrl: "",
          status: "ERROR",
          message:
            "No image_url provided. If the user uploaded an image, call upload_image first, then call enhance_photo with the returned url.",
        });
      }

      if (isMntPath(input)) {
        return replyWithResult({
          originalUrl: "",
          enhancedUrl: "",
          status: "ERROR",
          message:
            "Cannot access /mnt/data/... on a remote server. Call upload_image first to obtain a public https URL.",
        });
      }

      try {
        // 1) Normalize to public https URL
        let publicUrl = "";

        if (isHttpsUrl(input)) {
          publicUrl = input;
        } else if (isDataUrl(input)) {
          // accept data url directly as a fallback: host it on /files then proceed
          const { mime, buf } = parseDataUrl(input);
          const saved = await saveUploadBuffer(buf, mime, "from-data-url");
          publicUrl = saved.url;
        } else if (isHttpUrl(input)) {
          // allow http -> store as https served from our /files
          const saved = await fetchAndStoreImage(input);
          publicUrl = saved.url;
        } else {
          throw new Error("Unsupported input. Use https URL or data:image base64.");
        }

        // 2) Call HitPaw proxy
        const { status, originalUrl, enhancedUrl } = await callPhotoProxy(publicUrl);

        return replyWithResult({
          originalUrl: ensureHttpsOrEmpty(originalUrl) || publicUrl,
          enhancedUrl: ensureHttpsOrEmpty(enhancedUrl),
          status,
          message:
            status === "COMPLETED"
              ? "Photo enhanced successfully."
              : `Photo enhance status: ${status}`,
        });
      } catch (err) {
        return replyWithResult({
          originalUrl: "",
          enhancedUrl: "",
          status: "ERROR",
          message: err?.message ?? "Failed to enhance photo.",
        });
      }
    }
  );

  return server;
}

/* ===================== HTTP Server (includes /upload + /files + /mcp) ===================== */

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Minimal multipart parser: supports single file field name="file"
function parseMultipartSingleFile(bodyBuf, boundary) {
  const boundaryStr = `--${boundary}`;
  const body = bodyBuf.toString("binary");
  const parts = body.split(boundaryStr).slice(1, -1);

  for (const raw of parts) {
    const part = Buffer.from(raw, "binary");
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;

    const headerStr = part.slice(0, headerEnd).toString("utf8");
    const content = part.slice(headerEnd + 4, part.length - 2); // trim last \r\n

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    if (nameMatch[1] !== "file") continue;

    const filenameMatch = headerStr.match(/filename="([^"]*)"/);
    const mimeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

    const filename = filenameMatch?.[1] || "upload";
    const mime = mimeMatch?.[1]?.trim() || "application/octet-stream";

    return { filename, mime, content };
  }
  return null;
}

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.writeHead(400).end("Missing URL");
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    // health
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain" }).end("Photo enhancer server");
      return;
    }

    // POST /upload (multipart/form-data; field=file)
    if (req.method === "POST" && url.pathname === "/upload") {
      const ct = req.headers["content-type"] || "";
      const m = ct.match(/multipart\/form-data;\s*boundary=(.+)$/i);
      if (!m) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ ok: false, error: "Expected multipart/form-data" })
        );
        return;
      }

      const boundary = m[1];
      const body = await readRequestBody(req);
      const file = parseMultipartSingleFile(body, boundary);

      if (!file) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ ok: false, error: 'No file field named "file"' })
        );
        return;
      }

      const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
      if (!allowed.has(file.mime)) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ ok: false, error: `Unsupported mime: ${file.mime}` })
        );
        return;
      }

      const saved = await saveUploadBuffer(file.content, file.mime, file.filename);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: true, url: saved.url, id: saved.id })
      );
      return;
    }

    // GET /files/<filename>
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const filename = url.pathname.replace("/files/", "");

      // basic safety: allow hexname + ext
      if (!/^[a-f0-9]{32}\.[a-z0-9]+$/i.test(filename)) {
        res.writeHead(404).end("Not Found");
        return;
      }

      const filePath = path.join(UPLOAD_DIR, filename);
      if (!existsSync(filePath)) {
        res.writeHead(404).end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const mime =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".png"
          ? "image/png"
          : ext === ".webp"
          ? "image/webp"
          : ext === ".gif"
          ? "image/gif"
          : "application/octet-stream";

      res.writeHead(200, {
        "content-type": mime,
        "cache-control": "public, max-age=86400",
      });
      createReadStream(filePath).pipe(res);
      return;
    }

    // CORS preflight for MCP
    if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
      const requestHeaders = req.headers["access-control-request-headers"];
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
        "Access-Control-Allow-Headers": requestHeaders || "content-type",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      });
      res.end();
      return;
    }

    // MCP endpoint
    const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
    if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

      const server = createPhotoEnhancerServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404).end("Not Found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end("Internal server error");
  }
});

httpServer.listen(port, () => {
  console.log(`Server listening on ${PUBLIC_BASE_URL} (port ${port})`);
  console.log(`MCP: ${PUBLIC_BASE_URL}${MCP_PATH}`);
});
