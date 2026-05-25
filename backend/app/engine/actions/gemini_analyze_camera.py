"""Action: motion event → pull MP4 from Verkada → Gemini analysis.

The "easy-mode" pipeline action that mirrors a prior internal project's
end-to-end flow: a single step that takes the Verkada + Gemini connections
plus a camera_id + timestamp, grabs the clip, sends it to Gemini, and
returns the text. Chain a verkada_helix_event step after this and you
have the complete motion → AI → Helix automation in just two nodes.

For more granular control (analyze an arbitrary on-disk clip, grab a
clip without analyzing it), use the standalone verkada_grab_clip and
gemini_analyze_video actions.
"""

import asyncio
import logging
import time
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select

from app.connectors.verkada.footage import CLIP_ROOT, FootageError, grab_video_clip
from app.crypto import decrypt_secret
from app.db import SessionLocal
from app.engine.actions.gemini_analyze_video import (
    _DEFAULT_PROMPT,
    PROMPT_TEMPLATES,
    analyze_clip,
)
from app.engine.templates import resolve_deep
from app.models import Connection
from app.pricing.gemini import cost_for


logger = logging.getLogger(__name__)


# tier buckets the per-token cost so the UI can show a $/$$/$$$ chip
# without users having to know what 2.5 Flash vs 3.1 Pro actually costs.
# preview=True marks the two beta models so the UI can warn that they
# can change behavior, get pulled, or be priced differently without
# notice.
GEMINI_MODELS: list[dict[str, Any]] = [
    {
        "value": "gemini-3.1-flash-lite",
        "label": "Gemini 3.1 Flash Lite",
        "tier": "$",
        "preview": False,
        "tagline": "cheapest, fast — great for simple OCR / yes-no checks",
    },
    {
        "value": "gemini-2.5-flash",
        "label": "Gemini 2.5 Flash",
        "tier": "$",
        "preview": False,
        "tagline": "balanced default — solid quality for most camera prompts",
    },
    {
        "value": "gemini-2.5-pro",
        "label": "Gemini 2.5 Pro",
        "tier": "$$$",
        "preview": False,
        "tagline": "highest-quality stable Pro — best for nuanced / complex prompts",
    },
    {
        "value": "gemini-3-flash-preview",
        "label": "Gemini 3 Flash",
        "tier": "$$",
        "preview": True,
        "tagline": "newer Flash variant, BETA — quality / speed may vary",
    },
    {
        "value": "gemini-3.1-pro-preview",
        "label": "Gemini 3.1 Pro",
        "tier": "$$$",
        "preview": True,
        "tagline": "newest Pro variant, BETA — even pricier than 2.5 Pro",
    },
]

_DEFAULT_MODEL = "gemini-2.5-flash"
_DEFAULT_FALLBACK_CHAIN = "gemini-3.1-flash-lite"


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
            "name": "start_epoch",
            "label": "Start time (unix seconds)",
            "type": "text",
            "required": True,
            "group": "advanced",
            "default_template": "{{ trigger.data.created }}",
            "help": "Auto-fills from {{ trigger.data.created }} when present.",
        },
        {
            "name": "model",
            "label": "Default model",
            "type": "select",
            "required": False,
            "options": GEMINI_MODELS,
            "default": _DEFAULT_MODEL,
            "docs_url": "https://ai.google.dev/gemini-api/docs/models",
            "help": "The first model tried for each request. If it returns 503/429/404, the fallback chain below is used. See Gemini model docs.",
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
            "name": "duration_sec",
            "label": "Clip duration (seconds)",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": "Default 10. Keep short — Gemini charges per second.",
        },
        {
            "name": "pre_grab_delay_sec",
            "label": "Wait before grab (seconds)",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": "Default 0 (grab immediately). Set 45–60 for live webhooks if you want a higher chance of HD footage — Verkada needs ~30–45s to backfill the HD variant on 4K+ cameras. Replays of old events skip this wait automatically.",
        },
        {
            "name": "pre_roll_sec",
            "label": "Pre-roll (seconds)",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": "Default 2. Clip starts this many seconds before start_epoch to capture lead-up motion.",
        },
        {
            "name": "model_chain",
            "label": "Fallback model chain",
            "type": "text",
            "required": False,
            "group": "advanced",
            "help": f"Comma-separated models tried if the default model fails. Default: {_DEFAULT_FALLBACK_CHAIN}",
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
    "action": "gemini_analyze_camera",
    "camera_id": "...",
    "text": "...",
    # Populated when the prompt asks Gemini for JSON. Reference fields
    # like {{ steps.<name>.output.json.animal }} in downstream actions.
    "json": {"example_field": "example_value"},
    "char_count": 199,
    "model_used": "gemini-2.5-pro",
    "clip_path": "/app/data/clips/abc.mp4",
    "duration_sec": 10,
    "file_size": 1234567,
    "started_at_epoch": 1700000000,
}


