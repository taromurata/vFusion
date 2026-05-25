"""Action: grab a single live frame from a Verkada camera → Gemini.

Sibling of ``gemini_analyze_camera`` but for still-image analysis: no
historical window, no clip duration, no pre-roll. ffmpeg pulls one frame
off the live HLS stream and we hand the JPEG to Gemini.

Uses the same footage stream endpoint (``/cameras/v1/footage/stream/stream.m3u8``,
docs: https://apidocs.verkada.com/reference/getfootagestreamviewv1) as the
clip-grab action — just without start_time/end_time so the URL serves the
live edge of the stream. ``ffmpeg -frames:v 1`` grabs the first frame.
"""

import logging
import time
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select

from app.connectors.verkada.footage import FootageError, IMAGE_ROOT, grab_still_frame
from app.crypto import decrypt_secret
from app.db import SessionLocal
from app.engine.actions.gemini_analyze_camera import (
    GEMINI_MODELS,
    _DEFAULT_FALLBACK_CHAIN,
    _DEFAULT_MODEL,
)
from app.engine.actions.gemini_analyze_video import (
    _DEFAULT_PROMPT,
    PROMPT_TEMPLATES,
    analyze_clip,
)
from app.engine.templates import resolve_deep
from app.models import Connection
from app.pricing.gemini import cost_for


logger = logging.getLogger(__name__)


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
            "name": "gemini_connection_id",
            "label": "Gemini connection",
            "type": "connection_ref",
            "connection_type": "gemini",
            "required": True,
        },
        {
            "name": "camera_id",
            "label": "Camera",
            "type": "camera_ref",
            "required": True,
            "help": "Pick from synced cameras (for schedule-triggered flows) or paste a UUID / {{ trigger.data.camera_id }} template ref for webhook-triggered flows.",
        },
        {
            "name": "model",
            "label": "Default model",
            "type": "select",
            "required": False,
            "options": GEMINI_MODELS,
            "default": _DEFAULT_MODEL,
            "docs_url": "https://ai.google.dev/gemini-api/docs/models",
            "help": "The first model tried for each request. If it returns 503/429/404, the fallback chain below is used.",
        },
        {
            "name": "prompt",
            "label": "Prompt",
            "type": "text",
            "required": False,
            "help": "Pick a template to insert, then edit. Leave blank for the security-camera default.",
            "templates": PROMPT_TEMPLATES,
        },
        {
            "name": "model_chain",
            "label": "Fallback model chain",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": f"Comma-separated models tried if the default fails. Default: {_DEFAULT_FALLBACK_CHAIN}",
        },
        {
            "name": "active_timeout_sec",
            "label": "Upload-active timeout (seconds)",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": "How long to wait for Gemini's file state to become ACTIVE. Default 180.",
        },
    ]
}


SAMPLE_OUTPUT: dict[str, Any] = {
    "action": "gemini_analyze_still_image",
    "camera_id": "...",
    "text": "...",
    # Populated when the prompt asks Gemini for JSON. Reference fields
    # like {{ steps.<name>.output.json.stock_pct }} in downstream actions.
    "json": {"example_field": "example_value"},
    "char_count": 199,
    "model_used": "gemini-3-flash-preview",
    "image_path": "/app/data/images/abc.jpg",
    "file_size": 234567,
    "captured_at_epoch": 1700000000,
}


def _coerce_int(v: Any, default: int) -> int:
    try:
        return int(float(str(v).strip()))
    except (ValueError, TypeError):
        return default


