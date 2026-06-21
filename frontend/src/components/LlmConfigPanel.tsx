import { useEffect, useState } from "react";
import { configApi, LlmConfig } from "../api/config";

const EMPTY: LlmConfig = { base_url: "", api_key: "", model: "", timeout: 120 };

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
      setMsg({ type: "ok", text: "保存成功。Admin 服务需重启后生效。" });
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-sm text-gray-400">加载中…</div>;

  return (
    <div className="space-y-4">
      <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        配置保存到 MongoDB 后，Admin 服务需重启才能使用新配置。
      </p>

      <Field label="Base URL" placeholder="https://api.openai.com/v1">
        <input
          type="url"
          value={form.base_url}
          onChange={(e) => setForm({ ...form, base_url: e.target.value })}
          placeholder="https://api.openai.com/v1"
          className={inputCls}
        />
      </Field>

      <Field label="API Key">
        <div className="flex gap-2">
          <input
            type={showKey ? "text" : "password"}
            value={form.api_key}
            onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            placeholder="sk-..."
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

      <Field label="默认模型">
        <input
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
          placeholder="gpt-4o / claude-opus-4-5"
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
