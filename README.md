# Pi Agent Platform

基于 [Pi Coding Agent](https://pi.dev/) 构建的多租户 Agent 执行平台，支持会话管理、SSE 流式输出、bwrap 沙盒隔离、MCP 工具扩展、Skill 渐进式披露和动态配置管理。

---

## 架构总览（精简版）

```mermaid
flowchart LR
    Browser["浏览器\n前端 :3000"]

    subgraph api [API 层]
        Gateway["gateway :8000\n会话 + SSE"]
        Admin["admin :9000\nLLM代理 + 配置"]
    end

    subgraph exec [执行层]
        PiRuntime["pi-runtime\nPi Agent + bwrap"]
        McpServers["MCP Servers\n(按需启动进程)"]
    end

    subgraph store [存储层]
        Redis[("Redis\nPub/Sub + Stream")]
        Mongo[("MongoDB\nsessions/configs/skills")]
        FS[["共享文件系统\nbwrap沙盒 + Skill文件"]]
    end

    subgraph ext [外部]
        LLM["LLM Provider"]
        RemoteMCP["远程MCP\n(可选)"]
    end

    Browser -- "会话/SSE" --> Gateway
    Browser -- "配置管理" --> Admin

    Gateway -- "任务派发" --> Redis
    Gateway -- "SSE拉取" --> Redis
    Gateway -- "session读写" --> Mongo

    Redis -- "任务订阅" --> PiRuntime
    PiRuntime -- "输出推流" --> Redis
    PiRuntime -- "配置读取/状态更新" --> Mongo
    PiRuntime -- "LLM调用" --> Admin
    PiRuntime -- "工具调用" --> McpServers
    PiRuntime -- "沙盒执行/skill加载" --> FS
    McpServers -. "HTTP/SSE" .-> RemoteMCP

    Admin -- "配置持久化" --> Mongo
    Admin -- "SKILL.md写入" --> FS
    Admin -- "转发推理" --> LLM
```

---

## 整体架构（详细版）

```mermaid
flowchart TB
    subgraph client [Client]
        Browser["浏览器\n前端 :3000"]
    end

    subgraph compose [Docker Compose]
        subgraph api [API 层]
            Gateway["gateway\nFastAPI :8000\n会话管理 + SSE 流"]
            Admin["admin\nFastAPI :9000\nLLM 代理 + 配置管理"]
        end

        subgraph runtime [执行层]
            PiRuntime["pi-runtime\nNode.js Worker\nPi Agent RPC + bwrap 沙盒"]
            subgraph mcp [MCP Server 进程（由 pi-mcp-adapter 按需启动）]
                McpFS["filesystem-mcp\n文件读写\n限 /workspace"]
                McpHTTP["http-client-mcp\nHTTP 请求\n沙盒外执行"]
                McpDB["database-mcp\nMongoDB 只读\n沙盒外执行"]
            end
        end

        subgraph storage [存储层]
            Redis[("Redis :6379\nPub/Sub + Stream")]
            subgraph mongo [MongoDB :27017]
                ColSessions[/"sessions\n会话文档 + 事件快照"/]
                ColConfigs[/"configs\nllm / mcp 配置文档"/]
                ColSkills[/"skills\nSkill 元数据\nname/description/tags"/]
            end
        end

        subgraph sandbox [沙盒 + 文件系统（持久化卷）]
            Bwrap["bwrap 沙盒（per session）\nworkspace/ home/ tmp/"]
            SkillFS["Skill 文件系统\nglobal/skills/{name}/SKILL.md\nusers/{uid}/skills/{name}/SKILL.md"]
        end
    end

    subgraph external [外部服务]
        LLM["LLM Provider\nAnthropic / OpenAI / 其他"]
        RemoteMCP["远程 MCP Server（可选）\nHTTP / SSE transport"]
        NFS["共享存储\nNFS / EFS / NAS\n集群部署时使用"]
    end

    %% 用户请求链路
    Browser -->|"POST /sessions\n选 Skill"| Gateway
    Browser -->|"GET /sessions/{id}/stream SSE"| Gateway
    Browser -->|"GET /skills 下拉列表"| Gateway
    Browser -->|"GET/PUT /config/llm\nGET/PUT /config/mcp\nSkill CRUD"| Admin

    %% Gateway ↔ 存储
    Gateway -->|"写 session 文档"| ColSessions
    Gateway -->|"PUBLISH sessions:new"| Redis
    Gateway -->|"XREAD BLOCK stream"| Redis
    Gateway -->|"读 skill 元数据列表"| ColSkills

    %% Admin ↔ 存储（配置管理职责）
    Admin -->|"读写 LLM 配置"| ColConfigs
    Admin -->|"读写 MCP 配置"| ColConfigs
    Admin -->|"写 skill 元数据"| ColSkills
    Admin -->|"写 SKILL.md 文件"| SkillFS

    %% pi-runtime ↔ 存储
    PiRuntime -->|"SUBSCRIBE sessions:new"| Redis
    PiRuntime -->|"XADD 输出事件"| Redis
    PiRuntime -->|"读 MCP 配置"| ColConfigs
    PiRuntime -->|"更新 session 状态"| ColSessions
    PiRuntime -->|"读 SKILL.md 文件\n软链 global+user skills"| SkillFS

    %% pi-runtime 执行
    PiRuntime -->|"POST /v1/chat/completions"| Admin
    PiRuntime -->|"bash 命令\n--unshare-net"| Bwrap
    PiRuntime -->|"按需启动\nstdio transport"| McpFS
    PiRuntime -->|"按需启动\nstdio transport"| McpHTTP
    PiRuntime -->|"按需启动\nstdio transport"| McpDB
    PiRuntime -.->|"可选\nHTTP/SSE transport"| RemoteMCP

    %% Admin ↔ 外部
    Admin -->|"透传 LLM 请求"| LLM

    %% 集群存储
    Bwrap -.->|"集群共享挂载"| NFS
    SkillFS -.->|"集群共享挂载"| NFS
```

---

## MongoDB 存储职责

| 集合 | 写入方 | 读取方 | 内容 |
|------|--------|--------|------|
| `sessions` | gateway（创建）/ pi-runtime（更新状态）| gateway（SSE 回放快照）| 会话文档、事件快照、状态 |
| `configs` | admin（LLM / MCP 配置）| admin（LLM 代理读内存缓存）/ pi-runtime（MCP 配置）| LLM Provider 配置、MCP Server 配置 |
| `skills` | admin（元数据）| gateway（下拉列表）| Skill 名称、描述、标签（不含正文）|

> Skill **正文内容**存储在文件系统（`/data/sandboxes/global/skills/{name}/SKILL.md`），不在 MongoDB 中。pi 原生渐进式披露直接读文件。

---

## MCP Server 管理关系

```
Admin 页配置 MCP Server（POST /config/mcp）
  → 写 MongoDB configs.mcp
  
  session 启动时：
  pi-runtime 读 MongoDB configs.mcp
  → 写 /tmp/pi-config/{session_id}/mcp.json
  → pi-mcp-adapter 加载配置
  → 用户 prompt 触发工具调用时按需启动 MCP Server 进程（stdio）
  → 工具调用完成后进程空闲超时自动退出

外部 MCP Server（HTTP/SSE transport）：
  直接在 mcp.json 中配置 url 字段
  → pi-mcp-adapter 通过 HTTP/SSE 连接，无需本地启动进程
```

---

## Skill 文件系统结构

```
/data/sandboxes/                    ← 共享持久化卷（admin + pi-runtime 共同挂载）
  global/skills/                    ← admin 管理的全局 skill（所有用户可用）
    python-expert/
      SKILL.md                      ← frontmatter(name/description) + 正文
    data-analysis/
      SKILL.md
      scripts/analyze.py            ← Skill tier 3：按需加载的脚本
  users/{user_id}/skills/           ← 用户专属 skill（user 级别隔离，持久化）
    custom-workflow/
      SKILL.md

session 启动时：
  PI_CODING_AGENT_DIR/skills/
    g_python-expert → symlink → global/skills/python-expert/
    u_custom-workflow → symlink → users/{uid}/skills/custom-workflow/
  
  用户选定 skill："--no-skills --skill {path}"（只加载选定的）
  用户未选定："pi 自动扫描 skills/ 目录"（全量渐进式披露）
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
| **frontend** | 3000 | React + Vite + Tailwind | 对话界面 + 管理页面（LLM/MCP/Skill 配置）|
| **gateway** | 8000 | Python FastAPI | 会话 CRUD、SSE 流、Skill 元数据列表 |
| **admin** | 9000 | Python FastAPI | LLM 代理、LLM/MCP/Skill 配置管理、写 SKILL.md 文件 |
| **pi-runtime** | — | Node.js + Pi Agent | Agent 执行、bwrap 沙盒、MCP Server 管理 |
| **redis** | 6379 | Redis 7 | 任务 Pub/Sub + 输出 Stream |
| **mongo** | 27017 | MongoDB 7 | sessions、configs（LLM/MCP）、skills 元数据 |

---

## 快速开始

```bash
# 1. 初始化配置
cp .env.example .env
# 编辑 .env，填写 LLM_API_KEY 和 LLM_BASE_URL

# 2. 一键部署
bash deploy.sh

# 3. 访问
# 前端   → http://localhost:3000
# API    → http://localhost:8000/docs
# Admin  → http://localhost:9000/docs
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
├── admin/                 # FastAPI 管理服务（README.md）
└── pi-runtime/            # Node.js Pi Agent 执行引擎（README.md）
```
