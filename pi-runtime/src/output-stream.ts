import Redis from "ioredis";
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

  constructor(
    private readonly redis: Redis,
    private readonly sessionId: string
  ) {
    this.streamKey = buildStreamKey(sessionId);
  }

  async push(event: OutputEvent): Promise<void> {
    await this.redis.xadd(
      this.streamKey,
      "*",
      "event_type",
      event.event_type,
      "content",
      event.content
    );
  }

  async pushDone(): Promise<void> {
    await this.push({ event_type: "done", content: "" });
    console.log(`[stream] session ${this.sessionId}: done 事件已推送`);
  }

  async pushError(message: string): Promise<void> {
    await this.push({ event_type: "error", content: message });
    console.error(`[stream] session ${this.sessionId}: error 事件已推送: ${message}`);
  }

  // 设置 Stream 自动过期（任务完成后 1 小时清理）
  async expire(seconds: number = 3600): Promise<void> {
    await this.redis.expire(this.streamKey, seconds);
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
