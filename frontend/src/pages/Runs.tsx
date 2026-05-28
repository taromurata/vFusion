import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import {
  API_BASE,
  apiGet,
  apiPost,
  RunDetail,
  RunEvent,
  RunListResponse,
  RunStep,
} from "../lib/api";
import JsonView from "../components/JsonView";

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-slate-800 text-slate-300",
  running: "bg-sky-900 text-sky-200",
  success: "bg-emerald-900 text-emerald-200",
  failed: "bg-rose-900 text-rose-200",
  skipped: "bg-slate-800 text-slate-500",
};

export default function Runs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(
    searchParams.get("selected"),
  );
  useEffect(() => {
    const fromUrl = searchParams.get("selected");
    if (fromUrl && fromUrl !== selected) setSelected(fromUrl);
  }, [searchParams, selected]);
  const pick = (id: string) => {
    setSelected(id);
    setSearchParams({ selected: id }, { replace: true });
  };

  const list = useQuery({
    queryKey: ["runs"],
    queryFn: () => apiGet<RunListResponse>("/api/runs?limit=100"),
    refetchInterval: 2000,
  });
  const detail = useQuery({
    queryKey: ["run", selected],
    queryFn: () => apiGet<RunDetail>(`/api/runs/${selected}`),
    enabled: selected !== null,
    refetchInterval: selected !== null ? 2000 : false,
  });

  const items = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-white">Runs</h1>
        <p className="text-slate-400 text-sm mt-1">
          Every flow execution. Open one to see the trigger payload, the action
          output, and any error.{" "}
          <Link to="/flows" className="text-sky-400 hover:underline">
            Configure flows →
          </Link>
        </p>
      </div>

      <div className="grid grid-cols-12 gap-4 min-h-[60vh]">
        <div className="col-span-5 border border-slate-800 rounded-lg overflow-hidden bg-slate-900/50">
          {items.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">
              No runs yet. Once a webhook matches an enabled flow's trigger, it'll
              show up here.
            </div>
          ) : (
            <ul className="divide-y divide-slate-800">
              {items.map((r) => (
                <li
                  key={r.id}
                  onClick={() => pick(r.id)}
                  className={`px-3 py-2 cursor-pointer text-sm transition-colors ${
                    selected === r.id ? "bg-slate-800" : "hover:bg-slate-800/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        STATUS_STYLE[r.status] ?? "bg-slate-800 text-slate-300"
                      }`}
                    >
                      {r.status}
                    </span>
                    <span className="text-slate-100 truncate">
                      {r.flow_name ?? "(deleted flow)"}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 flex justify-between">
                    <span>{new Date(r.created_at).toLocaleString()}</span>
                    {r.started_at && r.finished_at && (
                      <span>
                        {Math.round(
                          (new Date(r.finished_at).getTime() -
                            new Date(r.started_at).getTime()) /
                            10
                        ) / 100}{" "}
                        s
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="col-span-7 border border-slate-800 rounded-lg bg-slate-900/50 overflow-hidden">
          {detail.data ? (
            <RunDetailView run={detail.data} />
          ) : (
            <div className="p-6 text-sm text-slate-500">Select a run to inspect.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunDetailView({ run }: { run: RunDetail }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isByoa =
    run.input &&
    typeof run.input === "object" &&
    !Array.isArray(run.input) &&
    (run.input as Record<string, unknown>).byoa === true;
  // For flow-triggered runs, "Run it back" replays the flow against the
  // same webhook event via the existing test-run endpoint. Useful when a
  // step errored (bad helix schema, missing template ref, etc.) and you
  // want to fix the flow and try again without waiting for another
  // webhook to land. We only show it when both pieces are still there.
  const canFlowReplay =
    !isByoa &&
    !!run.flow_id &&
    !!run.webhook_event_id;
  const flowReplay = useMutation({
    mutationFn: () =>
      apiPost<{ run_id: string }>(
        `/api/flows/${run.flow_id}/test-run`,
        { webhook_event_id: run.webhook_event_id },
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      navigate(`/runs?selected=${res.run_id}`);
    },
  });
  // Live progress: poll events while running, then stop. Polling stops
  // updating the cache as soon as the run finishes so we don't keep
  // hitting the endpoint forever.
  const isLive = run.status === "pending" || run.status === "running";
  const events = useQuery({
    queryKey: ["run-events", run.id],
    queryFn: () => apiGet<RunEvent[]>(`/api/runs/${run.id}/events`),
    refetchInterval: isLive ? 1000 : false,
  });
  const eventsByStep = new Map<string, RunEvent[]>();
  for (const e of events.data ?? []) {
    if (!e.step_name) continue;
    const bucket = eventsByStep.get(e.step_name) ?? [];
    bucket.push(e);
    eventsByStep.set(e.step_name, bucket);
  }
  // Reset the detail pane's scroll position when the selected run
  // changes. Without this, navigating in from BYOA's "Brew it" or
  // clicking a different run keeps whatever scroll position the
  // previous run left behind — the operator lands midway through
  // a run and has to scroll up to see the header.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [run.id]);
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
              STATUS_STYLE[run.status] ?? "bg-slate-800 text-slate-300"
            }`}
          >
            {run.status}
          </span>
          <span className="font-medium text-slate-100">
            {run.flow_name ?? "(deleted flow)"}
          </span>
          {isByoa && (
            <button
              onClick={() => navigate(`/workbench?from_run=${run.id}`)}
              className="ml-auto text-xs px-2 py-1 rounded-md bg-sky-700 hover:bg-sky-600 text-white"
              title="Open Workbench pre-filled with this run's config — tweak and run again"
            >
              ↻ Run it back
            </button>
          )}
          {canFlowReplay && (
            <button
              onClick={() => flowReplay.mutate()}
              disabled={flowReplay.isPending}
              className="ml-auto text-xs px-2 py-1 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
              title="Re-run this flow against the same webhook payload — same as Test run from the flow editor"
            >
              {flowReplay.isPending ? "Starting…" : "↻ Run it back"}
            </button>
          )}
          {run.webhook_event_id && (
            // Jump to the triggering payload in the Inbox. Handy when a
            // step blew up on something like a missing field — open the
            // raw hook to see exactly what Verkada sent. The ``ml-auto``
            // only applies when "Run it back" isn't already taking the
            // slot, so we use a smaller margin here to keep them paired.
            <button
              onClick={() =>
                navigate(`/inbox?event=${run.webhook_event_id}`)
              }
              className={`${canFlowReplay ? "ml-1" : "ml-auto"} text-xs px-2 py-1 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-100`}
              title="Open the triggering webhook payload in the Inbox"
            >
              {"</>"} View source hook
            </button>
          )}
        </div>
        <div className="text-xs text-slate-500 mt-1">
          created {new Date(run.created_at).toLocaleString()}
          {run.started_at && (
            <>
              {" "}
              • started {new Date(run.started_at).toLocaleTimeString()}
            </>
          )}
          {run.finished_at && (
            <>
              {" "}
              • finished {new Date(run.finished_at).toLocaleTimeString()}
            </>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-4">
        {/* Lift the captured clip/still to a run-level preview so it
            shows regardless of which step the operator has expanded.
            For a typical Gemini-analyze flow the asset is in step 1's
            output, but operators reading step 2 (the condition) or
            step 3 (the Helix post) still want to see what the camera
            saw — it's the run's shared context. */}
        <RunCapturedAsset run={run} />

        {/* Run-level Helix-posted summary. The verkada_helix_event
            step's output carries the request_body.attributes dict
            — exactly what landed on the Verkada Helix event. 9/10
            times that's what the operator is here to confirm
            ("did Animal=dog get through?"), so we surface it as a
            tidy card above the step chain instead of making them
            click through to step → output → request_body. */}
        <HelixPostSummary steps={run.steps ?? []} />

        {run.error && (
          <div>
            <SectionTitle>Error</SectionTitle>
            <pre className="font-mono text-xs whitespace-pre-wrap break-words text-rose-300 bg-rose-950/40 border border-rose-900 rounded p-3">
              {run.error}
            </pre>
          </div>
        )}

        {run.steps && run.steps.length > 0 ? (
          run.steps.length === 1 ? (
            // Single-step runs (BYOA, simple flows) don't need the
            // chain UI — there's no flow to visualize, just one step's
            // detail. Skip the chain card + "Steps" header entirely.
            <StepBlock
              step={run.steps[0]}
              index={0}
              runId={run.id}
              events={eventsByStep.get(run.steps[0].name) ?? []}
              defaultOpen
            />
          ) : (
            <div>
              <SectionTitle>Steps</SectionTitle>
              <StepChain
                steps={run.steps}
                runId={run.id}
                eventsByStep={eventsByStep}
              />
            </div>
          )
        ) : (
          <div>
            <SectionTitle>Action output</SectionTitle>
            <div className="bg-slate-950 rounded p-3 overflow-x-auto">
              {run.output ? (
                <JsonView value={run.output} />
              ) : (
                <span className="text-slate-500 text-sm">
                  {run.status === "pending" || run.status === "running"
                    ? "(not yet)"
                    : "(none)"}
                </span>
              )}
            </div>
          </div>
        )}

        <div>
          <SectionTitle>Trigger payload</SectionTitle>
          <div className="bg-slate-950 rounded p-3 overflow-x-auto">
            {run.input ? (
              <JsonView value={run.input} />
            ) : (
              <span className="text-slate-500 text-sm">(none)</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- StepChain ------------------------------------------------------------
//
// Horizontal flow-style chain: each step is a card, arrows between them.
// Clicking a card opens its details (clip / image / output / log / phases)
// below the chain. Failed and running steps auto-open. The chain doesn't
// know about branch edges — runs don't carry the flow's DAG, just a flat
// list of executed steps — so this draws them in execution order with a
// simple "→" between, which is right for 99% of real flows. Steps marked
// "skipped" are dimmed so the timeline of what actually ran reads clearly.

function StepChain({
  steps,
  runId,
  eventsByStep,
}: {
  steps: RunStep[];
  runId: string;
  eventsByStep: Map<string, RunEvent[]>;
}) {
  // Auto-pick the most interesting step on first render: failed > running >
  // last. Re-pick whenever the steps list changes (live runs add steps).
  const [openIdx, setOpenIdx] = useState<number>(() => bestStep(steps));
  useEffect(() => {
    setOpenIdx(bestStep(steps));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.length, steps.map((s) => s.status).join("|")]);

  const active = steps[openIdx];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-stretch gap-0 overflow-x-auto pb-1">
        {steps.map((s, i) => (
          <div key={i} className="flex items-stretch">
            <StepCard
              step={s}
              index={i}
              selected={i === openIdx}
              onClick={() => setOpenIdx(i)}
              phaseCount={(eventsByStep.get(s.name) ?? []).filter((e) => e.phase).length}
            />
            {i < steps.length - 1 && <Arrow />}
          </div>
        ))}
      </div>
      {active && (
        <StepBlock
          key={openIdx}
          step={active}
          index={openIdx}
          runId={runId}
          events={eventsByStep.get(active.name) ?? []}
          defaultOpen
        />
      )}
    </div>
  );
}


function bestStep(steps: RunStep[]): number {
  const failed = steps.findIndex((s) => s.status === "failed");
  if (failed !== -1) return failed;
  const running = steps.findIndex((s) => s.status === "running");
  if (running !== -1) return running;
  return Math.max(0, steps.length - 1);
}


function Arrow() {
  return (
    <div className="flex items-center px-2 text-slate-500 select-none">
      <svg width="28" height="14" viewBox="0 0 28 14" fill="none">
        <path
          d="M0 7 H22 M16 1 L22 7 L16 13"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </div>
  );
}


function StepCard({
  step,
  index,
  selected,
  onClick,
  phaseCount,
}: {
  step: RunStep;
  index: number;
  selected: boolean;
  onClick: () => void;
  phaseCount: number;
}) {
  const dim = step.status === "skipped";
  const cost = stepCostUsd(step);
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-md border min-w-[12rem] max-w-[16rem] px-3 py-2 transition-colors ${
        selected
          ? "bg-sky-950/40 border-sky-500"
          : "bg-white/5 border-white/15 hover:border-sky-500"
      } ${dim ? "opacity-50" : ""}`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
          {index + 1}
        </span>
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            STATUS_STYLE[step.status] ?? "bg-slate-800 text-slate-300"
          }`}
        >
          {step.status}
        </span>
      </div>
      <div
        className={`text-sm text-slate-100 mt-1 truncate ${
          step.label ? "font-medium" : "font-mono"
        }`}
        title={step.label ? step.name : undefined}
      >
        {step.label || step.name}
      </div>
      <div className="text-[10px] text-slate-500 mt-0.5 truncate">
        {step.type}
        {phaseCount > 0 && <span className="ml-2">{phaseCount} phases</span>}
      </div>
      {cost !== null && (
        <div className="text-[10px] text-emerald-300 mt-0.5">
          ~${cost.toFixed(cost < 0.01 ? 4 : 3)} est.
        </div>
      )}
    </button>
  );
}


// OutputSection
//
// Most action outputs have a primary "text" field (Gemini analyze) — show
// THAT prominently, full bleed, since it's what users actually came to see.
// Stuff the structured fields (model, tokens, file paths, cost, etc.) under
// a collapsed "Details" toggle. Outputs without text fall through to the
// raw JSON view as before — keeps existing behavior for helix-event,
// unlock-door, api-call, etc.
//
// When the Gemini step asked for JSON the ``text`` field IS a stringified
// JSON blob (``{"status":"ok","issue":null,...}``). Showing that as a
// single wrapped line is ugly; the action also exposes ``output.json``
// (the same content already parsed) so we render that pretty-printed
// when present, with the raw text under Details for the curious.
// RunCapturedAsset
//
// Finds the first step in the run whose output carries a ``clip_path``
// (video clip pulled from Verkada) or ``image_path`` (still frame
// grab) and renders it once at the top of the run-detail pane. Means
// the operator sees the camera context — same image Gemini looked at
// — without having to expand the analyze step. Falls silent when
// neither is present (e.g. weather_fetch runs, helix-only flows).
// Run-level summary of every successful Helix post in the run. Reads
// each verkada_helix_event step's output.request_body.attributes —
// that's the dict that actually went over the wire to Verkada. We
// render it as a labeled pill block so the operator can confirm
// "yes, the right values reached Helix" at a glance, without
// expanding the step + drilling into request_body.
function HelixPostSummary({ steps }: { steps: RunStep[] }) {
  const helixSteps = steps.filter((s) => {
    if (s.type !== "verkada_helix_event") return false;
    if (s.status !== "success") return false;
    const out = s.output as Record<string, unknown> | null | undefined;
    const body = out?.request_body as Record<string, unknown> | null | undefined;
    return body && typeof body === "object" && "attributes" in body;
  });
  if (helixSteps.length === 0) return null;
  return (
    <div>
      <SectionTitle>Posted to Helix</SectionTitle>
      <div className="space-y-2">
        {helixSteps.map((s, i) => {
          const out = s.output as Record<string, unknown>;
          const body = out.request_body as Record<string, unknown>;
          const attrs = body.attributes as Record<string, unknown>;
          // Multi-step flows sometimes post twice (once per branch).
          // Label each block so the operator can tell them apart;
          // fall back to step name when no friendly label is set.
          const heading = s.label || s.name;
          const resp = out.verkada_response as
            | Record<string, unknown>
            | null
            | undefined;
          const statusCode =
            typeof resp?.status_code === "number" ? resp.status_code : null;
          return (
            <div
              key={`${s.name}-${i}`}
              className="bg-emerald-950/30 border border-emerald-900/60 rounded p-3"
            >
              <div className="flex items-center gap-2 text-xs text-emerald-300 mb-2">
                <span>🧬</span>
                <span className="font-medium">{heading}</span>
                {statusCode !== null && (
                  <span className="text-[10px] text-slate-400">
                    · HTTP {statusCode}
                  </span>
                )}
              </div>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                {Object.entries(attrs).map(([k, v]) => (
                  <FragmentRow key={k} k={k} v={v} />
                ))}
              </dl>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: unknown }) {
  const rendered =
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
      ? String(v)
      : JSON.stringify(v);
  return (
    <>
      <dt className="font-mono text-emerald-300">{k}</dt>
      <dd className="text-slate-100 break-words">{rendered}</dd>
    </>
  );
}


function RunCapturedAsset({ run }: { run: RunDetail }) {
  const stepWithClip = (run.steps ?? []).find((s) => {
    const out = s.output as Record<string, unknown> | null | undefined;
    return typeof out?.clip_path === "string" && out.clip_path;
  });
  const stepWithImage = (run.steps ?? []).find((s) => {
    const out = s.output as Record<string, unknown> | null | undefined;
    return typeof out?.image_path === "string" && out.image_path;
  });

  if (stepWithClip) {
    const url = `${API_BASE}/api/runs/${run.id}/clip?step=${encodeURIComponent(stepWithClip.name)}`;
    return (
      <div>
        <SectionTitle>Captured clip</SectionTitle>
        <video
          src={url}
          controls
          className="w-full rounded bg-black max-h-72"
        />
      </div>
    );
  }
  if (stepWithImage) {
    const url = `${API_BASE}/api/runs/${run.id}/image?step=${encodeURIComponent(stepWithImage.name)}`;
    return (
      <div>
        <SectionTitle>Captured frame</SectionTitle>
        <img
          src={url}
          alt="Captured frame"
          className="w-full rounded bg-black max-h-72 object-contain"
        />
      </div>
    );
  }
  return null;
}


function OutputSection({ output }: { output: unknown }) {
  const obj =
    output && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : null;
  const text = obj && typeof obj.text === "string" ? obj.text : null;
  // ``json`` is set by the Gemini actions when their text response
  // parses as JSON. Prefer that when present — it's the same content,
  // just structured for syntax-highlighted display.
  const parsedJson = obj && obj.json !== undefined && obj.json !== null
    ? obj.json
    : null;

  if (parsedJson !== null) {
    return (
      <div>
        <SectionTitle>Output</SectionTitle>
        <div className="bg-slate-950 rounded p-3 overflow-x-auto">
          <JsonView value={parsedJson} />
        </div>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-500 hover:text-slate-300">
            Details
          </summary>
          <div className="mt-2 bg-slate-950 rounded p-3 overflow-x-auto">
            <JsonView value={output} />
          </div>
        </details>
      </div>
    );
  }

  if (text) {
    return (
      <div>
        <SectionTitle>Output</SectionTitle>
        <div className="bg-slate-950 rounded p-3 text-sm text-slate-100 whitespace-pre-wrap break-words">
          {text}
        </div>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-500 hover:text-slate-300">
            Details
          </summary>
          <div className="mt-2 bg-slate-950 rounded p-3 overflow-x-auto">
            <JsonView value={output} />
          </div>
        </details>
      </div>
    );
  }
  return (
    <div>
      <SectionTitle>Output</SectionTitle>
      <div className="bg-slate-950 rounded p-3 overflow-x-auto">
        <JsonView value={output} />
      </div>
    </div>
  );
}


function CostDetail({ step }: { step: RunStep }) {
  const out = step.output as Record<string, unknown> | null | undefined;
  const cost = out && typeof out === "object" ? (out as Record<string, unknown>).cost : null;
  if (!cost || typeof cost !== "object") return null;
  const c = cost as Record<string, unknown>;
  const usd = typeof c.cost_usd === "number" ? c.cost_usd : 0;
  return (
    <div className="bg-white/5 border border-white/10 rounded p-3 text-sm space-y-1">
      <div className="text-lg font-semibold text-emerald-300">
        ~${usd.toFixed(usd < 0.01 ? 6 : 4)}
        <span className="ml-2 text-[10px] text-slate-400 font-normal">
          estimated — not a Google invoice
        </span>
      </div>
      <div className="text-xs text-slate-400 font-mono">
        {String(c.model)} · {String(c.tokens_in)} in / {String(c.tokens_out)} out
      </div>
      <div className="text-[10px] text-slate-500">
        input ${Number(c.input_rate_per_1m_usd).toFixed(2)}/1M ·
        output ${Number(c.output_rate_per_1m_usd).toFixed(2)}/1M ·
        rates from {new Date(String(c.rates_fetched_at)).toLocaleDateString()}
      </div>
    </div>
  );
}


function stepCostUsd(step: RunStep): number | null {
  const out = step.output as Record<string, unknown> | null | undefined;
  if (!out || typeof out !== "object") return null;
  const cost = (out as Record<string, unknown>).cost;
  if (!cost || typeof cost !== "object") return null;
  const v = (cost as Record<string, unknown>).cost_usd;
  return typeof v === "number" ? v : null;
}


function StepBlock({
  step,
  index,
  runId,
  events,
  defaultOpen,
}: {
  step: RunStep;
  index: number;
  runId: string;
  events: RunEvent[];
  defaultOpen?: boolean;
}) {
  // Any step whose recorded output has a clip_path gets an inline player.
  // The endpoint resolves the actual path server-side so we don't expose
  // server file paths to the browser.
  const output =
    step.output && typeof step.output === "object" && !Array.isArray(step.output)
      ? (step.output as Record<string, unknown>)
      : null;
  const hasClip = typeof output?.clip_path === "string" && output.clip_path;
  const clipUrl = hasClip
    ? `${API_BASE}/api/runs/${runId}/clip?step=${encodeURIComponent(step.name)}`
    : null;
  const hasImage = typeof output?.image_path === "string" && output.image_path;
  const imageUrl = hasImage
    ? `${API_BASE}/api/runs/${runId}/image?step=${encodeURIComponent(step.name)}`
    : null;

  // Build the phase checklist: first appearance per (phase) defines order,
  // last entry per phase defines current status. Free-form log lines (no
  // phase) feed the nerd panel.
  const phaseOrder: string[] = [];
  const phaseStatus = new Map<string, string>();
  const phaseLastMsg = new Map<string, string | null>();
  const logs: RunEvent[] = [];
  for (const e of events) {
    if (e.phase) {
      if (!phaseStatus.has(e.phase)) phaseOrder.push(e.phase);
      if (e.status) phaseStatus.set(e.phase, e.status);
      if (e.message) phaseLastMsg.set(e.phase, e.message);
    } else if (e.message) {
      logs.push(e);
    }
  }
  const [open, setOpen] = useState(
    defaultOpen || step.status === "running" || step.status === "failed",
  );
  useEffect(() => {
    if (step.status === "running" || step.status === "failed") setOpen(true);
  }, [step.status]);
  const duration =
    step.started_at && step.finished_at
      ? Math.round(
          (new Date(step.finished_at).getTime() -
            new Date(step.started_at).getTime()) /
            10
        ) / 100
      : null;
  return (
    <div className="border border-slate-800 rounded-md bg-slate-950/50 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 bg-slate-900/60 border-b border-slate-800 text-left flex items-center gap-2"
      >
        <span className="text-slate-500 text-xs w-3">{open ? "▾" : "▸"}</span>
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
          {index + 1}
        </span>
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            STATUS_STYLE[step.status] ?? "bg-slate-800 text-slate-300"
          }`}
        >
          {step.status}
        </span>
        <span
          className={`text-sm text-slate-100 truncate flex-1 ${
            step.label ? "font-medium" : "font-mono"
          }`}
          title={step.label ? step.name : undefined}
        >
          {step.label || step.name}
        </span>
        <span className="text-xs text-slate-500 font-mono">{step.type}</span>
        {duration !== null && (
          <span className="text-[10px] text-slate-500">{duration}s</span>
        )}
      </button>
      {open && (
        <div className="p-3 space-y-3">
          {step.status === "skipped" && step.skip_reason && (
            // Make "skipped" self-explanatory — the #1 confusion on
            // the Runs page is a skipped Helix post with no hint as
            // to which condition gated it.
            <div>
              <SectionTitle>Why skipped</SectionTitle>
              <div className="text-xs text-amber-200/90 bg-amber-950/30 border border-amber-900/50 rounded p-2 leading-relaxed">
                {step.skip_reason}
              </div>
            </div>
          )}
          {step.error && (
            <div>
              <SectionTitle>Error</SectionTitle>
              <pre className="font-mono text-xs whitespace-pre-wrap break-words text-rose-300 bg-rose-950/40 border border-rose-900 rounded p-2">
                {step.error}
              </pre>
            </div>
          )}
          {phaseOrder.length > 0 && (
            // Collapse the per-phase checklist once everything's green —
            // it's mostly useful WHILE the step is running, and post-
            // success the per-phase detail is noise (the headline says
            // "success" already). Failures + in-flight runs auto-open.
            <details open={step.status !== "success"}>
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-200 mb-2">
                Progress ({phaseOrder.length} phases)
              </summary>
              <ul className="space-y-1">
                {phaseOrder.map((phase) => {
                  const status = phaseStatus.get(phase) ?? "pending";
                  const msg = phaseLastMsg.get(phase) ?? null;
                  return (
                    <li
                      key={phase}
                      className="flex items-start gap-2 text-xs"
                      title={msg ?? undefined}
                    >
                      <span className="w-4 text-center pt-0.5">
                        {status === "success"
                          ? "✓"
                          : status === "failed"
                            ? "✗"
                            : status === "running"
                              ? "…"
                              : "○"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div
                          className={
                            status === "failed"
                              ? "text-rose-300"
                              : status === "success"
                                ? "text-emerald-300"
                                : status === "running"
                                  ? "text-sky-300"
                                  : "text-slate-400"
                          }
                        >
                          {phase}
                        </div>
                        {msg && (
                          <div className="text-[11px] text-slate-500 truncate">
                            {msg}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
          {/* The free-form log panel — surfaces fallback notes, ffmpeg
              stderr on retries, and the exact Helix POST body so users
              can debug schema rejections. */}
          {logs.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs uppercase tracking-wider text-slate-500 hover:text-slate-300">
                Log ({logs.length})
              </summary>
              <pre className="mt-2 bg-slate-950 rounded p-2 text-[11px] font-mono whitespace-pre-wrap break-words text-slate-300 max-h-64 overflow-y-auto">
                {logs
                  .map(
                    (l) =>
                      `[${new Date(l.ts).toLocaleTimeString()}] ${l.message}`,
                  )
                  .join("\n")}
              </pre>
            </details>
          )}
          {clipUrl && (
            <div>
              <SectionTitle>Clip</SectionTitle>
              <video
                src={clipUrl}
                controls
                preload="metadata"
                className="w-full max-w-md rounded bg-black"
              />
            </div>
          )}
          {imageUrl && (
            <div>
              <SectionTitle>Image</SectionTitle>
              <a href={imageUrl} target="_blank" rel="noreferrer">
                <img
                  src={imageUrl}
                  className="w-full max-w-md rounded bg-black object-contain max-h-[30vh]"
                  alt="captured still — click for full-size"
                />
              </a>
              <div className="text-[10px] text-slate-500 mt-1">
                click to open full-size
              </div>
            </div>
          )}
          {stepCostUsd(step) !== null && (
            <div>
              <SectionTitle>Cost (est.)</SectionTitle>
              <CostDetail step={step} />
            </div>
          )}
          {step.output !== undefined && step.output !== null && (
            <OutputSection output={step.output} />
          )}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
      {children}
    </h3>
  );
}
