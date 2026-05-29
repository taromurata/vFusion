import { useQuery } from "@tanstack/react-query";

import { apiGet, Flow, Taxonomy, TriggerField } from "../lib/api";
import { useCameras } from "../lib/cameras";


export interface TriggerConfigState {
  family: string;
  notificationType: string;
  filters: Array<{ field: string; value: string }>;
}


export function triggerStateToConfig(s: TriggerConfigState): Flow["trigger_config"] {
  const trigger_config: Flow["trigger_config"] = { family: s.family };
  if (s.notificationType) trigger_config.notification_type = s.notificationType;
  const filterMap: Record<string, string> = {};
  for (const { field, value } of s.filters) {
    if (field && value) filterMap[field] = value;
  }
  if (Object.keys(filterMap).length > 0) trigger_config.filters = filterMap;
  return trigger_config;
}


export function triggerStateFromConfig(c: Flow["trigger_config"] | undefined): TriggerConfigState {
  return {
    family: c?.family ?? "camera",
    notificationType: c?.notification_type ?? "",
    filters: Object.entries(c?.filters ?? {}).map(([field, value]) => ({ field, value })),
  };
}


interface Props {
  value: TriggerConfigState;
  onChange: (next: TriggerConfigState) => void;
}


/** Schema-driven trigger config: family picker, notification_type picker
 *  (filtered by family), and a list of key=value filters using the family's
 *  known filter fields. */
