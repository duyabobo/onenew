import json
import logging
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from services.llm_config_store import get_effective_config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["llm-proxy"])


def _build_upstream_url(path: str) -> str:
    cfg = get_effective_config()
    return f"{cfg.base_url.rstrip('/')}{path}"


def _build_upstream_headers() -> dict[str, str]:
    cfg = get_effective_config()
    return {
        "Authorization": f"Bearer {cfg.api_key}",
        "Content-Type": "application/json",
    }


def _inject_default_model(body: dict[str, Any]) -> dict[str, Any]:
    if not body.get("model"):
        body["model"] = get_effective_config().model
    return body


@router.post("/chat/completions")
async def proxy_chat_completions(request: Request) -> StreamingResponse | dict:
    body: dict[str, Any] = await request.json()
    body = _inject_default_model(body)
    is_stream = body.get("stream", False)

    cfg = get_effective_config()
    logger.info("LLM 代理: model=%s stream=%s → %s", body.get("model"), is_stream, cfg.base_url)

    upstream_url = _build_upstream_url("/chat/completions")
    headers = _build_upstream_headers()

    if is_stream:
        return await _handle_stream(upstream_url, headers, body, cfg.timeout)
    return await _handle_normal(upstream_url, headers, body, cfg.timeout)


async def _handle_stream(url: str, headers: dict, body: dict, timeout: int) -> StreamingResponse:
    client = httpx.AsyncClient(timeout=timeout)

    async def generator():
        async with client.stream("POST", url, headers=headers, json=body) as resp:
            if resp.status_code != 200:
                err = await resp.aread()
                logger.error("LLM 上游流式错误: %d %s", resp.status_code, err[:200])
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


async def _handle_normal(url: str, headers: dict, body: dict, timeout: int) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, headers=headers, json=body)

    if resp.status_code != 200:
        logger.error("LLM 上游错误: %d", resp.status_code)
        from fastapi import HTTPException, status
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY,
                            detail=f"LLM 上游返回 {resp.status_code}")
    return resp.json()
