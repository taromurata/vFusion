import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  ActionFieldSpec,
  ActionSpec,
  ApiEndpointDetail,
  apiGet,
  Connection,
  HelixEventType,
  KnownDoor,
  KnownScenario,
  PromptTemplate,
  TriggerField,
  VerkadaCamera,
} from "../lib/api";
import { useCameras } from "../lib/cameras";
import EndpointPicker from "./EndpointPicker";
import HelixEventTypeEditor from "./HelixEventTypeEditor";
import VariablePicker from "./VariablePicker";

interface PriorStep {
  name: string;
  output_sample: unknown;
}

interface Props {
  spec: ActionSpec;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  triggerFamily?: string;
  triggerNotificationType?: string;
  priorSteps?: PriorStep[];
  /** For condition nodes — populates the operator dropdown. */
  operators?: string[];
  /**
   * Optional callback wired by the FlowEditor. When the operator picks
   * a paired-prompt template (one with embedded Helix metadata), the
   * editor renders a "+ Add Helix logging step" button under the
   * prompt field. Clicking calls this with the helix def + attribute
   * mapping + the current step's name so the editor can insert a
   * pre-wired ``verkada_helix_event`` node downstream.
   */
  onAddPairedHelixStep?: (args: {
    helix_event_type: {
      event_type_uid: string;
      name: string;
      event_schema: Record<string, string>;
    };
    helix_attribute_mapping: Record<string, string>;
    sourceStepName: string;
  }) => void;
  /**
   * The current step's name — needed to rewrite the prompt's
   * ``{{ output.* }}`` step-local refs into
   * ``{{ steps.<sourceStepName>.output.* }}`` at insertion time.
   * Omitted when the editor doesn't yet know the name (e.g. a
   * brand-new unsaved node).
   */
  currentStepName?: string;
}

