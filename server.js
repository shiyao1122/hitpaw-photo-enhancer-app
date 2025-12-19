// server.js
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { FormData } from "undici";

/* ===================== 基础配置 ===================== */

const widgetHtml = readFileSync("public/enhancer-widget-v1.html", "utf8");

const PHOTO_PROXY_URL =
  process.env.PHOTO_PROXY_URL ||
  "https://hitpaw-enhancer.onrender.com/enhance-photo";

const IMGBB_KEY = process.env.IMGBB_KEY;

const WIDGET_DOMAIN =
  process.env.WIDGET_DOMAIN || "https://hitpaw-photo-enhancer-app-shiyao1122";

/* ===================== Tool Schema（关键） ===================== */

// ✅ image_url 必须是 optional
// ✅ description 必须告诉 ChatGPT：自动使用上传的图片
const enhanceInputSchema = z.object({
  image_url: z
    .string()
    .optional()
    .describe(
      "Image to enhance. If the user uploaded an image in this conversation, automatically use the uploaded image as input. If multiple images are uploaded, use the most recent one. Accepts https URLs or /mnt/data/... file paths."
    ),
});

/* ===================== 工具输出 ===================== */

const replyWithResult = ({ originalUrl, enhancedUrl, status, message }) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: { originalUrl, enhancedUrl, status, message },
});

/* ===================== 工具逻辑 ===================== */

function isHttpUrl(v) {
  return /^https?:\/\//.test(v);
}

function isMntPath(v) {
  return /^\/mnt\/data\//.test(v);
}

// /mnt/data/... → data:image/... → imgbb → https
async function uploadMntFileToImgbb(filePath) {
  if (!IMGBB_KEY) {
    throw new Error("IMGBB_KEY not configured on server.");
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
      ? "image/webp"
      : null;

  if (!mime) {
    throw new Error("Unsupported image type: " + ext);
  }

  const buf = await readFile(filePath);
  const base64 = buf.toString("base64");

  const form = new FormData();
  form.append("key", IMGBB_KEY);
  form.append("image", base64);

  const resp = await fetch("https://api.imgbb.com/1/upload", {
    method: "POST",
    body: form,
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json?.success) {
    throw new Error(json?.error?.message || "imgbb upload failed");
  }

  return json.data.url; // https://i.ibb.co/...
}

async function callPhotoProxy(imageUrl) {
  const resp = await fetch(PHOTO_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl }),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(text);

  const data = JSON.parse(text);
  return {
    status: data.data?.status ?? "COMPLETED",
    originalUrl: data.data?.original_url,
    enhancedUrl: data.data?.enhanced_url,
  };
}

/* ===================== MCP Server ===================== */

function createPhotoEnhancerServer() {
  const server = new McpServer({ name: "photo-enhancer-app", version: "1.0.0" });

  const widgetUri = "ui://widget/photo-enhancer-v1.html";

  server.registerResource("photo-enhancer-widget", widgetUri, {}, async () => ({
    contents: [
      {
        uri: widgetUri,
        mimeType: "text/html+skybridge",
        text: widgetHtml,
        _meta: {
          "openai/widgetPrefersBorder": true,
          "openai/widgetCSP": {
            resource_domains: [
              "https://i.ibb.co",
              "https://ai-hitpaw-us.oss-accelerate.aliyuncs.com",
            ],
          },
          "openai/widgetDomain": WIDGET_DOMAIN,
        },
      },
    ],
  }));

  server.registerTool(
    "enhance_photo",
    {
      title: "Enhance Photo",
      description:
        "Enhance an image using HitPaw. If the user uploaded an image, automatically enhance it.",
      inputSchema: enhanceInputSchema,
      _meta: {
        "openai/outputTemplate": widgetUri,
      },
    },
    async (args) => {
      const imageInput = args?.image_url;

      // 🔴 关键兜底：用户没上传图片，也没传参数
      if (!imageInput) {
        return replyWithResult({
          originalUrl: "",
          enhancedUrl: "",
          status: "ERROR",
          message: "Please upload an image first, then say: Enhance image.",
        });
      }

      try {
        let httpsUrl;

        if (isHttpUrl(imageInput)) {
          httpsUrl = imageInput;
        } else if (isMntPath(imageInput)) {
          httpsUrl = await uploadMntFileToImgbb(imageInput);
        } else {
          throw new Error("Unsupported image input.");
        }

        const { status, originalUrl, enhancedUrl } =
          await callPhotoProxy(httpsUrl);

        return replyWithResult({
          originalUrl: originalUrl || httpsUrl,
          enhancedUrl,
          status,
          message: "Photo enhanced successfully.",
        });
      } catch (err) {
        return replyWithResult({
          originalUrl: "",
          enhancedUrl: "",
          status: "ERROR",
          message: err.message || "Failed to enhance image.",
        });
      }
    }
  );

  return server;
}

/* ===================== HTTP ===================== */

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200).end("Photo Enhancer MCP server");
    return;
  }

  if (url.pathname === MCP_PATH) {
    const server = createPhotoEnhancerServer();
    const transport = new StreamableHTTPServerTransport({
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
});

httpServer.listen(port, () => {
  console.log(`MCP server listening on :${port}`);
});
