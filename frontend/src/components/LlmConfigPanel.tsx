import { useEffect, useState } from "react";
import { configApi, LlmConfig } from "../api/config";

const EMPTY: LlmConfig = { base_url: "", api_key: "", model: "", timeout: 120, protocol: "openai" };

// 常用服务商预设，方便快速填写
const PRESETS: Record<string, Partial<LlmConfig>> = {
  openai:     { protocol: "openai",     base_url: "https://api.openai.com/v1",                              model: "gpt-4o" },
  anthropic:  { protocol: "anthropic",  base_url: "https://api.anthropic.com",                              model: "claude-opus-4-5-20251101" },
  dashscope:  { protocol: "openai",     base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",      model: "qwen-max" },
  deepseek:   { protocol: "openai",     base_url: "https://api.deepseek.com/v1",                            model: "deepseek-chat" },
  groq:       { protocol: "openai",     base_url: "https://api.groq.com/openai/v1",                         model: "llama-3.3-70b-versatile" },
};

export default function LlmConfigPanel() {
  const [form, setForm] = useState<LlmConfig>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    configApi.getLlm()
      .then((cfg) => { if (cfg) setForm(cfg); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await configApi.saveLlm(form);
      setMsg({ type: "ok", text: "保存成功，立即生效（llm-proxy 热更新无需重启）。" });
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-sm text-gray-400">加载中…</div>;

  return (
    <div className="space-y-4">
      {/* 快速选择服务商预设 */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">快速选择服务商</label>
        <div className="flex gap-2 flex-wrap">
          {Object.entries(PRESETS).map(([key, preset]) => (
            <button
              key={key}
              onClick={() => setForm((f) => ({ ...f, ...preset }))}
              className="text-xs px-3 py-1 border border-gray-300 rounded-full hover:bg-indigo-50 hover:border-indigo-400 hover:text-indigo-700 transition-colors"
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      <Field label="协议">
        <select
          value={form.protocol}
          onChange={(e) => setForm({ ...form, protocol: e.target.value as LlmConfig["protocol"] })}
          className={inputCls}
        >
          <option value="openai">OpenAI-compatible（OpenAI / 百炼 / DeepSeek / Groq 等）</option>
          <option value="anthropic">Anthropic Messages API（Claude 原生协议）</option>
        </select>
      </Field>

      <Field label="Base URL">
        <input
          type="url"
          value={form.base_url}
          onChange={(e) => setForm({ ...form, base_url: e.target.value })}
          placeholder={form.protocol === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
          className={inputCls}
        />
      </Field>

      <Field label="API Key">
        <div className="flex gap-2">
          <input
            type={showKey ? "text" : "password"}
            value={form.api_key}
            onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            placeholder={form.protocol === "anthropic" ? "sk-ant-..." : "sk-..."}
            className={`${inputCls} flex-1`}
          />
          <button
            onClick={() => setShowKey((v) => !v)}
            className="text-xs text-gray-500 px-2 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            {showKey ? "隐藏" : "显示"}
          </button>
        </div>
      </Field>

      <Field label="模型">
        <input
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
          placeholder={form.protocol === "anthropic" ? "claude-opus-4-5-20251101" : "gpt-4o"}
          className={inputCls}
        />
      </Field>

      <Field label="超时（秒）">
        <input
          type="number"
          value={form.timeout}
          onChange={(e) => setForm({ ...form, timeout: Number(e.target.value) })}
          min={10}
          max={600}
          className={inputCls}
        />
      </Field>

      {msg && (
        <p className={`text-sm px-3 py-2 rounded-lg ${
          msg.type === "ok" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}>
          {msg.text}
        </p>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-5 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
      >
        {saving ? "保存中…" : "保存"}
      </button>
    </div>
  );
}

function Field({ label, children, placeholder: _p }: {
  label: string;
  children: React.ReactNode;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  );
}

const inputCls =
  "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400";
