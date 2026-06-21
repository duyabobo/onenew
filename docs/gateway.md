# Gateway 服务

## 职责边界

Gateway 是整个平台对外的唯一入口，负责：

- 接收用户请求，创建/查询 Session
- 向 pi-runtime 派发任务（通过 Redis Pub/Sub）
- 通过 SSE 接口将 pi-runtime 的流式输出返回给客户端

**不负责**：
- 执行 pi agent（由 pi-runtime 负责）
- 调用 LLM（由 pi-runtime 通过 admin 负责）
- 文件系统操作（由 pi-runtime 内部处理）
- bwrap 沙盒管理

---

## API

### `POST /sessions` — 创建或复用会话

**请求体：**
```json
{
  "user_id": "alice",
  "request": "帮我写一个冒泡排序"
}
```

**响应：**
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "PENDING"
}
```

**幂等性**：相同 `user_id + request` 且任务未结束时，返回已有 session_id，不重复创建。

同一用户可同时发起多个不同 `request` 的会话（session 级文件系统隔离，互不影响）。

---

### `GET /sessions/{session_id}` — 查询会话详情

返回 session 的完整文档，包含 status / request / events_snapshot 等字段。

**状态流转：**
```
PENDING → RUNNING → COMPLETED
                  → FAILED
```

---

### `GET /sessions/{session_id}/stream` — SSE 流式拉取

`Content-Type: text/event-stream`

**查询参数：**
- `last_seq`（可选，默认 `0`）：断线重连时传入上次收到的 Redis Stream ID，跳过已接收消息

**响应事件类型：**

| event 名 | 含义 | data 格式 |
|----------|------|-----------|
| `snapshot` | 历史事件快照（断线重连时回放）| `{"events": [...]}` |
| `token` | pi 生成的文本 token | 原始文本 |
| `tool_call` | pi 调用工具 | `{"name": "bash", "input": {...}}` |
| `tool_result` | 工具执行结果 | `{"name": "bash", "output": "..."}` |
| `done` | 任务完成 | `""` |
| `error` | 任务出错 | 错误信息文本 |
| `heartbeat` | 保活心跳（5s 一次）| `""` |

**断线重连示例：**
```
# 客户端记录最后收到的 event id（即 Redis Stream ID）
curl -N "http://localhost:8000/sessions/SESSION_ID/stream?last_seq=1718000000000-0"
```

---

## 内部实现

```
客户端
  │
  │ POST /sessions
  ▼
gateway/routes/session.py
  ├── 查询 MongoDB: find_active_session_by_request（幂等）
  ├── 创建 MongoDB session 文档（status: PENDING）
  └── PUBLISH sessions:new → Redis
                               │
                               └── pi-runtime 消费

  │ GET /sessions/{id}/stream
  ▼
gateway/routes/stream.py
  ├── 从 MongoDB 读取 events_snapshot（断线重连回放）
  └── XREAD BLOCK session:{id}:stream → 持续从 Redis Stream 拉取
```

---

## 依赖关系

| 依赖 | 用途 | 连接方式 |
|------|------|---------|
| MongoDB | 存储 session 文档 | motor（async）|
| Redis | 发布任务 / 读取输出流 | redis[asyncio] |

**不依赖**：admin、pi-runtime（单向依赖，gateway 不调用这两个服务）

---

## 配置

| 环境变量 | 说明 | 默认值 |
|---------|------|-------|
| `MONGO_URI` | MongoDB 连接串 | `mongodb://mongo:27017` |
| `MONGO_DB` | 数据库名 | `pi_agent` |
| `REDIS_URL` | Redis 连接串 | `redis://redis:6379` |
| `GATEWAY_HOST` | 监听地址 | `0.0.0.0` |
| `GATEWAY_PORT` | 监听端口 | `8000` |
| `SSE_BLOCK_MS` | SSE 拉取阻塞超时（心跳间隔）| `5000` |
