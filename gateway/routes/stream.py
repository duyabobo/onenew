import json
import logging

from fastapi import APIRouter, HTTPException, Query, Request, status
from sse_starlette.sse import EventSourceResponse

from models.session import SessionStatus
from services import mongo_client, redis_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["stream"])

# SSE 心跳事件名称
_HEARTBEAT_EVENT = "heartbeat"
# SSE 历史快照事件名称
_SNAPSHOT_EVENT = "snapshot"


@router.get("/{session_id}/stream")
async def pull_session_stream_resp(
    request: Request,
    session_id: str,
    last_seq: str = Query(default="0", description="断线重连时传入上次收到的 Redis Stream ID"),
) -> EventSourceResponse:
    """
    SSE 接口：先回放 MongoDB 中的历史快照，再持续从 Redis Stream 拉取增量输出。
    支持断线重连：通过 last_seq 参数跳过已接收消息。
    """
    session = await mongo_client.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="session 不存在")

    async def event_generator():
        # 先发送历史快照（仅首次连接或 last_seq=0 时有意义）
        if last_seq == "0" and session.events_snapshot:
            yield {
                "event": _SNAPSHOT_EVENT,
                "data": json.dumps({"events": session.events_snapshot}),
            }
            logger.info("session %s: 历史快照已发送 (%d 条)", session_id, len(session.events_snapshot))

        # 如果 session 已终态，直接结束 SSE
        if session.status in (SessionStatus.COMPLETED, SessionStatus.FAILED):
            yield {"event": "done", "data": json.dumps({"status": session.status})}
            return

        # 持续从 Redis Stream 拉取增量
        async for item in redis_client.stream_session_output(session_id, start_seq=last_seq):
            # 客户端断开时停止
            if await request.is_disconnected():
                logger.info("session %s: 客户端断开连接", session_id)
                return

            if item.get("heartbeat"):
                yield {"event": _HEARTBEAT_EVENT, "data": ""}
                continue

            event_type = item.get("event_type", "token")
            yield {
                "event": event_type,
                "id": item.get("id"),
                "data": item.get("content", ""),
            }

            if event_type == "done":
                return

    return EventSourceResponse(event_generator())
