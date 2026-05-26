from collections import defaultdict, deque
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from sqlalchemy.orm.attributes import flag_modified

from app.engine.actions import ACTIONS
from app.engine.conditions import OPERATORS as CONDITION_OPERATORS
from app.engine.conditions import SAMPLE_OUTPUT as CONDITION_SAMPLE
from app.engine.conditions import SCHEMA as CONDITION_SCHEMA
from app.engine.conditions import evaluate as evaluate_condition
from app.models import Connection, Flow, Run, VerkadaHelixEventType, WebhookEvent


router = APIRouter(prefix="/api/flows", tags=["flows"])


class NodePosition(BaseModel):
    x: float
    y: float


class FlowNode(BaseModel):
    id: str
    name: str
    # Friendly display name shown on the canvas. ``name`` stays the
    # identifier (used in ``{{ steps.<name>.output.* }}`` template
    # substitution); ``label`` is purely cosmetic and falls back to
    # ``name`` when blank. Templates set this so the canvas reads like
    # English instead of like Python variables.
    label: str | None = None
    kind: Literal["action", "condition"] = "action"
    action_type: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    # Optional persisted position from the editor. When absent the frontend
    # falls back to its auto-layout. Snapped to a 20px grid when set.
    position: NodePosition | None = None


class FlowEdge(BaseModel):
    id: str
    source: str
    target: str
    branch: Literal["true", "false"] | None = None


class FlowOut(BaseModel):
    id: UUID
    name: str
    enabled: bool
    trigger_type: str
    trigger_config: dict[str, Any]
    nodes: list[FlowNode]
    edges: list[FlowEdge]
    node_samples: dict[str, Any] = Field(default_factory=dict)
    last_scheduled_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class FlowCreate(BaseModel):
    name: str
    enabled: bool = True
    trigger_type: str = "verkada_webhook"
    trigger_config: dict[str, Any] = Field(default_factory=dict)
    nodes: list[FlowNode] = Field(default_factory=list)
    edges: list[FlowEdge] = Field(default_factory=list)


