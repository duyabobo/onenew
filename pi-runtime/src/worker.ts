/**
 * pi-runtime 主入口：订阅 Redis Pub/Sub 任务频道，
 * 管理长生命周期 session（一个 chat 窗口 = 一个 session = 一个 pi 进程）。
 *
 * Session 生命周期：
 *   sessions:new / sessions:{instanceId}:new  → 创建新 session，启动 pi 进程
 *   sessions:{sessionId}:message              → 向已有 session 发送新消息（新轮次）
 *   sessions:{sessionId}:close               → 关闭 session，销毁 pi 进程和沙盒
 *
 * Sticky Session 机制：
 *   pi 进程持续运行期间，workspace 文件保留，pi 维护完整对话历史，
 *   无需外部传 context 字段。
 */
import Redis from "ioredis";
import os from "os";
import { config } from "./config";
import { connect as connectMongo, disconnect as disconnectMongo, updateSessionStatus, findOrphanedSessions } from "./mongo-client";
import { connectRedis, disconnectRedis, getRedis, SessionOutputStream } from "./output-stream";
import { createSandbox, destroySandbox } from "./sandbox";
import { startPiSession, PiSessionHandle } from "./pi-session";
import { startSocketBridge } from "./socket-bridge";

// ── 消息类型定义 ──────────────────────────────────────────────────────────────

interface NewSessionPayload {
  session_id: string;
  user_id: string;
  request: string;      // 第一条消息
  turn_id: string;      // 第一个轮次 ID
  skill_ids: string[];
}

interface NewMessagePayload {
  session_id: string;
  user_id: string;
  request: string;
  turn_id: string;      // 本轮次 ID（gateway 生成，用于 Redis Stream key）
  skill_ids: string[];
}

// ── 运行中的 session 状态 ─────────────────────────────────────────────────────

interface RunningSession {
  sessionId: string;
  userId: string;
  piHandle: PiSessionHandle;
  messageSubscriber: Redis;     // 订阅 sessions:{sessionId}:message
  closeSubscriber: Redis;       // 订阅 sessions:{sessionId}:close
  inactivityTimer: NodeJS.Timeout;
  startedAt: number;
}

// session 闲置超时（30 分钟无新消息自动关闭）
const SESSION_INACTIVITY_MS = 30 * 60_000;

const runningSessions = new Map<string, RunningSession>();

// ── 实例心跳 ─────────────────────────────────────────────────────────────────

const INSTANCE_ID = os.hostname();
const USER_INSTANCE_KEY_TPL = "user:{userId}:instance";
const USER_INSTANCE_TTL = 86400;
const INSTANCE_ALIVE_KEY_TPL = "pi:instance:{instanceId}:alive";
const INSTANCE_ALIVE_TTL = 60;
const HEARTBEAT_INTERVAL_MS = 30_000;

async function registerInstanceAlive(): Promise<void> {
  const key = INSTANCE_ALIVE_KEY_TPL.replace("{instanceId}", INSTANCE_ID);
  await getRedis().setex(key, INSTANCE_ALIVE_TTL, "1");
}

async function bindUserToInstance(userId: string): Promise<void> {
  const key = USER_INSTANCE_KEY_TPL.replace("{userId}", userId);
  await getRedis().setex(key, USER_INSTANCE_TTL, INSTANCE_ID);
  console.log(`[worker] user 实例绑定: user=${userId} → instance=${INSTANCE_ID}`);
}

// ── Session 管理 ──────────────────────────────────────────────────────────────

function resetInactivityTimer(running: RunningSession): void {
  clearTimeout(running.inactivityTimer);
  running.inactivityTimer = setTimeout(() => {
    console.log(`[worker] session=${running.sessionId}: 闲置超时，自动关闭`);
    closeSession(running.sessionId, "timeout").catch((err) =>
      console.error(`[worker] 自动关闭 session 失败: session=${running.sessionId}`, err)
    );
  }, SESSION_INACTIVITY_MS);
}

async function closeSession(sessionId: string, reason: string): Promise<void> {
  const running = runningSessions.get(sessionId);
  if (!running) return;

  runningSessions.delete(sessionId);
  clearTimeout(running.inactivityTimer);

  console.log(`[worker] session=${sessionId}: 关闭（原因=${reason}）`);

  await running.piHandle.close().catch((err) =>
    console.error(`[worker] 关闭 pi 进程失败: session=${sessionId}`, err)
  );
  await running.messageSubscriber.quit().catch(() => {});
  await running.closeSubscriber.quit().catch(() => {});
  await destroySandbox(running.userId, sessionId).catch((err) =>
    console.error(`[worker] 销毁沙盒失败: session=${sessionId}`, err)
  );

  // 超时关闭标记为 IDLE（沙盒已回收，session 可重启）；其他原因（用户主动关闭/进程退出）标记为 COMPLETED
  const finalStatus = reason === "timeout" ? "IDLE" : "COMPLETED";
  await updateSessionStatus(sessionId, finalStatus).catch(() => {});
  console.log(`[worker] session=${sessionId}: 已完全关闭，最终状态=${finalStatus}`);
}

