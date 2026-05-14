"""Runtime-editable settings layer.

The crons that sweep old assets/events read their retention windows
through here. Reads are async-cached for ~30 seconds so we don't hammer
Postgres on every cron tick.

Conventions:
  - All keys are snake_case strings (see ``SettingKey`` below).
  - Storage type is ``str`` (varchar). The typed accessors
    (``get_int``, ``get_int_or_none``) coerce on read.
  - ``0`` means "unlimited / never expire" for retention windows.
  - Missing rows fall back to the registered default — the table can
    be empty on first boot.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionLocal
from app.models import AppSetting


@dataclass(frozen=True)
class SettingSpec:
    """Describes one tunable. ``default`` is what's used when the DB row
    is absent. ``unit`` and ``label`` are surface metadata for the API
    response so the UI can render meaningful labels and units."""

    key: str
    default: str
    label: str
    unit: str  # "hours" | "days" | "" — drives UI suffix
    description: str
    allow_zero: bool = True  # whether 0 means "unlimited"


SETTINGS: dict[str, SettingSpec] = {
    "webhook_event_retention_days": SettingSpec(
        key="webhook_event_retention_days",
        default="30",
        label="Webhook events (inbox)",
        unit="days",
        description=(
            "How long captured webhook events stay in the inbox. The "
            "underlying images / vehicle crops are cleaned up by the "
            "Webhook asset retention setting independently."
        ),
    ),
    "webhook_asset_retention_hours": SettingSpec(
        key="webhook_asset_retention_hours",
        default="24",
        label="Webhook assets (inline images)",
        unit="hours",
        description=(
            "How long the images embedded in webhook bodies (LPR crops, "
            "vehicle photos, snapshots) stay on disk. Verkada signs the "
            "source URLs for a short window, so the downloaded copy is "
            "the only way to view them after a few hours."
        ),
    ),
    "gemini_clip_retention_hours": SettingSpec(
        key="gemini_clip_retention_hours",
        default="168",
        label="Gemini clips (camera footage)",
        unit="hours",
        description=(
            "How long the MP4 clips pulled from Verkada cameras for Gemini "
            "video analysis stay on disk. Defaults to a week."
        ),
    ),
    "gemini_image_retention_hours": SettingSpec(
        key="gemini_image_retention_hours",
        default="168",
        label="Gemini still images (live snapshots)",
        unit="hours",
        description=(
            "How long the single-frame JPEGs grabbed for live-image Gemini "
            "analysis stay on disk."
        ),
    ),
    "run_retention_days": SettingSpec(
        key="run_retention_days",
        default="90",
        label="Flow runs",
        unit="days",
        description=(
            "How long flow-run history (and the live-progress event "
            "stream for each run) stays. Set to 0 to keep forever."
        ),
    ),
}


# ---- Cache --------------------------------------------------------------

_cache: dict[str, str | None] = {}
_cache_ts: float = 0.0
_cache_ttl: float = 30.0  # seconds — short so the UI feels live
_lock = asyncio.Lock()


async def _refresh() -> None:
    """Pull all rows into the cache. Cheap — handful of rows."""
    global _cache, _cache_ts
    async with SessionLocal() as session:
        rows = (await session.execute(select(AppSetting))).scalars().all()
    _cache = {r.key: r.value for r in rows}
    _cache_ts = time.time()


async def _ensure_fresh() -> None:
    if time.time() - _cache_ts < _cache_ttl:
        return
    async with _lock:
        if time.time() - _cache_ts < _cache_ttl:
            return
        await _refresh()


async def get_str(key: str) -> str | None:
    """Return the stored value or the registered default (as a string)."""
    await _ensure_fresh()
    spec = SETTINGS.get(key)
    raw = _cache.get(key)
    if raw is None or raw == "":
        return spec.default if spec else None
    return raw


async def get_int(key: str) -> int:
    """Coerce to int. Falls back to default. ``0`` is a valid stored value
    and means "unlimited" for the retention keys."""
    raw = await get_str(key)
    try:
        return int(raw) if raw is not None else 0
    except (ValueError, TypeError):
        return 0


async def get_int_or_none(key: str) -> int | None:
    """Like ``get_int`` but returns None when the value is 0 (= unlimited),
    so cleanup code can do ``if (n := await get_int_or_none(...)) is None: skip``."""
    v = await get_int(key)
    return v if v > 0 else None


async def set_value(session: AsyncSession, key: str, value: str | None) -> None:
    """Upsert a single setting and invalidate the cache."""
    stmt = (
        pg_insert(AppSetting)
        .values(key=key, value=value)
        .on_conflict_do_update(
            index_elements=[AppSetting.key],
            set_={"value": value},
        )
    )
    await session.execute(stmt)
    # Bust the cache so the next read is fresh.
    global _cache_ts
    _cache_ts = 0.0


def all_specs() -> list[dict[str, Any]]:
    """For the API: every registered key with its metadata."""
    return [
        {
            "key": s.key,
            "default": s.default,
            "label": s.label,
            "unit": s.unit,
            "description": s.description,
            "allow_zero": s.allow_zero,
        }
        for s in SETTINGS.values()
    ]
