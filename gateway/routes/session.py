import logging
import uuid

from fastapi import APIRouter, HTTPException, status

from models.session import CreateSessionRequest, CreateSessionResponse, SessionDocument, SessionStatus
from services import mongo_client, redis_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["session"])


@router.post("", response_model=CreateSessionResponse, status_code=status.HTTP_200_OK)
async def get_or_create_session(body: CreateSessionRequest) -> CreateSessionResponse:
    """
    幂等创建 session：相同 user_id + request 且任务未终态时直接返回已有 session_id。
    否则创建新 session 并派发任务到 pi-runtime。
    """
    existing = await mongo_client.find_active_session(body.user_id, body.request)
    if existing:
        logger.info("复用已有 session: %s user=%s", existing.id, body.user_id)
        return CreateSessionResponse(session_id=existing.id, status=existing.status)

    session_id = str(uuid.uuid4())
    await mongo_client.create_session(session_id, body.user_id, body.request)
    await redis_client.publish_task(session_id, body.user_id, body.request)

    return CreateSessionResponse(session_id=session_id, status=SessionStatus.PENDING)


@router.get("/{session_id}", response_model=SessionDocument)
async def get_session(session_id: str) -> SessionDocument:
    """查询 session 详情"""
    session = await mongo_client.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="session 不存在")
    return session
