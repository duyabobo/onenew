"""
LLM 配置运行时存储。

优先级（高 → 低）：
  1. 通过 PUT /config/llm 写入 MongoDB 的配置（动态更新，立即生效，无需重启）
  2. 启动时从 MongoDB 读取的持久配置
  3. 环境变量默认值（.env）

设计：
  启动时从 MongoDB 加载一次到内存（_current）。
  PUT /config/llm 同时写 MongoDB 和更新 _current，下一个请求立即使用新配置。
  proxy.py 通过 get_effective_config() 获取，避免每次请求都查 DB。
"""
import logging

from config import settings
from models.config import LlmConfig

logger = logging.getLogger(__name__)

# 内存中的生效配置（启动时从 DB 加载，PUT 时同步更新）
_current: LlmConfig | None = None


def _env_defaults() -> LlmConfig:
    return LlmConfig(
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        model=settings.llm_model,
        timeout=settings.llm_timeout,
    )


async def load_from_db() -> None:
    """启动时调用，从 MongoDB 加载配置到内存"""
    from services import mongo_client

    global _current
    db_cfg = await mongo_client.get_llm_config()
    if db_cfg:
        _current = db_cfg
        logger.info("LLM 配置已从 DB 加载: model=%s", db_cfg.model)
    else:
        _current = _env_defaults()
        logger.info("DB 无 LLM 配置，使用环境变量默认值: model=%s", _current.model)


def get_effective_config() -> LlmConfig:
    """获取当前生效的 LLM 配置（内存读，零 IO）"""
    return _current or _env_defaults()


def update_in_memory(cfg: LlmConfig) -> None:
    """PUT /config/llm 成功写 DB 后，同步更新内存配置，立即生效"""
    global _current
    _current = cfg
    logger.info("LLM 配置已热更新（内存）: model=%s base_url=%s", cfg.model, cfg.base_url)
