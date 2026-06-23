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
    root: process.env.SANDBOX_ROOT ?? "/data/sandboxes",
  },
} as const;
