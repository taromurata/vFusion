"""Brew-Your-Own-Analytics — a one-shot test runner.

Lets the user wire up a camera + prompt + Gemini model directly without
building a Flow. Reuses the same Run/RunEvent/step infrastructure so the
existing Runs page renders the captured clip/image, the per-phase
checklist, and the log stream identically.

The user-facing intent: "let me see if Gemini can answer X from this
camera right now, before I bake it into a real flow."

The ``/dry-run`` endpoint adds a second mode: upload an arbitrary MP4
or image instead of pulling from a camera. Same Gemini analyze, but
the result returns inline (no Run row, no Helix POST). When a paired
prompt template is selected on the frontend we also compute a Helix
preview payload — the exact JSON that *would* have been posted — so
operators can iterate on a prompt + Helix mapping using their own
sample footage before committing to a real flow.
"""

import asyncio
import json as _json
import logging
import tempfile
import time
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.crypto import decrypt_secret
from app.db import get_session
from app.models import Connection, Run, VerkadaHelixEventType


logger = logging.getLogger(__name__)


# Cap covers the size of footage operators actually want to test —
# longer clips off a Verkada camera regularly land in the 50-150 MB
# range, so 50 MB was clipping the common case. Gemini's File API
# accepts up to ~2 GB; the practical bound here is upload time from
# a laptop. 200 MB is ~30s on a typical home connection — slow enough
# that we don't want to allow unbounded but fast enough that real
# clips work without a "trim it first" friction step.
DRY_RUN_MAX_BYTES = 200 * 1024 * 1024  # 200 MB

# Allow common image + video mime types. We don't try to police every
# extension — Gemini will tell us if it can't handle the actual bytes.
DRY_RUN_ALLOWED_MIMES = {
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "image/jpeg",
    "image/png",
    "image/webp",
}


router = APIRouter(prefix="/api/byoa", tags=["byoa"])


class ByoaRunRequest(BaseModel):
    connection_id: UUID
    gemini_connection_id: UUID
    camera_id: str
    mode: Literal["live", "historical"]
    prompt: str
    model: str | None = None
    # Historical mode only:
    start_epoch: int | None = None
    duration_sec: float | None = None
    pre_roll_sec: float | None = None
    # Optional Helix post-step: when enabled, the worker runs a second
    # step after the analyze that POSTs to Verkada Helix with the AI
    # text in the chosen attribute. event_type_uid is required when
    # post_to_helix is true.
    post_to_helix: bool = False
    helix_event_type_uid: str | None = None
    helix_attribute: str | None = None
    # Paired-prompt multi-field mapping: {"Animal": "{{ output.json.animal }}",
    # "Behavior": "{{ output.json.behavior }}"}. When present, the worker
    # ignores ``helix_attribute`` and posts each field individually. Without
    # this declared on the model, Pydantic strips the field from the body
    # and BYOA quietly stuffs the entire JSON blob into a "Summary"
    # attribute that doesn't exist on the paired event type.
    helix_attribute_mapping: dict[str, str] | None = None


class ByoaRunResponse(BaseModel):
    run_id: UUID


