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
    """用于历史列表的轻量摘要（一个 session = 一个 chat 窗口）"""
    session_id: str
    status: SessionStatus
    request: str
    created_at: datetime
    completed_at: datetime | None = None
