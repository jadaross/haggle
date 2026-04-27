from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass
class Buyer:
    id: str
    username: str | None
    rating: float | None
    item_count: int | None
    profile_url: str | None


@dataclass
class Item:
    id: str
    title: str
    price: float
    currency: str
    brand: str | None
    size: str | None
    condition: str | None
    description: str | None
    url: str | None
    photos: list[str]


@dataclass
class FavouriteEvent:
    """Platform-agnostic representation of a buyer favouriting a seller's item."""

    platform: str          # e.g. "vinted_uk", "depop", "ebay"
    notification_id: str   # platform-native ID — used for deduplication
    buyer: Buyer
    item: Item
    detected_at: datetime

    def to_item_data_dict(self) -> dict:
        """Serialise item for JSONB storage."""
        return {
            "id": self.item.id,
            "title": self.item.title,
            "price": self.item.price,
            "currency": self.item.currency,
            "brand": self.item.brand,
            "size": self.item.size,
            "condition": self.item.condition,
            "description": self.item.description,
            "url": self.item.url,
            "photos": self.item.photos,
        }

    def to_buyer_data_dict(self) -> dict:
        """Serialise buyer for JSONB storage."""
        return {
            "id": self.buyer.id,
            "username": self.buyer.username,
            "rating": self.buyer.rating,
            "item_count": self.buyer.item_count,
            "profile_url": self.buyer.profile_url,
        }
