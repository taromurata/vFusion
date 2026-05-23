"""Sync Verkada metadata into the local cache.

For each configured connection we hit the Command API once a day (and on
demand from the UI) and upsert ``verkada_cameras`` so the rest of the
app can resolve ``camera_id`` UUIDs to friendly names without doing
live API calls on every request.
"""

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete, select

from app.connectors.verkada.client import VerkadaApiError, VerkadaClient
from app.crypto import decrypt_secret
from app.db import SessionLocal
from app.models import (
    Connection,
    VerkadaCamera,
    VerkadaDoor,
    VerkadaHelixEventType,
    VerkadaScenario,
)


logger = logging.getLogger(__name__)


def _auth_hint(operation: str, permission: str) -> str:
    """Friendly 401 message that tells the operator which Verkada API
    permission their key needs to be granted. Same generic 401 body
    ("Failed to authenticate request") comes back for both a bad key
    and a key missing a scope, so we surface both possibilities."""
    return (
        f"Verkada rejected the API key (HTTP 401). To {operation}, the key needs "
        f'**Read** on "{permission}" in Verkada Command.'
    )


async def sync_cameras_for_connection(connection_id) -> dict[str, Any]:
    """Pull the full camera list for one connection and replace the cache.

    Returns ``{"count": N}`` on success or ``{"error": "..."}`` if the
    connection isn't ready or the API call failed.
    """
    async with SessionLocal() as session:
        conn = await session.get(Connection, connection_id)
        if conn is None:
            return {"error": "connection not found"}
        if conn.type != "verkada":
            return {"error": f"connection type {conn.type!r} can't sync cameras"}
        try:
            secret = decrypt_secret(conn.encrypted_secret)
        except Exception as e:
            return {"error": f"could not decrypt secret: {e}"}
        api_key = secret.get("api_key")
        if not api_key:
            return {"error": "connection has no api_key — finish setup first"}
        region = secret.get("region") or None

        client = VerkadaClient(api_key=api_key, base_url=region)
        try:
            cameras = await client.list_cameras()
        except VerkadaApiError as e:
            logger.warning("camera sync failed for %s: %s", conn.id, e)
            if e.status_code == 401:
                return {"error": _auth_hint("list cameras", "Cameras")}
            return {"error": str(e)}

        # Replace strategy: wipe + insert. Avoids stale rows for deleted cameras.
        await session.execute(
            delete(VerkadaCamera).where(VerkadaCamera.connection_id == conn.id)
        )
        for cam in cameras:
            if not isinstance(cam, dict):
                continue
            camera_id = cam.get("camera_id")
            if not isinstance(camera_id, str) or not camera_id:
                continue
            session.add(
                VerkadaCamera(
                    connection_id=conn.id,
                    camera_id=camera_id,
                    name=cam.get("name"),
                    site=cam.get("site"),
                    site_id=cam.get("site_id"),
                    model=cam.get("model"),
                    serial=cam.get("serial"),
                    status=cam.get("status"),
                    location=cam.get("location"),
                    raw=cam,
                )
            )

        conn.cameras_last_synced_at = datetime.now(timezone.utc)
        await session.commit()
        logger.info(
            "synced %d cameras for connection %s", len(cameras), conn.id
        )
        return {"count": len(cameras)}