class FlowUpdate(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    trigger_type: str | None = None
    trigger_config: dict[str, Any] | None = None
    nodes: list[FlowNode] | None = None
    edges: list[FlowEdge] | None = None


def _has_cycle(nodes: list[FlowNode], edges: list[FlowEdge]) -> bool:
    ids = {n.id for n in nodes}
    indegree: dict[str, int] = {nid: 0 for nid in ids}
    outgoing: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        if e.source in ids and e.target in ids:
            indegree[e.target] += 1
            outgoing[e.source].append(e.target)
    queue: deque[str] = deque(nid for nid, d in indegree.items() if d == 0)
    seen = 0
    while queue:
        nid = queue.popleft()
        seen += 1
        for tgt in outgoing[nid]:
            indegree[tgt] -= 1
            if indegree[tgt] == 0:
                queue.append(tgt)
    return seen != len(ids)


def _validate_graph(nodes: list[FlowNode], edges: list[FlowEdge]) -> None:
    if not nodes:
        return
    ids_seen: set[str] = set()
    names_seen: set[str] = set()
    for i, n in enumerate(nodes):
        if not n.id.strip():
            raise HTTPException(status_code=400, detail=f"node {i + 1}: id is required")
        if n.id in ids_seen:
            raise HTTPException(
                status_code=400, detail=f"duplicate node id {n.id!r}"
            )
        ids_seen.add(n.id)
        if not n.name.strip():
            raise HTTPException(
                status_code=400, detail=f"node {n.id!r}: name is required"
            )
        if n.name in names_seen:
            raise HTTPException(
                status_code=400, detail=f"duplicate node name {n.name!r}"
            )
        names_seen.add(n.name)
        if n.kind == "action":
            if not n.action_type or n.action_type not in ACTIONS:
                raise HTTPException(
                    status_code=400,
                    detail=f"node {n.name!r}: unknown action type {n.action_type!r}",
                )
        elif n.kind == "condition":
            op = (n.config or {}).get("operator")
            if op is not None and op not in CONDITION_OPERATORS:
                raise HTTPException(
                    status_code=400,
                    detail=f"node {n.name!r}: unknown operator {op!r}",
                )
        else:
            raise HTTPException(
                status_code=400, detail=f"node {n.name!r}: unknown kind {n.kind!r}"
            )

    edge_ids_seen: set[str] = set()
    for e in edges:
        if not e.id.strip():
            raise HTTPException(status_code=400, detail="edge id is required")
        if e.id in edge_ids_seen:
            raise HTTPException(status_code=400, detail=f"duplicate edge id {e.id!r}")
        edge_ids_seen.add(e.id)
        if e.source not in ids_seen:
            raise HTTPException(
                status_code=400, detail=f"edge {e.id!r}: unknown source {e.source!r}"
            )
        if e.target not in ids_seen:
            raise HTTPException(
                status_code=400, detail=f"edge {e.id!r}: unknown target {e.target!r}"
            )
        if e.source == e.target:
            raise HTTPException(
                status_code=400, detail=f"edge {e.id!r}: self-loop not allowed"
            )

    if _has_cycle(nodes, edges):
        raise HTTPException(status_code=400, detail="flow has a cycle — DAG only")


@router.get("/actions")
async def list_actions() -> dict[str, dict[str, Any]]:
    """Node types available for the editor — both regular actions and the
    condition kind. The frontend renders the right form based on ``kind``.
    """
    out: dict[str, dict[str, Any]] = {
        "_condition": {
            "kind": "condition",
            "label": "Condition (if / else)",
            "description": "Evaluate a comparison and branch downstream edges.",
            "schema": CONDITION_SCHEMA,
            "output_sample": CONDITION_SAMPLE,
            "operators": list(CONDITION_OPERATORS),
        },
    }
    for spec in ACTIONS.values():
        out[spec.type] = {
            "kind": "action",
            "label": spec.label,
            "description": spec.description,
            "schema": spec.schema,
            "output_sample": spec.output_sample,
            "default_step_name": spec.default_step_name,
        }
    return out


@router.get("", response_model=list[FlowOut])
async def list_flows(session: AsyncSession = Depends(get_session)) -> list[FlowOut]:
    rows = (
        await session.execute(select(Flow).order_by(Flow.created_at.desc()))
    ).scalars().all()
    return [FlowOut.model_validate(r) for r in rows]


@router.post("", response_model=FlowOut)
async def create_flow(
    payload: FlowCreate, session: AsyncSession = Depends(get_session)
) -> FlowOut:
    _validate_graph(payload.nodes, payload.edges)
    flow = Flow(
        name=payload.name,
        enabled=payload.enabled,
        trigger_type=payload.trigger_type,
        trigger_config=payload.trigger_config,
        nodes=[n.model_dump() for n in payload.nodes],
        edges=[e.model_dump() for e in payload.edges],
    )
    session.add(flow)
    await session.commit()
    await session.refresh(flow)
    return FlowOut.model_validate(flow)


# ---------------------------------------------------------------------------
# Export / import — share a flow between vFusion installs.
#
# Connection-style FKs (verkada / gemini connection IDs, helix event-type
# UIDs, API-catalog endpoint UUIDs) are stripped on export because they're
# meaningful only inside the deploy that authored them. The importer
# re-picks those on first edit. Verkada-side identifiers (camera_id,
# door_id) stay as-is so the importer can see the original intent and
# either keep them or replace them.
# ---------------------------------------------------------------------------

_STRIPPED_CONFIG_KEYS = {
    "connection_id",
    "gemini_connection_id",
    "event_type_uid",
    "endpoint_id",
}


def _strip_for_export(node: dict[str, Any]) -> dict[str, Any]:
    out = dict(node)
    cfg = dict(out.get("config") or {})
    for k in _STRIPPED_CONFIG_KEYS:
        if k in cfg:
            cfg[k] = None
    out["config"] = cfg
    return out


async def _collect_helix_event_type_defs(
    nodes: list[dict[str, Any]], session: AsyncSession
) -> "list[HelixEventTypeDef]":
    """Look up every (event_type_uid, connection_id) pair referenced in
    the flow's nodes and return de-duped definitions.

    De-dupe by ``event_type_uid`` only — the same uid means the same
    type even if two nodes happened to point at different connections.
    We look up against the source flow's connection_ids so the name +
    schema we embed reflect what the *author* actually used at export
    time.

    Three sources, in priority order:

      1. ``config._inline_helix_def`` — the paired-prompt insertion
         path stuffs the full def into the new node so a downstream
         importer can recreate the type even if it was never synced
         from Verkada (e.g. the inserter created it on a brand-new org
         and the export goes to a different deploy).
      2. ``verkada_helix_event_types`` table — looked up by
         ``(connection_id, event_type_uid)``.
      3. Stub (uid only, no name/schema) — last-resort fallback.
    """
    pairs: list[tuple[str, str]] = []  # (connection_id, event_type_uid)
    seen_uids: set[str] = set()
    # ``inline_overrides[uid]`` wins over DB lookup for the same uid —
    # the inline def is what the operator just configured locally.
    inline_overrides: dict[str, HelixEventTypeDef] = {}
    for n in nodes:
        cfg = n.get("config") or {}
        uid = cfg.get("event_type_uid")
        conn = cfg.get("connection_id")
        inline = cfg.get("_inline_helix_def")
        if not isinstance(uid, str) or not uid:
            continue
        # Record the inline def even if we've seen the uid — first-write
        # wins, mirroring the seen_uids guard below.
        if isinstance(inline, dict) and uid not in inline_overrides:
            try:
                inline_overrides[uid] = HelixEventTypeDef(
                    event_type_uid=str(inline.get("event_type_uid") or uid),
                    name=inline.get("name"),
                    event_schema=inline.get("event_schema"),
                )
            except Exception:  # noqa: BLE001 — malformed inline blob falls back to DB lookup
                pass
        if uid in seen_uids:
            continue
        seen_uids.add(uid)
        if isinstance(conn, str) and conn:
            pairs.append((conn, uid))
        else:
            # No connection on the node — emit a stub so the importer
            # can still surface the uid.
            pairs.append(("", uid))

    if not pairs:
        return []

    defs: "list[HelixEventTypeDef]" = []
    for conn_str, uid in pairs:
        # Inline def wins if present — see priority order in the
        # docstring. The node carries the full type schema, which is
        # what a downstream importer needs to recreate it.
        inline = inline_overrides.get(uid)
        if inline is not None:
            defs.append(inline)
            continue
        row = None
        if conn_str:
            try:
                conn_uuid = UUID(conn_str)
            except ValueError:
                conn_uuid = None
            if conn_uuid is not None:
                row = (
                    await session.execute(
                        select(VerkadaHelixEventType).where(
                            VerkadaHelixEventType.connection_id == conn_uuid,
                            VerkadaHelixEventType.event_type_uid == uid,
                        )
                    )
                ).scalar_one_or_none()
        if row is None:
            defs.append(HelixEventTypeDef(event_type_uid=uid))
        else:
            defs.append(
                HelixEventTypeDef(
                    event_type_uid=row.event_type_uid,
                    name=row.name,
                    event_schema=row.event_schema,
                )
            )
    return defs


class HelixEventTypeDef(BaseModel):
    """Embedded Helix event-type definition for portability.

    Travels alongside an exported flow whenever any node references a
    custom Helix event type. The importer can offer to recreate these
    on the destination's Verkada org so the recipient doesn't have to
    hand-build event types before the flow will run. Per-deploy fields
    (connection_id, org_id, internal UUID) are deliberately excluded —
    only the type's intrinsic identity (uid + name + schema) crosses
    deploy boundaries.
    """

    event_type_uid: str
    name: str | None = None
    event_schema: dict[str, Any] | None = None


class FlowExport(BaseModel):
    """Portable representation of a flow. ``format`` + ``version``
    identify the schema so a future change can be detected on import.

    ``helix_event_types`` carries the definitions of any Helix event
    types referenced by action configs. Optional + omitted when empty
    so older importers (and exports of flows that don't touch Helix)
    stay byte-identical to v1.
    """

    format: Literal["vfusion-flow"] = "vfusion-flow"
    version: int = 1
    name: str
    trigger_type: str
    trigger_config: dict[str, Any]
    nodes: list[FlowNode]
    edges: list[FlowEdge]
    helix_event_types: list[HelixEventTypeDef] = Field(default_factory=list)


class FlowImport(BaseModel):
    format: Literal["vfusion-flow"]
    version: int = 1
    # Optional override; if omitted we use the exported name + " (imported)".
    name: str | None = None
    trigger_type: str = "verkada_webhook"
    trigger_config: dict[str, Any] = Field(default_factory=dict)
    nodes: list[FlowNode] = Field(default_factory=list)
    edges: list[FlowEdge] = Field(default_factory=list)
    # Embedded Helix type defs the importer may offer to recreate; we
    # accept them on the wire but the actual create-missing work runs
    # through a separate endpoint so the operator can opt in / pick the
    # target connection. Stored here purely for round-tripping.
    helix_event_types: list[HelixEventTypeDef] = Field(default_factory=list)
    # Optional uid rewrite map produced by /helix-bootstrap. Verkada
    # assigns event_type_uids server-side, so a "bear" type recreated on
    # a different deploy gets a different uid than the one referenced in
    # the export. The frontend bootstrap step returns this map and we
    # apply it to node configs during import.
    helix_uid_map: dict[str, str] = Field(default_factory=dict)
    # Same Verkada-org override as ApplyTemplateBody — when the
    # operator picks a connection in the bootstrap modal we wire it
    # into every null verkada connection_id slot during rebind.
    verkada_connection_id: str | None = None


class HelixBootstrapRequest(BaseModel):
    """Bootstrap Helix event types on a target Verkada connection before
    importing or applying a flow that references them."""

    target_connection_id: UUID
    event_types: list[HelixEventTypeDef]
    # When omitted, every missing type is created. Pass an explicit
    # subset to let the operator skip certain types.
    create_uids: list[str] | None = None


class HelixBootstrapResultRow(BaseModel):
    event_type_uid: str  # the uid from the export (may differ from new_uid)
    new_uid: str | None  # the uid on the target connection (None if skipped)
    name: str | None
    status: Literal["existed", "created", "skipped", "failed"]
    error: str | None = None


class HelixBootstrapResponse(BaseModel):
    uid_map: dict[str, str]  # old_uid -> new_uid for everything resolved
    results: list[HelixBootstrapResultRow]


def _rewrite_helix_uids_in_nodes(
    nodes: list[dict[str, Any]], uid_map: dict[str, str]
) -> list[dict[str, Any]]:
    """Rewrite ``config.event_type_uid`` on every node per ``uid_map``.

    No-op when the node doesn't reference Helix or when its uid isn't in
    the map — those slots stay as-is and either fail at runtime (operator
    didn't bootstrap) or already match (uid happened to be identical).
    """
    if not uid_map:
        return nodes
    out: list[dict[str, Any]] = []
    for n in nodes:
        cfg = dict(n.get("config") or {})
        uid = cfg.get("event_type_uid")
        if isinstance(uid, str) and uid in uid_map:
            cfg["event_type_uid"] = uid_map[uid]
        new_node = dict(n)
        new_node["config"] = cfg
        out.append(new_node)
    return out


@router.post("/helix-bootstrap", response_model=HelixBootstrapResponse)
async def helix_bootstrap(
    body: HelixBootstrapRequest, session: AsyncSession = Depends(get_session)
) -> HelixBootstrapResponse:
    """Pre-create Helix event types on a target Verkada connection so a
    flow import / template apply can proceed without runtime failures.

    Match strategy: look up by **name** on the target connection. Verkada
    assigns event_type_uids server-side so the export's uid is just an
    opaque label — the name is the only stable identifier across deploys.
    For each embedded def:

    - **existed** — a type with that name already lives on the target
      connection. Map old_uid → existing_uid; no API call.
    - **created** — name not found, ``create_uids`` allowed it. Create
      via Verkada, map old_uid → newly-issued uid.
    - **skipped** — name not found but the operator left the box
      unchecked. No mapping; the runtime action will fail until the
      operator fixes it.
    - **failed** — Verkada rejected the create (duplicate name race,
      bad schema, etc.). Reported back so the UI can surface it.

    A single resync runs at the end so the local cache reflects whatever
    we just created.
    """
    from app.api.connections import _verkada_client_for
    from app.connectors.verkada.client import VerkadaApiError
    from app.connectors.verkada.sync import sync_helix_event_types_for_connection

    conn = await session.get(Connection, body.target_connection_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="target connection not found")
    if conn.type != "verkada":
        raise HTTPException(
            status_code=400,
            detail=f"helix bootstrap only works on verkada connections (got {conn.type!r})",
        )

    # Existing types on the target conn, keyed by lowercased name for
    # case-insensitive match. Names are user-supplied so casing drifts.
    existing_rows = (
        await session.execute(
            select(VerkadaHelixEventType).where(
                VerkadaHelixEventType.connection_id == body.target_connection_id
            )
        )
    ).scalars().all()
    by_name: dict[str, VerkadaHelixEventType] = {
        (r.name or "").strip().lower(): r for r in existing_rows if r.name
    }

    create_uid_set = set(body.create_uids) if body.create_uids is not None else None
    client = None
    results: list[HelixBootstrapResultRow] = []
    uid_map: dict[str, str] = {}
    created_any = False

    for d in body.event_types:
        nm = (d.name or "").strip()
        key = nm.lower()
        existing = by_name.get(key) if key else None
        if existing is not None:
            uid_map[d.event_type_uid] = existing.event_type_uid
            results.append(
                HelixBootstrapResultRow(
                    event_type_uid=d.event_type_uid,
                    new_uid=existing.event_type_uid,
                    name=existing.name,
                    status="existed",
                )
            )
            continue
        # Missing. Either create or skip per the operator's opt-in set.
        allowed = create_uid_set is None or d.event_type_uid in create_uid_set
        if not allowed or not nm or d.event_schema is None:
            reason = (
                "not selected for creation"
                if allowed is False
                else "missing name or schema"
            )
            results.append(
                HelixBootstrapResultRow(
                    event_type_uid=d.event_type_uid,
                    new_uid=None,
                    name=d.name,
                    status="skipped",
                    error=reason if not allowed else "no name/schema embedded",
                )
            )
            continue
        # Lazy-init the API client so we don't decrypt secrets unless we
        # actually have something to create.
        if client is None:
            client = await _verkada_client_for(conn)
        try:
            await client.create_helix_event_type(nm, d.event_schema)
        except VerkadaApiError as e:
            results.append(
                HelixBootstrapResultRow(
                    event_type_uid=d.event_type_uid,
                    new_uid=None,
                    name=d.name,
                    status="failed",
                    error=str(e),
                )
            )
            continue
        created_any = True
        # We'll resolve the new uid after the resync below.
        results.append(
            HelixBootstrapResultRow(
                event_type_uid=d.event_type_uid,
                new_uid=None,
                name=d.name,
                status="created",
            )
        )

    # Resync once so newly-created rows land locally with their assigned
    # uids, then go back and fill in new_uid for everything we created.
    if created_any:
        await sync_helix_event_types_for_connection(conn.id)
        fresh = (
            await session.execute(
                select(VerkadaHelixEventType).where(
                    VerkadaHelixEventType.connection_id == body.target_connection_id
                )
            )
        ).scalars().all()
        fresh_by_name = {
            (r.name or "").strip().lower(): r for r in fresh if r.name
        }
        for i, row in enumerate(results):
            if row.status != "created":
                continue
            fresh_row = fresh_by_name.get((row.name or "").strip().lower())
            if fresh_row is not None:
                uid_map[row.event_type_uid] = fresh_row.event_type_uid
                results[i] = row.model_copy(update={"new_uid": fresh_row.event_type_uid})

    return HelixBootstrapResponse(uid_map=uid_map, results=results)


@router.post("/import", response_model=FlowOut)
async def import_flow(
    payload: FlowImport, session: AsyncSession = Depends(get_session)
) -> FlowOut:
    """Create a new flow from an exported JSON. Imported flows are
    disabled by default — the user reviews + picks their connections
    before flipping the switch.

    Connection slots that are null get auto-rebound when the deploy
    has exactly one matching connection (same helper used by the
    template-apply endpoint), so importers with one Verkada + one
    Gemini connection land in the editor with nothing left to pick.
    """
    # Local import to avoid a module-init cycle (flow_templates imports
    # from app.models, which transitively touches the flows router).
    from app.api.flow_templates import _rebind_connections

    if payload.version != 1:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported flow export version: {payload.version!r}",
        )
    _validate_graph(payload.nodes, payload.edges)
    node_dicts = [n.model_dump() for n in payload.nodes]
    # Apply the uid rewrite *before* connection rebind — the rebind only
    # touches connection_id slots, but the uid map lives in node configs
    # under event_type_uid, so the two are independent passes.
    node_dicts = _rewrite_helix_uids_in_nodes(node_dicts, payload.helix_uid_map)
    node_dicts = await _rebind_connections(
        node_dicts, session, verkada_override=payload.verkada_connection_id
    )
    flow = Flow(
        name=payload.name or "Imported flow",
        enabled=False,
        trigger_type=payload.trigger_type,
        trigger_config=payload.trigger_config,
        nodes=node_dicts,
        edges=[e.model_dump() for e in payload.edges],
    )
    session.add(flow)
    await session.commit()
    await session.refresh(flow)
    return FlowOut.model_validate(flow)


