"""
Skill 文件系统管理。

存储结构：
  /data/sandboxes/global/skills/{name}/
    SKILL.md      ← pi 直接读取（frontmatter + 正文）

全局 skill（admin 管理的公共 skill）放在 global/skills/。
用户专属 skill 放在 users/{user_id}/skills/，由用户自己通过 pi 管理，
admin 不直接写用户专属 skill 目录（用户自主管理）。

SKILL.md 格式（Agent Skills 标准）：
  ---
  name: python-expert
  description: 当用户需要写 Python 代码时使用
  ---
  skill 正文指令...
"""
import logging
import os
from pathlib import Path

from config import settings

logger = logging.getLogger(__name__)

_GLOBAL_SKILLS_ROOT = Path(settings.sandbox_root) / "global" / "skills"


def _skill_dir(name: str) -> Path:
    return _GLOBAL_SKILLS_ROOT / name


def _skill_file(name: str) -> Path:
    return _skill_dir(name) / "SKILL.md"


def _build_skill_md(name: str, description: str, content: str) -> str:
    """按 Agent Skills 标准拼装 SKILL.md 内容"""
    frontmatter = f"---\nname: {name}\ndescription: {description}\n---\n\n"
    return frontmatter + content


def write_skill(name: str, description: str, content: str) -> None:
    """将 skill 写入文件系统（global/skills/{name}/SKILL.md）"""
    skill_dir = _skill_dir(name)
    skill_dir.mkdir(parents=True, exist_ok=True)
    skill_file = _skill_file(name)
    skill_file.write_text(_build_skill_md(name, description, content), encoding="utf-8")
    logger.info("skill 文件已写入: %s", skill_file)


def read_skill_content(name: str) -> str | None:
    """读取 global skill 的 SKILL.md 原始内容（含 frontmatter）"""
    skill_file = _skill_file(name)
    if not skill_file.exists():
        return None
    return skill_file.read_text(encoding="utf-8")


def delete_skill_files(name: str) -> bool:
    """删除 global skill 文件目录"""
    import shutil
    skill_dir = _skill_dir(name)
    if not skill_dir.exists():
        return False
    shutil.rmtree(skill_dir)
    logger.info("skill 文件目录已删除: %s", skill_dir)
    return True


def get_global_skills_root() -> str:
    """返回全局 skill 根目录绝对路径（供 pi-runtime 使用）"""
    _GLOBAL_SKILLS_ROOT.mkdir(parents=True, exist_ok=True)
    return str(_GLOBAL_SKILLS_ROOT)
