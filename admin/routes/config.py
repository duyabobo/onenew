import logging

from fastapi import APIRouter, HTTPException, status

from models.config import LlmConfig, McpConfig, McpServerConfig
from services import mongo_client
from services.llm_config_store import get_effective_config, update_in_memory

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/config", tags=["config"])


# ── LLM 配置 ──────────────────────────────────────────────────────────────────

@router.get("/llm", response_model=LlmConfig)
async def get_llm_config() -> LlmConfig:
    """读取当前生效的 LLM 配置（内存读，无 DB IO）"""
    return get_effective_config()


@router.put("/llm", response_model=LlmConfig)
async def update_llm_config(body: LlmConfig) -> LlmConfig:
    """
    更新 LLM 配置。
    同时写入 MongoDB（持久化）并更新内存（立即生效，无需重启）。
    """
    await mongo_client.save_llm_config(body)
    update_in_memory(body)
    return body


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
