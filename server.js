// server.js
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { FormData } from "undici";

const widgetHtml = readFileSync("public/enhancer-widget-v1.html", "utf8");

// Render 上的中转服务地址
const PHOTO_PROXY_URL =
  process.env.PHOTO_PROXY_URL ||
  "https://hitpaw-enhancer.onrender.com/enhance-photo";

// imgbb key（在运行 MCP server 的机器上要设好 IMGBB_KEY）
const IMGBB_KEY = process.env.IMGBB_KEY;

// Widget domain（必须唯一，用于提交审核）
const WIDGET_DOMAIN =
  process.env.WIDGET_DOMAIN || "https://hitpaw-photo-enhancer-app-shiyao1122";

// tool 入参 schema（兼容 https 链接和 data URL）
const enhanceInputSchema = z.object({
  image_url: z
    .string({
      required_error: "image_url is required",
      invalid_type_error: "image_url must be a string",
    })
    .refine(
      (value) => /^(https?:\/\/|data:image\/)/.test(value),
      "Image URL must be an https:// link or data:image/...;base64,... string."
    )
    .describe(
      "Image URL to enhance. Supports https:// links or data:image/...;base64,... strings."
    ),
});

// 工具返回统一结构
const replyWithResult = ({ originalUrl, enhancedUrl, status, message }) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: {
    originalUrl,
    enhancedUrl,
    status,
    message,
  },
});

// 调用你自己的中转服务（它再去找 HitPaw）
async function callPhotoProxy(imageUrl) {
  const resp = await fetch(PHOTO_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ image_url: imageUrl }),
  });

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(`Proxy HTTP error: ${resp.status} ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Proxy returned invalid JSON: ${err?.message ?? err}`);
  }

  if (data.error) {
    throw new Error(`Proxy error: ${data.error}`);
  }

  const status = data.data?.status ?? "COMPLETED";
  const enhancedUrl = data.data?.enhanced_url;
  const originalUrl = data.data?.original_url;

  return { originalUrl, enhancedUrl, status };
}

// 判断是不是 data:image/...;base64,... 这种格式
function isBase64Image(str) {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(str);
}

// ✅ 更健壮：提取 base64 并清洗换行/空格（关键修复点）
function extractBase64Data(dataUrl) {
  if (!dataUrl.startsWith("data:image/")) {
    throw new Error("Invalid data URL: must start with data:image/...");
  }
  const marker = "base64,";
  const idx = dataUrl.indexOf(marker);
  if (idx === -1) {
    throw new Error("Invalid data URL: missing base64 marker");
  }

  // 取出 base64 部分，去掉所有空白（imgbb 对换行/空格非常敏感）
  const base64 = dataUrl.slice(idx + marker.length).trim().replace(/\s+/g, "");

  // 粗略校验：仅允许 base64 字符
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw new Error("Invalid base64 string: contains non-base64 characters");
  }

  // 可选：避免超大图片导致失败（你可按需要调整阈值）
  // 10MB base64 大约 ~13.3MB 字符串，这里给个保守限制
  const MAX_BASE64_CHARS = 14_000_000;
  if (base64.length > MAX_BASE64_CHARS) {
    throw new Error("Image is too large to upload. Please use a smaller image.");
  }

  return base64;
}

// 上传 base64 到 imgbb，返回 https 图片地址
async function uploadBase64ToImgbb(dataUrl) {
  if (!IMGBB_KEY) {
    throw new Error("IMGBB_KEY not configured on server.");
  }

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
    const msg =
      json?.error?.message || resp.statusText || "Unknown imgbb error";
    throw new Error("Image upload to imgbb failed: " + msg);
  }

  // 公网可访问图片 URL（通常是 https://i.ibb.co/...)
  return json.data.url;
}

// ✅ 只允许 https URL 进入 UI（禁止 data URL）
function ensureHttpsUrlOrEmpty(url) {
  if (!url) return "";
  return /^https:\/\//.test(url) ? url : "";
}

