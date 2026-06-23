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
import { connect as connectMongo, disconnect as disconnectMongo, updateSessionStatus, findOrphanedSessions } from "./mongo-client";
import { connectRedis, disconnectRedis, getRedis, SessionOutputStream } from "./output-stream";
import { createSandbox, destroySandbox } from "./sandbox";
import { runPiSession } from "./pi-session";

interface TaskPayload {
  session_id: string;
  user_id: string;
  request: string;
  skill_ids: string[];
  conversation_id?: string;
  context?: string;     // 格式化的历史上下文，仅用于本次 pi 调用，不持久化
}

// 本实例唯一 ID（容器 hostname 天然唯一）
const INSTANCE_ID = os.hostname();

// Redis key 常量（与 gateway 保持一致）
const USER_INSTANCE_KEY_TPL = "user:{userId}:instance";
const USER_INSTANCE_TTL = 86400; // 24h

// 实例心跳 key：pi-runtime 通过此 key 向 gateway 声明自己存活
// gateway 路由前检查此 key，若不存在则认为实例已死，清除 sticky 绑定走全局频道
const INSTANCE_ALIVE_KEY_TPL = "pi:instance:{instanceId}:alive";
const INSTANCE_ALIVE_TTL = 60; // 60s，心跳每 30s 刷新一次，允许最多 2 次超时
const HEARTBEAT_INTERVAL_MS = 30_000;

// 防止同一 session 被重复处理
const activeSessions = new Set<string>();

async function registerInstanceAlive(): Promise<void> {
  const key = INSTANCE_ALIVE_KEY_TPL.replace("{instanceId}", INSTANCE_ID);
  await getRedis().setex(key, INSTANCE_ALIVE_TTL, "1");
}

async function bindUserToInstance(userId: string): Promise<void> {
  const key = USER_INSTANCE_KEY_TPL.replace("{userId}", userId);
  await getRedis().setex(key, USER_INSTANCE_TTL, INSTANCE_ID);
  console.log(`[worker] user 实例绑定: user=${userId} → instance=${INSTANCE_ID}`);
}

