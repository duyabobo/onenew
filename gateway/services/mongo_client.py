import logging
from datetime import datetime
from typing import Any

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from config import settings
from models.session import SessionDocument, SessionStatus

logger = logging.getLogger(__name__)

_client: AsyncIOMotorClient | None = None


def get_db() -> AsyncIOMotorDatabase:
    if _client is None:
        raise RuntimeError("MongoDB 客户端未初始化，请先调用 connect()")
    return _client[settings.mongo_db]


async def connect() -> None:
    global _client
    _client = AsyncIOMotorClient(settings.mongo_uri)
    logger.info("MongoDB 连接成功: %s / %s", settings.mongo_uri, settings.mongo_db)


async def disconnect() -> None:
    global _client
    if _client:
        _client.close()
        _client = None
        logger.info("MongoDB 连接已关闭")


async def create_session(session_id: str, user_id: str, request: str) -> SessionDocument:
    doc = SessionDocument(
        _id=session_id,
        user_id=user_id,
        request=request,
    )
    db = get_db()
    await db.sessions.insert_one(doc.model_dump(by_alias=True))
    logger.info("session 创建成功: %s user=%s", session_id, user_id)
    return doc


async def get_session(session_id: str) -> SessionDocument | None:
    db = get_db()
    raw = await db.sessions.find_one({"_id": session_id})
    if raw is None:
        return None
    return SessionDocument(**raw)


async def find_active_session(user_id: str, request: str) -> SessionDocument | None:
    """幂等查找：相同 user_id + request 且非终态的 session"""
    db = get_db()
    raw = await db.sessions.find_one(
        {
            "user_id": user_id,
            "request": request,
            "status": {"$in": [SessionStatus.PENDING, SessionStatus.RUNNING]},
        }
    )
    if raw is None:
        return None
    return SessionDocument(**raw)


async def append_event_snapshot(session_id: str, event: dict[str, Any]) -> None:
    """将 pi-runtime 推送的事件追加到 MongoDB 快照，供断线重连回放"""
    db = get_db()
    await db.sessions.update_one(
        {"_id": session_id},
        {"$push": {"events_snapshot": event}},
    )


async def update_session_status(
    session_id: str,
    status: SessionStatus,
    extra_fields: dict[str, Any] | None = None,
) -> None:
    update: dict[str, Any] = {"status": status}
    if status == SessionStatus.RUNNING:
        update["started_at"] = datetime.utcnow()
    elif status in (SessionStatus.COMPLETED, SessionStatus.FAILED):
        update["completed_at"] = datetime.utcnow()
    if extra_fields:
        update.update(extra_fields)

    db = get_db()
    await db.sessions.update_one({"_id": session_id}, {"$set": update})
    logger.info("session 状态更新: %s -> %s", session_id, status)
