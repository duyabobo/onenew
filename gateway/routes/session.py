import logging
import uuid

from fastapi import APIRouter, HTTPException, Query, status

from models.session import CreateSessionRequest, CreateSessionResponse, SessionDocument, SessionStatus, SessionSummary
from services import mongo_client, redis_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["session"])


@router.post("", response_model=CreateSessionResponse, status_code=status.HTTP_200_OK)
async def get_or_create_session(body: CreateSessionRequest) -> CreateSessionResponse:
    """
    创建 session。
    支持同一用户并发多个 session，每个 session 拥有独立的文件系统（session 级隔离）。
    相同 request 的幂等性：若该 user 已有相同 request 的进行中 session，直接返回它。
    """
    existing = await mongo_client.find_active_session_by_request(body.user_id, body.request)
    if existing:
        logger.info("复用进行中的 session: %s user=%s", existing.id, body.user_id)
        return CreateSessionResponse(session_id=existing.id, status=existing.status)

    session_id = str(uuid.uuid4())
    request_preview = body.request[:80].replace("\n", " ")
    logger.info("新建 session: session_id=%s user=%s skill_ids=%s request='%s'",
                session_id, body.user_id, body.skill_ids, request_preview)

    await mongo_client.create_session(session_id, body.user_id, body.request, body.skill_ids)
    logger.info("session 已写入 MongoDB: session_id=%s", session_id)

    await redis_client.publish_task(session_id, body.user_id, body.request, body.skill_ids)
    logger.info("session 任务已发布到 Redis: session_id=%s", session_id)

    return CreateSessionResponse(session_id=session_id, status=SessionStatus.PENDING)


@router.get("", response_model=list[SessionSummary])
async def list_sessions(
    user_id: str = Query(..., description="用户 ID"),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[SessionSummary]:
    """查询用户近期 session 列表（按创建时间降序），用于历史消息恢复"""
    return await mongo_client.get_recent_sessions(user_id, limit)


@router.get("/{session_id}", response_model=SessionDocument)
async def get_session(session_id: str) -> SessionDocument:
    """查询 session 详情（含 events_snapshot，用于历史消息回放）"""
    session = await mongo_client.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="session 不存在")
    return session