@router.get("/{flow_id}", response_model=FlowOut)
async def get_flow(
    flow_id: UUID, session: AsyncSession = Depends(get_session)
) -> FlowOut:
    flow = await session.get(Flow, flow_id)
    if flow is None:
        raise HTTPException(status_code=404, detail="not found")
    return FlowOut.model_validate(flow)


@router.get("/{flow_id}/export", response_model=FlowExport)
async def export_flow(
    flow_id: UUID, session: AsyncSession = Depends(get_session)
) -> FlowExport:
    flow = await session.get(Flow, flow_id)
    if flow is None:
        raise HTTPException(status_code=404, detail="not found")
    raw_nodes = flow.nodes or []
    # Collect Helix defs from the un-stripped nodes — we need the
    # original connection_id to find the right row in
    # verkada_helix_event_types. After that the connection_id gets
    # zeroed out by _strip_for_export.
    helix_defs = await _collect_helix_event_type_defs(raw_nodes, session)
    stripped = [_strip_for_export(n) for n in raw_nodes]
    return FlowExport(
        name=flow.name,
        trigger_type=flow.trigger_type,
        trigger_config=flow.trigger_config or {},
        nodes=[FlowNode.model_validate(n) for n in stripped],
        edges=[FlowEdge.model_validate(e) for e in (flow.edges or [])],
        helix_event_types=helix_defs,
    )


