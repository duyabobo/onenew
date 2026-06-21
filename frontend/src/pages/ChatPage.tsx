import { useState, useRef, useEffect, useCallback } from "react";
import { createSession, streamSession, getRecentSessions, getSessionDetail, SessionSummary } from "../api/session";
import { skillsApi, Skill } from "../api/skills";

interface Message {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
}

/** 从 events_snapshot 重建消息内容（把 token 拼接成完整 assistant 消息） */
function buildMessagesFromSnapshot(
  request: string,
  snapshot: Array<{ event_type: string; content: string }>
): Message[] {
  const assistantContent = snapshot
    .filter((e) => e.event_type === "token")
    .map((e) => e.content)
    .join("");

  const msgs: Message[] = [{ role: "user", content: request }];
  if (assistantContent) {
    msgs.push({ role: "assistant", content: assistantContent });
  }
  return msgs;
}

export default function ChatPage() {
  const [userId, setUserId] = useState(() => localStorage.getItem("pi_user_id") ?? "");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string>("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const closeStreamRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 加载 skill 列表
  useEffect(() => {
    skillsApi.list()
      .then((list) => setSkills(list.filter((s) => !s.hidden)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // userId 变化时拉取历史 session 列表
  const loadHistory = useCallback(async (uid: string) => {
    if (!uid.trim()) { setSessions([]); return; }
    const list = await getRecentSessions(uid);
    setSessions(list);
    return list;
  }, []);

  // 页面挂载时自动恢复最近一次已完成的会话
  useEffect(() => {
    if (!userId.trim()) return;
    loadHistory(userId).then((list) => {
      if (!list || list.length === 0) return;
      const lastCompleted = list.find((s) => s.status === "COMPLETED");
      if (lastCompleted) {
        loadSessionMessages(lastCompleted.session_id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 加载某个 session 的历史消息
  const loadSessionMessages = useCallback(async (sessionId: string) => {
    const detail = await getSessionDetail(sessionId);
    if (!detail) return;
    const msgs = buildMessagesFromSnapshot(detail.request, detail.events_snapshot);
    setMessages(msgs);
    setActiveSessionId(sessionId);
  }, []);

  const appendToLastAssistant = useCallback((text: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant") {
        return [...prev.slice(0, -1), { ...last, content: last.content + text }];
      }
      return [...prev, { role: "assistant", content: text, isStreaming: true }];
    });
  }, []);

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    if (!userId.trim()) { setError("请先填写用户 ID"); return; }

    localStorage.setItem("pi_user_id", userId);
    setError("");
    setInput("");
    setIsLoading(true);
    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);

    const skillIds = selectedSkillId ? [selectedSkillId] : [];

    try {
      const { session_id } = await createSession(userId, trimmed, skillIds);
      setActiveSessionId(session_id);
      setMessages((prev) => [...prev, { role: "assistant", content: "", isStreaming: true }]);

      closeStreamRef.current = streamSession(
        session_id,
        (ev) => {
          if (ev.event === "token") {
            appendToLastAssistant(ev.data);
          } else if (ev.event === "tool_call") {
            const tc = JSON.parse(ev.data) as { name: string; input: unknown };
            appendToLastAssistant(`\n\`\`\`tool:${tc.name}\n${JSON.stringify(tc.input, null, 2)}\n\`\`\`\n`);
          }
        },
        () => {
          setIsLoading(false);
          setMessages((prev) =>
            prev.map((m, i) => (i === prev.length - 1 ? { ...m, isStreaming: false } : m))
          );
          // 刷新历史列表，让新完成的 session 出现在列表中
          loadHistory(userId);
        },
        (msg) => {
          setError(msg);
          setIsLoading(false);
        }
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败");
      setIsLoading(false);
    }
  }, [input, userId, isLoading, selectedSkillId, appendToLastAssistant, loadHistory]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const handleUserIdChange = (newId: string) => {
    setUserId(newId);
    setMessages([]);
    setActiveSessionId(null);
    if (newId.trim()) loadHistory(newId);
  };

  return (
    <div className="flex h-[calc(100vh-53px)]">
      {/* 历史会话侧边栏 */}
      {showHistory && (
        <div className="w-64 border-r bg-gray-50 flex flex-col shrink-0">
          <div className="px-3 py-2 border-b bg-white flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">历史会话</span>
            <button
              onClick={() => setShowHistory(false)}
              className="text-gray-400 hover:text-gray-600 text-lg leading-none"
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {sessions.length === 0 ? (
              <p className="text-xs text-gray-400 text-center mt-8 px-3">暂无历史会话</p>
            ) : (
              sessions.map((s) => (
                <button
                  key={s.session_id}
                  onClick={() => loadSessionMessages(s.session_id)}
                  className={`w-full text-left px-3 py-2 border-b hover:bg-indigo-50 transition-colors ${
                    s.session_id === activeSessionId ? "bg-indigo-50 border-l-2 border-l-indigo-500" : ""
                  }`}
                >
                  <p className="text-xs text-gray-800 truncate">{s.request}</p>
                  <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                    <span
                      className={`inline-block w-1.5 h-1.5 rounded-full ${
                        s.status === "COMPLETED" ? "bg-green-400" :
                        s.status === "RUNNING" ? "bg-yellow-400 animate-pulse" :
                        s.status === "FAILED" ? "bg-red-400" : "bg-gray-300"
                      }`}
                    />
                    {new Date(s.created_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* 主聊天区 */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* 顶部配置栏 */}
        <div className="bg-white border-b px-4 py-2 flex items-center gap-3 flex-wrap">
          <button
            onClick={() => {
              setShowHistory((v) => !v);
              if (!showHistory && userId.trim()) loadHistory(userId);
            }}
            title="历史会话"
            className="text-gray-400 hover:text-indigo-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>

          <label className="text-sm text-gray-500 whitespace-nowrap">用户 ID</label>
          <input
            value={userId}
            onChange={(e) => handleUserIdChange(e.target.value)}
            placeholder="alice"
            className="text-sm border border-gray-300 rounded px-2 py-1 w-32 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />

          <span className="text-gray-300">|</span>

          <label className="text-sm text-gray-500 whitespace-nowrap">Skill</label>
          <select
            value={selectedSkillId}
            onChange={(e) => setSelectedSkillId(e.target.value)}
            className="text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          >
            <option value="">默认（不指定）</option>
            {skills.map((s) => (
              <option key={s.name} value={s.name} title={s.description}>
                {s.name}
              </option>
            ))}
          </select>
          {selectedSkillId && (
            <span className="text-xs text-indigo-500">
              {skills.find((s) => s.name === selectedSkillId)?.description ?? ""}
            </span>
          )}

          {isLoading && (
            <span className="ml-auto text-xs text-indigo-500 animate-pulse">Pi 正在思考…</span>
          )}
          {error && <span className="ml-auto text-xs text-red-500">{error}</span>}
        </div>

        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-gray-400 mt-20 text-sm">
              选择 Skill（可选），发送消息，Pi Agent 将为你执行任务
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words ${
                  msg.role === "user"
                    ? "bg-indigo-600 text-white rounded-br-sm"
                    : "bg-white border border-gray-200 text-gray-800 rounded-bl-sm shadow-sm"
                }`}
              >
                {msg.content}
                {msg.isStreaming && (
                  <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse ml-1 align-middle rounded-sm" />
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* 输入框 */}
        <div className="bg-white border-t px-4 py-3">
          <div className="flex gap-2 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入你的请求… (Enter 发送，Shift+Enter 换行)"
              rows={2}
              className="flex-1 resize-none border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            <button
              onClick={send}
              disabled={isLoading || !input.trim()}
              className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
