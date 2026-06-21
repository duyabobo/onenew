from datetime import datetime
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


class SkillDoc(BaseModel):
    """
    单个 Skill 文档。

    content 遵循 SKILL.md 标准：
      ---
      name: python-expert
      description: 当用户需要写 Python 代码时使用
      ---
      （skill 正文指令，注入 pi 的 system prompt）

    description 字段同时用于前端展示和（如果启用 pi 自动发现时的）pi 激活判断。
    """
    name: str
    description: str
    content: str
    tags: list[str] = []
    hidden: bool = False
    created_at: datetime = None  # type: ignore[assignment]
    updated_at: datetime = None  # type: ignore[assignment]

    def model_post_init(self, __context: object) -> None:
        now = datetime.utcnow()
        if self.created_at is None:
            self.created_at = now
        if self.updated_at is None:
            self.updated_at = now
