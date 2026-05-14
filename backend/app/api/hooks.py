import json
import uuid
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.assets import download_pending_for_event, queue_event_assets
from app.connectors.verkada import Envelope, classify
from app.connectors.verkada.signature import verify as verify_verkada
from app.crypto import decrypt_secret, encrypt_secret
from app.db import get_session
from app.engine.triggers import matches as trigger_matches
from app.models import Connection, Flow, Run, WebhookEvent


router = APIRouter(tags=["hooks"])


SENSITIVE_HEADERS = {"authorization", "cookie", "x-api-key", "x-verkada-auth"}

# Sentinel org_ids that look like UUIDs but should never trigger a real
# auto-created Connection — synthetic test traffic, all-zero IDs, etc.
_NULL_UUID = uuid.UUID("00000000-0000-0000-0000-000000000000")


def _is_real_org_id(org_id: str | None) -> bool:
    """True iff ``org_id`` is a proper UUID and not the null sentinel."""
    if not org_id:
        return False
    try:
        parsed = uuid.UUID(org_id)
    except (ValueError, TypeError):
        return False
    return parsed != _NULL_UUID


def _safe_headers(request: Request) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in request.headers.items():
        out[k] = "***redacted***" if k.lower() in SENSITIVE_HEADERS else v
    return out


def _classify_payload(body_json: Any) -> tuple[str, str | None, str | None, str | None]:
    """Returns (family, webhook_type, notification_type, org_id).

    family is always set — falls through to "unknown" for non-envelope bodies
    so the inbox UI can surface them.
    """
    if not isinstance(body_json, dict):
        return ("unknown", None, None, None)
    try:
        env = Envelope.model_validate(body_json)
    except ValidationError:
        return (
            "unknown",
            body_json.get("webhook_type") if isinstance(body_json.get("webhook_type"), str) else None,
            None,
            body_json.get("org_id") if isinstance(body_json.get("org_id"), str) else None,
        )
    family = classify(env)
    nt = env.data.get("notification_type") if isinstance(env.data, dict) else None
    if not isinstance(nt, str):
        nt = None
    return (family, env.webhook_type, nt, env.org_id)


async def _get_or_autocreate_connection(
    session: AsyncSession, family: str, org_id: str | None
) -> Connection | None:
    """Find the Verkada connection for this org_id, or auto-create a stub.

    Auto-create only fires when the webhook is a recognized Verkada envelope
    (family != "unknown"), so junk traffic doesn't spawn empty connections.
    The stub has an empty secret and setup_complete=False; the user finishes
    setup by supplying an api_key through the UI.
    """
    if not org_id:
        return None
    # Refuse to spawn a stub Connection for synthetic / malformed org_ids
    # (random test strings, all-zero UUIDs). Without this, README curl
    # examples and stray junk would pollute the Connections page on first
    # install. The onboarding flow depends on "first real Connection" as
    # the signal that a real Verkada webhook has arrived.
    if not _is_real_org_id(org_id):
        return None
    result = await session.execute(
        select(Connection).where(
            Connection.type == "verkada", Connection.external_id == org_id
        )
    )
    conn = result.scalar_one_or_none()
    if conn is not None:
        return conn
    if family == "unknown":
        return None
    conn = Connection(
        type="verkada",
        name=f"Verkada org {org_id[:8]}",
        external_id=org_id,
        encrypted_secret=encrypt_secret({}),
        setup_complete=False,
    )
    session.add(conn)
    await session.flush()  # populate conn.id before commit at end of request
    return conn


async def _maybe_verify(
    conn: Connection | None, header: str | None, body: bytes
) -> str | None:
    """Return signature_status, or None if there's no org to associate with."""
    if conn is None:
        return None
    try:
        secret_blob = decrypt_secret(conn.encrypted_secret)
    except Exception:
        return "unverified"
    signing_secret = secret_blob.get("webhook_signing_secret")
    if not signing_secret:
        return "unverified"
    return verify_verkada(signing_secret, header, body)


async def _record(
    request: Request,
    slug: str,
    session: AsyncSession,
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    raw = await request.body()
    body_text: str | None = None
    body_json: Any = None
    if raw:
        try:
            body_text = raw.decode("utf-8")
        except UnicodeDecodeError:
            body_text = f"<binary {len(raw)} bytes>"
        if body_text and not body_text.startswith("<binary"):
            try:
                body_json = json.loads(body_text)
            except json.JSONDecodeError:
                body_json = None

    family, webhook_type, notification_type, org_id = _classify_payload(body_json)

    conn = await _get_or_autocreate_connection(session, family, org_id)
    sig_header = request.headers.get("verkada-signature")
    signature_status = await _maybe_verify(conn, sig_header, raw)

    event = WebhookEvent(
        slug=slug,
        method=request.method,
        path=str(request.url.path),
        query_string=str(request.url.query or ""),
        headers=_safe_headers(request),
        body_json=body_json if isinstance(body_json, (dict, list)) else None,
        body_text=body_text,
        body_size=len(raw),
        remote_addr=request.client.host if request.client else None,
        family=family,
        webhook_type=webhook_type,
        notification_type=notification_type,
        org_id=org_id,
        signature_status=signature_status,
    )
    session.add(event)
    await session.flush()  # need event.id before enqueuing runs

    triggered = await _enqueue_matching_flows(
        request, session, event, body_json, family, notification_type
    )

    # Record any image / vehicle_image URLs so we can grab them before
    # their signed tokens expire. The actual download fires after the
    # response goes out.
    if isinstance(body_json, dict):
        await queue_event_assets(session, event.id, body_json)
        background_tasks.add_task(download_pending_for_event, event.id)

    await session.commit()
    return {
        "ok": True,
        "id": str(event.id),
        "family": family,
        "signature_status": signature_status,
        "triggered_flows": triggered,
    }


async def _enqueue_matching_flows(
    request: Request,
    session: AsyncSession,
    event: WebhookEvent,
    body_json: Any,
    family: str,
    notification_type: str | None,
) -> int:
    """Find enabled verkada_webhook flows whose trigger matches and enqueue runs.

    Only fires for Verkada-shaped payloads; junk traffic gets dropped here.
    """
    if family == "unknown" or not isinstance(body_json, dict):
        return 0

    data = body_json.get("data") if isinstance(body_json.get("data"), dict) else {}
    event_summary = {
        "family": family,
        "notification_type": notification_type,
        "data": data,
    }

    flows_q = await session.execute(
        select(Flow).where(
            Flow.enabled.is_(True), Flow.trigger_type == "verkada_webhook"
        )
    )
    pool = getattr(request.app.state, "arq_pool", None)
    triggered = 0
    for flow in flows_q.scalars().all():
        if not trigger_matches(flow.trigger_config or {}, event_summary):
            continue
        run = Run(
            flow_id=flow.id,
            webhook_event_id=event.id,
            status="pending",
            input=body_json,
        )
        session.add(run)
        await session.flush()
        if pool is not None:
            await pool.enqueue_job("run_flow", str(run.id))
        triggered += 1
    return triggered


@router.api_route(
    "/hooks/{slug:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
)
async def catch_all(
    slug: str,
    request: Request,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await _record(request, slug, session, background_tasks)


@router.api_route("/hooks", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def catch_root(
    request: Request,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await _record(request, "", session, background_tasks)
