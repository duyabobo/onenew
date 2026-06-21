# Pi-Runtime 服务（Agent 执行引擎）

## 职责边界

Pi-Runtime 是平台的执行核心，负责：

- 订阅 Redis Pub/Sub，消费 gateway 派发的 session 任务
- 为每个 session 创建独立的 bwrap 沙盒（文件系统隔离）
- 以 RPC 模式启动 pi agent，执行用户请求
- 将 pi 生成的 token / 工具调用 / 结果流式推送到 Redis Stream
- 任务完成后销毁 bwrap 沙盒，更新 MongoDB session 状态

**不负责**：
- 对外暴露 HTTP 接口（纯消费者）
- 用户认证 / session 创建（由 gateway 负责）
- LLM 直连（通过 admin 代理）

---

## 核心组件

```
pi-runtime/
├── src/
│   ├── worker.ts         主入口：Redis 订阅 + session 调度
│   ├── pi-session.ts     启动 pi RPC 进程，解析 JSONL 输出
│   ├── sandbox.ts        bwrap 沙盒生命周期（创建 / 执行 / 销毁）
│   ├── output-stream.ts  Redis Stream XADD 输出推送
│   └── mongo-client.ts   MongoDB session 状态更新
└── extensions/
    ├── bwrap/            Pi 扩展：拦截 bash 工具调用，路由到 bwrap
    └── mcp-servers/      MCP 工具服务器（http-client / database）
```

---

## 任务处理流程

```
Redis Pub/Sub: sessions:new / sessions:{instanceId}:new
  │
  ▼
worker.ts: 收到任务 payload { session_id, user_id, request }
  │
  ├─ 1. bindUserToInstance → 写 Redis（sticky session 路由优化）
  ├─ 2. updateSessionStatus → MongoDB RUNNING
  ├─ 3. createSandbox → 创建 /data/sandboxes/users/{uid}/sessions/{sid}/
  │                       workspace/  home/  tmp/
  │
  ├─ 4. runPiSession → 启动 pi --mode rpc 子进程
  │       ├── 注入环境变量（PI_SANDBOX_WORKSPACE / HOME / TMP）
  │       ├── 设置 CWD = workspace 目录
  │       ├── 发送 prompt → pi stdin
  │       └── 解析 pi stdout JSONL：
  │             text event      → XADD session:{id}:stream event_type=token
  │             tool_call event → XADD event_type=tool_call
  │             tool_result     → XADD event_type=tool_result
  │             done event      → XADD event_type=done
  │
  ├─ 5. outputStream.expire(3600) → Redis Stream TTL 1h
  ├─ 6. updateSessionStatus → MongoDB COMPLETED
  └─ 7. destroySandbox → 删除 session 沙盒目录
```

---

## bwrap 沙盒

### 隔离粒度：session 级别

每个 session 拥有完全独立的文件系统，不同 session（哪怕同一 user）互不可见：

```
/data/sandboxes/users/{user_id}/sessions/{session_id}/
  workspace/   ← pi 的工作目录，读写，session 结束后销毁
  home/        ← 独立 HOME（.bashrc / pip 包路径），session 结束后销毁
  tmp/         ← 临时文件，session 结束后销毁
```

### bwrap 挂载策略

```
--ro-bind / /                      → 根文件系统只读（提供系统工具、Python 运行时）
--bind {workspace} {workspace}     → workspace 可读写（路径内外一致）
--bind {home} {home}               → home 可读写（路径内外一致）
--bind {tmp} {tmp}                 → tmp 可读写
--unshare-net                      → 禁止网络
--unshare-pid                      → 独立 PID 空间
--die-with-parent                  → pi 进程退出时自动终止沙盒子进程
```

### 路径一致性（关键设计）

bwrap 内外使用**相同的绝对路径**（不用 `/workspace` 别名）：

- pi 的 `bash` 工具（bwrap 子进程）看到的路径 = `/data/.../workspace/`
- pi 的 `read/write/edit` 工具（Node.js 进程）看到的路径 = `/data/.../workspace/`
- 两者操作同一个物理目录，无路径映射歧义

