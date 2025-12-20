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

// HitPaw proxy service
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

// Tool 1: upload_image
// Accepts sandbox:/mnt/data/..., /mnt/data/..., https://...
const uploadInputSchema = z.object({
  file: z
    .string()
    .describe(
      [
        "Image to upload and convert into a PUBLIC https URL hosted by this app.",
        "Accepted formats:",
        "- sandbox:/mnt/data/... (preferred when user uploaded an image)",
        "- /mnt/data/... (uploaded file path)",
        "- https://... (public image URL)",
        "Do NOT pass base64."
      ].join("\n")
    ),
});

// Tool 2: enhance_photo
const enhanceInputSchema = z.object({
  image_url: z
    .string()
    .optional()
    .describe(
      [
        "Image to enhance.",
        "Prefer a PUBLIC https URL.",
        "If you only have sandbox:/mnt/data/... or /mnt/data/..., you may pass it and the server will upload it first.",
        "If the user uploaded an image, call upload_image first, then pass the returned url here."
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
function isMntPath(v = "") {
  return /^\/mnt\/data\//.test(v);
}
function isSandboxMnt(v = "") {
  return /^sandbox:\/mnt\/data\//.test(v);
}

/**
 * ✅ 关键修复：远程 MCP 服务器不能 fetch sandbox: scheme。
 * 将 sandbox:/mnt/data/... 归一化为 /mnt/data/...
 * 然后交给平台做“路径->可下载URL”的重写/代理。
 */
function normalizeFileUrl(input) {
  if (!input) return input;
  if (input.startsWith("sandbox:")) {
    return input.replace(/^sandbox:/, ""); // sandbox:/mnt/data/x -> /mnt/data/x
  }
  return input;
}

function ensureHttpsOrEmpty(v = "") {
  return isHttpsUrl(v) ? v : "";
}

async function saveUploadBuffer(buf, mime, originalName = "upload") {
  const extFromName = path.extname(originalName);
  const ext =
    extFromName ||
    (mime === "image/jpeg"
      ? ".jpg"
      : mime === "image/png"
      ? ".png"
      : mime === "image/webp"
      ? ".webp"
      : mime === "image/gif"
      ? ".gif"
      : ".bin");

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

/**
 * 统一从任意“可定位图片”的输入中拿到 bytes 并入库到 /files
 * 支持：
 * - https://... （直接 fetch）
 * - /mnt/data/... （平台会把它转换成可下载URL供 fetch）
 * - sandbox:/mnt/data/... （先 normalize 再走上一条）
 */
async function fetchAndStoreImage(anyUrlOrPath) {
  const normalized = normalizeFileUrl(anyUrlOrPath);

  // 只允许这三类输入，避免误传导致 fetch 解析失败
  const ok =
    isHttpUrl(normalized) ||
    isMntPath(normalized); // 注意：normalize 后 sandbox 会变成 /mnt/data

  if (!ok) {
    throw new Error(
      `Unsupported image locator: ${anyUrlOrPath}. Use https://..., /mnt/data/..., or sandbox:/mnt/data/...`
    );
  }

  const resp = await fetch(normalized);
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Failed to fetch image: ${resp.status} ${resp.statusText} ${txt}`.trim());
  }

  const ct = resp.headers.get("content-type") || "";
  if (!ct.startsWith("image/")) {
    throw new Error(`Fetched content is not an image (content-type: ${ct || "unknown"})`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());

  // optional size guard
  const MAX_BYTES = 15 * 1024 * 1024;
  if (buf.length > MAX_BYTES) throw new Error("Image too large. Please use a smaller image.");

  return saveUploadBuffer(buf, ct.split(";")[0].trim(), "uploaded");
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

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Proxy returned non-JSON: ${text.slice(0, 300)}`);
  }

  if (data.error) throw new Error(`Proxy error: ${data.error}`);

  return {
    status: data.data?.status ?? "COMPLETED",
    originalUrl: data.data?.original_url,
    enhancedUrl: data.data?.enhanced_url,
  };
}

/* ===================== MCP Server ===================== */

function createPhotoEnhancerServer() {
  const server = new McpServer({ name: "photo-enhancer-app", version: "2.0.0" });

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

          // ✅ submission requires both
          "openai/widgetDomain": WIDGET_DOMAIN,
          "openai/widgetCSP": {
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

  // Tool 1: upload_image
  server.registerTool(
    "upload_image",
    {
      title: "Upload Image",
      description:
        "Upload an image and return a PUBLIC https URL hosted by this app. " +
        "Use this FIRST when the user uploaded an image in chat, then pass the returned url to enhance_photo. " +
        "Input can be sandbox:/mnt/data/... or /mnt/data/... or https://...",
      inputSchema: uploadInputSchema,
      _meta: {
        "openai/toolInvocation/invoking": "Uploading image",
        "openai/toolInvocation/invoked": "Image uploaded",
      },
    },
    async (args) => {
      const input = (args?.file || "").trim();

      if (!input) {
        return replyWithResult({
          status: "ERROR",
          message: "Missing file. Provide sandbox:/mnt/data/... or /mnt/data/... or https://...",
          extra: { url: "" },
        });
      }

      try {
        // ✅ 核心：支持 sandbox:/mnt/data/...
        const saved = await fetchAndStoreImage(input);
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

  // Tool 2: enhance_photo
  server.registerTool(
    "enhance_photo",
    {
      title: "Enhance Photo (HitPaw)",
      description:
        "Enhance an image via HitPaw proxy. Prefer a PUBLIC https URL. " +
        "If provided sandbox:/mnt/data/... or /mnt/data/... the server will upload it first, then enhance.",
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

      try {
        let publicUrl = "";

        // 1) already https
        if (isHttpsUrl(input)) {
          publicUrl = input;
        }
        // 2) http (store then use our https)
        else if (isHttpUrl(input)) {
          const saved = await fetchAndStoreImage(input);
          publicUrl = saved.url;
        }
        // 3) /mnt/data or sandbox:/mnt/data -> store then use our https
        else if (isMntPath(input) || isSandboxMnt(input)) {
          const saved = await fetchAndStoreImage(input);
          publicUrl = saved.url;
        } else {
          throw new Error(
            "Unsupported image_url. Use https://..., /mnt/data/..., or sandbox:/mnt/data/..."
          );
        }

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
