from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors.verkada.sync import (
    sync_cameras_for_connection,
    sync_doors_for_connection,
    sync_helix_event_types_for_connection,
)
from app.crypto import encrypt_secret, decrypt_secret
from app.db import get_session
from app.models import Connection, VerkadaCamera, VerkadaDoor, VerkadaHelixEventType
from sqlalchemy import func


router = APIRouter(prefix="/api/connections", tags=["connections"])


# ---- Type registry ---------------------------------------------------------
#
# Each connection type declares which fields the UI should render. The
# `secret` flag marks fields that should be rendered as a password input and
# never returned in API responses. `external_id_field` names the field
# whose value gets stored on the non-secret `external_id` column so we can
# look up the connection from incoming webhook payloads without decrypting
# anything. `required_for_setup` is the minimum field that must be present
# for the connection to be considered "set up" (e.g. api_key for Verkada).

CONNECTION_TYPES: dict[str, dict[str, Any]] = {
    "gemini": {
        "label": "Google Gemini",
        "description": "Gemini API key for video / image analysis actions.",
        "required_for_setup": "api_key",
        "fields": [
            {"name": "api_key", "label": "Gemini API key", "type": "secret", "required": True, "help": "From https://aistudio.google.com/apikey — used by the Gemini video analysis action."},
        ],
    },
    "verkada": {
        "label": "Verkada Org",
        "description": "API key + optional webhook signing secret for one Verkada org.",
        "external_id_field": "org_id",
        "required_for_setup": "api_key",
        "fields": [
            {"name": "org_id", "label": "Verkada Org ID", "type": "text", "required": True, "help": "UUID, e.g. fe46589d-cb2a-4bee-… Auto-filled when vSplice detects a new org from an incoming webhook."},
            {"name": "api_key", "label": "API key", "type": "secret", "required": True, "help": "Needed for action nodes (door unlock, etc.). The one thing you actually have to provide to get up and running."},
            {"name": "webhook_signing_secret", "label": "Webhook signing secret", "type": "secret", "required": False, "help": "Optional. Provide to enable HMAC verification of inbound webhooks. Get it from Verkada Command → Webhooks."},
            {"name": "region", "label": "API region", "type": "text", "required": False, "help": "e.g. api.verkada.com (leave blank for default)"},
        ],
    }
}


class ConnectionOut(BaseModel):
    id: UUID
    type: str
    name: str
    external_id: str | None
    setup_complete: bool
    cameras_last_synced_at: datetime | None = None
    camera_count: int = 0
    doors_last_synced_at: datetime | None = None
    door_count: int = 0
    helix_events_last_synced_at: datetime | None = None
    helix_event_count: int = 0
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ConnectionCreate(BaseModel):
    type: str
    name: str
    secret: dict[str, Any] = Field(default_factory=dict)


class ConnectionUpdate(BaseModel):
    name: str | None = None
    secret: dict[str, Any] | None = None


@router.get("/types")
async def list_types() -> dict[str, dict[str, Any]]:
    """Field metadata for each connection type — drives dynamic forms in the UI."""
    return CONNECTION_TYPES


async def _build_out(session: AsyncSession, conn: Connection) -> ConnectionOut:
    cam_count = (
        await session.execute(
            select(func.count())
            .select_from(VerkadaCamera)
            .where(VerkadaCamera.connection_id == conn.id)
        )
    ).scalar_one()
    door_count = (
        await session.execute(
            select(func.count())
            .select_from(VerkadaDoor)
            .where(VerkadaDoor.connection_id == conn.id)
        )
    ).scalar_one()
    helix_count = (
        await session.execute(
            select(func.count())
            .select_from(VerkadaHelixEventType)
            .where(VerkadaHelixEventType.connection_id == conn.id)
        )
    ).scalar_one()
    out = ConnectionOut.model_validate(conn)
    out.camera_count = cam_count
    out.door_count = door_count
    out.helix_event_count = helix_count
    return out


@router.get("", response_model=list[ConnectionOut])
async def list_connections(
    session: AsyncSession = Depends(get_session),
) -> list[ConnectionOut]:
    conns = (
        await session.execute(select(Connection).order_by(Connection.created_at.desc()))
    ).scalars().all()
    return [await _build_out(session, c) for c in conns]


