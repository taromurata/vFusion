"""Action: upload a local MP4 clip to Gemini and run a text prompt.

Walks an ordered model fallback chain (configurable). Falls back on
503 / 429 / 404 — everything else raises immediately. Deletes the
Gemini-side file after the analysis to avoid quota leakage.

The clip path is normally pulled from a prior ``verkada_grab_clip``
step via ``{{ steps.<grab>.output.clip_path }}``.
"""

import asyncio
import json
import logging
import re
import time
from pathlib import Path
from typing import Any

from app.crypto import decrypt_secret
from app.engine.templates import resolve_deep
from app.models import Connection


logger = logging.getLogger(__name__)


# Matches an opening ```json (or just ```) fence and the closing fence.
# Gemini often returns JSON wrapped in code fences even when asked not
# to — we strip them transparently so prompts can stay loose.
_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def maybe_parse_json(text: str) -> Any | None:
    """Best-effort JSON parse of a Gemini text response.

    Returns the parsed object (dict, list, scalar) when ``text`` is a
    well-formed JSON value, optionally wrapped in a ``` code fence.
    Returns ``None`` for anything that doesn't parse — callers expose
    this alongside the raw text so a flow can pick whichever shape is
    convenient (e.g. ``output.json.animal`` vs ``output.text``).

    This is intentionally untyped because Gemini might be asked to
    return a string ("bear"), an integer (47), or a structured object —
    all are valid and useful.
    """
    if not isinstance(text, str):
        return None
    stripped = text.strip()
    if not stripped:
        return None
    # Peel a ``` ... ``` wrapper if present so prompts asking for "just
    # JSON" still work when the model wraps it anyway.
    m = _FENCE_RE.match(stripped)
    if m:
        stripped = m.group(1).strip()
    # Cheap rejection: JSON values start with one of these chars. Saves
    # a try/except on the common natural-language case.
    if not stripped or stripped[0] not in "{[\"-0123456789tfn":
        return None
    try:
        return json.loads(stripped)
    except (ValueError, TypeError):
        return None


_DEFAULT_MODELS = "gemini-3.1-pro-preview,gemini-2.5-pro,gemini-2.5-flash"
_DEFAULT_PROMPT = (
    "Describe only what is clearly visible in this security camera footage. "
    "If the scene is dark or unclear, describe what you can see including "
    "that it is dark. Do not invent or imagine details that are not visible. "
    "Response must be 190-199 characters."
)


