"""
MongoDB 客户端：只读取 configs 集合中的 mcp 配置，不写入任何数据。
"""
import logging
from dataclasses import dataclass

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from config import settings

logger = logging.getLogger(__name__)

_client: AsyncIOMotorClient | None = None


def _get_db() -> AsyncIOMotorDatabase:
    if _client is None:
        raise RuntimeError("MongoDB 未连接，请先调用 connect()")
    return _client[settings.mongo_db]


async def connect() -> None:
    global _client
    _client = AsyncIOMotorClient(settings.mongo_uri)
    logger.info("MongoDB 连接成功: %s / %s", settings.mongo_uri, settings.mongo_db)


async def disconnect() -> None:
    global _client
    if _client:
        _client.close()
        _client = None
        logger.info("MongoDB 连接已关闭")


@dataclass
class McpServerEntry:
    name: str
    url: str


async def read_enabled_mcp_servers() -> list[McpServerEntry]:
    """读取所有启用的 URL 类型 MCP Server 配置。command 类型本地进程不允许，直接过滤。"""
    raw = await _get_db().configs.find_one({"_id": "mcp"})
    if not raw or "servers" not in raw:
        return []

    servers: dict = raw["servers"]
    result: list[McpServerEntry] = []

    for name, cfg in servers.items():
        if not isinstance(cfg, dict):
            continue
        if not cfg.get("url"):
            logger.warning("MCP server '%s' 缺少 url 字段，已跳过", name)
            continue
        if cfg.get("enabled") is False:
            continue
        result.append(McpServerEntry(name=name, url=cfg["url"]))

    return result
