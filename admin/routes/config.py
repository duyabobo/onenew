import logging

from fastapi import APIRouter, HTTPException, status

from models.config import McpConfig, McpServerConfig
from services import mongo_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/config", tags=["config"])


# ── MCP 配置 ──────────────────────────────────────────────────────────────────

@router.get("/mcp", response_model=McpConfig)
async def get_mcp_config() -> McpConfig:
    """读取 MCP server 配置"""
    return await mongo_client.get_mcp_config()


@router.put("/mcp", response_model=McpConfig)
async def update_mcp_config(body: McpConfig) -> McpConfig:
    """全量替换 MCP 配置（新 session 启动时 pi-runtime 从 MongoDB 读取，立即生效）"""
    await mongo_client.save_mcp_config(body)
    return body


@router.post("/mcp/servers/{name}", response_model=McpConfig)
async def add_or_update_mcp_server(name: str, body: McpServerConfig) -> McpConfig:
    """添加或更新单个 MCP server"""
    cfg = await mongo_client.get_mcp_config()
    cfg.servers[name] = body
    await mongo_client.save_mcp_config(cfg)
    logger.info("MCP server 已添加/更新: %s", name)
    return cfg


@router.delete("/mcp/servers/{name}", response_model=McpConfig)
async def delete_mcp_server(name: str) -> McpConfig:
    """删除单个 MCP server"""
    cfg = await mongo_client.get_mcp_config()
    if name not in cfg.servers:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"MCP server '{name}' 不存在")
    del cfg.servers[name]
    await mongo_client.save_mcp_config(cfg)
    logger.info("MCP server 已删除: %s", name)
    return cfg
