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


class SkillMeta(BaseModel):
    """
    MongoDB 中只存储 Skill 的元数据（供前端下拉查询，不含正文内容）。
    Skill 正文（SKILL.md）存储在文件系统 /data/sandboxes/global/skills/{name}/SKILL.md。
    pi 直接读取文件系统，实现原生渐进式披露。
    """
    name: str
    description: str
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


class SkillCreateRequest(BaseModel):
    """创建/更新 Skill 时的请求体（含 content，用于写入文件系统）"""
    description: str
    content: str                  # 完整 SKILL.md 正文（frontmatter 由 admin 自动生成）
    tags: list[str] = []
    hidden: bool = False