/**
 * 启动 pi 进程、创建沙盒、订阅 Redis 频道并注册到 runningSessions。
 * openSession（首次创建）和 handleNewMessage（自动重建）共用此函数。
 */
async function startAndRegisterSession(
  sessionId: string,
  userId: string,
  skillIds: string[]
): Promise<RunningSession> {
  await bindUserToInstance(userId);
  await updateSessionStatus(sessionId, "RUNNING");

  const sandboxPaths = await createSandbox(userId, sessionId);
  console.log(`[worker] session=${sessionId}: 沙盒就绪 workspace=${sandboxPaths.workspace}`);

  const piHandle = await startPiSession(sessionId, sandboxPaths, skillIds);
  console.log(`[worker] session=${sessionId}: pi 进程已启动`);

  const messageSubscriber = new Redis(config.redis.url);
  const closeSubscriber = new Redis(config.redis.url);
  const messageChannel = `sessions:${sessionId}:message`;
  const closeChannel = `sessions:${sessionId}:close`;

  const running: RunningSession = {
    sessionId,
    userId,
    piHandle,
    messageSubscriber,
    closeSubscriber,
    inactivityTimer: setTimeout(() => {}, 0), // 占位，立即被 resetInactivityTimer 覆盖
    startedAt: Date.now(),
  };
  runningSessions.set(sessionId, running);
  resetInactivityTimer(running);

  messageSubscriber.on("message", (_channel, msg) => {
    let msgPayload: NewMessagePayload;
    try { msgPayload = JSON.parse(msg) as NewMessagePayload; }
    catch { console.error(`[worker] 无法解析消息: ${msg}`); return; }
    handleNewMessage(msgPayload).catch((err) =>
      console.error(`[worker] 处理消息失败: session=${sessionId} turn=${msgPayload.turn_id}`, err)
    );
  });

  closeSubscriber.on("message", () => {
    closeSession(sessionId, "user_close").catch((err) =>
      console.error(`[worker] 处理关闭失败: session=${sessionId}`, err)
    );
  });

  await messageSubscriber.subscribe(messageChannel);
  await closeSubscriber.subscribe(closeChannel);
  console.log(`[worker] session=${sessionId}: 已订阅消息频道 [${messageChannel}] 和关闭频道 [${closeChannel}]`);

  return running;
}

// ── 处理新 session（第一条消息，创建 pi 进程）───────────────────────────────

async function openSession(payload: NewSessionPayload): Promise<void> {
  const { session_id, user_id, request, turn_id, skill_ids = [] } = payload;

  if (runningSessions.has(session_id)) {
    console.warn(`[worker] session=${session_id} 已在运行中，跳过重复创建`);
    return;
  }

  console.log(`[worker] 创建 session: session=${session_id} user=${user_id} turn=${turn_id}`);
  const running = await startAndRegisterSession(session_id, user_id, skill_ids);
  await sendTurnToSession(running, turn_id, request);
}

// ── 处理新消息（追加轮次到已有 session）──────────────────────────────────────

async function handleNewMessage(payload: NewMessagePayload): Promise<void> {
  const { session_id, user_id, request, turn_id, skill_ids = [] } = payload;
  let running = runningSessions.get(session_id);

  if (!running) {
    // pi 进程不在内存中（崩溃或被清理），自动重建后继续处理本条消息
    console.warn(`[worker] session=${session_id}: pi 进程不存在，自动重建`);
    running = await startAndRegisterSession(session_id, user_id, skill_ids);
    console.log(`[worker] session=${session_id}: pi 进程重建完成`);
  }

  resetInactivityTimer(running);
  await sendTurnToSession(running, turn_id, request);
}

