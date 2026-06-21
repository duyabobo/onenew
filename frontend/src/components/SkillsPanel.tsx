import { useEffect, useState } from "react";
import { skillsApi, Skill } from "../api/skills";

const EMPTY_SKILL: Skill = { name: "", description: "", content: "", tags: [], hidden: false };

export default function SkillsPanel() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = () =>
    skillsApi.list()
      .then(setSkills)
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const openNew = () => { setEditing({ ...EMPTY_SKILL }); setIsNew(true); setMsg(null); };
  const openEdit = (s: Skill) => { setEditing({ ...s }); setIsNew(false); setMsg(null); };

  const handleDelete = async (name: string) => {
    if (!confirm(`确认删除 Skill "${name}"？`)) return;
    await skillsApi.delete(name);
    setSkills((prev) => prev.filter((s) => s.name !== name));
    setMsg({ type: "ok", text: `已删除 ${name}` });
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name.trim()) { setMsg({ type: "err", text: "Skill 名称不能为空" }); return; }
    if (!editing.description.trim()) { setMsg({ type: "err", text: "描述不能为空（用于前端展示）" }); return; }
    try {
      const saved = await skillsApi.save(editing.name.trim(), editing);
      setSkills((prev) => {
        const idx = prev.findIndex((s) => s.name === saved.name);
        return idx >= 0 ? prev.map((s, i) => (i === idx ? saved : s)) : [...prev, saved];
      });
      setEditing(null);
      setMsg({ type: "ok", text: `${saved.name} 已保存` });
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "保存失败" });
    }
  };

  if (loading) return <div className="text-sm text-gray-400">加载中…</div>;

  return (
    <div className="space-y-4">
      <p className="text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
        Skill 是注入 pi agent system prompt 的指令集。用户在对话页选定 Skill 后，该 Skill 的 content 会直接注入，无需 pi 自动发现选择。
      </p>

      {msg && (
        <p className={`text-sm px-3 py-2 rounded-lg ${
          msg.type === "ok" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}>
          {msg.text}
        </p>
      )}

      <div className="space-y-2">
        {skills.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-8 border border-dashed border-gray-300 rounded-xl">
            暂无 Skill，点击「添加」创建
          </p>
        )}
        {skills.map((s) => (
          <div key={s.name} className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-800">{s.name}</span>
                {s.hidden && <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">隐藏</span>}
                {(s.tags ?? []).map((t) => (
                  <span key={t} className="text-xs bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded">{t}</span>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-0.5 truncate">{s.description}</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => openEdit(s)} className="text-xs px-3 py-1 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50">编辑</button>
              <button onClick={() => handleDelete(s.name)} className="text-xs px-3 py-1 border border-red-300 rounded-lg text-red-600 hover:bg-red-50">删除</button>
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={openNew}
        className="px-4 py-2 border-2 border-dashed border-indigo-300 text-indigo-600 text-sm rounded-xl hover:bg-indigo-50 transition-colors w-full"
      >
        + 添加 Skill
      </button>

      {editing && (
        <SkillEditModal
          skill={editing}
          isNew={isNew}
          onChange={setEditing}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function SkillEditModal({ skill, isNew, onChange, onSave, onCancel }: {
  skill: Skill;
  isNew: boolean;
  onChange: (s: Skill) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<Skill>) => onChange({ ...skill, ...patch });
  const [tagsText, setTagsText] = useState((skill.tags ?? []).join(", "));

  const handleSave = () => {
    set({ tags: tagsText.split(",").map((t) => t.trim()).filter(Boolean) });
    onSave();
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b">
          <h2 className="font-semibold text-gray-800">{isNew ? "添加 Skill" : `编辑 ${skill.name}`}</h2>
        </div>
        <div className="px-6 py-4 space-y-4">
          <Field label="Skill 名称（英文，如 python-expert）">
            <input
              value={skill.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="python-expert"
              disabled={!isNew}
              className={cls + (isNew ? "" : " bg-gray-50 text-gray-400")}
            />
          </Field>
          <Field label="描述（前端下拉展示 + 用户理解用途）">
            <input
              value={skill.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="当用户需要写 Python 代码、调试 Python 错误时使用"
              className={cls}
            />
          </Field>
          <Field label="Content（注入 pi system prompt 的完整指令）">
            <textarea
              rows={10}
              value={skill.content}
              onChange={(e) => set({ content: e.target.value })}
              placeholder={"你是一个 Python 专家。\n\n处理 Python 任务时遵循以下规范：\n1. 优先使用类型注解\n2. ..."}
              className={cls + " resize-y font-mono text-xs"}
            />
          </Field>
          <Field label="标签（逗号分隔，如 coding, python）">
            <input
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="coding, python"
              className={cls}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={skill.hidden ?? false}
              onChange={(e) => set({ hidden: e.target.checked })}
              className="rounded"
            />
            隐藏（不在对话页下拉列表显示）
          </label>
        </div>
        <div className="px-6 py-4 border-t flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">取消</button>
          <button onClick={handleSave} className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">保存</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  );
}

const cls = "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400";
