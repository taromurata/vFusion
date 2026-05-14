"""Periodic crawler for Verkada's public OpenAPI specs.

Verkada publishes one OpenAPI 3.0.3 document per API namespace at
predictable URLs of the form
``https://api.verkada.com/admin/{namespace}/openapi.json``. We fetch
each one, parse it, and upsert each operation into
``verkada_api_endpoints`` so the UI can browse the full surface and
flag anything that's new, changed, or removed since last crawl.

Change detection is per-endpoint: we hash the operation dict (sans
volatile fields) and compare to the stored hash. If different ->
``last_changed_at = now``. If missing from this run -> ``deleted_at``.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy import select

from app.db import SessionLocal
from app.models import VerkadaApiEndpoint, VerkadaApiSpec


logger = logging.getLogger(__name__)


# Namespaces vFusion knows about. New ones discovered upstream (e.g.
# access_v2) just need to be added here.
DEFAULT_NAMESPACES: list[str] = [
    "access_v1",
    "alarms_v1",
    "camera_v1",
    "core_v1",
    "guest_v1",
    "guest_v2",
    "sensor_v1",
    "tokens",
    "viewing_station_v1",
]


SPEC_URL_TEMPLATE = "https://api.verkada.com/admin/{namespace}/openapi.json"

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}


def _hash_dict(d: Any) -> str:
    """Stable hash of a JSON-serializable structure."""
    payload = json.dumps(d, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode()).hexdigest()


def _spec_url(namespace: str) -> str:
    return SPEC_URL_TEMPLATE.format(namespace=namespace)


async def _fetch_spec(namespace: str, timeout: float = 15.0) -> dict[str, Any]:
    url = _spec_url(namespace)
    async with httpx.AsyncClient(timeout=timeout) as client:
        res = await client.get(url, headers={"accept": "application/json"})
    if res.status_code >= 400:
        raise RuntimeError(f"GET {url} → {res.status_code} {res.text[:200]!r}")
    try:
        return res.json()
    except ValueError as e:
        raise RuntimeError(f"GET {url} returned non-JSON: {e}")


async def crawl_namespace(namespace: str) -> dict[str, Any]:
    """Fetch one spec and reconcile its operations against the catalog."""
    now = datetime.now(timezone.utc)
    url = _spec_url(namespace)

    async with SessionLocal() as session:
        spec = (
            await session.execute(
                select(VerkadaApiSpec).where(VerkadaApiSpec.namespace == namespace)
            )
        ).scalar_one_or_none()
        if spec is None:
            spec = VerkadaApiSpec(namespace=namespace, url=url)
            session.add(spec)
            await session.flush()

        spec.url = url
        spec.last_fetched_at = now

        try:
            doc = await _fetch_spec(namespace)
        except Exception as e:
            spec.fetch_status = "error"
            spec.fetch_error = str(e)
            await session.commit()
            logger.warning("catalog: %s fetch failed: %s", namespace, e)
            return {"namespace": namespace, "status": "error", "error": str(e)}

        new_hash = _hash_dict(doc)
        if spec.raw_hash != new_hash:
            spec.raw_hash = new_hash
            spec.raw = doc
            spec.last_changed_at = now
        spec.fetch_status = "ok"
        spec.fetch_error = None
        info = doc.get("info") or {}
        spec.title = info.get("title") if isinstance(info, dict) else None
        spec.api_version = info.get("version") if isinstance(info, dict) else None
        spec.openapi_version = doc.get("openapi")

        # ---- Reconcile endpoints ----
        existing = (
            await session.execute(
                select(VerkadaApiEndpoint).where(VerkadaApiEndpoint.spec_id == spec.id)
            )
        ).scalars().all()
        by_key: dict[tuple[str, str], VerkadaApiEndpoint] = {
            (e.method, e.path): e for e in existing
        }

        seen_keys: set[tuple[str, str]] = set()
        added = 0
        changed = 0
        unchanged = 0

        for path, methods in (doc.get("paths") or {}).items():
            if not isinstance(methods, dict):
                continue
            for method, op in methods.items():
                if method.lower() not in HTTP_METHODS or not isinstance(op, dict):
                    continue
                method_u = method.upper()
                key = (method_u, path)
                seen_keys.add(key)
                content_hash = _hash_dict(op)
                row = by_key.get(key)
                tags = op.get("tags") if isinstance(op.get("tags"), list) else None
                summary = op.get("summary")
                description = op.get("description")
                operation_id = op.get("operationId")

                if row is None:
                    session.add(
                        VerkadaApiEndpoint(
                            spec_id=spec.id,
                            namespace=namespace,
                            method=method_u,
                            path=path,
                            operation_id=operation_id,
                            summary=summary,
                            description=description,
                            tags=tags,
                            content_hash=content_hash,
                            raw=op,
                            first_seen_at=now,
                            last_seen_at=now,
                            last_changed_at=now,
                            deleted_at=None,
                        )
                    )
                    added += 1
                else:
                    row.last_seen_at = now
                    if row.deleted_at is not None:
                        # Resurrected — count as changed.
                        row.deleted_at = None
                        row.last_changed_at = now
                        changed += 1
                    elif row.content_hash != content_hash:
                        row.content_hash = content_hash
                        row.raw = op
                        row.operation_id = operation_id
                        row.summary = summary
                        row.description = description
                        row.tags = tags
                        row.last_changed_at = now
                        changed += 1
                    else:
                        unchanged += 1

        # Mark anything not seen as deleted (idempotent).
        removed = 0
        for (method, path), row in by_key.items():
            if (method, path) not in seen_keys and row.deleted_at is None:
                row.deleted_at = now
                row.last_changed_at = now
                removed += 1

        await session.commit()
        logger.info(
            "catalog: %s added=%d changed=%d removed=%d unchanged=%d",
            namespace,
            added,
            changed,
            removed,
            unchanged,
        )
        return {
            "namespace": namespace,
            "status": "ok",
            "added": added,
            "changed": changed,
            "removed": removed,
            "unchanged": unchanged,
            "title": spec.title,
        }


async def crawl_all(namespaces: list[str] | None = None) -> list[dict[str, Any]]:
    """Crawl every known namespace. Used by the 4-hourly cron + manual trigger."""
    ns_list = namespaces or DEFAULT_NAMESPACES
    results: list[dict[str, Any]] = []
    for ns in ns_list:
        try:
            results.append(await crawl_namespace(ns))
        except Exception as e:
            logger.exception("catalog: unexpected error on %s", ns)
            results.append({"namespace": ns, "status": "error", "error": str(e)})
    return results
