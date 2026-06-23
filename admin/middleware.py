import logging
import time

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_MAX_BODY_CHARS = 2000
_SKIP_PATHS = {"/health"}

logger = logging.getLogger("access")


def _truncate(text: str) -> str:
    if len(text) <= _MAX_BODY_CHARS:
        return text
    return f"{text[:_MAX_BODY_CHARS]}...[+{len(text) - _MAX_BODY_CHARS} chars]"


async def _read_and_replay_body(receive: Receive) -> tuple[bytes, Receive]:
    """读取完整请求体，并返回可重放的 receive，避免 app 层读取时 body 已被消费。"""
    chunks: list[bytes] = []
    more_body = True
    while more_body:
        message = await receive()
        if message["type"] != "http.request":
            break
        chunks.append(message.get("body", b""))
        more_body = message.get("more_body", False)

    body = b"".join(chunks)
    replayed = False

    async def replay_receive() -> Message:
        nonlocal replayed
        if not replayed:
            replayed = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await receive()

    return body, replay_receive


def _emit_log(
    method: str,
    path: str,
    req_body: str,
    resp_chunks: list[bytes] | None,
    status_code: int,
    start: float,
) -> None:
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    resp_body = "[stream]" if resp_chunks is None else _truncate(
        b"".join(resp_chunks).decode("utf-8", errors="replace")
    )
    logger.info(
        "method=%s path=%s status=%d timecost=%dms req=%s resp=%s",
        method, path, status_code, elapsed_ms, req_body, resp_body,
    )


class AccessLogMiddleware:
    """纯 ASGI 访问日志中间件，记录 method/path/req/resp/status/timecost。

    对 SSE 等流式响应不缓冲 body，仅记录 [stream] 占位，
    避免干扰 EventSourceResponse 的正常推送。
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method: str = scope.get("method", "")
        path: str = scope.get("path", "")

        if path in _SKIP_PATHS:
            await self.app(scope, receive, send)
            return

        body_bytes, receive = await _read_and_replay_body(receive)
        req_body = _truncate(body_bytes.decode("utf-8", errors="replace"))
        start = time.perf_counter()

        status_code = 500
        is_stream = False
        resp_chunks: list[bytes] = []

        async def send_wrapper(message: Message) -> None:
            nonlocal status_code, is_stream
            if message["type"] == "http.response.start":
                status_code = message["status"]
                headers = Headers(raw=message.get("headers", []))
                is_stream = "text/event-stream" in headers.get("content-type", "")
            elif message["type"] == "http.response.body" and not is_stream:
                chunk = message.get("body", b"")
                if chunk:
                    resp_chunks.append(chunk)
                if not message.get("more_body", False):
                    _emit_log(method, path, req_body, resp_chunks, status_code, start)
            await send(message)

        await self.app(scope, receive, send_wrapper)

        # 流式响应在 app 完成后（SSE 关闭/断开）统一记一条日志
        if is_stream:
            _emit_log(method, path, req_body, None, status_code, start)
