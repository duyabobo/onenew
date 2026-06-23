"""
MCP 聚合器：连接多个后端 MCP Server，汇总工具列表，路由工具调用。

连接生命周期管理：
  - 使用 AsyncExitStack 持有所有后端的 streamable_http_client 和 ClientSession
  - refresh() 时先 aclose() 旧 ExitStack（关闭所有连接），再重新建立
  - 这样 callTool() 可以直接复用已持久化的 session，无需每次重连

刷新策略：
  - refresh_if_stale() 按 TTL 懒刷新，避免每次请求都重连
"""
import logging
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import Tool

from services.mongo_client import McpServerEntry

logger = logging.getLogger(__name__)


@dataclass
class _ToolEntry:
    tool: Tool
    server_name: str
    session: ClientSession


class McpAggregator:
    def __init__(self, refresh_interval_s: float) -> None:
        self._refresh_interval_s = refresh_interval_s
        self._tool_map: dict[str, _ToolEntry] = {}
        self._exit_stack: AsyncExitStack = AsyncExitStack()
        self._last_refresh_at: float = 0.0

    async def refresh_if_stale(self, servers: list[McpServerEntry]) -> None:
        if time.monotonic() - self._last_refresh_at < self._refresh_interval_s:
            return
        await self.refresh(servers)

    async def refresh(self, servers: list[McpServerEntry]) -> None:
        await self._exit_stack.aclose()
        self._exit_stack = AsyncExitStack()
        self._tool_map.clear()

        for server in servers:
            await self._connect_and_load_tools(server)

        self._last_refresh_at = time.monotonic()
        logger.info("刷新完成，共 %d 个工具", len(self._tool_map))

    def list_tools(self) -> list[dict[str, Any]]:
        return [
            entry.tool.model_dump(by_alias=True, exclude_none=True)
            for entry in self._tool_map.values()
        ]

    async def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        entry = self._tool_map.get(name)
        if entry is None:
            raise ValueError(f"工具未找到: {name}")
        logger.info("调用工具: %s → server=%s", name, entry.server_name)
        result = await entry.session.call_tool(name, arguments=args)
        return result.model_dump(by_alias=True, exclude_none=True)

    async def close(self) -> None:
        await self._exit_stack.aclose()

    async def _connect_and_load_tools(self, server: McpServerEntry) -> None:
        try:
            # 通过 ExitStack 持有连接，直到下次 refresh 或服务关闭才释放
            read, write, _ = await self._exit_stack.enter_async_context(
                streamable_http_client(server.url)
            )
            session: ClientSession = await self._exit_stack.enter_async_context(
                ClientSession(read, write)
            )
            await session.initialize()

            tools_result = await session.list_tools()
            loaded = 0
            for tool in tools_result.tools:
                if tool.name in self._tool_map:
                    logger.warning(
                        "工具名冲突: '%s' 已存在于 %s，跳过 %s",
                        tool.name, self._tool_map[tool.name].server_name, server.name,
                    )
                    continue
                self._tool_map[tool.name] = _ToolEntry(
                    tool=tool, server_name=server.name, session=session
                )
                loaded += 1

            logger.info("server=%s: 加载 %d 个工具", server.name, loaded)
        except Exception as e:
            # 单个 server 连接失败不影响其他 server，降级处理
            logger.error("连接 MCP server 失败: name=%s url=%s err=%s", server.name, server.url, e)
