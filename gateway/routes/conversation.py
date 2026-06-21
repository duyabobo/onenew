import logging

from fastapi import APIRouter, HTTPException, Query, status

from models.session import ConversationSession, ConversationSummary
from services import mongo_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/conversations", tags=["conversation"])


@router.get("", response_model=list[ConversationSummary])
async def list_conversations(
    user_id: str = Query(..., description="用户 ID"),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[ConversationSummary]:
    """
    获取用户最近的对话列表（按对话维度聚合）。
    一条对话只返回一个条目，包含首条消息、最新状态、轮数等信息。
    """
    logger.info("查询对话列表: user=%s limit=%d", user_id, limit)
    docs = await mongo_client.get_recent_conversations(user_id, limit)
    return [ConversationSummary(**doc) for doc in docs]


@router.get("/{conversation_id}", response_model=list[ConversationSession])
async def get_conversation_messages(conversation_id: str) -> list[ConversationSession]:
    """
    获取某对话内所有 session（含 events_snapshot），按创建时间升序排列。
    前端用此接口一次性重建完整消息列表，无需 N+1 请求。
    """
    docs = await mongo_client.get_conversation_sessions_with_events(conversation_id)
    if not docs:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="对话不存在或无消息")
    logger.info("查询对话消息: conversation_id=%s sessions=%d", conversation_id, len(docs))
    return [ConversationSession(**doc) for doc in docs]
