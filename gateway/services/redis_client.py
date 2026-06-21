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
# 全局任务频道：所有 pi-runtime 实例都订阅（无 sticky session 时使用）
TASK_CHANNEL_GLOBAL = "sessions:new"
# 实例专属任务频道：sticky session 模式下路由到特定实例
TASK_CHANNEL_INSTANCE = "sessions:{instance_id}:new"
# user → pi-runtime instance 的亲和映射，TTL 24h（用于 sticky session）
USER_INSTANCE_KEY = "user:{user_id}:instance"
USER_INSTANCE_TTL = 86400
# pi-runtime 实例心跳 key（TTL 60s，每 30s 刷新；key 不存在表示实例已下线）
INSTANCE_ALIVE_KEY = "pi:instance:{instance_id}:alive"


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


async def _get_user_instance(user_id: str) -> str | None:
    """查询 user 绑定的 pi-runtime 实例，并验证实例是否存活。
    若实例心跳 key 不存在（实例已重启或下线），清除 stale 绑定并返回 None。
    """
    client = get_redis()
    instance_id = await client.get(USER_INSTANCE_KEY.format(user_id=user_id))
    if not instance_id:
        return None

    alive = await client.exists(INSTANCE_ALIVE_KEY.format(instance_id=instance_id))
    if not alive:
        logger.info("sticky 实例 %s 已下线，清除 user=%s 的 stale 绑定", instance_id, user_id)
        await client.delete(USER_INSTANCE_KEY.format(user_id=user_id))
        return None

    return instance_id


async def publish_task(
    session_id: str,
    user_id: str,
    request: str,
    skill_ids: list[str] | None = None,
    conversation_id: str | None = None,
    context: str | None = None,
) -> None:
    """
    向 pi-runtime 发布新 session 任务。

    Sticky session 路由逻辑：
      1. 查询该 user 是否已绑定到某个 pi-runtime 实例
      2. 若已绑定，发布到该实例专属频道（保证 workspace 连续性）
      3. 若未绑定，发布到全局频道（由任意实例认领，认领时写入绑定关系）
    """
    payload = json.dumps({
        "session_id": session_id,
        "user_id": user_id,
        "request": request,
        "skill_ids": skill_ids or [],
        "conversation_id": conversation_id,
        "context": context,
    })
    client = get_redis()

    instance_id = await _get_user_instance(user_id)
    if instance_id:
        channel = TASK_CHANNEL_INSTANCE.format(instance_id=instance_id)
        logger.info("sticky session 路由: user=%s → instance=%s session=%s", user_id, instance_id, session_id)
    else:
        channel = TASK_CHANNEL_GLOBAL
        logger.info("全局路由（新用户或实例未知）: session=%s user=%s", session_id, user_id)

    await client.publish(channel, payload)


async def bind_user_to_instance(user_id: str, instance_id: str) -> None:
    """
    pi-runtime 实例认领任务后，将 user → instance 绑定关系写入 Redis。
    由 pi-runtime 通过独立接口或消息回写；gateway 此处提供写入方法供统一管理。
    """
    client = get_redis()
    key = USER_INSTANCE_KEY.format(user_id=user_id)
    await client.setex(key, USER_INSTANCE_TTL, instance_id)
    logger.info("user 实例绑定: user=%s → instance=%s TTL=%ds", user_id, instance_id, USER_INSTANCE_TTL)


async def stream_session_output(
    session_id: str,
    start_seq: str = "0",
) -> AsyncGenerator[dict[str, Any], None]:
    """
    从 Redis Stream 持续拉取 session 输出事件。
    start_seq: Redis Stream 的消息 ID（"0" 表示从头开始）
    每次 XREAD 阻塞 sse_block_ms 毫秒，超时则 yield 心跳后继续。
    """
    client = get_redis()
    stream_key = _get_stream_key(session_id)
    last_id = start_seq
    heartbeat_count = 0

    logger.info("开始读取 Redis Stream: key=%s start_seq=%s", stream_key, start_seq)

    while True:
        results = await client.xread(
            streams={stream_key: last_id},
            block=settings.sse_block_ms,
            count=50,
        )
        if not results:
            heartbeat_count += 1
            # 每隔 10 次心跳（约 10 * sse_block_ms）打一次日志，避免刷屏
            if heartbeat_count % 10 == 1:
                logger.debug("session %s: 等待 Redis Stream 中（心跳 #%d，last_id=%s）",
                             session_id, heartbeat_count, last_id)
            yield {"heartbeat": True}
            continue

        for _key, messages in results:
            batch_size = len(messages)
            logger.debug("session %s: 读取到 %d 条消息（last_id=%s）", session_id, batch_size, last_id)

            for msg_id, fields in messages:
                last_id = msg_id
                event_type = fields.get("event_type", "unknown")

                if event_type in ("done", "error"):
                    logger.info("session %s: Redis Stream 终止事件 event_type=%s msg_id=%s",
                                session_id, event_type, msg_id)

                yield {"id": msg_id, **fields}

                if event_type == "done":
                    return