export default function TriggerConfigForm({ value, onChange }: Props) {
  const taxonomy = useQuery({
    queryKey: ["verkada-taxonomy"],
    queryFn: () => apiGet<Taxonomy>("/api/taxonomy/verkada"),
  });
  const sample = useQuery({
    queryKey: ["trigger-fields", value.family, value.notificationType],
    queryFn: () => {
      const params = new URLSearchParams();
      if (value.family) params.set("family", value.family);
      if (value.notificationType)
        params.set("notification_type", value.notificationType);
      return apiGet<TriggerField[]>(
        `/api/triggers/sample-fields?${params.toString()}`
      );
    },
    enabled: !!value.family,
    staleTime: 60_000,
  });

  const familyEntry = taxonomy.data?.[value.family];
  const filterFieldOptions = buildFilterFieldOptions(
    sample.data ?? [],
    familyEntry?.filter_fields ?? []
  );

  const setFilter = (i: number, patch: Partial<{ field: string; value: string }>) => {
    const next = [...value.filters];
    next[i] = { ...next[i], ...patch };
    // When the user picks a *new* field from the dropdown, refresh the
    // value input with the new field's sample — but only when the value
    // is currently empty *or* still matches the previous field's sample
    // (i.e. it was auto-filled, not hand-typed). That way custom values
    // are preserved, but stale auto-fills don't get left behind when the
    // user is hopping between fields to find the right one.
    if (
      patch.field !== undefined &&
      patch.field !== value.filters[i]?.field
    ) {
      const prevField = value.filters[i]?.field;
      const prevOpt = prevField
        ? filterFieldOptions.find((o) => o.name === prevField)
        : undefined;
      const prevSample =
        prevOpt?.rawSample !== undefined
          ? rawToString(prevOpt.rawSample)
          : undefined;
      const wasAutoFilled =
        !next[i].value || (prevSample !== undefined && prevSample === next[i].value);
      if (wasAutoFilled) {
        const opt =
          patch.field === ""
            ? undefined
            : filterFieldOptions.find((o) => o.name === patch.field);
        next[i] = {
          ...next[i],
          value:
            opt?.rawSample !== undefined ? rawToString(opt.rawSample) : "",
        };
      }
    }
    onChange({ ...value, filters: next });
  };

  return (
    <div className="space-y-3">
      <Field label="Family" required>
        <select
          value={value.family}
          onChange={(e) =>
            onChange({ ...value, family: e.target.value, notificationType: "" })
          }
          className="w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-sm"
        >
          {taxonomy.data &&
            Object.entries(taxonomy.data).map(([key, t]) => (
              <option key={key} value={key}>
                {t.label}
              </option>
            ))}
        </select>
      </Field>

      {familyEntry?.notification_types && (
        <Field label="Notification type">
          <select
            value={value.notificationType}
            onChange={(e) => onChange({ ...value, notificationType: e.target.value })}
            className="w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-sm"
          >
            <option value="">(any in this family)</option>
            {familyEntry.notification_types.map((nt) => (
              <option key={nt} value={nt}>
                {nt}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field
        label="Filters"
        help="All filters must match. Case-insensitive equality."
      >
        <div className="space-y-3">
          {value.filters.map((f, i) => (
            <div
              key={i}
              className="border border-slate-800 rounded-md p-2 bg-slate-950/50 space-y-2"
            >
              <div className="flex items-center gap-2">
                <select
                  value={f.field}
                  onChange={(e) => setFilter(i, { field: e.target.value })}
                  className="flex-1 px-2 py-1 rounded bg-slate-950 border border-slate-700 text-sm"
                >
                  <option value="">— field —</option>
                  {filterFieldOptions.map((opt) => (
                    <option key={opt.name} value={opt.name}>
                      {opt.name}
                    </option>
                  ))}
                  {/* If the user already picked a field that no longer
                      appears (e.g. because the sample changed), keep it
                      selectable rather than silently dropping it. */}
                  {f.field &&
                    !filterFieldOptions.some((o) => o.name === f.field) && (
                      <option value={f.field}>{f.field}</option>
                    )}
                </select>
                <button
                  onClick={() =>
                    onChange({
                      ...value,
                      filters: value.filters.filter((_, j) => j !== i),
                    })
                  }
                  className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-rose-300 shrink-0"
                  title="Remove filter"
                >
                  ×
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-500 text-xs font-mono shrink-0">
                  ==
                </span>
                {f.field === "camera_id" ? (
                  <CameraFilterValue
                    value={f.value}
                    onChange={(v) => setFilter(i, { value: v })}
                  />
                ) : (
                  <input
                    value={f.value}
                    onChange={(e) => setFilter(i, { value: e.target.value })}
                    className="flex-1 px-2 py-1 rounded bg-slate-950 border border-slate-700 text-sm font-mono"
                    placeholder="value to match"
                    spellCheck={false}
                  />
                )}
              </div>
            </div>
          ))}
          <button
            onClick={() =>
              onChange({
                ...value,
                filters: [...value.filters, { field: "", value: "" }],
              })
            }
            className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-400 hover:border-sky-600"
          >
            + Add filter
          </button>
        </div>
      </Field>
    </div>
  );
}


/** Value input for a ``camera_id`` filter — a dropdown of synced
 *  cameras (online by default) so the operator doesn't have to paste
 *  a UUID. Falls back to a free-text box for pasting an id that isn't
 *  in the synced list (offline, different org cache, etc.). Mirrors
 *  the camera picker in the step config form. */
function CameraFilterValue({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const cameras = useCameras();
  const list = cameras.data ?? [];
  const isOnline = (s: string | null | undefined) =>
    !!s && s.toLowerCase() !== "offline";
  const online = list.filter((c) => isOnline(c.status));
  const offlineCount = list.length - online.length;
  const sorted = [...online].sort((a, b) =>
    (a.name ?? "").localeCompare(b.name ?? ""),
  );
  // If the saved value is an offline / unknown camera, keep it
  // selectable so it isn't silently dropped.
  const known = list.find((c) => c.camera_id === value);
  return (
    <div className="flex-1 space-y-1">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-sm"
      >
        <option value="">— pick a camera —</option>
        {sorted.map((c) => (
          <option key={c.camera_id} value={c.camera_id}>
            {c.name ?? "(unnamed)"}
            {c.site ? ` — ${c.site}` : ""}
          </option>
        ))}
        {value && !online.some((c) => c.camera_id === value) && (
          <option value={value}>
            {known?.name ? `${known.name} (offline)` : value}
          </option>
        )}
      </select>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-800 text-xs font-mono"
        placeholder="or paste a camera_id UUID"
        spellCheck={false}
      />
      {list.length > 0 && (
        <div className="text-[10px] text-slate-500">
          {online.length} online
          {offlineCount > 0 ? ` · ${offlineCount} offline hidden` : ""}
        </div>
      )}
    </div>
  );
}


/** Build the filter-field dropdown options from a real sampled webhook.
 *
 *  Only scalar ``trigger.data.*`` fields with a non-null value are useful
 *  for filtering — a field that's always null in this notification type
 *  can't usefully gate a flow. The family's taxonomy ``filter_fields``
 *  list is used only as an ordering hint so common fields surface first;
 *  if the sample is missing entirely (no captures yet), we fall back to
 *  the taxonomy list so the picker isn't empty. */
interface FilterFieldOption {
  name: string;
  /** Display string shown in the dropdown — short and quoted. */
  sample?: string;
  /** Raw value from the sampled webhook — used to prefill the value input. */
  rawSample?: unknown;
}


// Fields that *exist* on most Verkada webhook payloads but can't usefully
// gate a flow — unique per event, opaque URLs with signed tokens, etc.
// They'd just clutter the filter dropdown.
const EXCLUDED_FILTER_FIELDS = new Set([
  "event_id",
  "image_url",
  "video_url",
]);


function buildFilterFieldOptions(
  sample: TriggerField[],
  preferred: string[],
): FilterFieldOption[] {
  // For array paths, the endpoint returns BOTH "trigger.data.foo" (type
  // "array") AND "trigger.data.foo.0" (the first element). We surface
  // the array path itself as a filterable field with array-contains
  // semantics on the backend, and use the first element as the prefill
  // value so picking "objects" autofills "animal".
  const firstElems = new Map<string, unknown>();
  for (const f of sample) {
    if (!f.path.endsWith(".0")) continue;
    if (f.sample === null || f.sample === undefined) continue;
    if (typeof f.sample === "object") continue;
    firstElems.set(f.path.slice(0, -2), f.sample);
  }

  const found = new Map<string, unknown>();
  for (const f of sample) {
    if (!f.path.startsWith("trigger.data.")) continue;
    const tail = f.path.slice("trigger.data.".length);
    if (!tail) continue;
    // Drop the synthetic ".0" entries — the parent array represents them.
    if (tail.endsWith(".0")) continue;
    if (EXCLUDED_FILTER_FIELDS.has(tail)) continue;
    if (f.type === "array") {
      const elem = firstElems.get(f.path);
      if (elem === undefined || elem === null || elem === "") continue;
      found.set(tail, elem);
      continue;
    }
    if (f.sample === null || f.sample === undefined || f.sample === "") continue;
    if (f.type === "dict" || typeof f.sample === "object") continue;
    found.set(tail, f.sample);
  }
  if (found.size === 0) {
    return preferred.map((name) => ({ name }));
  }
  const preferredSet = new Set(preferred);
  const orderedPreferred = preferred.filter((p) => found.has(p));
  // Surface top-level fields before nested ones so the most common
  // filter targets stay at the top of a potentially long list.
  const extras = [...found.keys()]
    .filter((n) => !preferredSet.has(n))
    .sort((a, b) => {
      const ad = a.split(".").length;
      const bd = b.split(".").length;
      if (ad !== bd) return ad - bd;
      return a.localeCompare(b);
    });
  return [...orderedPreferred, ...extras].map((name) => {
    const rawSample = found.get(name);
    return {
      name,
      rawSample,
      sample: formatSample(rawSample),
    };
  });
}


function formatSample(v: unknown): string {
  if (typeof v === "string") {
    return v.length > 32 ? `"${v.slice(0, 30)}…"` : `"${v}"`;
  }
  return String(v);
}


function rawToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
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
