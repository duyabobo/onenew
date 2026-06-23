# Pi Agent Platform

基于 [Pi Coding Agent](https://pi.dev/) 构建的多租户 Agent 执行平台，支持会话管理、SSE 流式输出、bwrap 沙盒隔离、MCP 工具扩展、Skill 渐进式披露和动态配置管理。

---

## 整体架构

```mermaid
%%{init: {"flowchart": {"curve": "linear", "nodeSpacing": 80}}}%%
flowchart TB
    Browser["浏览器\n前端 :3000"]

    subgraph mid [" "]
        direction LR
        subgraph api ["接口层"]
            direction TB
            Gateway["gateway\nFastAPI :8000\n会话管理 + SSE 流"]
            Admin["admin\nFastAPI :9000\n配置管理"]
        end
        subgraph execution ["执行层"]
            direction LR
            subgraph proxies [" "]
                direction TB
                LLMProxy["llm-proxy\nFastAPI :9001\nLLM 代理"]
                McpProxy["mcp-proxy\nFastAPI :8080\nMCP 代理"]
            end
            subgraph piruntime ["pi-runtime"]
                Bwrap["bwrap 沙盒\nsession 级别 · 完全无网络\n（pi + pi-mcp-adapter）"]
            end
        end
    end

    subgraph persist ["持久化层"]
        direction LR
        Redis[("Redis\n:6379")]
        MongoDB[("MongoDB\n:27017")]
        PadNode[ ]
        NFS["NFS\n共享存储"]
    end

    Browser --> Gateway
    Browser --> Admin

    Gateway -->|"订阅会话事件"| Redis
    Gateway -->|"创建会话\n读取会话历史"| MongoDB
    Admin -->|"LLM & MCP 配置"| MongoDB
    Admin -->|"Skill 创建"| NFS

    Bwrap -->|"LLM 推理\nUnix socket"| LLMProxy
    Bwrap -->|"MCP 调用\nUnix socket"| McpProxy

    execution -->|"推送会话事件"| Redis
    execution -->|"读取 mcp/llm 配置\n写入会话历史"| MongoDB
    execution -->|"workspace / Skill 挂靠"| NFS

    style mid fill:none,stroke:none
    style proxies fill:none,stroke:none
    style PadNode fill:none,stroke:none,color:transparent
```

---

| 服务 | 端口 | 技术栈 | 职责 |
|------|------|--------|------|
| **frontend** | 3000 | React + Vite + Tailwind | 对话界面、LLM / MCP / Skill 配置管理页 |
| **gateway** | 8000 | Python FastAPI | 会话 CRUD、SSE 流式输出、Skill 元数据列表 |
| **admin** | 9000 | Python FastAPI | MCP Server 配置、Skill 管理（元数据 + 文件）|
| **llm-proxy** | 9001 | Python FastAPI | LLM 代理（OpenAI 兼容）、Provider 配置热更新 |
| **mcp-proxy** | 8080 | Python FastAPI | MCP 聚合代理：汇总所有 MCP Server 工具，统一路由调用 |
| **pi-runtime** | — | Node.js + Pi Agent | Agent 任务执行、bwrap 沙盒隔离、Unix socket 网络白名单 |
| **redis** | 6379 | Redis 7 | 会话任务 Pub/Sub + 增量输出 Stream |
| **mongo** | 27017 | MongoDB 7 | 会话数据、LLM / MCP 配置、Skill 元数据 |

---

## 快速开始

```bash
# 一键部署（首次运行自动创建 .env）
bash deploy.sh

# 访问
# 前端      → http://localhost:3000
# API       → http://localhost:8000/docs
# Admin     → http://localhost:9000/docs
# LLM Proxy → http://localhost:9001/docs

# 启动后在前端管理页面配置 LLM Provider（base_url / api_key / model）
```

## 集群部署

```bash
# 生产集群：3 个 pi-runtime 实例，NFS 共享存储
NFS_SERVER_ADDR=192.168.1.100 NFS_EXPORT_PATH=/data/pi-sandboxes \
  bash deploy.sh --prod --scale 3
```

---

## 目录结构

```
pi-agent-platform/
├── README.md              # 本文件
├── deploy.sh              # 一键部署脚本
├── docker-compose.yml     # 单节点编排
├── docker-compose.prod.yml # 集群覆盖配置（NFS 卷）
├── .env.example
├── frontend/              # React + Vite 前端 
├── gateway/               # FastAPI 会话网关 
├── admin/                 # FastAPI 管理服务 - MCP/Skill 配置 
├── llm-proxy/             # FastAPI LLM 代理服务 
├── mcp-proxy/             # FastAPI MCP 聚合代理 
└── pi-runtime/            # Node.js Pi Agent 执行引擎 
```