async function processSession(payload: TaskPayload): Promise<void> {
  const { session_id, user_id, request, skill_ids = [], context } = payload;

  if (activeSessions.has(session_id)) {
    console.warn(`[worker] session ${session_id} 已在处理中，跳过重复任务`);
    return;
  }

  activeSessions.add(session_id);
  const outputStream = new SessionOutputStream(getRedis(), session_id);
  const startAt = Date.now();

  try {
    const requestPreview = request.slice(0, 80).replace(/\n/g, " ");
    console.log(`[worker] 开始处理: session=${session_id} user=${user_id} instance=${INSTANCE_ID} skill_ids=[${skill_ids}] request='${requestPreview}'`);

    // 认领任务，将 user 绑定到本实例（sticky session 核心）
    await bindUserToInstance(user_id);
    await updateSessionStatus(session_id, "RUNNING");
    console.log(`[worker] session ${session_id}: 状态已更新为 RUNNING`);

    // userId 用于确定 session 沙盒路径（session 级隔离，不跨 session 复用）
    const sandboxPaths = await createSandbox(user_id, session_id);
    console.log(`[worker] session ${session_id}: 沙盒就绪，workspace=${sandboxPaths.workspace}`);

    console.log(`[worker] session ${session_id}: 启动 pi agent...`);
    await runPiSession(session_id, request, sandboxPaths, outputStream, skill_ids, context);

    const elapsed = Date.now() - startAt;
    await outputStream.expire(3600);
    await updateSessionStatus(session_id, "COMPLETED");
    console.log(`[worker] session ${session_id}: 执行完成，耗时 ${elapsed}ms`);
  } catch (err) {
    const elapsed = Date.now() - startAt;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] session=${session_id}: 执行失败（耗时 ${elapsed}ms）:`, message);

    await outputStream.pushError(message).catch(() => {});
    await outputStream.pushDone().catch(() => {});
    await updateSessionStatus(session_id, "FAILED", { error: message });
  } finally {
    // session 结束后清理整个沙盒目录（workspace/home/tmp 全部删除）
    // user 级别的 skills 目录在 sandbox root 的 users/{userId}/skills/ 下，不在此处，不受影响
    await destroySandbox(user_id, session_id).catch((err) =>
      console.error(`[worker] 销毁临时目录失败: session=${session_id}`, err)
    );
    activeSessions.delete(session_id);
  }
}

function handleMessage(channel: string, message: string): void {
  let payload: TaskPayload;
  try {
    payload = JSON.parse(message) as TaskPayload;
  } catch (err) {
    console.error("[worker] 无法解析任务消息:", message, err);
    return;
  }

  console.log(`[worker] 收到任务: channel=${channel} session=${payload.session_id} user=${payload.user_id}`);

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
    handleMessage(channel, message);
  });

  return subscriber;
}

/**
 * 扫描 MongoDB 中所有孤儿 RUNNING/PENDING session，重新触发处理。
 * 用于两个场景：
 *   1. 启动时一次性恢复（解决重启前的遗留任务）
 *   2. 定期轮询（解决启动竞态：task 发布时 pi-runtime 尚未订阅/recovery 尚未运行）
 */
async function recoverOrphanedSessions(): Promise<void> {
  const sessions = await findOrphanedSessions();

  // 过滤掉当前实例已经在处理中的 session，防止重复处理
  const unhandled = sessions.filter((s) => !activeSessions.has(s.session_id));
  if (unhandled.length === 0) return;

  console.log(`[worker] 发现 ${unhandled.length} 个孤儿 session，开始恢复...`);
  for (const s of unhandled) {
    console.log(`[worker] 恢复孤儿 session: session=${s.session_id} user=${s.user_id} status=${s.status}`);
    processSession({
      session_id: s.session_id,
      user_id: s.user_id,
      request: s.request,
      skill_ids: s.skill_ids,
      // 孤儿恢复时没有 context，pi 会从头处理当前 request
    }).catch((err) =>
      console.error(`[worker] 恢复 session 失败: session=${s.session_id}`, err)
    );
  }
}

// 定期扫描间隔：15 秒（覆盖启动竞态窗口，也能兜底其他意外丢失的任务）
const ORPHAN_SCAN_INTERVAL_MS = 15_000;

async function main(): Promise<void> {
  console.log(`[worker] pi-runtime 启动中... instance=${INSTANCE_ID}`);

  await connectMongo();
  await connectRedis();
  const subscriber = await startSubscriber();

  // 注册实例心跳（让 gateway 知道本实例存活，避免 sticky 路由到死实例）
  await registerInstanceAlive();
  console.log(`[worker] 实例心跳已注册: pi:instance:${INSTANCE_ID}:alive (TTL=${INSTANCE_ALIVE_TTL}s)`);

  // 订阅就绪后立即恢复孤儿 session（覆盖重启前的遗留任务）
  await recoverOrphanedSessions();

  // 定期扫描孤儿 session（覆盖启动竞态：task 发布时 recovery 尚未运行的时间窗口）
  const scanTimer = setInterval(() => {
    recoverOrphanedSessions().catch((err) =>
      console.error("[worker] 定期孤儿 session 扫描失败:", err)
    );
  }, ORPHAN_SCAN_INTERVAL_MS);

  // 定期刷新心跳（TTL 60s，每 30s 刷新，防止 gateway 误判实例死亡）
  const heartbeatTimer = setInterval(() => {
    registerInstanceAlive().catch((err) =>
      console.error("[worker] 心跳刷新失败:", err)
    );
  }, HEARTBEAT_INTERVAL_MS);

  console.log(`[worker] pi-runtime 就绪，等待任务...（孤儿扫描每 ${ORPHAN_SCAN_INTERVAL_MS / 1000}s，心跳每 ${HEARTBEAT_INTERVAL_MS / 1000}s）`);

  const shutdown = async () => {
    console.log("[worker] pi-runtime 正在关闭...");
    clearInterval(scanTimer);
    clearInterval(heartbeatTimer);
    // 主动注销心跳，让 gateway 立即感知实例下线
    await getRedis().del(INSTANCE_ALIVE_KEY_TPL.replace("{instanceId}", INSTANCE_ID)).catch(() => {});
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
