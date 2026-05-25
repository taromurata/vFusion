import { Handle, Position, NodeProps } from "@xyflow/react";

import { Flow } from "../../lib/api";
import { triggerIcon } from "./icons";


export interface TriggerNodeData extends Record<string, unknown> {
  trigger_type?: string;
  trigger_config: Flow["trigger_config"];
  onAddChild: () => void;
  // Optional: when present, the card shows a Run button that fires
  // the saved flow with a synthetic trigger blob and keeps the
  // operator on the canvas to watch the run light up. Hidden for
  // unsaved flows (no flow row to dispatch against yet).
  onRunNow?: () => void;
  // Whether a run launched from this card is currently being polled
  // — used to dim the Run button while in flight.
  runActive?: boolean;
  runOverallStatus?: string | null;
}


const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];


export default function TriggerNode({ data, selected }: NodeProps) {
  const d = data as TriggerNodeData;
  const isSchedule = d.trigger_type === "schedule";
  const cfg = d.trigger_config ?? {};
  const icon = triggerIcon(d.trigger_type);

  return (
    <div
      className={`w-72 rounded-lg border-2 bg-slate-900 shadow-xl transition-shadow duration-200 ${
        selected
          ? "border-sky-400 ring-2 ring-sky-500/40 shadow-[0_0_24px_rgba(56,189,248,0.35)]"
          : "border-slate-700"
      }`}
    >
      <div className="px-3 py-2 bg-sky-950/60 border-b border-slate-700 rounded-t-md flex items-center gap-2">
        <span className="text-xl leading-none shrink-0" aria-hidden>
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-100 truncate">
            {isSchedule ? "Schedule" : "Verkada webhook"}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-sky-300/80">
            Trigger
          </div>
        </div>
        {d.onRunNow && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              d.onRunNow?.();
            }}
            disabled={!!d.runActive}
            title="Fire this flow now with a synthetic trigger and watch the run light up the canvas"
            className="nodrag shrink-0 text-[11px] font-semibold px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          >
            <span aria-hidden>▶</span>
            {d.runActive && (d.runOverallStatus === "running" || d.runOverallStatus === "pending")
              ? "Running…"
              : "Run"}
          </button>
        )}
      </div>
      {isSchedule ? (
        <ScheduleSummary cfg={cfg} />
      ) : (
        <WebhookSummary cfg={cfg} />
      )}
      <div className="flex justify-center pb-1 pt-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            d.onAddChild();
          }}
          className="nodrag text-[10px] uppercase font-semibold text-sky-300 hover:underline"
          title="Add the first step"
        >
          + start
        </button>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-slate-500 !w-2 !h-2" />
    </div>
  );
}


function pad(n: number): string {
  return n.toString().padStart(2, "0");
}


function ScheduleSummary({ cfg }: { cfg: Flow["trigger_config"] }) {
  const kind = (cfg as Record<string, unknown>).kind;
  if (kind === "interval") {
    const every = Number((cfg as Record<string, unknown>).every_minutes) || 0;
    return (
      <div className="px-3 py-2 text-xs">
        <div className="text-slate-300">
          Runs <span className="font-semibold text-slate-100">every {every} min</span>
        </div>
      </div>
    );
  }
  if (kind === "daily" || kind === "weekly") {
    const hour = Number((cfg as Record<string, unknown>).hour) || 0;
    const minute = Number((cfg as Record<string, unknown>).minute) || 0;
    const weekday = Number((cfg as Record<string, unknown>).weekday) || 0;
    return (
      <div className="px-3 py-2 text-xs">
        <div className="text-slate-300">
          {kind === "weekly" ? (
            <>
              Runs <span className="font-semibold text-slate-100">{WEEKDAYS[weekday]}</span> at{" "}
              <span className="font-semibold text-slate-100">
                {pad(hour)}:{pad(minute)} UTC
              </span>
            </>
          ) : (
            <>
              Runs daily at{" "}
              <span className="font-semibold text-slate-100">
                {pad(hour)}:{pad(minute)} UTC
              </span>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="px-3 py-2 text-xs text-slate-500">
      (no schedule configured)
    </div>
  );
}


/** Maps Verkada event families to a small emoji + a friendly label.
 *  Just a UX layer — server matching still uses the raw family string. */
const FAMILY_PRETTY: Record<string, { emoji: string; label: string }> = {
  camera: { emoji: "📹", label: "Camera" },
  access: { emoji: "🚪", label: "Access" },
  lpr: { emoji: "🚗", label: "LPR" },
  sensor: { emoji: "🌡️", label: "Sensor" },
  intercom: { emoji: "🔔", label: "Intercom" },
  credential: { emoji: "🪪", label: "Credential" },
  alarm: { emoji: "🚨", label: "Alarm" },
};


function WebhookSummary({ cfg }: { cfg: Flow["trigger_config"] }) {
  const family = String((cfg as Record<string, unknown>).family ?? "");
  const nt = String((cfg as Record<string, unknown>).notification_type ?? "");
  const filters = (cfg as Record<string, unknown>).filters ?? {};
  const filterEntries = Object.entries(filters as Record<string, unknown>);
  const fp = FAMILY_PRETTY[family];

  return (
    <div className="px-3 py-2 text-xs space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        {fp ? (
          <Pill>
            <span aria-hidden>{fp.emoji}</span> {fp.label}
          </Pill>
        ) : (
          <Pill>{family || "any"}</Pill>
        )}
        {nt && <Pill subtle>{prettifyNotificationType(nt)}</Pill>}
      </div>
      {filterEntries.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {filterEntries.map(([k, v]) => (
            <Pill key={k} subtle>
              {k} = <span className="font-medium">{String(v)}</span>
            </Pill>
          ))}
        </div>
      )}
    </div>
  );
}


function Pill({
  children,
  subtle,
}: {
  children: React.ReactNode;
  subtle?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${
        subtle
          ? "bg-slate-800 text-slate-300 border border-slate-700"
          : "bg-sky-900/60 text-sky-100 border border-sky-800"
      }`}
    >
      {children}
    </span>
  );
}


/** Strip the noisy ``alert_rule_`` prefix and underscore-to-space the
 *  rest so things like ``alert_rule_motion`` read as ``motion`` in the
 *  pill. Original string is preserved for tooltips elsewhere. */
function prettifyNotificationType(nt: string): string {
  return nt.replace(/^alert_rule_/, "").replace(/_/g, " ");
}
