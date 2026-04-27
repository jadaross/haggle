from __future__ import annotations

import hashlib
import hmac
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.base import FavouriteEvent
from app.adapters.vinted import parse_favourite_event
from app.config import settings
from app.db.models import ApiKey, FavouriteEvent as FavouriteEventModel, SentMessage
from app.services import claude_service, rate_limiter


class ProcessingError(Exception):
    def __init__(self, error_code: str, message: str, status_code: int = 400) -> None:
        self.error_code = error_code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def hash_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode()).hexdigest()


async def resolve_api_key(db: AsyncSession, raw_key: str) -> ApiKey:
    key_hash = hash_key(raw_key)
    result = await db.execute(
        select(ApiKey).where(ApiKey.key_hash == key_hash, ApiKey.active == True)  # noqa: E712
    )
    api_key = result.scalar_one_or_none()
    if api_key is None:
        raise ProcessingError("invalid_api_key", "Invalid or inactive API key.", status_code=401)
    return api_key


async def process_favourite_event(
    db: AsyncSession,
    raw_payload: dict,
) -> dict:
    """
    Full pipeline: validate → deduplicate → rate-check → Claude → persist → return message.
    Returns a dict ready to be serialised as the API response.
    """
    # 1. Resolve API key
    raw_key = raw_payload.get("api_key", "")
    api_key = await resolve_api_key(db, raw_key)
    key_hash = hash_key(raw_key)

    # 2. Parse payload into a FavouriteEvent
    event: FavouriteEvent = parse_favourite_event(raw_payload)

    # 3. Deduplicate — attempt insert, ignore on conflict
    event_row_id = uuid.uuid4()
    stmt = (
        pg_insert(FavouriteEventModel)
        .values(
            id=event_row_id,
            platform=event.platform,
            notification_id=event.notification_id,
            api_key_hash=key_hash,
            buyer_id=event.buyer.id,
            buyer_username=event.buyer.username,
            item_id=event.item.id,
            item_data=event.to_item_data_dict(),
            buyer_data=event.to_buyer_data_dict(),
            status="received",
            detected_at=event.detected_at,
        )
        .on_conflict_do_nothing(constraint="uq_platform_notification")
        .returning(FavouriteEventModel.id)
    )
    result = await db.execute(stmt)
    returned = result.fetchone()

    if returned is None:
        # Already processed — return a benign skip response
        raise ProcessingError("duplicate_event", "Event already processed.", status_code=200)

    db_event_id = returned[0]
    await db.commit()

    # 4. Rate limit check
    seller_config = raw_payload.get("seller_config", {})
    user_daily_limit = int(seller_config.get("max_messages_per_day", api_key.daily_limit))
    allowed, sent_today = await rate_limiter.check_rate_limit(db, key_hash, user_daily_limit)

    if not allowed:
        await _update_event_status(db, db_event_id, "rate_limited")
        raise ProcessingError(
            "daily_limit_reached",
            f"Daily limit of {min(user_daily_limit, settings.hard_daily_cap)} messages reached.",
            status_code=429,
        )

    # 5. Generate message with Claude
    floor_pct = int(seller_config.get("floor_pct", api_key.floor_pct))
    seller_persona = seller_config.get("seller_persona") or api_key.seller_persona or "Friendly, honest seller."

    await _update_event_status(db, db_event_id, "generating")

    generated = claude_service.generate_opening_message(
        event=event,
        floor_pct=floor_pct,
        seller_persona=seller_persona,
    )

    # 6. Persist SentMessage
    sent_msg = SentMessage(
        favourite_event_id=db_event_id,
        message_text=generated.text,
        prompt_version=generated.prompt_version,
        claude_model=generated.model,
        input_tokens=generated.input_tokens,
        output_tokens=generated.output_tokens,
        generation_latency_ms=generated.latency_ms,
    )
    db.add(sent_msg)
    await _update_event_status(db, db_event_id, "sent")
    await rate_limiter.increment_daily_count(db, key_hash)
    await db.commit()
    await db.refresh(sent_msg)

    return {
        "event_id": str(db_event_id),
        "message_id": str(sent_msg.id),
        "message_text": generated.text,
        "status": "generated",
    }


async def confirm_sent(
    db: AsyncSession,
    event_id: str,
    raw_key: str,
    vinted_conversation_id: str,
    sent_at: datetime | None,
) -> None:
    """Record that the extension successfully sent the message to Vinted."""
    key_hash = hash_key(raw_key)

    result = await db.execute(
        select(SentMessage)
        .join(FavouriteEventModel, SentMessage.favourite_event_id == FavouriteEventModel.id)
        .where(
            FavouriteEventModel.id == uuid.UUID(event_id),
            FavouriteEventModel.api_key_hash == key_hash,
        )
        .order_by(SentMessage.created_at.desc())
        .limit(1)
    )
    sent_msg = result.scalar_one_or_none()
    if sent_msg is None:
        raise ProcessingError("not_found", "Event not found.", status_code=404)

    sent_msg.vinted_conversation_id = vinted_conversation_id
    sent_msg.sent_at = sent_at or datetime.now(tz=timezone.utc)
    await db.commit()


async def _update_event_status(db: AsyncSession, event_id: uuid.UUID, status: str) -> None:
    result = await db.execute(select(FavouriteEventModel).where(FavouriteEventModel.id == event_id))
    row = result.scalar_one_or_none()
    if row:
        row.status = status
        await db.commit()
