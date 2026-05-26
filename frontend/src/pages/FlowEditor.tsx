import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Background,
  Connection as RFConnection,
  Controls,
  Edge,
  Node,
  NodeChange,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import {
  ActionSpec,
  apiGet,
  apiPost,
  apiPut,
  Flow,
  FlowEdge,
  FlowExportFormat,
  FlowNode,
  HelixEventTypeDef,
  RunDetail,
  RunStep,
  WebhookEvent,
} from "../lib/api";
import HelixBootstrapModal from "../components/HelixBootstrapModal";
import ActionNode from "../components/flow-canvas/ActionNode";
import ConditionNode from "../components/flow-canvas/ConditionNode";
import TriggerNode from "../components/flow-canvas/TriggerNode";
import StepConfigForm from "../components/StepConfigForm";
import TestRunModal from "../components/TestRunModal";
import TriggerConfigForm, {
  triggerStateFromConfig,
  triggerStateToConfig,
  TriggerConfigState,
} from "../components/TriggerConfigForm";
import ScheduleTriggerForm, {
  scheduleStateFromConfig,
  scheduleStateToConfig,
  ScheduleConfigState,
} from "../components/ScheduleTriggerForm";
import { uuid } from "../lib/ids";


const NODE_TYPES = { trigger: TriggerNode, action: ActionNode, condition: ConditionNode };
const COL_X = 320;
const ROW_Y = 200;
const TRIGGER_ID = "__trigger__";


interface Selection {
  kind: "trigger" | "node" | "edge" | "none";
  id?: string;
}


export default function FlowEditor() {
  return (
    <ReactFlowProvider>
      <FlowEditorInner />
    </ReactFlowProvider>
  );
}


