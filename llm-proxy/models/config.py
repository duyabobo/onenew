from pydantic import BaseModel


class LlmConfig(BaseModel):
    base_url: str
    api_key: str
    model: str
    timeout: int = 120
