"""Initial schema

Revision ID: 0001
Revises:
Create Date: 2026-04-26

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import BYTEA, JSONB, UUID

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "api_keys",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("key_hash", sa.Text, nullable=False, unique=True),
        sa.Column("label", sa.Text, nullable=True),
        sa.Column("platform", sa.Text, nullable=False, server_default="vinted_uk"),
        sa.Column("seller_persona", sa.Text, nullable=True),
        sa.Column("floor_pct", sa.Integer, nullable=False, server_default="80"),
        sa.Column("daily_limit", sa.Integer, nullable=False, server_default="20"),
        sa.Column("active", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    op.create_table(
        "favourite_events",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("platform", sa.Text, nullable=False),
        sa.Column("notification_id", sa.Text, nullable=False),
        sa.Column("api_key_hash", sa.Text, nullable=False),
        sa.Column("buyer_id", sa.Text, nullable=False),
        sa.Column("buyer_username", sa.Text, nullable=True),
        sa.Column("item_id", sa.Text, nullable=False),
        sa.Column("item_data", JSONB, nullable=False),
        sa.Column("buyer_data", JSONB, nullable=True),
        sa.Column("status", sa.Text, nullable=False, server_default="received"),
        sa.Column("detected_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("platform", "notification_id", name="uq_platform_notification"),
    )
    op.create_index("idx_favourite_events_api_key", "favourite_events", ["api_key_hash"])
    op.create_index("idx_favourite_events_status", "favourite_events", ["platform", "status"])

    op.create_table(
        "sent_messages",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("favourite_event_id", UUID(as_uuid=True), sa.ForeignKey("favourite_events.id"), nullable=False),
        sa.Column("message_text", sa.Text, nullable=False),
        sa.Column("prompt_version", sa.Text, nullable=False),
        sa.Column("claude_model", sa.Text, nullable=False),
        sa.Column("input_tokens", sa.Integer, nullable=True),
        sa.Column("output_tokens", sa.Integer, nullable=True),
        sa.Column("generation_latency_ms", sa.Integer, nullable=True),
        sa.Column("vinted_conversation_id", sa.Text, nullable=True),
        sa.Column("sent_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    op.create_table(
        "daily_rate_limits",
        sa.Column("api_key_hash", sa.Text, primary_key=True),
        sa.Column("date", sa.Date, primary_key=True),
        sa.Column("messages_sent", sa.Integer, nullable=False, server_default="0"),
    )

    # LangGraph checkpoint tables — unused in V1, schema-ready for V2
    op.create_table(
        "checkpoints",
        sa.Column("thread_id", sa.Text, primary_key=True),
        sa.Column("checkpoint_ns", sa.Text, primary_key=True, server_default=""),
        sa.Column("checkpoint_id", sa.Text, primary_key=True),
        sa.Column("parent_id", sa.Text, nullable=True),
        sa.Column("type", sa.Text, nullable=True),
        sa.Column("checkpoint", JSONB, nullable=False),
        sa.Column("metadata", JSONB, nullable=False, server_default="{}"),
    )

    op.create_table(
        "checkpoint_blobs",
        sa.Column("thread_id", sa.Text, primary_key=True),
        sa.Column("checkpoint_ns", sa.Text, primary_key=True, server_default=""),
        sa.Column("channel", sa.Text, primary_key=True),
        sa.Column("version", sa.Text, primary_key=True),
        sa.Column("type", sa.Text, nullable=False),
        sa.Column("blob", BYTEA, nullable=True),
    )

    op.create_table(
        "checkpoint_writes",
        sa.Column("thread_id", sa.Text, primary_key=True),
        sa.Column("checkpoint_ns", sa.Text, primary_key=True, server_default=""),
        sa.Column("checkpoint_id", sa.Text, primary_key=True),
        sa.Column("task_id", sa.Text, primary_key=True),
        sa.Column("idx", sa.Integer, primary_key=True),
        sa.Column("channel", sa.Text, nullable=False),
        sa.Column("type", sa.Text, nullable=True),
        sa.Column("blob", BYTEA, nullable=False),
    )


def downgrade() -> None:
    op.drop_table("checkpoint_writes")
    op.drop_table("checkpoint_blobs")
    op.drop_table("checkpoints")
    op.drop_table("daily_rate_limits")
    op.drop_table("sent_messages")
    op.drop_index("idx_favourite_events_status")
    op.drop_index("idx_favourite_events_api_key")
    op.drop_table("favourite_events")
    op.drop_table("api_keys")
