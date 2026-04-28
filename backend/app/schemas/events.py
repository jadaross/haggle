from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class BuyerPayload(BaseModel):
    id: str
    username: str | None = None
    rating: float | None = None
    item_count: int | None = None
    profile_url: str | None = None


class ItemPayload(BaseModel):
    id: str
    title: str
    price: float
    currency: str = "GBP"
    brand: str | None = None
    size: str | None = None
    condition: str | None = None
    description: str | None = None
    url: str | None = None
    photos: list[str] = Field(default_factory=list)


class PreviousMessage(BaseModel):
    role: str  # "seller" | "buyer"
    text: str
    sent_at: datetime | None = None


class EventPayload(BaseModel):
    id: str
    detected_at: datetime | None = None
    buyer: BuyerPayload
    item: ItemPayload
    is_followup: bool = False
    previous_messages: list[PreviousMessage] = Field(default_factory=list)


class SellerConfig(BaseModel):
    floor_pct: int = Field(default=80, ge=50, le=100)
    max_messages_per_day: int = Field(default=20, ge=1, le=50)
    seller_persona: str | None = None


class FavouriteEventRequest(BaseModel):
    api_key: str
    platform: str = "vinted_uk"
    event: EventPayload
    seller_config: SellerConfig = Field(default_factory=SellerConfig)


class FavouriteEventResponse(BaseModel):
    event_id: str
    message_id: str
    message_text: str
    status: str


class SentConfirmRequest(BaseModel):
    api_key: str
    vinted_conversation_id: str
    sent_at: datetime | None = None


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None
