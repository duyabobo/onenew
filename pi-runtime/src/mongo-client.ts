import { MongoClient, Db, Filter, Document } from "mongodb";
import { config } from "./config";

const SESSION_STATUS = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

let client: MongoClient | null = null;

function getDb(): Db {
  if (!client) throw new Error("MongoDB 未连接，请先调用 connect()");
  return client.db(config.mongo.db);
}

export async function connect(): Promise<void> {
  client = new MongoClient(config.mongo.uri);
  await client.connect();
  console.log(`[mongo] 已连接: ${config.mongo.uri}`);
}

export async function disconnect(): Promise<void> {
  await client?.close();
  client = null;
  console.log("[mongo] 连接已关闭");
}

export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const now = new Date();
  const update: Record<string, unknown> = { status, ...extra };

  if (status === SESSION_STATUS.RUNNING) {
    update.started_at = now;
  } else if (status === SESSION_STATUS.COMPLETED || status === SESSION_STATUS.FAILED) {
    update.completed_at = now;
  }

  await getDb()
    .collection("sessions")
    .updateOne({ _id: sessionId } as unknown as Filter<Document>, { $set: update });

  console.log(`[mongo] session ${sessionId} 状态更新 -> ${status}`);
}

/**
 * 批量写入事件到 events_snapshot。
 * 使用 $push + $each 一次 updateOne，避免 N 次 DB 写入。
 */
export async function appendEventSnapshot(
  sessionId: string,
  events: Array<Record<string, unknown>>
): Promise<void> {
  if (events.length === 0) return;
  await getDb()
    .collection("sessions")
    .updateOne(
      { _id: sessionId } as unknown as Filter<Document>,
      { $push: { events_snapshot: { $each: events } } } as unknown as Filter<Document>
    );
}

// ── MCP 配置读取 ─────────────────────────────────────────────────────────────

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export async function getMcpConfig(): Promise<McpConfig> {
  const raw = await getDb().collection("configs").findOne({ _id: "mcp" } as unknown as Filter<Document>);
  if (!raw) return { servers: {} };
  const { _id: _omit, ...rest } = raw;
  return rest as McpConfig;
}

// ── 启动恢复 ──────────────────────────────────────────────────────────────────

export interface OrphanedSession {
  session_id: string;
  user_id: string;
  request: string;
  skill_ids: string[];
}

/**
 * 查找所有处于 RUNNING 或 PENDING 状态的 session。
 * pi-runtime 启动时调用，用于恢复因重启而丢失的孤儿任务。
 */
export async function findOrphanedSessions(): Promise<OrphanedSession[]> {
  const docs = await getDb()
    .collection("sessions")
    .find({ status: { $in: [SESSION_STATUS.RUNNING, SESSION_STATUS.PENDING] } } as unknown as Filter<Document>)
    .toArray();

  return docs.map((doc) => ({
    session_id: String(doc._id),
    user_id: String(doc.user_id),
    request: String(doc.request ?? ""),
    skill_ids: Array.isArray(doc.skill_ids) ? (doc.skill_ids as string[]) : [],
  }));
}

// Skill 由文件系统管理（/data/sandboxes/global/skills/ 和 users/{uid}/skills/）
// pi-runtime 直接使用文件路径，不再从 MongoDB 读取 skill 内容