# Picker presets exposed via the field's ``templates`` metadata. All caps
# response length at <200 chars so the result fits in a single Verkada
# Helix attribute (Helix limits attribute values to 200 chars).
PROMPT_TEMPLATES: list[dict[str, str]] = [
    {
        "name": "Security camera description (default)",
        "value": _DEFAULT_PROMPT,
    },
    {
        "name": "Animal detection (outdoor)",
        "value": (
            "Look at this security camera footage and identify any animals you "
            "can clearly see. Say what species, how many, and what they're doing. "
            "If no animals are visible, say 'no animals detected'. Do not invent "
            "details that are not visible. Limit response to 190-199 characters."
        ),
    },
    {
        "name": "OCR — extract visible text",
        "value": (
            "Extract every piece of legible text visible in this footage. "
            "Include sign text, license plates, screens, labels, papers — "
            "anything readable. Return each piece on its own line, no quotes. "
            "Do not invent text; if you cannot clearly read a character, omit "
            "it. If no text is visible, respond with 'no text visible'. Limit "
            "response to 190-199 characters."
        ),
    },
    {
        # Returns structured JSON so a downstream condition + Helix step
        # can branch on issue / severity / reasoning without parsing
        # freeform prose. Tuned to skip legit-but-boring scenes
        # (night IR, empty hallways, privacy masks) so it only fires
        # for real maintenance work.
        "name": "Camera FOV health check (JSON)",
        "value": (
            "You are auditing a security camera frame for image-quality / "
            "mounting issues. Decide whether this camera appears to be doing "
            "its job, OR whether the lens / mounting is impaired in a way a "
            "maintenance technician should investigate.\n\n"
            "Respond with ONLY a JSON object - no prose, no code fence - with "
            "exactly four keys:\n"
            "  \"status\":   \"ok\" if the image looks like a normal working "
            "security camera view; \"issue\" if the camera itself appears "
            "impaired.\n"
            "  \"issue\":    when status is \"issue\", one of: \"obstructed\" "
            "(lens covered), \"blurry\" (severely out of focus), \"mis_aimed\" "
            "(pointed at a wall / ceiling / floor as if knocked), "
            "\"dirty_lens\" (smears, water, fog), \"dark\" (uniformly black/white "
            "in a way IR / exposure can't explain), \"scene_drift\" (view doesn't "
            "look like a security cam should see). Use null when status is \"ok\".\n"
            "  \"severity\": \"low\" / \"medium\" / \"high\". Use null when status "
            "is \"ok\".\n"
            "  \"reasoning\": one-sentence explanation, max 180 characters.\n\n"
            "DO NOT flag legitimate situations:\n"
            "  - A dark scene at night is fine (working IR cameras are dark).\n"
            "  - An empty hallway, parking lot, loading dock, or wall corner is "
            "fine if it appears to be the intended view.\n"
            "  - Slight motion blur, compression artifacts, or wide-angle "
            "distortion in an otherwise normal frame.\n"
            "  - Privacy-masked regions (solid gray / black rectangles in part "
            "of the frame) - those are intentional.\n"
            "  - Glare, sun flare, or backlit scenes if the rest is intelligible.\n\n"
            "DO flag:\n"
            "  - Lens physically covered, sprayed, or fogged so the scene is "
            "unintelligible.\n"
            "  - Camera so out of focus the scene can't be identified.\n"
            "  - Camera knocked out of alignment and now pointing at a wall, "
            "ceiling, or floor.\n"
            "  - Entire frame is a single flat color suggesting covered lens or "
            "broken sensor.\n\n"
            "Examples:\n"
            "  {\"status\": \"issue\", \"issue\": \"obstructed\", \"severity\": "
            "\"high\", \"reasoning\": \"Lens covered by fabric or paper - no "
            "scene visible.\"}\n"
            "  {\"status\": \"issue\", \"issue\": \"mis_aimed\", \"severity\": "
            "\"medium\", \"reasoning\": \"Camera appears to be pointing at a "
            "ceiling tile rather than the corridor.\"}\n"
            "  {\"status\": \"ok\", \"issue\": null, \"severity\": null, "
            "\"reasoning\": \"Normal parking lot view, daytime, clear focus.\"}"
        ),
    },
]


SCHEMA: dict[str, Any] = {
    "fields": [
        {
            "name": "connection_id",
            "label": "Gemini connection",
            "type": "connection_ref",
            "connection_type": "gemini",
            "required": True,
        },
        {
            "name": "clip_path",
            "label": "Clip path",
            "type": "text",
            "required": True,
            "help": 'Usually {{ steps.<grab_clip>.output.clip_path }}.',
        },
        {
            "name": "prompt",
            "label": "Prompt",
            "type": "text",
            "required": False,
            "help": "Pick a template above to populate, then edit. Leave blank to use the default.",
            "templates": PROMPT_TEMPLATES,
        },
        {
            "name": "model_chain",
            "label": "Model fallback chain",
            "type": "text",
            "required": False,
            "help": "Comma-separated. Default: gemini-3.1-pro-preview,gemini-2.5-pro,gemini-2.5-flash",
        },
        {
            "name": "active_timeout_sec",
            "label": "Upload-active timeout (seconds)",
            "type": "text",
            "required": False,
            "help": "How long to wait for Gemini's file state to become ACTIVE. Default 180.",
        },
    ]
}


SAMPLE_OUTPUT: dict[str, Any] = {
    "action": "gemini_analyze_video",
    "text": "...",
    # Populated when the prompt asks Gemini for JSON.
    "json": {"example_field": "example_value"},
    "char_count": 199,
    "model_used": "gemini-2.5-pro",
    "clip_path": "/app/data/clips/abc.mp4",
}


def _is_fallbackable(e: Exception) -> bool:
    status = getattr(e, "code", None) or getattr(e, "status_code", None)
    if status in (503, 429, 404):
        return True
    msg = str(e)
    for needle in ("503", "UNAVAILABLE", "429", "RESOURCE_EXHAUSTED", "404", "NOT_FOUND"):
        if needle in msg:
            return True
    return False


