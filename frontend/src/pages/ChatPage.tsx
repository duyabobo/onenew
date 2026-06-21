import { useState, useRef, useEffect, useCallback } from "react";
import { createSession, streamSession } from "../api/session";

interface Message {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export default function ChatPage() {
  const [userId, setUserId] = useState(() => localStorage.getItem("pi_user_id") ?? "");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const closeStreamRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

    try {
      const { session_id } = await createSession(userId, trimmed);
      setMessages((prev) => [...prev, { role: "assistant", content: "", isStreaming: true }]);

      closeStreamRef.current = streamSession(
        session_id,
        (ev) => {
          if (ev.event === "token") {
            appendToLastAssistant(ev.data);
          } else if (ev.event === "tool_call") {
            const tc = JSON.parse(ev.data) as ToolCall;
            appendToLastAssistant(`\n\`\`\`tool:${tc.name}\n${JSON.stringify(tc.input, null, 2)}\n\`\`\`\n`);
          }
        },
        () => {
          setIsLoading(false);
          setMessages((prev) =>
            prev.map((m, i) => (i === prev.length - 1 ? { ...m, isStreaming: false } : m))
          );
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
  }, [input, userId, isLoading, appendToLastAssistant]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-53px)]">
      {/* 用户 ID 栏 */}
      <div className="bg-white border-b px-4 py-2 flex items-center gap-3">
        <label className="text-sm text-gray-500 whitespace-nowrap">用户 ID</label>
        <input
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="alice"
          className="text-sm border border-gray-300 rounded px-2 py-1 w-40 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
        {isLoading && (
          <span className="text-xs text-indigo-500 animate-pulse">Pi 正在思考…</span>
        )}
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-400 mt-20 text-sm">
            发送消息，Pi Agent 将为你执行任务
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
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
  );
}
