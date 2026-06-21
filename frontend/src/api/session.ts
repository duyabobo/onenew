export interface CreateSessionResp {
  session_id: string;
  status: string;
}

export interface StreamEvent {
  event: string;
  data: string;
  id?: string;
}

export async function createSession(userId: string, request: string): Promise<CreateSessionResp> {
  const resp = await fetch("/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, request }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail ?? `HTTP ${resp.status}`);
  }
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
