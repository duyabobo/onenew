export const config = {
  port: Number(process.env.MCP_PROXY_PORT ?? 8080),
  mongo: {
    uri: process.env.MONGO_URI ?? "mongodb://mongo:27017",
    db: process.env.MONGO_DB ?? "pi_agent",
  },
  // 工具列表缓存刷新间隔（ms）。MCP 配置变更后最多等待此时间生效。
  toolRefreshIntervalMs: Number(process.env.TOOL_REFRESH_INTERVAL_MS ?? 60_000),
} as const;