def _coerce_int(v: Any, default: int) -> int:
    try:
        return int(float(str(v).strip()))
    except (ValueError, TypeError):
        return default


async def analyze_clip(
    api_key: str,
    clip_path: Path,
    prompt: str,
    model_chain: list[str],
    active_timeout: int,
    progress: Any = None,
) -> dict[str, Any]:
    """All Gemini SDK calls happen in worker threads — the SDK is sync-only
    and we don't want to block the asyncio loop. Split into upload /
    wait-active / generate so the async wrapper can emit phase events
    between them when ``progress`` is provided.

    ``progress`` is a StepProgress (or None). Phase keys emitted here:
    ``gemini_upload``, ``gemini_wait_active``, ``gemini_generate``.
    """

    def _state_name(f: Any) -> str:
        """Best-effort string name from whatever google-genai returns for
        File.state. Older SDKs return a string; newer ones return an enum.
        We try .name (enum), .value (str-enum), then str() as a last resort."""
        s = getattr(f, "state", None) or getattr(f, "status", None)
        if s is None:
            return ""
        return (
            getattr(s, "name", None)
            or getattr(s, "value", None)
            or str(s)
        ).upper()

    def _upload() -> Any:
        from google import genai

        client = genai.Client(api_key=api_key)
        file_obj = client.files.upload(file=str(clip_path))
        return client, file_obj

    def _wait_active(client: Any, file_obj: Any) -> tuple[Any, int, list[str]]:
        """Poll until ACTIVE. Returns (file, poll_count, observed_states)
        so the caller can log what we saw — critical for diagnosing the
        "Gemini is slow" problem when the bottleneck is actually here."""
        started = time.time()
        polls = 0
        observed: list[str] = []
        while True:
            f = client.files.get(name=file_obj.name)
            polls += 1
            name = _state_name(f)
            if name and name not in observed:
                observed.append(name)
            if name == "ACTIVE":
                return f, polls, observed
            if name in ("FAILED", "DELETED"):
                raise RuntimeError(f"Gemini file {file_obj.name} state={name}")
            if time.time() - started > active_timeout:
                raise TimeoutError(
                    f"Gemini file {file_obj.name} timed out after {polls} polls "
                    f"(states seen: {observed or ['<none>']})"
                )
            # 0.75s — small files become ACTIVE in well under 2s; tighter
            # polling here saves real wall-clock when the SDK is healthy.
            time.sleep(0.75)

    def _generate_one(client: Any, file_obj: Any, model: str) -> Any:
        return client.models.generate_content(
            model=model,
            contents=[file_obj, prompt],
            config={"temperature": 0},
        )

    # ---- Phase: upload ----
    upload_started = time.time()
    if progress:
        await progress.phase(
            "gemini_upload",
            "running",
            f"uploading {clip_path.name} to Gemini",
        )
    client, file_obj = await asyncio.to_thread(_upload)
    upload_secs = time.time() - upload_started
    if progress:
        await progress.phase(
            "gemini_upload",
            "success",
            f"upload accepted as {file_obj.name} in {upload_secs:.1f}s",
        )

    # ---- Phase: wait active ----
    wait_started = time.time()
    if progress:
        await progress.phase(
            "gemini_wait_active",
            "running",
            "polling until file state = ACTIVE (0.75s interval)",
        )
    try:
        file_obj, polls, observed = await asyncio.to_thread(
            _wait_active, client, file_obj
        )
    except Exception as e:  # noqa: BLE001
        if progress:
            await progress.phase("gemini_wait_active", "failed", str(e))
        raise
    wait_secs = time.time() - wait_started
    if progress:
        await progress.phase(
            "gemini_wait_active",
            "success",
            f"ACTIVE after {polls} polls / {wait_secs:.1f}s "
            f"(states seen: {', '.join(observed) or '?'})",
        )

    # ---- Phase: generate (with per-model timing) ----
    generate_started = time.time()
    if progress:
        await progress.phase(
            "gemini_generate",
            "running",
            f"trying {model_chain[0]} (fallback chain has {len(model_chain) - 1} more)",
        )

    used: str | None = None
    last_err: Exception | None = None
    resp = None
    notes: list[str] = []
    try:
        for model in model_chain:
            model_started = time.time()
            try:
                resp = await asyncio.to_thread(
                    _generate_one, client, file_obj, model
                )
                used = model
                if progress:
                    await progress.log(
                        f"{model} returned in {time.time() - model_started:.1f}s"
                    )
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                elapsed = time.time() - model_started
                if _is_fallbackable(e):
                    notes.append(
                        f"{model} → fallback after {elapsed:.1f}s: {e}"
                    )
                    logger.warning(
                        "Gemini %s failed (fallbackable) after %.1fs: %s",
                        model,
                        elapsed,
                        e,
                    )
                    if progress:
                        await progress.log(
                            f"{model} failed in {elapsed:.1f}s, trying next"
                        )
                    continue
                if progress:
                    await progress.phase(
                        "gemini_generate", "failed", f"{model} threw: {e}"
                    )
                raise
        if resp is None or used is None:
            raise last_err if last_err else RuntimeError("no models tried")
    finally:
        # Best-effort cleanup of the uploaded file. Runs even on failure.
        def _cleanup() -> None:
            try:
                client.files.delete(name=file_obj.name)
            except Exception:  # noqa: BLE001
                pass
        await asyncio.to_thread(_cleanup)

    generate_secs = time.time() - generate_started
    if progress:
        for note in notes:
            await progress.log(note)
        if used != model_chain[0]:
            msg = f"used {used} in {generate_secs:.1f}s (fell back from {model_chain[0]})"
        else:
            msg = f"used {used} in {generate_secs:.1f}s"
        await progress.phase("gemini_generate", "success", msg)

    text = (getattr(resp, "text", "") or "").strip()
    # Extract usage_metadata so the caller can attach cost info to the
    # step output. Field names match google-genai 1.x (prompt_token_count
    # / candidates_token_count). Defaults to 0/0 if the SDK ever changes
    # the shape — we'd rather report a wrong-zero cost than crash here.
    usage = getattr(resp, "usage_metadata", None)
    tokens_in = int(getattr(usage, "prompt_token_count", 0) or 0)
    tokens_out = int(getattr(usage, "candidates_token_count", 0) or 0)
    return {
        "text": text,
        # Auto-parse JSON responses so flows can reference structured
        # fields without a separate parsing step. ``None`` when the text
        # isn't valid JSON — templates that don't ask for JSON just
        # ignore this field.
        "json": maybe_parse_json(text),
        "model_used": used,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
    }


