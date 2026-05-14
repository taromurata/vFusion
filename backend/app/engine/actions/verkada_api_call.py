"""Generic Verkada API call action.

The user picks any cataloged endpoint and supplies path/query/body. The
action substitutes ``{{ trigger.data.* }}`` template references against
the triggering webhook payload before sending the request.

This is the workhorse action — every Verkada endpoint becomes usable as
a flow step without writing new code. Adding new actions is now a
question of how Verkada's API changes, not how vFusion's codebase
changes.
"""

import re
from typing import Any
from uuid import UUID

from sqlalchemy import select

from app.connectors.verkada.client import VerkadaApiError, VerkadaClient
from app.crypto import decrypt_secret
from app.db import SessionLocal
from app.engine.templates import resolve_deep
from app.models import Connection, VerkadaApiEndpoint


SAMPLE_OUTPUT: dict[str, Any] = {
    "action": "verkada_api_call",
    "method": "POST",
    "path": "/...",
    "request": {"query": None, "body": {}},
    "verkada_response": {
        "status_code": 200,
        "body": {},
    },
}


SCHEMA: dict[str, Any] = {
    "fields": [
        {
            "name": "connection_id",
            "label": "Verkada connection",
            "type": "connection_ref",
            "connection_type": "verkada",
            "required": True,
        },
        {
            "name": "endpoint_id",
            "label": "Verkada endpoint",
            "type": "verkada_endpoint_ref",
            "required": True,
            "help": "Pick from the API catalog. The form below adapts to the endpoint you choose.",
        },
        {
            # Composite control: the frontend reads endpoint_id from the
            # sibling config, fetches the OpenAPI schema, and renders
            # per-parameter inputs (name, type, description, required).
            # The control still persists into config.path_params,
            # config.query_params, and config.body — this is just the
            # rendering hook.
            "name": "_request",
            "label": "Request parameters",
            "type": "verkada_request_params",
            "required": False,
            "endpoint_field": "endpoint_id",
        },
    ]
}


_PATH_PARAM_RE = re.compile(r"\{([^}]+)\}")


def _substitute_path(template: str, params: dict[str, Any]) -> str:
    def _replace(m: re.Match[str]) -> str:
        key = m.group(1)
        if key not in params:
            raise ValueError(f"missing path parameter: {key!r}")
        return str(params[key])

    return _PATH_PARAM_RE.sub(_replace, template)


async def run(
    config: dict[str, Any],
    ctx: dict[str, Any],
    connection: Connection,
) -> dict[str, Any]:
    """Execute one Verkada API call step.

    ``ctx`` is the full template context: ``{"trigger": <envelope>, "steps":
    {step_name: {"output": ...}}}``. Templates can pull from anywhere in it.
    """
    endpoint_id_raw = config.get("endpoint_id")
    if not endpoint_id_raw:
        raise ValueError("action config missing required 'endpoint_id'")
    try:
        endpoint_id = UUID(endpoint_id_raw)
    except (ValueError, TypeError) as e:
        raise ValueError(f"endpoint_id must be a UUID, got {endpoint_id_raw!r}") from e

    async with SessionLocal() as session:
        endpoint = (
            await session.execute(
                select(VerkadaApiEndpoint).where(VerkadaApiEndpoint.id == endpoint_id)
            )
        ).scalar_one_or_none()
    if endpoint is None:
        raise ValueError(
            f"endpoint {endpoint_id} not found — was the catalog crawled?"
        )
    if endpoint.deleted_at is not None:
        raise ValueError(
            f"endpoint {endpoint.method} {endpoint.path} was removed from Verkada's API"
        )

    secret = decrypt_secret(connection.encrypted_secret)
    api_key = secret.get("api_key")
    if not api_key:
        raise ValueError(
            f"connection {connection.id} has no api_key set — finish setup first"
        )
    region = secret.get("region") or None

    path_params = resolve_deep(config.get("path_params") or {}, ctx) or {}
    query_params = resolve_deep(config.get("query_params") or {}, ctx) or {}
    body = resolve_deep(config.get("body"), ctx)

    if not isinstance(path_params, dict):
        raise ValueError("path_params must be a JSON object")
    if not isinstance(query_params, dict):
        raise ValueError("query_params must be a JSON object")

    try:
        path = _substitute_path(endpoint.path, path_params)
    except ValueError as e:
        raise ValueError(str(e)) from e

    send_body = (
        body if body is not None and endpoint.method.upper() in {"POST", "PUT", "PATCH"} else None
    )

    client = VerkadaClient(api_key=api_key, base_url=region)
    try:
        result = await client.request(
            method=endpoint.method,
            path=path,
            query=query_params or None,
            json_body=send_body,
        )
    except VerkadaApiError as e:
        raise ValueError(str(e)) from e

    if result["status_code"] >= 400:
        raise ValueError(
            f"{endpoint.method} {path} → {result['status_code']}: {result['body']!r}"
        )

    return {
        "action": "verkada_api_call",
        "method": endpoint.method,
        "path": path,
        "request": {"query": query_params or None, "body": send_body},
        "verkada_response": result,
    }
