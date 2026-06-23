// ── 类型定义 ─────────────────────────────────────────────────────────────────

export interface CreateSessionResp {
  session_id: string;
  status: string;
}

export interface SendMessageResp {
  session_id: string;
  turn_id: string;
}

/** session 列表摘要（一个 session = 一个 chat 窗口） */
export interface SessionSummary {
  session_id: string;
  status: string;
  request: string;       // 第一条消息，作为标题
  created_at: string;
  completed_at: string | null;
}

/** session 详情（含 events_snapshot，用于重建历史消息） */
export interface SessionDetail {
  _id: string;
  status: string;
  request: string;
  events_snapshot: Array<{ event_type: string; content: string }>;
  created_at: string;
}

export interface StreamEvent {
  event: string;
  data: string;
  id?: string;
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/** 解析 FastAPI 错误响应（detail 可能是字符串或数组） */
function parseErrorDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((d: { msg?: string }) => d.msg ?? String(d)).join("; ");
  }
  return String(detail);
}

async function throwIfNotOk(resp: Response): Promise<void> {
  if (resp.ok) return;
  const body = await resp.json().catch(() => ({}));
  const detail = (body as { detail?: unknown }).detail;
  throw new Error(detail ? parseErrorDetail(detail) : `HTTP ${resp.status}`);
}

// ── Session API ───────────────────────────────────────────────────────────────

/** 创建新 session（打开新 chat 窗口 + 发送第一条消息） */
export async function createSession(
  userId: string,
  request: string,
  turnId: string,
  skillIds: string[] = [],
): Promise<CreateSessionResp> {
  const resp = await fetch("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, request, turn_id: turnId, skill_ids: skillIds }),
  });
  await throwIfNotOk(resp);
  return resp.json();
}

/** 向已有 session 发送新消息（多轮对话） */
export async function sendMessage(
  sessionId: string,
  request: string,
  turnId: string,
  skillIds: string[] = [],
): Promise<SendMessageResp> {
  const resp = await fetch(`/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request, turn_id: turnId, skill_ids: skillIds }),
  });
  await throwIfNotOk(resp);
  return resp.json();
}

/** 关闭 session（关闭 chat 窗口，销毁 pi 进程和沙盒） */
export async function closeSession(sessionId: string): Promise<void> {
  await fetch(`/sessions/${sessionId}`, { method: "DELETE" });
}

/** 获取用户最近的 session 列表（每条 = 一个 chat 窗口） */
export async function getRecentSessions(userId: string, limit = 20): Promise<SessionSummary[]> {
  const resp = await fetch(`/sessions?user_id=${encodeURIComponent(userId)}&limit=${limit}`);
  if (!resp.ok) return [];
  return resp.json();
}

/** 获取 session 详情（含 events_snapshot，用于重建消息） */
export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  const resp = await fetch(`/sessions/${sessionId}`);
  if (!resp.ok) return null;
  return resp.json();
}

// ── SSE 流 ────────────────────────────────────────────────────────────────────

/**
 * 订阅指定轮次的 SSE 输出流。
 * 返回 close 函数，调用后断开连接。
 */
export function streamTurn(
  sessionId: string,
  turnId: string,
  onEvent: (event: StreamEvent) => void,
  onDone: () => void,
  onError: (msg: string) => void,
): () => void {
  const es = new EventSource(`/sessions/${sessionId}/turns/${turnId}/stream`);

  const handlers: Record<string, (e: MessageEvent) => void> = {
    token:       (e) => onEvent({ event: "token",       data: e.data }),
    thinking:    (e) => onEvent({ event: "thinking",    data: e.data }),
    tool_call:   (e) => onEvent({ event: "tool_call",   data: e.data }),
    tool_result: (e) => onEvent({ event: "tool_result", data: e.data }),
    done:        ()  => { onDone(); es.close(); },
    error:       (e) => { onError(e.data || "执行出错"); es.close(); },
    heartbeat:   ()  => {},
  };

  Object.entries(handlers).forEach(([ev, fn]) => es.addEventListener(ev, fn));
  es.onerror = () => { onError("SSE 连接中断"); es.close(); };

  return () => es.close();
}
