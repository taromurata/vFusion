"""Resource pickers for the flow editor.

These read what vFusion has *seen* in captured webhooks rather than
calling the Verkada API. Cheap, always available, and surfaces real
human-readable names ("Front Door", "HQ") instead of bare UUIDs.

When Phase 4 lands and we have a real API client, we'll fold in live
discovery as a secondary source.
"""

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import VerkadaCamera, VerkadaDoor, VerkadaScenario


router = APIRouter(prefix="/api/verkada", tags=["verkada"])


@router.get("/cameras")
async def list_cameras(
    connection_id: UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    """Cached camera list pulled via the Verkada API on sync.

    Used by the UI to render camera names where the underlying webhook
    only carried a camera_id UUID.
    """
    q = select(VerkadaCamera).order_by(VerkadaCamera.name.asc().nullslast())
    if connection_id is not None:
        q = q.where(VerkadaCamera.connection_id == connection_id)
    rows = (await session.execute(q)).scalars().all()
    return [
        {
            "connection_id": str(c.connection_id),
            "camera_id": c.camera_id,
            "name": c.name,
            "site": c.site,
            "site_id": c.site_id,
            "model": c.model,
            "serial": c.serial,
            "status": c.status,
            "location": c.location,
            "synced_at": c.synced_at.isoformat() if c.synced_at else None,
        }
        for c in rows
    ]


@router.get("/doors")
async def list_known_doors(
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    """All known doors. Prefers the synced cache from /access/v1/door; falls
    back to what we've observed in captured access events if no sync has
    run yet.

    Returned rows: ``{door_id, name, site_name, source}`` where ``source``
    is ``"synced"`` or ``"observed"``.
    """
    synced = (
        await session.execute(
            select(VerkadaDoor).order_by(VerkadaDoor.name.asc().nullslast())
        )
    ).scalars().all()
    if synced:
        return [
            {
                "door_id": d.door_id,
                "name": d.name,
                "site_name": d.site,
                "source": "synced",
                "synced_at": d.synced_at.isoformat() if d.synced_at else None,
            }
            for d in synced
        ]

    # Fallback: doors discovered from access webhooks. Useful before the
    # user clicks "Sync doors" for the first time.
    q = text(
        """
        SELECT
            body_json->'data'->>'door_id' AS door_id,
            body_json->'data'->'door_info'->>'name' AS name,
            body_json->'data'->'door_info'->'site'->>'name' AS site_name,
            MAX(received_at) AS last_seen
        FROM webhook_events
        WHERE family = 'access'
          AND body_json->'data'->>'door_id' IS NOT NULL
        GROUP BY 1, 2, 3
        ORDER BY MAX(received_at) DESC
        """
    )
    rows = (await session.execute(q)).all()
    return [
        {
            "door_id": r.door_id,
            "name": r.name,
            "site_name": r.site_name,
            "source": "observed",
            "last_seen": r.last_seen.isoformat() if r.last_seen else None,
        }
        for r in rows
    ]


@router.get("/scenarios")
async def list_scenarios(
    connection_id: UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    """Cached Access scenarios pulled via ``/access/v1/scenarios`` on sync.

    Includes the full upstream ``raw`` payload so the activation action
    (forthcoming) can read whatever fields Verkada surfaces — we don't
    yet know the canonical activation body and want everything at hand.
    """
    q = select(VerkadaScenario).order_by(VerkadaScenario.name.asc().nullslast())
    if connection_id is not None:
        q = q.where(VerkadaScenario.connection_id == connection_id)
    rows = (await session.execute(q)).scalars().all()
    return [
        {
            "connection_id": str(s.connection_id),
            "scenario_id": s.scenario_id,
            "name": s.name,
            "scenario_type": s.scenario_type,
            "site_id": s.site_id,
            "site_name": s.site_name,
            "raw": s.raw,
            "synced_at": s.synced_at.isoformat() if s.synced_at else None,
        }
        for s in rows
    ]
