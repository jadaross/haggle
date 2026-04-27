from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class StatsResponse(BaseModel):
    messages_sent_today: int
    daily_limit: int
    total_messages_sent: int


class HealthResponse(BaseModel):
    status: str
    version: str = "0.1.0"
