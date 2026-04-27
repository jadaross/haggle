import uuid
from datetime import date, datetime

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import BYTEA, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from app.db.database import Base


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    label: Mapped[str | None] = mapped_column(Text, nullable=True)
    platform: Mapped[str] = mapped_column(Text, nullable=False, default="vinted_uk")
    seller_persona: Mapped[str | None] = mapped_column(Text, nullable=True)
    floor_pct: Mapped[int] = mapped_column(Integer, nullable=False, default=80)
    daily_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=20)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    events: Mapped[list["FavouriteEvent"]] = relationship(back_populates="api_key_rel", foreign_keys="FavouriteEvent.api_key_hash", primaryjoin="ApiKey.key_hash == FavouriteEvent.api_key_hash")


class FavouriteEvent(Base):
    __tablename__ = "favourite_events"
    __table_args__ = (UniqueConstraint("platform", "notification_id", name="uq_platform_notification"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    platform: Mapped[str] = mapped_column(Text, nullable=False)
    notification_id: Mapped[str] = mapped_column(Text, nullable=False)
    api_key_hash: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    buyer_id: Mapped[str] = mapped_column(Text, nullable=False)
    buyer_username: Mapped[str | None] = mapped_column(Text, nullable=True)
    item_id: Mapped[str] = mapped_column(Text, nullable=False)
    item_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    buyer_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="received")
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    api_key_rel: Mapped["ApiKey | None"] = relationship(back_populates="events", foreign_keys=[api_key_hash], primaryjoin="ApiKey.key_hash == FavouriteEvent.api_key_hash")
    messages: Mapped[list["SentMessage"]] = relationship(back_populates="event")


class SentMessage(Base):
    __tablename__ = "sent_messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    favourite_event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("favourite_events.id"), nullable=False)
    message_text: Mapped[str] = mapped_column(Text, nullable=False)
    prompt_version: Mapped[str] = mapped_column(Text, nullable=False)
    claude_model: Mapped[str] = mapped_column(Text, nullable=False)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    generation_latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    vinted_conversation_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    event: Mapped["FavouriteEvent"] = relationship(back_populates="messages")


class DailyRateLimit(Base):
    __tablename__ = "daily_rate_limits"

    api_key_hash: Mapped[str] = mapped_column(Text, primary_key=True)
    date: Mapped[date] = mapped_column(Date, primary_key=True)
    messages_sent: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


# ── LangGraph checkpoint tables (unused in V1, schema-ready for V2) ──────────

class LangGraphCheckpoint(Base):
    __tablename__ = "checkpoints"

    thread_id: Mapped[str] = mapped_column(Text, primary_key=True)
    checkpoint_ns: Mapped[str] = mapped_column(Text, primary_key=True, default="")
    checkpoint_id: Mapped[str] = mapped_column(Text, primary_key=True)
    parent_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    type: Mapped[str | None] = mapped_column(Text, nullable=True)
    checkpoint: Mapped[dict] = mapped_column(JSONB, nullable=False)
    metadata_: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, default=dict)


class LangGraphCheckpointBlob(Base):
    __tablename__ = "checkpoint_blobs"

    thread_id: Mapped[str] = mapped_column(Text, primary_key=True)
    checkpoint_ns: Mapped[str] = mapped_column(Text, primary_key=True, default="")
    channel: Mapped[str] = mapped_column(Text, primary_key=True)
    version: Mapped[str] = mapped_column(Text, primary_key=True)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    blob: Mapped[bytes | None] = mapped_column(BYTEA, nullable=True)


class LangGraphCheckpointWrite(Base):
    __tablename__ = "checkpoint_writes"

    thread_id: Mapped[str] = mapped_column(Text, primary_key=True)
    checkpoint_ns: Mapped[str] = mapped_column(Text, primary_key=True, default="")
    checkpoint_id: Mapped[str] = mapped_column(Text, primary_key=True)
    task_id: Mapped[str] = mapped_column(Text, primary_key=True)
    idx: Mapped[int] = mapped_column(Integer, primary_key=True)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str | None] = mapped_column(Text, nullable=True)
    blob: Mapped[bytes] = mapped_column(BYTEA, nullable=False)
