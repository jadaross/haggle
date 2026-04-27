from __future__ import annotations

from datetime import date, timezone
from datetime import datetime as dt

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import DailyRateLimit


async def get_messages_sent_today(db: AsyncSession, api_key_hash: str) -> int:
    today = dt.now(tz=timezone.utc).date()
    result = await db.execute(
        select(DailyRateLimit.messages_sent).where(
            DailyRateLimit.api_key_hash == api_key_hash,
            DailyRateLimit.date == today,
        )
    )
    row = result.scalar_one_or_none()
    return row or 0


async def check_rate_limit(
    db: AsyncSession,
    api_key_hash: str,
    user_daily_limit: int,
) -> tuple[bool, int]:
    """
    Returns (allowed, messages_sent_today).
    Enforces min(user_daily_limit, hard_daily_cap).
    """
    effective_limit = min(user_daily_limit, settings.hard_daily_cap)
    sent_today = await get_messages_sent_today(db, api_key_hash)
    return sent_today < effective_limit, sent_today


async def increment_daily_count(db: AsyncSession, api_key_hash: str) -> None:
    today = dt.now(tz=timezone.utc).date()
    stmt = (
        insert(DailyRateLimit)
        .values(api_key_hash=api_key_hash, date=today, messages_sent=1)
        .on_conflict_do_update(
            index_elements=["api_key_hash", "date"],
            set_={"messages_sent": DailyRateLimit.messages_sent + 1},
        )
    )
    await db.execute(stmt)
    await db.commit()
