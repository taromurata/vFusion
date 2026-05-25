"""Flow templates — built-in starter flows + user-saved templates.

Two sources for the same product surface:

  - **Built-in** templates live as JSON files in
    ``backend/app/data/flow_templates/``. Their IDs are slugs (kebab-case)
    so they survive across deploys and across the "Reset everything"
    wipe. Read-only.
  - **User-defined** templates live in the ``user_flow_templates`` table.
    Their IDs are UUIDs. Created by promoting an existing flow from the
    editor; deletable.

Endpoints:
  - ``GET    /api/flow-templates``                 — list both sources.
  - ``GET    /api/flow-templates/{id}``            — full template body.
  - ``POST   /api/flow-templates``                 — save a user template.
  - ``DELETE /api/flow-templates/{id}``            — drop a user template.
  - ``POST   /api/flow-templates/{id}/apply``      — create a new flow
    from the template, auto-rebinding obvious connection slots.

The "use this template" UX hits ``/apply`` so the auto-rebind runs
server-side and a single endpoint owns the conversion from template
shape → ``flows`` row. Imports of arbitrary JSON go through
``/api/flows/import`` instead, but they share the same rebind helper.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Connection, Flow, UserFlowTemplate


_TEMPLATES_DIR = Path(__file__).parent.parent / "data" / "flow_templates"


def _load_builtins() -> dict[str, dict[str, Any]]:
    """Read every JSON file in the templates dir. Cheap (a handful of
    small files) and called fresh per request — keeps shipping a new
    template a matter of dropping a file and reloading."""
    templates: dict[str, dict[str, Any]] = {}
    if not _TEMPLATES_DIR.is_dir():
        return templates
    for path in sorted(_TEMPLATES_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        tid = data.get("id")
        if isinstance(tid, str) and tid:
            templates[tid] = data
    return templates


def _is_uuid(s: str) -> bool:
    try:
        UUID(s)
        return True
    except (ValueError, TypeError):
        return False


def _user_template_to_dict(row: UserFlowTemplate) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "name": row.name,
        "category": row.category,
        "description": row.description,
        "summary": row.summary,
        "default_name": row.default_name or row.name,
        "flow": row.flow,
    }


router = APIRouter(prefix="/api/flow-templates", tags=["flow-templates"])


@router.get("")
async def list_flow_templates(
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    """Index for the Templates page — both built-ins and user-defined.

    Each row is tagged with ``source: "builtin" | "user"`` so the UI
    can hide the delete button on built-ins.
    """
    out: list[dict[str, Any]] = []
    for tpl in _load_builtins().values():
        out.append(
            {
                "id": tpl["id"],
                "source": "builtin",
                "name": tpl.get("name", tpl["id"]),
                # ``category`` was the original single-bucket field. New
                # templates declare ``tags`` (multi-tag list) instead;
                # we keep ``category`` populated as the first tag for
                # back-compat with anything still reading the old shape.
                "category": tpl.get("category") or (tpl.get("tags") or [None])[0],
                "tags": _normalize_tags(tpl.get("tags"), tpl.get("category")),
                "description": tpl.get("description"),
                "summary": tpl.get("summary"),
                "trigger_type": tpl.get("flow", {}).get("trigger_type"),
                "default_name": tpl.get("default_name", tpl.get("name", tpl["id"])),
            }
        )
    rows = (
        await session.execute(
            select(UserFlowTemplate).order_by(UserFlowTemplate.created_at.desc())
        )
    ).scalars().all()
    for row in rows:
        # User templates only carry ``category`` today. Surface it as
        # the sole tag so the UI render path doesn't have to special-
        # case user vs builtin.
        user_tags = _normalize_tags(None, row.category)
        out.append(
            {
                "id": str(row.id),
                "source": "user",
                "name": row.name,
                "category": row.category,
                "tags": user_tags,
                "description": row.description,
                "summary": row.summary,
                "trigger_type": (row.flow or {}).get("trigger_type"),
                "default_name": row.default_name or row.name,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
        )
    return out


def _normalize_tags(
    tags: list[Any] | None, category: str | None
) -> list[str]:
    """Coerce the various tag-source fields into a clean list of
    strings. Order is preserved; empties + non-strings are dropped;
    duplicates collapse case-insensitively to their first occurrence.

    Falls back to the legacy ``category`` field when no ``tags`` are
    declared, so a template that hasn't been migrated still shows
    *something* in the tag chip row.
    """
    raw: list[Any] = list(tags or [])
    if not raw and category:
        raw = [category]
    seen: set[str] = set()
    out: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        s = item.strip()
        if not s:
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


async def _resolve_template(
    template_id: str, session: AsyncSession
) -> dict[str, Any]:
    """Look up a template by id. Slugs hit the JSON catalog; UUIDs hit
    the user table. Raises 404 if neither finds it."""
    if _is_uuid(template_id):
        row = await session.get(UserFlowTemplate, UUID(template_id))
        if row is None:
            raise HTTPException(
                status_code=404,
                detail=f"User flow template {template_id!r} not found",
            )
        return _user_template_to_dict(row)
    builtins = _load_builtins()
    if template_id not in builtins:
        raise HTTPException(
            status_code=404, detail=f"Unknown flow template: {template_id!r}"
        )
    return builtins[template_id]


@router.get("/{template_id}")
async def get_flow_template(
    template_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Full template body — frontend uses this for previews."""
    return await _resolve_template(template_id, session)


