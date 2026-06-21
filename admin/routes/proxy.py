import json
import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["llm-proxy"])

# 需要透传给上游的请求头
_FORWARD_HEADERS = {"content-type", "accept"}


def _build_upstream_url(path: str) -> str:
    base = settings.llm_base_url.rstrip("/")
    return f"{base}{path}"


def _build_upstream_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.llm_api_key}",
        "Content-Type": "application/json",
    }


def _inject_default_model(body: dict[str, Any]) -> dict[str, Any]:
    """如果请求体未指定 model，注入 admin 配置的默认模型"""
    if not body.get("model"):
        body["model"] = settings.llm_model
        logger.debug("注入默认模型: %s", settings.llm_model)
    return body


async def _stream_upstream_response(upstream_resp: httpx.Response):
    """逐块透传流式响应"""
    async for chunk in upstream_resp.aiter_bytes():
        yield chunk


@router.post("/chat/completions")
async def proxy_chat_completions(request: Request) -> StreamingResponse | dict:
    """
    OpenAI 兼容的 /v1/chat/completions 代理。
    支持 stream=true 流式透传和普通 JSON 响应。
    """
    body: dict[str, Any] = await request.json()
    body = _inject_default_model(body)
    is_stream = body.get("stream", False)

    upstream_url = _build_upstream_url("/chat/completions")
    headers = _build_upstream_headers()

    logger.info(
        "LLM 请求转发: model=%s stream=%s upstream=%s",
        body.get("model"),
        is_stream,
        settings.llm_base_url,
    )

    if is_stream:
        return await _handle_stream_request(upstream_url, headers, body)
    return await _handle_normal_request(upstream_url, headers, body)


async def _handle_stream_request(
    url: str, headers: dict[str, str], body: dict[str, Any]
) -> StreamingResponse:
    """流式请求：打开连接后持续透传 SSE 数据块"""
    client = httpx.AsyncClient(timeout=settings.llm_timeout)
    upstream_req = client.stream("POST", url, headers=headers, json=body)

    async def generator():
        async with upstream_req as resp:
            if resp.status_code != 200:
                error_body = await resp.aread()
                logger.error("LLM 上游错误: %d %s", resp.status_code, error_body[:200])
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


async def _handle_normal_request(
    url: str, headers: dict[str, str], body: dict[str, Any]
) -> dict:
    """普通请求：等待完整响应后返回"""
    async with httpx.AsyncClient(timeout=settings.llm_timeout) as client:
        resp = await client.post(url, headers=headers, json=body)

    if resp.status_code != 200:
        logger.error("LLM 上游错误: %d", resp.status_code)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"LLM 上游返回 {resp.status_code}",
        )

    return resp.json()