/** Renders one action step's config form based on its ActionSpec schema. */
export default function StepConfigForm({
  spec,
  config,
  onChange,
  triggerFamily,
  triggerNotificationType,
  priorSteps = [],
  operators = [],
  onAddPairedHelixStep,
  currentStepName,
}: Props) {
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
  });
  const doors = useQuery({
    queryKey: ["verkada-doors"],
    queryFn: () => apiGet<KnownDoor[]>("/api/verkada/doors"),
  });
  const scenarios = useQuery({
    queryKey: ["verkada-scenarios", config.connection_id],
    queryFn: () => {
      const cid = config.connection_id;
      const qs =
        typeof cid === "string" && cid
          ? `?connection_id=${encodeURIComponent(cid)}`
          : "";
      return apiGet<KnownScenario[]>(`/api/verkada/scenarios${qs}`);
    },
  });
  const cameras = useCameras();
  // User-saved prompt templates (Templates page). Merged into any field
  // schema that already declares built-in templates so users see both
  // sets in the picker.
  const userTemplates = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: () => apiGet<PromptTemplate[]>("/api/prompt-templates"),
  });
  // Used by the field auto-wire effect below — knows which trigger
  // fields exist so we can default things like camera_id to
  // {{ trigger.data.camera_id }} when names match.
  const triggerSample = useQuery({
    queryKey: ["trigger-fields", triggerFamily, triggerNotificationType],
    queryFn: () => {
      const params = new URLSearchParams();
      if (triggerFamily) params.set("family", triggerFamily);
      if (triggerNotificationType)
        params.set("notification_type", triggerNotificationType);
      return apiGet<TriggerField[]>(
        `/api/triggers/sample-fields?${params.toString()}`
      );
    },
    enabled: !!triggerFamily,
    staleTime: 60_000,
  });

  const setOne = (name: string, value: unknown) => {
    const next = { ...config };
    if (value === undefined || value === null || value === "") {
      delete next[name];
    } else {
      next[name] = value;
    }
    onChange(next);
  };

  // Auto-fill empty fields where the choice is obvious. Done once per
  // (spec, field) via a ref so clearing the field later doesn't keep
  // re-filling it. Three patterns covered:
  //
  // 1. connection_ref → first matching connection.
  // 2. text field whose name matches a prior step's output key →
  //    {{ steps.<that step>.output.<name> }}. Lets gemini_analyze_video's
  //    clip_path auto-wire from verkada_grab_clip's clip_path output.
  // 3. text field whose name matches a trigger.data.<name> key →
  //    {{ trigger.data.<name> }}. Lets verkada_grab_clip's camera_id
  //    auto-wire from {{ trigger.data.camera_id }}.
  const autofilledRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const conns = connections.data ?? [];
    const triggerFields = triggerSample.data ?? [];
    const triggerKeys = new Set<string>();
    for (const t of triggerFields) {
      if (!t.path.startsWith("trigger.data.")) continue;
      const tail = t.path.slice("trigger.data.".length);
      if (!tail || tail.includes(".") || tail.endsWith(".0")) continue;
      if (t.sample === null || t.sample === undefined) continue;
      triggerKeys.add(tail);
    }

    let patched: Record<string, unknown> | null = null;

    for (const f of spec.schema.fields) {
      const key = `${spec.label}::${f.name}`;
      if (autofilledRef.current.has(key)) continue;
      if (config[f.name]) {
        autofilledRef.current.add(key);
        continue;
      }

      if (f.type === "connection_ref") {
        if (conns.length === 0) continue;
        const match = conns.find(
          (c) =>
            (!f.connection_type || c.type === f.connection_type) &&
            c.setup_complete,
        );
        if (match) {
          autofilledRef.current.add(key);
          patched = { ...(patched ?? config), [f.name]: match.id };
        }
        continue;
      }

      if (f.type === "text") {
        // (2) prior-step output name match — prefer the most recent.
        let wired = false;
        for (let i = priorSteps.length - 1; i >= 0; i--) {
          const step = priorSteps[i];
          const sample = step.output_sample;
          if (
            sample &&
            typeof sample === "object" &&
            !Array.isArray(sample) &&
            f.name in (sample as Record<string, unknown>)
          ) {
            autofilledRef.current.add(key);
            patched = {
              ...(patched ?? config),
              [f.name]: `{{ steps.${step.name}.output.${f.name} }}`,
            };
            wired = true;
            break;
          }
        }
        if (wired) continue;
        // (3) trigger.data field name match.
        if (triggerKeys.has(f.name)) {
          autofilledRef.current.add(key);
          patched = {
            ...(patched ?? config),
            [f.name]: `{{ trigger.data.${f.name} }}`,
          };
          continue;
        }
        // (4) explicit default_template on the field schema.
        if (typeof f.default_template === "string" && f.default_template) {
          autofilledRef.current.add(key);
          patched = {
            ...(patched ?? config),
            [f.name]: f.default_template,
          };
        }
      }
    }
    if (patched) onChange(patched);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, connections.data, triggerSample.data, priorSteps]);

  // Merge user-saved templates into any field that already declares
  // built-in templates. User entries are listed first so the most-recent
  // intent is at the top of the dropdown.
  const userTplList = userTemplates.data ?? [];
  const mergeTemplates = (f: ActionFieldSpec): ActionFieldSpec => {
    if (!f.templates || userTplList.length === 0) return f;
    const merged = [
      ...userTplList.map((t) => ({ name: t.name, value: t.value })),
      ...f.templates,
    ];
    return { ...f, templates: merged };
  };
  const renderOne = (f: ActionFieldSpec) => {
    const fm = mergeTemplates(f);
    return (
      <Field
        key={fm.name}
        label={fm.label}
        help={fm.help}
        required={fm.required}
        docsUrl={fm.docs_url}
      >
        {renderControl(
          fm,
          config,
          setOne,
          onChange,
          connections.data ?? [],
          doors.data ?? [],
          scenarios.data ?? [],
          cameras.data ?? [],
          triggerFamily,
          triggerNotificationType,
          priorSteps,
          operators,
          onAddPairedHelixStep,
          currentStepName,
        )}
      </Field>
    );
  };
  const primary = spec.schema.fields.filter((f) => f.group !== "advanced");
  const advanced = spec.schema.fields.filter((f) => f.group === "advanced");
  return (
    <div className="space-y-3">
      {primary.map(renderOne)}
      {advanced.length > 0 && (
        <details className="border border-white/10 rounded-md bg-white/5">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs uppercase tracking-wider text-slate-400 hover:text-slate-200">
            Advanced
          </summary>
          <div className="px-3 pb-3 pt-1 space-y-3">
            {advanced.map(renderOne)}
          </div>
        </details>
      )}
    </div>
  );
}