@router.put("/{flow_id}", response_model=FlowOut)
async def update_flow(
    flow_id: UUID,
    payload: FlowUpdate,
    session: AsyncSession = Depends(get_session),
) -> FlowOut:
    flow = await session.get(Flow, flow_id)
    if flow is None:
        raise HTTPException(status_code=404, detail="not found")
    if payload.name is not None:
        flow.name = payload.name
    if payload.enabled is not None:
        flow.enabled = payload.enabled
    if payload.trigger_type is not None:
        flow.trigger_type = payload.trigger_type
        # Reset schedule bookkeeping if we changed away from / to schedule.
        flow.last_scheduled_at = None
    if payload.trigger_config is not None:
        flow.trigger_config = payload.trigger_config
    if payload.nodes is not None or payload.edges is not None:
        new_nodes = payload.nodes if payload.nodes is not None else [
            FlowNode.model_validate(n) for n in flow.nodes
        ]
        new_edges = payload.edges if payload.edges is not None else [
            FlowEdge.model_validate(e) for e in flow.edges
        ]
        _validate_graph(new_nodes, new_edges)
        flow.nodes = [n.model_dump() for n in new_nodes]
        flow.edges = [e.model_dump() for e in new_edges]
    await session.commit()
    await session.refresh(flow)
    return FlowOut.model_validate(flow)


