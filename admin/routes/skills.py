import logging

from fastapi import APIRouter, HTTPException, status

from models.config import SkillDoc
from services import mongo_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/config/skills", tags=["skills"])


@router.get("", response_model=list[SkillDoc])
async def list_skills() -> list[SkillDoc]:
    """列出所有 skill（不含 content 正文，供前端下拉展示）"""
    return await mongo_client.list_skills()


@router.get("/{name}", response_model=SkillDoc)
async def get_skill(name: str) -> SkillDoc:
    """获取单个 skill（含 content）"""
    doc = await mongo_client.get_skill(name)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"skill '{name}' 不存在")
    return doc


@router.post("/{name}", response_model=SkillDoc, status_code=status.HTTP_200_OK)
async def save_skill(name: str, body: SkillDoc) -> SkillDoc:
    """创建或更新 skill"""
    body.name = name
    return await mongo_client.save_skill(body)


@router.delete("/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skill(name: str) -> None:
    """删除 skill"""
    deleted = await mongo_client.delete_skill(name)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"skill '{name}' 不存在")
