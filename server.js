// server.js
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { FormData } from "undici"; // 这行放在文件顶部的 import 里


const widgetHtml = readFileSync("public/enhancer-widget-v1.html", "utf8");

// Render 上的中转服务地址
const PHOTO_PROXY_URL =
  process.env.PHOTO_PROXY_URL ||
  "https://hitpaw-enhancer.onrender.com/enhance-photo";

// imgbb key（在运行 MCP server 的机器上要设好 IMGBB_KEY）
const IMGBB_KEY = process.env.IMGBB_KEY;
  
// tool 入参 schema
const enhanceInputSchema = {
  image_url: z.string().url().describe("The URL of the image to enhance."),
};

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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Proxy HTTP error: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  if (data.error) {
    throw new Error(`Proxy error: ${data.error}`);
  }

  // 这里对应你中转服务返回的结构：
  // {
  //   code: 200,
  //   data: {
  //     job_id,
  //     status,
  //     enhanced_url,
  //     original_url,
  //     raw: ...
  //   }
  // }
  const status = data.data?.status ?? "COMPLETED";
  const enhancedUrl = data.data?.enhanced_url;
  const originalUrl = data.data?.original_url;

  return { originalUrl, enhancedUrl, status };
}

// 判断是不是 data:image/...;base64,... 这种格式
function isBase64Image(str) {
  return /^data:image\/[a-zA-Z0-9+]+;base64,/.test(str);
}

// 把 data URL 拆出纯 base64 部分
function extractBase64Data(dataUrl) {
  const match = dataUrl.match(/^data:image\/[a-zA-Z0-9+]+;base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid data URL for image.");
  }
  return match[1]; // 真正的 base64 内容
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
    body: form
  });

  const json = await resp.json();

  if (!resp.ok || !json.success) {
    const msg = json.error?.message || resp.statusText || "Unknown imgbb error";
    throw new Error("Image upload to imgbb failed: " + msg);
  }

  // 这是公网可访问的图片 URL
  console.log(json.data.url)
  return json.data.url;
}


function createPhotoEnhancerServer() {
  const server = new McpServer({ name: "photo-enhancer-app", version: "0.1.0" });

  // 1. 注册前端组件资源 :contentReference[oaicite:5]{index=5}
  const widgetUri = "ui://widget/photo-enhancer.html";
  server.registerResource(
    "photo-enhancer-widget",
    widgetUri,
    {},
    async () => ({
      contents: [
        {
          uri: widgetUri,
          mimeType: "text/html+skybridge",
          text: widgetHtml,
          _meta: { "openai/widgetPrefersBorder": true },
        },
      ],
    })
  );

  // 2. 注册工具：enhance_photo :contentReference[oaicite:6]{index=6}
server.registerTool(
  "enhance_photo",
  {
    title: "Enhance a photo with HitPaw",
    description:
      "Enhance a photo using the HitPaw Photo Enhancer via the proxy service.",
    inputSchema: {
      image_url: z
        .string()
        .describe(
          "Image URL or data URL (data:image/...;base64,...) of the image to enhance."
        )
    },
    _meta: {
      "openai/outputTemplate": widgetUri,
      "openai/toolInvocation/invoking": "Enhancing photo",
      "openai/toolInvocation/invoked": "Enhanced photo"
    }
  },
  async (args) => {
    let imageUrl = args?.image_url;

    if (!imageUrl) {
      return replyWithResult({
        originalUrl: "",
        enhancedUrl: "",
        status: "ERROR",
        message: "Missing image_url."
      });
    }

    try {
      // 1. 如果 ChatGPT 传来的是 base64，就先上传 imgbb 获取 https URL
      let finalUrl = imageUrl;
      if (isBase64Image(imageUrl)) {
        console.log("Got base64 image, uploading to imgbb...");
        finalUrl = await uploadBase64ToImgbb(imageUrl);
        console.log("Uploaded to imgbb, url =", finalUrl);
      } else {
        console.log("Got normal URL:", imageUrl);
      }
      // 2. 用真正的 URL 调你的中转服务
      const { originalUrl, enhancedUrl, status } = await callPhotoProxy(finalUrl);

      const msg =
        status === "COMPLETED"
          ? "Photo enhanced successfully."
          : `Photo enhance status: ${status}`;

      return replyWithResult({
        originalUrl: originalUrl || finalUrl,
        enhancedUrl: enhancedUrl || "",
        status,
        message: msg
      });
    } catch (err) {
      return replyWithResult({
        originalUrl: imageUrl,
        enhancedUrl: "",
        status: "ERROR",
        message: err.message ?? "Failed to enhance photo."
      });
    }
  }
);


  return server;
}

// 3. MCP HTTP server（照 Quickstart 模板）:contentReference[oaicite:8]{index=8}
const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
	console.log("Incoming request:", req.method, req.url);  // 👈 新增这一行
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
		// 直接把浏览器请求预检里声明的头全部允许
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
  console.log(`Photo enhancer MCP server listening on http://localhost:${port}${MCP_PATH}`);
});

