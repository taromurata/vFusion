"""Pull historical footage out of Verkada via HLS + ffmpeg.

Ported from a prior internal project's verkada_footage.py. The two
public entry points used by flow actions are:

  - ``get_stream_key(api_key, org_id)`` — short-lived JWT for HLS auth.
    Cached in-process with a small TTL safety margin.
  - ``grab_video_clip(api_key, org_id, camera_id, start_epoch, ...)``
    — shells out to ffmpeg to download a transcoded H.264 MP4 clip
    from a historical window.

Auth tokens (POST /token) are handled by ``VerkadaClient`` directly;
we only need the stream key here.

ffmpeg must be present in PATH (the backend image installs it).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any

import httpx


logger = logging.getLogger(__name__)


STREAM_KEY_TTL_SEC = 500  # Verkada grants 600s; refresh a bit early


class FootageError(RuntimeError):
    pass


# Module-level cache keyed by (api_key, org_id) — refreshed lazily.
_stream_keys: dict[tuple[str, str], tuple[str, float]] = {}


async def get_stream_key(api_key: str, org_id: str, force_refresh: bool = False) -> str:
    """Return a cached HLS stream JWT, refreshing when stale."""
    cache_key = (api_key, org_id)
    now = time.time()
    if not force_refresh:
        cached = _stream_keys.get(cache_key)
        if cached and now < cached[1]:
            return cached[0]
    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.get(
            "https://api.verkada.com/cameras/v1/footage/token",
            params={"expiration": 600, "org_id": org_id},
            headers={"accept": "application/json", "x-api-key": api_key},
        )
    if res.status_code >= 400:
        raise FootageError(f"stream-key fetch failed: {res.status_code} {res.text[:200]!r}")
    jwt = res.json().get("jwt")
    if not jwt or not isinstance(jwt, str):
        raise FootageError(f"stream-key response missing 'jwt': {res.text[:200]!r}")
    _stream_keys[cache_key] = (jwt, now + STREAM_KEY_TTL_SEC)
    return jwt


async def grab_video_clip(
    *,
    api_key: str,
    org_id: str,
    camera_id: str,
    start_epoch: int,
    duration_sec: float,
    out_path: Path,
    buffer_sec: float = 0.0,
    timeout_sec: int = 90,
    progress: Any = None,
) -> int:
    """Transcode a short historical MP4 clip to ``out_path``. Returns the
    file size on success; raises ``FootageError`` otherwise.

    Built for downstream Gemini upload — H.264 yuv420p is the broadest
    compatibility codec. Retries once with a fresh stream key on the
    first failure (which usually means an expired JWT).

    If ``progress`` is provided (a StepProgress instance from the worker),
    ffmpeg stderr lines and retry notes are forwarded to it as log messages
    for the run-events panel."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    end_epoch = start_epoch + int(max(2, buffer_sec + duration_sec + 2))

    last_err: str | None = None
    for attempt in (1, 2):
        if progress and attempt == 2:
            await progress.log("ffmpeg retrying with fresh stream key")
        key = await get_stream_key(api_key, org_id, force_refresh=(attempt == 2))
        url = (
            "https://api.verkada.com/stream/cameras/v1/footage/stream/stream.m3u8"
            f"?org_id={org_id}"
            f"&camera_id={camera_id}"
            f"&resolution=high_res"
            f"&jwt={key}"
            f"&type=stream"
            f"&codec=hevc"
            f"&transcode=false"
            f"&start_time={start_epoch}"
            f"&end_time={end_epoch}"
        )
        cmd = [
            "ffmpeg", "-y",
            "-loglevel", "error",
            "-i", url,
            "-ss", str(max(0.0, buffer_sec)),
            "-t", str(duration_sec),
            "-an",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "23",
            "-movflags", "+faststart",
            "-pix_fmt", "yuv420p",
            str(out_path),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            last_err = "ffmpeg timed out"
            continue
        if proc.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
            return out_path.stat().st_size
        last_err = stderr_bytes.decode(errors="replace").strip()[:500] or f"rc={proc.returncode}"
        if progress:
            await progress.log(f"ffmpeg attempt {attempt} failed: {last_err}")
        logger.warning(
            "grab_video_clip attempt %d failed for %s: %s",
            attempt, camera_id, last_err,
        )

    raise FootageError(f"grab_video_clip failed: {last_err}")


CLIP_ROOT = Path(os.environ.get("CLIP_DIR", "/app/data/clips"))
CLIP_RETENTION_HOURS = int(os.environ.get("CLIP_RETENTION_HOURS", "168"))  # 1 week
IMAGE_ROOT = Path(os.environ.get("IMAGE_DIR", "/app/data/images"))
IMAGE_RETENTION_HOURS = int(os.environ.get("IMAGE_RETENTION_HOURS", "168"))


async def grab_still_frame(
    *,
    api_key: str,
    org_id: str,
    camera_id: str,
    out_path: Path,
    timeout_sec: int = 45,
    progress: Any = None,
) -> int:
    """Pull a single live frame from the camera's HLS stream as a JPEG.

    Same HLS endpoint as ``grab_video_clip`` (footage stream view) but with
    no start/end window — the URL serves the live segment list and ffmpeg's
    ``-frames:v 1`` grabs the first frame it decodes. Returns file size on
    success or raises ``FootageError``.

    Retries once with a fresh stream key on the first failure (matches
    grab_video_clip semantics — usually an expired JWT)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)

    last_err: str | None = None
    for attempt in (1, 2):
        if progress and attempt == 2:
            await progress.log("ffmpeg retrying with fresh stream key")
        key = await get_stream_key(api_key, org_id, force_refresh=(attempt == 2))
        url = (
            "https://api.verkada.com/stream/cameras/v1/footage/stream/stream.m3u8"
            f"?org_id={org_id}"
            f"&camera_id={camera_id}"
            f"&resolution=high_res"
            f"&jwt={key}"
            f"&type=stream"
        )
        cmd = [
            "ffmpeg", "-y",
            "-loglevel", "error",
            "-i", url,
            "-frames:v", "1",
            "-q:v", "2",
            "-f", "image2",
            str(out_path),
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            last_err = "ffmpeg timed out"
            continue
        if proc.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
            return out_path.stat().st_size
        last_err = stderr_bytes.decode(errors="replace").strip()[:500] or f"rc={proc.returncode}"
        if progress:
            await progress.log(f"ffmpeg attempt {attempt} failed: {last_err}")
        logger.warning(
            "grab_still_frame attempt %d failed for %s: %s",
            attempt, camera_id, last_err,
        )

    raise FootageError(f"grab_still_frame failed: {last_err}")


def _cleanup_dir(root: Path, retention_hours: int) -> int:
    if not root.exists():
        return 0
    cutoff = time.time() - retention_hours * 3600
    removed = 0
    for child in root.iterdir():
        if not child.is_file():
            continue
        try:
            if child.stat().st_mtime < cutoff:
                child.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def cleanup_old_clips(
    clip_retention_hours: int | None = None,
    image_retention_hours: int | None = None,
) -> dict[str, int]:
    """Delete clip + image files older than the given retention windows.

    Each window can be ``None`` or ``0`` to skip (= unlimited / never
    delete). Idempotent. Defaults fall back to the env-driven constants
    so legacy code paths keep working.
    """
    if clip_retention_hours is None:
        clip_retention_hours = CLIP_RETENTION_HOURS
    if image_retention_hours is None:
        image_retention_hours = IMAGE_RETENTION_HOURS
    clips = (
        _cleanup_dir(CLIP_ROOT, clip_retention_hours)
        if clip_retention_hours and clip_retention_hours > 0
        else 0
    )
    images = (
        _cleanup_dir(IMAGE_ROOT, image_retention_hours)
        if image_retention_hours and image_retention_hours > 0
        else 0
    )
    if clips or images:
        logger.info("media cleanup: clips=%d images=%d", clips, images)
    return {"removed": clips + images, "clips": clips, "images": images}
