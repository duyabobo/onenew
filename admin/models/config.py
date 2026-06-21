from datetime import datetime
from pydantic import BaseModel, model_validator


class McpServerConfig(BaseModel):
    """
    MCP Server 配置。

    只允许 HTTP/SSE 远程类型（url 字段）。
    stdio 本地进程类型（command + args）被明确禁止：本地进程在 pi-runtime 容器内以 root 运行，
    可访问 Docker 内网（MongoDB/Redis 等），是不可接受的攻击面。
    """
    url: str
    description: str = ""
    enabled: bool = True

    @model_validator(mode="before")
    @classmethod
    def reject_command_based(cls, values: dict) -> dict:
        if values.get("command"):
            raise ValueError(
                "不允许配置 command 类型的 MCP Server（会在容器内启动本地进程）。"
                "请改用 url 类型（HTTP/SSE 远程 MCP Server）。"
            )
        if not values.get("url"):
            raise ValueError("MCP Server 必须提供 url 字段（HTTP/SSE 远程端点）。")
        return values


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
