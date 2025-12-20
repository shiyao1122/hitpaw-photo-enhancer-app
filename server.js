// server.js (Dual-mode: public url + upload_image auto-host)
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
  process.env.PHOTO_PROXY_URL || "https://hitpaw-enhancer.onrender.com/enhance-photo";

// Public base URL for THIS server (Render)
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://hitpaw-photo-enhancer-app.onrender.com";

// Widget domain (must be unique for submission)
const WIDGET_DOMAIN =
  process.env.WIDGET_DOMAIN || "https://hitpaw-photo-enhancer-app-shiyao1122";

// Upload dir (Render: /tmp is safest writable path)
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/uploads";
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

/* ===================== Schemas ===================== */

// upload_image: accept local path reference OR public url.
// NOTE: We DO NOT accept base64 to avoid truncation.
const uploadInputSchema = z.object({
  file: z
    .string()
    .describe(
      [
        "Upload an image and return a PUBLIC https URL hosted by this app.",
        "Input can be:",
        "- a public https URL",
        "- a platform-provided download URL (http/https) for an uploaded file",
        "- a local path reference like /mnt/data/... or sandbox:/mnt/data/... (the platform should transform it to a URL)",
        "Do NOT pass base64."
      ].join("\n")
    ),
});

// enhance_photo: accept public https url; we will auto-host original before sending to HitPaw proxy.
const enhanceInputSchema = z.object({
  image_url: z
    .string({
      required_error: "image_url is required",
      invalid_type_error: "image_url must be a string",
    })
    .describe(
      [
        "Image to enhance. Prefer a PUBLIC https URL.",
        "If you have a user-uploaded file reference, call upload_image first and pass the returned url here."
      ].join("\n")
    ),
});

/* ===================== Helpers ===================== */

function isHttpUrl(v = "") {
  return /^https?:\/\//i.test(v);
}
function isHttpsUrl(v = "") {
  return /^https:\/\//i.test(v);
}
function isMntPath(v = "") {
  return /^\/mnt\/data\//.test(v);
}
function isSandboxMnt(v = "") {
  return /^sandbox:\/mnt\/data\//.test(v);
}