def _coerce_int(v: Any, default: int) -> int:
    try:
        return int(float(str(v).strip()))
    except (ValueError, TypeError):
        return default


def _coerce_float(v: Any, default: float) -> float:
    try:
        return float(str(v).strip())
    except (ValueError, TypeError):
        return default


async def run(
    config: dict[str, Any],
    ctx: dict[str, Any],
    connection: Connection,
) -> dict[str, Any]:
    """``connection`` is the Verkada connection (resolved via connection_id).
    The Gemini connection is looked up separately from ``gemini_connection_id``."""

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

    # ---- Inputs (template-resolved) ----
    camera_id = resolve_deep(config.get("camera_id"), ctx)
    start_epoch_raw = resolve_deep(config.get("start_epoch"), ctx)
    duration_sec = max(1.0, _coerce_float(resolve_deep(config.get("duration_sec"), ctx), 10.0))
    delay_sec = max(0.0, _coerce_float(resolve_deep(config.get("pre_grab_delay_sec"), ctx), 0.0))
    pre_roll_sec = max(0.0, _coerce_float(resolve_deep(config.get("pre_roll_sec"), ctx), 2.0))

    if not isinstance(camera_id, str) or not camera_id:
        raise ValueError("camera_id is required (string)")
    start_epoch = _coerce_int(start_epoch_raw, 0)
    if start_epoch <= 0:
        raise ValueError(f"start_epoch must be positive unix-seconds, got {start_epoch_raw!r}")
    grab_start_epoch = max(0, start_epoch - int(pre_roll_sec))
    grab_duration = duration_sec + pre_roll_sec

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
    # The default model is tried first; fallback chain runs after, de-duped
    # so the user can't accidentally double-charge.
    model_chain = [default_model] + [m for m in fallback if m != default_model]
    if not model_chain:
        raise ValueError("model chain is empty")

    active_timeout = _coerce_int(resolve_deep(config.get("active_timeout_sec"), ctx), 180)

    progress = ctx.get("_progress")

    # ---- Phase 1: wait for HD backfill ----
    wait_until = start_epoch + int(delay_sec)
    wait_remaining = wait_until - int(time.time())
    if wait_remaining > 0:
        if progress:
            await progress.phase(
                "wait_hd_backfill",
                "running",
                f"sleeping {wait_remaining}s so Verkada can backfill HD footage",
            )
        logger.info("waiting %ds before clip grab", wait_remaining)
        await asyncio.sleep(wait_remaining)
        if progress:
            await progress.phase("wait_hd_backfill", "success")
    elif progress:
        await progress.phase(
            "wait_hd_backfill", "success", "no wait needed (event already aged)"
        )

    # ---- Phase 2: ffmpeg grab ----
    clip_path = CLIP_ROOT / f"{uuid4().hex}.mp4"
    if progress:
        await progress.phase(
            "ffmpeg_grab",
            "running",
            f"pulling {grab_duration:.0f}s clip starting at epoch {grab_start_epoch} → {clip_path.name}",
        )
    grab_started = time.time()
    try:
        size = await grab_video_clip(
            api_key=api_key,
            org_id=org_id,
            camera_id=camera_id,
            start_epoch=grab_start_epoch,
            duration_sec=grab_duration,
            out_path=clip_path,
            progress=progress,
        )
    except FootageError as e:
        if progress:
            await progress.phase("ffmpeg_grab", "failed", str(e))
        raise ValueError(f"grab_video_clip failed: {e}") from e
    if progress:
        await progress.phase(
            "ffmpeg_grab",
            "success",
            f"wrote {size / 1024:.0f} KB in {time.time() - grab_started:.1f}s",
        )

    # ---- Phase 3: Gemini analysis ----
    if progress:
        await progress.phase(
            "gemini_analyze",
            "running",
            f"uploading clip + running prompt against {model_chain[0]}",
        )
    analyze_started = time.time()
    try:
        result = await analyze_clip(
            gemini_api_key, clip_path, prompt, model_chain, active_timeout,
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
        "action": "gemini_analyze_camera",
        "camera_id": camera_id,
        "text": result["text"],
        # Parsed JSON when the response was structured (None otherwise).
        # See ``maybe_parse_json`` in gemini_analyze_video for the rules.
        "json": result.get("json"),
        "char_count": len(result["text"]),
        "model_used": result["model_used"],
        "clip_path": str(clip_path),
        "duration_sec": duration_sec,
        "file_size": size,
        "started_at_epoch": start_epoch,
        "tokens_in": result["tokens_in"],
        "tokens_out": result["tokens_out"],
    }
    if cost:
        out["cost"] = cost
    return out