@router.post("/run-once", response_model=ByoaRunResponse)
async def run_once(
    payload: ByoaRunRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> ByoaRunResponse:
    verkada = await session.get(Connection, payload.connection_id)
    if verkada is None or verkada.type != "verkada":
        raise HTTPException(status_code=404, detail="Verkada connection not found")
    gemini = await session.get(Connection, payload.gemini_connection_id)
    if gemini is None or gemini.type != "gemini":
        raise HTTPException(status_code=404, detail="Gemini connection not found")
    if not payload.camera_id.strip():
        raise HTTPException(status_code=400, detail="camera_id is required")
    if not payload.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")
    if payload.mode == "historical" and not payload.start_epoch:
        raise HTTPException(
            status_code=400, detail="start_epoch is required for historical mode"
        )
    if payload.post_to_helix and not payload.helix_event_type_uid:
        raise HTTPException(
            status_code=400,
            detail="helix_event_type_uid is required when post_to_helix is true",
        )

    # Store the BYOA params on the Run as its "input" so the Runs page can
    # show what was requested. flow_id stays null — this is a one-off, not
    # tied to any flow.
    input_blob: dict[str, Any] = {
        "byoa": True,
        "mode": payload.mode,
        "camera_id": payload.camera_id,
        "prompt": payload.prompt,
        "model": payload.model,
        "connection_id": str(payload.connection_id),
        "gemini_connection_id": str(payload.gemini_connection_id),
    }
    if payload.mode == "historical":
        input_blob["start_epoch"] = payload.start_epoch
        input_blob["duration_sec"] = payload.duration_sec or 10
        input_blob["pre_roll_sec"] = payload.pre_roll_sec if payload.pre_roll_sec is not None else 2
    if payload.post_to_helix:
        input_blob["post_to_helix"] = True
        input_blob["helix_event_type_uid"] = payload.helix_event_type_uid
        if payload.helix_attribute_mapping:
            # Paired prompt — let the worker post each field separately.
            # Don't seed a fallback ``helix_attribute`` here; the worker
            # prefers the mapping when present and the legacy single-field
            # path would just be dead weight in the input blob.
            input_blob["helix_attribute_mapping"] = payload.helix_attribute_mapping
        else:
            input_blob["helix_attribute"] = payload.helix_attribute or "Summary"
    run = Run(
        flow_id=None,
        webhook_event_id=None,
        status="pending",
        input=input_blob,
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)

    pool = getattr(request.app.state, "arq_pool", None)
    if pool is None:
        raise HTTPException(status_code=503, detail="worker queue unavailable")
    await pool.enqueue_job("run_byoa", str(run.id))
    return ByoaRunResponse(run_id=run.id)


# ─────────────────────────── /dry-run ───────────────────────────


def _maybe_parse_json(text: str) -> Any:
    """Same fence-tolerant JSON parser the analyze action uses.

    Inlined (rather than imported) so the dry-run endpoint has no
    import-time dependency on the gemini_analyze_video module, which
    pulls google-genai at top level.
    """
    if not isinstance(text, str):
        return None
    stripped = text.strip()
    if not stripped:
        return None
    # Strip ``` or ```json fences if present.
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else stripped[3:]
        if stripped.endswith("```"):
            stripped = stripped[: -3].rstrip()
    if not stripped or stripped[0] not in "{[\"-0123456789tfn":
        return None
    try:
        return _json.loads(stripped)
    except (ValueError, TypeError):
        return None


def _analyze_with_gemini_sync(
    *, api_key: str, model: str, prompt: str, path: Path,
) -> dict[str, Any]:
    """Upload + poll + generate + cleanup. Returns {text, json, model_used,
    upload_secs, generate_secs}.

    Synchronous; called from the endpoint via ``asyncio.to_thread`` so
    the genai SDK's blocking calls don't park the event loop. Mirrors
    the upload pattern in gemini_analyze_video.run() but stripped down
    (no fallback chain, no run-event logging) — the dry-run path is
    user-driven and a single attempt with a clear error is the right
    UX.
    """
    from google import genai

    client = genai.Client(api_key=api_key)

    upload_started = time.time()
    file_obj = client.files.upload(file=str(path))
    # Poll until ACTIVE — small files become ACTIVE within a second
    # or two; cap at ~45s so we don't hang the request indefinitely
    # if Gemini's intake is slow.
    deadline = time.time() + 45.0
    while True:
        f = client.files.get(name=file_obj.name)
        state = getattr(f, "state", None) or getattr(f, "status", None)
        name = (
            getattr(state, "name", None)
            or getattr(state, "value", None)
            or str(state)
        ).upper() if state is not None else ""
        if name == "ACTIVE":
            file_obj = f
            break
        if name in ("FAILED", "DELETED"):
            raise RuntimeError(f"Gemini file state={name}")
        if time.time() > deadline:
            raise TimeoutError(f"Gemini file didn't become ACTIVE in time (last state: {name or '<none>'})")
        time.sleep(0.75)
    upload_secs = time.time() - upload_started

    gen_started = time.time()
    try:
        res = client.models.generate_content(
            model=model,
            contents=[file_obj, prompt],
            config={"temperature": 0},
        )
    finally:
        # Best-effort cleanup — quota leakage matters more here than
        # surfacing a deletion error. The endpoint already has the
        # generation result by this point.
        try:
            client.files.delete(name=file_obj.name)
        except Exception:
            logger.warning("dry-run: failed to delete gemini file %s", file_obj.name)
    gen_secs = time.time() - gen_started

    # google-genai exposes .text on the response; fall back to walking
    # candidates if a future SDK version reshuffles. We surface both
    # the raw text and the parsed JSON (when applicable) — same shape
    # the camera-mode worker produces, so the frontend can render
    # either uniformly.
    text: str = getattr(res, "text", None) or ""
    if not text:
        try:
            text = res.candidates[0].content.parts[0].text or ""  # type: ignore[index]
        except (AttributeError, IndexError, TypeError):
            text = ""

    return {
        "text": text,
        "json": _maybe_parse_json(text),
        "model_used": model,
        "upload_secs": round(upload_secs, 2),
        "generate_secs": round(gen_secs, 2),
    }


async def _compute_helix_preview(
    session: AsyncSession,
    *,
    connection_id: UUID,
    event_type_uid: str,
    gemini_json: Any,
    gemini_text: str,
    helix_attribute_mapping: dict[str, str] | None,
    helix_attribute: str | None,
    camera_id: str | None,
    inline_schema: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build the JSON payload that would have been POSTed to Helix.

    Replicates worker.py's BYOA auto-fan-out logic so the preview the
    operator sees in upload mode exactly matches what real flow runs
    would send:

      1. If ``helix_attribute_mapping`` is present, resolve each
         ``{{ output.xxx }}`` template against the Gemini result.
      2. Else if ``gemini_json`` is a dict and the chosen Helix type's
         schema has matching field names (case-insensitive), fan out
         each matching field. Same path the worker uses when an
         operator picks a paired prompt without an explicit mapping.
      3. Else fall back to a single ``Summary`` (or ``helix_attribute``)
         attribute containing the raw text.

    The returned ``attributes`` are *previewed values only* — Helix's
    type coercion (string vs float vs integer) is applied at POST time
    in the real flow; we don't run it here because the dry-run isn't
    posting anything and showing the user the pre-coerce values keeps
    the preview transparent.
    """
    # Pull the event type's schema (field names → declared types) so
    # the auto-fan-out path knows which attributes the type accepts.
    row = (
        await session.execute(
            select(VerkadaHelixEventType).where(
                VerkadaHelixEventType.connection_id == connection_id,
                VerkadaHelixEventType.event_type_uid == event_type_uid,
            )
        )
    ).scalar_one_or_none()
    schema: dict[str, str] = {}
    if row and isinstance(row.event_schema, dict):
        schema = {str(k): str(v) for k, v in row.event_schema.items()}
    elif inline_schema:
        # The frontend ships the template's embedded schema so we can
        # render a useful preview even when the operator hasn't yet
        # clicked "Create in Verkada" on the paired event type. Without
        # this fallback, picking a paired template + uploading a clip
        # gives a confusing empty Helix preview.
        schema = {str(k): str(v) for k, v in inline_schema.items()}

    attributes: dict[str, Any] = {}

    if isinstance(helix_attribute_mapping, dict) and helix_attribute_mapping:
        # The mapping uses ``{{ output.x }}`` shorthand exactly like
        # the camera-mode worker. Resolve it against the gemini result
        # so the preview reflects the same values a real run would
        # send. We support the most common refs (output.text,
        # output.json.<key>) without spinning up the full template
        # resolver — the worker's resolver also accepts more exotic
        # paths but the picker UI only emits these.
        for k, v in helix_attribute_mapping.items():
            if isinstance(v, str):
                attributes[k] = _resolve_output_ref(v, gemini_json, gemini_text)
            else:
                attributes[k] = v
    elif isinstance(gemini_json, dict) and schema:
        # Auto-fan-out: case-insensitive match between JSON keys and
        # schema fields, same as worker.py.
        json_index = {str(k).lower(): k for k in gemini_json.keys()}
        for schema_field in schema.keys():
            jk = json_index.get(schema_field.lower())
            if jk is not None:
                val = gemini_json[jk]
                attributes[schema_field] = (
                    val if isinstance(val, (str, int, float, bool)) else str(val)
                )
        if not attributes:
            attributes = {(helix_attribute or "Summary"): gemini_text}
    else:
        attributes = {(helix_attribute or "Summary"): gemini_text}

    return {
        "event_type_uid": event_type_uid,
        # The dry-run isn't tied to a real camera/timestamp; we surface
        # placeholders so the preview reads like the eventual payload.
        # Real flow runs supply these from the trigger / camera_ref.
        "camera_id": camera_id or "<would be filled from trigger.data.camera_id>",
        "time_ms": int(time.time() * 1000),
        "attributes": attributes,
        # Pass-through metadata the UI uses for the "Pre-coerced — Helix
        # may downcast" disclaimer.
        "event_schema": schema,
        "dry_run": True,
    }


def _resolve_output_ref(template: str, gemini_json: Any, gemini_text: str) -> Any:
    """Resolve ``{{ output.text }}`` and ``{{ output.json.<path> }}`` refs
    against the dry-run Gemini result. Returns the original string when
    nothing matches so the operator can see *which* template didn't
    resolve in the preview.
    """
    s = template.strip()
    if not (s.startswith("{{") and s.endswith("}}")):
        return template  # literal — pass through unchanged
    inner = s[2:-2].strip()
    if inner == "output.text":
        return gemini_text
    if inner.startswith("output.json"):
        rest = inner[len("output.json"):].lstrip(".")
        cur: Any = gemini_json
        for part in (rest.split(".") if rest else []):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                return template
        return cur
    return template


class DryRunGeminiResult(BaseModel):
    text: str
    json: Any = None
    model_used: str
    upload_secs: float
    generate_secs: float


class DryRunHelixPreview(BaseModel):
    event_type_uid: str
    camera_id: str
    time_ms: int
    attributes: dict[str, Any]
    # ``event_schema`` (not ``schema``) — Pydantic v2 reserves ``schema``
    # as a deprecated BaseModel class method, and a field of that name
    # produces a noisy UserWarning at startup.
    event_schema: dict[str, str]
    dry_run: bool = True


class DryRunResponse(BaseModel):
    gemini: DryRunGeminiResult
    helix_preview: DryRunHelixPreview | None = None
    media_kind: Literal["video", "image"]


@router.post("/dry-run", response_model=DryRunResponse)
async def dry_run(
    file: UploadFile = File(...),
    gemini_connection_id: UUID = Form(...),
    prompt: str = Form(...),
    model: str = Form(...),
    # Optional Helix preview wiring — frontend only sends these when a
    # paired prompt template is selected. Without them the response
    # carries ``helix_preview: None`` and the UI just shows the Gemini
    # output.
    connection_id: UUID | None = Form(None),
    helix_event_type_uid: str | None = Form(None),
    # Both helix_attribute_mapping (multi-field paired path) and
    # helix_attribute (single-field legacy path) arrive as JSON-encoded
    # strings because multipart form-data has no native object/array
    # support. Empty strings mean "not provided".
    helix_attribute_mapping_json: str | None = Form(None),
    helix_attribute: str | None = Form(None),
    # Frontend ships the template's embedded schema so the preview
    # renders even when the operator hasn't created the paired Helix
    # event type on their Verkada org yet. JSON-encoded dict.
    helix_event_schema_json: str | None = Form(None),
    session: AsyncSession = Depends(get_session),
) -> DryRunResponse:
    # ---- Validate Gemini connection ----
    gemini = await session.get(Connection, gemini_connection_id)
    if gemini is None or gemini.type != "gemini":
        raise HTTPException(status_code=404, detail="Gemini connection not found")
    try:
        gemini_secret = decrypt_secret(gemini.encrypted_secret)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"could not decrypt gemini secret: {e}")
    api_key = gemini_secret.get("api_key")
    if not api_key:
        raise HTTPException(
            status_code=400, detail="Gemini connection has no api_key set"
        )
    if not prompt.strip():
        raise HTTPException(status_code=400, detail="prompt is required")

    # ---- Validate upload ----
    content_type = (file.content_type or "").lower()
    if content_type and content_type not in DRY_RUN_ALLOWED_MIMES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported media type {content_type!r}. "
                f"Accepts MP4 / MOV / WebM video or JPG / PNG / WebP image."
            ),
        )
    media_kind: Literal["video", "image"] = (
        "video" if content_type.startswith("video/") else "image"
    )

    # ---- Stream to temp file with a hard size cap ----
    suffix = Path(file.filename or "upload").suffix or (
        ".mp4" if media_kind == "video" else ".jpg"
    )
    tmp = Path(tempfile.mkstemp(suffix=suffix, prefix="vfusion-dryrun-")[1])
    try:
        bytes_written = 0
        with tmp.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                bytes_written += len(chunk)
                if bytes_written > DRY_RUN_MAX_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"File exceeds the {DRY_RUN_MAX_BYTES // (1024 * 1024)}MB "
                            "dry-run upload cap. Trim the clip or run it in camera mode."
                        ),
                    )
                out.write(chunk)
        if bytes_written == 0:
            raise HTTPException(status_code=400, detail="Empty upload")

        # ---- Gemini analyze ----
        try:
            gemini_result = await asyncio.to_thread(
                _analyze_with_gemini_sync,
                api_key=api_key,
                model=model.strip(),
                prompt=prompt,
                path=tmp,
            )
        except TimeoutError as e:
            raise HTTPException(status_code=504, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Gemini analyze failed: {e}")
    finally:
        tmp.unlink(missing_ok=True)

    # ---- Optional Helix preview ----
    helix_preview: DryRunHelixPreview | None = None
    if helix_event_type_uid and connection_id is not None:
        verkada = await session.get(Connection, connection_id)
        if verkada is None or verkada.type != "verkada":
            # Don't 4xx — the analysis succeeded, the preview is bonus.
            # Log the mismatch and skip the preview.
            logger.warning(
                "dry-run: connection_id %s isn't a verkada connection; skipping helix preview",
                connection_id,
            )
        else:
            mapping_parsed: dict[str, str] | None = None
            if helix_attribute_mapping_json:
                try:
                    parsed = _json.loads(helix_attribute_mapping_json)
                    if isinstance(parsed, dict):
                        mapping_parsed = {str(k): str(v) for k, v in parsed.items()}
                except (ValueError, TypeError):
                    logger.warning(
                        "dry-run: helix_attribute_mapping_json wasn't valid JSON; ignoring"
                    )
            inline_schema_parsed: dict[str, str] | None = None
            if helix_event_schema_json:
                try:
                    parsed = _json.loads(helix_event_schema_json)
                    if isinstance(parsed, dict):
                        inline_schema_parsed = {str(k): str(v) for k, v in parsed.items()}
                except (ValueError, TypeError):
                    logger.warning(
                        "dry-run: helix_event_schema_json wasn't valid JSON; ignoring"
                    )
            preview = await _compute_helix_preview(
                session,
                connection_id=connection_id,
                event_type_uid=helix_event_type_uid,
                gemini_json=gemini_result["json"],
                gemini_text=gemini_result["text"],
                helix_attribute_mapping=mapping_parsed,
                helix_attribute=helix_attribute,
                camera_id=None,
                inline_schema=inline_schema_parsed,
            )
            helix_preview = DryRunHelixPreview(**preview)

    return DryRunResponse(
        gemini=DryRunGeminiResult(**gemini_result),
        helix_preview=helix_preview,
        media_kind=media_kind,
    )
