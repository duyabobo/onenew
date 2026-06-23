/**
 * MongoDB 客户端：读取 MCP 服务配置。
 * 只读取 configs 集合中的 mcp 文档，不写入任何数据。
 */
import { MongoClient, Db, Filter, Document } from "mongodb";
import { config } from "./config.js";

let client: MongoClient | null = null;

function getDb(): Db {
  if (!client) throw new Error("MongoDB 未连接，请先调用 connect()");
  return client.db(config.mongo.db);
}

export async function connect(): Promise<void> {
  client = new MongoClient(config.mongo.uri);
  await client.connect();
  console.log(`[mcp-proxy:mongo] 已连接: ${config.mongo.uri}`);
}

export async function disconnect(): Promise<void> {
  await client?.close();
  client = null;
}

export interface McpServerEntry {
  name: string;
  url: string;
}

/**
 * 读取所有启用的 URL 类型 MCP Server 配置。
 * command 类型的本地进程在设计上不允许，直接过滤。
 */
export async function readEnabledMcpServers(): Promise<McpServerEntry[]> {
  const raw = await getDb()
    .collection("configs")
    .findOne({ _id: "mcp" } as unknown as Filter<Document>);

  if (!raw?.servers) return [];

  const servers = raw.servers as Record<string, { url?: string; enabled?: boolean }>;
  const result: McpServerEntry[] = [];

  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg.url) {
      console.warn(`[mcp-proxy] MCP server "${name}" 缺少 url 字段，已跳过`);
      continue;
    }
    if (cfg.enabled === false) continue;
    result.push({ name, url: cfg.url });
  }

  return result;
}
