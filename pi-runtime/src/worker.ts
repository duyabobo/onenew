/**
 * pi-runtime 主入口：订阅 Redis Pub/Sub 任务频道，
 * 为每个新 session 启动 pi agent（含 bwrap 沙盒），
 * 将输出推送到 Redis Stream。
 *
 * Sticky Session 机制：
 *   每个 pi-runtime 实例有唯一 instanceId（容器 hostname）。
 *   同时订阅两个频道：
 *     sessions:new              → 接收无实例绑定的新用户任务
 *     sessions:{instanceId}:new → 接收已绑定到本实例的老用户任务
 *   认领任务后，将 user → instanceId 写入 Redis（TTL 24h）。
 *   下次该 user 的任务由 gateway 直接路由到本实例，保证 workspace 连续。
 */
import Redis from "ioredis";
import os from "os";
import { config } from "./config";
import { connect as connectMongo, disconnect as disconnectMongo, updateSessionStatus } from "./mongo-client";
import { connectRedis, disconnectRedis, getRedis, SessionOutputStream } from "./output-stream";
import { createSandbox, destroySandbox } from "./sandbox";
import { runPiSession } from "./pi-session";

interface TaskPayload {
  session_id: string;
  user_id: string;
  request: string;
}

// 本实例唯一 ID（容器 hostname 天然唯一）
const INSTANCE_ID = os.hostname();

// Redis key 常量（与 gateway 保持一致）
const USER_INSTANCE_KEY_TPL = "user:{userId}:instance";
const USER_INSTANCE_TTL = 86400; // 24h

// 防止同一 session 被重复处理
const activeSessions = new Set<string>();

async function bindUserToInstance(userId: string): Promise<void> {
  const key = USER_INSTANCE_KEY_TPL.replace("{userId}", userId);
  await getRedis().setex(key, USER_INSTANCE_TTL, INSTANCE_ID);
  console.log(`[worker] user 实例绑定: user=${userId} → instance=${INSTANCE_ID}`);
}

async function processSession(payload: TaskPayload): Promise<void> {
  const { session_id, user_id, request } = payload;

  if (activeSessions.has(session_id)) {
    console.warn(`[worker] session ${session_id} 已在处理中，跳过重复任务`);
    return;
  }

  activeSessions.add(session_id);
  const outputStream = new SessionOutputStream(getRedis(), session_id);

  try {
    console.log(`[worker] 开始处理 session=${session_id} user=${user_id} instance=${INSTANCE_ID}`);

    // 认领任务，将 user 绑定到本实例（sticky session 核心）
    await bindUserToInstance(user_id);
    await updateSessionStatus(session_id, "RUNNING");

    // userId 用于确定持久化 workspace 路径，同一 user 跨 session 复用
    const sandboxPaths = await createSandbox(user_id, session_id);

    await runPiSession(session_id, request, sandboxPaths, outputStream);

    await outputStream.expire(3600);
    await updateSessionStatus(session_id, "COMPLETED");
    console.log(`[worker] session=${session_id} 执行完成`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] session=${session_id} 执行失败:`, message);

    await outputStream.pushError(message).catch(() => {});
    await outputStream.pushDone().catch(() => {});
    await updateSessionStatus(session_id, "FAILED", { error: message });
  } finally {
    // 只清理 session 临时目录，user workspace 持久保留
    await destroySandbox(user_id, session_id).catch((err) =>
      console.error(`[worker] 销毁临时目录失败: session=${session_id}`, err)
    );
    activeSessions.delete(session_id);
  }
}

function handleMessage(message: string): void {
  let payload: TaskPayload;
  try {
    payload = JSON.parse(message) as TaskPayload;
  } catch (err) {
    console.error("[worker] 无法解析任务消息:", message, err);
    return;
  }

  // 异步处理，不阻塞订阅循环
  processSession(payload).catch((err) =>
    console.error(`[worker] processSession 未捕获异常: session=${payload.session_id}`, err)
  );
}

async function startSubscriber(): Promise<Redis> {
  // 订阅连接需要独立的 Redis 客户端（订阅模式下不能执行普通命令）
  const subscriber = new Redis(config.redis.url);
  subscriber.on("error", (err) => console.error("[subscriber] Redis 错误:", err));

  // 订阅全局频道（接收新用户或无实例绑定的任务）
  const globalChannel = config.redis.taskChannel;
  // 订阅实例专属频道（接收已绑定到本实例的老用户任务）
  const instanceChannel = `sessions:${INSTANCE_ID}:new`;

  await subscriber.subscribe(globalChannel, instanceChannel);
  console.log(`[worker] 已订阅频道: [${globalChannel}] [${instanceChannel}]`);

  subscriber.on("message", (channel, message) => {
    if (channel !== globalChannel && channel !== instanceChannel) return;
    handleMessage(message);
  });

  return subscriber;
}

async function main(): Promise<void> {
  console.log(`[worker] pi-runtime 启动中... instance=${INSTANCE_ID}`);

  await connectMongo();
  await connectRedis();
  const subscriber = await startSubscriber();

  console.log("[worker] pi-runtime 就绪，等待任务...");

  const shutdown = async () => {
    console.log("[worker] pi-runtime 正在关闭...");
    await subscriber.quit();
    await disconnectRedis();
    await disconnectMongo();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[worker] 启动失败:", err);
  process.exit(1);
});