async function sendTurnToSession(running: RunningSession, turnId: string, request: string): Promise<void> {
  const { sessionId, userId } = running;
  // 每个轮次有独立的 Redis Stream key，供前端 SSE 消费
  const turnStream = new SessionOutputStream(getRedis(), sessionId, turnId);
  const startAt = Date.now();

  console.log(`[worker] session=${sessionId} turn=${turnId}: 开始执行，request='${request.slice(0, 80).replace(/\n/g, " ")}'`);

  try {
    await running.piHandle.sendTurn(turnId, request, turnStream);
    const elapsed = Date.now() - startAt;
    await turnStream.expire(3600);
    console.log(`[worker] session=${sessionId} turn=${turnId}: 执行完成，耗时 ${elapsed}ms`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] session=${sessionId} turn=${turnId}: 执行失败:`, message);
    await turnStream.pushError(message).catch(() => {});
    await turnStream.pushDone().catch(() => {});
    // 轮次失败不关闭整个 session，继续等待下一条消息
  }
}

// ── 全局频道消息处理 ──────────────────────────────────────────────────────────

function handleGlobalMessage(channel: string, message: string): void {
  let payload: NewSessionPayload;
  try {
    payload = JSON.parse(message) as NewSessionPayload;
  } catch (err) {
    console.error("[worker] 无法解析任务消息:", message, err);
    return;
  }
  console.log(`[worker] 收到新 session 任务: channel=${channel} session=${payload.session_id} user=${payload.user_id}`);
  openSession(payload).catch((err) =>
    console.error(`[worker] openSession 未捕获异常: session=${payload.session_id}`, err)
  );
}

async function startSubscriber(): Promise<Redis> {
  const subscriber = new Redis(config.redis.url);
  subscriber.on("error", (err) => console.error("[subscriber] Redis 错误:", err));

  const globalChannel = config.redis.taskChannel;
  const instanceChannel = `sessions:${INSTANCE_ID}:new`;

  await subscriber.subscribe(globalChannel, instanceChannel);
  console.log(`[worker] 已订阅频道: [${globalChannel}] [${instanceChannel}]`);

  subscriber.on("message", (channel, message) => {
    if (channel !== globalChannel && channel !== instanceChannel) return;
    handleGlobalMessage(channel, message);
  });

  return subscriber;
}

// ── 孤儿 session 恢复 ─────────────────────────────────────────────────────────

async function recoverOrphanedSessions(): Promise<void> {
  const sessions = await findOrphanedSessions();
  const unhandled = sessions.filter((s) => !runningSessions.has(s.session_id));
  if (unhandled.length === 0) return;

  console.log(`[worker] 发现 ${unhandled.length} 个孤儿 session，开始恢复...`);
  for (const s of unhandled) {
    console.log(`[worker] 恢复孤儿 session: session=${s.session_id} user=${s.user_id}`);
    openSession({
      session_id: s.session_id,
      user_id: s.user_id,
      request: s.request,
      turn_id: `recovery-${Date.now()}`,
      skill_ids: s.skill_ids,
    }).catch((err) =>
      console.error(`[worker] 恢复 session 失败: session=${s.session_id}`, err)
    );
  }
}

const ORPHAN_SCAN_INTERVAL_MS = 15_000;

// ── 主函数 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[worker] pi-runtime 启动中... instance=${INSTANCE_ID}`);

  await connectMongo();
  await connectRedis();

  // 启动 Unix socket 桥：为沙盒提供 llm-proxy 和 mcp-proxy 两个网络白名单出口
  startSocketBridge(
    process.env.LLM_PROXY_HOST ?? "llm-proxy",
    Number(process.env.LLM_PROXY_PORT ?? 9001),
    process.env.MCP_PROXY_HOST ?? "mcp-proxy",
    Number(process.env.MCP_PROXY_PORT ?? 8080)
  );
  console.log(`[worker] socket bridge 已启动（llm.sock → llm-proxy, mcp.sock → mcp-proxy）`);

  const subscriber = await startSubscriber();

  await registerInstanceAlive();
  console.log(`[worker] 实例心跳已注册: pi:instance:${INSTANCE_ID}:alive (TTL=${INSTANCE_ALIVE_TTL}s)`);

  await recoverOrphanedSessions();

  const scanTimer = setInterval(() => {
    recoverOrphanedSessions().catch((err) =>
      console.error("[worker] 定期孤儿 session 扫描失败:", err)
    );
  }, ORPHAN_SCAN_INTERVAL_MS);

  const heartbeatTimer = setInterval(() => {
    registerInstanceAlive().catch((err) =>
      console.error("[worker] 心跳刷新失败:", err)
    );
  }, HEARTBEAT_INTERVAL_MS);

  console.log(`[worker] pi-runtime 就绪（孤儿扫描每 ${ORPHAN_SCAN_INTERVAL_MS / 1000}s，心跳每 ${HEARTBEAT_INTERVAL_MS / 1000}s）`);

  const shutdown = async () => {
    console.log("[worker] pi-runtime 正在关闭...");
    clearInterval(scanTimer);
    clearInterval(heartbeatTimer);
    // 关闭所有活跃 session
    await Promise.all([...runningSessions.keys()].map((id) => closeSession(id, "shutdown")));
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
