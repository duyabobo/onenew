export interface CreateSessionResp {
  session_id: string;
  status: string;
}

export interface SessionSummary {
  session_id: string;
  conversation_id: string | null;
  status: string;
  request: string;
  created_at: string;
  completed_at: string | null;
}

export interface SessionDetail {
  _id: string;
  status: string;
  request: string;
  events_snapshot: Array<{ event_type: string; content: string }>;
  created_at: string;
}

/** 对话维度的摘要，一条对话一个条目（用于侧边栏历史列表） */
export interface ConversationSummary {
  conversation_id: string;
  first_request: string;     // 该对话第一条消息，作为标题
  last_status: string;       // 最近一次 session 的状态
  last_created_at: string;
  session_count: number;     // 共经历几轮问答
}

/** 包含 events_snapshot 的 session，用于重建对话消息列表 */
export interface ConversationSession {
  session_id: string;
  status: string;
  request: string;
  events_snapshot: Array<{ event_type: string; content: string }>;
}

export async function getRecentSessions(userId: string, limit = 20): Promise<SessionSummary[]> {
  const resp = await fetch(`/sessions?user_id=${encodeURIComponent(userId)}&limit=${limit}`);
  if (!resp.ok) return [];
  return resp.json();
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  const resp = await fetch(`/sessions/${sessionId}`);
  if (!resp.ok) return null;
  return resp.json();
}

export interface StreamEvent {
  event: string;
  data: string;
  id?: string;
}

export async function createSession(
  userId: string,
  request: string,
  skillIds: string[] = [],
  conversationId?: string,
  context?: string,
): Promise<CreateSessionResp> {
  const resp = await fetch("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      request,
      skill_ids: skillIds,
      conversation_id: conversationId ?? null,
      context: context ?? null,
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail ?? `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** 获取某对话的所有 session（按时间升序，用于重建消息列表） */
export async function getConversationSessions(conversationId: string): Promise<SessionSummary[]> {
  const resp = await fetch(`/sessions?conversation_id=${encodeURIComponent(conversationId)}`);
  if (!resp.ok) return [];
  return resp.json();
}

/** 获取用户最近的对话列表（按对话维度聚合，一条对话一个条目） */
export async function getRecentConversations(userId: string, limit = 20): Promise<ConversationSummary[]> {
  const resp = await fetch(`/conversations?user_id=${encodeURIComponent(userId)}&limit=${limit}`);
  if (!resp.ok) return [];
  return resp.json();
}

/**
 * 获取某对话的所有 session（含 events_snapshot），用于一次性重建完整消息列表。
 * 相比 getConversationSessions + 逐条 getSessionDetail，消除了 N+1 请求问题。
 */
export async function getConversationMessages(conversationId: string): Promise<ConversationSession[]> {
  const resp = await fetch(`/conversations/${encodeURIComponent(conversationId)}`);
  if (!resp.ok) return [];
  return resp.json();
}

/**
 * 打开 SSE 连接，通过回调逐事件推送。
 * 返回 close 函数，调用后断开连接。
 */
export function streamSession(
  sessionId: string,
  onEvent: (event: StreamEvent) => void,
  onDone: () => void,
  onError: (msg: string) => void
): () => void {
  const es = new EventSource(`/sessions/${sessionId}/stream`);

  const handlers: Record<string, (e: MessageEvent) => void> = {
    token: (e) => onEvent({ event: "token", data: e.data }),
    thinking: (e) => onEvent({ event: "thinking", data: e.data }),
    tool_call: (e) => onEvent({ event: "tool_call", data: e.data }),
    tool_result: (e) => onEvent({ event: "tool_result", data: e.data }),
    snapshot: (e) => {
      const snap = JSON.parse(e.data) as { events: StreamEvent[] };
      snap.events.forEach(onEvent);
    },
    done: () => { onDone(); es.close(); },
    error: (e) => { onError(e.data); es.close(); },
    heartbeat: () => {},
  };

  Object.entries(handlers).forEach(([ev, fn]) => es.addEventListener(ev, fn));

  es.onerror = () => {
    onError("SSE 连接中断");
    es.close();
  };

  return () => es.close();
}