async def sync_doors_for_connection(connection_id) -> dict[str, Any]:
    """Pull the full door list for one connection and replace the cache.

    Mirrors sync_cameras_for_connection — same wipe-and-insert strategy,
    same error shape.
    """
    async with SessionLocal() as session:
        conn = await session.get(Connection, connection_id)
        if conn is None:
            return {"error": "connection not found"}
        if conn.type != "verkada":
            return {"error": f"connection type {conn.type!r} can't sync doors"}
        try:
            secret = decrypt_secret(conn.encrypted_secret)
        except Exception as e:
            return {"error": f"could not decrypt secret: {e}"}
        api_key = secret.get("api_key")
        if not api_key:
            return {"error": "connection has no api_key — finish setup first"}
        region = secret.get("region") or None

        client = VerkadaClient(api_key=api_key, base_url=region)
        try:
            doors = await client.list_doors()
        except VerkadaApiError as e:
            logger.warning("door sync failed for %s: %s", conn.id, e)
            if e.status_code == 401:
                return {"error": _auth_hint("list doors", "Door Access Management")}
            return {"error": str(e)}

        await session.execute(
            delete(VerkadaDoor).where(VerkadaDoor.connection_id == conn.id)
        )
        for door in doors:
            if not isinstance(door, dict):
                continue
            door_id = door.get("door_id")
            if not isinstance(door_id, str) or not door_id:
                continue
            # Verkada's door payload may nest site info under a sub-object;
            # we try a couple of plausible shapes so we surface a name + site.
            site = door.get("site")
            site_id = door.get("site_id")
            if isinstance(site, dict):
                site_id = site.get("site_id") or site_id
                site = site.get("name")
            acu = door.get("access_controller") if isinstance(door.get("access_controller"), dict) else {}
            session.add(
                VerkadaDoor(
                    connection_id=conn.id,
                    door_id=door_id,
                    name=door.get("name"),
                    site=site if isinstance(site, str) else None,
                    site_id=site_id if isinstance(site_id, str) else None,
                    status=door.get("status"),
                    acu_id=(acu.get("access_controller_id") or door.get("acu_id"))
                    if isinstance(acu.get("access_controller_id"), str) or isinstance(door.get("acu_id"), str)
                    else None,
                    acu_name=acu.get("name") if isinstance(acu.get("name"), str) else door.get("acu_name"),
                    raw=door,
                )
            )

        conn.doors_last_synced_at = datetime.now(timezone.utc)
        await session.commit()
        logger.info("synced %d doors for connection %s", len(doors), conn.id)
        return {"count": len(doors)}


async def sync_helix_event_types_for_connection(connection_id) -> dict[str, Any]:
    """Pull all Helix video-tagging event types for one connection and replace
    the cache. Wipe + insert so deleted event types fall off.
    """
    async with SessionLocal() as session:
        conn = await session.get(Connection, connection_id)
        if conn is None:
            return {"error": "connection not found"}
        if conn.type != "verkada":
            return {"error": f"connection type {conn.type!r} can't sync helix events"}
        try:
            secret = decrypt_secret(conn.encrypted_secret)
        except Exception as e:
            return {"error": f"could not decrypt secret: {e}"}
        api_key = secret.get("api_key")
        if not api_key:
            return {"error": "connection has no api_key — finish setup first"}
        org_id = secret.get("org_id") or conn.external_id
        if not org_id:
            return {"error": "connection has no org_id"}
        region = secret.get("region") or None

        client = VerkadaClient(api_key=api_key, base_url=region)
        try:
            event_types = await client.list_helix_event_types()
        except VerkadaApiError as e:
            logger.warning("helix sync failed for %s: %s", conn.id, e)
            if e.status_code == 401:
                return {"error": _auth_hint("list Helix event types", "Helix")}
            return {"error": str(e)}

        await session.execute(
            delete(VerkadaHelixEventType).where(
                VerkadaHelixEventType.connection_id == conn.id
            )
        )
        for et in event_types:
            if not isinstance(et, dict):
                continue
            uid = et.get("event_type_uid")
            if not isinstance(uid, str) or not uid:
                continue
            schema = et.get("event_schema")
            session.add(
                VerkadaHelixEventType(
                    connection_id=conn.id,
                    org_id=str(et.get("org_id") or org_id),
                    event_type_uid=uid,
                    name=et.get("name"),
                    event_schema=schema if isinstance(schema, dict) else None,
                )
            )

        conn.helix_events_last_synced_at = datetime.now(timezone.utc)
        await session.commit()
        logger.info(
            "synced %d helix event types for connection %s",
            len(event_types),
            conn.id,
        )
        return {"count": len(event_types)}


