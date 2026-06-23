from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class SessionStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class SessionDocument(BaseModel):
    """MongoDB 中存储的 session 完整文档"""

    id: str = Field(alias="_id")
    user_id: str
    conversation_id: str | None = None
    status: SessionStatus = SessionStatus.PENDING
    request: str
    skill_ids: list[str] = Field(default_factory=list)
    events_snapshot: list[dict[str, Any]] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error: str | None = None

    class Config:
        populate_by_name = True


class CreateSessionRequest(BaseModel):
    user_id: str
    request: str
    turn_id: str           # 第一个轮次 ID，由前端生成（UUID），用于 SSE stream key
    skill_ids: list[str] = []


class SendMessageRequest(BaseModel):
    """向已有 session 发送新消息（新轮次）"""
    request: str
    turn_id: str           # 本轮次 ID，由前端生成，用于 SSE stream key
    skill_ids: list[str] = []


class SendMessageResponse(BaseModel):
    turn_id: str
    session_id: str


class CreateSessionResponse(BaseModel):
    session_id: str
    status: SessionStatus


class SessionSummary(BaseModel):
    """用于历史列表的轻量摘要（不含 events_snapshot 全量数据）"""
    session_id: str
    conversation_id: str | None = None
    status: SessionStatus
    request: str
    created_at: datetime
    completed_at: datetime | None = None


class SessionStreamEvent(BaseModel):
    """SSE 事件结构体"""

    event_type: str  # token | tool_call | tool_result | done | error
    content: str
    seq: int


class ConversationSummary(BaseModel):
    """对话维度摘要（按 conversation_id 聚合），用于历史侧边栏"""
    conversation_id: str
    first_request: str
    last_status: SessionStatus
    last_created_at: datetime
    session_count: int


class ConversationSession(BaseModel):
    """含 events_snapshot 的 session，用于一次性重建对话消息列表"""
    session_id: str
    status: SessionStatus
    request: str
    events_snapshot: list[dict[str, Any]] = Field(default_factory=list)
