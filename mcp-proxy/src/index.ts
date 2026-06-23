/**
 * mcp-proxy 入口：HTTP 服务器，实现 MCP Streamable HTTP 协议。
 *
 * 协议规范：MCP 2025-03-26 Streamable HTTP transport
 *   - POST /mcp  接收 JSON-RPC 请求，返回 application/json 响应
 *   - GET  /health  健康检查
 *
 * 支持的 MCP 方法：
 *   - initialize        → 返回服务能力声明
 *   - notifications/*   → 确认（202，无响应体）
 *   - tools/list        → 返回聚合后的工具列表
 *   - tools/call        → 路由到对应后端 MCP Server 执行
 */
import http from "http";
import { config } from "./config.js";
import { connect as connectMongo, readEnabledMcpServers } from "./mongo-client.js";
import { McpAggregator } from "./mcp-aggregator.js";
import { getLogger } from "./logger.js";

const logger = getLogger();

const aggregator = new McpAggregator(config.toolRefreshIntervalMs);

// ── JSON-RPC 工具函数 ─────────────────────────────────────────────────────────

type JsonRpcId = string | number | null;

function jsonrpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonrpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ── MCP 请求处理 ──────────────────────────────────────────────────────────────

interface McpRequest {
  jsonrpc: string;
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

async function handleMcpRequest(body: string): Promise<unknown> {
  let req: McpRequest;
  try {
    req = JSON.parse(body) as McpRequest;
  } catch {
    return jsonrpcError(null, -32700, "Parse error");
  }

  const { id = null, method, params } = req;

  // 在每个请求上刷新工具列表（受 TTL 控制，不会每次真正重连）
  const servers = await readEnabledMcpServers();
  await aggregator.refreshIfStale(servers);

  switch (method) {
    case "initialize":
      return jsonrpcResult(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-proxy", version: "1.0.0" },
      });

    case "tools/list":
      return jsonrpcResult(id, { tools: aggregator.listTools() });

    case "tools/call": {
      const { name, arguments: args } = params as {
        name: string;
        arguments?: Record<string, unknown>;
      };
      try {
        const result = await aggregator.callTool(name, args ?? {});
        return jsonrpcResult(id, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`tools/call 失败: tool=${name} ${message}`);
        return jsonrpcError(id, -32603, message);
      }
    }

    default:
      // notifications/initialized 等通知类消息，无需响应体
      if (method.startsWith("notifications/")) return null;
      return jsonrpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ── HTTP 服务器 ───────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "POST" && req.url === "/mcp") {
    try {
      const body = await readBody(req);
      const response = await handleMcpRequest(body);

      if (response === null) {
        res.writeHead(202).end();
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (err) {
      logger.error("请求处理异常", { err });
      res.writeHead(500).end();
    }
    return;
  }

  res.writeHead(404).end();
});

// ── 主函数 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await connectMongo();

  // 启动时预热工具列表，失败不阻断启动
  const servers = await readEnabledMcpServers();
  await aggregator.refresh(servers).catch((err) =>
    logger.error("初始工具加载失败（将在首次请求时重试）", { err })
  );

  server.listen(config.port, "0.0.0.0", () => {
    logger.info(`服务已启动 port=${config.port}`);
  });

  const shutdown = async () => {
    logger.info("正在关闭...");
    server.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((err) => {
  // 用 console 兜底，因为此时 logger 可能未初始化
  console.error("[mcp-proxy] 启动失败:", err);
  process.exit(1);
});
