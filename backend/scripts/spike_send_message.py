#!/usr/bin/env python3
"""
Spike: fetch notifications → find unfollowed likes → send a message.

Usage:
    cd backend
    VINTED_COOKIE="..." VINTED_CSRF="..." python scripts/spike_send_message.py

How to get your credentials from Chrome:
  1. Go to vinted.co.uk (stay logged in)
  2. Open DevTools → Network tab
  3. Refresh the page, click any request to vinted.co.uk
  4. In Request Headers, copy the full value of the "cookie" header → VINTED_COOKIE
  5. Copy the value of "x-csrf-token" → VINTED_CSRF

The script will:
  - Fetch your recent notifications
  - List items that were liked but you haven't started a conversation for
  - Ask which one to message
  - Create the conversation and send a test message (or a real Claude-generated one)
"""

import asyncio
import json
import os
import sys

import httpx

BASE_URL = "https://www.vinted.co.uk/api/v2"

COOKIE = os.environ.get("VINTED_COOKIE", "")
CSRF = os.environ.get("VINTED_CSRF", "")

if not COOKIE or not CSRF:
    print("ERROR: Set VINTED_COOKIE and VINTED_CSRF environment variables.")
    print("See the docstring at the top of this file for instructions.")
    sys.exit(1)

HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-GB,en;q=0.9",
    "cookie": COOKIE,
    "x-csrf-token": CSRF,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "referer": "https://www.vinted.co.uk/",
    "x-platform": "web",
}


async def get_notifications(client: httpx.AsyncClient, page: int = 1) -> dict:
    r = await client.get(
        f"{BASE_URL}/notifications",
        params={"page": page, "per_page": 20},
        headers=HEADERS,
    )
    r.raise_for_status()
    return r.json()


async def get_inbox(client: httpx.AsyncClient) -> dict:
    r = await client.get(f"{BASE_URL}/inbox", headers=HEADERS)
    r.raise_for_status()
    return r.json()


async def create_conversation(
    client: httpx.AsyncClient, item_id: str, buyer_id: str
) -> dict:
    r = await client.post(
        f"{BASE_URL}/conversations",
        json={
            "initiator": "seller_enters_notification",
            "item_id": item_id,
            "opposite_user_id": buyer_id,
        },
        headers={**HEADERS, "content-type": "application/json"},
    )
    r.raise_for_status()
    return r.json()


async def send_reply(
    client: httpx.AsyncClient, conversation_id: str, body: str
) -> dict:
    r = await client.post(
        f"{BASE_URL}/conversations/{conversation_id}/replies",
        json={
            "reply": {
                "body": body,
                "photo_temp_uuids": None,
                "is_personal_data_sharing_check_skipped": False,
            }
        },
        headers={**HEADERS, "content-type": "application/json"},
    )
    r.raise_for_status()
    return r.json()


async def main():
    async with httpx.AsyncClient(timeout=15) as client:
        # --- Step 1: fetch notifications ---
        print("\nFetching notifications...")
        notif_data = await get_notifications(client)

        print(f"\nRaw notifications response keys: {list(notif_data.keys())}")

        notifications = notif_data.get("notifications", [])
        if not notifications:
            print("No notifications key found. Full response:")
            print(json.dumps(notif_data, indent=2)[:2000])
            return

        # Filter to item_liked events only
        likes = [n for n in notifications if n.get("type") == "item_liked"]
        print(f"\nFound {len(notifications)} notifications, {len(likes)} are item_liked events.")

        if not likes:
            print("\nAll notification types found:")
            types = set(n.get("type") for n in notifications)
            for t in sorted(types):
                print(f"  {t}")
            print("\nFull first notification for schema inspection:")
            print(json.dumps(notifications[0], indent=2))
            return

        # --- Step 2: show the likes ---
        print("\nRecent likes (newest first):")
        for i, like in enumerate(likes[:10]):
            item = like.get("item", {}) or {}
            user = like.get("user", {}) or {}
            print(
                f"  [{i}] item_id={item.get('id','?')} "
                f"'{item.get('title','?')[:40]}' "
                f"by user_id={user.get('id','?')} @{user.get('login','?')}"
            )

        # --- Step 3: pick one ---
        choice = input("\nEnter index to send a message to (or 'q' to quit): ").strip()
        if choice.lower() == "q":
            return

        idx = int(choice)
        like = likes[idx]
        item = like.get("item", {}) or {}
        user = like.get("user", {}) or {}

        item_id = str(item.get("id"))
        buyer_id = str(user.get("id"))
        item_title = item.get("title", "your item")

        print(f"\nSelected: item '{item_title}' liked by @{user.get('login','?')}")

        # --- Step 4: compose message ---
        default_msg = f"Hi! Thanks for liking my {item_title}. Happy to answer any questions or discuss the price if you're interested!"
        print(f"\nDefault message:\n  {default_msg}")
        custom = input("Enter a custom message (or press Enter to use the default): ").strip()
        message_body = custom if custom else default_msg

        # --- Step 5: create conversation ---
        print("\nCreating conversation...")
        conv_data = await create_conversation(client, item_id, buyer_id)
        print(f"Conversation response: {json.dumps(conv_data, indent=2)[:500]}")

        conv_id = (
            str(conv_data.get("conversation", {}).get("id"))
            or str(conv_data.get("id"))
        )
        if not conv_id or conv_id == "None":
            print("ERROR: Could not extract conversation ID from response.")
            print("Full response:", json.dumps(conv_data, indent=2))
            return

        print(f"Conversation ID: {conv_id}")

        # --- Step 6: send the message ---
        confirm = input(f"\nSend this message? (yes/no): ").strip().lower()
        if confirm != "yes":
            print("Aborted.")
            return

        print("Sending message...")
        reply_data = await send_reply(client, conv_id, message_body)
        print(f"\nReply response: {json.dumps(reply_data, indent=2)[:500]}")
        print("\nDone.")


if __name__ == "__main__":
    asyncio.run(main())