class UserTemplateCreate(BaseModel):
    name: str
    category: str | None = None
    description: str | None = None
    summary: str | None = None
    default_name: str | None = None
    # The flow body — same shape as a saved Flow's
    # ``{trigger_type, trigger_config, nodes, edges}``. May also carry an
    # optional top-level ``helix_event_types`` array that lists every
    # Helix event type the flow references, so a recipient applying the
    # template can be offered "create these on your Verkada org" without
    # having to hand-build them first.
    flow: dict[str, Any] = Field(default_factory=dict)


# Keys inside node configs that reference connection IDs in the local
# DB. They're meaningless across deploys, so we always null them out
# when promoting a flow to a template — the auto-rebind on apply
# re-picks them when the new deploy has exactly one option.
_TEMPLATE_NULLED_KEYS = (
    "connection_id",
    "gemini_connection_id",
    "event_type_uid",
    "endpoint_id",
)


def _strip_for_template(flow: dict[str, Any]) -> dict[str, Any]:
    """Remove deploy-specific FK references from a flow body before
    storing it as a template. Mirrors the export-flow strip step."""
    out = dict(flow)
    nodes = []
    for n in out.get("nodes") or []:
        n = dict(n)
        cfg = dict(n.get("config") or {})
        for k in _TEMPLATE_NULLED_KEYS:
            if k in cfg:
                cfg[k] = None
        n["config"] = cfg
        nodes.append(n)
    out["nodes"] = nodes
    return out


