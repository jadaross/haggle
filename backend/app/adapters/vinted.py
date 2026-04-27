from __future__ import annotations

from datetime import datetime, timezone

from app.adapters.base import Buyer, FavouriteEvent, Item


def parse_favourite_event(payload: dict) -> FavouriteEvent:
    """
    Parse the raw request body sent by the Chrome extension into a FavouriteEvent.

    The extension sends a normalised payload (see API contract in RESEARCH.md),
    so this adapter is thin — it mostly validates presence and coerces types.
    """
    event = payload["event"]
    buyer_raw = event["buyer"]
    item_raw = event["item"]

    buyer = Buyer(
        id=str(buyer_raw["id"]),
        username=buyer_raw.get("username"),
        rating=_float_or_none(buyer_raw.get("rating")),
        item_count=_int_or_none(buyer_raw.get("item_count")),
        profile_url=buyer_raw.get("profile_url"),
    )

    item = Item(
        id=str(item_raw["id"]),
        title=item_raw["title"],
        price=float(item_raw["price"]),
        currency=item_raw.get("currency", "GBP"),
        brand=item_raw.get("brand"),
        size=item_raw.get("size"),
        condition=item_raw.get("condition"),
        description=item_raw.get("description"),
        url=item_raw.get("url"),
        photos=item_raw.get("photos", []),
    )

    detected_at_raw = event.get("detected_at")
    if detected_at_raw:
        detected_at = datetime.fromisoformat(detected_at_raw.replace("Z", "+00:00"))
    else:
        detected_at = datetime.now(tz=timezone.utc)

    return FavouriteEvent(
        platform=payload.get("platform", "vinted_uk"),
        notification_id=str(event["id"]),
        buyer=buyer,
        item=item,
        detected_at=detected_at,
    )


def _float_or_none(value: object) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _int_or_none(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
