import { useState } from "react";
import LlmConfigPanel from "../components/LlmConfigPanel";
import McpConfigPanel from "../components/McpConfigPanel";
import SkillsPanel from "../components/SkillsPanel";

type Tab = "llm" | "mcp" | "skills";

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("llm");

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <h1 className="text-xl font-bold text-gray-800 mb-6">系统配置</h1>

      {/* Tab 切换 */}
      <div className="flex gap-1 border-b border-gray-200 mb-6">
        {(["llm", "mcp", "skills"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t === "llm" ? "LLM Provider" : t === "mcp" ? "MCP Servers" : "Skills"}
          </button>
        ))}
      </div>

      {tab === "llm" && <LlmConfigPanel />}
      {tab === "mcp" && <McpConfigPanel />}
      {tab === "skills" && <SkillsPanel />}
    </div>
  );
}
