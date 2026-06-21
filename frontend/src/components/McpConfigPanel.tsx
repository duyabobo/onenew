import { useEffect, useState } from "react";
import { configApi, McpConfig, McpServerConfig } from "../api/config";

const EMPTY_SERVER: McpServerConfig = {
  command: "",
  args: [],
  env: {},
  url: "",
  description: "",
  enabled: true,
};

interface EditState {
  name: string;
  config: McpServerConfig;
}

export default function McpConfigPanel() {
  const [mcpConfig, setMcpConfig] = useState<McpConfig>({ servers: {} });
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = () =>
    configApi.getMcp()
      .then(setMcpConfig)
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const openNew = () => setEdit({ name: "", config: { ...EMPTY_SERVER } });
  const openEdit = (name: string) =>
    setEdit({ name, config: { ...mcpConfig.servers[name] } });

  const handleDelete = async (name: string) => {
    if (!confirm(`确认删除 MCP server "${name}"？`)) return;
    setMsg(null);
    try {
      const updated = await configApi.deleteServer(name);
      setMcpConfig(updated);
      setMsg({ type: "ok", text: `已删除 ${name}` });
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "删除失败" });
    }
  };

  const handleSaveServer = async () => {
    if (!edit) return;
    if (!edit.name.trim()) { setMsg({ type: "err", text: "Server 名称不能为空" }); return; }
    setMsg(null);
    try {
      const updated = await configApi.addServer(edit.name.trim(), edit.config);
      setMcpConfig(updated);
      setEdit(null);
      setMsg({ type: "ok", text: `${edit.name} 已保存，新 session 启动时生效` });
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "保存失败" });
    }
  };

  if (loading) return <div className="text-sm text-gray-400">加载中…</div>;

  const servers = Object.entries(mcpConfig.servers);

  return (
    <div className="space-y-4">
      <p className="text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
        MCP 配置保存后，下一个新建 session 即可使用最新配置，无需重启服务。
      </p>

      {msg && (
        <p className={`text-sm px-3 py-2 rounded-lg ${
          msg.type === "ok" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}>
          {msg.text}
        </p>
      )}

      {/* Server 列表 */}
      <div className="space-y-2">
        {servers.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-8 border border-dashed border-gray-300 rounded-xl">
            暂无 MCP Server，点击「添加」新增
          </p>
        )}
        {servers.map(([name, cfg]) => (
          <div
            key={name}
            className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-800">{name}</span>
                {cfg.enabled === false && (
                  <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">已禁用</span>
                )}
              </div>
              <p className="text-xs text-gray-500 truncate mt-0.5">
                {cfg.command
                  ? `${cfg.command} ${(cfg.args ?? []).join(" ")}`
                  : cfg.url ?? ""}
              </p>
              {cfg.description && (
                <p className="text-xs text-gray-400 mt-0.5">{cfg.description}</p>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => openEdit(name)}
                className="text-xs px-3 py-1 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50"
              >
                编辑
              </button>
              <button
                onClick={() => handleDelete(name)}
                className="text-xs px-3 py-1 border border-red-300 rounded-lg text-red-600 hover:bg-red-50"
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={openNew}
        className="px-4 py-2 border-2 border-dashed border-indigo-300 text-indigo-600 text-sm rounded-xl hover:bg-indigo-50 transition-colors w-full"
      >
        + 添加 MCP Server
      </button>

      {/* 编辑弹窗 */}
      {edit && (
        <ServerEditModal
          edit={edit}
          onChange={setEdit}
          onSave={handleSaveServer}
          onCancel={() => setEdit(null)}
        />
      )}
    </div>
  );
}

function ServerEditModal({
  edit,
  onChange,
  onSave,
  onCancel,
}: {
  edit: EditState;
  onChange: (e: EditState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { name, config: cfg } = edit;
  const set = (patch: Partial<McpServerConfig>) =>
    onChange({ ...edit, config: { ...cfg, ...patch } });

  const [argsText, setArgsText] = useState((cfg.args ?? []).join(" "));
  const [envText, setEnvText] = useState(
    Object.entries(cfg.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n")
  );

  const handleSave = () => {
    set({
      args: argsText.split(/\s+/).filter(Boolean),
      env: Object.fromEntries(
        envText
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split("=", 2) as [string, string])
      ),
    });
    onSave();
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b">
          <h2 className="font-semibold text-gray-800">
            {name ? `编辑 ${name}` : "添加 MCP Server"}
          </h2>
        </div>
        <div className="px-6 py-4 space-y-4">
          <ModalField label="Server 名称">
            <input
              value={name}
              onChange={(e) => onChange({ ...edit, name: e.target.value })}
              placeholder="filesystem"
              className={inputCls}
              disabled={!!edit.name && Object.keys({}).length > 0}
            />
          </ModalField>
          <ModalField label="描述（可选）">
            <input
              value={cfg.description ?? ""}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="文件系统工具"
              className={inputCls}
            />
          </ModalField>
          <ModalField label="Command（stdio transport）">
            <input
              value={cfg.command ?? ""}
              onChange={(e) => set({ command: e.target.value })}
              placeholder="npx"
              className={inputCls}
            />
          </ModalField>
          <ModalField label="Args（空格分隔）">
            <input
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem /workspace"
              className={inputCls}
            />
          </ModalField>
          <ModalField label="URL（HTTP/SSE transport，可选）">
            <input
              value={cfg.url ?? ""}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="http://mcp-server:8080/sse"
              className={inputCls}
            />
          </ModalField>
          <ModalField label="环境变量（每行 KEY=VALUE）">
            <textarea
              rows={3}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={"API_TOKEN=xxx\nDB_URL=mongodb://..."}
              className={`${inputCls} resize-none`}
            />
          </ModalField>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={cfg.enabled !== false}
              onChange={(e) => set({ enabled: e.target.checked })}
              className="rounded"
            />
            启用此 Server
          </label>
        </div>
        <div className="px-6 py-4 border-t flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  );
}

const inputCls =
  "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400";
