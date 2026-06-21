import logging

from fastapi import APIRouter, HTTPException, status

from models.config import SkillCreateRequest, SkillMeta
from services import mongo_client
from services.skills_fs import delete_skill_files, read_skill_content, write_skill

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/config/skills", tags=["skills"])


@router.get("", response_model=list[SkillMeta])
async def list_skills() -> list[SkillMeta]:
    """列出所有 global skill 元数据（不含正文，供前端下拉展示）"""
    return await mongo_client.list_skill_metas()


@router.get("/{name}/content")
async def get_skill_content(name: str) -> dict:
    """读取 skill 的 SKILL.md 原始内容（从文件系统读取）"""
    content = read_skill_content(name)
    if content is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"skill '{name}' 文件不存在")
    return {"name": name, "raw": content}


@router.post("/{name}", response_model=SkillMeta, status_code=status.HTTP_200_OK)
async def save_skill(name: str, body: SkillCreateRequest) -> SkillMeta:
    """
    创建或更新 global skill。
    - 文件系统：写 /data/sandboxes/global/skills/{name}/SKILL.md（pi 原生格式）
    - MongoDB：写元数据（name/description/tags，供前端展示）
    """
    write_skill(name, body.description, body.content)

    meta = SkillMeta(
        name=name,
        description=body.description,
        tags=body.tags,
        hidden=body.hidden,
    )
    return await mongo_client.save_skill_meta(meta)


@router.delete("/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skill(name: str) -> None:
    """删除 global skill（同时删除文件系统和 MongoDB 元数据）"""
    fs_deleted = delete_skill_files(name)
    db_deleted = await mongo_client.delete_skill_meta(name)
    if not fs_deleted and not db_deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"skill '{name}' 不存在")
