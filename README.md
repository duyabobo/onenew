# Pi Agent Platform

基于 [Pi Coding Agent](https://pi.dev/) 构建的多租户 Agent 执行平台，支持会话管理、SSE 流式输出、bwrap 沙盒隔离、MCP 工具扩展、Skill 渐进式披露和动态配置管理。

---

## 整体架构（简要版）

```mermaid
%%{init: {"flowchart": {"curve": "linear"}}}%%
flowchart LR
    subgraph mid[" "]
        direction TB
        subgraph row_api[" "]
            direction LR
            Browser["浏览器\n前端 :3000"]
            subgraph api ["接口层"]
                direction TB
                Gateway["gateway\nFastAPI :8000\n会话管理 + SSE 流"]
                Admin["admin\nFastAPI :9000\n配置管理"]
                LLMProxy["LLM Proxy\nFastAPI :9001\nLLM 代理"]
            end
        end
        subgraph piruntime ["执行层（pi-runtime）"]
            direction TB
            McpAdapter["pi-mcp-adapter\nMCP Client"]
            Bwrap["bwrap\nsession 级别的 cmd 执行沙盒"]
            SkillFS["Skill 文件管理\nuser 级别的文件管理系统"]
            PiAgent["任务执行"]
        end
    end

    subgraph persist ["持久化层"]
        direction TB
        NFS["NFS 共享存储\n集群部署"]
        subgraph mongo ["MongoDB :27017  \n  sessions / configs"]
        end
        Gap[ ]
        Redis[("Redis :6379\nPub/Sub + Stream")]
    end

    subgraph capability ["能力层"]
        direction TB
        LLM["LLM Proxy\nAnthropic / OpenAI"]
        McpExt["MCP Servers\n业务工具服务"]
    end

    Browser -->|"会话"| Gateway
    Browser -->|"配置"| Admin

    Gateway -->|"创建会话任务\n获取历史消息"| mongo
    Admin -->|"LLM & MCP 配置"| mongo
    LLMProxy -->|"读取 LLM 配置"| mongo

    Gateway -->|"订阅会话事件"| Redis

    Bwrap -.->|"共享挂载"| NFS
    SkillFS -.->|"共享挂载"| NFS

    PiAgent -->|"增量输出事件"| Redis

    PiAgent -->|"更新会话状态\n存储历史消息\n读取 MCP 配置"| mongo

    piruntime -->|"LLM 推理"| LLM
    McpAdapter -->|"MCP 调用"| McpExt

    style mid fill:none,stroke:none
    style row_api fill:none,stroke:none
    style Gap fill:none,stroke:none,color:transparent
```

---

## 关键请求链路

### 会话创建

```
用户 → POST /sessions { user_id, request, skill_ids }
  → gateway 创建 session（MongoDB）
  → PUBLISH sessions:new（Redis）
  → 返回 session_id
```

### Pi Agent 执行

```
pi-runtime SUBSCRIBE sessions:new
  → 读 MongoDB：MCP 配置
  → 创建 bwrap 沙盒（per session）
  → 软链 global + user skills 到 PI_CODING_AGENT_DIR/skills/
  → 启动 pi --mode rpc
      ├── 用户选了 skill：--no-skills --skill {path}（只披露选定范围）
      ├── 未选 skill：pi 自动扫描，渐进式披露全量 skill
      ├── bash 工具 → bwrap（禁网络）
      └── MCP 工具 → pi-mcp-adapter → 按需启动 MCP Server 进程
  → 每个输出事件 XADD stream（Redis）
  → 任务完成：销毁沙盒
```

### SSE 流式拉取

```
用户 → GET /sessions/{id}/stream
  → gateway 读 MongoDB events_snapshot（断线重连回放）
  → XREAD BLOCK stream（持续拉取）
  → 逐事件推送 SSE
```

---

## 服务一览

| 服务 | 端口 | 技术栈 | 职责 |
|------|------|--------|------|
| **frontend** | 3000 | React + Vite + Tailwind | 对话界面、LLM / MCP / Skill 配置管理页 |
| **gateway** | 8000 | Python FastAPI | 会话 CRUD、SSE 流式输出、Skill 元数据列表 |
| **admin** | 9000 | Python FastAPI | MCP Server 配置、Skill 管理（元数据 + 文件）|
| **llm-proxy** | 9001 | Python FastAPI | LLM 代理（OpenAI 兼容）、Provider 配置热更新 |
| **pi-runtime** | — | Node.js + Pi Agent | Agent 任务执行、bwrap 沙盒隔离、MCP 工具调用 |
| **redis** | 6379 | Redis 7 | 会话任务 Pub/Sub + 增量输出 Stream |
| **mongo** | 27017 | MongoDB 7 | 会话状态、LLM / MCP 配置、Skill 元数据 |

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
├── frontend/              # React + Vite 前端（README.md）
├── gateway/               # FastAPI 会话网关（README.md）
├── admin/                 # FastAPI 管理服务 - MCP/Skill 配置（README.md）
├── llm-proxy/             # FastAPI LLM 代理服务（README.md）
└── pi-runtime/            # Node.js Pi Agent 执行引擎（README.md）
```
