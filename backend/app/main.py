from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db.database import engine
from app.db.models import Base
from app.routers import events, stats


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables if they don't exist (Alembic handles production migrations;
    # this is a dev convenience only — remove if you want strict migration control)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()


app = FastAPI(
    title="Haggle API",
    description="AI-powered Vinted seller automation backend",
    version="0.1.0",
    lifespan=lifespan,
)

# Allow requests from the Chrome extension (chrome-extension:// origin)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in production if desired
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(events.router)
app.include_router(stats.router)
