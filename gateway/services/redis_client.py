import json
import logging
from collections.abc import AsyncGenerator
from typing import Any

import redis.asyncio as aioredis

from config import settings

logger = logging.getLogger(__name__)

_pool: aioredis.ConnectionPool | None = None

# Redis Stream key 模板
STREAM_KEY = "session:{session_id}:stream"
# Pub/Sub channel，gateway 向 pi-runtime 派发任务
TASK_CHANNEL = "sessions:new"


def _get_stream_key(session_id: str) -> str:
    return STREAM_KEY.format(session_id=session_id)


def get_redis() -> aioredis.Redis:
    if _pool is None:
        raise RuntimeError("Redis 连接池未初始化，请先调用 connect()")
    return aioredis.Redis(connection_pool=_pool)


async def connect() -> None:
    global _pool
    _pool = aioredis.ConnectionPool.from_url(
        settings.redis_url,
        max_connections=50,
        decode_responses=True,
    )
    logger.info("Redis 连接池初始化完成: %s", settings.redis_url)


async def disconnect() -> None:
    global _pool
    if _pool:
        await _pool.disconnect()
        _pool = None
        logger.info("Redis 连接池已关闭")


async def publish_task(session_id: str, user_id: str, request: str) -> None:
    """向 pi-runtime 发布新 session 任务"""
    payload = json.dumps({"session_id": session_id, "user_id": user_id, "request": request})
    client = get_redis()
    await client.publish(TASK_CHANNEL, payload)
    logger.info("任务已发布到 Redis Pub/Sub: session=%s", session_id)


async def stream_session_output(
    session_id: str,
    start_seq: str = "0",
) -> AsyncGenerator[dict[str, Any], None]:
    """
    从 Redis Stream 持续拉取 session 输出事件。
    start_seq: Redis Stream 的消息 ID（"0" 表示从头开始，"$" 表示只拉新消息）
    每次 XREAD 阻塞 sse_block_ms 毫秒，超时则 yield None（心跳）后继续。
    """
    client = get_redis()
    stream_key = _get_stream_key(session_id)
    last_id = start_seq

    while True:
        results = await client.xread(
            streams={stream_key: last_id},
            block=settings.sse_block_ms,
            count=50,
        )
        if not results:
            # 超时未收到数据，发送心跳
            yield {"heartbeat": True}
            continue

        for _key, messages in results:
            for msg_id, fields in messages:
                last_id = msg_id
                yield {"id": msg_id, **fields}

                # 收到 done 事件，停止拉取
                if fields.get("event_type") == "done":
                    return