class TestRunRequest(BaseModel):
    webhook_event_id: UUID | None = None
    input: dict[str, Any] | None = None


class TestRunResponse(BaseModel):
    run_id: UUID


class RunNodeRequest(BaseModel):
    node_id: str
    # Optional override for the trigger context. When omitted we use the
    # most recent matching webhook event for the flow's trigger filter
    # (webhook flows) or a synthetic schedule trigger.
    webhook_event_id: UUID | None = None


class RunNodeResponse(BaseModel):
    output: Any | None = None
    error: str | None = None


@router.post("/{flow_id}/test-run", response_model=TestRunResponse)
async def test_run_flow(
    flow_id: UUID,
    payload: TestRunRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> TestRunResponse:
    """Enqueue a one-off Run for this flow using either a past webhook
    event's body as input or an inline dict. Bypasses trigger-matching
    so a flow can be tested even when its filter wouldn't fire."""
    flow = await session.get(Flow, flow_id)
    if flow is None:
        raise HTTPException(status_code=404, detail="flow not found")

    body: dict[str, Any]
    event_id: UUID | None = None
    if payload.webhook_event_id is not None:
        event = await session.get(WebhookEvent, payload.webhook_event_id)
        if event is None:
            raise HTTPException(status_code=404, detail="webhook event not found")
        if not isinstance(event.body_json, dict):
            raise HTTPException(
                status_code=400, detail="webhook event has no usable JSON body"
            )
        body = event.body_json
        event_id = event.id
    elif payload.input is not None:
        body = payload.input
    else:
        raise HTTPException(
            status_code=400, detail="webhook_event_id or input is required"
        )

    run = Run(
        flow_id=flow.id,
        webhook_event_id=event_id,
        status="pending",
        input=body,
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)

    pool = getattr(request.app.state, "arq_pool", None)
    if pool is None:
        raise HTTPException(status_code=503, detail="worker queue unavailable")
    await pool.enqueue_job("run_flow", str(run.id))
    return TestRunResponse(run_id=run.id)


@router.post("/{flow_id}/run-node", response_model=RunNodeResponse)
async def run_one_node(
    flow_id: UUID,
    payload: RunNodeRequest,
    session: AsyncSession = Depends(get_session),
) -> RunNodeResponse:
    """Synchronous execution of a single node for the in-editor "▶ Run
    this step" button. Builds a template context from already-captured
    sample outputs of prior nodes (Flow.node_samples) so the user can
    iterate one step at a time without re-running the whole flow.

    On success the captured output is persisted to Flow.node_samples
    under the node id — that's what feeds the variable picker for
    downstream steps."""
    flow = await session.get(Flow, flow_id)
    if flow is None:
        raise HTTPException(status_code=404, detail="flow not found")
    nodes = list(flow.nodes or [])
    node = next((n for n in nodes if n.get("id") == payload.node_id), None)
    if node is None:
        raise HTTPException(
            status_code=404, detail=f"node {payload.node_id} not found in flow"
        )

    # ---- Trigger context ----
    # For webhook flows: pull the most recent matching event by family /
    # notification_type (or the explicit one the user picked) and use its
    # body as ctx.trigger. For schedule flows: synthesize a trigger blob
    # so {{ trigger.fired_at }} resolves to "now".
    trigger_blob: dict[str, Any] = {}
    if flow.trigger_type == "verkada_webhook":
        if payload.webhook_event_id is not None:
            event = await session.get(WebhookEvent, payload.webhook_event_id)
        else:
            cfg = flow.trigger_config or {}
            q = select(WebhookEvent).order_by(WebhookEvent.received_at.desc())
            fam = cfg.get("family")
            nt = cfg.get("notification_type")
            if fam:
                q = q.where(WebhookEvent.family == fam)
            if nt:
                q = q.where(WebhookEvent.notification_type == nt)
            event = (await session.execute(q.limit(1))).scalars().first()
        if event is not None and isinstance(event.body_json, dict):
            trigger_blob = event.body_json
    elif flow.trigger_type == "schedule":
        now = int(datetime.now().timestamp())
        trigger_blob = {
            "schedule": True,
            "fired_at": now,
            "kind": (flow.trigger_config or {}).get("kind"),
            "config": flow.trigger_config or {},
        }

    # ---- Steps context from captured samples ----
    # Walk the flow's node samples and key by step NAME (which is what
    # template refs use: {{ steps.<name>.output.* }}). Also include by
    # node id as a fallback, mirroring how the real worker does it.
    samples: dict[str, Any] = flow.node_samples or {}
    by_name: dict[str, Any] = {}
    for n in nodes:
        nid = n.get("id")
        name = n.get("name") or nid
        if not nid or nid == payload.node_id:
            continue
        out = samples.get(nid)
        if out is not None:
            by_name[name] = {"output": out}
            by_name[nid] = {"output": out}

    ctx: dict[str, Any] = {"trigger": trigger_blob, "steps": by_name}

    # ---- Execute ----
    kind = node.get("kind", "action")
    try:
        if kind == "condition":
            output: Any = evaluate_condition(node.get("config") or {}, ctx)
        elif kind == "action":
            spec = ACTIONS.get(node.get("action_type"))
            if spec is None:
                raise ValueError(f"unknown action type: {node.get('action_type')!r}")
            conn_id_raw = (node.get("config") or {}).get("connection_id")
            connection: Connection | None = None
            if conn_id_raw:
                try:
                    cid = UUID(str(conn_id_raw))
                except (ValueError, TypeError):
                    cid = None
                if cid:
                    connection = await session.get(Connection, cid)
            if connection is None:
                raise ValueError("connection_id missing or invalid")
            output = await spec.run(node.get("config") or {}, ctx, connection)
        else:
            raise ValueError(f"unknown node kind: {kind!r}")
    except Exception as e:  # noqa: BLE001 — surface anything to the UI
        return RunNodeResponse(error=str(e))

    # Persist the captured output keyed by node id so the variable
    # picker can read it for downstream steps next time the editor
    # renders.
    next_samples = dict(samples)
    next_samples[payload.node_id] = output
    flow.node_samples = next_samples
    flag_modified(flow, "node_samples")
    await session.commit()

    return RunNodeResponse(output=output)


@router.delete("/{flow_id}")
async def delete_flow(
    flow_id: UUID, session: AsyncSession = Depends(get_session)
) -> dict[str, bool]:
    flow = await session.get(Flow, flow_id)
    if flow is None:
        raise HTTPException(status_code=404, detail="not found")
    await session.delete(flow)
    await session.commit()
    return {"ok": True}
