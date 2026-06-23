# mcp-proxy 服务（MCP 聚合代理）

## 职责边界

mcp-proxy 是 MCP 工具调用的统一出口，负责：

- 从 MongoDB 读取所有已启用的 MCP Server 配置
- 连接各后端 MCP Server，汇总工具列表
- 对外暴露单一 MCP HTTP 端点，供沙盒内 pi 调用
- 将 pi 的工具调用请求路由到对应的后端 MCP Server 并返回结果

**不负责**：
- 用户认证（由 gateway 负责）
- MCP 配置的写入（由 admin 负责）
- 直接执行任何工具逻辑（纯代理转发）

---

## 在整体架构中的位置

```
pi（bwrap 沙盒内，完全无网）
  ↓ HTTP 127.0.0.1:8080（loopback）
  ↓ Unix socket /tmp/pi-socks/mcp.sock（挂载进沙盒）
  ↓ TCP
mcp-proxy（沙盒外，有网）
  ↓ MCP HTTP 协议
真实 MCP Server 1、2、N...
```

pi 通过 mcp-proxy 间接调用外部工具，沙盒内没有任何 MCP Server 的连接信息，也无法绕过代理直接访问。

---

## 核心组件

```
mcp-proxy/
└── src/
    ├── config.ts           环境变量配置（端口、MongoDB、刷新间隔）
    ├── mongo-client.ts     只读 MongoDB：读取启用的 MCP Server 列表
    ├── mcp-aggregator.ts   聚合器：连接后端、汇总工具、路由调用
    └── index.ts            HTTP 服务器入口，实现 MCP JSON-RPC 协议
```

---

## 工具刷新机制

mcp-proxy 不在启动时一次性加载所有工具，而是采用**带 TTL 的懒刷新**策略：

```
每个 MCP 请求到来时：
  → 检查距上次刷新是否超过 TOOL_REFRESH_INTERVAL_MS（默认 60s）
  → 超过则重新连接所有后端，拉取最新工具列表
  → 未超过则直接使用缓存

admin 修改 MCP 配置后，最多等待 60s 自动生效，无需重启 mcp-proxy。
```

**工具名冲突处理**：同名工具以先发现的后端为准，并打印 WARN 日志。

---

## MCP 协议实现

遵循 MCP 2025-03-26 Streamable HTTP 规范：

| 方法 | 处理方式 |
|------|---------|
| `initialize` | 返回服务能力声明（`{ tools: {} }`） |
| `tools/list` | 返回聚合后的全量工具列表 |
| `tools/call` | 路由到对应后端执行，返回结果 |
| `notifications/*` | 确认（202，无响应体） |

所有响应均为 `application/json`，不使用 SSE 流式传输（工具调用本身是同步的）。

---

## 依赖关系

| 依赖 | 用途 | 方向 |
|------|------|------|
| MongoDB | 读取 MCP Server 配置 | 只读 |
| 各 MCP Server | 工具发现 + 工具调用 | HTTP 调用 |

**不依赖**：Redis、gateway、pi-runtime、llm-proxy

---

## 配置

| 环境变量 | 说明 | 默认值 |
|---------|------|-------|
| `MCP_PROXY_PORT` | 服务监听端口 | `8080` |
| `MONGO_URI` | MongoDB 连接串 | `mongodb://mongo:27017` |
| `MONGO_DB` | 数据库名 | `pi_agent` |
| `TOOL_REFRESH_INTERVAL_MS` | 工具列表刷新间隔（毫秒）| `60000` |
