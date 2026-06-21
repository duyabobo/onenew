import logging

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from config import settings
from datetime import datetime
from models.config import LlmConfig, McpConfig, SkillDoc

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


async def list_skills() -> list[SkillDoc]:
    cursor = get_db()[_SKILL_COLLECTION].find({}, {"content": 0})
    docs = []
    async for raw in cursor:
        raw.pop("_id", None)
        docs.append(SkillDoc(**raw))
    return docs


async def get_skill(name: str) -> SkillDoc | None:
    raw = await get_db()[_SKILL_COLLECTION].find_one({"name": name})
    if not raw:
        return None
    raw.pop("_id", None)
    return SkillDoc(**raw)


async def get_skills_by_names(names: list[str]) -> list[SkillDoc]:
    """批量获取指定 skill（含 content），供 pi-runtime 注入 system prompt 使用"""
    cursor = get_db()[_SKILL_COLLECTION].find({"name": {"$in": names}})
    docs = []
    async for raw in cursor:
        raw.pop("_id", None)
        docs.append(SkillDoc(**raw))
    return docs


async def save_skill(doc: SkillDoc) -> SkillDoc:
    doc.updated_at = datetime.utcnow()
    await get_db()[_SKILL_COLLECTION].update_one(
        {"name": doc.name},
        {"$set": doc.model_dump(), "$setOnInsert": {"created_at": doc.created_at}},
        upsert=True,
    )
    logger.info("skill 已保存: %s", doc.name)
    return doc


async def delete_skill(name: str) -> bool:
    result = await get_db()[_SKILL_COLLECTION].delete_one({"name": name})
    if result.deleted_count:
        logger.info("skill 已删除: %s", name)
        return True
    return False
