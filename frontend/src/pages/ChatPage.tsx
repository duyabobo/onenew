import { useState, useRef, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import {
  createSession, streamSession,
  getRecentConversations, getConversationMessages,
  ConversationSummary,
} from "../api/session";
import { skillsApi, Skill } from "../api/skills";

// ── 消息结构 ────────────────────────────────────────────────────────────────

type MessageType = "text" | "thinking" | "tool_call" | "tool_result";

interface Message {
  role: "user" | "assistant";
  type: MessageType;
  content: string;
  isStreaming?: boolean;
}

// ── 快照重建：把 events_snapshot 转成 Message 列表 ────────────────────────

function buildMessagesFromSnapshot(
  request: string,
  snapshot: Array<{ event_type: string; content: string }>
): Message[] {
  const msgs: Message[] = [{ role: "user", type: "text", content: request }];
  for (const event of snapshot) {
    const last = msgs[msgs.length - 1];
    if (event.event_type === "token") {
      if (last?.role === "assistant" && last.type === "text") {
        last.content += event.content;
      } else {
        msgs.push({ role: "assistant", type: "text", content: event.content });
      }
    } else if (event.event_type === "thinking") {
      if (last?.role === "assistant" && last.type === "thinking") {
        last.content += event.content;
      } else {
        msgs.push({ role: "assistant", type: "thinking", content: event.content });
      }
    } else if (event.event_type === "tool_call") {
      msgs.push({ role: "assistant", type: "tool_call", content: event.content });
    } else if (event.event_type === "tool_result") {
      msgs.push({ role: "assistant", type: "tool_result", content: event.content });
    }
  }
  return msgs;
}

/**
 * 将消息列表格式化为发给 pi 的历史上下文文本。
 * 只提取 text 类型的消息，跳过思考/工具调用细节，保持上下文简洁。
 */
function formatConversationContext(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.type !== "text" || !msg.content.trim()) continue;
    lines.push(msg.role === "user" ? `用户：${msg.content}` : `助手：${msg.content}`);
  }
  if (lines.length === 0) return "";
  return `[对话历史]\n\n${lines.join("\n\n")}`;
}

// ── 消息块渲染组件 ──────────────────────────────────────────────────────────

function ThinkingBlock({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const [open, setOpen] = useState(!!isStreaming);
  useEffect(() => { if (isStreaming) setOpen(true); }, [isStreaming]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!isStreaming) setOpen(false); }, [isStreaming]);

  return (
    <div className="max-w-[80%] text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-gray-400 hover:text-gray-600 transition-colors mb-1"
      >
        <svg className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="italic">{isStreaming ? "正在思考…" : "思考过程"}</span>
        {isStreaming && <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />}
      </button>
      {open && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-gray-500 italic whitespace-pre-wrap break-words leading-relaxed">
          {content}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(true);
  let name = ""; let inputText = "";
  try {
    const p = JSON.parse(content) as { name: string; input: unknown };
    name = p.name; inputText = JSON.stringify(p.input, null, 2);
  } catch { inputText = content; }
  return (
    <div className="max-w-[80%] text-xs">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-indigo-500 hover:text-indigo-700 transition-colors mb-1">
        <svg className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
        <span className="font-mono font-medium text-indigo-600">{name || "工具调用"}</span>
      </button>
      {open && <pre className="bg-indigo-50 border border-indigo-100 rounded-xl px-3 py-2 text-gray-600 overflow-x-auto">{inputText}</pre>}
    </div>
  );
}

function ToolResultBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  let name = ""; let outputText = ""; let isError = false;
  try {
    const p = JSON.parse(content) as { name: string; output: string; isError?: boolean };
    name = p.name; outputText = p.output; isError = !!p.isError;
  } catch { outputText = content; }
  return (
    <div className="max-w-[80%] text-xs">
      <button onClick={() => setOpen((v) => !v)} className={`flex items-center gap-1 transition-colors mb-1 ${isError ? "text-red-400 hover:text-red-600" : "text-green-500 hover:text-green-700"}`}>
        <svg className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
        {isError
          ? <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          : <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
        }
        <span className={`font-mono font-medium ${isError ? "text-red-500" : "text-green-600"}`}>{name ? `${name} 结果` : "执行结果"}</span>
      </button>
      {open && <pre className={`border rounded-xl px-3 py-2 overflow-x-auto ${isError ? "bg-red-50 border-red-100 text-red-600" : "bg-green-50 border-green-100 text-gray-600"}`}>{outputText}</pre>}
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words bg-indigo-600 text-white rounded-br-sm">
          {msg.content}
        </div>
      </div>
    );
  }
  if (msg.type === "thinking") return <div className="flex justify-start"><ThinkingBlock content={msg.content} isStreaming={msg.isStreaming} /></div>;
  if (msg.type === "tool_call") return <div className="flex justify-start"><ToolCallBlock content={msg.content} /></div>;
  if (msg.type === "tool_result") return <div className="flex justify-start"><ToolResultBlock content={msg.content} /></div>;
  return (
    <div className="flex justify-start">
      <div className="max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap break-words bg-white border border-gray-200 text-gray-800 rounded-bl-sm shadow-sm">
        {msg.content}
        {msg.isStreaming && <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse ml-1 align-middle rounded-sm" />}
      </div>
    </div>
  );
}

