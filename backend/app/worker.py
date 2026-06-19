"""arq worker — runs flow DAGs out-of-band of the webhook ingest path.

Each ``run_flow`` job:

1. Loads the Run + Flow.
2. Topologically sorts the flow's nodes.
3. Walks the order, deciding each node's status:
   - root nodes (no incoming edges) always run
   - non-root nodes run when at least one incoming edge has a successful
     source AND the edge's branch (if any) matches the source's
     ``output.matched`` (only meaningful for condition nodes)
   - otherwise the node is recorded as ``skipped`` and its downstream
     edges propagate that
4. Each step's output is added to the template context as
   ``steps.<node_name>.output`` for later nodes to reference.
5. Run-level status reflects the worst non-skipped step: if any step
   ``failed``, the run is ``failed``; else ``success``.
"""

import logging
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any
from uuid import UUID


logger = logging.getLogger(__name__)

from arq.connections import RedisSettings
from arq.cron import cron
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.orm.attributes import flag_modified

from app.assets import cleanup_expired as cleanup_expired_assets
from app.config import settings
from app.connectors.verkada.catalog import crawl_all as crawl_verkada_catalog
from app.connectors.verkada.footage import cleanup_old_clips
from app.connectors.verkada.sync import sync_all_connections
from app.db import SessionLocal
from app.engine.actions import ACTIONS
from app.engine.conditions import evaluate as evaluate_condition
from app.engine.progress import StepProgress
from app.engine.schedule import is_due as schedule_is_due
from app.models import Connection, Flow, Run, VerkadaHelixEventType
from app.pricing.gemini import refresh_gemini_pricing


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _topo_sort(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> list[str]:
    """Kahn's algorithm. Returns node ids in execution order, or raises
    ValueError if the graph has a cycle (shouldn't happen — API validates)."""
    ids = [n["id"] for n in nodes]
    indegree: dict[str, int] = {nid: 0 for nid in ids}
    outgoing: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        src, tgt = e.get("source"), e.get("target")
        if src in indegree and tgt in indegree:
            indegree[tgt] += 1
            outgoing[src].append(tgt)
    queue: deque[str] = deque(nid for nid in ids if indegree[nid] == 0)
    order: list[str] = []
    while queue:
        nid = queue.popleft()
        order.append(nid)
        for tgt in outgoing[nid]:
            indegree[tgt] -= 1
            if indegree[tgt] == 0:
                queue.append(tgt)
    if len(order) != len(ids):
        raise ValueError("flow contains a cycle")
    return order


async def _resolve_connection(session, conn_id_raw: Any) -> Connection | None:
    if not conn_id_raw:
        return None
    try:
        conn_id = UUID(str(conn_id_raw))
    except (ValueError, TypeError):
        return None
    return (
        await session.execute(select(Connection).where(Connection.id == conn_id))
    ).scalar_one_or_none()


async def _run_one_node(
    session,
    node: dict[str, Any],
    ctx: dict[str, Any],
) -> dict[str, Any]:
    """Execute a single node. Returns a result dict on success or raises."""
    kind = node.get("kind", "action")
    if kind == "condition":
        return evaluate_condition(node.get("config") or {}, ctx)
    if kind == "action":
        action_type = node.get("action_type")
        spec = ACTIONS.get(action_type)
        if spec is None:
            raise ValueError(f"unknown action type: {action_type!r}")
        connection = await _resolve_connection(
            session, (node.get("config") or {}).get("connection_id")
        )
        if connection is None:
            raise ValueError("connection_id missing or invalid")
        return await spec.run(node.get("config") or {}, ctx, connection)
    raise ValueError(f"unknown node kind: {kind!r}")


def _progress_for(run_id: UUID, step_name: str) -> StepProgress:
    return StepProgress(run_id=run_id, step_name=step_name)


async def _fetch_helix_schema(
    session, connection_id: UUID, event_type_uid: str
) -> dict[str, Any] | None:
    """Pull the synced Helix event-type schema for a given uid on a
    given Verkada connection. Returns the ``event_schema`` dict
    (field name -> type string) or None if we don't have a synced
    row for it. Used by the BYOA worker to auto-fan-out analyze JSON
    into per-attribute Helix posts even when the operator didn't
    carry a paired-prompt mapping into the run."""
    from sqlalchemy import select as sa_select

    row = (
        await session.execute(
            sa_select(VerkadaHelixEventType).where(
                VerkadaHelixEventType.connection_id == connection_id,
                VerkadaHelixEventType.event_type_uid == event_type_uid,
            )
        )
    ).scalar_one_or_none()
    if row is None or not isinstance(row.event_schema, dict):
        return None
    return row.event_schema


def _edge_matches_branch(edge: dict[str, Any], src_output: dict[str, Any] | None) -> bool:
    """An unconditional edge always matches; a branch-gated edge requires
    the source's output to be a condition result with the matching value."""
    branch = edge.get("branch")
    if branch is None:
        return True
    if not isinstance(src_output, dict):
        return False
    if branch == "true":
        return src_output.get("matched") is True
    if branch == "false":
        return src_output.get("matched") is False
    return False


def _skip_reason(
    inc: list[dict[str, Any]],
    nodes_by_id: dict[str, dict[str, Any]],
    results: dict[str, dict[str, Any]],
) -> str:
    """Human-readable explanation for why a step was skipped, derived
    from its incoming edges. Shown on the Runs page so a skipped Helix
    post reads "condition 'Is it blocked?' was false (obstructed
    equals "true" → no match)" instead of a bare badge."""
    if not inc:
        return "No path reached this step."
    reasons: list[str] = []
    for edge in inc:
        src_id = edge.get("source")
        src = results.get(src_id) if src_id else None
        src_node = nodes_by_id.get(src_id) if src_id else None
        src_label = (
            (src_node.get("label") or src_node.get("name") or src_id)
            if src_node
            else src_id
        )
        branch = edge.get("branch")
        if src is None:
            reasons.append(f"upstream step '{src_label}' did not run")
        elif src["status"] == "failed":
            reasons.append(f"upstream step '{src_label}' failed")
        elif src["status"] == "skipped":
            reasons.append(f"upstream step '{src_label}' was itself skipped")
        elif branch in ("true", "false"):
            out = src.get("output") or {}
            matched = out.get("matched")
            # Describe the condition that gated this branch.
            left = out.get("left")
            right = out.get("right")
            op = out.get("operator", "equals")
            took = "true" if matched else "false"
            reasons.append(
                f"condition '{src_label}' evaluated {took} "
                f"({left!r} {op} {right!r}) so the '{branch}' branch "
                f"wasn't taken"
            )
        else:
            reasons.append(f"the edge from '{src_label}' wasn't taken")
    return "; ".join(reasons)


async def run_flow(ctx: dict[str, Any], run_id: str) -> dict[str, Any]:  # noqa: ARG001
    async with SessionLocal() as session:
        run = await session.get(Run, UUID(run_id))
        if run is None:
            return {"error": f"run {run_id} not found"}

        flow = await session.get(Flow, run.flow_id)
        if flow is None:
            run.status = "failed"
            run.error = "flow no longer exists"
            run.finished_at = _utcnow()
            await session.commit()
            return {"error": run.error}

        nodes = list(flow.nodes or [])
        edges = list(flow.edges or [])
        if not nodes:
            run.status = "failed"
            run.error = "flow has no nodes configured"
            run.started_at = run.started_at or _utcnow()
            run.finished_at = _utcnow()
            await session.commit()
            return {"error": run.error}

        nodes_by_id = {n["id"]: n for n in nodes}
        incoming: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for e in edges:
            tgt = e.get("target")
            if tgt in nodes_by_id:
                incoming[tgt].append(e)

        try:
            order = _topo_sort(nodes, edges)
        except ValueError as e:
            run.status = "failed"
            run.error = str(e)
            run.started_at = run.started_at or _utcnow()
            run.finished_at = _utcnow()
            await session.commit()
            return {"error": run.error}

        run.status = "running"
        run.started_at = _utcnow()
        await session.commit()

        template_ctx: dict[str, Any] = {
            "trigger": run.input or {},
            "steps": {},
        }
        # node_id -> {status, output}
        results: dict[str, dict[str, Any]] = {}
        step_records: list[dict[str, Any]] = []
        any_failed = False

        for nid in order:
            node = nodes_by_id[nid]
            inc = incoming.get(nid, [])
            started_at = _utcnow()

            # Reachability
            reachable: bool
            if not inc:
                reachable = True
            else:
                reachable = False
                for edge in inc:
                    src = results.get(edge.get("source"))
                    if not src or src["status"] != "success":
                        continue
                    if _edge_matches_branch(edge, src.get("output")):
                        reachable = True
                        break

            record: dict[str, Any] = {
                "name": node.get("name") or nid,
                # Friendly display name set on the flow node (e.g.
                # "Inspect the view" vs "analyze"). The Runs UI prefers
                # this so step chips read like English instead of Python
                # identifiers. ``name`` stays the canonical id for any
                # downstream tooling that joins on it.
                "label": node.get("label") or None,
                "type": node.get("action_type") or node.get("kind", "action"),
                "kind": node.get("kind", "action"),
                "started_at": started_at.isoformat(),
            }

            if not reachable:
                record["status"] = "skipped"
                record["finished_at"] = _utcnow().isoformat()
                # Explain *why* this step didn't run so the Runs UI can
                # show it instead of a bare "skipped" badge. Walk the
                # incoming edges and describe the gate that blocked us:
                # an upstream condition that evaluated to the opposite
                # branch, an upstream step that failed / was itself
                # skipped, etc.
                record["skip_reason"] = _skip_reason(inc, nodes_by_id, results)
                results[nid] = {"status": "skipped", "output": None}
                step_records.append(record)
                # Persist incrementally so the UI sees skipped steps live.
                run.steps = list(step_records)
                flag_modified(run, "steps")
                await session.commit()
                continue

            # Mark step as running and persist so the UI's poll picks it up.
            # flag_modified is critical here: SQLAlchemy's change detection
            # on JSON columns compares by equality, and we mutate the same
            # dict object across the running → success transitions. Without
            # flag_modified the second commit is a no-op and the step stays
            # "running" forever in the DB.
            record["status"] = "running"
            step_records.append(record)
            run.steps = list(step_records)
            flag_modified(run, "steps")
            await session.commit()

            # Bind a live-progress reporter to this step's name. Actions
            # that emit phase/log events read this from ctx and write rows
            # into run_events for the UI to stream.
            step_ctx = dict(template_ctx)
            step_ctx["_progress"] = _progress_for(run.id, record["name"])
            try:
                output = await _run_one_node(session, node, step_ctx)
                record["status"] = "success"
                record["output"] = output
                results[nid] = {"status": "success", "output": output}
                template_ctx["steps"][record["name"]] = {"output": output}
                # Also expose by node id for stability.
                template_ctx["steps"][nid] = {"output": output}
            except Exception as e:  # noqa: BLE001 — surface anything to the UI
                record["status"] = "failed"
                record["error"] = str(e)
                results[nid] = {"status": "failed", "output": None}
                any_failed = True

            record["finished_at"] = _utcnow().isoformat()
            step_records[-1] = dict(record)
            run.steps = list(step_records)
            flag_modified(run, "steps")
            await session.commit()

        overall_status = "failed" if any_failed else "success"
        last_success = next(
            (r["output"] for r in reversed(step_records) if r.get("status") == "success"),
            None,
        )
        first_error = next(
            (r["error"] for r in step_records if r.get("status") == "failed"),
            None,
        )

        run.steps = list(step_records)
        flag_modified(run, "steps")
        run.status = overall_status
        run.error = first_error
        run.output = last_success if overall_status == "success" else None
        run.finished_at = _utcnow()
        await session.commit()
        return {"status": run.status, "nodes": len(step_records)}


async def run_byoa(ctx: dict[str, Any], run_id: str) -> dict[str, Any]:  # noqa: ARG001
    """One-off "Brew Your Own Analytics" run. Same Run + step + event
    plumbing as a normal flow execution, but the "flow" is synthesized
    from the BYOA form payload — historical → gemini_analyze_camera;
    live → gemini_analyze_still_image. Reusing the actions means the
    Runs page renders the captured media + AI text identically."""
    async with SessionLocal() as session:
        run = await session.get(Run, UUID(run_id))
        if run is None:
            return {"error": f"run {run_id} not found"}
        params = run.input or {}
        if not isinstance(params, dict) or not params.get("byoa"):
            run.status = "failed"
            run.error = "byoa params missing"
            run.finished_at = _utcnow()
            await session.commit()
            return {"error": run.error}

        mode = params.get("mode")
        action_type = (
            "gemini_analyze_camera"
            if mode == "historical"
            else "gemini_analyze_still_image"
        )
        spec = ACTIONS.get(action_type)
        if spec is None:
            run.status = "failed"
            run.error = f"action {action_type} unavailable"
            run.finished_at = _utcnow()
            await session.commit()
            return {"error": run.error}

        try:
            verkada_conn_id = UUID(params["connection_id"])
        except (KeyError, ValueError):
            run.status = "failed"
            run.error = "invalid connection_id"
            run.finished_at = _utcnow()
            await session.commit()
            return {"error": run.error}
        verkada_conn = await _resolve_connection(session, str(verkada_conn_id))
        if verkada_conn is None:
            run.status = "failed"
            run.error = "Verkada connection not found"
            run.finished_at = _utcnow()
            await session.commit()
            return {"error": run.error}

        config: dict[str, Any] = {
            "connection_id": params["connection_id"],
            "gemini_connection_id": params["gemini_connection_id"],
            "camera_id": params["camera_id"],
            "prompt": params.get("prompt"),
            "model": params.get("model"),
        }
        if mode == "historical":
            config["start_epoch"] = params.get("start_epoch")
            config["duration_sec"] = params.get("duration_sec", 10)
            config["pre_roll_sec"] = params.get("pre_roll_sec", 2)
            # The BYOA UI never wants to sit through 60s of HD-backfill
            # waiting — the user picked the start time themselves and
            # is iterating live. Force the pre-grab delay off.
            config["pre_grab_delay_sec"] = 0

        record: dict[str, Any] = {
            "name": "byoa",
            "type": action_type,
            "kind": "action",
            "started_at": _utcnow().isoformat(),
            "status": "running",
        }
        run.status = "running"
        run.started_at = _utcnow()
        run.steps = [dict(record)]
        flag_modified(run, "steps")
        await session.commit()

        ctx_for_action: dict[str, Any] = {
            "trigger": params,
            "steps": {},
            "_progress": _progress_for(run.id, "byoa"),
        }
        analyze_output: dict[str, Any] | None = None
        try:
            analyze_output = await spec.run(config, ctx_for_action, verkada_conn)
            record["status"] = "success"
            record["output"] = analyze_output
            record["finished_at"] = _utcnow().isoformat()
            run.steps = [dict(record)]
            flag_modified(run, "steps")
            run.status = "running" if params.get("post_to_helix") else "success"
            run.output = analyze_output
            await session.commit()
        except Exception as e:  # noqa: BLE001 — surface anything to the UI
            # Full traceback to container logs so root-cause is debuggable
            # — ``str(e)`` (what lands in the UI) often drops the line
            # number / library frame that actually matters.
            logger.exception("byoa action failed: %s", e)
            record["status"] = "failed"
            record["error"] = str(e)
            record["finished_at"] = _utcnow().isoformat()
            run.steps = [dict(record)]
            flag_modified(run, "steps")
            run.status = "failed"
            run.error = str(e)
            run.finished_at = _utcnow()
            await session.commit()
            return {"error": str(e)}

        # Optional follow-up: post the AI text to Helix as a video-tagging
        # event. Same flow the real verkada_helix_event action runs in a
        # normal flow execution — we just synthesize a second step record
        # so the Runs page chain shows both.
        if not params.get("post_to_helix") or analyze_output is None:
            run.status = "success"
            run.finished_at = _utcnow()
            await session.commit()
            return {"status": "success"}

        helix_spec = ACTIONS.get("verkada_helix_event")
        if helix_spec is None:
            run.status = "success"
            run.finished_at = _utcnow()
            await session.commit()
            return {"status": "success", "warning": "helix action missing"}

        time_sec = (
            analyze_output.get("started_at_epoch")
            or analyze_output.get("captured_at_epoch")
            or int(_utcnow().timestamp())
        )

        # Two ways the operator can specify the Helix payload:
        #
        #   1. ``helix_attribute_mapping`` (preferred, sent by paired
        #      prompts): a dict { "Helix attr": "{{ output.x }}" }. The
        #      worker rewrites ``{{ output. }}`` -> ``{{ steps.byoa.output. }}``
        #      and lets the helix step's template resolver fill each
        #      field. Multi-attribute, structured.
        #
        #   2. ``helix_attribute`` (legacy single-field path): one
        #      attribute name, populated with the raw analyze output's
        #      ``text``. Used by unpaired prompts where the operator
        #      picks an attribute manually from BYOA's UI.
        mapping = params.get("helix_attribute_mapping")
        if isinstance(mapping, dict) and mapping:
            attributes: dict[str, Any] = {}
            for k, v in mapping.items():
                if isinstance(v, str):
                    # ``output.`` is the step-local shorthand the paired
                    # prompt declares; rewrite to the canonical
                    # ``steps.byoa.output.`` so the helix action's
                    # resolver finds it.
                    attributes[k] = v.replace(
                        "{{ output.", "{{ steps.byoa.output."
                    )
                else:
                    attributes[k] = v
        else:
            # Auto-resolve: if the analyze output is structured JSON and
            # the chosen Helix type's schema has field names matching
            # those JSON keys (case-insensitive), post each field
            # separately. This catches every entry path that *didn't*
            # carry an explicit mapping — "Open in Workbench", manual
            # prompt entry, replay paths that predate the mapping
            # restore. Without this, the legacy "Summary" fallback
            # stuffs the whole JSON into one attribute and Helix 400's.
            attributes = {}
            json_out = analyze_output.get("json") if isinstance(analyze_output, dict) else None
            if isinstance(json_out, dict) and json_out:
                schema = await _fetch_helix_schema(
                    session,
                    UUID(params["connection_id"]),
                    str(params["helix_event_type_uid"]),
                )
                if schema:
                    # case-insensitive JSON key index for matching
                    json_index = {k.lower(): k for k in json_out.keys()}
                    for schema_field in schema.keys():
                        jk = json_index.get(schema_field.lower())
                        if jk is not None:
                            val = json_out[jk]
                            attributes[schema_field] = (
                                val if isinstance(val, (str, int, float, bool)) else str(val)
                            )
            if not attributes:
                # No JSON or no schema match — fall back to the old
                # single-field path with whatever attribute the
                # operator picked (defaults to "Summary" if they
                # didn't pick one, which still 400's on paired types
                # but at least makes the failure visible).
                helix_attr = params.get("helix_attribute") or "Summary"
                text = str(analyze_output.get("text") or "")
                attributes = {helix_attr: text}

        helix_config: dict[str, Any] = {
            "connection_id": params["connection_id"],
            "camera_id": params["camera_id"],
            "event_type_uid": params["helix_event_type_uid"],
            "time_ms": int(time_sec) * 1000,
            "attributes": attributes,
        }
        helix_record: dict[str, Any] = {
            "name": "post_helix",
            "type": "verkada_helix_event",
            "kind": "action",
            "started_at": _utcnow().isoformat(),
            "status": "running",
        }
        run.steps = [dict(record), dict(helix_record)]
        flag_modified(run, "steps")
        await session.commit()

        helix_ctx: dict[str, Any] = {
            "trigger": params,
            "steps": {"byoa": {"output": analyze_output}},
            "_progress": _progress_for(run.id, "post_helix"),
        }
        try:
            helix_out = await helix_spec.run(
                helix_config, helix_ctx, verkada_conn
            )
            helix_record["status"] = "success"
            helix_record["output"] = helix_out
            helix_record["finished_at"] = _utcnow().isoformat()
            run.steps = [dict(record), dict(helix_record)]
            flag_modified(run, "steps")
            run.status = "success"
            run.finished_at = _utcnow()
            await session.commit()
            return {"status": "success"}
        except Exception as e:  # noqa: BLE001
            helix_record["status"] = "failed"
            helix_record["error"] = str(e)
            helix_record["finished_at"] = _utcnow().isoformat()
            run.steps = [dict(record), dict(helix_record)]
            flag_modified(run, "steps")
            run.status = "failed"
            run.error = f"Helix post failed: {e}"
            run.finished_at = _utcnow()
            await session.commit()
            return {"error": str(e)}


async def sync_verkada_cameras_cron(ctx: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG001
    return await sync_all_connections()


async def crawl_verkada_catalog_cron(ctx: dict[str, Any]) -> list[dict[str, Any]]:  # noqa: ARG001
    return await crawl_verkada_catalog()


async def cleanup_assets_cron(ctx: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG001
    """Sweep expired filesystem assets + (optionally) old DB rows.

    Reads all retention windows from ``app_settings`` at call time so a
    UI-side change to the Settings card takes effect on the next tick
    (no service restart needed). A value of 0 / null on any setting
    means "keep forever" — the corresponding sweep is skipped.
    """
    from app import settings_store

    asset_days = await settings_store.get_int("webhook_asset_retention_days")
    clip_days = await settings_store.get_int("gemini_clip_retention_days")
    image_days = await settings_store.get_int("gemini_image_retention_days")
    event_days = await settings_store.get_int("webhook_event_retention_days")
    run_days = await settings_store.get_int("run_retention_days")

    # cleanup_* helpers still take hours under the hood, so convert here.
    # 0 stays 0 (= unlimited / skip).
    assets = await cleanup_expired_assets(asset_days * 24)
    clips = cleanup_old_clips(
        clip_retention_hours=clip_days * 24,
        image_retention_hours=image_days * 24,
    )
    events = await _cleanup_old_webhook_events(event_days)
    runs = await _cleanup_old_runs(run_days)
    return {"assets": assets, "clips": clips, "events": events, "runs": runs}


async def _cleanup_old_webhook_events(retention_days: int) -> dict[str, int]:
    """Delete webhook_events older than ``retention_days``. 0 = skip.

    Cascade on the asset/run FKs takes care of dependent rows
    (``webhook_assets.webhook_event_id`` is ON DELETE CASCADE).
    """
    if not retention_days or retention_days <= 0:
        return {"deleted": 0, "skipped": True}
    from datetime import datetime, timedelta, timezone

    from app.models import WebhookEvent

    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    async with SessionLocal() as session:
        result = await session.execute(
            sa_delete(WebhookEvent).where(WebhookEvent.received_at < cutoff)
        )
        await session.commit()
    deleted = int(result.rowcount or 0)
    if deleted:
        logger.info("webhook_events cleanup: deleted=%d (cutoff=%s)", deleted, cutoff)
    return {"deleted": deleted}


async def _cleanup_old_runs(retention_days: int) -> dict[str, int]:
    """Delete runs older than ``retention_days``. 0 = skip.

    ``run_events`` rows are removed by ON DELETE CASCADE on their FK.
    """
    if not retention_days or retention_days <= 0:
        return {"deleted": 0, "skipped": True}
    from datetime import datetime, timedelta, timezone

    from app.models import Run

    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    async with SessionLocal() as session:
        result = await session.execute(
            sa_delete(Run).where(Run.created_at < cutoff)
        )
        await session.commit()
    deleted = int(result.rowcount or 0)
    if deleted:
        logger.info("runs cleanup: deleted=%d (cutoff=%s)", deleted, cutoff)
    return {"deleted": deleted}


async def tick_schedule_flows(ctx: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG001
    """Every-minute pass over enabled schedule-trigger flows. For each
    one that's due (based on its trigger_config kind + last_scheduled_at)
    we create a Run with a synthetic trigger blob and enqueue run_flow.
    Mirrors the webhook ingest path so the existing run engine doesn't
    need to know schedules exist at all."""
    now = _utcnow()
    fired = 0
    fired_ids: list[str] = []
    pool = ctx.get("redis")
    async with SessionLocal() as session:
        flows = (
            await session.execute(
                select(Flow).where(
                    Flow.enabled.is_(True),
                    Flow.trigger_type == "schedule",
                )
            )
        ).scalars().all()
        for flow in flows:
            if not schedule_is_due(
                flow.trigger_config or {},
                now=now,
                last=flow.last_scheduled_at,
            ):
                continue
            run = Run(
                flow_id=flow.id,
                webhook_event_id=None,
                status="pending",
                input={
                    "schedule": True,
                    "fired_at": int(now.timestamp()),
                    "kind": (flow.trigger_config or {}).get("kind"),
                    "config": flow.trigger_config or {},
                },
            )
            session.add(run)
            await session.flush()
            flow.last_scheduled_at = now
            if pool is not None:
                await pool.enqueue_job("run_flow", str(run.id))
            fired += 1
            fired_ids.append(str(run.id))
        await session.commit()
    return {"fired": fired, "run_ids": fired_ids}


async def refresh_gemini_pricing_cron(ctx: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG001
    """Upsert the hardcoded Gemini price table into the DB. Currently a
    no-op refresh of static values; the seam is here so a future live
    scrape (or a Google pricing API) can be wired in without touching
    the rest of the system."""
    return await refresh_gemini_pricing()


async def run_byoa_upload(ctx: dict[str, Any], run_id: str) -> dict[str, Any]:  # noqa: ARG001
    """BYOA upload-mode entry point — same shape as ``run_byoa`` but the
    media comes from a file the user uploaded (sitting on the
    ``webhook_assets`` shared volume), not from a Verkada camera.

    Pipeline:
      1. ``byoa`` step: upload the file to Gemini, poll until ACTIVE,
         generate_content with the operator's prompt. Output mirrors
         ``gemini_analyze_camera`` (.text, .json) so the Runs page
         renders the result identically.
      2. ``helix_preview`` step (only when the operator picked a
         paired prompt template): compute the JSON payload the real
         verkada_helix_event action *would have* POSTed, using the
         same auto-fan-out logic as the camera-mode worker. Emitted
         with ``type: "verkada_helix_event_preview"`` so the Runs
         page can render a distinct "would have posted — dry run"
         card.

    No Helix POST ever fires. The uploaded file is deleted at the end
    of the run regardless of success or failure.
    """
    from pathlib import Path

    from app.api.byoa import _compute_helix_preview

    async with SessionLocal() as session:
        run = await session.get(Run, UUID(run_id))
        if run is None:
            return {"error": f"run {run_id} not found"}
        params = run.input or {}
        if not isinstance(params, dict) or not params.get("byoa_upload"):
            run.status = "failed"
            run.error = "byoa_upload params missing"
            run.finished_at = _utcnow()
            await session.commit()
            return {"error": run.error}

        source_path = Path(params.get("source_path") or "")
        if not source_path.exists():
            run.status = "failed"
            run.error = f"uploaded source file missing: {source_path}"
            run.finished_at = _utcnow()
            await session.commit()
            return {"error": run.error}

        # Resolve the Gemini connection (the action will decrypt the
        # secret itself — no need to pull the api_key here).
        try:
            gemini_conn_id = UUID(params["gemini_connection_id"])
        except (KeyError, ValueError):
            run.status = "failed"
            run.error = "invalid gemini_connection_id"
            run.finished_at = _utcnow()
            source_path.unlink(missing_ok=True)
            await session.commit()
            return {"error": run.error}
        gemini_conn = await _resolve_connection(session, str(gemini_conn_id))
        if gemini_conn is None or gemini_conn.type != "gemini":
            run.status = "failed"
            run.error = "Gemini connection not found"
            run.finished_at = _utcnow()
            source_path.unlink(missing_ok=True)
            await session.commit()
            return {"error": run.error}

        prompt = str(params.get("prompt") or "")
        model = str(params.get("model") or "").strip()
        if not prompt or not model:
            run.status = "failed"
            run.error = "prompt and model are required"
            run.finished_at = _utcnow()
            source_path.unlink(missing_ok=True)
            await session.commit()
            return {"error": run.error}

        # ---- Step 1: byoa (Gemini analyze) ----
        # Reuse the existing ``gemini_analyze_video`` action rather than
        # hand-rolling the upload/poll/generate sequence here. That gets
        # us the per-phase progress emission (gemini_upload →
        # gemini_wait_active → gemini_generate) for free — identical to
        # what camera-mode runs render on the Runs page. The action just
        # needs a ``clip_path`` config field; we hand it the uploaded
        # file's path on the shared volume.
        analyze_spec = ACTIONS.get("gemini_analyze_video")
        if analyze_spec is None:
            run.status = "failed"
            run.error = "gemini_analyze_video action unavailable"
            run.finished_at = _utcnow()
            source_path.unlink(missing_ok=True)
            await session.commit()
            return {"error": run.error}

        byoa_record: dict[str, Any] = {
            "name": "byoa",
            "type": "gemini_analyze_video",
            "kind": "action",
            "started_at": _utcnow().isoformat(),
            "status": "running",
            "label": f"Analyze uploaded {params.get('media_kind') or 'media'}",
        }
        run.status = "running"
        run.started_at = _utcnow()
        run.steps = [dict(byoa_record)]
        flag_modified(run, "steps")
        await session.commit()

        analyze_config: dict[str, Any] = {
            "clip_path": str(source_path),
            "prompt": prompt,
            # gemini_analyze_video takes a comma-separated fallback
            # chain — for the workbench we just want the operator's
            # picked model. Single-entry chain = no fallback, deterministic.
            "model_chain": model,
        }
        analyze_ctx: dict[str, Any] = {
            "trigger": params,
            "steps": {},
            "_progress": _progress_for(run.id, "byoa"),
        }
        try:
            gemini_result = await analyze_spec.run(
                analyze_config, analyze_ctx, gemini_conn
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("byoa_upload analyze failed: %s", e)
            byoa_record["status"] = "failed"
            byoa_record["error"] = str(e)
            byoa_record["finished_at"] = _utcnow().isoformat()
            run.steps = [dict(byoa_record)]
            flag_modified(run, "steps")
            run.status = "failed"
            run.error = str(e)
            run.finished_at = _utcnow()
            source_path.unlink(missing_ok=True)
            await session.commit()
            return {"error": str(e)}

        byoa_record["status"] = "success"
        byoa_record["output"] = gemini_result
        byoa_record["finished_at"] = _utcnow().isoformat()
        run.steps = [dict(byoa_record)]
        flag_modified(run, "steps")
        run.output = gemini_result
        await session.commit()

        # ---- Step 2 (optional): helix preview ----
        helix_uid = params.get("helix_event_type_uid")
        conn_id_raw = params.get("connection_id")
        if not helix_uid or not conn_id_raw:
            # No paired template — done. Drop the upload file and
            # mark success.
            run.status = "success"
            run.finished_at = _utcnow()
            source_path.unlink(missing_ok=True)
            await session.commit()
            return {"status": "success"}

        preview_record: dict[str, Any] = {
            "name": "helix_preview",
            "type": "verkada_helix_event_preview",
            "kind": "action",
            "started_at": _utcnow().isoformat(),
            "status": "running",
            "label": "Helix preview (dry run — not posted)",
        }
        run.steps = [dict(byoa_record), dict(preview_record)]
        flag_modified(run, "steps")
        await session.commit()

        try:
            preview = await _compute_helix_preview(
                session,
                connection_id=UUID(conn_id_raw),
                event_type_uid=str(helix_uid),
                gemini_json=gemini_result.get("json"),
                gemini_text=str(gemini_result.get("text") or ""),
                helix_attribute_mapping=params.get("helix_attribute_mapping"),
                helix_attribute=params.get("helix_attribute"),
                camera_id=None,
                inline_schema=params.get("helix_event_schema"),
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("byoa_upload helix preview failed: %s", e)
            preview_record["status"] = "failed"
            preview_record["error"] = str(e)
            preview_record["finished_at"] = _utcnow().isoformat()
            run.steps = [dict(byoa_record), dict(preview_record)]
            flag_modified(run, "steps")
            # Don't fail the whole run — the analyze succeeded, the
            # preview is best-effort. Mark the run as "success" and
            # let the operator see the preview step's error.
            run.status = "success"
            run.finished_at = _utcnow()
            source_path.unlink(missing_ok=True)
            await session.commit()
            return {"status": "success", "warning": f"preview failed: {e}"}

        # Shape the preview output so the Runs page can reuse the same
        # extraction path as ``verkada_helix_event`` real posts: read
        # ``output.request_body.attributes``. The extra dry_run flag at
        # the top level is what HelixPostSummary will switch on to
        # render the alternate "would have posted" header.
        preview_record["status"] = "success"
        preview_record["output"] = {
            "dry_run": True,
            "request_body": {
                "event_type_uid": preview["event_type_uid"],
                "camera_id": preview["camera_id"],
                "time_ms": preview["time_ms"],
                "attributes": preview["attributes"],
            },
            "event_schema": preview["event_schema"],
        }
        preview_record["finished_at"] = _utcnow().isoformat()
        run.steps = [dict(byoa_record), dict(preview_record)]
        flag_modified(run, "steps")
        run.status = "success"
        run.finished_at = _utcnow()
        source_path.unlink(missing_ok=True)
        await session.commit()
        return {"status": "success"}


class WorkerSettings:
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    functions = [run_flow, run_byoa, run_byoa_upload]
    cron_jobs = [
        cron(sync_verkada_cameras_cron, hour=3, minute=17, run_at_startup=False),
        cron(
            crawl_verkada_catalog_cron,
            hour={0, 4, 8, 12, 16, 20},
            minute=7,
            run_at_startup=True,
        ),
        # Hourly: drop webhook media older than 24h.
        cron(cleanup_assets_cron, minute=23),
        # Daily 04:11 UTC: refresh Gemini pricing snapshot. run_at_startup
        # so first deploy populates the table before any flow runs.
        cron(refresh_gemini_pricing_cron, hour=4, minute=11, run_at_startup=True),
        # Every minute: fire any due schedule-trigger flows.
        cron(tick_schedule_flows, minute=set(range(60))),
    ]
    max_tries = 1