@router.post("/{conn_id}/sync-cameras")
async def trigger_camera_sync(
    conn_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Run the Verkada camera sync for this connection right now.

    Same operation the daily cron does — exposed for the 'Sync now'
    button in the UI.
    """
    conn = await session.get(Connection, conn_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="not found")
    result = await sync_cameras_for_connection(conn.id)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.post("/{conn_id}/sync-doors")
async def trigger_door_sync(
    conn_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Run the Verkada door sync for this connection right now."""
    conn = await session.get(Connection, conn_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="not found")
    result = await sync_doors_for_connection(conn.id)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


class HelixEventTypeOut(BaseModel):
    id: UUID
    event_type_uid: str
    name: str | None
    event_schema: dict[str, Any] | None

    model_config = {"from_attributes": True}


@router.get("/{conn_id}/helix-event-types", response_model=list[HelixEventTypeOut])
async def list_helix_event_types(
    conn_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> list[HelixEventTypeOut]:
    """Synced Helix event types for this connection. Used by the action
    editor to render a dropdown + structured attributes form keyed by the
    event_schema, so users don't have to paste UUIDs or write attribute
    JSON by hand."""
    conn = await session.get(Connection, conn_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="connection not found")
    rows = (
        await session.execute(
            select(VerkadaHelixEventType)
            .where(VerkadaHelixEventType.connection_id == conn_id)
            .order_by(VerkadaHelixEventType.name.asc())
        )
    ).scalars().all()
    return [HelixEventTypeOut.model_validate(r) for r in rows]


class HelixEventTypeUpsert(BaseModel):
    """Request body for create + update of a Helix event type.

    For create, ``name`` and ``event_schema`` are both required by
    Verkada. For update, both are optional — pass only what changed.
    ``event_schema`` is the attribute→type map, e.g.
    ``{"location": "string", "count": "integer"}``.
    """

    name: str | None = None
    event_schema: dict[str, Any] | None = None


async def _verkada_client_for(conn: Connection) -> "VerkadaClient":
    """Open a VerkadaClient using this connection's stored API key."""
    from app.connectors.verkada.client import VerkadaClient

    secret = decrypt_secret(conn.encrypted_secret)
    api_key = secret.get("api_key")
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="connection has no api_key set — finish setup first",
        )
    region = secret.get("region") or None
    return VerkadaClient(api_key=api_key, base_url=region)


@router.post("/{conn_id}/helix-event-types", response_model=HelixEventTypeOut)
async def create_helix_event_type_endpoint(
    conn_id: UUID,
    body: HelixEventTypeUpsert,
    session: AsyncSession = Depends(get_session),
) -> HelixEventTypeOut:
    """Create a new Helix event type in Verkada Command and re-sync the
    local cache. Both ``name`` and ``event_schema`` are required."""
    from app.connectors.verkada.client import VerkadaApiError

    if not body.name or body.event_schema is None:
        raise HTTPException(
            status_code=400,
            detail="name and event_schema are both required to create an event type",
        )
    conn = await session.get(Connection, conn_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="connection not found")
    client = await _verkada_client_for(conn)
    try:
        await client.create_helix_event_type(body.name, body.event_schema)
    except VerkadaApiError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    # Re-sync so the row appears locally without a separate "Sync" click.
    await sync_helix_event_types_for_connection(conn.id)
    # Find the row we just created. New uid was assigned by Verkada and
    # only landed in the DB during the resync above, so query by name.
    new_row = (
        await session.execute(
            select(VerkadaHelixEventType)
            .where(
                VerkadaHelixEventType.connection_id == conn_id,
                VerkadaHelixEventType.name == body.name,
            )
            .order_by(VerkadaHelixEventType.last_synced_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if new_row is None:
        raise HTTPException(
            status_code=500,
            detail="event type created in Verkada but didn't show up in resync",
        )
    return HelixEventTypeOut.model_validate(new_row)


@router.patch("/{conn_id}/helix-event-types/{event_type_uid}", response_model=HelixEventTypeOut)
async def update_helix_event_type_endpoint(
    conn_id: UUID,
    event_type_uid: str,
    body: HelixEventTypeUpsert,
    session: AsyncSession = Depends(get_session),
) -> HelixEventTypeOut:
    """Update a Helix event type's name and/or schema, then re-sync the
    local cache. Both body fields are optional but at least one must be
    provided."""
    from app.connectors.verkada.client import VerkadaApiError

    if body.name is None and body.event_schema is None:
        raise HTTPException(
            status_code=400,
            detail="provide at least one of name / event_schema to update",
        )
    conn = await session.get(Connection, conn_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="connection not found")
    client = await _verkada_client_for(conn)
    try:
        await client.update_helix_event_type(
            event_type_uid, name=body.name, event_schema=body.event_schema
        )
    except VerkadaApiError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await sync_helix_event_types_for_connection(conn.id)
    updated_row = (
        await session.execute(
            select(VerkadaHelixEventType).where(
                VerkadaHelixEventType.connection_id == conn_id,
                VerkadaHelixEventType.event_type_uid == event_type_uid,
            )
        )
    ).scalar_one_or_none()
    if updated_row is None:
        raise HTTPException(
            status_code=500,
            detail="event type updated in Verkada but didn't show up in resync",
        )
    return HelixEventTypeOut.model_validate(updated_row)


@router.post("/{conn_id}/sync-helix")
async def trigger_helix_sync(
    conn_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Pull all Helix video-tagging event types from Verkada and persist
    them so the action editor can offer a dropdown of real event_type_uids."""
    conn = await session.get(Connection, conn_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="not found")
    result = await sync_helix_event_types_for_connection(conn.id)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


def _spec(type_: str) -> dict[str, Any]:
    spec = CONNECTION_TYPES.get(type_)
    if spec is None:
        raise HTTPException(status_code=400, detail=f"unknown connection type: {type_}")
    return spec


def _is_setup_complete(type_: str, secret: dict[str, Any]) -> bool:
    """A connection is 'set up' once the type's required_for_setup field is filled."""
    required = _spec(type_).get("required_for_setup")
    if not required:
        return True
    return bool(secret.get(required))


def _validate_required_fields(type_: str, secret: dict[str, Any]) -> None:
    """Reject if any field marked required=True is missing.

    Called for explicit POST/PUT — not for the auto-create path, which
    intentionally writes an empty secret.
    """
    spec = _spec(type_)
    for field in spec["fields"]:
        if field["required"] and not secret.get(field["name"]):
            raise HTTPException(
                status_code=400,
                detail=f"missing required field: {field['name']}",
            )


def _external_id_for(type_: str, secret: dict[str, Any]) -> str | None:
    ext_field = _spec(type_).get("external_id_field")
    if not ext_field:
        return None
    val = secret.get(ext_field)
    return val if isinstance(val, str) and val else None


@router.post("", response_model=ConnectionOut)
async def create_connection(
    payload: ConnectionCreate, session: AsyncSession = Depends(get_session)
) -> ConnectionOut:
    _validate_required_fields(payload.type, payload.secret)
    conn = Connection(
        type=payload.type,
        name=payload.name,
        external_id=_external_id_for(payload.type, payload.secret),
        encrypted_secret=encrypt_secret(payload.secret),
        setup_complete=_is_setup_complete(payload.type, payload.secret),
    )
    session.add(conn)
    await session.commit()
    await session.refresh(conn)
    return await _build_out(session, conn)


@router.put("/{conn_id}", response_model=ConnectionOut)
async def update_connection(
    conn_id: UUID,
    payload: ConnectionUpdate,
    session: AsyncSession = Depends(get_session),
) -> ConnectionOut:
    conn = await session.get(Connection, conn_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="not found")
    if payload.name is not None:
        conn.name = payload.name
    if payload.secret is not None:
        # Merge: keep existing fields the user didn't re-submit (e.g. don't wipe
        # webhook_signing_secret just because the finish-setup form omitted it).
        try:
            existing = decrypt_secret(conn.encrypted_secret) if conn.encrypted_secret else {}
        except Exception:
            existing = {}
        merged = {**existing, **payload.secret}
        # Drop keys whose new value is an empty string — let the user clear a field.
        merged = {k: v for k, v in merged.items() if v not in ("", None)}
        conn.encrypted_secret = encrypt_secret(merged)
        # Refresh derived state.
        ext = _external_id_for(conn.type, merged)
        if ext:
            conn.external_id = ext
        conn.setup_complete = _is_setup_complete(conn.type, merged)
    await session.commit()
    await session.refresh(conn)
    return await _build_out(session, conn)


@router.delete("/{conn_id}")
async def delete_connection(
    conn_id: UUID, session: AsyncSession = Depends(get_session)
) -> dict[str, bool]:
    conn = await session.get(Connection, conn_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="not found")
    await session.delete(conn)
    await session.commit()
    return {"ok": True}
