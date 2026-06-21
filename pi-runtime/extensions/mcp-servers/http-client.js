#!/usr/bin/env node
/**
 * HTTP 客户端 MCP 服务器（stdio transport）。
 * 提供 http_get / http_post 工具，运行在沙盒外，可正常访问网络。
 */
"use strict";

const { createServer } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const server = createServer(
  { name: "http-client", version: "1.0.0" },
  {
    capabilities: { tools: {} },
  }
);

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "http_get",
      description: "发送 HTTP GET 请求并返回响应体",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "请求 URL" },
          headers: {
            type: "object",
            description: "可选的请求头",
            additionalProperties: { type: "string" },
          },
        },
        required: ["url"],
      },
    },
    {
      name: "http_post",
      description: "发送 HTTP POST 请求（JSON 体）并返回响应体",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "请求 URL" },
          body: { type: "object", description: "请求体（JSON）" },
          headers: {
            type: "object",
            description: "可选的请求头",
            additionalProperties: { type: "string" },
          },
        },
        required: ["url", "body"],
      },
    },
  ],
}));

server.setRequestHandler("tools/call", async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "http_get") {
    const text = await fetchUrl(args.url, "GET", null, args.headers ?? {});
    return { content: [{ type: "text", text }] };
  }

  if (name === "http_post") {
    const body = JSON.stringify(args.body);
    const extraHeaders = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body).toString(),
      ...(args.headers ?? {}),
    };
    const text = await fetchUrl(args.url, "POST", body, extraHeaders);
    return { content: [{ type: "text", text }] };
  }

  throw new Error(`未知工具: ${name}`);
});

function fetchUrl(url, method, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const req = lib.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve(`status=${res.statusCode}\n${data}`));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[http-client-mcp] 启动完成\n");
}

main().catch((err) => {
  process.stderr.write(`[http-client-mcp] 启动失败: ${err}\n`);
  process.exit(1);
});
