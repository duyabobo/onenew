export interface Skill {
  name: string;
  description: string;
  content?: string;
  tags?: string[];
  hidden?: boolean;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail ?? `HTTP ${resp.status}`);
  }
  return resp.json();
}

export const skillsApi = {
  // 列表接口走 gateway（前端用于下拉选择）
  list: () => request<Skill[]>("/skills"),

  // CRUD 接口走 admin（管理页面）
  get: (name: string) => request<Skill>(`/config/skills/${encodeURIComponent(name)}`),
  save: (name: string, skill: Skill) =>
    request<Skill>(`/config/skills/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify(skill),
    }),
  delete: (name: string) =>
    fetch(`/config/skills/${encodeURIComponent(name)}`, { method: "DELETE" }),
};
