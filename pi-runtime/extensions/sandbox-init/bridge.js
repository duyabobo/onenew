#!/usr/bin/env node
/**
 * 沙盒内网络桥接器（TCP loopback ↔ Unix socket）。
 *
 * 在 bwrap 沙盒内运行，将两个 loopback TCP 端口桥接到挂载进来的 Unix socket：
 *   127.0.0.1:9001 ↔ /tmp/pi-socks/llm.sock  → pi-runtime → llm-proxy
 *   127.0.0.1:8080 ↔ /tmp/pi-socks/mcp.sock  → pi-runtime → mcp-proxy
 *
 * 纯字节转发，不解析协议，支持 HTTP、SSE 等所有 TCP 协议。
 * 沙盒内 pi 进程通过这两个端口完成 LLM 推理和 MCP 工具调用。
 */
"use strict";

const net = require("net");

const LLM_SOCK = process.env.PI_SOCKS_LLM || "/tmp/pi-socks/llm.sock";
const MCP_SOCK = process.env.PI_SOCKS_MCP || "/tmp/pi-socks/mcp.sock";
const LLM_PORT = 9001;
const MCP_PORT = 8080;

function startBridge(tcpPort, unixSockPath, label) {
  const server = net.createServer((tcpConn) => {
    const unixConn = net.connect(unixSockPath);

    tcpConn.pipe(unixConn);
    unixConn.pipe(tcpConn);

    tcpConn.on("error", () => unixConn.destroy());
    unixConn.on("error", () => tcpConn.destroy());
    tcpConn.on("close", () => unixConn.destroy());
    unixConn.on("close", () => tcpConn.destroy());
  });

  server.on("error", (err) => {
    process.stderr.write(`[sandbox-bridge] ${label} 错误: ${err.message}\n`);
  });

  server.listen(tcpPort, "127.0.0.1", () => {
    process.stderr.write(
      `[sandbox-bridge] ${label}: 127.0.0.1:${tcpPort} → ${unixSockPath}\n`
    );
  });
}

startBridge(LLM_PORT, LLM_SOCK, "LLM");
startBridge(MCP_PORT, MCP_SOCK, "MCP");
