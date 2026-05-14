"""Capture short-lived media from webhook payloads to local disk.

Verkada's notification payloads embed signed URLs (``image_url``,
``vehicle_image_url``, etc.) that expire shortly after the webhook fires.
We sniff the body for known URL fields when a webhook lands and fetch
the bytes in the background so the inbox UI can render them later.

Files are stored under ``/app/data/webhook_assets/{asset_id}.{ext}`` and
expired by the hourly cron after ``RETENTION_HOURS``.
"""

from __future__ import annotations

import logging
import mimetypes
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionLocal
from app.models import WebhookAsset


logger = logging.getLogger(__name__)


ASSET_FIELDS: tuple[str, ...] = ("image_url", "vehicle_image_url")
ASSET_ROOT = Path(os.environ.get("ASSET_DIR", "/app/data/webhook_assets"))
RETENTION_HOURS = 24
MAX_BYTES = 50 * 1024 * 1024  # 50MB per asset hard cap


_EXT_BY_TYPE: dict[str, str] = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "video/mp4": ".mp4",
}


# When the upstream server lies about content-type (S3 hands us
# application/octet-stream for JPEGs all the time), peek at the first
# few bytes and figure out the real type ourselves.
_GENERIC_TYPES = {None, "", "application/octet-stream", "binary/octet-stream"}


def _sniff_content_type(head: bytes) -> str | None:
    if len(head) >= 3 and head[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(head) >= 8 and head[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(head) >= 6 and head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if len(head) >= 12 and head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"heic", b"heix", b"mif1", b"msf1", b"hevc"):
            return "image/heic"
        if brand in (b"isom", b"mp41", b"mp42"):
            return "video/mp4"
    return None


def resolved_content_type(stored: str | None, path: Path | None) -> str:
    """Use the stored content-type when meaningful; otherwise sniff the
    file's first 16 bytes. Falls back to ``application/octet-stream`` when
    nothing matches so the response is still streamable."""
    if stored and stored.split(";", 1)[0].strip().lower() not in _GENERIC_TYPES:
        return stored
    if path is not None and path.is_file():
        try:
            with path.open("rb") as f:
                head = f.read(16)
        except OSError:
            head = b""
        sniffed = _sniff_content_type(head)
        if sniffed:
            return sniffed
    return stored or "application/octet-stream"


def _ext_for(content_type: str | None, source_url: str) -> str:
    if content_type:
        ct = content_type.split(";", 1)[0].strip().lower()
        ext = _EXT_BY_TYPE.get(ct)
        if ext:
            return ext
        guessed = mimetypes.guess_extension(ct)
        if guessed:
            return guessed
    # Fall back to the URL's path extension if any.
    path = source_url.split("?", 1)[0]
    if "." in path.rsplit("/", 1)[-1]:
        return "." + path.rsplit(".", 1)[-1].lower()
    return ".bin"


def _collect_urls(body_json: Any) -> list[tuple[str, str]]:
    """Walk the body looking for the known asset fields. Returns a list
    of (field_path, url) tuples."""
    out: list[tuple[str, str]] = []

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, f"{path}.{k}" if path else k)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{path}.{i}")
        elif isinstance(node, str):
            # Only sniff fields whose *name* is one of the known image
            # carriers, to avoid grabbing massive video URLs or other links.
            last_segment = path.rsplit(".", 1)[-1]
            if last_segment in ASSET_FIELDS and node.startswith(("http://", "https://")):
                out.append((path, node))

    walk(body_json, "")
    return out


async def queue_event_assets(
    session: AsyncSession, event_id: UUID, body_json: Any
) -> None:
    """Stage pending WebhookAsset rows on the caller's session.

    Uses the request's transaction so the asset rows commit atomically
    with the parent webhook_event row. Don't commit here — the caller
    (the webhook handler) commits everything once at the end.
    """
    urls = _collect_urls(body_json)
    if not urls:
        return
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(hours=RETENTION_HOURS)
    for field, url in urls:
        session.add(
            WebhookAsset(
                webhook_event_id=event_id,
                source_url=url,
                source_field=field,
                status="pending",
                expires_at=expires_at,
            )
        )


class _TransientError(Exception):
    """404/403 from upstream — Verkada's vehicle-crop images get uploaded
    a few seconds after the webhook fires, so we retry these."""


# Backoff schedule for transient errors. Total wait: 5+15+45 = 65s,
# which comfortably covers the upload lag for any Verkada asset.
_RETRY_DELAYS_SEC = (5, 15, 45)