async def run(
    config: dict[str, Any],
    ctx: dict[str, Any],
    connection: Connection,
) -> dict[str, Any]:
    """``connection`` is the Verkada connection. Gemini connection is looked
    up from ``gemini_connection_id`` (same pattern as gemini_analyze_camera)."""

    # ---- Verkada side ----
    secret = decrypt_secret(connection.encrypted_secret)
    api_key = secret.get("api_key")
    org_id = secret.get("org_id") or connection.external_id
    if not api_key:
        raise ValueError("Verkada connection has no api_key set")
    if not org_id:
        raise ValueError("Verkada connection has no org_id")

    # ---- Gemini side ----
    gemini_conn_id_raw = config.get("gemini_connection_id")
    if not gemini_conn_id_raw:
        raise ValueError("gemini_connection_id is required")
    try:
        gemini_conn_id = UUID(str(gemini_conn_id_raw))
    except (ValueError, TypeError) as e:
        raise ValueError(f"gemini_connection_id must be a UUID: {gemini_conn_id_raw!r}") from e

    async with SessionLocal() as session:
        gemini_conn = (
            await session.execute(
                select(Connection).where(Connection.id == gemini_conn_id)
            )
        ).scalar_one_or_none()
    if gemini_conn is None or gemini_conn.type != "gemini":
        raise ValueError("Gemini connection not found")
    gemini_secret = decrypt_secret(gemini_conn.encrypted_secret)
    gemini_api_key = gemini_secret.get("api_key")
    if not gemini_api_key:
        raise ValueError("Gemini connection has no api_key set")

    # ---- Inputs ----
    camera_id = resolve_deep(config.get("camera_id"), ctx)
    if not isinstance(camera_id, str) or not camera_id:
        raise ValueError("camera_id is required (string)")

    prompt = resolve_deep(config.get("prompt"), ctx) or _DEFAULT_PROMPT
    if not isinstance(prompt, str):
        prompt = str(prompt)

    default_model = resolve_deep(config.get("model"), ctx) or _DEFAULT_MODEL
    if not isinstance(default_model, str):
        default_model = str(default_model)
    chain_raw = resolve_deep(config.get("model_chain"), ctx) or _DEFAULT_FALLBACK_CHAIN
    if not isinstance(chain_raw, str):
        chain_raw = str(chain_raw)
    fallback = [m.strip() for m in chain_raw.split(",") if m.strip()]
    model_chain = [default_model] + [m for m in fallback if m != default_model]
    if not model_chain:
        raise ValueError("model chain is empty")

    active_timeout = _coerce_int(resolve_deep(config.get("active_timeout_sec"), ctx), 180)

    progress = ctx.get("_progress")

    # ---- Phase 1: ffmpeg grab one live frame ----
    image_path = IMAGE_ROOT / f"{uuid4().hex}.jpg"
    captured_at = int(time.time())
    if progress:
        await progress.phase(
            "ffmpeg_grab_frame",
            "running",
            f"pulling one live frame → {image_path.name}",
        )
    grab_started = time.time()
    try:
        size = await grab_still_frame(
            api_key=api_key,
            org_id=org_id,
            camera_id=camera_id,
            out_path=image_path,
            progress=progress,
        )
    except FootageError as e:
        if progress:
            await progress.phase("ffmpeg_grab_frame", "failed", str(e))
        raise ValueError(f"grab_still_frame failed: {e}") from e
    if progress:
        await progress.phase(
            "ffmpeg_grab_frame",
            "success",
            f"wrote {size / 1024:.0f} KB in {time.time() - grab_started:.1f}s",
        )

    # ---- Phase 2: Gemini analysis (same path as the video action) ----
    if progress:
        await progress.phase(
            "gemini_analyze",
            "running",
            f"uploading frame + running prompt against {model_chain[0]}",
        )
    analyze_started = time.time()
    try:
        result = await analyze_clip(
            gemini_api_key, image_path, prompt, model_chain, active_timeout,
            progress=progress,
        )
    except Exception as e:  # noqa: BLE001
        if progress:
            await progress.phase("gemini_analyze", "failed", str(e))
        raise
    cost = await cost_for(
        result["model_used"], result["tokens_in"], result["tokens_out"]
    )
    if progress:
        cost_msg = f", ~${cost['cost_usd']:.4f}" if cost else ""
        await progress.phase(
            "gemini_analyze",
            "success",
            f"got {len(result['text'])} chars from {result['model_used']} "
            f"in {time.time() - analyze_started:.1f}s "
            f"({result['tokens_in']}/{result['tokens_out']} tok{cost_msg})",
        )

    out: dict[str, Any] = {
        "action": "gemini_analyze_still_image",
        "camera_id": camera_id,
        "text": result["text"],
        # Parsed JSON when the response was structured (None otherwise).
        # See ``maybe_parse_json`` in gemini_analyze_video for the rules.
        "json": result.get("json"),
        "char_count": len(result["text"]),
        "model_used": result["model_used"],
        "image_path": str(image_path),
        "file_size": size,
        "captured_at_epoch": captured_at,
        "tokens_in": result["tokens_in"],
        "tokens_out": result["tokens_out"],
    }
    if cost:
        out["cost"] = cost
    return out
