export const config = {
  redis: {
    url: process.env.REDIS_URL ?? "redis://redis:6379",
    taskChannel: "sessions:new",
  },
  mongo: {
    uri: process.env.MONGO_URI ?? "mongodb://mongo:27017",
    db: process.env.MONGO_DB ?? "pi_agent",
  },
  sandbox: {
    // 沙盒根目录，用于构建 user 持久化工作空间路径
    // 结构：{root}/users/{user_id}/workspace/  → bwrap /workspace（持久化）
    //        {root}/users/{user_id}/home/       → bwrap /root（持久化）
    //        {root}/users/{user_id}/sessions/{sid}/tmp/ → bwrap /tmp（临时）
    root: process.env.SANDBOX_ROOT ?? "/data/sandboxes",
  },
  llm: {
    // pi 通过 OPENAI_BASE_URL 和 OPENAI_API_KEY 环境变量使用 admin 服务
    baseUrl: process.env.OPENAI_BASE_URL ?? "http://admin:9000/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "pi-agent-internal",
  },
  // Pi agent 扩展目录（相对于容器内路径）
  extensionsDir: process.env.PI_EXTENSIONS_DIR ?? "/app/extensions",
} as const;
