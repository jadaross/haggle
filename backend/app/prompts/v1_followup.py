"""
V1 follow-up message prompt.

Used when a buyer has favourited an item and there is already a conversation
between them and the seller. The model gets the prior message history.
"""

VERSION = "v1_followup"

SYSTEM = """\
You help a Vinted seller send a short, casual follow-up to a buyer who has favourited an item again.
The buyer and seller already have message history — you will see the prior messages.

Write 1-2 sentences. Sound like a real person, not a salesperson.

Rules:
- Don't repeat what's already been said
- If the buyer asked something that wasn't answered, address it
- If there's room to negotiate, gently mention you're open to offers
- If the conversation went quiet, a friendly nudge is fine but never pushy
- No em dashes
- Don't say "Hey!" again if there's already conversation flow
- Do not mention Vinted by name
- Write in English\
"""

USER = """\
Item the buyer favourited (again):
  Title: {title}
  Price: £{price}
  Brand: {brand}

Seller floor price: £{floor_price:.2f} ({floor_pct}% of listed)
Room to negotiate: {has_room}

Buyer: {buyer_username}

Recent message history (oldest → newest):
{message_history}

Seller persona: {seller_persona}

Write a short follow-up message.\
"""


def build_user_prompt(
    *,
    title: str,
    price: float,
    brand: str | None,
    floor_pct: int,
    buyer_username: str | None,
    seller_persona: str,
    previous_messages: list[dict],
) -> str:
    floor_price = price * (floor_pct / 100)
    discount_room = price - floor_price
    has_room = (
        f"yes — up to £{discount_room:.0f} off"
        if discount_room >= price * 0.10
        else "no — priced to sell"
    )

    # Format history. Each entry: {role: "seller"|"buyer", text: "..."}
    if not previous_messages:
        history = "  (no prior messages)"
    else:
        lines = []
        for m in previous_messages[-10:]:  # cap at last 10 to keep prompt bounded
            role = m.get("role", "?")
            text = (m.get("text") or "").strip()
            lines.append(f"  {role}: {text}")
        history = "\n".join(lines)

    return USER.format(
        title=title,
        price=price,
        brand=brand or "—",
        floor_price=floor_price,
        floor_pct=floor_pct,
        has_room=has_room,
        buyer_username=buyer_username or "buyer",
        message_history=history,
        seller_persona=seller_persona,
    )
