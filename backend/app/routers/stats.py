from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import APIRouter, Depends, Header, HTTPException, Query

from app.db.database import get_db
from app.db.models import DailyRateLimit, SentMessage
from app.schemas.stats import HealthResponse, StatsResponse
from app.services.event_processor import hash_key
from app.services.rate_limiter import get_messages_sent_today
from app.config import settings

from datetime import timezone
from datetime import datetime as dt

router = APIRouter(tags=["stats"])


@router.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(status="ok")


@router.get("/stats", response_model=StatsResponse)
async def stats(
    authorization: str = Header(...),
    daily_limit: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    api_key = authorization.removeprefix("Bearer ").strip()
    if not api_key:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    key_hash = hash_key(api_key)
    sent_today = await get_messages_sent_today(db, key_hash)

    total_result = await db.execute(
        select(func.count(SentMessage.id))
        .join(SentMessage.event)
        .where(SentMessage.event.has(api_key_hash=key_hash))
    )
    total = total_result.scalar_one_or_none() or 0

    return StatsResponse(
        messages_sent_today=sent_today,
        daily_limit=min(daily_limit, settings.hard_daily_cap),
        total_messages_sent=total,
    )
