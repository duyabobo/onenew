export interface LlmConfig {
  base_url: string;
  api_key: string;
  model: string;
  timeout: number;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  description?: string;
  enabled?: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
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

// 所有 config API 请求到 admin 服务（/config/* → admin:9000）
export const configApi = {
  getLlm: () => request<LlmConfig | null>("/config/llm"),
  saveLlm: (cfg: LlmConfig) =>
    request<LlmConfig>("/config/llm", { method: "PUT", body: JSON.stringify(cfg) }),

  getMcp: () => request<McpConfig>("/config/mcp"),
  saveMcp: (cfg: McpConfig) =>
    request<McpConfig>("/config/mcp", { method: "PUT", body: JSON.stringify(cfg) }),
  addServer: (name: string, cfg: McpServerConfig) =>
    request<McpConfig>(`/config/mcp/servers/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify(cfg),
    }),
  deleteServer: (name: string) =>
    request<McpConfig>(`/config/mcp/servers/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
};
