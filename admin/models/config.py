from pydantic import BaseModel


class LlmConfig(BaseModel):
    base_url: str
    api_key: str
    model: str
    timeout: int = 120


class McpServerConfig(BaseModel):
    command: str | None = None
    args: list[str] = []
    env: dict[str, str] = {}
    url: str | None = None
    description: str = ""
    enabled: bool = True


class McpConfig(BaseModel):
    servers: dict[str, McpServerConfig] = {}