function renderControl(
  f: ActionFieldSpec,
  config: Record<string, unknown>,
  setOne: (name: string, value: unknown) => void,
  setAll: (config: Record<string, unknown>) => void,
  connections: Connection[],
  doors: KnownDoor[],
  scenariosList: KnownScenario[],
  camerasList: VerkadaCamera[],
  triggerFamily: string | undefined,
  triggerNotificationType: string | undefined,
  priorSteps: PriorStep[],
  operators: string[],
  onAddPairedHelixStep: Props["onAddPairedHelixStep"],
  currentStepName: Props["currentStepName"],
): JSX.Element {
  if (f.type === "connection_ref") {
    return (
      <select
        value={(config[f.name] as string) ?? ""}
        onChange={(e) => setOne(f.name, e.target.value)}
        className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
      >
        <option value="">— pick a connection —</option>
        {connections
          .filter((c) => !f.connection_type || c.type === f.connection_type)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {!c.setup_complete ? " (needs api key!)" : ""}
            </option>
          ))}
      </select>
    );
  }
  if (f.type === "door_ref") {
    return (
      <>
        <select
          value={(config[f.name] as string) ?? ""}
          onChange={(e) => setOne(f.name, e.target.value)}
          className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
        >
          <option value="">— pick a door —</option>
          {doors.map((d) => (
            <option key={d.door_id} value={d.door_id}>
              {d.name ?? "(unnamed)"}
              {d.site_name ? ` — ${d.site_name}` : ""}
            </option>
          ))}
        </select>
        <input
          value={(config[f.name] as string) ?? ""}
          onChange={(e) => setOne(f.name, e.target.value)}
          className="w-full px-2 py-1.5 mt-1 rounded bg-white/5 border border-white/10 text-xs font-mono"
          placeholder="or paste door_id UUID"
        />
      </>
    );
  }
  if (f.type === "camera_ref") {
    // Filter by the picked Verkada connection when one is set on the
    // same step. Stops the dropdown from showing cameras from orgs
    // that aren't authorized to act on this flow.
    const connId =
      typeof config.connection_id === "string" ? config.connection_id : "";
    const visible = connId
      ? camerasList.filter((c) => c.connection_id === connId)
      : camerasList;
    return (
      <>
        <select
          value={(config[f.name] as string) ?? ""}
          onChange={(e) => setOne(f.name, e.target.value)}
          className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
        >
          <option value="">— pick a camera —</option>
          {visible.map((c) => (
            <option key={c.camera_id} value={c.camera_id}>
              {c.name ?? "(unnamed)"}
              {c.site ? ` — ${c.site}` : ""}
              {c.model ? ` · ${c.model}` : ""}
            </option>
          ))}
        </select>
        <input
          value={(config[f.name] as string) ?? ""}
          onChange={(e) => setOne(f.name, e.target.value)}
          className="w-full px-2 py-1.5 mt-1 rounded bg-white/5 border border-white/10 text-xs font-mono"
          placeholder="or paste camera_id / template ref like {{ trigger.data.camera_id }}"
        />
        {visible.length === 0 && (
          <div className="text-[11px] text-amber-300/80 mt-1">
            {connId
              ? "No cameras synced for this connection yet — click Sync cameras on the Connections page."
              : "Pick a Verkada connection above to populate the camera list."}
          </div>
        )}
      </>
    );
  }
  if (f.type === "scenario_ref") {
    const list = scenariosList;
    return (
      <>
        <select
          value={(config[f.name] as string) ?? ""}
          onChange={(e) => setOne(f.name, e.target.value)}
          className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
        >
          <option value="">— pick a scenario —</option>
          {list.map((s) => (
            <option key={s.scenario_id} value={s.scenario_id}>
              {s.name ?? "(unnamed)"}
              {s.scenario_type ? ` — ${s.scenario_type}` : ""}
            </option>
          ))}
        </select>
        <input
          value={(config[f.name] as string) ?? ""}
          onChange={(e) => setOne(f.name, e.target.value)}
          className="w-full px-2 py-1.5 mt-1 rounded bg-white/5 border border-white/10 text-xs font-mono"
          placeholder="or paste scenario_id UUID"
        />
        {list.length === 0 && (
          <div className="text-[11px] text-amber-300/80 mt-1">
            No scenarios synced yet — click <strong>Sync scenarios</strong> on
            the Connections page first.
          </div>
        )}
      </>
    );
  }
  if (f.type === "verkada_endpoint_ref") {
    return (
      <EndpointPicker
        value={(config[f.name] as string) ?? null}
        onChange={(endpoint) => {
          if (!endpoint) {
            const next = { ...config };
            delete next[f.name];
            delete next.path_params;
            delete next.body;
            setAll(next);
            return;
          }
          const pathParams: Record<string, string> = {};
          const re = /\{([^}]+)\}/g;
          let m;
          while ((m = re.exec(endpoint.path)) !== null) {
            pathParams[m[1]] = "";
          }
          const body = stubBodyFromSchema(endpoint.raw);
          const next: Record<string, unknown> = { ...config, [f.name]: endpoint.id };
          if (Object.keys(pathParams).length > 0) next.path_params = pathParams;
          else delete next.path_params;
          if (body !== undefined) next.body = body;
          else delete next.body;
          setAll(next);
        }}
      />
    );
  }
  if (f.type === "verkada_request_params") {
    return (
      <VerkadaRequestParamsField
        f={f}
        config={config}
        setOne={setOne}
        triggerFamily={triggerFamily}
        triggerNotificationType={triggerNotificationType}
        priorSteps={priorSteps}
      />
    );
  }
  if (f.type === "helix_event_ref") {
    return (
      <HelixEventRefField
        f={f}
        config={config}
        setAll={setAll}
      />
    );
  }
  if (f.type === "helix_attributes") {
    return (
      <HelixAttributesField
        f={f}
        config={config}
        setOne={setOne}
        triggerFamily={triggerFamily}
        triggerNotificationType={triggerNotificationType}
        priorSteps={priorSteps}
      />
    );
  }
  if (f.type === "json") {
    return (
      <JsonField
        value={config[f.name]}
        onChange={(v) => setOne(f.name, v)}
        triggerFamily={triggerFamily}
        triggerNotificationType={triggerNotificationType}
        priorSteps={priorSteps}
      />
    );
  }
  if (f.type === "select") {
    const current = (config[f.name] as string) ?? f.default ?? "";
    const picked = (f.options ?? []).find((o) => o.value === current);
    return (
      <div className="space-y-1.5">
        <select
          value={current}
          onChange={(e) => setOne(f.name, e.target.value)}
          className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
        >
          {(f.options ?? []).map((o) => {
            // <option> can't carry markup — chips re-render as text
            // here and as styled badges below the select for clarity.
            const bits = [o.label];
            if (o.tier) bits.push(o.tier);
            if (o.preview) bits.push("BETA");
            if (f.default === o.value) bits.push("default");
            return (
              <option key={o.value} value={o.value}>
                {bits.join(" · ")}
              </option>
            );
          })}
        </select>
        {picked && (picked.tier || picked.preview || picked.tagline) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {picked.tier && <CostChip tier={picked.tier} />}
            {picked.preview && <BetaChip />}
            {picked.tagline && (
              <span className="text-[11px] text-slate-400">{picked.tagline}</span>
            )}
          </div>
        )}
      </div>
    );
  }
  if (f.type === "operator") {
    return (
      <select
        value={(config[f.name] as string) ?? "equals"}
        onChange={(e) => setOne(f.name, e.target.value)}
        className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
      >
        {operators.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>
    );
  }
  // For multi-line "text" fields with prompt templates (e.g. Gemini's
  // prompt), use a textarea + a template picker dropdown. For short
  // text without templates, single-line input + variable picker.
  const hasTemplates = f.templates && f.templates.length > 0;
  const currentValue = (config[f.name] as string) ?? "";
  // When the current value exactly matches a paired-prompt template,
  // surface the Helix pairing affordance. Comparing on full value keeps
  // the button hidden after the operator edits the prompt — at that
  // point the mapping might not match what Gemini will actually
  // return, so we don't want to mis-suggest a Helix step.
  const matchedPairedTemplate =
    hasTemplates && onAddPairedHelixStep
      ? f.templates!.find(
          (t) =>
            t.value === currentValue &&
            !!t.helix_event_type &&
            !!t.helix_attribute_mapping,
        )
      : undefined;
  return (
    <div className="space-y-2">
      {hasTemplates && (
        <select
          value=""
          onChange={(e) => {
            const tpl = f.templates!.find((t) => t.name === e.target.value);
            if (tpl) setOne(f.name, tpl.value);
          }}
          className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 text-xs"
        >
          <option value="">— insert template (replaces text below) —</option>
          {f.templates!.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      <div className="flex gap-2 items-start">
        {hasTemplates ? (
          <textarea
            value={currentValue}
            onChange={(e) => setOne(f.name, e.target.value)}
            rows={4}
            spellCheck={false}
            className="flex-1 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm focus:outline-none focus:border-sky-600"
          />
        ) : (
          <input
            value={currentValue}
            onChange={(e) => setOne(f.name, e.target.value)}
            className="flex-1 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
          />
        )}
        {triggerFamily && (
          <VariablePicker
            family={triggerFamily}
            notificationType={triggerNotificationType || undefined}
            priorSteps={priorSteps}
            onPick={(path) => {
              const current = (config[f.name] as string) ?? "";
              setOne(f.name, current + `{{ ${path} }}`);
            }}
          />
        )}
      </div>
      {matchedPairedTemplate && currentStepName && (
        <div className="bg-emerald-950/30 border border-emerald-900/60 rounded px-3 py-2 text-xs flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-emerald-300 font-medium">
              Pairs with Helix:{" "}
              <span className="text-slate-100">
                {matchedPairedTemplate.helix_event_type!.name}
              </span>
            </div>
            <div className="text-[10px] text-slate-400 font-mono mt-0.5">
              {Object.entries(matchedPairedTemplate.helix_event_type!.event_schema)
                .map(([k, v]) => `${k}: ${v}`)
                .join(" · ")}
            </div>
          </div>
          <button
            type="button"
            onClick={() =>
              onAddPairedHelixStep!({
                helix_event_type: matchedPairedTemplate.helix_event_type!,
                helix_attribute_mapping:
                  matchedPairedTemplate.helix_attribute_mapping!,
                sourceStepName: currentStepName,
              })
            }
            className="shrink-0 text-xs px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white font-semibold"
            title="Insert a downstream Helix event step pre-wired with the right attributes."
          >
            + Add Helix logging step
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Helix event type picker -----------------------------------------------
//
// Renders a dropdown of Helix event types synced from the user's Verkada org.
// When the user picks one, we set this field to the event_type_uid AND
// seed the sibling "attributes" field with one empty entry per schema key,
// so the user lands in a structured editor pre-keyed by the event schema.

function HelixEventRefField({
  f,
  config,
  setAll,
}: {
  f: ActionFieldSpec;
  config: Record<string, unknown>;
  setAll: (config: Record<string, unknown>) => void;
}) {
  const connId = f.connection_field
    ? (config[f.connection_field] as string | undefined)
    : undefined;
  const attrsField = f.attributes_field;
  const evtTypes = useQuery({
    queryKey: ["helix-event-types", connId],
    queryFn: () =>
      apiGet<HelixEventType[]>(`/api/connections/${connId}/helix-event-types`),
    enabled: !!connId,
    staleTime: 30_000,
  });
  // ``creating`` toggles the inline editor modal. On successful create
  // we auto-select the new type so the operator doesn't have to find
  // it in the dropdown manually. Same modal the Helixr page uses.
  const [creating, setCreating] = useState(false);
  const current = (config[f.name] as string) ?? "";
  return (
    <>
      <div className="flex gap-2 items-start">
        <select
          value={current}
          onChange={(e) => {
            const uid = e.target.value;
            const next: Record<string, unknown> = { ...config, [f.name]: uid };
            if (attrsField) {
              const picked = (evtTypes.data ?? []).find(
                (et) => et.event_type_uid === uid,
              );
              const schema = picked?.event_schema ?? {};
              const seeded: Record<string, string> = {};
              for (const k of Object.keys(schema)) seeded[k] = "";
              next[attrsField] = seeded;
            }
            setAll(next);
          }}
          disabled={!connId}
          className="flex-1 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
        >
          <option value="">
            {!connId
              ? "— pick a Verkada connection first —"
              : evtTypes.data && evtTypes.data.length === 0
                ? "— none synced yet (click 'Sync helix' on the connection) —"
                : "— pick an event type —"}
          </option>
          {(evtTypes.data ?? []).map((et) => (
            <option key={et.id} value={et.event_type_uid}>
              {et.name ?? "(unnamed)"}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={!connId}
          title="Create a new Helix event type on this connection's Verkada org"
          className="shrink-0 text-xs px-3 py-1.5 rounded border border-emerald-700/60 bg-emerald-900/40 text-emerald-200 hover:bg-emerald-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          + New type
        </button>
      </div>
      {creating && connId && (
        <HelixEventTypeEditor
          connId={connId}
          mode="create"
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            // Drop the new type's uid into this field + seed the
            // attributes form below it with the new schema so the
            // operator lands ready to fill in values.
            const next: Record<string, unknown> = {
              ...config,
              [f.name]: created.event_type_uid,
            };
            if (attrsField) {
              const seeded: Record<string, string> = {};
              for (const k of Object.keys(created.event_schema ?? {}))
                seeded[k] = "";
              next[attrsField] = seeded;
            }
            setAll(next);
          }}
        />
      )}
    </>
  );
}


// ---- Helix structured attributes ------------------------------------------
//
// Renders the attributes JSON as a labeled key-per-row form when we know
// the Helix schema for the selected event type. Each row has the same
// {input + variable picker} pair we use for text fields, so users can drop
// in {{ steps.analyze.output.text }} without writing JSON. Falls back to
// raw JSON when the event type is unknown / not synced.

function HelixAttributesField({
  f,
  config,
  setOne,
  triggerFamily,
  triggerNotificationType,
  priorSteps,
}: {
  f: ActionFieldSpec;
  config: Record<string, unknown>;
  setOne: (name: string, value: unknown) => void;
  triggerFamily?: string;
  triggerNotificationType?: string;
  priorSteps: PriorStep[];
}) {
  const connId = f.connection_field
    ? (config[f.connection_field] as string | undefined)
    : undefined;
  const uid = f.event_type_field
    ? (config[f.event_type_field] as string | undefined)
    : undefined;
  const evtTypes = useQuery({
    queryKey: ["helix-event-types", connId],
    queryFn: () =>
      apiGet<HelixEventType[]>(`/api/connections/${connId}/helix-event-types`),
    enabled: !!connId,
    staleTime: 30_000,
  });
  const picked = (evtTypes.data ?? []).find((et) => et.event_type_uid === uid);
  const schema = picked?.event_schema ?? null;

  const value =
    config[f.name] && typeof config[f.name] === "object" && !Array.isArray(config[f.name])
      ? (config[f.name] as Record<string, string>)
      : {};

  // Schema unknown → fall back to raw JSON so the user can still hand-edit.
  if (!schema) {
    return (
      <JsonField
        value={config[f.name]}
        onChange={(v) => setOne(f.name, v)}
        triggerFamily={triggerFamily}
        triggerNotificationType={triggerNotificationType}
        priorSteps={priorSteps}
      />
    );
  }

  const setKey = (k: string, v: string) => {
    const next = { ...value, [k]: v };
    setOne(f.name, next);
  };

  return (
    <div className="space-y-2">
      {Object.entries(schema).map(([k, t]) => (
        <div key={k} className="space-y-1">
          <div className="text-[11px] font-medium text-slate-300 flex items-center gap-2">
            <span>{k}</span>
            <span className="text-[10px] text-slate-500 lowercase">{t}</span>
          </div>
          <div className="flex gap-2 items-start">
            <input
              value={value[k] ?? ""}
              onChange={(e) => setKey(k, e.target.value)}
              className="flex-1 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              placeholder={`{{ steps.<name>.output.* }}`}
            />
            {triggerFamily && (
              <VariablePicker
                family={triggerFamily}
                notificationType={triggerNotificationType || undefined}
                priorSteps={priorSteps}
                onPick={(path) =>
                  setKey(k, (value[k] ?? "") + `{{ ${path} }}`)
                }
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}


function JsonField({
  value,
  onChange,
  triggerFamily,
  triggerNotificationType,
  priorSteps,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  triggerFamily?: string;
  triggerNotificationType?: string;
  priorSteps: PriorStep[];
}) {
  const [text, setText] = useState(() =>
    value === undefined || value === null ? "" : JSON.stringify(value, null, 2)
  );
  const [err, setErr] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastCursorRef = useRef<number>(text.length);

  useEffect(() => {
    const incoming =
      value === undefined || value === null ? "" : JSON.stringify(value, null, 2);
    setText((prev) => (prev === incoming ? prev : incoming));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);

  const commit = (next: string) => {
    setText(next);
    if (!next.trim()) {
      onChange(undefined);
      setErr(null);
      return;
    }
    try {
      onChange(JSON.parse(next));
      setErr(null);
    } catch (ex) {
      setErr((ex as Error).message);
    }
  };

  const insertAtCursor = (path: string) => {
    const ta = textareaRef.current;
    const pos = ta?.selectionStart ?? lastCursorRef.current ?? text.length;
    const snippet = `{{ ${path} }}`;
    const next = text.slice(0, pos) + snippet + text.slice(pos);
    commit(next);
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus();
        const newPos = pos + snippet.length;
        ta.setSelectionRange(newPos, newPos);
        lastCursorRef.current = newPos;
      }
    });
  };

  return (
    <div>
      <div className="flex items-start gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => commit(e.target.value)}
          onSelect={(e) => {
            lastCursorRef.current = e.currentTarget.selectionStart;
          }}
          onBlur={(e) => {
            lastCursorRef.current = e.currentTarget.selectionStart;
          }}
          rows={6}
          spellCheck={false}
          className="flex-1 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-xs font-mono focus:outline-none focus:border-sky-600"
          placeholder='e.g. { "door_id": "{{ trigger.data.door_id }}" }'
        />
        {triggerFamily && (
          <VariablePicker
            family={triggerFamily}
            notificationType={triggerNotificationType || undefined}
            priorSteps={priorSteps}
            onPick={insertAtCursor}
          />
        )}
      </div>
      {err && <div className="text-xs text-rose-300 mt-1">JSON: {err}</div>}
    </div>
  );
}

function stubBodyFromSchema(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return undefined;
  const rb = (raw as { requestBody?: { content?: Record<string, { schema?: unknown }> } })
    .requestBody;
  const schema = rb?.content?.["application/json"]?.schema;
  if (!schema || typeof schema !== "object") return undefined;
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return {};
  const stub: Record<string, string> = {};
  for (const k of Object.keys(props)) stub[k] = "";
  return stub;
}

// ---- Verkada API call: structured path / query / body editor -------------
//
// Reads the currently-picked endpoint's OpenAPI schema and renders a
// labeled row per parameter (name, type chip, required asterisk,
// description, example) with an input field + variable picker. Persists
// values into config.path_params, config.query_params, and config.body
// — same keys the backend's verkada_api_call.run() reads.

interface OAParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: OASchema;
  example?: unknown;
}


interface OASchema {
  type?: string;
  format?: string;
  description?: string;
  enum?: unknown[];
  items?: OASchema;
  properties?: Record<string, OASchema>;
  required?: string[];
  example?: unknown;
  default?: unknown;
  $ref?: string;
}


function shortType(schema?: OASchema | null): string {
  if (!schema) return "any";
  if (schema.$ref) {
    const slash = schema.$ref.lastIndexOf("/");
    return slash >= 0 ? schema.$ref.slice(slash + 1) : schema.$ref;
  }
  if (schema.type === "array") return `array<${shortType(schema.items)}>`;
  if (schema.type) {
    return schema.format ? `${schema.type} (${schema.format})` : schema.type;
  }
  if (schema.properties) return "object";
  return "any";
}


function VerkadaRequestParamsField({
  f,
  config,
  setOne,
  triggerFamily,
  triggerNotificationType,
  priorSteps,
}: {
  f: ActionFieldSpec;
  config: Record<string, unknown>;
  setOne: (name: string, value: unknown) => void;
  triggerFamily?: string;
  triggerNotificationType?: string;
  priorSteps: PriorStep[];
}) {
  const endpointId = f.endpoint_field
    ? (config[f.endpoint_field] as string | undefined)
    : undefined;
  const endpoint = useQuery({
    queryKey: ["api-endpoint", endpointId],
    queryFn: () =>
      apiGet<ApiEndpointDetail>(
        `/api/verkada/catalog/endpoints/${endpointId}`,
      ),
    enabled: !!endpointId,
    staleTime: 5 * 60_000,
  });

  if (!endpointId) {
    return (
      <div className="text-xs text-slate-500 italic px-3 py-2 rounded border border-dashed border-white/10 bg-white/5">
        Pick an endpoint above to see its parameters.
      </div>
    );
  }
  if (endpoint.isLoading || !endpoint.data) {
    return (
      <div className="text-xs text-slate-500 px-3 py-2">Loading schema…</div>
    );
  }

  const raw = endpoint.data.raw as Record<string, unknown> | null;
  const params = (Array.isArray(raw?.parameters) ? raw!.parameters : []) as OAParameter[];
  const pathParams = params.filter((p) => p.in === "path");
  const queryParams = params.filter((p) => p.in === "query");
  const body = (raw?.requestBody as
    | {
        description?: string;
        required?: boolean;
        content?: Record<string, { schema?: OASchema; example?: unknown }>;
      }
    | undefined) ?? undefined;
  const bodySchema = body?.content?.["application/json"]?.schema;
  const bodyProps = bodySchema?.properties ?? {};
  const bodyRequired = new Set(bodySchema?.required ?? []);
  const method = endpoint.data.method.toUpperCase();
  const bodyAllowed = ["POST", "PUT", "PATCH"].includes(method);

  const pathValues = (config.path_params as Record<string, string>) ?? {};
  const queryValues = (config.query_params as Record<string, string>) ?? {};
  const bodyValues = (config.body as Record<string, unknown>) ?? {};

  const setNested = (
    bucket: "path_params" | "query_params" | "body",
    key: string,
    value: string,
  ) => {
    const current =
      bucket === "path_params"
        ? pathValues
        : bucket === "query_params"
          ? queryValues
          : bodyValues;
    const next = { ...current };
    if (value === "") delete next[key];
    else next[key] = value;
    setOne(bucket, Object.keys(next).length === 0 ? undefined : next);
  };

  const nothingToShow =
    pathParams.length === 0 &&
    queryParams.length === 0 &&
    !(bodyAllowed && Object.keys(bodyProps).length > 0);

  return (
    <div className="space-y-4">
      {pathParams.length > 0 && (
        <ParamGroup
          title="Path parameters"
          subtitle={`Filled into the URL: ${endpoint.data.path}`}
        >
          {pathParams.map((p) => (
            <ParamRow
              key={p.name}
              name={p.name}
              typeLabel={shortType(p.schema)}
              required={!!p.required}
              description={p.description ?? p.schema?.description}
              example={p.example ?? p.schema?.example}
              value={pathValues[p.name] ?? ""}
              onChange={(v) => setNested("path_params", p.name, v)}
              triggerFamily={triggerFamily}
              triggerNotificationType={triggerNotificationType}
              priorSteps={priorSteps}
            />
          ))}
        </ParamGroup>
      )}

      {queryParams.length > 0 && (
        <ParamGroup
          title="Query parameters"
          subtitle="Appended as ?key=value on the URL."
        >
          {queryParams.map((p) => (
            <ParamRow
              key={p.name}
              name={p.name}
              typeLabel={shortType(p.schema)}
              required={!!p.required}
              description={p.description ?? p.schema?.description}
              example={p.example ?? p.schema?.example}
              value={queryValues[p.name] ?? ""}
              onChange={(v) => setNested("query_params", p.name, v)}
              triggerFamily={triggerFamily}
              triggerNotificationType={triggerNotificationType}
              priorSteps={priorSteps}
            />
          ))}
        </ParamGroup>
      )}

      {bodyAllowed && Object.keys(bodyProps).length > 0 && (
        <ParamGroup
          title={`Request body${body?.required ? " (required)" : ""}`}
          subtitle={
            body?.description ??
            `Sent as JSON in the ${method} body. Unknown fields are dropped by Verkada.`
          }
        >
          {Object.entries(bodyProps).map(([k, sch]) => {
            const raw = bodyValues[k];
            const str =
              typeof raw === "string"
                ? raw
                : raw === undefined || raw === null
                  ? ""
                  : JSON.stringify(raw);
            return (
              <ParamRow
                key={k}
                name={k}
                typeLabel={shortType(sch)}
                required={bodyRequired.has(k)}
                description={sch.description}
                example={sch.example ?? sch.default}
                value={str}
                onChange={(v) => setNested("body", k, v)}
                triggerFamily={triggerFamily}
                triggerNotificationType={triggerNotificationType}
                priorSteps={priorSteps}
              />
            );
          })}
        </ParamGroup>
      )}

      {nothingToShow && (
        <div className="text-xs text-slate-500 italic px-3 py-2 rounded border border-dashed border-white/10 bg-white/5">
          This endpoint takes no parameters. Just save and run.
        </div>
      )}

      {endpoint.data.docs_url && (
        <a
          href={endpoint.data.docs_url}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-[11px] text-sky-400 hover:underline"
        >
          Full reference on apidocs.verkada.com ↗
        </a>
      )}
    </div>
  );
}


function ParamGroup({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-white/10 bg-white/5">
      <div className="px-3 py-2 border-b border-white/10">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
          {title}
        </div>
        {subtitle && (
          <div className="text-[11px] text-slate-500 mt-0.5">{subtitle}</div>
        )}
      </div>
      <div className="p-3 space-y-3">{children}</div>
    </div>
  );
}


function ParamRow({
  name,
  typeLabel,
  required,
  description,
  example,
  value,
  onChange,
  triggerFamily,
  triggerNotificationType,
  priorSteps,
}: {
  name: string;
  typeLabel: string;
  required: boolean;
  description?: string;
  example?: unknown;
  value: string;
  onChange: (v: string) => void;
  triggerFamily?: string;
  triggerNotificationType?: string;
  priorSteps: PriorStep[];
}) {
  const exampleStr =
    example === undefined || example === null
      ? null
      : typeof example === "string"
        ? example
        : JSON.stringify(example);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 flex-wrap">
        <code className="text-xs font-mono text-slate-100">{name}</code>
        {required && <span className="text-[10px] text-rose-300">required</span>}
        <span className="text-[10px] text-slate-500">{typeLabel}</span>
      </div>
      {description && (
        <div className="text-[11px] text-slate-400 whitespace-pre-wrap">
          {description}
        </div>
      )}
      <div className="flex gap-2 items-start">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            exampleStr
              ? `e.g. ${exampleStr}`
              : "literal value or {{ trigger.data.* }}"
          }
          className="flex-1 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
        />
        {triggerFamily && (
          <VariablePicker
            family={triggerFamily}
            notificationType={triggerNotificationType || undefined}
            priorSteps={priorSteps}
            onPick={(path) => onChange(value + `{{ ${path} }}`)}
          />
        )}
      </div>
    </div>
  );
}


function Field({
  label,
  help,
  required,
  docsUrl,
  children,
}: {
  label: string;
  help?: string;
  required?: boolean;
  docsUrl?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-slate-300 mb-1 flex items-center gap-2">
        <span>
          {label}
          {required && <span className="text-rose-400 ml-1">*</span>}
        </span>
        {docsUrl && (
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-sky-400 hover:underline"
          >
            docs ↗
          </a>
        )}
      </div>
      {children}
      {help && <div className="text-xs text-slate-500 mt-1">{help}</div>}
    </label>
  );
}


// Cost-tier chip: green $ → cheap, amber $$ → medium, rose $$$ →
// expensive. The tooltip points users at Stats for the actual per-1M
// rate so the chip stays uncluttered.
export function CostChip({ tier }: { tier: string }) {
  const cls =
    tier === "$"
      ? "bg-emerald-900/60 text-emerald-200"
      : tier === "$$"
        ? "bg-amber-900/60 text-amber-200"
        : "bg-rose-900/60 text-rose-200";
  return (
    <span
      className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${cls}`}
      title="Relative cost — see Stats → 'Current Gemini rates' for the per-1M-token numbers."
    >
      {tier}
    </span>
  );
}


export function BetaChip() {
  return (
    <span
      className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-900/60 text-violet-200"
      title="Preview / beta model. Behavior, pricing, and availability may change without notice."
    >
      BETA
    </span>
  );
}