async def _fetch_to_disk(asset: WebhookAsset) -> tuple[Path, str | None, int, bytes]:
    """Single GET + stream-to-disk attempt. Raises _TransientError on
    404/403, RuntimeError on anything else >=400."""
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        async with client.stream("GET", asset.source_url) as res:
            if res.status_code in (403, 404):
                raise _TransientError(f"upstream {res.status_code}")
            if res.status_code >= 400:
                raise RuntimeError(f"upstream {res.status_code}")
            upstream_ct = res.headers.get("content-type")
            ASSET_ROOT.mkdir(parents=True, exist_ok=True)
            path = ASSET_ROOT / f"{asset.id}{_ext_for(upstream_ct, asset.source_url)}"
            size = 0
            first_bytes = b""
            with path.open("wb") as f:
                async for chunk in res.aiter_bytes(64 * 1024):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise RuntimeError(f"asset exceeds {MAX_BYTES} bytes")
                    if len(first_bytes) < 16:
                        first_bytes += chunk[: 16 - len(first_bytes)]
                    f.write(chunk)
            return path, upstream_ct, size, first_bytes


async def _download_one(asset_id: UUID) -> None:
    import asyncio as _aio

    async with SessionLocal() as session:
        asset = await session.get(WebhookAsset, asset_id)
        if asset is None or asset.status != "pending":
            return
        try:
            attempt = 0
            while True:
                try:
                    path, upstream_ct, size, first_bytes = await _fetch_to_disk(asset)
                    break
                except _TransientError as e:
                    if attempt >= len(_RETRY_DELAYS_SEC):
                        raise RuntimeError(
                            f"{e} after {attempt} retries; asset may never publish"
                        ) from e
                    delay = _RETRY_DELAYS_SEC[attempt]
                    attempt += 1
                    logger.info(
                        "asset %s transient (%s); retrying in %ds [%d/%d]",
                        asset.id, e, delay, attempt, len(_RETRY_DELAYS_SEC),
                    )
                    await _aio.sleep(delay)
            # S3 often serves images as application/octet-stream — sniff the
            # bytes so the frontend can render them as <img>.
            ct = upstream_ct
            if not ct or ct.split(";", 1)[0].strip().lower() in _GENERIC_TYPES:
                sniffed = _sniff_content_type(first_bytes)
                if sniffed:
                    ct = sniffed
                    correct = ASSET_ROOT / f"{asset.id}{_ext_for(ct, asset.source_url)}"
                    if correct != path:
                        try:
                            path.rename(correct)
                            path = correct
                        except OSError:
                            pass
            asset.local_path = str(path)
            asset.content_type = ct
            asset.file_size = size
            asset.status = "ready"
            asset.error = None
        except Exception as e:  # noqa: BLE001 — record any failure for the UI
            asset.status = "failed"
            asset.error = str(e)[:500]
            logger.warning("asset %s download failed: %s", asset.id, e)
        await session.commit()


async def download_pending_for_event(event_id: UUID) -> None:
    """Fetch every pending asset for this event. Called as a background
    task right after the webhook response goes out."""
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                select(WebhookAsset.id).where(
                    WebhookAsset.webhook_event_id == event_id,
                    WebhookAsset.status == "pending",
                )
            )
        ).scalars().all()
    for asset_id in rows:
        await _download_one(asset_id)


async def cleanup_expired(retention_hours: int | None = None) -> dict[str, int]:
    """Remove rows + files older than ``retention_hours``. Called hourly.

    ``retention_hours = 0`` or ``None`` skips the sweep entirely (the
    "unlimited / never delete" setting). We sweep on ``created_at``
    rather than the stored ``expires_at`` so that changing the retention
    setting at runtime affects all rows immediately — old assets get
    cleaned up on the next tick, not when their original expires_at
    rolls around.
    """
    if not retention_hours or retention_hours <= 0:
        return {"deleted_rows": 0, "removed_files": 0, "skipped": True}
    cutoff = datetime.now(timezone.utc) - timedelta(hours=retention_hours)
    deleted_rows = 0
    removed_files = 0
    async with SessionLocal() as session:
        expired = (
            await session.execute(
                select(WebhookAsset).where(WebhookAsset.created_at < cutoff)
            )
        ).scalars().all()
        for asset in expired:
            if asset.local_path:
                try:
                    Path(asset.local_path).unlink(missing_ok=True)
                    removed_files += 1
                except OSError:
                    pass
        if expired:
            ids = [a.id for a in expired]
            await session.execute(
                delete(WebhookAsset).where(WebhookAsset.id.in_(ids))
            )
            deleted_rows = len(ids)
        await session.commit()
    if deleted_rows:
        logger.info(
            "assets cleanup: deleted_rows=%d removed_files=%d",
            deleted_rows,
            removed_files,
        )
    return {"deleted_rows": deleted_rows, "removed_files": removed_files}
