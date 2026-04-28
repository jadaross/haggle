#!/usr/bin/env python3
"""
Seed a test API key into the local database.

Usage:
    cd backend
    python scripts/seed_api_key.py hgl_live_test_key_123
"""

import asyncio
import hashlib
import sys

from app.db.database import AsyncSessionLocal
from app.db.models import ApiKey


async def seed(raw_key: str, label: str = "local-dev") -> None:
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    async with AsyncSessionLocal() as db:
        api_key = ApiKey(
            key_hash=key_hash,
            label=label,
            platform="vinted_uk",
            floor_pct=75,
            daily_limit=20,
            active=True,
        )
        db.add(api_key)
        try:
            await db.commit()
        except Exception as e:
            await db.rollback()
            print(f"Insert failed (key may already exist): {e}")
            return
    print(f"Seeded API key '{raw_key}' (hash: {key_hash[:12]}...) — label: {label}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/seed_api_key.py <raw_api_key> [label]")
        sys.exit(1)
    raw = sys.argv[1]
    lbl = sys.argv[2] if len(sys.argv) > 2 else "local-dev"
    asyncio.run(seed(raw, lbl))
