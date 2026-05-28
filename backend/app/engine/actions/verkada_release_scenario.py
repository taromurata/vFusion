"""Action: release (deactivate) a previously-activated Verkada Access scenario."""

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
            "name": "scenario_id",
            "label": "Scenario",
            "type": "scenario_ref",
            "required": True,
            "help": (
                f"Pick from scenarios {BRAND_NAME} has synced. Release "
                "is a no-op on a scenario that's already INACTIVE."
            ),
        },
    ]
}


SAMPLE_OUTPUT: dict[str, Any] = {
    "action": "verkada_release_scenario",
    "scenario_id": "...",
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
    scenario_id = config.get("scenario_id")
    if not scenario_id or not isinstance(scenario_id, str):
        raise ValueError("action config missing required 'scenario_id'")

    secret = decrypt_secret(connection.encrypted_secret)
    api_key = secret.get("api_key")
    if not api_key:
        raise ValueError(
            f"connection {connection.id} has no api_key set — finish setup first"
        )
    region = secret.get("region") or None

    body = {"scenario_id": scenario_id}
    progress = ctx.get("_progress")
    if progress:
        await progress.log(
            "POST /access/v1/scenario/release → " + json.dumps(body, default=str)
        )

    client = VerkadaClient(api_key=api_key, base_url=region)
    result = await client.release_scenario(scenario_id)
    if progress:
        await progress.log(
            f"Verkada responded {result.get('status_code')}: "
            + json.dumps(result.get("body"), default=str)
        )
    return {
        "action": "verkada_release_scenario",
        "scenario_id": scenario_id,
        "request_body": body,
        "verkada_response": result,
    }
