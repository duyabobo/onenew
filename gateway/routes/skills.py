import logging
from typing import Any

from fastapi import APIRouter

from services.mongo_client import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/skills", tags=["skills"])


@router.get("", response_model=list[dict[str, Any]])
async def list_skills() -> list[dict[str, Any]]:
    """
    列出所有可用 skill（不含 content 正文），供前端下拉展示。
    数据来源：与 admin 共享同一 MongoDB 的 skills 集合。
    """
    db = get_db()
    cursor = db.skills.find({}, {"content": 0, "_id": 0})
    return [doc async for doc in cursor]
