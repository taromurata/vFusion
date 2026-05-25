import { Handle, Position, NodeProps } from "@xyflow/react";

import { ActionSpec, FlowNode } from "../../lib/api";
import { actionIcon } from "./icons";


export interface ActionNodeData extends Record<string, unknown> {
  node: FlowNode;
  spec: ActionSpec | undefined;
  canRemove: boolean;
  outgoingCount: number;
  onRemove: () => void;
  onAddChild: () => void;
  // Run-state from the editor's active-run poll. ``undefined`` when no
  // run is being tracked or this step hasn't started yet — the node
  // renders in its resting state.
  runStatus?: "running" | "success" | "failed" | "skipped";
}


/** A single action node on the canvas. */
export default function ActionNode({ data, selected }: NodeProps) {
  const d = data as ActionNodeData;
  const { node, spec } = d;
  // Prefer the friendly label; only fall back to the identifier when
  // no label was set. The identifier still shows as a small caption
  // when it differs so power users can still see what {{ steps.X }}
  // would reference.
  const display = (node.label ?? "").trim() || node.name;
  const showIdSubline = !!(node.label ?? "").trim() && node.label!.trim() !== node.name;
  const summary = summarize(node);
  const icon = actionIcon(node.action_type);

  return (
    <div
      className={`w-72 rounded-lg border-2 bg-slate-900 shadow-xl transition-shadow duration-200 ${runStateClasses(d.runStatus, selected)}`}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-500 !w-2 !h-2" />
      <div className="px-3 py-2 bg-slate-900/80 border-b border-slate-700 rounded-t-md flex items-center gap-2">
        <span className="text-xl leading-none shrink-0" aria-hidden>
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-100 truncate">
            {display}
          </div>
          {showIdSubline && (
            <div className="text-[10px] font-mono text-slate-500 truncate">
              {node.name}
            </div>
          )}
        </div>
        {d.runStatus && <RunBadge status={d.runStatus} />}
        <button
          className="nodrag text-xs px-1 text-slate-400 hover:text-rose-300 disabled:opacity-30 disabled:cursor-not-allowed"
          disabled={!d.canRemove}
          onClick={(e) => {
            e.stopPropagation();
            d.onRemove();
          }}
          title="Remove"
        >
          ×
        </button>
      </div>
      <div className="px-3 py-2 text-xs space-y-1">
        <div className="text-slate-400">
          {spec?.label ?? (
            <span className="text-rose-300">{node.action_type}</span>
          )}
        </div>
        {summary && (
          <div className="text-slate-300 font-mono truncate">{summary}</div>
        )}
      </div>
      <div className="flex justify-center pb-1 pt-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            d.onAddChild();
          }}
          className="nodrag text-[10px] uppercase font-semibold text-sky-300 hover:underline"
          title={
            d.outgoingCount === 0
              ? "Add the next step"
              : "Branch — add another downstream step"
          }
        >
          + {d.outgoingCount === 0 ? "next step" : "branch"}
        </button>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-slate-500 !w-2 !h-2" />
    </div>
  );
}


/** Pick the wrapper classes for an action node based on whether this
 *  step is part of an actively-tracked run. The running state pulses
 *  to draw the eye to "where the flow is right now". */
export function runStateClasses(
  status: ActionNodeData["runStatus"],
  selected: boolean,
): string {
  if (status === "running") {
    return "border-sky-400 shadow-[0_0_28px_rgba(56,189,248,0.55)] animate-pulse";
  }
  if (status === "success") {
    return "border-emerald-500/70 shadow-[0_0_18px_rgba(16,185,129,0.25)]";
  }
  if (status === "failed") {
    return "border-rose-500/70 shadow-[0_0_18px_rgba(244,63,94,0.25)]";
  }
  if (status === "skipped") {
    return "border-slate-700 opacity-50";
  }
  if (selected) {
    return "border-sky-400 ring-2 ring-sky-500/40 shadow-[0_0_24px_rgba(56,189,248,0.35)]";
  }
  return "border-slate-700";
}


/** Small colored chip in the card header indicating the step's status
 *  during a tracked run. Reuses the same palette as ``runStateClasses``
 *  so the card border + the badge agree visually. */
function RunBadge({
  status,
}: {
  status: NonNullable<ActionNodeData["runStatus"]>;
}) {
  const map: Record<string, { color: string; label: string }> = {
    running: { color: "bg-sky-600 text-white", label: "running" },
    success: { color: "bg-emerald-600 text-white", label: "done" },
    failed: { color: "bg-rose-600 text-white", label: "failed" },
    skipped: { color: "bg-slate-600 text-slate-200", label: "skipped" },
  };
  const m = map[status];
  return (
    <span
      className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${m.color}`}
    >
      {m.label}
    </span>
  );
}


function summarize(node: FlowNode): string | null {
  const cfg = node.config ?? {};
  if (node.action_type === "verkada_api_call") {
    const body = cfg.body;
    const hasBody = body && typeof body === "object" && Object.keys(body).length > 0;
    return hasBody ? "with body templated" : "endpoint configured";
  }
  if (node.action_type === "verkada_unlock_door") {
    const door = cfg.door_id;
    return typeof door === "string" && door
      ? `unlock ${door.slice(0, 8)}…`
      : "unlock door";
  }
  return null;
}
