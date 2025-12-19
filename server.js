// server.js
import { createServer } from "node:http";
import { readFileSync, readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { FormData } from "undici";

const widgetHtml = await readFileSync("public/enhancer-widget-v1.html", "utf8");

// Render 上的中转服务地址
const PHOTO_PROXY_URL =
  process.env.PHOTO_PROXY_URL ||
  "https://hitpaw-enhancer.onrender.com/enhance-photo";

// imgbb key（必须）
const IMGBB_KEY = process.env.IMGBB_KEY;

// Widget domain（必须唯一，用于提交审核）
const WIDGET_DOMAIN =
  process.env.WIDGET_DOMAIN || "https://hitpaw-photo-enhancer-app-shiyao1122";

// ✅ 允许三类输入：https / data:image / /mnt/data
const enhanceInputSchema = z.object({
  image_url: z
    .string({
      required_error: "image_url is required",
      invalid_type_error: "image_url must be a string",
    })
    .refine(
      (value) =>
        /^https?:\/\//.test(value) ||
        /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value) ||
        /^\/mnt\/data\//.test(value),
      "Image URL must be an http(s) link, a data:image/...;base64,... string, or a /mnt/data/... file path."
    )
    .describe(
      "Image input: supports http(s) URLs, data:image/...;base64,..., or /mnt/data/... file path (uploaded file)."
    ),
});

// 工具返回统一结构
const replyWithResult = ({ originalUrl, enhancedUrl, status, message }) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: { originalUrl, enhancedUrl, status, message },
});

// 调用你自己的中转服务（它再去找 HitPaw）
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
  } catch (err) {
    throw new Error(`Proxy returned invalid JSON: ${err?.message ?? err}`);
  }
  if (data.error) throw new Error(`Proxy error: ${data.error}`);

  const status = data.data?.status ?? "COMPLETED";
  const enhancedUrl = data.data?.enhanced_url;
  const originalUrl = data.data?.original_url;

  return { originalUrl, enhancedUrl, status };
}

function isHttpsUrl(str) {
  return /^https:\/\//.test(str);
}
function isHttpUrl(str) {
  return /^https?:\/\//.test(str);
}
function isBase64Image(str) {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(str);
}
function isMntPath(str) {
  return /^\/mnt\/data\//.test(str);
}

// ✅ 更健壮：提取 base64 并清洗换行/空格
function extractBase64Data(dataUrl) {
  const marker = "base64,";
  const idx = dataUrl.indexOf(marker);
  if (idx === -1) throw new Error("Invalid data URL: missing base64 marker");
  const base64 = dataUrl.slice(idx + marker.length).trim().replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw new Error("Invalid base64 string: contains non-base64 characters");
  }
  // 可选：限制超大
  const MAX_BASE64_CHARS = 14_000_000;
  if (base64.length > MAX_BASE64_CHARS) {
    throw new Error("Image is too large to upload. Please use a smaller image.");
  }
  return base64;
}

