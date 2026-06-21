# Admin 服务（配置管理）

## 职责边界

Admin 是平台的**配置管理中枢**，专注于两类职责：

**1. MCP 配置管理**
- 通过 `/config/mcp` 接口管理 MCP Server 配置（持久化到 MongoDB）
- MCP 配置由 **pi-runtime 在每个 session 启动时直接从 MongoDB 读取**，新 session 即生效

**2. Skill 管理**
- 通过 `/config/skills` 接口管理 global Skill（元数据写 MongoDB，正文写文件系统）
- Skill 正文（SKILL.md）存储在共享文件系统，pi 直接读取，原生渐进式披露

**不负责**：
- LLM 代理 / LLM 配置（由独立的 **llm-proxy** 服务负责）
- session / user 管理（由 gateway 负责）
- bwrap 沙盒（由 pi-runtime 负责）
- 直接调用 pi agent

---

## API

### `GET /config/mcp` — 读取 MCP 配置

返回所有已配置的 MCP Server 列表。

### `PUT /config/mcp` — 全量替换 MCP 配置

### `POST /config/mcp/servers/{name}` — 添加或更新单个 MCP Server

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
  "description": "文件系统工具",
  "enabled": true
}
```

### `DELETE /config/mcp/servers/{name}` — 删除 MCP Server

MCP 配置变更后，**下一个新建 session** 的 pi-runtime 会读取最新配置，无需重启任何服务。

---

### `GET /config/skills` — 列出所有 global Skill 元数据

### `GET /config/skills/{name}/content` — 读取 Skill 正文

### `POST /config/skills/{name}` — 创建或更新 Skill

```json
{
  "description": "Python 专家",
  "content": "---\nname: python-expert\n---\n正文内容...",
  "tags": ["python", "coding"],
  "hidden": false
}
```

### `DELETE /config/skills/{name}` — 删除 Skill

---

### `GET /health` — 健康检查

```json
{"status": "ok"}
```

---

## 内部实现

```
MCP 配置读取（pi-runtime 侧）：
  pi-runtime/src/mongo-client.ts: getMcpConfig()
    → 直接读 MongoDB configs.mcp（每 session 启动时调用一次）
    → 写入 /tmp/pi-config/{session_id}/mcp.json
    → 通过 PI_CODING_AGENT_DIR 让 pi 使用该目录
```

---

## 依赖关系

| 依赖 | 用途 |
|------|------|
| MongoDB | 持久化 MCP 配置、Skill 元数据 |
| 共享文件系统 | 读写 SKILL.md 文件 |

**不依赖**：Redis、gateway、pi-runtime、llm-proxy

---

## 配置

| 环境变量 | 说明 | 默认值 |
|---------|------|-------|
| `MONGO_URI` | MongoDB 连接串 | `mongodb://mongo:27017` |
| `MONGO_DB` | 数据库名 | `pi_agent` |
| `SANDBOX_ROOT` | 共享文件系统根目录 | `/data/sandboxes` |
| `ADMIN_HOST` | 监听地址 | `0.0.0.0` |
| `ADMIN_PORT` | 监听端口 | `9000` |
