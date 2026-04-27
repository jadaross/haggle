"""
V1 opening message prompt.

Versioned so we can A/B test prompt changes without losing attribution
on historical sent_messages rows (prompt_version column).
"""

VERSION = "v1_opening"

SYSTEM = """\
You help a Vinted seller send short, casual messages to buyers who have favourited their items.

Write 1-2 sentences max. Sound like a real person texting, not a salesperson.
The message should feel like: "Hey! Still got this if you're interested, happy to take offers"

Rules:
- Start with "Hey!"
- Keep it very short and casual
- If there's room to negotiate, mention you're open to offers
- If there's no room, just say it's still available
- No em dashes
- No exclamation marks after the opening "Hey!"
- Do not mention Vinted by name
- Write in English\
"""

USER = """\
Item the buyer favourited:
  Title: {title}
  Price: £{price}
  Brand: {brand}
  Size: {size}
  Condition: {condition}
  Description snippet: {description_snippet}

Seller floor price: £{floor_price:.2f} ({floor_pct}% of listed)
Room to negotiate: {has_room}

Buyer: {buyer_username} (rating: {buyer_rating}, {buyer_item_count} items on profile)

Seller persona: {seller_persona}

Write the message.\
"""


def build_user_prompt(
    *,
    title: str,
    price: float,
    brand: str | None,
    size: str | None,
    condition: str | None,
    description: str | None,
    floor_pct: int,
    buyer_username: str | None,
    buyer_rating: float | None,
    buyer_item_count: int | None,
    seller_persona: str,
) -> str:
    floor_price = price * (floor_pct / 100)
    discount_room = price - floor_price
    has_room = f"yes — up to £{discount_room:.0f} off" if discount_room >= price * 0.10 else "no — priced to sell"

    description_snippet = (description or "")[:200].strip() or "—"
    brand_str = brand or "unbranded"
    size_str = size or "—"
    condition_str = condition or "—"
    buyer_username_str = buyer_username or "buyer"
    buyer_rating_str = f"{buyer_rating:.1f}" if buyer_rating is not None else "new"
    buyer_item_count_str = str(buyer_item_count) if buyer_item_count is not None else "unknown number of"

    return USER.format(
        title=title,
        price=price,
        brand=brand_str,
        size=size_str,
        condition=condition_str,
        description_snippet=description_snippet,
        floor_price=floor_price,
        floor_pct=floor_pct,
        has_room=has_room,
        buyer_username=buyer_username_str,
        buyer_rating=buyer_rating_str,
        buyer_item_count=buyer_item_count_str,
        seller_persona=seller_persona,
    )