function createPhotoEnhancerServer() {
  const server = new McpServer({ name: "photo-enhancer-app", version: "0.1.0" });

  // 1) 注册前端组件资源
  const widgetUri = "ui://widget/photo-enhancer-v1.html";

  // ✅ 根据你给的真实样例：original 来自 i.ibb.co；enhanced 来自 aliyuncs OSS accelerate 域名
  const WIDGET_RESOURCE_DOMAINS = [
    "https://i.ibb.co",
    "https://ai-hitpaw-us.oss-accelerate.aliyuncs.com",
  ];

  const WIDGET_CONNECT_DOMAINS = [
    // 你的 MCP server 本身（一般不需要，但放上更稳）
    "https://hitpaw-photo-enhancer-app.onrender.com",
    // 你的 proxy
    "https://hitpaw-enhancer.onrender.com",
    // 图片域名（用于打开链接/可能的安全检查）
    "https://i.ibb.co",
    "https://ai-hitpaw-us.oss-accelerate.aliyuncs.com",
  ];

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

            // ✅ 必填：Widget CSP
            "openai/widgetCSP": {
              connect_domains: WIDGET_CONNECT_DOMAINS,
              resource_domains: WIDGET_RESOURCE_DOMAINS,
            },

            // ✅ 必填：Widget Domain（唯一）
            "openai/widgetDomain": WIDGET_DOMAIN,
          },
        },
      ],
    })
  );

  // 2) 注册工具：enhance_photo
  server.registerTool(
    "enhance_photo",
    {
      title: "Enhance a photo with HitPaw",
      description:
        "Enhance a photo using the HitPaw Photo Enhancer via the proxy service.",
      inputSchema: enhanceInputSchema,
      _meta: {
        "openai/outputTemplate": widgetUri,
        "openai/toolInvocation/invoking": "Enhancing photo",
        "openai/toolInvocation/invoked": "Enhanced photo",
      },
    },
    async (args) => {
      const imageUrl = args?.image_url;
      if (!imageUrl) {
        return replyWithResult({
          originalUrl: "",
          enhancedUrl: "",
          status: "ERROR",
          message: "Missing image_url.",
        });
      }

      try {
        // 1) base64 -> imgbb -> https
        let finalUrl = imageUrl;
        let originalUrlForUI = "";

        if (isBase64Image(imageUrl)) {
          console.log("Got base64 image, uploading to imgbb...");
          finalUrl = await uploadBase64ToImgbb(imageUrl);
          originalUrlForUI = finalUrl; // ✅ UI 原图一定用 https
          console.log("Uploaded to imgbb, url =", finalUrl);
        } else {
          console.log("Got normal URL:", imageUrl);
          // ✅ 如果用户传的是 https，直接作为 UI 原图
          originalUrlForUI = ensureHttpsUrlOrEmpty(imageUrl);
        }

        // 2) 调 proxy
        const { originalUrl, enhancedUrl, status } = await callPhotoProxy(finalUrl);

        const msg =
          status === "COMPLETED"
            ? "Photo enhanced successfully."
            : `Photo enhance status: ${status}`;

        // ✅ 最终返回给 UI 的 URL：只允许 https；否则置空
        return replyWithResult({
          originalUrl: ensureHttpsUrlOrEmpty(originalUrl) || originalUrlForUI,
          enhancedUrl: ensureHttpsUrlOrEmpty(enhancedUrl),
          status,
          message: msg,
        });
      } catch (err) {
        // ✅ 关键：绝不把 data:image/... 返回给 UI
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
    res
      .writeHead(200, { "content-type": "text/plain" })
      .end("Photo enhancer MCP server");
    return;
  }

  // ✅ 可选：浏览器直接访问 /mcp 时给更友好提示
  if (req.method === "GET" && url.pathname === MCP_PATH) {
    const accept = req.headers["accept"] || "";
    if (!accept.includes("text/event-stream")) {
      res.writeHead(406, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        "This is an MCP endpoint. Use an MCP client (ChatGPT / MCP Inspector). If using curl, add header: Accept: text/event-stream"
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
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(
    `Photo enhancer MCP server listening on http://localhost:${port}${MCP_PATH}`
  );
});