### 工具拦截（bwrap 扩展）

| pi 工具 | 执行位置 | 处理方式 |
|--------|---------|---------|
| `bash` | bwrap 子进程 | 完全替换：所有命令走 bwrap，禁网络 |
| `read` | Node.js 进程 | 路径白名单校验，越界绝对路径拦截 |
| `write` | Node.js 进程 | 路径白名单校验，越界绝对路径拦截 |
| `edit` | Node.js 进程 | 路径白名单校验，越界绝对路径拦截 |

---

## MCP 工具

pi 通过 `pi-mcp-adapter` 扩展调用外部工具（MCP 协议）。

配置文件：`~/.pi/agent/mcp.json`（构建时从 `config/mcp.json` 复制）

| MCP 服务器 | 工具 | 网络访问 | 说明 |
|-----------|------|---------|------|
| filesystem | 文件读写 | 无 | 限制在 /workspace 目录 |
| http-client | http_get / http_post | 有 | 运行在沙盒外，可访问外网 |
| database | db_find / db_count | 有 | MongoDB 只读查询 |

> MCP 服务器作为独立进程运行，**不在 bwrap 沙盒内**，可正常访问网络。

---

## Sticky Session（集群路由优化）

```
每个 pi-runtime 实例有唯一 INSTANCE_ID = 容器 hostname

认领任务时写入 Redis：
  user:{user_id}:instance = {INSTANCE_ID}  （TTL 24h）

订阅两个频道：
  sessions:new              ← 新用户或未绑定实例的任务
  sessions:{instanceId}:new ← 已绑定到本实例的老用户任务

Gateway 派发逻辑：
  查到 user:alice:instance = node-1 → PUBLISH sessions:node-1:new
  未查到                            → PUBLISH sessions:new（任意实例处理）
```

Sticky session 是**性能优化**，减少 NFS 跨节点 IO 竞争。
数据安全由共享存储（NFS/EFS）保证，即使路由到不同节点数据也不丢失。

---

## 集群部署

多个 pi-runtime 实例必须挂载同一共享存储卷（NFS/EFS/NAS）：

```yaml
# docker-compose.prod.yml
volumes:
  sandbox_workspaces:
    driver: local
    driver_opts:
      type: nfs
      o: "addr=${NFS_SERVER_ADDR},rw,nfsvers=4"
      device: ":${NFS_EXPORT_PATH}"
```

所有节点挂载路径均为 `/data/sandboxes/users/`，user 数据跨节点可见。

---

## 依赖关系

| 依赖 | 用途 | 方向 |
|------|------|------|
| Redis | 订阅任务 + 推送输出流 | 消费 + 写入 |
| MongoDB | 更新 session 状态 | 写入 |
| Admin | LLM 推理代理 | HTTP 调用 |
| 共享存储卷 | 用户 workspace 持久化 | 读写 |

**不依赖**：gateway（gateway 依赖 pi-runtime，反向不成立）

---

## 配置

| 环境变量 | 说明 | 默认值 |
|---------|------|-------|
| `REDIS_URL` | Redis 连接串 | `redis://redis:6379` |
| `MONGO_URI` | MongoDB 连接串 | `mongodb://mongo:27017` |
| `MONGO_DB` | 数据库名 | `pi_agent` |
| `OPENAI_BASE_URL` | LLM 代理地址（指向 admin）| `http://admin:9000/v1` |
| `OPENAI_API_KEY` | LLM 内部 token | `pi-agent-internal` |
| `SANDBOX_ROOT` | bwrap 沙盒根目录 | `/data/sandboxes` |

---

## Pi 版本管理

Dockerfile 中锁定 pi 版本：

```dockerfile
ARG PI_VERSION=0.79.9
RUN npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}
```

升级前需验证 bwrap 扩展兼容性，详见 [bwrap 扩展注释](../pi-runtime/extensions/bwrap/index.ts)。