async def run(
    config: dict[str, Any],
    ctx: dict[str, Any],
    connection: Connection,
) -> dict[str, Any]:
    secret = decrypt_secret(connection.encrypted_secret)
    api_key = secret.get("api_key")
    if not api_key:
        raise ValueError("Gemini connection has no api_key set")

    clip_path_raw = resolve_deep(config.get("clip_path"), ctx)
    if not isinstance(clip_path_raw, str) or not clip_path_raw.strip():
        raise ValueError("clip_path is required")
    clip_path = Path(clip_path_raw)
    if not clip_path.is_file():
        raise ValueError(f"clip not found on disk: {clip_path}")

    prompt = resolve_deep(config.get("prompt"), ctx) or _DEFAULT_PROMPT
    if not isinstance(prompt, str):
        prompt = str(prompt)

    chain_raw = resolve_deep(config.get("model_chain"), ctx) or _DEFAULT_MODELS
    if not isinstance(chain_raw, str):
        chain_raw = str(chain_raw)
    model_chain = [m.strip() for m in chain_raw.split(",") if m.strip()]
    if not model_chain:
        raise ValueError("model_chain is empty")

    active_timeout = _coerce_int(
        resolve_deep(config.get("active_timeout_sec"), ctx), 180
    )

    result = await analyze_clip(api_key, clip_path, prompt, model_chain, active_timeout)
    return {
        "action": "gemini_analyze_video",
        "text": result["text"],
        "json": result.get("json"),
        "char_count": len(result["text"]),
        "model_used": result["model_used"],
        "clip_path": str(clip_path),
    }