// ── 主页面 ───────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [userId, setUserId] = useState(() => localStorage.getItem("pi_user_id") ?? "");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string>("");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // conversationId 是对话线程的唯一标识，存在 URL ?c= 参数中
  const conversationIdRef = useRef<string | null>(searchParams.get("c"));

  const closeStreamRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // 最新 messages 的 ref，供回调函数访问（避免闭包过期问题）
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;

  useEffect(() => {
    skillsApi.list()
      .then((list) => setSkills(list.filter((s) => !s.hidden)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /**
   * 从 URL 中的 conversationId 恢复对话历史。
   * 单次请求获取所有 session（含 events_snapshot），消除 N+1 问题。
   */
  const loadConversation = useCallback(async (conversationId: string) => {
    const sessions = await getConversationMessages(conversationId);
    if (sessions.length === 0) return;

    const allMessages: Message[] = [];
    for (const s of sessions) {
      if (s.status === "COMPLETED" || s.status === "FAILED") {
        allMessages.push(...buildMessagesFromSnapshot(s.request, s.events_snapshot));
      }
    }
    if (allMessages.length > 0) setMessages(allMessages);
  }, []);

  /** 加载用户对话列表（conversation 维度，一条对话一个条目） */
  const loadConversations = useCallback(async (uid: string) => {
    if (!uid.trim()) { setConversations([]); return; }
    const list = await getRecentConversations(uid);
    setConversations(list);
  }, []);

  // 页面挂载：优先从 URL 恢复对话，其次加载用户历史
  useEffect(() => {
    const convId = searchParams.get("c");
    if (convId) {
      conversationIdRef.current = convId;
      loadConversation(convId);
    } else if (userId.trim()) {
      loadConversations(userId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 点击侧边栏对话条目，切换并加载该对话的完整消息 */
  const switchToConversation = useCallback(async (conversationId: string) => {
    conversationIdRef.current = conversationId;
    setSearchParams({ c: conversationId });
    setMessages([]);
    await loadConversation(conversationId);
  }, [loadConversation, setSearchParams]);

  const appendToLastOfType = useCallback((type: MessageType, text: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.type === type) {
        return [...prev.slice(0, -1), { ...last, content: last.content + text }];
      }
      return [...prev, { role: "assistant", type, content: text, isStreaming: true }];
    });
  }, []);

  const addDiscreteMessage = useCallback((type: MessageType, content: string) => {
    setMessages((prev) => [...prev, { role: "assistant", type, content }]);
  }, []);

  const markStreamingDone = useCallback(() => {
    setMessages((prev) =>
      prev.map((m, i) => (i === prev.length - 1 ? { ...m, isStreaming: false } : m))
    );
  }, []);

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    if (!userId.trim()) { setError("请先填写用户 ID"); return; }

    localStorage.setItem("pi_user_id", userId);
    setError("");
    setInput("");
    setIsLoading(true);
    setMessages((prev) => [...prev, { role: "user", type: "text", content: trimmed }]);

    // 获取或初始化对话 ID
    if (!conversationIdRef.current) {
      conversationIdRef.current = crypto.randomUUID();
      setSearchParams({ c: conversationIdRef.current });
    }

    // 格式化历史上下文（当前消息还没加到 messages，用 messagesRef.current 的前一版本）
    const context = formatConversationContext(messagesRef.current) || undefined;
    const skillIds = selectedSkillId ? [selectedSkillId] : [];

    try {
      const { session_id } = await createSession(
        userId, trimmed, skillIds, conversationIdRef.current, context
      );

      closeStreamRef.current = streamSession(
        session_id,
        (ev) => {
          if (ev.event === "token") appendToLastOfType("text", ev.data);
          else if (ev.event === "thinking") appendToLastOfType("thinking", ev.data);
          else if (ev.event === "tool_call") addDiscreteMessage("tool_call", ev.data);
          else if (ev.event === "tool_result") addDiscreteMessage("tool_result", ev.data);
        },
        () => {
          setIsLoading(false);
          markStreamingDone();
          // 问答完成后刷新对话列表（更新最新活动时间和状态）
          loadConversations(userId);
        },
        (msg) => { setError(msg); setIsLoading(false); }
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败");
      setIsLoading(false);
    }
  }, [input, userId, isLoading, selectedSkillId, setSearchParams, appendToLastOfType, addDiscreteMessage, markStreamingDone, loadConversations]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const handleUserIdChange = (newId: string) => {
    setUserId(newId);
    setMessages([]);
    conversationIdRef.current = null;
    setSearchParams({});
    if (newId.trim()) loadConversations(newId);
  };

  return (
    <div className="flex h-[calc(100vh-53px)]">
      {/* 历史会话侧边栏（conversation 维度，一条对话一个条目） */}
      {showHistory && (
        <div className="w-64 border-r bg-gray-50 flex flex-col shrink-0">
          <div className="px-3 py-2 border-b bg-white flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">历史对话</span>
            <button onClick={() => setShowHistory(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {conversations.length === 0 ? (
              <p className="text-xs text-gray-400 text-center mt-8 px-3">暂无历史对话</p>
            ) : (
              conversations.map((conv) => (
                <button
                  key={conv.conversation_id}
                  onClick={() => switchToConversation(conv.conversation_id)}
                  className={`w-full text-left px-3 py-2 border-b hover:bg-indigo-50 transition-colors ${
                    conv.conversation_id === conversationIdRef.current ? "bg-indigo-50 border-l-2 border-l-indigo-500" : ""
                  }`}
                >
                  <p className="text-xs text-gray-800 truncate">{conv.first_request}</p>
                  <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-2">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                      conv.last_status === "COMPLETED" ? "bg-green-400" :
                      conv.last_status === "RUNNING" ? "bg-yellow-400 animate-pulse" :
                      conv.last_status === "FAILED" ? "bg-red-400" : "bg-gray-300"
                    }`} />
                    <span>{new Date(conv.last_created_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="text-gray-300">{conv.session_count} 轮</span>
                  </p>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* 主聊天区 */}
      <div className="flex flex-col flex-1 min-w-0">
        <div className="bg-white border-b px-4 py-2 flex items-center gap-3 flex-wrap">
          <button
            onClick={() => { setShowHistory((v) => !v); if (!showHistory && userId.trim()) loadConversations(userId); }}
            title="历史对话"
            className="text-gray-400 hover:text-indigo-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
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
              <option key={s.name} value={s.name} title={s.description}>{s.name}</option>
            ))}
          </select>
          {selectedSkillId && (
            <span className="text-xs text-indigo-500">
              {skills.find((s) => s.name === selectedSkillId)?.description ?? ""}
            </span>
          )}

          {isLoading && <span className="ml-auto text-xs text-indigo-500 animate-pulse">Pi 正在执行…</span>}
          {error && <span className="ml-auto text-xs text-red-500">{error}</span>}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-50">
          {messages.length === 0 && (
            <div className="text-center text-gray-400 mt-20 text-sm">
              选择 Skill（可选），发送消息，Pi Agent 将为你执行任务
            </div>
          )}
          {messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)}
          <div ref={bottomRef} />
        </div>

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
