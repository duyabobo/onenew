/**
 * pi-runtime 主入口：订阅 Redis Pub/Sub 任务频道，
 * 为每个新 session 启动 pi agent（含 bwrap 沙盒），
 * 将输出推送到 Redis Stream。
 */
import Redis from "ioredis";
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

// 并发处理中的 session 集合，防止重复消费
const activeSessions = new Set<string>();

async function processSession(payload: TaskPayload): Promise<void> {
  const { session_id, user_id, request } = payload;

  if (activeSessions.has(session_id)) {
    console.warn(`[worker] session ${session_id} 已在处理中，跳过重复任务`);
    return;
  }

  activeSessions.add(session_id);
  const outputStream = new SessionOutputStream(getRedis(), session_id);

  try {
    console.log(`[worker] 开始处理 session ${session_id} user=${user_id}`);
    await updateSessionStatus(session_id, "RUNNING");

    const sandboxPaths = await createSandbox(session_id);

    await runPiSession(session_id, request, sandboxPaths, outputStream);

    await outputStream.expire(3600);
    await updateSessionStatus(session_id, "COMPLETED");
    console.log(`[worker] session ${session_id} 执行完成`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] session ${session_id} 执行失败:`, message);

    await outputStream.pushError(message).catch(() => {});
    await outputStream.pushDone().catch(() => {});
    await updateSessionStatus(session_id, "FAILED", { error: message });
  } finally {
    await destroySandbox(session_id).catch((err) =>
      console.error(`[worker] 销毁沙盒失败: session=${session_id}`, err)
    );
    activeSessions.delete(session_id);
  }
}

async function startSubscriber(): Promise<Redis> {
  // 订阅连接需要独立的 Redis 客户端（订阅模式下不能执行普通命令）
  const subscriber = new Redis(config.redis.url);

  subscriber.on("error", (err) => console.error("[subscriber] Redis 错误:", err));

  await subscriber.subscribe(config.redis.taskChannel);
  console.log(`[worker] 已订阅任务频道: ${config.redis.taskChannel}`);

  subscriber.on("message", (channel, message) => {
    if (channel !== config.redis.taskChannel) return;

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
  });

  return subscriber;
}

async function main(): Promise<void> {
  console.log("[worker] pi-runtime 启动中...");

  await connectMongo();
  await connectRedis();
  const subscriber = await startSubscriber();

  console.log("[worker] pi-runtime 就绪，等待任务...");

  // 统一的优雅关闭逻辑
  const shutdown = async () => {
    console.log("[worker] pi-runtime 正在关闭...");
    await subscriber.unsubscribe(config.redis.taskChannel);
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
