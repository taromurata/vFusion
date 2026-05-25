import { Handle, Position, NodeProps } from "@xyflow/react";

import { FlowNode } from "../../lib/api";
import { conditionIcon } from "./icons";


export interface ConditionNodeData extends Record<string, unknown> {
  node: FlowNode;
  canRemove: boolean;
  onRemove: () => void;
  onAddBranch: (branch: "true" | "false") => void;
}


export default function ConditionNode({ data, selected }: NodeProps) {
  const d = data as ConditionNodeData;
  const cfg = d.node.config ?? {};
  const left = (cfg.left as string) ?? "";
  const op = (cfg.operator as string) ?? "equals";
  const right = (cfg.right as string) ?? "";
  const display = (d.node.label ?? "").trim() || d.node.name;
  const showIdSubline = !!(d.node.label ?? "").trim() && d.node.label!.trim() !== d.node.name;

  return (
    <div
      className={`w-72 rounded-lg border-2 bg-slate-900 shadow-xl ${
        selected ? "border-amber-500" : "border-slate-700"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-500 !w-2 !h-2" />
      <div className="px-3 py-2 bg-amber-950/60 border-b border-slate-700 rounded-t-md flex items-center gap-2">
        <span className="text-xl leading-none shrink-0" aria-hidden>
          {conditionIcon()}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-100 truncate">
            {display}
          </div>
          {showIdSubline && (
            <div className="text-[10px] font-mono text-slate-500 truncate">
              {d.node.name}
            </div>
          )}
        </div>
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
      <div className="px-3 py-2 text-xs">
        <ExpressionPretty left={left} op={op} right={right} />
      </div>
      <div className="flex justify-around items-center px-1 pb-1 pt-0 text-[10px] text-slate-400">
        <BranchHandle
          id="true"
          label="true"
          color="emerald"
          onAdd={() => d.onAddBranch("true")}
        />
        <BranchHandle
          id="false"
          label="false"
          color="rose"
          onAdd={() => d.onAddBranch("false")}
        />
      </div>
    </div>
  );
}


const IS_UNARY: Record<string, boolean> = { exists: true, not_exists: true };

/** English-ish names for the condition operators, so the card reads
 *  like a sentence ("if animal contains \"bear\"") instead of a code
 *  fragment ("contains"). */
const OP_WORDS: Record<string, string> = {
  equals: "equals",
  not_equals: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  starts_with: "starts with",
  ends_with: "ends with",
  greater_than: ">",
  less_than: "<",
  greater_or_equal: "≥",
  less_or_equal: "≤",
  exists: "exists",
  not_exists: "is empty",
};


/** Render the condition expression as ``if <pill> <op> <pill>`` instead
 *  of dumping the raw template literal. Falls back to the raw string in
 *  a tooltip so the path is still discoverable. */
function ExpressionPretty({
  left,
  op,
  right,
}: {
  left: string;
  op: string;
  right: string;
}) {
  const opWord = OP_WORDS[op] ?? op;
  const unary = !!IS_UNARY[op];
  return (
    <div className="flex items-center gap-1.5 flex-wrap text-[12px]">
      <span className="text-slate-500">if</span>
      <ValuePill raw={left} />
      <span className="text-amber-200/90 font-medium">{opWord}</span>
      {!unary && <ValuePill raw={right} />}
    </div>
  );
}


/** Render a single value as either:
 *   - a styled template-variable pill (when the raw text looks like
 *     ``{{ steps.x.output.y.z }}`` — we surface ``stepname.field`` so
 *     it's clear *where* the value came from, not just what the field
 *     is named. Full path stays as a tooltip), or
 *   - a quoted literal chip for everything else.
 */
function ValuePill({ raw }: { raw: string }) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return (
      <span className="text-slate-600 italic">(empty)</span>
    );
  }
  const tplMatch = trimmed.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (tplMatch) {
    const path = tplMatch[1];
    return (
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded bg-sky-900/60 border border-sky-800 text-sky-100 font-mono text-[11px]"
        title={`{{ ${path} }}`}
      >
        {prettyVarPath(path)}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-200 font-mono text-[11px] max-w-[10rem] truncate"
      title={trimmed}
    >
      "{trimmed}"
    </span>
  );
}


/** Collapse a template path to its meaningful segments. We drop the
 *  scaffold keys (``steps``, ``output``, ``json``, ``data``) that don't
 *  carry information about *what* the value is and keep the rest joined
 *  with dots. Examples:
 *
 *    steps.analyze.output.json.animal  →  analyze.animal
 *    steps.ocr.output.text             →  ocr.text
 *    trigger.data.camera_id            →  trigger.camera_id
 *    trigger.fired_at                  →  trigger.fired_at
 *
 *  This way the condition card always shows ``<source>.<field>`` so the
 *  operator can tell which step produced the value at a glance.
 */
const NOISE_SEGMENTS = new Set(["steps", "output", "json", "data"]);

function prettyVarPath(path: string): string {
  const parts = path.split(".");
  const meaningful = parts.filter((p) => !NOISE_SEGMENTS.has(p));
  if (meaningful.length === 0) {
    // All segments were noise — fall back to the raw last segment so
    // we still render something useful (rare case, e.g. `{{ steps }}`).
    return parts[parts.length - 1] || path;
  }
  return meaningful.join(".");
}


function BranchHandle({
  id,
  label,
  color,
  onAdd,
}: {
  id: string;
  label: string;
  color: "emerald" | "rose";
  onAdd: () => void;
}) {
  const text = color === "emerald" ? "text-emerald-300" : "text-rose-300";
  return (
    <div className="relative flex flex-col items-center w-1/2">
      <button
        onClick={(e) => {
          e.stopPropagation();
          onAdd();
        }}
        className={`nodrag text-[10px] uppercase font-semibold ${text} hover:underline pb-2`}
        title={`Add step on the ${label} branch`}
      >
        + {label}
      </button>
      <Handle
        type="source"
        position={Position.Bottom}
        id={id}
        className="!bg-slate-500 !w-2 !h-2 !relative !translate-x-0 !translate-y-0"
      />
    </div>
  );
}
