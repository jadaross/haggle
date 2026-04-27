from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.schemas.events import (
    ErrorResponse,
    FavouriteEventRequest,
    FavouriteEventResponse,
    SentConfirmRequest,
)
from app.services.event_processor import ProcessingError, confirm_sent, process_favourite_event

router = APIRouter(prefix="/events", tags=["events"])


@router.post(
    "/favourite",
    response_model=FavouriteEventResponse,
    responses={
        200: {"model": FavouriteEventResponse},
        401: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
    },
)
async def favourite_event(
    body: FavouriteEventRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await process_favourite_event(db, body.model_dump())
        return result
    except ProcessingError as e:
        if e.status_code == 200:
            # Duplicate — return a minimal success-like response
            return FavouriteEventResponse(
                event_id="",
                message_id="",
                message_text="",
                status="duplicate",
            )
        raise HTTPException(
            status_code=e.status_code,
            detail={"error": e.error_code, "detail": e.message},
        )


@router.post("/{event_id}/sent", status_code=204)
async def event_sent_confirmation(
    event_id: str,
    body: SentConfirmRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        await confirm_sent(
            db=db,
            event_id=event_id,
            raw_key=body.api_key,
            vinted_conversation_id=body.vinted_conversation_id,
            sent_at=body.sent_at,
        )
    except ProcessingError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
