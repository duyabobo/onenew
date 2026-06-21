import json
import logging
import time
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from services.llm_config_store import get_effective_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["llm-proxy"])

# ── 公共工具 ──────────────────────────────────────────────────────────────────

def _apply_model(body: dict[str, Any]) -> dict[str, Any]:
    """始终用代理自身配置的 model 覆盖请求中的 model 字段。"""
    body["model"] = get_effective_config().model
    return body


# ── OpenAI-compatible 协议 ────────────────────────────────────────────────────

def _openai_upstream_url(path: str) -> str:
    cfg = get_effective_config()
    return f"{cfg.base_url.rstrip('/')}{path}"


def _openai_headers() -> dict[str, str]:
    cfg = get_effective_config()
    return {
        "Authorization": f"Bearer {cfg.api_key}",
        "Content-Type": "application/json",
    }


async def _openai_stream(url: str, headers: dict, body: dict, timeout: int) -> StreamingResponse:
    client = httpx.AsyncClient(timeout=timeout)

    async def generator():
        async with client.stream("POST", url, headers=headers, json=body) as resp:
            if resp.status_code != 200:
                err = await resp.aread()
                logger.error("OpenAI 上游流式错误: %d %s", resp.status_code, err[:200])
                yield f"data: {json.dumps({'error': resp.status_code})}\n\n"
                return
            async for chunk in resp.aiter_bytes():
                yield chunk
        await client.aclose()

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _openai_normal(url: str, headers: dict, body: dict, timeout: int) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, headers=headers, json=body)
    if resp.status_code != 200:
        logger.error("OpenAI 上游错误: %d %s", resp.status_code, resp.text[:200])
        from fastapi import HTTPException, status as http_status
        raise HTTPException(status_code=http_status.HTTP_502_BAD_GATEWAY,
                            detail=f"LLM 上游返回 {resp.status_code}")
    return resp.json()


# ── Anthropic 协议 ────────────────────────────────────────────────────────────

_ANTHROPIC_VERSION = "2023-06-01"
_ANTHROPIC_DEFAULT_MAX_TOKENS = 4096


def _anthropic_upstream_url() -> str:
    cfg = get_effective_config()
    return f"{cfg.base_url.rstrip('/')}/v1/messages"


def _anthropic_headers() -> dict[str, str]:
    cfg = get_effective_config()
    return {
        "x-api-key": cfg.api_key,
        "anthropic-version": _ANTHROPIC_VERSION,
        "Content-Type": "application/json",
    }


def _to_anthropic_request(openai_body: dict[str, Any]) -> dict[str, Any]:
    """将 OpenAI Chat Completions 请求体转换为 Anthropic Messages 请求体。"""
    messages = openai_body.get("messages", [])

    # 提取 system 消息（Anthropic 要求 system 作为顶层字段）
    system_parts = [m["content"] for m in messages if m.get("role") == "system"]
    non_system = [m for m in messages if m.get("role") != "system"]

    body: dict[str, Any] = {
        "model": openai_body.get("model", get_effective_config().model),
        "messages": [{"role": m["role"], "content": m["content"]} for m in non_system],
        "max_tokens": openai_body.get("max_tokens") or _ANTHROPIC_DEFAULT_MAX_TOKENS,
    }
    if system_parts:
        body["system"] = "\n\n".join(system_parts)
    if openai_body.get("temperature") is not None:
        body["temperature"] = openai_body["temperature"]
    if openai_body.get("stream"):
        body["stream"] = True
    return body


def _from_anthropic_response(ant_resp: dict[str, Any]) -> dict[str, Any]:
    """将 Anthropic 非流式响应转换为 OpenAI Chat Completions 格式。"""
    text = "".join(
        block.get("text", "")
        for block in ant_resp.get("content", [])
        if block.get("type") == "text"
    )
    stop_reason = ant_resp.get("stop_reason", "end_turn")
    finish_reason = "stop" if stop_reason in ("end_turn", "max_tokens") else stop_reason
    usage = ant_resp.get("usage", {})

    return {
        "id": ant_resp.get("id", f"chatcmpl-{uuid.uuid4().hex}"),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": ant_resp.get("model", get_effective_config().model),
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": usage.get("input_tokens", 0),
            "completion_tokens": usage.get("output_tokens", 0),
            "total_tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
        },
    }


def _anthropic_sse_to_openai(line: str) -> str | None:
    """
    将 Anthropic SSE 行转换为 OpenAI SSE 行。
    返回 None 表示该行不需要转发。

    Anthropic SSE 关键事件：
      event: content_block_delta  → 文本增量
      event: message_stop         → 结束
    """
    if not line.startswith("data:"):
        return None
    raw = line[5:].strip()
    if not raw or raw == "[DONE]":
        return None

    try:
        evt = json.loads(raw)
    except json.JSONDecodeError:
        return None

    evt_type = evt.get("type")

    if evt_type == "content_block_delta":
        delta = evt.get("delta", {})
        if delta.get("type") == "text_delta":
            text = delta.get("text", "")
            openai_chunk = {
                "id": f"chatcmpl-{uuid.uuid4().hex}",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": get_effective_config().model,
                "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
            }
            return f"data: {json.dumps(openai_chunk)}\n\n"

    if evt_type == "message_stop":
        return "data: [DONE]\n\n"

    return None


async def _anthropic_stream(url: str, headers: dict, body: dict, timeout: int) -> StreamingResponse:
    client = httpx.AsyncClient(timeout=timeout)

    async def generator():
        async with client.stream("POST", url, headers=headers, json=body) as resp:
            if resp.status_code != 200:
                err = await resp.aread()
                logger.error("Anthropic 上游流式错误: %d %s", resp.status_code, err[:200])
                yield f"data: {json.dumps({'error': resp.status_code})}\n\n"
                return
            async for line in resp.aiter_lines():
                converted = _anthropic_sse_to_openai(line)
                if converted:
                    yield converted
        await client.aclose()

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _anthropic_normal(url: str, headers: dict, body: dict, timeout: int) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, headers=headers, json=body)
    if resp.status_code != 200:
        logger.error("Anthropic 上游错误: %d %s", resp.status_code, resp.text[:200])
        from fastapi import HTTPException, status as http_status
        raise HTTPException(status_code=http_status.HTTP_502_BAD_GATEWAY,
                            detail=f"Anthropic 上游返回 {resp.status_code}")
    return _from_anthropic_response(resp.json())


# ── 统一入口 ──────────────────────────────────────────────────────────────────

@router.post("/chat/completions", response_model=None)
async def proxy_chat_completions(request: Request) -> StreamingResponse | dict:
    body: dict[str, Any] = await request.json()
    original_model = body.get("model", "<unset>")
    body = _apply_model(body)
    is_stream = body.get("stream", False)

    cfg = get_effective_config()
    logger.info("LLM 代理: protocol=%s model=%s (client=%s) stream=%s → %s",
                cfg.protocol, cfg.model, original_model, is_stream, cfg.base_url)

    if cfg.protocol == "anthropic":
        ant_body = _to_anthropic_request(body)
        url = _anthropic_upstream_url()
        headers = _anthropic_headers()
        if is_stream:
            return await _anthropic_stream(url, headers, ant_body, cfg.timeout)
        return await _anthropic_normal(url, headers, ant_body, cfg.timeout)

    # 默认：openai-compatible
    url = _openai_upstream_url("/chat/completions")
    headers = _openai_headers()
    if is_stream:
        return await _openai_stream(url, headers, body, cfg.timeout)
    return await _openai_normal(url, headers, body, cfg.timeout)
