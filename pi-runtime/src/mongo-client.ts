import { MongoClient, Db } from "mongodb";
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
    .updateOne({ _id: sessionId as unknown }, { $set: update });

  console.log(`[mongo] session ${sessionId} 状态更新 -> ${status}`);
}

export async function appendEventSnapshot(
  sessionId: string,
  event: Record<string, unknown>
): Promise<void> {
  await getDb()
    .collection("sessions")
    .updateOne(
      { _id: sessionId as unknown },
      { $push: { events_snapshot: event } as unknown }
    );
}