// ✅ /mnt/data 文件 -> data:image/...;base64,...
async function mntPathToDataUrl(filePath) {
  // 基础安全：只允许 /mnt/data 下的文件
  if (!isMntPath(filePath)) {
    throw new Error("Only /mnt/data/... paths are supported.");
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
      ? "image/webp"
      : ext === ".gif"
      ? "image/gif"
      : null;

  if (!mime) {
    throw new Error(`Unsupported image type: ${ext || "(no ext)"}`);
  }

  const buf = await readFile(filePath);
  const b64 = buf.toString("base64");
  return `data:${mime};base64,${b64}`;
}

// 上传 base64 到 imgbb，返回 https 图片地址
async function uploadBase64ToImgbb(dataUrl) {
  if (!IMGBB_KEY) throw new Error("IMGBB_KEY not configured on server.");

  const base64 = extractBase64Data(dataUrl);

  const form = new FormData();
  form.append("key", IMGBB_KEY);
  form.append("image", base64);

  const resp = await fetch("https://api.imgbb.com/1/upload", {
    method: "POST",
    body: form,
  });

  const json = await resp.json().catch(() => null);

  if (!resp.ok || !json?.success) {
    const msg = json?.error?.message || resp.statusText || "Unknown imgbb error";
    throw new Error("Image upload to imgbb failed: " + msg);
  }

  return json.data.url; // 通常是 https://i.ibb.co/...
}

// ✅ 强制：返回给 UI 的 URL 只允许 https
function ensureHttpsOrEmpty(url) {
  return isHttpsUrl(url) ? url : "";
}

// ✅ 把各种输入统一转换成 “可给 proxy 用的 https URL”
// 返回：{ proxyUrl, originalUrlForUI }
async function normalizeInputToHttps(imageInput) {
  // 1) 已经是 http(s)
  if (isHttpUrl(imageInput)) {
    // proxy 一般能接受 https；如果是 http 你也可以强制拒绝
    return {
      proxyUrl: imageInput,
      originalUrlForUI: ensureHttpsOrEmpty(imageInput),
    };
  }

  // 2) /mnt/data/...
  if (isMntPath(imageInput)) {
    const dataUrl = await mntPathToDataUrl(imageInput);
    const httpsUrl = await uploadBase64ToImgbb(dataUrl);
    return { proxyUrl: httpsUrl, originalUrlForUI: httpsUrl };
  }

  // 3) base64 data url
  if (isBase64Image(imageInput)) {
    const httpsUrl = await uploadBase64ToImgbb(imageInput);
    return { proxyUrl: httpsUrl, originalUrlForUI: httpsUrl };
  }

  throw new Error("Unsupported image input format.");
}

function createPhotoEnhancerServer() {
  const server = new McpServer({ name: "photo-enhancer-app", version: "0.1.0" });

  // 1) 注册前端组件资源
  const widgetUri = "ui://widget/photo-enhancer-v1.html";

  // ✅ 根据你样例：原图 i.ibb.co；增强图 aliyuncs
  const WIDGET_RESOURCE_DOMAINS = [
    "https://i.ibb.co",
    "https://ai-hitpaw-us.oss-accelerate.aliyuncs.com",
  ];

  const WIDGET_CONNECT_DOMAINS = [
    "https://hitpaw-photo-enhancer-app.onrender.com",
    "https://hitpaw-enhancer.onrender.com",
    "https://i.ibb.co",
    "https://ai-hitpaw-us.oss-accelerate.aliyuncs.com",
  ];

  server.registerResource("photo-enhancer-widget-v1", widgetUri, {}, async () => ({
    contents: [
      {
        uri: widgetUri,
        mimeType: "text/html+skybridge",
        text: widgetHtml,
        _meta: {
          "openai/widgetPrefersBorder": true,
          "openai/widgetCSP": {
            connect_domains: WIDGET_CONNECT_DOMAINS,
            resource_domains: WIDGET_RESOURCE_DOMAINS,
          },
          "openai/widgetDomain": WIDGET_DOMAIN,
        },
      },
    ],
  }));

  // 2) 注册工具
  server.registerTool(
    "enhance_photo",
    {
      title: "Enhance a photo with HitPaw",
      description: "Enhance a photo using the HitPaw Photo Enhancer via the proxy service.",
      inputSchema: enhanceInputSchema,
      _meta: {
        "openai/outputTemplate": widgetUri,
        "openai/toolInvocation/invoking": "Enhancing photo",
        "openai/toolInvocation/invoked": "Enhanced photo",
      },
    },
    async (args) => {
      const imageInput = args?.image_url;
      if (!imageInput) {
        return replyWithResult({
          originalUrl: "",
          enhancedUrl: "",
          status: "ERROR",
          message: "Missing image_url.",
        });
      }

      try {
        // ✅ 统一转成 https
        const { proxyUrl, originalUrlForUI } = await normalizeInputToHttps(imageInput);

        // ✅ 调 proxy
        const { originalUrl, enhancedUrl, status } = await callPhotoProxy(proxyUrl);

        const msg =
          status === "COMPLETED"
            ? "Photo enhanced successfully."
            : `Photo enhance status: ${status}`;

        return replyWithResult({
          // ✅ 只回 https（不回 data URL）
          originalUrl: ensureHttpsOrEmpty(originalUrl) || originalUrlForUI,
          enhancedUrl: ensureHttpsOrEmpty(enhancedUrl),
          status,
          message: msg,
        });
      } catch (err) {
        // ✅ 不要回传 data:image/... 给 UI
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

// 3) MCP HTTP server
const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  console.log("Incoming request:", req.method, req.url);
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  // CORS 预检
  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    const requestHeaders = req.headers["access-control-request-headers"];
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": requestHeaders || "content-type",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  // 健康检查
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end("Photo enhancer MCP server");
    return;
  }

  // 浏览器直接访问 /mcp 时给提示
  if (req.method === "GET" && url.pathname === MCP_PATH) {
    const accept = req.headers["accept"] || "";
    if (!accept.includes("text/event-stream")) {
      res.writeHead(406, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        "This is an MCP endpoint. Use an MCP client (ChatGPT / MCP Inspector). For curl, add: Accept: text/event-stream"
      );
      return;
    }
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

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`Photo enhancer MCP server listening on http://localhost:${port}${MCP_PATH}`);
});
