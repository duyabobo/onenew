# Pi-Runtime 服务（Agent 执行引擎）

## 职责边界

Pi-Runtime 是平台的执行核心，负责：

- 订阅 Redis Pub/Sub，消费 gateway 派发的 session 任务
- 为每个 session 创建 bwrap 沙盒（文件系统 + 网络双重隔离）
- 启动 Unix socket 桥，为沙盒提供受控的网络白名单出口
- 以 RPC 模式在沙盒内启动 pi agent，执行用户请求
- 将 pi 生成的 token / 工具调用 / 结果流式推送到 Redis Stream
- 任务完成后销毁沙盒，更新 MongoDB session 状态

**不负责**：
- 对外暴露 HTTP 接口（纯消费者）
- 用户认证 / session 创建（由 gateway 负责）
- LLM 直连（通过 llm-proxy 代理）
- MCP 工具调用（通过 mcp-proxy 代理）
- MCP / LLM 配置管理（由 admin 负责）

---

## 核心组件

```
pi-runtime/
├── src/
│   ├── worker.ts         主入口：Redis 订阅 + session 调度 + socket bridge 启动
│   ├── pi-session.ts     启动 pi RPC 进程（在沙盒内），解析 JSONL 输出
│   ├── sandbox.ts        bwrap 沙盒生命周期（创建 / 销毁）+ 外层 bwrap 参数构建
│   ├── socket-bridge.ts  Unix socket 代理服务器（LLM / MCP 网络白名单）
│   ├── output-stream.ts  Redis Stream XADD 输出推送
│   └── mongo-client.ts   MongoDB：session 状态更新 + 孤儿 session 恢复
└── extensions/
    ├── bwrap/            Pi 扩展：路径白名单校验（read/write/edit），bash 工具适配
    └── sandbox-init/     沙盒启动脚本：启用 loopback + TCP↔Unix socket 桥
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
  ├─ 4. startPiSession
  │       ├── 写 /tmp/pi-config/{sid}/mcp.json（指向沙盒内 mcp-proxy 桥）
  │       ├── 写 /tmp/pi-config/{sid}/models.json（指向沙盒内 llm-proxy 桥）
  │       ├── bwrap 外层沙盒启动 sandbox-init.sh
  │       │     ├── ip link set lo up（启用 loopback）
  │       │     ├── bridge.js（127.0.0.1:9001 ↔ llm.sock，127.0.0.1:8080 ↔ mcp.sock）
  │       │     └── exec pi --mode rpc
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

## 沙盒安全架构

### 双重隔离设计

pi 进程本身运行在外层 bwrap 沙盒内，不仅 bash 命令被隔离，pi 进程本身也被完全隔离：

```
┌─────────────────────────────────────────────────────────┐
│  pi-runtime（宿主进程，有网）                             │
│  socket-bridge: /tmp/pi-socks/llm.sock → llm-proxy     │
│                 /tmp/pi-socks/mcp.sock → mcp-proxy     │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │  bwrap 沙盒（--unshare-net，per session）         │  │
│  │                                                  │  │
│  │  bridge.js: 127.0.0.1:9001 ↔ llm.sock           │  │
│  │             127.0.0.1:8080 ↔ mcp.sock           │  │
│  │                                                  │  │
│  │  pi（--mode rpc）                                │  │
│  │    LLM 调用 → http://127.0.0.1:9001/v1          │  │
│  │    MCP 调用 → http://127.0.0.1:8080/mcp         │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### bwrap 挂载策略

| 挂载参数 | 目录 | 权限 | 说明 |
|---------|------|------|------|
| `--ro-bind / /` | 根文件系统 | 只读 | 提供系统工具、pi 可执行文件 |
| `--tmpfs {sandboxRoot}` | 沙盒根目录 | 内存覆盖 | 对沙盒内隐藏其他 session 数据 |
| `--bind {workspace}` | session 工作目录 | 读写 | pi 的文件操作目标 |
| `--bind {home}` | session home | 读写 | .bashrc / pip 包路径 |
| `--bind {tmp}` | session tmp | 读写 | 临时文件 |
| `--bind {piConfigDir}` | pi config 目录 | 读写 | mcp.json / models.json / bwrap.ready |
| `--ro-bind /tmp/pi-socks` | Unix socket 目录 | **只读** | 网络白名单，pi 只能连接不能篡改 |
| `--unshare-net` | — | — | 完全断网，唯一出口是 Unix socket |
| `--unshare-pid` | — | — | 独立 PID 空间 |