async def sync_scenarios_for_connection(connection_id) -> dict[str, Any]:
    """Pull the Access scenario list for one connection and replace the
    cache. Same wipe-and-insert + error shape as the camera / door syncs.

    The exact field names inside each scenario payload aren't fully
    pinned down yet (the Verkada docs are sparse on the response body),
    so we try a couple of plausible keys for id / name / type / site
    and always keep the full payload in ``raw`` for downstream actions.
    """
    async with SessionLocal() as session:
        conn = await session.get(Connection, connection_id)
        if conn is None:
            return {"error": "connection not found"}
        if conn.type != "verkada":
            return {"error": f"connection type {conn.type!r} can't sync scenarios"}
        try:
            secret = decrypt_secret(conn.encrypted_secret)
        except Exception as e:
            return {"error": f"could not decrypt secret: {e}"}
        api_key = secret.get("api_key")
        if not api_key:
            return {"error": "connection has no api_key — finish setup first"}
        region = secret.get("region") or None

        client = VerkadaClient(api_key=api_key, base_url=region)
        try:
            scenarios = await client.list_scenarios()
        except VerkadaApiError as e:
            logger.warning("scenario sync failed for %s: %s", conn.id, e)
            if e.status_code == 401:
                return {
                    "error": _auth_hint(
                        "list Access scenarios",
                        "Access Scenario Management (or Access Control)",
                    )
                }
            return {"error": str(e)}

        await session.execute(
            delete(VerkadaScenario).where(VerkadaScenario.connection_id == conn.id)
        )
        for sc in scenarios:
            if not isinstance(sc, dict):
                continue
            # Try a few likely key names — once we see live data we'll
            # tighten this up. The unique identifier is mandatory; the
            # rest are best-effort.
            scenario_id = sc.get("scenario_id") or sc.get("id") or sc.get("uid")
            if not isinstance(scenario_id, str) or not scenario_id:
                continue
            site = sc.get("site") if isinstance(sc.get("site"), dict) else None
            site_id = (site or {}).get("site_id") or sc.get("site_id")
            site_name = (site or {}).get("name") or sc.get("site_name")
            session.add(
                VerkadaScenario(
                    connection_id=conn.id,
                    scenario_id=scenario_id,
                    name=sc.get("name") if isinstance(sc.get("name"), str) else None,
                    scenario_type=(
                        sc.get("scenario_type")
                        or sc.get("type")
                        if isinstance(sc.get("scenario_type") or sc.get("type"), str)
                        else None
                    ),
                    site_id=site_id if isinstance(site_id, str) else None,
                    site_name=site_name if isinstance(site_name, str) else None,
                    raw=sc,
                )
            )

        conn.scenarios_last_synced_at = datetime.now(timezone.utc)
        await session.commit()
        logger.info(
            "synced %d scenarios for connection %s", len(scenarios), conn.id
        )
        return {"count": len(scenarios)}


async def sync_all_connections() -> dict[str, Any]:
    """Sync cameras + doors + helix + scenarios across every set-up Verkada
    connection. Used by cron."""
    results: dict[str, Any] = {
        "cameras": {},
        "doors": {},
        "helix": {},
        "scenarios": {},
    }
    async with SessionLocal() as session:
        conns = (
            await session.execute(
                select(Connection).where(
                    Connection.type == "verkada", Connection.setup_complete.is_(True)
                )
            )
        ).scalars().all()
        ids = [c.id for c in conns]
    for cid in ids:
        results["cameras"][str(cid)] = await sync_cameras_for_connection(cid)
        results["doors"][str(cid)] = await sync_doors_for_connection(cid)
        results["helix"][str(cid)] = await sync_helix_event_types_for_connection(cid)
        results["scenarios"][str(cid)] = await sync_scenarios_for_connection(cid)
    return results
