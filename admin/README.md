# Admin 服务（LLM 代理 + 配置管理）

## 职责边界

Admin 是平台的**管理中枢**，承担两类职责：

**1. LLM 代理**
- 对 pi-runtime 暴露 OpenAI 兼容的 `/v1/chat/completions` 接口
- 将请求转发到实际 LLM Provider（Anthropic / OpenAI / 其他）
- 支持流式（`stream: true`）和非流式两种模式
- LLM 配置（base_url / api_key / model）**热更新，无需重启**

**2. 配置管理**
- 通过 `/config/llm` 接口管理 LLM Provider 配置（持久化到 MongoDB）
- 通过 `/config/mcp` 接口管理 MCP Server 配置（持久化到 MongoDB）
- MCP 配置由 **pi-runtime 在每个 session 启动时直接从 MongoDB 读取**，新 session 即生效

**不负责**：
- session / user 管理（由 gateway 负责）
- bwrap 沙盒（由 pi-runtime 负责）
- 直接调用 pi agent

---

## API

### `POST /v1/chat/completions` — LLM 推理代理

OpenAI 兼容格式，直接透传。

```json
{
  "model": "claude-opus-4-5",
  "stream": true,
  "messages": [{"role": "user", "content": "hello"}]
}
```

- `model` 缺省时，自动注入当前生效的默认模型
- `stream: true` 响应为 `text/event-stream`，逐 chunk 透传
- LLM 配置从**内存**读取（零 DB IO），启动时从 MongoDB 加载，`PUT /config/llm` 时热更新

---

### `GET /config/llm` — 读取 LLM 配置

返回当前生效的 LLM 配置（内存读）。

### `PUT /config/llm` — 更新 LLM 配置

```json
{
  "base_url": "https://api.anthropic.com/v1",
  "api_key": "sk-ant-xxx",
  "model": "claude-opus-4-5",
  "timeout": 120
}
```

写入 MongoDB **并立即更新内存**，下一个 LLM 请求即使用新配置，**无需重启**。

---

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

### `GET /health` — 健康检查

```json
{"status": "ok"}
```

---

## 内部实现

```
LLM 代理链路：
  pi-runtime（OPENAI_BASE_URL=http://admin:9000/v1）
    │ POST /v1/chat/completions
    ▼
  admin/routes/proxy.py
    ├── llm_config_store.get_effective_config()  ← 内存读，零 IO
    ├── 注入默认 model（若请求未指定）
    └── 透传到 cfg.base_url + Bearer cfg.api_key

配置更新链路：
  前端 PUT /config/llm
    │
    ▼
  admin/routes/config.py
    ├── mongo_client.save_llm_config()   → MongoDB 持久化
    └── llm_config_store.update_in_memory() → 内存热更新，立即生效

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
| MongoDB | 持久化 LLM / MCP 配置 |
| 外部 LLM Provider | 实际推理 |

**不依赖**：Redis、gateway、pi-runtime

---

## 配置

| 环境变量 | 说明 | 默认值 |
|---------|------|-------|
| `MONGO_URI` | MongoDB 连接串 | `mongodb://mongo:27017` |
| `MONGO_DB` | 数据库名 | `pi_agent` |
| `LLM_BASE_URL` | LLM 接口地址（env 默认值，DB 配置优先）| `https://api.openai.com/v1` |
| `LLM_API_KEY` | LLM API Key（env 默认值，DB 配置优先）| `""` |
| `LLM_MODEL` | 默认模型（env 默认值，DB 配置优先）| `gpt-4o` |
| `LLM_TIMEOUT` | 请求超时（秒）| `120` |
| `ADMIN_HOST` | 监听地址 | `0.0.0.0` |
| `ADMIN_PORT` | 监听端口 | `9000` |

> env 变量作为首次启动的兜底默认值。一旦通过 `PUT /config/llm` 写入 MongoDB，DB 配置优先。
