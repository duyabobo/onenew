# Admin 服务（LLM 代理）

## 职责边界

Admin 是 pi-runtime 和真实 LLM Provider 之间的代理层，负责：

- 提供 OpenAI 兼容的 `/v1/chat/completions` 接口
- 将 pi-runtime 的 LLM 请求转发到实际的 LLM Provider（Anthropic / OpenAI / 其他）
- 支持流式（`stream: true`）和非流式两种模式

**不负责**：
- 业务逻辑（不知道 session、user、workspace 的存在）
- 状态存储（完全无状态）
- 用户认证（内部服务，仅限容器网络访问）
- bwrap 沙盒

**存在意义**：
- 统一 LLM 接入层，pi-runtime 无需感知底层 Provider 差异
- 后续可在此层追加：请求日志、token 计量、多 provider 路由、限流

---

## API

### `POST /v1/chat/completions` — LLM 推理代理

OpenAI 兼容格式，直接透传。

**流式请求示例：**
```json
{
  "model": "claude-opus-4-5",
  "stream": true,
  "messages": [
    {"role": "user", "content": "hello"}
  ]
}
```

- `model` 字段缺省时，自动注入 `LLM_MODEL` 配置的默认模型
- `stream: true` 时，响应为 `text/event-stream`，逐 chunk 透传上游数据
- `stream: false` 时，等待完整响应后返回 JSON

---

### `GET /health` — 健康检查

```json
{"status": "ok"}
```

---

## 内部实现

```
pi-runtime（OPENAI_BASE_URL=http://admin:9000/v1）
  │
  │ POST /v1/chat/completions
  ▼
admin/routes/proxy.py
  ├── 注入默认 model（若请求未指定）
  ├── 追加 Authorization: Bearer {LLM_API_KEY}
  └── 透传到 LLM_BASE_URL
        ├── stream=true  → StreamingResponse，逐 chunk 转发
        └── stream=false → 等待完整响应，返回 JSON
```

---

## 依赖关系

| 依赖 | 用途 |
|------|------|
| 外部 LLM Provider | 实际推理 |

**不依赖**：MongoDB、Redis、gateway、pi-runtime

Admin 是纯粹的 HTTP 代理，无任何内部状态。

---

## 配置

| 环境变量 | 说明 | 示例 |
|---------|------|------|
| `LLM_BASE_URL` | 上游 LLM 接口地址 | `https://api.anthropic.com/v1` |
| `LLM_API_KEY` | 上游 API Key | `sk-ant-xxx` |
| `LLM_MODEL` | 默认模型（请求未指定 model 时使用）| `claude-opus-4-5` |
| `LLM_TIMEOUT` | 请求超时（秒）| `120` |
| `ADMIN_HOST` | 监听地址 | `0.0.0.0` |
| `ADMIN_PORT` | 监听端口 | `9000` |

---

## 扩展方向

在 `admin/routes/proxy.py` 中可追加：

```python
# 请求日志
logger.info("LLM请求 model=%s tokens=%d", body.get("model"), count_tokens(body))

# 多 provider 路由（按 model 前缀路由）
upstream_url = route_by_model(body.get("model"), settings)

# 限流（基于 user_id header）
await rate_limiter.check(request.headers.get("X-User-Id"))
```