@router.post("")
async def create_user_template(
    body: UserTemplateCreate,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Create a user-defined template from a flow body.

    Connection IDs, helix-event UIDs, and endpoint UUIDs are stripped
    to null so the template is portable across deploys.
    """
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="name is required")
    if not body.flow.get("nodes"):
        raise HTTPException(
            status_code=400, detail="flow body must include at least one node"
        )
    row = UserFlowTemplate(
        name=body.name.strip(),
        category=(body.category or None),
        description=body.description,
        summary=body.summary,
        default_name=body.default_name or body.name.strip(),
        flow=_strip_for_template(body.flow),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _user_template_to_dict(row) | {"source": "user"}


@router.delete("/{template_id}")
async def delete_user_template(
    template_id: str,
    session: AsyncSession = Depends(get_session),
) -> Response:
    """Delete a user-created template. Built-ins can't be deleted —
    the ID format (slug vs UUID) decides which bucket we're in.

    Returns a bare 204 (No Content). We construct the Response manually
    rather than declaring ``status_code=204`` on the decorator because
    FastAPI's body-allowed assertion gets cranky when a 204 route also
    has a return-type annotation — building the Response here side-steps
    that check while keeping the same wire behavior."""
    if not _is_uuid(template_id):
        raise HTTPException(
            status_code=400,
            detail="Built-in templates can't be deleted (they ship with the app).",
        )
    row = await session.get(UserFlowTemplate, UUID(template_id))
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    await session.delete(row)
    await session.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Auto-rebind — fill obvious connection slots when applying a template
# ---------------------------------------------------------------------------

async def _rebind_connections(
    nodes: list[dict[str, Any]], session: AsyncSession
) -> list[dict[str, Any]]:
    """For each null ``connection_id`` / ``gemini_connection_id`` slot,
    pre-fill it when the deploy has exactly one matching connection.

    Multiple-of-a-type means we don't guess — the operator picks. Zero
    of a type leaves the slot null. Same approach for both template
    apply and JSON import: the operator's first edit is wiring up
    anything still empty.
    """
    verkada = (
        await session.execute(
            select(Connection).where(Connection.type == "verkada")
        )
    ).scalars().all()
    gemini = (
        await session.execute(
            select(Connection).where(Connection.type == "gemini")
        )
    ).scalars().all()
    verkada_id = str(verkada[0].id) if len(verkada) == 1 else None
    gemini_id = str(gemini[0].id) if len(gemini) == 1 else None
    if not verkada_id and not gemini_id:
        return nodes

    out: list[dict[str, Any]] = []
    for n in nodes:
        n = dict(n)
        cfg = dict(n.get("config") or {})
        if verkada_id and cfg.get("connection_id") is None and "connection_id" in cfg:
            cfg["connection_id"] = verkada_id
        if (
            gemini_id
            and cfg.get("gemini_connection_id") is None
            and "gemini_connection_id" in cfg
        ):
            cfg["gemini_connection_id"] = gemini_id
        n["config"] = cfg
        out.append(n)
    return out


class ApplyTemplateBody(BaseModel):
    """Optional body for template apply — currently just the Helix uid
    rewrite map produced by ``POST /api/flows/helix-bootstrap``.

    Defaults to empty so existing callers (and templates that don't use
    Helix) keep working with a bare POST and no body.
    """

    helix_uid_map: dict[str, str] = Field(default_factory=dict)


@router.post("/{template_id}/apply")
async def apply_flow_template(
    template_id: str,
    body: ApplyTemplateBody | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Create a new flow from a template.

    Server-side housekeeping so the frontend stays a thin shell:
      1. Node positions are stripped — the editor's auto-arrange lays
         out the template cleanly on first load.
      2. Connection slots get auto-rebound when the deploy has exactly
         one matching connection per type.
      3. Any ``helix_uid_map`` from the bootstrap step rewrites
         ``event_type_uid`` references onto whatever the target Verkada
         connection assigned (or already had under the same name).
    """
    # Local import — flows.py and flow_templates.py share helpers both
    # directions, and this avoids a module-init cycle.
    from app.api.flows import _rewrite_helix_uids_in_nodes

    uid_map = (body.helix_uid_map if body is not None else None) or {}
    tpl = await _resolve_template(template_id, session)
    flow = tpl.get("flow") or {}
    nodes_in = flow.get("nodes") or []
    # Strip positions — editor falls back to computeLayout.
    nodes_stripped = [
        {**n, "position": None} for n in nodes_in if isinstance(n, dict)
    ]
    # Helix uid rewrite first — the rebind step ignores event_type_uid.
    nodes_stripped = _rewrite_helix_uids_in_nodes(nodes_stripped, uid_map)
    nodes_rebound = await _rebind_connections(nodes_stripped, session)

    new_flow = Flow(
        name=tpl.get("default_name") or tpl.get("name") or "Untitled flow",
        enabled=False,
        trigger_type=flow.get("trigger_type", "verkada_webhook"),
        trigger_config=flow.get("trigger_config") or {},
        nodes=nodes_rebound,
        edges=list(flow.get("edges") or []),
    )
    session.add(new_flow)
    await session.commit()
    await session.refresh(new_flow)
    return {
        "id": str(new_flow.id),
        "name": new_flow.name,
        "trigger_type": new_flow.trigger_type,
    }
