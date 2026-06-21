import logging

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from config import settings
from datetime import datetime
from models.config import LlmConfig, McpConfig, SkillMeta

logger = logging.getLogger(__name__)

_client: AsyncIOMotorClient | None = None

_CONFIG_COLLECTION = "configs"
_LLM_DOC_ID = "llm"
_MCP_DOC_ID = "mcp"


def get_db() -> AsyncIOMotorDatabase:
    if _client is None:
        raise RuntimeError("MongoDB 客户端未初始化")
    return _client[settings.mongo_db]


async def connect() -> None:
    global _client
    _client = AsyncIOMotorClient(settings.mongo_uri)
    logger.info("admin MongoDB 已连接: %s", settings.mongo_uri)


async def disconnect() -> None:
    global _client
    if _client:
        _client.close()
        _client = None


async def get_llm_config() -> LlmConfig | None:
    raw = await get_db()[_CONFIG_COLLECTION].find_one({"_id": _LLM_DOC_ID})
    if not raw:
        return None
    raw.pop("_id", None)
    return LlmConfig(**raw)


async def save_llm_config(cfg: LlmConfig) -> None:
    await get_db()[_CONFIG_COLLECTION].update_one(
        {"_id": _LLM_DOC_ID},
        {"$set": cfg.model_dump()},
        upsert=True,
    )
    logger.info("LLM 配置已保存: model=%s base_url=%s", cfg.model, cfg.base_url)


async def get_mcp_config() -> McpConfig:
    raw = await get_db()[_CONFIG_COLLECTION].find_one({"_id": _MCP_DOC_ID})
    if not raw:
        return McpConfig()
    raw.pop("_id", None)
    return McpConfig(**raw)


async def save_mcp_config(cfg: McpConfig) -> None:
    await get_db()[_CONFIG_COLLECTION].update_one(
        {"_id": _MCP_DOC_ID},
        {"$set": cfg.model_dump()},
        upsert=True,
    )
    logger.info("MCP 配置已保存，共 %d 个 server", len(cfg.servers))


# ── Skill 管理 ────────────────────────────────────────────────────────────────

_SKILL_COLLECTION = "skills"


async def list_skill_metas() -> list[SkillMeta]:
    """列出所有 skill 元数据（不含正文，内容在文件系统）"""
    cursor = get_db()[_SKILL_COLLECTION].find({})
    docs = []
    async for raw in cursor:
        raw.pop("_id", None)
        docs.append(SkillMeta(**raw))
    return docs


async def save_skill_meta(meta: SkillMeta) -> SkillMeta:
    """保存/更新 skill 元数据到 MongoDB"""
    meta.updated_at = datetime.utcnow()
    await get_db()[_SKILL_COLLECTION].update_one(
        {"name": meta.name},
        {"$set": meta.model_dump(), "$setOnInsert": {"created_at": meta.created_at}},
        upsert=True,
    )
    logger.info("skill 元数据已保存: %s", meta.name)
    return meta


async def delete_skill_meta(name: str) -> bool:
    result = await get_db()[_SKILL_COLLECTION].delete_one({"name": name})
    if result.deleted_count:
        logger.info("skill 元数据已删除: %s", name)
        return True
    return False
