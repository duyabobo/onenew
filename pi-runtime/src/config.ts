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
    root: process.env.SANDBOX_ROOT ?? "/tmp/pi-sandbox",
  },
  llm: {
    // pi 通过 OPENAI_BASE_URL 和 OPENAI_API_KEY 环境变量使用 admin 服务
    baseUrl: process.env.OPENAI_BASE_URL ?? "http://admin:9000/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "pi-agent-internal",
  },
  // Pi agent 扩展目录（相对于容器内路径）
  extensionsDir: process.env.PI_EXTENSIONS_DIR ?? "/app/extensions",
} as const;
