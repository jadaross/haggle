from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class BuyerPayload(BaseModel):
    id: str = Field(..., max_length=100)
    username: str | None = Field(default=None, max_length=100)
    rating: float | None = None
    item_count: int | None = Field(default=None, ge=0, le=100000)
    profile_url: str | None = Field(default=None, max_length=500)


class ItemPayload(BaseModel):
    id: str = Field(..., max_length=100)
    title: str = Field(..., max_length=200)
    price: float = Field(..., ge=0, le=100000)
    currency: str = Field(default="GBP", max_length=8)
    brand: str | None = Field(default=None, max_length=100)
    size: str | None = Field(default=None, max_length=50)
    condition: str | None = Field(default=None, max_length=50)
    description: str | None = Field(default=None, max_length=5000)
    url: str | None = Field(default=None, max_length=500)
    photos: list[str] = Field(default_factory=list, max_length=20)


class PreviousMessage(BaseModel):
    role: str = Field(..., max_length=20)
    text: str = Field(..., max_length=4000)
    sent_at: datetime | None = None


class EventPayload(BaseModel):
    id: str = Field(..., max_length=100)
    detected_at: datetime | None = None
    buyer: BuyerPayload
    item: ItemPayload
    is_followup: bool = False
    previous_messages: list[PreviousMessage] = Field(default_factory=list, max_length=50)


class SellerConfig(BaseModel):
    floor_pct: int = Field(default=80, ge=50, le=100)
    max_messages_per_day: int = Field(default=20, ge=1, le=50)
    seller_persona: str | None = Field(default=None, max_length=500)


class FavouriteEventRequest(BaseModel):
    api_key: str = Field(..., max_length=200)
    platform: str = Field(default="vinted_uk", max_length=50)
    event: EventPayload
    seller_config: SellerConfig = Field(default_factory=SellerConfig)


class FavouriteEventResponse(BaseModel):
    event_id: str
    message_id: str
    message_text: str
    status: str


class SentConfirmRequest(BaseModel):
    api_key: str = Field(..., max_length=200)
    vinted_conversation_id: str = Field(..., max_length=200)
    sent_at: datetime | None = None


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None
