// server.js (Public URL Enhancer edition)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const widgetHtml = readFileSync("public/enhancer-widget-v1.html", "utf8");

// HitPaw proxy
const PHOTO_PROXY_URL =
  process.env.PHOTO_PROXY_URL ||
  "https://hitpaw-enhancer.onrender.com/enhance-photo";

// Required for submission
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://hitpaw-photo-enhancer-app.onrender.com";
const WIDGET_DOMAIN =
  process.env.WIDGET_DOMAIN || "https://hitpaw-photo-enhancer-app-shiyao1122";

// Only allow https URLs (public)
const enhanceInputSchema = z.object({
  image_url: z
    .string({
      required_error: "image_url is required",
      invalid_type_error: "image_url must be a string",
    })
    .refine((v) => /^https:\/\//.test(v), "image_url must be a PUBLIC https URL")
    .describe(
      "PUBLIC https image URL (must be directly accessible in a browser). " +
        "Local paths like /mnt/data/... or sandbox:/mnt/data/... are not supported."
    ),
});

const replyWithResult = ({ originalUrl, enhancedUrl, status, message }) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: {
    originalUrl: originalUrl ?? "",
    enhancedUrl: enhancedUrl ?? "",
    status: status ?? "",
    message: message ?? "",
  },
});

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
  } catch {
    throw new Error(`Proxy returned non-JSON: ${text.slice(0, 300)}`);
  }

  if (data.error) {
    throw new Error(`Proxy error: ${data.error}`);
  }

  return {
    status: data.data?.status ?? "COMPLETED",
    enhancedUrl: data.data?.enhanced_url,
    originalUrl: data.data?.original_url,
  };
}

function createPhotoEnhancerServer() {
  const server = new McpServer({ name: "photo-enhancer-app", version: "3.0.0" });

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

          // Required for submission
          "openai/widgetDomain": WIDGET_DOMAIN,

          // CSP for images + network
          // - resource_domains: allow any https images (original image host varies)
          // - connect_domains: allow only your server and your proxy
          "openai/widgetCSP": {
            resource_domains: [
              PUBLIC_BASE_URL,
              "https://ai-hitpaw-us.oss-accelerate.aliyuncs.com"
            ],
            connect_domains: [
              PUBLIC_BASE_URL,
              "https://hitpaw-enhancer.onrender.com"
            ]
          },
        },
      },
    ],
  }));

  // Tool: enhance_photo (Public URL only)
  server.registerTool(
    "enhance_photo",
    {
      title: "Enhance Photo (Public URL)",
      description:
        "Enhance a photo via HitPaw. This tool ONLY accepts a PUBLIC https image URL " +
        "(must open directly in a browser). If the user uploaded a local image, ask them to provide a public https direct link.",
      inputSchema: enhanceInputSchema,
      _meta: {
        "openai/outputTemplate": widgetUri,
        "openai/toolInvocation/invoking": "Enhancing photo",
        "openai/toolInvocation/invoked": "Enhanced photo",
      },
    },
    async (args) => {
      const imageUrl = args?.image_url?.trim();

      // Extra guard: reject local paths explicitly with a friendly message
      if (!imageUrl || !/^https:\/\//.test(imageUrl)) {
        return replyWithResult({
          originalUrl: "",
          enhancedUrl: "",
          status: "ERROR",
          message:
            "This app only supports PUBLIC https image URLs. " +
            "Please provide a direct https image link (openable in browser). " +
            "Local paths like /mnt/data/... or sandbox:/mnt/data/... are not supported.",
        });
      }

      try {
        const { status, originalUrl, enhancedUrl } = await callPhotoProxy(imageUrl);
        return replyWithResult({
          originalUrl: originalUrl || imageUrl,
          enhancedUrl: enhancedUrl || "",
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

/* ===================== HTTP server ===================== */

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  // Health
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end("Photo enhancer MCP server");
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

  // MCP
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
  console.log(`Photo enhancer MCP server listening on ${PUBLIC_BASE_URL}${MCP_PATH}`);
});

