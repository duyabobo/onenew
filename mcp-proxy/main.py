"""
mcp-proxy 入口：FastAPI 服务，实现 MCP Streamable HTTP 协议（服务端侧）。

协议规范：MCP 2025-03-26 Streamable HTTP transport
  - POST /mcp   接收 JSON-RPC 请求，返回 application/json 响应
  - GET  /health 健康检查

支持的 MCP 方法：
  - initialize        → 返回服务能力声明
  - notifications/*   → 确认（202，无响应体）
  - tools/list        → 返回聚合后的工具列表
  - tools/call        → 路由到对应后端 MCP Server 执行
"""
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from config import settings
from logger import setup_logging
from services import mcp_aggregator as aggregator_module
from services import mongo_client

setup_logging("mcp-proxy")
logger = logging.getLogger(__name__)

_aggregator = aggregator_module.McpAggregator(settings.tool_refresh_interval_s)

_PROTOCOL_VERSION = "2025-03-26"
_SERVER_INFO = {"name": "mcp-proxy", "version": "1.0.0"}

JsonRpcId = str | int | None


# ── JSON-RPC 工具函数 ──────────────────────────────────────────────────────────

def _jsonrpc_result(request_id: JsonRpcId, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _jsonrpc_error(request_id: JsonRpcId, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


# ── MCP 请求分发 ──────────────────────────────────────────────────────────────

async def _dispatch(body: dict) -> dict | None:
    """根据 JSON-RPC method 分发处理，返回 None 表示 202 无响应体（通知类消息）。"""
    request_id: JsonRpcId = body.get("id")
    method: str = body.get("method", "")
    params: dict = body.get("params") or {}

    # 每次请求都检查是否需要刷新工具列表（受 TTL 控制，不会每次真正重连）
    servers = await mongo_client.read_enabled_mcp_servers()
    await _aggregator.refresh_if_stale(servers)

    if method == "initialize":
        return _jsonrpc_result(request_id, {
            "protocolVersion": _PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": _SERVER_INFO,
        })

    if method == "tools/list":
        return _jsonrpc_result(request_id, {"tools": _aggregator.list_tools()})

    if method == "tools/call":
        tool_name: str = params.get("name", "")
        tool_args: dict = params.get("arguments") or {}
        try:
            result = await _aggregator.call_tool(tool_name, tool_args)
            return _jsonrpc_result(request_id, result)
        except ValueError as e:
            logger.error("tools/call 失败: tool=%s %s", tool_name, e)
            return _jsonrpc_error(request_id, -32603, str(e))

    if method.startswith("notifications/"):
        return None

    return _jsonrpc_error(request_id, -32601, f"Method not found: {method}")


# ── FastAPI 应用 ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("mcp-proxy 启动中...")
    await mongo_client.connect()

    servers = await mongo_client.read_enabled_mcp_servers()
    await _aggregator.refresh(servers)

    logger.info("mcp-proxy 启动完成，监听端口 %d", settings.mcp_proxy_port)
    yield

    logger.info("mcp-proxy 关闭中...")
    await _aggregator.close()
    await mongo_client.disconnect()


app = FastAPI(title="MCP Proxy", version="1.0.0", lifespan=lifespan)


@app.get("/health", tags=["health"])
async def health() -> dict:
    return {"status": "ok"}


@app.post("/mcp", tags=["mcp"])
async def handle_mcp(request: Request) -> Response:
    try:
        body = await request.json()
    except Exception:
        error = _jsonrpc_error(None, -32700, "Parse error")
        return JSONResponse(error, status_code=400)

    response = await _dispatch(body)

    if response is None:
        return Response(status_code=202)

    return JSONResponse(response)