function FlowEditorInner() {
  const { id: flowId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isNew = flowId === "new" || !flowId;

  const existing = useQuery({
    queryKey: ["flow", flowId],
    queryFn: () => apiGet<Flow>(`/api/flows/${flowId}`),
    enabled: !isNew,
  });

  const actionSpecs = useQuery({
    queryKey: ["action-types"],
    queryFn: () => apiGet<Record<string, ActionSpec>>("/api/flows/actions"),
  });

  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [triggerType, setTriggerType] = useState<"verkada_webhook" | "schedule">(
    "verkada_webhook",
  );
  const [trigger, setTrigger] = useState<TriggerConfigState>(
    triggerStateFromConfig(undefined)
  );
  const [schedule, setSchedule] = useState<ScheduleConfigState>(
    scheduleStateFromConfig(undefined),
  );
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [selected, setSelected] = useState<Selection>({ kind: "trigger" });
  const [picker, setPicker] = useState<{
    sourceId: string;
    branch: "true" | "false" | null;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Sticky reference to the webhook event that seeded this flow, used to
  // pre-pick the test-run sample. Falls back to recent matching events.
  const [sourceEventId, setSourceEventId] = useState<string | null>(null);
  const [testRunOpen, setTestRunOpen] = useState(false);
  const [saveAsTemplateOpen, setSaveAsTemplateOpen] = useState(false);

  // When the operator clicks "+ Add Helix logging step" under a paired
  // prompt, we open the existing bootstrap modal to create the helix
  // type on their Verkada org and then insert a downstream
  // verkada_helix_event node wired with whatever uid the bootstrap
  // returned. Holds the pending def + mapping + source step until the
  // modal closes.
  const [pendingPairedHelix, setPendingPairedHelix] = useState<{
    def: HelixEventTypeDef;
    mapping: Record<string, string>;
    sourceStepId: string;
    sourceStepName: string;
  } | null>(null);

  // When the operator hits "Run" on the trigger card we keep them on
  // the canvas and poll the run so the nodes + edges can light up as
  // each step fires. ``null`` means no active run is being tracked —
  // nodes render in their resting state.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const activeRun = useQuery({
    queryKey: ["run", activeRunId],
    queryFn: () => apiGet<RunDetail>(`/api/runs/${activeRunId}`),
    enabled: !!activeRunId,
    // Aggressive polling while the run is still in motion; stops as
    // soon as the run terminates so we don't hammer the backend after
    // the fireworks are over.
    refetchInterval: (q) => {
      const s = (q.state.data as RunDetail | undefined)?.status;
      return s === "pending" || s === "running" ? 500 : false;
    },
  });

  // Map step.name -> current status, used by the canvas to paint
  // nodes + edges. Defensive against missing data (run not loaded yet
  // / step name mismatch) — anything without an entry renders normally.
  const stepStatusByName: Record<string, RunStep["status"]> = {};
  for (const s of activeRun.data?.steps ?? []) {
    stepStatusByName[s.name] = s.status;
  }
  const runOverallStatus = activeRun.data?.status ?? null;

  const fromEventId = searchParams.get("from_event");
  useEffect(() => {
    if (!isNew || !fromEventId) return;
    let cancelled = false;
    setSourceEventId(fromEventId);
    apiGet<WebhookEvent>(`/api/webhook-events/${fromEventId}`)
      .then((ev) => {
        if (cancelled) return;
        if (!ev.family || ev.family === "unknown") return;
        const data =
          ev.body_json && typeof ev.body_json === "object" && !Array.isArray(ev.body_json)
            ? ((ev.body_json as Record<string, unknown>).data as
                | Record<string, unknown>
                | undefined)
            : undefined;
        const filters: Array<{ field: string; value: string }> = [];
        const tryAdd = (k: string) => {
          if (!data) return;
          const v = data[k];
          if (typeof v === "string" && v) {
            filters.push({ field: k, value: v });
            return;
          }
          // Array fields like `objects` — backend trigger matching does
          // array-contains, so seeding the first scalar element gives the
          // user a sensible default ("objects" == "animal" etc.).
          if (Array.isArray(v) && v.length > 0) {
            const first = v[0];
            if (typeof first === "string" && first) {
              filters.push({ field: k, value: first });
            } else if (typeof first === "number" || typeof first === "boolean") {
              filters.push({ field: k, value: String(first) });
            }
          }
        };
        tryAdd("person_label");
        if (filters.length === 0) tryAdd("objects");
        if (filters.length === 0) tryAdd("license_plate_number");
        if (filters.length === 0) tryAdd("door_id");
        if (filters.length === 0) tryAdd("camera_id");
        setTrigger({
          family: ev.family,
          notificationType: ev.notification_type ?? "",
          filters,
        });
        setSearchParams({}, { replace: true });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromEventId, isNew]);

  useEffect(() => {
    if (!existing.data) return;
    setName(existing.data.name);
    setEnabled(existing.data.enabled);
    const tt = (existing.data.trigger_type ?? "verkada_webhook") as
      | "verkada_webhook"
      | "schedule";
    setTriggerType(tt);
    if (tt === "schedule") {
      setSchedule(scheduleStateFromConfig(existing.data.trigger_config));
    } else {
      setTrigger(triggerStateFromConfig(existing.data.trigger_config));
    }
    setNodes(existing.data.nodes ?? []);
    setEdges(existing.data.edges ?? []);
  }, [existing.data]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name,
        enabled,
        trigger_type: triggerType,
        trigger_config:
          triggerType === "schedule"
            ? scheduleStateToConfig(schedule)
            : triggerStateToConfig(trigger),
        nodes,
        edges,
      };
      return isNew
        ? apiPost<Flow>("/api/flows", payload)
        : apiPut<Flow>(`/api/flows/${flowId}`, payload);
    },
    onSuccess: (flow) => {
      if (isNew) navigate(`/flows/${flow.id}/edit`, { replace: true });
      setErr(null);
    },
    onError: (e: Error) => setErr(e.message),
  });

  // Schedule-trigger "Test run" — fires the saved flow now with a
  // synthetic schedule trigger blob. Same shape the worker tick uses
  // when it dispatches a scheduled run for real.
  const scheduleTestRun = useMutation({
    mutationFn: () =>
      apiPost<{ run_id: string }>(
        `/api/flows/${flowId}/test-run`,
        {
          input: {
            schedule: true,
            fired_at: Math.floor(Date.now() / 1000),
            kind: schedule.kind,
            config: scheduleStateToConfig(schedule),
          },
        },
      ),
    onSuccess: (res) => navigate(`/runs?selected=${res.run_id}`),
    onError: (e: Error) => setErr(e.message),
  });

  const uniqueName = (base: string): string => {
    let i = 1;
    let candidate = base;
    const used = new Set(nodes.map((n) => n.name));
    while (used.has(candidate)) {
      i += 1;
      candidate = `${base}_${i}`;
    }
    return candidate;
  };

  const addNode = (
    kind: "action" | "condition",
    fromSourceId: string,
    branch: "true" | "false" | null = null,
  ): string => {
    const id = uuid();
    // Pick a sensible default action type:
    //   1. If the source node is a gemini analyze, the next step is almost
    //      always the helix post that logs the AI text.
    //   2. Camera-family webhooks (root step) default to the gemini pipeline.
    //   3. Everything else falls back to the generic API call.
    const sourceNode =
      fromSourceId === TRIGGER_ID
        ? null
        : nodes.find((n) => n.id === fromSourceId);
    const defaultActionType =
      sourceNode?.action_type === "gemini_analyze_camera" ||
      sourceNode?.action_type === "gemini_analyze_still_image"
        ? "verkada_helix_event"
        : sourceNode?.kind === "condition"
          ? "verkada_helix_event"
          : trigger.family === "camera"
            ? "gemini_analyze_camera"
            : "verkada_api_call";
    // Step name follows from the action: "analyze", "post_helix",
    // "unlock_door" — much more legible than "step", "step_2" in template
    // refs like {{ steps.<name>.output.* }}.
    const baseName =
      kind === "condition"
        ? "condition"
        : (actionSpecs.data?.[defaultActionType]?.default_step_name ?? "step");
    const newName = uniqueName(baseName);
    const newNode: FlowNode = {
      id,
      name: newName,
      kind,
      action_type: kind === "action" ? defaultActionType : null,
      config: kind === "condition" ? { operator: "equals" } : {},
    };
    const newEdge: FlowEdge | null =
      fromSourceId === TRIGGER_ID
        ? null
        : {
            id: uuid(),
            source: fromSourceId,
            target: id,
            branch,
          };
    setNodes([...nodes, newNode]);
    if (newEdge) setEdges([...edges, newEdge]);
    setSelected({ kind: "node", id });
    return id;
  };

  /**
   * Insert a ``verkada_helix_event`` node downstream of ``sourceStepId``,
   * pre-wired with the paired-prompt's helix metadata. The ``uidMap``
   * comes from the bootstrap modal — it rewrites the export-side
   * placeholder uid (``tpl:X``) to whatever the target Verkada org
   * actually assigned (or reused, for name matches). When the operator
   * skipped bootstrap the map is empty and the placeholder stays
   * (runtime will fail until they fix it, same as a normal template
   * import).
   *
   * The mapping's ``{{ output.* }}`` step-local refs get rewritten to
   * ``{{ steps.<sourceStepName>.output.* }}`` here so the new step's
   * attributes pull from the correct upstream output.
   */
  const insertPairedHelixStep = (
    def: HelixEventTypeDef,
    mapping: Record<string, string>,
    sourceStepId: string,
    sourceStepName: string,
    uidMap: Record<string, string>,
  ): void => {
    const resolvedUid = uidMap[def.event_type_uid] ?? def.event_type_uid;
    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(mapping)) {
      attributes[k] = v.replace(
        /\{\{\s*output\./g,
        `{{ steps.${sourceStepName}.output.`,
      );
    }
    const id = uuid();
    const newName = uniqueName("post_helix");
    const newNode: FlowNode = {
      id,
      name: newName,
      label: "Post to Helix",
      kind: "action",
      action_type: "verkada_helix_event",
      config: {
        connection_id: null,
        camera_id: "{{ trigger.data.camera_id }}",
        event_type_uid: resolvedUid,
        attributes,
        time_ms: "{{ trigger.data.created }}000",
        // Embed the helix def inline so the export collector picks it
        // up — without this, a downstream importer wouldn't see the
        // type and the bootstrap modal would have nothing to recreate.
        _inline_helix_def: {
          event_type_uid: def.event_type_uid,
          name: def.name,
          event_schema: def.event_schema,
        },
      },
    };
    const newEdge: FlowEdge = {
      id: uuid(),
      source: sourceStepId,
      target: id,
      branch: null,
    };
    setNodes([...nodes, newNode]);
    setEdges([...edges, newEdge]);
    setSelected({ kind: "node", id });
  };

  const removeNode = (id: string) => {
    // Splice the node out instead of orphaning its children. Without
    // this, deleting a middle node (e.g. a condition that's "is it a
    // bear?") drops the edges in + out, and its former children
    // re-root to the trigger as siblings — turning a linear chain
    // into a confusing fan-out. Reconnect every (parent → id) edge
    // to every (id → child) target so the remaining graph keeps the
    // same downstream wiring.
    //
    // Branch labels (true / false) are inherited from the *incoming*
    // edge so the surviving path keeps its meaning ("this used to be
    // the true branch"). De-duped via a Set so a parent that fed the
    // removed node twice doesn't materialize two identical edges.
    const incoming = edges.filter((e) => e.target === id);
    const outgoing = edges.filter((e) => e.source === id);
    const survivors = edges.filter((e) => e.source !== id && e.target !== id);
    const splicedKeys = new Set<string>();
    const spliced: typeof edges = [];
    for (const inE of incoming) {
      for (const outE of outgoing) {
        if (inE.source === outE.target) continue; // self-loop guard
        const key = `${inE.source}->${outE.target}:${inE.branch ?? ""}`;
        if (splicedKeys.has(key)) continue;
        if (
          survivors.some(
            (e) =>
              e.source === inE.source &&
              e.target === outE.target &&
              e.branch === inE.branch,
          )
        )
          continue;
        splicedKeys.add(key);
        spliced.push({
          id: uuid(),
          source: inE.source,
          target: outE.target,
          branch: inE.branch,
        });
      }
    }
    setNodes(nodes.filter((n) => n.id !== id));
    setEdges([...survivors, ...spliced]);
    if (selected.kind === "node" && selected.id === id)
      setSelected({ kind: "trigger" });
  };

  const updateNode = (id: string, patch: Partial<FlowNode>) => {
    setNodes(nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  };

  const addEdge = (source: string, target: string, branch: "true" | "false" | null) => {
    if (source === target) return;
    if (
      edges.some(
        (e) => e.source === source && e.target === target && e.branch === branch
      )
    ) {
      return;
    }
    setEdges([
      ...edges,
      { id: uuid(), source, target, branch },
    ]);
  };

  const removeEdge = (id: string) => {
    setEdges(edges.filter((e) => e.id !== id));
    if (selected.kind === "edge" && selected.id === id)
      setSelected({ kind: "trigger" });
  };

  // Discover which Verkada connection (if any) this flow has
  // already committed to. We scan every node's config for fields the
  // action spec declares as ``connection_ref`` + ``connection_type:
  // "verkada"`` and collect the resolved ids. If exactly one shows
  // up the flow is "locked" to that connection — downstream pickers
  // filter to it and auto-fill from it. If two show up we still
  // pick the first as the lock (so freshly-added steps don't pile
  // on a third org) and surface the mismatch in a banner.
  const lockedVerkadaConnectionId = useMemo<string | null>(() => {
    const specs = actionSpecs.data;
    if (!specs) return null;
    const ids: string[] = [];
    for (const n of nodes) {
      if (n.kind !== "action" || !n.action_type) continue;
      const spec = specs[n.action_type];
      if (!spec) continue;
      for (const f of spec.schema.fields) {
        if (f.type !== "connection_ref") continue;
        if (f.connection_type !== "verkada") continue;
        const v = (n.config as Record<string, unknown>)[f.name];
        if (typeof v === "string" && v) ids.push(v);
      }
    }
    return ids[0] ?? null;
  }, [nodes, actionSpecs.data]);

  // True if any node's Verkada connection picker disagrees with the
  // lock. We surface this as a banner so the operator notices before
  // the flow runs and posts events into the wrong org.
  const verkadaConnectionMismatch = useMemo<boolean>(() => {
    if (!lockedVerkadaConnectionId) return false;
    const specs = actionSpecs.data;
    if (!specs) return false;
    for (const n of nodes) {
      if (n.kind !== "action" || !n.action_type) continue;
      const spec = specs[n.action_type];
      if (!spec) continue;
      for (const f of spec.schema.fields) {
        if (f.type !== "connection_ref") continue;
        if (f.connection_type !== "verkada") continue;
        const v = (n.config as Record<string, unknown>)[f.name];
        if (typeof v === "string" && v && v !== lockedVerkadaConnectionId) {
          return true;
        }
      }
    }
    return false;
  }, [nodes, actionSpecs.data, lockedVerkadaConnectionId]);

  // Auto-layout positions for nodes that don't have a persisted position.
  // User-dragged nodes (node.position set) win — that's the snapping lock.
  const layout = computeLayout(nodes, edges);
  const posFor = (node: FlowNode) =>
    node.position ?? layout.get(node.id) ?? { x: 0, y: ROW_Y };

  const autoArrange = () => {
    // Wipe persisted positions so every node falls back to computeLayout.
    setNodes(nodes.map((n) => ({ ...n, position: null })));
  };

  // Apply React Flow's position changes back to our nodes state as they
  // happen during a drag. Without this RF holds the new position
  // internally but every parent re-render slams the prop position back to
  // the previous value, so the node visually freezes until drag-stop.
  // Selection / dimension changes are ignored — we manage those ourselves.
  const onNodesChange = (changes: NodeChange[]) => {
    let dirty = false;
    let next = nodes;
    for (const c of changes) {
      if (
        c.type === "position" &&
        c.position &&
        c.id !== TRIGGER_ID
      ) {
        next = next.map((n) =>
          n.id === c.id ? { ...n, position: c.position! } : n,
        );
        dirty = true;
      }
    }
    if (dirty) setNodes(next);
  };

  // Fire the saved flow as if a trigger had just landed. For schedule
  // flows we synthesize the same blob the worker tick produces. Webhook
  // flows open the existing TestRunModal so the operator can pick a
  // sample event. Either way we capture the run_id and let the polling
  // hook light up the canvas — no navigation away.
  const handleRunFromCanvas = async () => {
    if (isNew || !flowId) return;
    setErr(null);
    // Auto-save first so the run executes against the on-screen
    // config, not whatever was last persisted. Same foot-gun fix as
    // the "Test run" button in the toolbar.
    try {
      await save.mutateAsync();
    } catch {
      return;
    }
    if (triggerType === "schedule") {
      apiPost<{ run_id: string }>(`/api/flows/${flowId}/test-run`, {
        input: {
          schedule: true,
          fired_at: Math.floor(Date.now() / 1000),
          kind: schedule.kind,
          config: scheduleStateToConfig(schedule),
        },
      })
        .then((res) => setActiveRunId(res.run_id))
        .catch((e: Error) => setErr(e.message));
    } else {
      // Webhook → reuse the existing modal flow but capture the run_id
      // into activeRunId so playback stays on-canvas.
      setTestRunOpen(true);
    }
  };

  const rfNodes: Node[] = [
    {
      id: TRIGGER_ID,
      type: "trigger",
      position: { x: COL_X, y: 0 },
      data: {
        trigger_type: triggerType,
        trigger_config:
          triggerType === "schedule"
            ? scheduleStateToConfig(schedule)
            : triggerStateToConfig(trigger),
        onAddChild: () => setPicker({ sourceId: TRIGGER_ID, branch: null }),
        onRunNow: !isNew && flowId ? handleRunFromCanvas : undefined,
        runActive: !!activeRunId,
        runOverallStatus,
      },
      selected: selected.kind === "trigger",
      draggable: false,
    },
    ...nodes.map<Node>((node) => {
      const pos = posFor(node);
      const outgoingCount = edges.filter((e) => e.source === node.id).length;
      const runStatus = stepStatusByName[node.name];
      const conditionSpec = actionSpecs.data?._condition;
      const actionSpec = actionSpecs.data?.[node.action_type ?? ""];
      // Condition nodes use the synthetic ``_condition`` spec for
      // required-field validation; action nodes use their own spec.
      const missingRequired = missingRequiredFields(
        node,
        node.kind === "condition" ? conditionSpec : actionSpec,
      );
      if (node.kind === "condition") {
        return {
          id: node.id,
          type: "condition",
          position: pos,
          data: {
            node,
            canRemove: true,
            onRemove: () => removeNode(node.id),
            onAddBranch: (branch: "true" | "false") =>
              setPicker({ sourceId: node.id, branch }),
            runStatus,
            missingRequired,
          },
          selected: selected.kind === "node" && selected.id === node.id,
          draggable: true,
        };
      }
      return {
        id: node.id,
        type: "action",
        position: pos,
        data: {
          node,
          spec: actionSpec,
          canRemove: true,
          outgoingCount,
          onRemove: () => removeNode(node.id),
          onAddChild: () => setPicker({ sourceId: node.id, branch: null }),
          runStatus,
          missingRequired,
        },
        selected: selected.kind === "node" && selected.id === node.id,
        draggable: true,
      };
    }),
  ];

  const rfEdges: Edge[] = edges.map<Edge>((e) => {
    const sourceNode = nodes.find((n) => n.id === e.source);
    const targetNode = nodes.find((n) => n.id === e.target);
    const isCondition = sourceNode?.kind === "condition";
    const branchColor =
      e.branch === "true" ? "#34d399" : e.branch === "false" ? "#fb7185" : "#475569";
    // Run-state edge styling: when the target step is currently running,
    // pull the edge forward with a brighter stroke + thicker line so the
    // viewer's eye follows where the action is. Completed-to-completed
    // edges get a faint emerald tint to show "path taken".
    const tgtStatus = targetNode ? stepStatusByName[targetNode.name] : undefined;
    const srcStatus = sourceNode ? stepStatusByName[sourceNode.name] : undefined;
    let stroke = branchColor;
    let strokeWidth = 1.5;
    if (tgtStatus === "running") {
      stroke = "#38bdf8"; // sky-400 — "live"
      strokeWidth = 2.5;
    } else if (
      (srcStatus === "success" || srcStatus === undefined) &&
      (tgtStatus === "success" || tgtStatus === "failed")
    ) {
      stroke = tgtStatus === "failed" ? "#fb7185" : "#34d399";
      strokeWidth = 2;
    }
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: isCondition ? e.branch : undefined,
      animated: true,
      label: e.branch ?? undefined,
      labelStyle: {
        fill:
          e.branch === "true"
            ? "#34d399"
            : e.branch === "false"
              ? "#fb7185"
              : "#94a3b8",
        fontSize: 11,
        fontWeight: 600,
      },
      labelBgStyle: { fill: "#0f172a", fillOpacity: 0.9 },
      style: { stroke, strokeWidth },
      selected: selected.kind === "edge" && selected.id === e.id,
    };
  });

  // Implicit trigger → root-node edges so the canvas reads top-down.
  // These get the same run-state treatment as the explicit edges so a
  // live run lights up the trigger → first step transition too.
  const triggerEdges: Edge[] = nodes
    .filter((n) => !edges.some((e) => e.target === n.id))
    .map((n) => {
      const tgtStatus = stepStatusByName[n.name];
      let stroke = "#475569";
      let strokeWidth = 1.5;
      if (tgtStatus === "running") {
        stroke = "#38bdf8";
        strokeWidth = 2.5;
      } else if (tgtStatus === "success" || tgtStatus === "failed") {
        stroke = tgtStatus === "failed" ? "#fb7185" : "#34d399";
        strokeWidth = 2;
      }
      return {
        id: `${TRIGGER_ID}-${n.id}`,
        source: TRIGGER_ID,
        target: n.id,
        animated: true,
        selectable: false,
        style: { stroke, strokeWidth },
      };
    });

  const handleConnect = (c: RFConnection) => {
    if (!c.source || !c.target) return;
    if (c.source === TRIGGER_ID || c.target === TRIGGER_ID) return;
    const sourceNode = nodes.find((n) => n.id === c.source);
    const branch =
      sourceNode?.kind === "condition" &&
      (c.sourceHandle === "true" || c.sourceHandle === "false")
        ? (c.sourceHandle as "true" | "false")
        : null;
    addEdge(c.source, c.target, branch);
  };

  const handleExport = async () => {
    // Only meaningful for a saved flow — there's no server-side flow row
    // to read otherwise. The Save / Export buttons disable accordingly.
    if (isNew || !flowId) return;
    setErr(null);
    try {
      const data = await apiGet<FlowExportFormat>(`/api/flows/${flowId}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Filename: <flow-name>.vfusion.json, sanitised for filesystems.
      const slug = (name || "flow").replace(/[^a-z0-9\-_.]+/gi, "_") || "flow";
      a.download = `${slug}.vfusion.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSave = () => {
    setErr(null);
    if (!name.trim()) {
      setErr("Name is required.");
      return;
    }
    if (nodes.length === 0) {
      setErr("Add at least one step.");
      return;
    }
    const seenNames = new Set<string>();
    for (const n of nodes) {
      if (!n.name.trim()) {
        setErr(`Node ${n.id}: name is required.`);
        return;
      }
      if (seenNames.has(n.name)) {
        setErr(`Duplicate node name "${n.name}".`);
        return;
      }
      seenNames.add(n.name);
      if (n.kind === "action") {
        const spec = actionSpecs.data?.[n.action_type ?? ""];
        for (const f of spec?.schema?.fields ?? []) {
          const v = n.config[f.name];
          const empty =
            v === undefined ||
            v === null ||
            (typeof v === "string" && v.trim() === "");
          if (f.required && empty) {
            setErr(`Node "${n.name}": ${f.label} is required.`);
            return;
          }
        }
      }
      if (n.kind === "condition") {
        const op = (n.config.operator as string) ?? "equals";
        const unary = op === "exists" || op === "not_exists";
        const left = n.config.left;
        if (left === undefined || left === null || (typeof left === "string" && !left.trim())) {
          setErr(`Condition "${n.name}": left value is required.`);
          return;
        }
        if (!unary) {
          const right = n.config.right;
          if (right === undefined || right === null || (typeof right === "string" && !right.trim())) {
            setErr(`Condition "${n.name}": right value is required (or use exists/not_exists).`);
            return;
          }
        }
      }
    }
    save.mutate();
  };

  useEffect(() => {
    if (selected.kind !== "edge") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        const tgt = e.target as HTMLElement | null;
        if (
          tgt &&
          (tgt.tagName === "INPUT" ||
            tgt.tagName === "TEXTAREA" ||
            tgt.isContentEditable)
        ) {
          return;
        }
        removeEdge(selected.id!);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const selectedNode =
    selected.kind === "node" ? nodes.find((n) => n.id === selected.id) : null;
  const selectedEdge =
    selected.kind === "edge" ? edges.find((e) => e.id === selected.id) : null;

  return (
    <div className="fixed inset-x-0 top-14 bottom-0 flex flex-col">
      <div className="px-4 py-2 border-b border-white/10 bg-black/40 backdrop-blur-md flex items-center gap-3 shrink-0">
        <Link to="/flows" className="text-xs text-slate-500 hover:text-slate-200">
          ← Flows
        </Link>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="flow name"
          className="px-2 py-1 rounded bg-white/5 border border-white/15 text-sm w-72 focus:outline-none focus:border-sky-500"
        />
        <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          enabled
        </label>
        <div className="ml-auto flex items-center gap-2">
          {err && (
            <span className="text-xs text-rose-300 max-w-md truncate" title={err}>
              {err}
            </span>
          )}
          {activeRunId && (
            <div className="flex items-center gap-2 text-xs px-2 py-1 rounded border border-sky-700/60 bg-sky-950/50 text-sky-100">
              <span
                className={`inline-block w-2 h-2 rounded-full ${
                  runOverallStatus === "running" || runOverallStatus === "pending"
                    ? "bg-sky-400 animate-pulse"
                    : runOverallStatus === "failed"
                      ? "bg-rose-400"
                      : "bg-emerald-400"
                }`}
              />
              <span className="capitalize">
                {runOverallStatus ?? "starting"}
              </span>
              <Link
                to={`/runs?selected=${activeRunId}`}
                className="text-sky-300 hover:underline"
              >
                view full
              </Link>
              <button
                type="button"
                onClick={() => setActiveRunId(null)}
                title="Stop tracking this run on the canvas (the run itself keeps going on the server)"
                className="text-slate-400 hover:text-slate-200"
              >
                ×
              </button>
            </div>
          )}
          <button
            onClick={autoArrange}
            disabled={nodes.length === 0}
            title="Reset all node positions to the automatic layout"
            className="text-sm px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15 text-slate-100 border border-white/15 disabled:opacity-50"
          >
            Auto arrange
          </button>
          <button
            onClick={async () => {
              // Always save before testing. Without this, an operator
              // who tweaks a step then jumps straight to Test run sees
              // the *previous* persisted config execute — the
              // hard-to-debug "I changed the connection but it still
              // errors" foot-gun. Auto-save first; if it fails (bad
              // validation, etc.) bail and surface the error rather
              // than silently running stale config.
              try {
                await save.mutateAsync();
              } catch {
                return;
              }
              if (triggerType === "schedule") {
                // No webhook payload to seed from — fire synthetically.
                scheduleTestRun.mutate();
              } else {
                setTestRunOpen(true);
              }
            }}
            disabled={
              isNew || save.isPending || scheduleTestRun.isPending
            }
            title={
              isNew
                ? "Save the flow first to test it"
                : triggerType === "schedule"
                  ? "Save and fire this scheduled flow right now"
                  : "Save and run this flow with a past webhook payload"
            }
            className="text-sm px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15 text-slate-100 border border-white/15 disabled:opacity-50"
          >
            {save.isPending
              ? "Saving…"
              : scheduleTestRun.isPending
                ? "Starting…"
                : "Test run"}
          </button>
          <button
            onClick={handleExport}
            disabled={isNew || save.isPending}
            title={
              isNew
                ? "Save the flow first to export it"
                : "Download this flow as JSON to share or import elsewhere"
            }
            className="text-sm px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15 text-slate-100 border border-white/15 disabled:opacity-50"
          >
            Export
          </button>
          <button
            onClick={() => setSaveAsTemplateOpen(true)}
            disabled={isNew || save.isPending || nodes.length === 0}
            title={
              isNew
                ? "Save the flow first to promote it to a template"
                : "Save this flow as a reusable template (connections stripped)"
            }
            className="text-sm px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15 text-slate-100 border border-white/15 disabled:opacity-50"
          >
            Save as template
          </button>
          <button
            onClick={handleSave}
            disabled={save.isPending}
            className="text-sm px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 relative min-h-0">
          {verkadaConnectionMismatch && (
            // Cross-org flow alarm. Absolutely-positioned over the
            // canvas so it doesn't steal layout — operator can dismiss
            // it by fixing the mismatched picker.
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-2 rounded-md border border-rose-700/70 bg-rose-950/80 text-rose-100 text-xs max-w-md text-center shadow-lg">
              ⚠ This flow has steps pointing at different Verkada
              connections. A flow should stay inside one org —
              re-pick the offending step's connection so events
              don't get split between orgs.
            </div>
          )}
          <ReactFlow
            nodes={rfNodes}
            edges={[...triggerEdges, ...rfEdges]}
            nodeTypes={NODE_TYPES}
            onConnect={handleConnect}
            onNodeClick={(_e, node) => {
              if (node.id === TRIGGER_ID) setSelected({ kind: "trigger" });
              else setSelected({ kind: "node", id: node.id });
            }}
            onNodesChange={onNodesChange}
            onEdgeClick={(_e, edge) => {
              if (edge.source === TRIGGER_ID) return;
              setSelected({ kind: "edge", id: edge.id });
            }}
            onPaneClick={() => setPicker(null)}
            proOptions={{ hideAttribution: true }}
            fitView
            minZoom={0.3}
            maxZoom={1.5}
            className="!bg-transparent"
          >
            <Background color="rgba(255,255,255,0.08)" gap={20} />
            <Controls position="bottom-right" />
          </ReactFlow>

          {picker && (
            <NodeTypePicker
              onCancel={() => setPicker(null)}
              onPick={(kind) => {
                addNode(kind, picker.sourceId, picker.branch);
                setPicker(null);
              }}
            />
          )}
          {testRunOpen && flowId && !isNew && (
            <TestRunModal
              flowId={flowId}
              family={trigger.family || null}
              notificationType={trigger.notificationType || null}
              filters={trigger.filters}
              defaultEventId={sourceEventId}
              onClose={() => setTestRunOpen(false)}
              onRun={(runId) => {
                // Stay on the canvas — the polling hook will light up
                // each node as the run progresses. A "View run details"
                // banner appears so the operator can still jump to the
                // Runs page if they want the full transcript.
                setTestRunOpen(false);
                setActiveRunId(runId);
              }}
            />
          )}
          {saveAsTemplateOpen && (
            <SaveAsTemplateModal
              flowId={isNew ? null : flowId ?? null}
              defaultName={name}
              triggerType={triggerType}
              triggerConfig={
                triggerType === "schedule"
                  ? scheduleStateToConfig(schedule)
                  : triggerStateToConfig(trigger)
              }
              nodes={nodes}
              edges={edges}
              onClose={() => setSaveAsTemplateOpen(false)}
            />
          )}
          {pendingPairedHelix && (
            <HelixBootstrapModal
              defs={[pendingPairedHelix.def]}
              intent="insert"
              onCancel={() => setPendingPairedHelix(null)}
              onConfirm={(uidMap) => {
                insertPairedHelixStep(
                  pendingPairedHelix.def,
                  pendingPairedHelix.mapping,
                  pendingPairedHelix.sourceStepId,
                  pendingPairedHelix.sourceStepName,
                  uidMap,
                );
                setPendingPairedHelix(null);
              }}
            />
          )}
        </div>

        <aside className="w-[28rem] border-l border-white/10 bg-black/40 backdrop-blur-md flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-white/10 shrink-0">
            <div className="text-xs uppercase tracking-wider text-slate-500">
              Configure
            </div>
            <div className="text-sm font-medium text-slate-100 mt-0.5">
              {selected.kind === "trigger"
                ? "Trigger — Verkada webhook"
                : selected.kind === "node"
                  ? selectedNode
                    ? `${selectedNode.kind === "condition" ? "Condition" : "Action"} — ${selectedNode.name}`
                    : "—"
                  : selected.kind === "edge"
                    ? `Edge — ${selectedEdge?.branch ?? "always"}`
                    : "Select a node or edge"}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {selected.kind === "trigger" && (
              <div className="space-y-4">
                <div>
                  <div className="text-xs font-medium text-slate-300 mb-1">
                    Trigger type <span className="text-rose-400">*</span>
                  </div>
                  <div className="flex gap-2">
                    <TriggerKindBtn
                      active={triggerType === "verkada_webhook"}
                      onClick={() => setTriggerType("verkada_webhook")}
                      label="Verkada webhook"
                    />
                    <TriggerKindBtn
                      active={triggerType === "schedule"}
                      onClick={() => setTriggerType("schedule")}
                      label="Schedule"
                    />
                  </div>
                </div>
                {triggerType === "verkada_webhook" ? (
                  <TriggerConfigForm value={trigger} onChange={setTrigger} />
                ) : (
                  <ScheduleTriggerForm
                    value={schedule}
                    onChange={setSchedule}
                  />
                )}
              </div>
            )}
            {selected.kind === "node" && selectedNode && (
              <NodeEditor
                node={selectedNode}
                allSpecs={actionSpecs.data ?? {}}
                lockedVerkadaConnectionId={lockedVerkadaConnectionId}
                triggerFamily={trigger.family}
                triggerNotificationType={trigger.notificationType}
                flowId={isNew ? null : (flowId ?? null)}
                flowSaved={!isNew && !save.isPending}
                sampleOutput={existing.data?.node_samples?.[selectedNode.id]}
                priorSteps={priorStepsFor(
                  selectedNode.id,
                  nodes,
                  edges,
                  actionSpecs.data,
                  existing.data?.node_samples,
                )}
                onChangeName={(n) => updateNode(selectedNode.id, { name: n })}
                onChangeLabel={(l) =>
                  updateNode(selectedNode.id, { label: l || null })
                }
                // Suppress the "+ Add Helix logging step" affordance when
                // the flow already has a Helix event step downstream — no
                // sense offering to insert a duplicate. The template apply
                // path lands here pre-wired, so the affordance was firing
                // even for templates that already include the Helix step.
                onAddPairedHelixStep={
                  hasDownstreamHelixStep(selectedNode.id, nodes, edges)
                    ? undefined
                    : ({
                        helix_event_type,
                        helix_attribute_mapping,
                        sourceStepName,
                      }) =>
                        setPendingPairedHelix({
                          def: {
                            event_type_uid: helix_event_type.event_type_uid,
                            name: helix_event_type.name,
                            event_schema: helix_event_type.event_schema,
                          },
                          mapping: helix_attribute_mapping,
                          sourceStepId: selectedNode.id,
                          sourceStepName,
                        })
                }
                onChangeActionType={(t) => {
                  // If the current name still matches a known default
                  // (e.g. "analyze", "post_helix", possibly suffixed _2),
                  // update it to the new action's default. Don't touch
                  // user-renamed nodes.
                  const allDefaults = new Set(
                    Object.values(actionSpecs.data ?? {})
                      .map((s) => s.default_step_name)
                      .filter(Boolean) as string[],
                  );
                  allDefaults.add("step");
                  const stripped = selectedNode.name.replace(/_\d+$/, "");
                  const newDefault =
                    actionSpecs.data?.[t]?.default_step_name ?? "step";
                  const namePatch = allDefaults.has(stripped)
                    ? { name: uniqueName(newDefault) }
                    : {};
                  updateNode(selectedNode.id, {
                    action_type: t,
                    config: {},
                    ...namePatch,
                  });
                }}
                onChangeConfig={(c) => {
                  // Auto-mirror camera_id from a Gemini analyze step to
                  // any downstream verkada_helix_event nodes — the
                  // event almost always wants to land on the same
                  // camera the analysis came from. We only push when
                  // the helix node's camera_id is blank or still
                  // matches the analyze step's *previous* value
                  // (template default included), so an operator who
                  // intentionally points the helix step at a
                  // different camera doesn't get overwritten.
                  const prev = selectedNode.config ?? {};
                  const prevCamera = (prev.camera_id as string) ?? "";
                  const nextCamera = (c.camera_id as string) ?? "";
                  updateNode(selectedNode.id, { config: c });
                  if (
                    (selectedNode.action_type ?? "").startsWith(
                      "gemini_analyze",
                    ) &&
                    prevCamera !== nextCamera
                  ) {
                    const downstream = downstreamHelixSteps(
                      selectedNode.id,
                      nodes,
                      edges,
                    );
                    for (const helix of downstream) {
                      const helixCamera =
                        (helix.config?.camera_id as string) ?? "";
                      const matchesPrev =
                        helixCamera === "" || helixCamera === prevCamera;
                      if (matchesPrev) {
                        updateNode(helix.id, {
                          config: {
                            ...(helix.config ?? {}),
                            camera_id: nextCamera,
                          },
                        });
                      }
                    }
                  }
                }}
              />
            )}
            {selected.kind === "edge" && selectedEdge && (
              <EdgeEditor
                edge={selectedEdge}
                sourceNode={nodes.find((n) => n.id === selectedEdge.source)}
                onChangeBranch={(branch) =>
                  setEdges(
                    edges.map((e) =>
                      e.id === selectedEdge.id ? { ...e, branch } : e
                    )
                  )
                }
                onRemove={() => removeEdge(selectedEdge.id)}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}


function TriggerKindBtn({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-3 py-1.5 rounded border text-xs ${
        active
          ? "bg-sky-950/50 border-sky-500 text-sky-100"
          : "bg-white/5 border-white/15 text-slate-300 hover:border-sky-500"
      }`}
    >
      {label}
    </button>
  );
}


/** BFS forward from ``nodeId`` returning every ``verkada_helix_event``
 *  node found along any downstream path. Used both for the
 *  "needs no insertion" check (hasDownstreamHelixStep) and the
 *  auto-mirror-camera_id path. Visits each node at most once. */
function downstreamHelixSteps(
  nodeId: string,
  nodes: FlowNode[],
  edges: FlowEdge[],
): FlowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const outgoing = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    outgoing.get(e.source)!.push(e);
  }
  const visited = new Set<string>();
  const queue: string[] = [nodeId];
  const result: FlowNode[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    for (const e of outgoing.get(current) ?? []) {
      if (visited.has(e.target)) continue;
      visited.add(e.target);
      const n = byId.get(e.target);
      if (!n) continue;
      if (n.action_type === "verkada_helix_event") result.push(n);
      queue.push(n.id);
    }
  }
  return result;
}


/** Convenience boolean over ``downstreamHelixSteps`` for the "suppress
 *  + Add Helix logging step" affordance — see the call site. */
function hasDownstreamHelixStep(
  nodeId: string,
  nodes: FlowNode[],
  edges: FlowEdge[],
): boolean {
  return downstreamHelixSteps(nodeId, nodes, edges).length > 0;
}


/** List the labels of any required fields on this action that are
 *  currently unfilled. Returns an empty list when the action is fully
 *  configured (or when we don't know the spec — better to render no
 *  warning than a false positive).
 *
 *  Considers a value "filled" when it's any non-empty, non-null,
 *  non-blank string / object / array. Numbers and booleans count even
 *  when 0 / false — they're explicit choices. ``connection_id``s are
 *  validated by literal presence; we don't dereference to confirm the
 *  connection still exists (saved flows can outlive a connection
 *  deletion). Template refs like ``{{ trigger.data.camera_id }}`` are
 *  considered filled — they resolve at run time, not edit time.
 */
function missingRequiredFields(
  node: FlowNode,
  spec: ActionSpec | undefined,
): string[] {
  if (!spec || node.kind !== "action") return [];
  const cfg = node.config ?? {};
  const missing: string[] = [];
  for (const f of spec.schema.fields ?? []) {
    if (!f.required) continue;
    const value = cfg[f.name];
    const filled =
      value !== undefined &&
      value !== null &&
      !(typeof value === "string" && value.trim() === "") &&
      !(Array.isArray(value) && value.length === 0);
    if (!filled) missing.push(f.label || f.name);
  }
  return missing;
}


function priorStepsFor(
  nodeId: string,
  nodes: FlowNode[],
  edges: FlowEdge[],
  specs: Record<string, ActionSpec> | undefined,
  nodeSamples?: Record<string, unknown> | null,
): Array<{ name: string; output_sample: unknown }> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const incoming = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e);
  }
  const visited = new Set<string>();
  const queue: string[] = [nodeId];
  const result: FlowNode[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    for (const e of incoming.get(current) ?? []) {
      if (visited.has(e.source)) continue;
      visited.add(e.source);
      const n = byId.get(e.source);
      if (n) {
        result.push(n);
        queue.push(n.id);
      }
    }
  }
  return result.map((n) => {
    // Prefer a real captured sample (from "Run this step") over the
    // action's canned output_sample so the variable picker shows keys
    // that actually exist for this flow.
    const captured = nodeSamples ? nodeSamples[n.id] : undefined;
    if (captured !== undefined && captured !== null) {
      return { name: n.name, output_sample: captured };
    }
    const spec =
      n.kind === "condition" ? specs?._condition : specs?.[n.action_type ?? ""];
    return { name: n.name, output_sample: spec?.output_sample };
  });
}


function NodeEditor({
  node,
  allSpecs,
  triggerFamily,
  triggerNotificationType,
  priorSteps,
  onChangeName,
  onChangeLabel,
  onChangeActionType,
  onChangeConfig,
  onAddPairedHelixStep,
  flowId,
  flowSaved,
  sampleOutput,
  lockedVerkadaConnectionId,
}: {
  node: FlowNode;
  allSpecs: Record<string, ActionSpec>;
  triggerFamily?: string;
  triggerNotificationType?: string;
  priorSteps: Array<{ name: string; output_sample: unknown }>;
  onChangeName: (n: string) => void;
  onChangeLabel: (l: string) => void;
  onChangeActionType: (t: string) => void;
  onChangeConfig: (c: Record<string, unknown>) => void;
  onAddPairedHelixStep?: React.ComponentProps<typeof StepConfigForm>["onAddPairedHelixStep"];
  flowId: string | null;
  flowSaved: boolean;
  sampleOutput?: unknown;
  lockedVerkadaConnectionId?: string | null;
}) {
  const isCondition = node.kind === "condition";
  const spec = isCondition ? allSpecs._condition : allSpecs[node.action_type ?? ""];
  const actionOnlySpecs = Object.entries(allSpecs).filter(
    ([key, s]) => s.kind === "action" && !key.startsWith("_")
  );
  const qc = useQueryClient();
  const [runErr, setRunErr] = useState<string | null>(null);
  const [runOutput, setRunOutput] = useState<unknown>(sampleOutput);
  useEffect(() => {
    setRunOutput(sampleOutput);
  }, [sampleOutput, node.id]);
  const runNode = useMutation({
    mutationFn: () =>
      apiPost<{ output?: unknown; error?: string | null }>(
        `/api/flows/${flowId}/run-node`,
        { node_id: node.id },
      ),
    onSuccess: (res) => {
      if (res.error) {
        setRunErr(res.error);
        setRunOutput(null);
      } else {
        setRunErr(null);
        setRunOutput(res.output ?? null);
        // Re-fetch the flow so node_samples updates everywhere
        // (variable picker, this panel on re-select, etc.).
        qc.invalidateQueries({ queryKey: ["flow", flowId] });
      }
    },
    onError: (e: Error) => setRunErr(e.message),
  });
  return (
    <div className="space-y-4">
      <Field
        label="Display label"
        help="Shown on the canvas. Leave blank to fall back to the identifier name below."
      >
        <input
          value={node.label ?? ""}
          onChange={(e) => onChangeLabel(e.target.value)}
          placeholder={node.name}
          className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
        />
      </Field>
      <Field label="Name" required help="Identifier used in templates: {{ steps.<name>.output.* }}">
        <input
          value={node.name}
          onChange={(e) => onChangeName(e.target.value)}
          className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
        />
      </Field>
      {!isCondition && (
        <Field label="Action type" required>
          <select
            value={node.action_type ?? ""}
            onChange={(e) => onChangeActionType(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
          >
            {actionOnlySpecs.map(([key, s]) => (
              <option key={key} value={key}>
                {s.label}
              </option>
            ))}
          </select>
          {spec?.description && (
            <div className="text-xs text-slate-500 mt-1">{spec.description}</div>
          )}
        </Field>
      )}
      {isCondition && spec?.description && (
        <div className="text-xs text-slate-500">{spec.description}</div>
      )}
      {spec && (
        <StepConfigForm
          spec={spec}
          config={node.config}
          onChange={onChangeConfig}
          triggerFamily={triggerFamily}
          triggerNotificationType={triggerNotificationType}
          priorSteps={priorSteps}
          operators={spec.operators ?? []}
          currentStepName={node.name}
          onAddPairedHelixStep={onAddPairedHelixStep}
          lockedVerkadaConnectionId={lockedVerkadaConnectionId}
        />
      )}

      {/* Per-step Run + captured sample output. Lets the user iterate
          one step at a time: run, see real output, use it to wire up the
          next step's variable refs. Captures persist on the flow's
          node_samples so the variable picker has real keys to offer. */}
      <div className="border-t border-white/10 pt-4 space-y-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => runNode.mutate()}
            disabled={!flowId || !flowSaved || runNode.isPending}
            title={
              !flowSaved
                ? "Save the flow first"
                : "Run just this step with the captured outputs of prior steps"
            }
            className="text-xs px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50"
          >
            {runNode.isPending ? "Running…" : "▶ Run this step"}
          </button>
          {runOutput !== undefined && runOutput !== null && (
            <span className="text-[11px] text-slate-500">
              captured output ready — downstream steps can reference it
            </span>
          )}
        </div>
        {runErr && (
          <pre className="font-mono text-[11px] whitespace-pre-wrap break-words text-rose-300 bg-rose-950/40 border border-rose-900 rounded p-2">
            {runErr}
          </pre>
        )}
        {runOutput !== undefined && runOutput !== null && (
          <details open>
            <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-slate-400 hover:text-slate-200">
              Captured output
            </summary>
            <pre className="mt-1 bg-slate-950 rounded p-2 text-[11px] font-mono whitespace-pre-wrap break-words text-slate-300 max-h-64 overflow-y-auto">
              {typeof runOutput === "string"
                ? runOutput
                : JSON.stringify(runOutput, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}


function EdgeEditor({
  edge,
  sourceNode,
  onChangeBranch,
  onRemove,
}: {
  edge: FlowEdge;
  sourceNode: FlowNode | undefined;
  onChangeBranch: (b: "true" | "false" | null) => void;
  onRemove: () => void;
}) {
  const isFromCondition = sourceNode?.kind === "condition";
  return (
    <div className="space-y-4">
      <div className="text-xs text-slate-400">
        {edge.source} → {edge.target}
      </div>
      {isFromCondition ? (
        <Field
          label="Branch"
          help="Which side of the condition does this edge represent?"
          required
        >
          <select
            value={edge.branch ?? ""}
            onChange={(e) =>
              onChangeBranch(
                e.target.value === "true" || e.target.value === "false"
                  ? (e.target.value as "true" | "false")
                  : null
              )
            }
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
          >
            <option value="">(always — unconditional)</option>
            <option value="true">true (matched)</option>
            <option value="false">false (not matched)</option>
          </select>
        </Field>
      ) : (
        <div className="text-xs text-slate-500">
          Edges from action nodes are unconditional — the target runs whenever this
          source succeeds.
        </div>
      )}
      <button
        onClick={onRemove}
        className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-rose-300 hover:border-rose-800"
      >
        Remove this edge
      </button>
    </div>
  );
}


function NodeTypePicker({
  onCancel,
  onPick,
}: {
  onCancel: () => void;
  onPick: (kind: "action" | "condition") => void;
}) {
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="bg-white/10 backdrop-blur-md border border-white/20 rounded-lg shadow-xl p-4 w-72 space-y-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">
          Add a node
        </div>
        <button
          onClick={() => onPick("action")}
          className="w-full text-left px-3 py-2 rounded border border-white/15 hover:border-sky-500 hover:bg-white/5"
        >
          <div className="text-sm font-medium text-sky-200">Action step</div>
          <div className="text-xs text-slate-400 mt-0.5">Call any Verkada endpoint.</div>
        </button>
        <button
          onClick={() => onPick("condition")}
          className="w-full text-left px-3 py-2 rounded border border-white/15 hover:border-amber-500 hover:bg-white/5"
        >
          <div className="text-sm font-medium text-amber-200">If / else condition</div>
          <div className="text-xs text-slate-400 mt-0.5">
            Branch downstream based on a comparison.
          </div>
        </button>
        <button
          onClick={onCancel}
          className="w-full text-xs px-2 py-1 rounded text-slate-500 hover:text-slate-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}


function Field({
  label,
  help,
  required,
  children,
}: {
  label: string;
  help?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-slate-300 mb-1">
        {label}
        {required && <span className="text-rose-400 ml-1">*</span>}
      </div>
      {children}
      {help && <div className="text-xs text-slate-500 mt-1">{help}</div>}
    </label>
  );
}


/** Auto-layout: depth-based vertical layering with horizontal spread per layer. */
function computeLayout(
  nodes: FlowNode[],
  edges: FlowEdge[],
): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const incoming = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target)!.push(e);
  }

  const visit = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const inc = incoming.get(id) ?? [];
    if (inc.length === 0) {
      depth.set(id, 0);
      return 0;
    }
    let max = 0;
    for (const e of inc) {
      max = Math.max(max, visit(e.source, seen) + 1);
    }
    depth.set(id, max);
    return max;
  };
  for (const n of nodes) visit(n.id);

  const byDepth = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(n.id);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of byDepth.entries()) {
    const total = ids.length;
    ids.forEach((id, i) => {
      const xOffset = (i - (total - 1) / 2) * COL_X;
      positions.set(id, { x: COL_X + xOffset, y: (d + 1) * ROW_Y });
    });
  }
  return positions;
}


/** Save-as-template modal — promotes the current flow body into the
 *  user_flow_templates table. Connection IDs are stripped server-side
 *  before persisting, so the saved template is portable. */
function SaveAsTemplateModal({
  flowId,
  defaultName,
  triggerType,
  triggerConfig,
  nodes,
  edges,
  onClose,
}: {
  // When the modal is opened from a saved flow, we fetch its export
  // body to harvest the embedded ``helix_event_types`` array. ``null``
  // for a never-saved flow — that case has no helix bootstrap to do.
  flowId: string | null;
  defaultName: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  nodes: FlowNode[];
  edges: FlowEdge[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(defaultName || "");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [summary, setSummary] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      // Pick up the export so we can attach the embedded Helix type
      // defs to the template. Best-effort — if the export call fails
      // we still save the template, just without the bootstrap helpers
      // for downstream recipients.
      let helixTypes: FlowExportFormat["helix_event_types"] = [];
      if (flowId) {
        try {
          const exported = await apiGet<FlowExportFormat>(
            `/api/flows/${flowId}/export`,
          );
          helixTypes = exported.helix_event_types ?? [];
        } catch {
          /* non-fatal — proceed without the embedded defs */
        }
      }
      return apiPost(`/api/flow-templates`, {
        name: name.trim(),
        category: category.trim() || null,
        description: description.trim() || null,
        summary: summary.trim() || null,
        default_name: name.trim(),
        flow: {
          trigger_type: triggerType,
          trigger_config: triggerConfig,
          nodes,
          edges,
          helix_event_types: helixTypes,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow-templates"] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
      <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-lg w-full max-w-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div>
          <h2 className="text-lg font-semibold text-white">Save as template</h2>
          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
            Saves this flow's trigger and steps under <strong>Templates → Flow
            templates → yours</strong>. Connection IDs and Helix event-type
            UIDs are stripped automatically — applying the template re-picks
            them from whatever deploy uses it.
          </p>
        </div>
        <label className="block">
          <div className="text-xs font-medium text-slate-300 mb-1">
            Name <span className="text-rose-400">*</span>
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 focus:outline-none focus:border-sky-500 text-sm"
            placeholder="e.g. Wildlife camera bear alert"
          />
        </label>
        <label className="block">
          <div className="text-xs font-medium text-slate-300 mb-1">
            Category
          </div>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 focus:outline-none focus:border-sky-500 text-sm"
            placeholder="e.g. AI analytics / Access automation / Scheduled"
          />
        </label>
        <label className="block">
          <div className="text-xs font-medium text-slate-300 mb-1">
            Short summary
          </div>
          <input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 focus:outline-none focus:border-sky-500 text-sm font-mono"
            placeholder="e.g. Webhook → Gemini → Helix"
          />
        </label>
        <label className="block">
          <div className="text-xs font-medium text-slate-300 mb-1">
            Description
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 focus:outline-none focus:border-sky-500 text-sm"
            placeholder="What this template builds and when you'd use it."
          />
        </label>
        {err && (
          <div className="text-sm text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
            {err}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border border-white/15 text-sm text-slate-200"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              setErr(null);
              if (!name.trim()) return setErr("Name is required.");
              save.mutate();
            }}
            disabled={save.isPending}
            className="px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-sm disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save template"}
          </button>
        </div>
      </div>
    </div>
  );
}
