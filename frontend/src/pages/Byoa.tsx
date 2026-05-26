import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  apiGet,
  apiPost,
  Connection,
  HelixEventType,
  PromptTemplate,
  RunDetail,
  VerkadaCamera,
  WebhookEvent,
} from "../lib/api";
import EpochPicker from "../components/EpochPicker";
import HelixEventTypeEditor from "../components/HelixEventTypeEditor";
import { BetaChip, CostChip } from "../components/StepConfigForm";


// Mirror the model list the action editor uses so the dropdown stays in
// sync with what's actually supported. Kept inline here (not imported from
// the action schema) because this page hits a different endpoint shape.
interface ModelChoice {
  value: string;
  label: string;
  tier: "$" | "$$" | "$$$";
  preview: boolean;
  tagline: string;
}


// Mirrors backend GEMINI_MODELS in gemini_analyze_camera.py. Kept inline
// because BYOA hits a different endpoint and isn't driven by the
// action-schema dropdown.
const GEMINI_MODELS: ModelChoice[] = [
  {
    value: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    tier: "$",
    preview: false,
    tagline: "cheapest, fast — great for simple OCR / yes-no checks",
  },
  {
    value: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    tier: "$",
    preview: false,
    tagline: "balanced default — solid quality for most camera prompts",
  },
  {
    value: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    tier: "$$$",
    preview: false,
    tagline: "highest-quality stable Pro — best for nuanced / complex prompts",
  },
  {
    value: "gemini-3-flash-preview",
    label: "Gemini 3 Flash",
    tier: "$$",
    preview: true,
    tagline: "newer Flash variant, BETA — quality / speed may vary",
  },
  {
    value: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    tier: "$$$",
    preview: true,
    tagline: "newest Pro variant, BETA — even pricier than 2.5 Pro",
  },
];


const DEFAULT_PROMPT =
  "Describe only what is clearly visible in this security camera footage. If the scene is dark or unclear, describe what you can see including that it is dark. Do not invent or imagine details that are not visible. Response is capped at 198–199 chars.";


