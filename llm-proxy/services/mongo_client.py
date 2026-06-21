import logging

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from config import settings
from models.config import LlmConfig

logger = logging.getLogger(__name__)

_client: AsyncIOMotorClient | None = None

_CONFIG_COLLECTION = "configs"
_LLM_DOC_ID = "llm"


def get_db() -> AsyncIOMotorDatabase:
    if _client is None:
        raise RuntimeError("MongoDB 客户端未初始化")
    return _client[settings.mongo_db]


async def connect() -> None:
    global _client
    _client = AsyncIOMotorClient(settings.mongo_uri)
    logger.info("llm-proxy MongoDB 已连接: %s", settings.mongo_uri)


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
