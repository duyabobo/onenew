from typing import Literal

from pydantic import BaseModel


class LlmConfig(BaseModel):
    base_url: str
    api_key: str
    model: str
    timeout: int = 120
    # openai: OpenAI-compatible Chat Completions（适用于 OpenAI / DashScope / DeepSeek 等）
    # anthropic: Anthropic Messages API（需 llm-proxy 做格式转换）
    protocol: Literal["openai", "anthropic"] = "openai"
