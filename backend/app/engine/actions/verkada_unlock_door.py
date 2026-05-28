"""Action: Verkada admin door unlock."""

import json
from typing import Any

from app.brand import BRAND_NAME
from app.connectors.verkada.client import VerkadaClient
from app.crypto import decrypt_secret
from app.models import Connection


SCHEMA: dict[str, Any] = {
    "fields": [
        {
            "name": "connection_id",
            "label": "Verkada connection",
            "type": "connection_ref",
            "connection_type": "verkada",
            "required": True,
            "help": "Which stored Verkada org's API key to use.",
        },
        {
            "name": "door_id",
            "label": "Door",
            "type": "door_ref",
            "required": True,
            "help": (
                f"Pick from doors {BRAND_NAME} has seen, or paste a door_id UUID. "
                "The door must have **Door Management via API** enabled in "
                "Verkada Command → Access → the door's settings, or the unlock "
                "call will be rejected even with the right API permissions."
            ),
        },
    ]
}


SAMPLE_OUTPUT: dict[str, Any] = {
    "action": "verkada_unlock_door",
    "door_id": "...",
    "verkada_response": {
        "status_code": 200,
        "body": {},
    },
}


async def run(
    config: dict[str, Any],
    ctx: dict[str, Any],
    connection: Connection,
) -> dict[str, Any]:
    door_id = config.get("door_id")
    if not door_id or not isinstance(door_id, str):
        raise ValueError("action config missing required 'door_id'")

    secret = decrypt_secret(connection.encrypted_secret)
    api_key = secret.get("api_key")
    if not api_key:
        raise ValueError(
            f"connection {connection.id} has no api_key set — finish setup first"
        )
    region = secret.get("region") or None

    body = {"door_id": door_id}
    progress = ctx.get("_progress")
    if progress:
        await progress.log(
            "POST /access/v1/door/admin_unlock → " + json.dumps(body, default=str)
        )

    client = VerkadaClient(api_key=api_key, base_url=region)
    result = await client.unlock_door(door_id)
    if progress:
        await progress.log(
            f"Verkada responded {result.get('status_code')}: "
            + json.dumps(result.get("body"), default=str)
        )
    return {
        "action": "verkada_unlock_door",
        "door_id": door_id,
        "request_body": body,
        "verkada_response": result,
    }