export default function Byoa() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const fromRunId = searchParams.get("from_run");
  // ``?from_event=<id>`` arrives from the WebhookInbox "Open in
  // Workbench" button. We resolve the event below and seed camera_id
  // + start_epoch + historical mode so the operator lands ready to
  // hit Brew. Cleared from the URL after first read so subsequent
  // edits don't keep re-seeding state.
  const fromEventId = searchParams.get("from_event");
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
  });
  const verkadaConns = (connections.data ?? []).filter(
    (c) => c.type === "verkada" && c.setup_complete,
  );
  const geminiConns = (connections.data ?? []).filter(
    (c) => c.type === "gemini" && c.setup_complete,
  );

  const [verkadaConnId, setVerkadaConnId] = useState<string>("");
  const [geminiConnId, setGeminiConnId] = useState<string>("");

  useEffect(() => {
    if (!verkadaConnId && verkadaConns.length > 0) setVerkadaConnId(verkadaConns[0].id);
    if (!geminiConnId && geminiConns.length > 0) setGeminiConnId(geminiConns[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verkadaConns.length, geminiConns.length]);

  const cameras = useQuery({
    queryKey: ["verkada-cameras", verkadaConnId],
    queryFn: () =>
      apiGet<VerkadaCamera[]>(
        `/api/verkada/cameras?connection_id=${verkadaConnId}`,
      ),
    enabled: !!verkadaConnId,
  });
  const userTemplates = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: () => apiGet<PromptTemplate[]>("/api/prompt-templates"),
  });
  interface BuiltinTemplate {
    name: string;
    value: string;
    // Optional Helix pairing — see /api/prompt-templates/builtins.
    // When present, picking the template auto-toggles "Post to Helix",
    // selects the matching event type by name (if one exists on the
    // current connection), and shows a banner explaining the pairing.
    helix_event_type?: {
      event_type_uid: string;
      name: string;
      event_schema: Record<string, string>;
    };
    helix_attribute_mapping?: Record<string, string>;
  }
  const builtinTemplates = useQuery({
    queryKey: ["prompt-templates-builtins"],
    queryFn: () =>
      apiGet<BuiltinTemplate[]>("/api/prompt-templates/builtins"),
    staleTime: 60_000,
  });

  const [cameraId, setCameraId] = useState("");
  const [onlineOnly, setOnlineOnly] = useState(true);
  const [mode, setMode] = useState<"live" | "historical">("live");
  const [postToHelix, setPostToHelix] = useState(false);
  const [helixEventTypeUid, setHelixEventTypeUid] = useState<string>("");
  const [helixAttribute, setHelixAttribute] = useState<string>("");
  // Inline "+ New type" editor toggle. When opened with a paired
  // prompt selected we seed the form from the paired definition so
  // the operator clicks once and gets the schema pre-filled.
  const [creatingHelixType, setCreatingHelixType] = useState(false);

  // Helix event types for the picked Verkada connection — feeds both
  // dropdowns below the "Post to Helix" toggle. Same endpoint the action
  // editor uses.
  const helixTypes = useQuery({
    queryKey: ["helix-event-types", verkadaConnId],
    queryFn: () =>
      apiGet<HelixEventType[]>(
        `/api/connections/${verkadaConnId}/helix-event-types`,
      ),
    enabled: !!verkadaConnId && postToHelix,
    staleTime: 30_000,
  });
  // Whenever the picked event type changes, default the attribute to
  // "Summary" if that key exists, otherwise the first string field —
  // matches the most common Helix shape ("Summary": "AI text here").
  // Lives AFTER the helixTypes query so it can reference helixTypes.data
  // without a temporal-dead-zone access.
  const pickedHelixEvent = (helixTypes.data ?? []).find(
    (e) => e.event_type_uid === helixEventTypeUid,
  );
  const helixAttrOptions = useMemo(() => {
    if (!pickedHelixEvent?.event_schema) return [];
    return Object.entries(pickedHelixEvent.event_schema).map(([k, t]) => ({
      key: k,
      type: t,
    }));
  }, [pickedHelixEvent]);
  useEffect(() => {
    if (!pickedHelixEvent) {
      setHelixAttribute("");
      return;
    }
    const keys = Object.keys(pickedHelixEvent.event_schema ?? {});
    if (helixAttribute && keys.includes(helixAttribute)) return;
    const preferred =
      keys.find((k) => k.toLowerCase() === "summary") ?? keys[0] ?? "";
    setHelixAttribute(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedHelixEvent]);
  const [model, setModel] = useState(GEMINI_MODELS[0].value);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  // Historical inputs. ``startEpoch`` is owned directly by EpochPicker
  // (canonical unix seconds); duration + pre-roll are local.
  const [startEpoch, setStartEpoch] = useState<number | null>(null);
  const [durationSec, setDurationSec] = useState<number>(10);
  const [preRollSec, setPreRollSec] = useState<number>(2);

  // "Run it back" hydration. Lives AFTER all state declarations so the
  // effect's closure captures fully-initialized setX bindings — keeps
  // bundlers / React strict-mode double-invoke from racing the TDZ.
  // Pulls the run once on mount, overwrites every local field, then
  // clears the search param so subsequent edits don't get reset.
  useEffect(() => {
    if (!fromRunId) return;
    let cancelled = false;
    apiGet<RunDetail>(`/api/runs/${fromRunId}`)
      .then((run) => {
        if (cancelled) return;
        const inp = run.input as Record<string, unknown> | null;
        if (!inp || !inp.byoa) return;
        if (typeof inp.connection_id === "string") setVerkadaConnId(inp.connection_id);
        if (typeof inp.gemini_connection_id === "string")
          setGeminiConnId(inp.gemini_connection_id);
        if (typeof inp.camera_id === "string") setCameraId(inp.camera_id);
        if (inp.mode === "live" || inp.mode === "historical") setMode(inp.mode);
        if (typeof inp.model === "string") setModel(inp.model);
        if (typeof inp.prompt === "string") setPrompt(inp.prompt);
        if (typeof inp.start_epoch === "number") setStartEpoch(inp.start_epoch);
        if (typeof inp.duration_sec === "number")
          setDurationSec(inp.duration_sec);
        if (typeof inp.pre_roll_sec === "number")
          setPreRollSec(inp.pre_roll_sec);
        if (inp.post_to_helix) {
          setPostToHelix(true);
          if (typeof inp.helix_event_type_uid === "string")
            setHelixEventTypeUid(inp.helix_event_type_uid);
          if (typeof inp.helix_attribute === "string")
            setHelixAttribute(inp.helix_attribute);
        }
        setSearchParams({}, { replace: true });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromRunId]);

  // "Open in Workbench" hydration. Same pattern as the run-it-back
  // effect but seeded from a webhook event: pull camera_id +
  // event timestamp out of the event's body and switch to historical
  // mode so the operator can re-analyze exactly the frame Verkada
  // sent. Verkada connection is matched by org_id when possible.
  useEffect(() => {
    if (!fromEventId) return;
    let cancelled = false;
    apiGet<WebhookEvent>(`/api/webhook-events/${fromEventId}`)
      .then((event) => {
        if (cancelled) return;
        const body = (event.body_json ?? {}) as Record<string, unknown>;
        const data =
          body && typeof body === "object"
            ? ((body as Record<string, unknown>).data as
                | Record<string, unknown>
                | undefined)
            : undefined;
        const camId =
          typeof data?.camera_id === "string" ? data.camera_id : null;
        // Verkada sends ``created`` as unix-seconds — perfect for our
        // historical start_epoch field. Some event types use other
        // names ("timestamp", "time"); fall through them in order.
        const createdRaw =
          (typeof data?.created === "number" && data.created) ||
          (typeof data?.timestamp === "number" && data.timestamp) ||
          (typeof data?.time === "number" && data.time) ||
          null;
        if (camId) setCameraId(camId);
        if (typeof createdRaw === "number" && createdRaw > 0) {
          setStartEpoch(createdRaw);
          setMode("historical");
        }
        // Match the Verkada connection by org if we can — when an
        // operator has multiple Verkada connections, the event tells
        // us which one this came from.
        if (event.org_id) {
          const match = verkadaConns.find((c) => c.external_id === event.org_id);
          if (match) setVerkadaConnId(match.id);
        }
        setSearchParams({}, { replace: true });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromEventId, verkadaConns.length]);

  // Merge templates: user entries first, then built-ins. User templates
  // never carry Helix pairing (no UI for setting it yet) so they coerce
  // to the same BuiltinTemplate shape with the optional fields absent.
  const allTemplates = useMemo<BuiltinTemplate[]>(
    () => [
      ...(userTemplates.data ?? []).map((t) => ({ name: t.name, value: t.value })),
      ...(builtinTemplates.data ?? []),
    ],
    [userTemplates.data, builtinTemplates.data],
  );

  // The template the operator picked most recently. Held in local state
  // so we can render the "Pairs with X" hint and react to changes in
  // the picked Verkada connection (re-resolve the matching Helix type).
  const [pickedTemplate, setPickedTemplate] = useState<BuiltinTemplate | null>(null);

  // When a paired template is selected, auto-toggle "Post to Helix" and
  // try to select the matching event type by name on the current
  // Verkada connection. If the type doesn't exist on the org yet, the
  // toggle still flips on so the UI surfaces the "Create" affordance.
  useEffect(() => {
    if (!pickedTemplate?.helix_event_type) return;
    setPostToHelix(true);
    if (!helixTypes.data) return;
    const wantedName = pickedTemplate.helix_event_type.name.trim().toLowerCase();
    const match = helixTypes.data.find(
      (h) => (h.name ?? "").trim().toLowerCase() === wantedName,
    );
    if (match) setHelixEventTypeUid(match.event_type_uid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedTemplate, helixTypes.data]);

  const [err, setErr] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        connection_id: verkadaConnId,
        gemini_connection_id: geminiConnId,
        camera_id: cameraId.trim(),
        mode,
        prompt,
        model,
      };
      if (mode === "historical") {
        body.start_epoch = startEpoch;
        body.duration_sec = durationSec;
        body.pre_roll_sec = preRollSec;
      }
      if (postToHelix) {
        body.post_to_helix = true;
        body.helix_event_type_uid = helixEventTypeUid;
        // When a paired prompt is selected we send its multi-attribute
        // mapping straight through to the worker — every Helix field
        // declared by the paired type gets its own value (Issue,
        // Severity, Reasoning, etc.) instead of stuffing the entire
        // JSON blob into one. The legacy single-attribute path stays
        // for unpaired prompts where the operator picks an attribute
        // manually.
        if (pickedTemplate?.helix_attribute_mapping) {
          body.helix_attribute_mapping = pickedTemplate.helix_attribute_mapping;
        } else {
          body.helix_attribute = helixAttribute;
        }
      }
      return apiPost<{ run_id: string }>("/api/byoa/run-once", body);
    },
    onSuccess: (res) => navigate(`/runs?selected=${res.run_id}`),
    onError: (e: Error) => setErr(e.message),
  });

  const noConnections = verkadaConns.length === 0 || geminiConns.length === 0;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {noConnections && (
        <Card>
          <div className="text-sm text-amber-200">
            You need at least one ready Verkada org and one ready Gemini API key
            in <a href="/connections" className="text-sky-300 hover:underline">Connections</a>{" "}
            before Workbench can run.
          </div>
        </Card>
      )}

      <Card>
        <Row>
          <Field label="Verkada connection" required>
            <select
              value={verkadaConnId}
              onChange={(e) => {
                setVerkadaConnId(e.target.value);
                setCameraId("");
              }}
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
            >
              <option value="">— pick —</option>
              {verkadaConns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Gemini connection" required>
            <select
              value={geminiConnId}
              onChange={(e) => setGeminiConnId(e.target.value)}
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
            >
              <option value="">— pick —</option>
              {geminiConns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </Row>

        <Field
          label="Camera"
          required
          help={
            verkadaConnId && (cameras.data?.length ?? 0) === 0
              ? "No cameras synced yet. Click 'Sync cameras' on the Connections page."
              : undefined
          }
        >
          {(() => {
            // Verkada's GET /cameras/v1/devices returns a status string
            // per camera ("Live" / "Offline" / a couple of transient states).
            // We treat anything not literally "Offline" as currently online
            // — that catches "Live" plus any future status the API adds for
            // healthy cameras without us having to chase the enum.
            const all = cameras.data ?? [];
            const isOnline = (s: string | null | undefined) =>
              !!s && s.toLowerCase() !== "offline";
            const online = all.filter((c) => isOnline(c.status));
            const list = onlineOnly ? online : all;
            const sorted = [...list].sort((a, b) =>
              (a.name ?? "").localeCompare(b.name ?? ""),
            );
            return (
              <>
                <div className="flex items-center gap-3 mb-1.5">
                  <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={onlineOnly}
                      onChange={(e) => setOnlineOnly(e.target.checked)}
                    />
                    Online cameras only
                  </label>
                  {all.length > 0 && (
                    <span className="text-[11px] text-slate-500">
                      {onlineOnly
                        ? `${online.length} online · ${all.length - online.length} offline hidden`
                        : `${online.length} online · ${all.length - online.length} offline · ${all.length} total`}
                    </span>
                  )}
                </div>
                <select
                  value={cameraId}
                  onChange={(e) => setCameraId(e.target.value)}
                  className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                  disabled={!verkadaConnId}
                >
                  <option value="">— pick a camera —</option>
                  {sorted.map((c) => {
                    const offline = !isOnline(c.status);
                    return (
                      <option key={c.camera_id} value={c.camera_id}>
                        {c.name ?? "(unnamed)"}
                        {c.site ? ` — ${c.site}` : ""}
                        {offline ? " · OFFLINE" : ""}
                      </option>
                    );
                  })}
                </select>
                <input
                  value={cameraId}
                  onChange={(e) => setCameraId(e.target.value)}
                  placeholder="or paste a camera_id UUID"
                  className="w-full px-2 py-1.5 mt-1 rounded bg-white/5 border border-white/10 text-xs font-mono"
                />
              </>
            );
          })()}
        </Field>

        <Row>
          <Field label="Footage" required>
            <div className="flex gap-2 text-sm">
              <ModeBtn
                active={mode === "live"}
                onClick={() => setMode("live")}
              >
                Live (still frame)
              </ModeBtn>
              <ModeBtn
                active={mode === "historical"}
                onClick={() => setMode("historical")}
              >
                Historical (clip)
              </ModeBtn>
            </div>
          </Field>
          <Field label="Model" required>
            <div className="space-y-1.5">
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                {GEMINI_MODELS.map((m) => {
                  const bits = [m.label, m.tier];
                  if (m.preview) bits.push("BETA");
                  return (
                    <option key={m.value} value={m.value}>
                      {bits.join(" · ")}
                    </option>
                  );
                })}
              </select>
              {(() => {
                const picked = GEMINI_MODELS.find((m) => m.value === model);
                if (!picked) return null;
                return (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <CostChip tier={picked.tier} />
                    {picked.preview && <BetaChip />}
                    <span className="text-[11px] text-slate-400">
                      {picked.tagline}
                    </span>
                  </div>
                );
              })()}
            </div>
          </Field>
        </Row>

        {mode === "historical" && (
          <>
            <Field label="Start time" required>
              <EpochPicker value={startEpoch} onChange={setStartEpoch} />
            </Field>
            <Row>
              <Field
                label="Duration (sec)"
                help="How long the clip is. Gemini bills per second of video."
              >
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={durationSec}
                  onChange={(e) => setDurationSec(Number(e.target.value) || 10)}
                  className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                />
              </Field>
              <Field
                label="Pre-roll (sec)"
                help="Clip starts this many seconds before start time."
              >
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={preRollSec}
                  onChange={(e) => setPreRollSec(Number(e.target.value) || 0)}
                  className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                />
              </Field>
            </Row>
          </>
        )}

        <Field label="Prompt" required>
          {allTemplates.length > 0 && (
            <>
              <select
                value=""
                onChange={(e) => {
                  const tpl = allTemplates.find((t) => t.name === e.target.value);
                  if (!tpl) return;
                  setPrompt(tpl.value);
                  setPickedTemplate(tpl);
                }}
                className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-xs mb-2"
              >
                <option value="">— insert template (replaces text below) —</option>
                {allTemplates.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                    {t.helix_event_type ? " · Helix-paired" : ""}
                  </option>
                ))}
              </select>
              {pickedTemplate?.helix_event_type && (
                <div className="text-[11px] bg-emerald-950/30 border border-emerald-900/60 rounded px-2 py-1.5 mb-2">
                  <div className="text-slate-300">
                    <span className="text-emerald-300">Pairs with Helix:</span>{" "}
                    <span className="text-slate-100 font-medium">
                      {pickedTemplate.helix_event_type.name}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                    {Object.entries(pickedTemplate.helix_event_type.event_schema)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(" · ")}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">
                    Post to Helix has been toggled on with this event type pre-selected. If it's not yet on your Verkada org, create it on the Helixr tab.
                  </div>
                </div>
              )}
            </>
          )}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            spellCheck={false}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
          />
        </Field>

        {/* Optional Helix post-step. Same machinery the verkada_helix_event
            flow action uses — Workbench just chains it after the analyze.
            Hidden until the operator picks a prompt template (or types a
            custom prompt) — there's nothing meaningful to log to Helix
            until we know what the model is actually being asked. The
            ``pickedTemplate``-driven effect above also auto-toggles the
            Post switch + pre-selects the matching event type when a
            Helix-paired prompt is chosen, so most operators never need
            to touch the toggle manually. */}
        {(pickedTemplate || (prompt.trim() !== "" && prompt !== DEFAULT_PROMPT)) && (
        <div className="border-t border-white/10 pt-4 space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={postToHelix}
              onChange={(e) => setPostToHelix(e.target.checked)}
            />
            <span className="text-sm text-slate-100">
              Post result to Helix
            </span>
            <span className="text-[11px] text-slate-500">
              {pickedTemplate?.helix_event_type
                ? `auto-paired with ${pickedTemplate.helix_event_type.name}`
                : "chain a verkada_helix_event step after the analyze"}
            </span>
          </label>
          {postToHelix && (
            <Row>
              {/*
                Stack the picker + create button vertically. Earlier we
                tucked the button inside ``Field`` (which wraps its
                children in a <label>), but a button-inside-a-label is
                a fragile clickable + visually disappears into the
                row. Pulling the button out as a sibling makes the
                create affordance obvious — especially when a paired
                prompt has primed a schema and we *want* the operator
                to notice it.
              */}
              <div>
                <Field
                  label="Helix event type"
                  required
                  help={
                    helixTypes.data && helixTypes.data.length === 0
                      ? "No event types synced yet. Click 'Sync helix' on the connection."
                      : "Synced from Verkada — pick which event type to post against."
                  }
                >
                  <select
                    value={helixEventTypeUid}
                    onChange={(e) => setHelixEventTypeUid(e.target.value)}
                    className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                  >
                    <option value="">— pick an event type —</option>
                    {(helixTypes.data ?? []).map((et) => (
                      <option key={et.id} value={et.event_type_uid}>
                        {et.name ?? "(unnamed)"}
                      </option>
                    ))}
                  </select>
                </Field>
                <button
                  type="button"
                  onClick={() => setCreatingHelixType(true)}
                  disabled={!verkadaConnId}
                  title={
                    pickedTemplate?.helix_event_type
                      ? `Create the ${pickedTemplate.helix_event_type.name} type on this Verkada org (schema pre-filled from the paired prompt).`
                      : "Create a new Helix event type on this Verkada org."
                  }
                  className="mt-2 inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded border border-emerald-700/60 bg-emerald-900/40 text-emerald-200 hover:bg-emerald-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span aria-hidden>+</span>
                  {pickedTemplate?.helix_event_type
                    ? `Create "${pickedTemplate.helix_event_type.name}" in Verkada`
                    : "New Helix event type"}
                </button>
              </div>
              {pickedTemplate?.helix_attribute_mapping ? (
                // Paired prompt — fields fill from the multi-attribute
                // mapping that travels with the prompt definition. Show
                // a read-only summary instead of the single-attribute
                // picker (which would be a downgrade).
                <Field label="Attribute mapping (from paired prompt)">
                  <div className="text-[11px] bg-emerald-950/30 border border-emerald-900/60 rounded px-2 py-1.5 space-y-0.5">
                    {Object.entries(pickedTemplate.helix_attribute_mapping).map(
                      ([k, v]) => (
                        <div key={k} className="font-mono text-slate-300">
                          <span className="text-emerald-300">{k}</span>
                          <span className="text-slate-500"> ← </span>
                          <span className="text-slate-100">{v}</span>
                        </div>
                      ),
                    )}
                  </div>
                </Field>
              ) : (
                <Field
                  label="Write AI text into"
                  required={postToHelix}
                  help={
                    helixAttrOptions.length > 0
                      ? "Other schema fields will be sent as empty strings."
                      : "Pick an event type first to see its attributes."
                  }
                >
                  <select
                    value={helixAttribute}
                    onChange={(e) => setHelixAttribute(e.target.value)}
                    disabled={helixAttrOptions.length === 0}
                    className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                  >
                    <option value="">— pick an attribute —</option>
                    {helixAttrOptions.map((a) => (
                      <option key={a.key} value={a.key}>
                        {a.key} ({a.type})
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </Row>
          )}
        </div>
        )}

        {err && (
          <div className="text-sm text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
            {err}
          </div>
        )}

        <div className="flex justify-end pt-2">
          <button
            onClick={() => {
              setErr(null);
              if (!verkadaConnId) return setErr("Pick a Verkada connection.");
              if (!geminiConnId) return setErr("Pick a Gemini connection.");
              if (!cameraId.trim()) return setErr("Pick a camera.");
              if (!prompt.trim()) return setErr("Prompt is required.");
              if (mode === "historical" && !startEpoch)
                return setErr("Pick a start time for historical mode.");
              if (postToHelix && !helixEventTypeUid)
                return setErr("Pick a Helix event type or turn off 'Post to Helix'.");
              if (postToHelix && !helixAttribute)
                return setErr("Pick which Helix attribute to write the AI text into.");
              run.mutate();
            }}
            disabled={run.isPending || noConnections}
            className="text-sm px-4 py-2 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
          >
            {run.isPending ? "Starting…" : "Brew it"}
          </button>
        </div>
      </Card>

      <p className="text-xs text-slate-500">
        Each run shows up under the Runs tab with the captured clip/image,
        the AI text, and the same per-phase progress checklist a flow
        execution gets.
      </p>

      {creatingHelixType && verkadaConnId && (
        <HelixEventTypeEditor
          connId={verkadaConnId}
          mode="create"
          // Seed the form from the paired prompt's helix definition
          // when one is selected — the operator opens the modal and
          // the name + attribute rows are already populated for the
          // common "the type doesn't exist on this org yet" path.
          seed={
            pickedTemplate?.helix_event_type
              ? {
                  name: pickedTemplate.helix_event_type.name,
                  event_schema: pickedTemplate.helix_event_type.event_schema,
                }
              : undefined
          }
          onClose={() => setCreatingHelixType(false)}
          onCreated={(created) => {
            // Land back on BYOA with the new type selected so the
            // operator can hit Brew immediately. The helix-types
            // query also invalidates inside the editor, so the
            // dropdown will repopulate on its own next render.
            setHelixEventTypeUid(created.event_type_uid);
          }}
        />
      )}
    </div>
  );
}


function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-5 space-y-4">
      {children}
    </div>
  );
}


function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{children}</div>;
}


function Field({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
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


function ModeBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
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
      {children}
    </button>
  );
}
