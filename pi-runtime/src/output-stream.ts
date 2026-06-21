import Redis from "ioredis";
import { appendEventSnapshot } from "./mongo-client";
import { config } from "./config";

// Redis Stream key 模板（与 gateway 保持一致）
const STREAM_KEY_TPL = "session:{sessionId}:stream";

function buildStreamKey(sessionId: string): string {
  return STREAM_KEY_TPL.replace("{sessionId}", sessionId);
}

export type EventType = "token" | "tool_call" | "tool_result" | "done" | "error";

export interface OutputEvent {
  event_type: EventType;
  content: string;
}

export class SessionOutputStream {
  private readonly streamKey: string;
  private pushCount = 0;
  // 内存中积累所有非 done 事件，session 结束时一次性写入 MongoDB snapshot
  private readonly pendingSnapshot: Array<Record<string, string>> = [];

  constructor(
    private readonly redis: Redis,
    private readonly sessionId: string
  ) {
    this.streamKey = buildStreamKey(sessionId);
  }

  async push(event: OutputEvent): Promise<void> {
    const msgId = await this.redis.xadd(
      this.streamKey,
      "*",
      "event_type",
      event.event_type,
      "content",
      event.content
    );
    this.pushCount++;
    if (this.pushCount === 1) {
      console.log(`[stream] session ${this.sessionId}: 首条事件写入 Redis Stream key=${this.streamKey} msg_id=${msgId} event_type=${event.event_type}`);
    }
    // 将用户可见的事件（token/tool_call/tool_result）加入 snapshot 缓冲
    // done/error 由 pushDone/pushError 单独处理，避免重复写入
    if (event.event_type !== "done" && event.event_type !== "error") {
      this.pendingSnapshot.push({ event_type: event.event_type, content: event.content });
    }
  }

  async pushDone(): Promise<void> {
    await this.push({ event_type: "done", content: "" });
    console.log(`[stream] session ${this.sessionId}: done 事件已推送，累计 ${this.pushCount} 条`);
    // 一次性将所有事件批量写入 MongoDB snapshot（不在 for 循环里逐条写 DB）
    await this._flushSnapshot();
  }

  async pushError(message: string): Promise<void> {
    await this.push({ event_type: "error", content: message });
    console.error(`[stream] session ${this.sessionId}: error 事件已推送: ${message}`);
    await this._flushSnapshot();
  }

  /**
   * 将内存中积累的事件一次性批量写入 MongoDB。
   * 使用 $push + $each 一条 updateOne，避免 N 次 DB 写入。
   */
  private async _flushSnapshot(): Promise<void> {
    if (this.pendingSnapshot.length === 0) return;
    await appendEventSnapshot(this.sessionId, this.pendingSnapshot);
    console.log(`[stream] session ${this.sessionId}: snapshot 已写入 MongoDB，共 ${this.pendingSnapshot.length} 条事件`);
    this.pendingSnapshot.length = 0;
  }

  // 设置 Stream 自动过期（任务完成后 1 小时清理）
  async expire(seconds: number = 3600): Promise<void> {
    await this.redis.expire(this.streamKey, seconds);
    console.log(`[stream] session ${this.sessionId}: Stream 已设置过期 TTL=${seconds}s`);
  }
}

let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (!redisClient) throw new Error("Redis 未连接，请先调用 connectRedis()");
  return redisClient;
}

export async function connectRedis(): Promise<Redis> {
  redisClient = new Redis(config.redis.url);
  redisClient.on("error", (err) => console.error("[redis] 连接错误:", err));
  console.log(`[redis] 已连接: ${config.redis.url}`);
  return redisClient;
}

export async function disconnectRedis(): Promise<void> {
  await redisClient?.quit();
  redisClient = null;
}
