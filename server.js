// server.js
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdirSync, existsSync, createReadStream, createWriteStream } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const widgetHtml = readFileSync("public/enhancer-widget-v1.html", "utf8");

// ====== 你的中转服务（HitPaw proxy） ======
const PHOTO_PROXY_URL =
  process.env.PHOTO_PROXY_URL ||
  "https://hitpaw-enhancer.onrender.com/enhance-photo";

// ====== 你的 Render 服务对外域名（用于拼接 /files URL） ======
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://hitpaw-photo-enhancer-app.onrender.com";

// ====== Widget domain（必须唯一）=====
const WIDGET_DOMAIN =
  process.env.WIDGET_DOMAIN || "https://hitpaw-photo-enhancer-app-shiyao1122";

// ====== 本地存储目录（Render 可写：/tmp 最稳）=====
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/uploads";
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

/* ===================== 工具 schema ===================== */
const enhanceInputSchema = z.object({
  image_url: z
    .string()
    .optional()
    .describe(
      [
        "Image to enhance.",
        "Preferred: a PUBLIC https URL.",
        "If the user uploaded an image, obtain a public https URL for it first (e.g., upload it to /upload), then call this tool.",
        "Do NOT rely on /mnt/data/... in remote servers.",
      ].join("\n")
    ),
});

/* ===================== 工具输出 ===================== */
const replyWithResult = ({ originalUrl, enhancedUrl, status, message }) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: { originalUrl, enhancedUrl, status, message },
});

/* ===================== helpers ===================== */
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
  return "";
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
  if (!match) throw new Error("Invalid data URL.");
  const mime = match[1];
  let b64 = match[2].trim().replace(/\s+/g, "");
  // base64url -> base64
  b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
  // pad
  const mod = b64.length % 4;
  if (mod === 2) b64 += "==";
  else if (mod === 3) b64 += "=";
  else if (mod === 1) throw new Error("Invalid base64: likely truncated.");
  // validate & decode
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error("Invalid base64 characters.");
  const buf = Buffer.from(b64, "base64");
  if (!buf || buf.length === 0) throw new Error("Invalid base64: decoded empty.");
  return { mime, buf };
}

/* ===================== 上传与文件服务 ===================== */

// 一个非常轻量的 multipart 解析（只支持单文件 field=file）
// 说明：够用且稳定；如果你想更强，可以后面换 busboy。
async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseMultipartSingleFile(bodyBuf, boundary) {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const parts = bodyBuf
    .toString("binary")
    .split(boundaryBuf.toString("binary"))
    .slice(1, -1);

  for (const p of parts) {
    const part = Buffer.from(p, "binary");

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;

    const headerStr = part.slice(0, headerEnd).toString("utf8");
    const content = part.slice(headerEnd + 4, part.length - 2); // 去掉末尾 \r\n

    // 只收 field name="file"
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

async function saveUploadBuffer(buf, mime, originalName = "upload") {
  const ext = path.extname(originalName) || guessExtFromMime(mime) || ".bin";
  const id = crypto.randomBytes(16).toString("hex");
  const filePath = path.join(UPLOAD_DIR, `${id}${ext}`);
  await fsp.writeFile(filePath, buf);
  return { id, ext, filePath, url: `${PUBLIC_BASE_URL}/files/${id}${ext}` };
}

/* ===================== HitPaw proxy 调用 ===================== */
async function callPhotoProxy(imageUrl) {
  const resp = await fetch(PHOTO_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ image_url: imageUrl }),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Proxy HTTP error: ${resp.status} ${text}`);

  const data = JSON.parse(text);
  const status = data.data?.status ?? "COMPLETED";
  const enhancedUrl = data.data?.enhanced_url;
  const originalUrl = data.data?.original_url;

  return { originalUrl, enhancedUrl, status };
}

/* ===================== MCP server ===================== */
function createPhotoEnhancerServer() {
  const server = new McpServer({ name: "photo-enhancer-app", version: "1.1.0" });

  const widgetUri = "ui://widget/photo-enhancer-v1.html";

  server.registerResource(
    "photo-enhancer-widget-v1",
    widgetUri,
    {},
    async () => ({
      contents: [
        {
          uri: widgetUri,
          mimeType: "text/html+skybridge",
          text: widgetHtml,
          _meta: {
            "openai/widgetPrefersBorder": true,

            // ✅ 必填
            "openai/widgetDomain": WIDGET_DOMAIN,

            // ✅ 必填：让 widget 能加载你自己 /files/ 的图片 + HitPaw OSS + i.ibb.co（如果你的 proxy 也会返回它）
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
    })
  );

  server.registerTool(
    "enhance_photo",
    {
      title: "Enhance Photo (HitPaw)",
      description:
        "Enhance an image via HitPaw proxy. Prefer a PUBLIC https URL. If user uploaded an image, first upload it to a public URL, then call this tool.",
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
            "No image provided. Please upload an image (attachment) or provide a public https URL, then try again.",
        });
      }

      // 远程 server 不能读 /mnt/data —— 给出明确指引
      if (isMntPath(input)) {
        return replyWithResult({
          originalUrl: "",
          enhancedUrl: "",
          status: "ERROR",
          message:
            "This tool runs on a remote server and cannot access /mnt/data/... paths directly. " +
            "Please convert the uploaded image to a public https URL first (e.g., upload to /upload), then retry.",
        });
      }

      let publicUrl = "";

      try {
        // 1) 已经是 http(s)
        if (isHttpUrl(input)) {
          publicUrl = input;
        }
        // 2) data URL：服务器端保存成 /files URL
        else if (isDataUrl(input)) {
          const { mime, buf } = parseDataUrl(input);
          const saved = await saveUploadBuffer(buf, mime, "from-data-url");
          publicUrl = saved.url;
        } else {
          throw new Error("Unsupported image input. Use https:// URL or data:image/... base64.");
        }

        // 3) 调 HitPaw proxy
        const { originalUrl, enhancedUrl, status } = await callPhotoProxy(publicUrl);

        return replyWithResult({
          originalUrl: ensureHttpsOrEmpty(originalUrl) || ensureHttpsOrEmpty(publicUrl),
          enhancedUrl: ensureHttpsOrEmpty(enhancedUrl),
          status,
          message:
            status === "COMPLETED"
              ? "Photo enhanced successfully."
              : `Photo enhance status: ${status}`,
        });
      } catch (err) {
        return replyWithResult({
          originalUrl: ensureHttpsOrEmpty(publicUrl),
          enhancedUrl: "",
          status: "ERROR",
          message: err?.message ?? "Failed to enhance photo.",
        });
      }
    }
  );

  return server;
}

/* ===================== HTTP server（含 /upload + /files） ===================== */
const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.writeHead(400).end("Missing URL");
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    // 健康检查
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain" }).end("Photo enhancer MCP server");
      return;
    }

    // ✅ 上传接口：POST /upload  (multipart/form-data; field=file)
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

      // 只允许常见图片 MIME
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

    // ✅ 文件访问：GET /files/<id>.<ext>
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const name = url.pathname.replace("/files/", "");
      // 基础安全：只允许 hex+ext
      if (!/^[a-f0-9]{32}\.[a-z0-9]+$/i.test(name)) {
        res.writeHead(404).end("Not Found");
        return;
      }
      const filePath = path.join(UPLOAD_DIR, name);
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
        // 缓存 1 天（可按需调整）
        "cache-control": "public, max-age=86400",
      });
      createReadStream(filePath).pipe(res);
      return;
    }

    // MCP endpoint（CORS 预检）
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