// IMPORTANT: sandbox: is NOT a fetchable scheme on your remote server.
// We strip it to a plain /mnt/data/... reference, but still cannot fetch it unless
// the platform already transformed it into an http(s) URL before it reached us.
function normalizeInputLocator(input) {
  if (!input) return input;
  if (input.startsWith("sandbox:")) return input.replace(/^sandbox:/, "");
  return input;
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

// Fetch image bytes from a URL and store locally
async function fetchAndStoreFromUrl(url, nameHint = "image") {
  const resp = await fetch(url);
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Failed to fetch image: ${resp.status} ${resp.statusText} ${txt}`.trim());
  }

  const ct = (resp.headers.get("content-type") || "").split(";")[0].trim();
  if (!ct.startsWith("image/")) {
    throw new Error(`Fetched content is not an image (content-type: ${ct || "unknown"})`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());

  const MAX_BYTES = 20 * 1024 * 1024;
  if (buf.length > MAX_BYTES) throw new Error("Image too large. Please use a smaller image.");

  return saveUploadBuffer(buf, ct, nameHint);
}

/**
 * Resolve any tool input into a fetchable URL.
 *
 * - If input is http(s): ok
 * - If input is sandbox:/mnt/data/... or /mnt/data/...:
 *   We cannot fetch these directly on a remote server. We rely on the platform to transform
 *   local file references into an http(s) download URL before sending them to us.
 *
 * In practice:
 * - If you still receive /mnt/data... here, you must ask the user/model to retry
 *   or provide a public https URL.
 */
function ensureFetchableUrl(inputRaw) {
  const input = normalizeInputLocator((inputRaw || "").trim());

  if (!input) throw new Error("Missing image input.");

  if (isHttpUrl(input)) return input;

  if (isSandboxMnt(inputRaw) || isMntPath(input)) {
    // Not fetchable from remote server
    throw new Error(
      "Received a local file reference (/mnt/data/...). Remote apps require a fetchable http(s) URL. " +
        "Please retry (the platform should provide a download URL), or provide a public https image link."
    );
  }

  throw new Error("Unsupported image input. Provide a public https URL or retry file upload.");
}

/* ===================== MCP reply ===================== */

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

/* ===================== HitPaw proxy call ===================== */

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
    enhancedUrl: data.data?.enhanced_url,
    originalUrl: data.data?.original_url,
  };
}

/* ===================== MCP server ===================== */

function createPhotoEnhancerServer() {
  const server = new McpServer({ name: "photo-enhancer-app", version: "4.0.0" });

  const widgetUri = "ui://widget/photo-enhancer-v1.html";

  // Resource: Widget
  server.registerResource("photo-enhancer-widget-v1", widgetUri, {}, async () => ({
    contents: [
      {
        uri: widgetUri,
        mimeType: "text/html+skybridge",
        text: widgetHtml,
        _meta: {
          "openai/widgetPrefersBorder": true,

          // Required for submission
          "openai/widgetDomain": WIDGET_DOMAIN,

          // IMPORTANT: resource_domains entries must be VALID URLs (no "https:" wildcard)
          // Since we auto-host the original on PUBLIC_BASE_URL, previews only need:
          // - our own domain (original hosted)
          // - HitPaw enhanced CDN domain
          "openai/widgetCSP": {
            resource_domains: [
              PUBLIC_BASE_URL,
              "https://ai-hitpaw-us.oss-accelerate.aliyuncs.com",
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

  // Tool 1: upload_image (auto-host)
  server.registerTool(
    "upload_image",
    {
      title: "Upload Image (Auto-host)",
      description:
        "Download an image (public URL or platform-provided file download URL) and re-host it on this app, " +
        "returning a PUBLIC https URL. Do NOT pass base64.",
      inputSchema: uploadInputSchema,
      _meta: {
        "openai/toolInvocation/invoking": "Uploading image",
        "openai/toolInvocation/invoked": "Image uploaded",
      },
    },
    async (args) => {
      try {
        const raw = args?.file ?? "";
        const fetchableUrl = ensureFetchableUrl(raw);

        // Re-host to our domain
        const saved = await fetchAndStoreFromUrl(fetchableUrl, "uploaded");
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

  // Tool 2: enhance_photo (public url OR your own hosted url)
  server.registerTool(
    "enhance_photo",
    {
      title: "Enhance Photo (HitPaw)",
      description:
        "Enhance a photo via HitPaw. Input must be a fetchable http(s) URL. " +
        "Best practice: if user uploaded a file, call upload_image first, then call enhance_photo with the returned url.",
      inputSchema: enhanceInputSchema,
      _meta: {
        "openai/outputTemplate": widgetUri,
        "openai/toolInvocation/invoking": "Enhancing photo",
        "openai/toolInvocation/invoked": "Enhanced photo",
      },
    },
    async (args) => {
      const raw = args?.image_url ?? "";
      if (!raw || typeof raw !== "string") {
        return replyWithResult({
          status: "ERROR",
          message:
            "Missing image_url. Provide a public https image URL, or call upload_image first for uploaded files.",
        });
      }

      try {
        // 1) Ensure fetchable URL (http/https). If local path slips through, return a clear error.
        const fetchableUrl = ensureFetchableUrl(raw);

        // 2) Auto-host original on our domain so widget CSP stays strict & preview always works.
        //    Even if input is already public, we host a copy.
        const hostedOriginal = await fetchAndStoreFromUrl(fetchableUrl, "original");

        // 3) Call HitPaw proxy using our hosted original URL (stable, https)
        const { status, enhancedUrl } = await callPhotoProxy(hostedOriginal.url);

        return replyWithResult({
          originalUrl: hostedOriginal.url,
          enhancedUrl: enhancedUrl || "",
          status,
          message:
            status === "COMPLETED"
              ? "Photo enhanced successfully."
              : `Photo enhance status: ${status}`,
        });
      } catch (err) {
        return replyWithResult({
          status: "ERROR",
          message: err?.message ?? "Failed to enhance photo.",
        });
      }
    }
  );

  return server;
}

/* ===================== HTTP server: /files + /mcp ===================== */

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.writeHead(400).end("Missing URL");
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    // Health check
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain" }).end("Photo enhancer server");
      return;
    }

    // Serve hosted files
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const filename = url.pathname.replace("/files/", "");
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
