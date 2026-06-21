import logging

from fastapi import APIRouter

from models.config import LlmConfig
from services import mongo_client
from services.llm_config_store import get_effective_config, update_in_memory

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/config", tags=["config"])


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
