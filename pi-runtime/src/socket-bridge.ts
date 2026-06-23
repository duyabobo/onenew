/**
 * Socket Bridge：在 pi-runtime 进程中为沙盒提供"网络白名单"。
 *
 * 原理：
 *   bwrap 沙盒使用 --unshare-net 完全隔离网络，但可通过 --ro-bind 挂载
 *   Unix domain socket 文件。沙盒内的 bridge.js 将这些 socket 暴露为
 *   loopback TCP 端口，供 pi 通过 HTTP 访问。
 *
 * 此模块在 pi-runtime 侧运行，持有 socket 文件并转发到实际服务：
 *   /tmp/pi-socks/llm.sock  →  llm-proxy TCP
 *   /tmp/pi-socks/mcp.sock  →  mcp-proxy TCP
 *
 * 安全性：
 *   - socket 文件由 pi-runtime 创建，以 --ro-bind 只读方式挂载进沙盒
 *   - pi 只能连接，无法创建或替换 socket 文件
 *   - 沙盒内唯一的网络出口就是这两个 socket
 */
import net from "net";
import fs from "fs";
import path from "path";

export const SOCKS_DIR = "/tmp/pi-socks";

const LLM_SOCK = path.join(SOCKS_DIR, "llm.sock");
const MCP_SOCK = path.join(SOCKS_DIR, "mcp.sock");

/**
 * 创建一个 Unix socket 服务器，将入站连接透明转发到 targetHost:targetPort。
 * 纯字节管道，不解析协议，支持 HTTP、SSE 等所有 TCP 上层协议。
 */
function createUnixSocketProxy(
  sockPath: string,
  targetHost: string,
  targetPort: number
): net.Server {
  const server = net.createServer((clientConn) => {
    const targetConn = net.connect(targetPort, targetHost);

    clientConn.pipe(targetConn);
    targetConn.pipe(clientConn);

    clientConn.on("error", () => targetConn.destroy());
    targetConn.on("error", () => clientConn.destroy());
    clientConn.on("close", () => targetConn.destroy());
    targetConn.on("close", () => clientConn.destroy());
  });

  server.on("error", (err) => {
    console.error(`[socket-bridge] 错误 sock=${sockPath}:`, err.message);
  });

  server.listen(sockPath, () => {
    console.log(
      `[socket-bridge] ${sockPath} → ${targetHost}:${targetPort}`
    );
  });

  return server;
}

/**
 * 启动两个 Unix socket 代理服务器。
 * 在 worker.ts 启动时调用一次，整个进程生命周期内持续运行。
 */
export function startSocketBridge(
  llmProxyHost: string,
  llmProxyPort: number,
  mcpProxyHost: string,
  mcpProxyPort: number
): void {
  fs.mkdirSync(SOCKS_DIR, { recursive: true });

  // 清理残留的 socket 文件（容器重启时可能存在）
  for (const sockPath of [LLM_SOCK, MCP_SOCK]) {
    try { fs.unlinkSync(sockPath); } catch { /* 不存在则忽略 */ }
  }

  createUnixSocketProxy(LLM_SOCK, llmProxyHost, llmProxyPort);
  createUnixSocketProxy(MCP_SOCK, mcpProxyHost, mcpProxyPort);
}
