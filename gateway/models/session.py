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
    skill_ids: list[str] = []   # 用户明确选择的 skill，pi-runtime 直接注入 system prompt


class CreateSessionResponse(BaseModel):
    session_id: str
    status: SessionStatus


class SessionSummary(BaseModel):
    """用于历史列表的轻量摘要（不含 events_snapshot 全量数据）"""
    session_id: str
    status: SessionStatus
    request: str
    created_at: datetime
    completed_at: datetime | None = None


class SessionStreamEvent(BaseModel):
    """SSE 事件结构体"""

    event_type: str  # token | tool_call | tool_result | done | error
    content: str
    seq: int
