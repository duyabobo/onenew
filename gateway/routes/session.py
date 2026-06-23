import logging
import uuid

from fastapi import APIRouter, HTTPException, Query, status

from models.session import (
    CreateSessionRequest, CreateSessionResponse, SendMessageRequest,
    SendMessageResponse, SessionDocument, SessionStatus, SessionSummary,
)
from services import mongo_client, redis_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["session"])


@router.post("", response_model=CreateSessionResponse, status_code=status.HTTP_200_OK)
async def create_session(body: CreateSessionRequest) -> CreateSessionResponse:
    """
    创建新 session（打开新 chat 窗口 + 发送第一条消息）。
    session_id 由后端生成，前端需提供 turn_id（供 SSE stream 订阅）。
    """
    existing = await mongo_client.find_active_session_by_request(body.user_id, body.request)
    if existing:
        logger.info("复用进行中的 session: %s user=%s", existing.id, body.user_id)
        return CreateSessionResponse(session_id=existing.id, status=existing.status)

    session_id = str(uuid.uuid4())
    logger.info("新建 session: session_id=%s user=%s turn_id=%s skill_ids=%s request='%s'",
                session_id, body.user_id, body.turn_id, body.skill_ids,
                body.request[:80].replace("\n", " "))

    await mongo_client.create_session(session_id, body.user_id, body.request, body.skill_ids)
    await redis_client.publish_task(
        session_id, body.user_id, body.request, body.turn_id, body.skill_ids,
    )

    return CreateSessionResponse(session_id=session_id, status=SessionStatus.PENDING)


@router.post("/{session_id}/messages", response_model=SendMessageResponse, status_code=status.HTTP_200_OK)
async def send_message(session_id: str, body: SendMessageRequest) -> SendMessageResponse:
    """
    向已有 session 发送新消息（新轮次）。
    前端提供 turn_id，发送后订阅 /sessions/{session_id}/turns/{turn_id}/stream 获取响应。
    """
    session = await mongo_client.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="session 不存在")
    if session.status in (SessionStatus.COMPLETED, SessionStatus.FAILED):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="session 已关闭，请开启新的 session")

    logger.info("新消息: session_id=%s turn_id=%s request='%s'",
                session_id, body.turn_id, body.request[:80].replace("\n", " "))

    await redis_client.publish_message(
        session_id, session.user_id, body.request, body.turn_id, body.skill_ids,
    )

    return SendMessageResponse(turn_id=body.turn_id, session_id=session_id)


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def close_session(session_id: str) -> None:
    """关闭 session（用户关闭 chat 窗口），通知 pi-runtime 销毁 pi 进程和沙盒。"""
    session = await mongo_client.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="session 不存在")

    await redis_client.get_redis().publish(f"sessions:{session_id}:close", "1")
    logger.info("session 关闭信号已发送: session_id=%s", session_id)


@router.get("", response_model=list[SessionSummary])
async def list_sessions(
    user_id: str = Query(..., description="用户 ID"),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[SessionSummary]:
    """查询用户近期 session 列表"""
    return await mongo_client.get_recent_sessions(user_id, limit)


@router.get("/{session_id}", response_model=SessionDocument)
async def get_session(session_id: str) -> SessionDocument:
    """查询 session 详情"""
    session = await mongo_client.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="session 不存在")
    return session