### 网络白名单安全性

`/tmp/pi-socks/` 以只读方式挂载进沙盒：

- pi 只能 **connect** 到 socket（读操作）
- pi 无法**创建、删除、替换** socket 文件（只读目录）
- `--unshare-net` 切断所有其他网络出口
- socket 文件由 pi-runtime 在沙盒外创建，pi 无法伪造

### pi 沙盒内无法访问的内容

| 资源 | 隔离方式 |
|------|---------|
| MongoDB | 无凭据，无网络 |
| Redis | 无凭据，无网络 |
| 其他 session 的文件 | `--tmpfs {sandboxRoot}` 覆盖 |
| 外部网络 / 互联网 | `--unshare-net` |
| MCP Server（直连） | 无路由，只能经由 mcp-proxy |

### bwrap 扩展（extensions/bwrap）

pi 在外层沙盒内运行时（`PI_OUTER_SANDBOX=1`）：

| pi 工具 | 处理方式 |
|--------|---------|
| `bash` | 直接执行（继承外层沙盒的网络和文件系统隔离） |
| `read` / `write` / `edit` | 路径白名单校验（workspace + home 范围内） |
| `find` / `grep` / `ls` | 路径白名单校验 |

---

## Socket Bridge

pi-runtime 启动时创建两个 Unix socket 代理服务器，作为沙盒的网络白名单出口：

```
/tmp/pi-socks/llm.sock  →  llm-proxy:9001  （LLM 推理）
/tmp/pi-socks/mcp.sock  →  mcp-proxy:8080  （MCP 工具调用）
```

两个 socket 均为纯字节转发，不解析协议，支持 HTTP、SSE 等所有 TCP 上层协议。

---

## Sticky Session（集群路由优化）

```
每个 pi-runtime 实例有唯一 INSTANCE_ID = 容器 hostname

认领任务时写入 Redis：
  user:{user_id}:instance = {INSTANCE_ID}  （TTL 24h）

订阅两个频道：
  sessions:new              ← 新用户或未绑定实例的任务
  sessions:{instanceId}:new ← 已绑定到本实例的老用户任务
```

Sticky session 是**性能优化**（减少跨节点 NFS IO），数据安全由共享存储保证。

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

---

## 依赖关系

| 依赖 | 用途 | 方向 |
|------|------|------|
| Redis | 订阅任务 + 推送输出流 | 消费 + 写入 |
| MongoDB | session 状态更新 + 孤儿 session 恢复 | 读写 |
| llm-proxy | LLM 推理（经 Unix socket 桥） | HTTP 调用 |
| mcp-proxy | MCP 工具调用（经 Unix socket 桥） | HTTP 调用 |
| 共享存储卷 | session sandbox 数据 | 读写 |

**不依赖**：gateway（gateway 依赖 pi-runtime，反向不成立）

---

## 配置

| 环境变量 | 说明 | 默认值 |
|---------|------|-------|
| `REDIS_URL` | Redis 连接串 | `redis://redis:6379` |
| `MONGO_URI` | MongoDB 连接串 | `mongodb://mongo:27017` |
| `MONGO_DB` | 数据库名 | `pi_agent` |
| `OPENAI_API_KEY` | LLM 内部 token（传给 pi） | `pi-agent-internal` |
| `SANDBOX_ROOT` | bwrap 沙盒根目录 | `/data/sandboxes` |
| `LLM_PROXY_HOST` | llm-proxy 主机名 | `llm-proxy` |
| `LLM_PROXY_PORT` | llm-proxy 端口 | `9001` |
| `MCP_PROXY_HOST` | mcp-proxy 主机名 | `mcp-proxy` |
| `MCP_PROXY_PORT` | mcp-proxy 端口 | `8080` |

---

## Pi 版本管理

Dockerfile 中锁定 pi 版本：

```dockerfile
ARG PI_VERSION=0.79.9
RUN npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}
```

升级前需验证 bwrap 扩展兼容性，详见 [extensions/bwrap/index.ts](extensions/bwrap/index.ts)。
