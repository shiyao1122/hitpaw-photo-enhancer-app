// server.js
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const widgetHtml = readFileSync("public/enhancer-widget-v1.html", "utf8");

// Render 上的中转服务地址
const PHOTO_PROXY_URL =
  process.env.PHOTO_PROXY_URL ||
  "https://hitpaw-enhancer.onrender.com/enhance-photo";

const WIDGET_DOMAIN =
  process.env.WIDGET_DOMAIN || "https://hitpaw-photo-enhancer-app-shiyao1122";

// ✅ 输入改为 optional：允许用户只说“增强图片”
// ✅ 但 description 强制模型：必须提供公网 https 图片链接（不要 /mnt/data，不要 data URL）
const enhanceInputSchema = z.object({
  image_url: z
    .string()
    .optional()
    .describe(
      [
        "Public HTTPS image URL to enhance (REQUIRED for execution).",
        "IMPORTANT:",
        "- This tool runs on a remote server and CANNOT access /mnt/data/... local paths.",
        "- Do NOT pass /mnt/data/... or data:image/... base64 URLs.",
        "- If the user uploaded an image, FIRST obtain a public https URL for that image, THEN call this tool.",
        "If multiple images are uploaded, use the most recent one."
      ].join("\n")
    ),
});

const replyWithResult = ({ originalUrl, enhancedUrl, status, message }) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: { originalUrl, enhancedUrl, status, message },
});

function isHttpsUrl(v) {
  return /^https:\/\//.test(v);
}

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

  const data = JSON.parse(text);

  const status = data.data?.status ?? "COMPLETED";
  const enhancedUrl = data.data?.enhanced_url;
  const originalUrl = data.data?.original_url;

  return { originalUrl, enhancedUrl, status };
}

function createPhotoEnhancerServer() {
  const server = new McpServer({ name: "photo-enhancer-app", version: "1.0.0" });

  // Widget resource
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
            "openai/widgetCSP": {
              resource_domains: [
                "https://i.ibb.co",
                "https://ai-hitpaw-us.oss-accelerate.aliyuncs.com",
              ],
              connect_domains: [
                "https://hitpaw-photo-enhancer-app.onrender.com",
                "https://hitpaw-enhancer.onrender.com",
                "https://i.ibb.co",
                "https://ai-hitpaw-us.oss-accelerate.aliyuncs.com",
              ],
            },
            "openai/widgetDomain": WIDGET_DOMAIN,
          },
        },
      ],
    })
  );

  // Tool
  server.registerTool(
    "enhance_photo",
    {
      title: "Enhance Photo (HitPaw)",
      description:
        [
          "Enhance an image using HitPaw via proxy.",
          "This server is remote; it cannot read /mnt/data local paths.",
          "Always pass a PUBLIC HTTPS image URL."
        ].join(" "),
      inputSchema: enhanceInputSchema,
      _meta: {
        "openai/outputTemplate": widgetUri,
        "openai/toolInvocation/invoking": "Enhancing photo",
        "openai/toolInvocation/invoked": "Enhanced photo",
      },
    },
    async (args) => {
      const imageUrl = args?.image_url?.trim();

      // ✅ 关键：没给 https，就明确要求模型生成/提供 https 再调用
      if (!imageUrl || !isHttpsUrl(imageUrl)) {
        return replyWithResult({
          originalUrl: "",
          enhancedUrl: "",
          status: "ERROR",
          message:
            "This tool requires a PUBLIC HTTPS image URL. " +
            "Local paths like /mnt/data/... and data:image/... are not accessible from this remote server. " +
            "Please provide a https:// image link (or first convert the uploaded image into a public https URL), then retry.",
        });
      }

      try {
        const { originalUrl, enhancedUrl, status } = await callPhotoProxy(imageUrl);

        return replyWithResult({
          originalUrl: originalUrl && isHttpsUrl(originalUrl) ? originalUrl : imageUrl,
          enhancedUrl: enhancedUrl && isHttpsUrl(enhancedUrl) ? enhancedUrl : "",
          status,
          message:
            status === "COMPLETED"
              ? "Photo enhanced successfully."
              : `Photo enhance status: ${status}`,
        });
      } catch (err) {
        return replyWithResult({
          originalUrl: imageUrl,
          enhancedUrl: "",
          status: "ERROR",
          message: err?.message ?? "Failed to enhance photo.",
        });
      }
    }
  );

  return server;
}

// HTTP server
const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) return res.writeHead(400).end("Missing URL");
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

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
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`Photo enhancer MCP server listening on http://localhost:${port}${MCP_PATH}`);
});
