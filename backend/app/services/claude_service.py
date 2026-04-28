from __future__ import annotations

import time

import anthropic

from app.adapters.base import FavouriteEvent
from app.config import settings
from app.prompts import v1_followup, v1_opening

_client = anthropic.Anthropic(api_key=settings.anthropic_api_key)


class GeneratedMessage:
    def __init__(
        self,
        text: str,
        prompt_version: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        latency_ms: int,
    ) -> None:
        self.text = text
        self.prompt_version = prompt_version
        self.model = model
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.latency_ms = latency_ms


def generate_opening_message(
    event: FavouriteEvent,
    floor_pct: int,
    seller_persona: str,
) -> GeneratedMessage:
    """
    Call Claude to generate a personalised opening message for a buyer
    who favourited one of the seller's items.
    """
    user_prompt = v1_opening.build_user_prompt(
        title=event.item.title,
        price=event.item.price,
        brand=event.item.brand,
        size=event.item.size,
        condition=event.item.condition,
        description=event.item.description,
        floor_pct=floor_pct,
        buyer_username=event.buyer.username,
        buyer_rating=event.buyer.rating,
        buyer_item_count=event.buyer.item_count,
        seller_persona=seller_persona,
    )

    t0 = time.monotonic()
    response = _client.messages.create(
        model=settings.claude_model,
        max_tokens=256,
        system=v1_opening.SYSTEM,
        messages=[{"role": "user", "content": user_prompt}],
    )
    latency_ms = int((time.monotonic() - t0) * 1000)

    text = response.content[0].text.strip()

    return GeneratedMessage(
        text=text,
        prompt_version=v1_opening.VERSION,
        model=settings.claude_model,
        input_tokens=response.usage.input_tokens,
        output_tokens=response.usage.output_tokens,
        latency_ms=latency_ms,
    )


def generate_followup_message(
    event: FavouriteEvent,
    floor_pct: int,
    seller_persona: str,
) -> GeneratedMessage:
    """Generate a follow-up message when there is prior conversation history."""
    user_prompt = v1_followup.build_user_prompt(
        title=event.item.title,
        price=event.item.price,
        brand=event.item.brand,
        floor_pct=floor_pct,
        buyer_username=event.buyer.username,
        seller_persona=seller_persona,
        previous_messages=event.previous_messages or [],
    )

    t0 = time.monotonic()
    response = _client.messages.create(
        model=settings.claude_model,
        max_tokens=256,
        system=v1_followup.SYSTEM,
        messages=[{"role": "user", "content": user_prompt}],
    )
    latency_ms = int((time.monotonic() - t0) * 1000)

    text = response.content[0].text.strip()

    return GeneratedMessage(
        text=text,
        prompt_version=v1_followup.VERSION,
        model=settings.claude_model,
        input_tokens=response.usage.input_tokens,
        output_tokens=response.usage.output_tokens,
        latency_ms=latency_ms,
    )
