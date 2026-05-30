import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  Connection,
  ConnectionTypeSpec,
} from "../lib/api";
import { useBrand } from "../lib/brand";
import { copyToClipboard } from "../lib/clipboard";
import { PENDING_SIGNING_SECRET_KEY } from "../components/OnboardingGate";

type FormMode =
  | { kind: "create"; type: string }
  | { kind: "finish"; connection: Connection }
  | { kind: "edit"; connection: Connection };

export default function Connections() {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormMode | null>(null);

  const types = useQuery({
    queryKey: ["connection-types"],
    queryFn: () => apiGet<Record<string, ConnectionTypeSpec>>("/api/connections/types"),
  });
  const conns = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
    refetchInterval: 5000,
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/connections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] }),
  });

  // Auto-open finish-setup when a pending connection first appears.
  const pending = (conns.data ?? []).filter((c) => !c.setup_complete);
  useEffect(() => {
    if (!form && pending.length > 0) {
      setForm({ kind: "finish", connection: pending[0] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length]);

  const verkadaConns = (conns.data ?? []).filter((c) => c.type === "verkada");
  const thirdPartyConns = (conns.data ?? []).filter((c) => c.type !== "verkada");
  const verkadaTypeKey = "verkada";
  const thirdPartyTypeKeys = Object.keys(types.data ?? {}).filter(
    (k) => k !== "verkada",
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Connections</h1>
        <p className="text-slate-300 text-sm mt-1">
          Store API keys and webhook signing secrets. Secrets are encrypted at rest with
          your <code className="bg-white/10 px-1 rounded">FERNET_KEY</code> and never
          returned through the API after creation.
        </p>
      </div>

      {/* ---- Verkada orgs ---- */}
      <section className="space-y-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-xs uppercase tracking-wider text-slate-400">
            Verkada orgs
          </h2>
          {types.data?.[verkadaTypeKey] && (
            <button
              onClick={() => setForm({ kind: "create", type: verkadaTypeKey })}
              className="text-xs px-2 py-1 rounded border border-white/15 hover:border-sky-500 hover:bg-white/5 text-slate-200"
            >
              + Add Verkada org
            </button>
          )}
        </div>

        <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg overflow-hidden">
          {conns.isLoading ? (
            <div className="p-6 text-sm text-slate-400">Loading…</div>
          ) : verkadaConns.length === 0 ? (
            <FirstRunState />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-slate-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">External ID</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Cameras</th>
                  <th className="text-left px-3 py-2">Doors</th>
                  <th className="text-left px-3 py-2">Helix events</th>
                  <th className="text-left px-3 py-2">Scenarios</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {verkadaConns.map((c) => (
                  <VerkadaRow
                    key={c.id}
                    c={c}
                    onFinish={() => setForm({ kind: "finish", connection: c })}
                    onEdit={() => setForm({ kind: "edit", connection: c })}
                    onDelete={() => {
                      if (confirm(`Delete "${c.name}"? This can't be undone.`)) {
                        del.mutate(c.id);
                      }
                    }}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* ---- 3rd-party API keys ---- */}
      <section className="space-y-3">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-xs uppercase tracking-wider text-slate-400">
            3rd-party API keys
          </h2>
          {types.data &&
            thirdPartyTypeKeys.map((k) => (
              <button
                key={k}
                onClick={() => setForm({ kind: "create", type: k })}
                className="text-xs px-2 py-1 rounded border border-white/15 hover:border-sky-500 hover:bg-white/5 text-slate-200"
              >
                + Add {types.data![k].label}
              </button>
            ))}
        </div>

        <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg overflow-hidden">
          {thirdPartyConns.length === 0 ? (
            <div className="p-6 text-sm text-slate-400">
              No 3rd-party API keys yet. Add a Gemini key to enable AI analysis actions.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-slate-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Type</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {thirdPartyConns.map((c) => (
                  <tr key={c.id} className={!c.setup_complete ? "bg-amber-950/30" : ""}>
                    <td className="px-3 py-2 font-medium text-slate-100">{c.name}</td>
                    <td className="px-3 py-2">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-900/60 text-sky-200">
                        {c.type}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge ready={c.setup_complete} />
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {!c.setup_complete && (
                        <button
                          onClick={() => setForm({ kind: "finish", connection: c })}
                          className="text-xs px-2 py-1 rounded bg-sky-700 hover:bg-sky-600 text-white mr-2"
                        >
                          Finish setup
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (confirm(`Delete "${c.name}"? This can't be undone.`)) {
                            del.mutate(c.id);
                          }
                        }}
                        className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:text-rose-300 hover:border-rose-700"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {form && types.data && (
        <ConnectionFormModal
          mode={form}
          spec={
            form.kind === "create"
              ? types.data[form.type]
              : types.data[form.connection.type]
          }
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            qc.invalidateQueries({ queryKey: ["connections"] });
          }}
        />
      )}
    </div>
  );
}


function VerkadaRow({
  c,
  onFinish,
  onEdit,
  onDelete,
}: {
  c: Connection;
  onFinish: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  // Per-row status line so a failed sync surfaces inline instead of
  // looking like a no-op (the buttons would otherwise just flip back to
  // their idle label). Cleared on the next sync click.
  const [syncStatus, setSyncStatus] = useState<{
    kind: "ok" | "err";
    msg: string;
  } | null>(null);
  const startSync = () => setSyncStatus(null);
  const okMsg = (label: string, count: number) => `${label}: ${count} synced`;
  // Strip the api-wrapper's `METHOD /path → STATUS:` prefix so the
  // surfaced message is the actual server-side reason.
  const cleanErr = (e: Error): string => {
    const m = e.message.match(/→\s*\d+\s*:\s*(.+)$/);
    return m ? m[1] : e.message;
  };
  const errMsg = (label: string, e: Error) => `${label} failed: ${cleanErr(e)}`;

  const syncCameras = useMutation({
    mutationFn: () => apiPost<{ count: number }>(`/api/connections/${c.id}/sync-cameras`, {}),
    onMutate: startSync,
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      qc.invalidateQueries({ queryKey: ["verkada-cameras"] });
      setSyncStatus({ kind: "ok", msg: okMsg("Cameras", d.count) });
    },
    onError: (e: Error) =>
      setSyncStatus({ kind: "err", msg: errMsg("Cameras", e) }),
  });
  // Reminder appended to every sync-doors result (success or failure)
  // because the per-door "Door Management via API" toggle is a separate
  // gotcha from listing the doors — the operator hits the first issue
  // they encounter and forgets the second otherwise.
  const DOOR_API_REMINDER =
    ' Heads-up: each door also needs "Door Management via API" enabled ' +
    "in its Verkada Command door settings to be unlockable via API.";

  const syncDoors = useMutation({
    mutationFn: () => apiPost<{ count: number }>(`/api/connections/${c.id}/sync-doors`, {}),
    onMutate: startSync,
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      qc.invalidateQueries({ queryKey: ["verkada-doors"] });
      setSyncStatus({
        kind: "ok",
        msg: `${okMsg("Doors", d.count)}.${DOOR_API_REMINDER}`,
      });
    },
    onError: (e: Error) =>
      setSyncStatus({
        kind: "err",
        msg: `${errMsg("Doors", e)}${DOOR_API_REMINDER}`,
      }),
  });
  const syncHelix = useMutation({
    mutationFn: () => apiPost<{ count: number }>(`/api/connections/${c.id}/sync-helix`, {}),
    onMutate: startSync,
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      qc.invalidateQueries({ queryKey: ["helix-event-types"] });
      setSyncStatus({ kind: "ok", msg: okMsg("Helix events", d.count) });
    },
    onError: (e: Error) =>
      setSyncStatus({ kind: "err", msg: errMsg("Helix events", e) }),
  });
  const syncScenarios = useMutation({
    mutationFn: () =>
      apiPost<{ count: number }>(`/api/connections/${c.id}/sync-scenarios`, {}),
    onMutate: startSync,
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["connections"] });
      qc.invalidateQueries({ queryKey: ["verkada-scenarios"] });
      setSyncStatus({ kind: "ok", msg: okMsg("Scenarios", d.count) });
    },
    onError: (e: Error) =>
      setSyncStatus({ kind: "err", msg: errMsg("Scenarios", e) }),
  });

  // Streaming-permission probe — fires a real live frame + historical
  // clip pull against the first synced camera and reports which Verkada
  // streaming permission tier the API key has.
  const [streamingResult, setStreamingResult] = useState<{
    camera_id: string;
    camera_name: string | null;
    live: { ok: boolean; error?: string };
    historical: { ok: boolean; error?: string };
    tier: string;
  } | null>(null);
  const testStreaming = useMutation({
    mutationFn: () =>
      apiPost<NonNullable<typeof streamingResult>>(
        `/api/connections/${c.id}/test-streaming`,
        {},
      ),
    onMutate: () => {
      setSyncStatus(null);
      setStreamingResult(null);
    },
    onSuccess: (d) => setStreamingResult(d),
    onError: (e: Error) =>
      setSyncStatus({ kind: "err", msg: errMsg("Test streaming", e) }),
  });
  return (
    <tr className={!c.setup_complete ? "bg-amber-950/30" : ""}>
      <td className="px-3 py-2 font-medium text-slate-100">{c.name}</td>
      <td className="px-3 py-2 font-mono text-xs text-slate-400">
        {c.external_id ?? "—"}
      </td>
      <td className="px-3 py-2">
        <StatusBadge ready={c.setup_complete} />
      </td>
      <CountCell n={c.camera_count} ts={c.cameras_last_synced_at} />
      <CountCell n={c.door_count} ts={c.doors_last_synced_at} />
      <CountCell n={c.helix_event_count} ts={c.helix_events_last_synced_at} />
      <CountCell n={c.scenario_count} ts={c.scenarios_last_synced_at} />
      <td className="px-3 py-2 align-top">
        <div className="text-right whitespace-nowrap space-x-2">
          {c.setup_complete && (
            <>
              <SyncBtn
                label="Sync cameras"
                pending={syncCameras.isPending}
                onClick={() => syncCameras.mutate()}
                title="Pull camera names from Verkada API"
              />
              <SyncBtn
                label="Sync doors"
                pending={syncDoors.isPending}
                onClick={() => syncDoors.mutate()}
                title="Pull door names from /access/v1/doors"
              />
              <SyncBtn
                label="Sync helix"
                pending={syncHelix.isPending}
                onClick={() => syncHelix.mutate()}
                title="Pull Helix event types from /cameras/v1/video_tagging/event_type"
              />
              <SyncBtn
                label="Sync scenarios"
                pending={syncScenarios.isPending}
                onClick={() => syncScenarios.mutate()}
                title="Pull Access scenarios from /access/v1/scenarios"
              />
              <SyncBtn
                label="Test streaming"
                pending={testStreaming.isPending}
                onClick={() => testStreaming.mutate()}
                title="Probe Streaming - Live and Streaming - Live/Historical permissions via a real HLS pull"
              />
            </>
          )}
          {!c.setup_complete && (
            <button
              onClick={onFinish}
              className="text-xs px-2 py-1 rounded bg-sky-700 hover:bg-sky-600 text-white"
            >
              Finish setup
            </button>
          )}
          <button
            onClick={onEdit}
            className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:text-white hover:border-white/30"
            title="Edit name, API key, or signing secret"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:text-rose-300 hover:border-rose-700"
          >
            Delete
          </button>
        </div>
        {syncStatus && (
          <div
            className={`text-[11px] mt-1.5 text-left break-words ${
              syncStatus.kind === "err"
                ? "text-rose-300"
                : "text-emerald-300"
            }`}
            title={syncStatus.msg}
          >
            {syncStatus.kind === "err" ? "✗ " : "✓ "}
            {syncStatus.msg}
          </div>
        )}
        {streamingResult && (
          <div className="text-[11px] mt-1.5 text-left break-words space-y-0.5">
            <div
              className={
                streamingResult.tier === "None"
                  ? "text-rose-300"
                  : "text-emerald-300"
              }
            >
              {streamingResult.tier === "None" ? "✗" : "✓"}{" "}
              {streamingResult.tier}
              {streamingResult.camera_name && (
                <span className="text-slate-500">
                  {" "}· tested via {streamingResult.camera_name}
                </span>
              )}
            </div>
            {!streamingResult.live.ok && streamingResult.live.error && (
              <div className="text-rose-300/90">
                Live: {streamingResult.live.error}
              </div>
            )}
            {!streamingResult.historical.ok &&
              streamingResult.historical.error && (
                <div className="text-rose-300/90">
                  Historical: {streamingResult.historical.error}
                </div>
              )}
          </div>
        )}
      </td>
    </tr>
  );
}


function SyncBtn({
  label,
  pending,
  onClick,
  title,
}: {
  label: string;
  pending: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title={title}
      className="text-xs px-2 py-1 rounded border border-white/15 hover:border-sky-500 hover:bg-white/5 disabled:opacity-50"
    >
      {pending ? "Syncing…" : label}
    </button>
  );
}


function CountCell({ n, ts }: { n: number; ts: string | null }) {
  return (
    <td className="px-3 py-2 text-slate-400 text-xs">
      {n > 0 ? <span className="text-slate-100">{n}</span> : <span className="text-slate-500">—</span>}
      {ts && <div className="text-[10px] text-slate-500 mt-0.5">{new Date(ts).toLocaleString()}</div>}
    </td>
  );
}


function StatusBadge({ ready }: { ready: boolean }) {
  return ready ? (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-200">
      ready
    </span>
  ) : (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-200">
      needs api key
    </span>
  );
}


function FirstRunState() {
  const brand = useBrand();
  return (
    <div className="p-6 text-sm text-slate-300 space-y-2">
      <p className="font-medium text-slate-100">No Verkada orgs connected yet.</p>
      <p>
        Point a Verkada webhook at this server (
        <code className="bg-white/10 px-1 rounded text-xs">/hooks/&lt;anything&gt;</code>
        ) and {brand} will auto-detect your org and prompt you to finish setup
        with just an API key.
      </p>
      <p>
        Or click <strong className="text-slate-100">+ Add Verkada org</strong> above to
        enter everything manually.
      </p>
    </div>
  );
}


function ConnectionFormModal({
  mode,
  spec,
  onClose,
  onSaved,
}: {
  mode: FormMode;
  spec: ConnectionTypeSpec;
  onClose: () => void;
  onSaved: () => void;
}) {
  const brand = useBrand();
  // "finish" = auto-detected stub from an inbound webhook, user fills
  //   in API key / signing secret.
  // "edit"   = existing complete connection, user updates fields.
  // Both PUT to the same endpoint and treat blank secret fields as
  // "keep existing" so users can re-open without re-entering keys.
  const isExisting = mode.kind === "finish" || mode.kind === "edit";
  const isFinish = mode.kind === "finish";
  const isEdit = mode.kind === "edit";
  const conn = isExisting ? mode.connection : null;

  const [name, setName] = useState(conn?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    if (conn?.external_id && spec.external_id_field) {
      initial[spec.external_id_field] = conn.external_id;
    }
    // If the user generated a signing secret during onboarding, the
    // OnboardingGate stashed it here. Prefill so they don't have to
    // re-generate / re-paste — the value they pasted into Verkada
    // Command's Shared secret is the same one we'll store. Only seed
    // when we're finishing an auto-detected connection (the canonical
    // post-onboarding moment); ignore for create / edit flows where
    // the user is being intentional about field contents.
    if (isFinish && spec.fields.some((f) => f.name === "webhook_signing_secret")) {
      const stored = window.localStorage.getItem(PENDING_SIGNING_SECRET_KEY);
      if (stored) initial.webhook_signing_secret = stored;
    }
    return initial;
  });
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      if (isExisting && conn) {
        const secret: Record<string, string> = {};
        for (const [k, v] of Object.entries(values)) {
          if (v) secret[k] = v;
        }
        return apiPut<Connection>(`/api/connections/${conn.id}`, {
          name,
          secret,
        });
      }
      return apiPost<Connection>("/api/connections", {
        type: mode.kind === "create" ? mode.type : "verkada",
        name,
        secret: values,
      });
    },
    onSuccess: () => {
      // Whichever path saved a signing secret, the onboarding stash
      // has served its purpose. Clear it so a future fresh-install
      // user doesn't inherit it.
      window.localStorage.removeItem(PENDING_SIGNING_SECRET_KEY);
      onSaved();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const title = isFinish
    ? `Finish setting up ${spec.label}`
    : isEdit
      ? `Edit ${spec.label}`
      : `Add ${spec.label}`;
  const description = isFinish
    ? `${brand} detected a new Verkada org from an incoming webhook. Add your API key to enable flow actions. Everything else is optional.`
    : isEdit
      ? "Update any field below. Secret fields left blank keep their existing value — only fill them if you're rotating the API key or signing secret."
      : spec.description;

  // In finish mode the external_id is locked (auto-filled from the
  // webhook). In edit mode it's also locked — you can't repoint an
  // existing connection at a different org without recreating. In
  // create mode the user types it.
  const visibleFields = spec.fields.filter(
    (f) => !isExisting || f.name !== spec.external_id_field,
  );

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
      <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-lg w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div>
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <p className="text-sm text-slate-300 mt-1">{description}</p>
        </div>

        {isExisting && conn?.external_id && (
          <Field label="Verkada Org ID" help={isFinish ? "Detected from your incoming webhook." : "Org ID can't be changed once a connection exists — delete and recreate to repoint."}>
            <input
              value={conn.external_id}
              readOnly
              className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/10 text-slate-400 text-sm font-mono cursor-not-allowed"
            />
          </Field>
        )}

        <Field
          label="Friendly name"
          help="How this connection shows up in the UI."
          required
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 focus:outline-none focus:border-sky-500 text-sm"
            placeholder="e.g. Home org"
          />
        </Field>

        {visibleFields.map((f) => (
          <Field key={f.name} label={f.label} help={f.help} required={f.required}>
            <SecretInput
              spec={f}
              value={values[f.name] ?? ""}
              onChange={(next) =>
                setValues((v) => ({ ...v, [f.name]: next }))
              }
              isFinish={isExisting}
            />
          </Field>
        ))}

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
            {isFinish ? "Later" : "Cancel"}
          </button>
          <button
            onClick={() => {
              setErr(null);
              if (!name.trim()) {
                setErr("Friendly name is required.");
                return;
              }
              // Don't enforce required_for_setup at the form level —
              // the backend leaves setup_complete=false when the key
              // is missing, which keeps the pending-setup banner up
              // as a reminder. Users can save partial state (e.g. the
              // signing secret first, API key later).
              save.mutate();
            }}
            disabled={save.isPending}
            className="px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-sm disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : isEdit ? "Save changes" : isFinish ? "Save" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}


/**
 * Renders any connection field (text / secret) plus, when the spec
 * carries ``generate: true``, an inline pair of buttons:
 *
 *   - **Generate** — fills the field with 48 random bytes encoded as
 *     URL-safe base64 (~64 chars). Cryptographically secure via
 *     ``crypto.getRandomValues``.
 *   - **Copy** — shows up only once the field has a value, since the
 *     whole point is to paste the same string into Verkada Command.
 *
 * The field briefly switches from password mask to plain text right
 * after generation so the user can see what they're about to copy. It
 * masks again as soon as they click away.
 */
function SecretInput({
  spec,
  value,
  onChange,
  isFinish,
}: {
  spec: { name: string; type: "text" | "secret"; generate?: boolean };
  value: string;
  onChange: (next: string) => void;
  isFinish: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const generate = () => {
    const bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    // URL-safe base64 without padding: matches token_urlsafe-style.
    let b64 = btoa(String.fromCharCode(...bytes));
    b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    onChange(b64);
    setRevealed(true);
  };

  const copy = async () => {
    await copyToClipboard(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const isSecret = spec.type === "secret";
  const inputType = isSecret && !revealed ? "password" : "text";

  return (
    <div className="flex items-center gap-2">
      <input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setRevealed(false)}
        className="flex-1 px-2 py-1.5 rounded bg-white/5 border border-white/15 focus:outline-none focus:border-sky-500 text-sm font-mono"
        autoComplete={isSecret ? "new-password" : "off"}
        // Tell password managers not to treat this as a login form —
        // the secret field flips between password / text on reveal, and
        // 1Password / LastPass otherwise interpret a subsequent button
        // click (e.g. "Sync cameras") as a credential save event and
        // pop their "Save login?" prompt.
        data-1p-ignore="true"
        data-lpignore="true"
        data-form-type="other"
        placeholder={isFinish && isSecret ? "leave blank to keep existing" : undefined}
      />
      {spec.generate && (
        <>
          <button
            type="button"
            onClick={generate}
            className="shrink-0 text-xs px-2 py-1.5 rounded border border-white/15 text-slate-200 hover:bg-white/10"
            title="Generate a new random secret"
          >
            Generate
          </button>
          {value && (
            <button
              type="button"
              onClick={copy}
              className="shrink-0 text-xs px-2 py-1.5 rounded border border-white/15 text-slate-200 hover:bg-white/10"
              title="Copy to clipboard so you can paste into Verkada Command"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </>
      )}
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
      {help && (
        <div className="text-xs text-slate-500 mt-1">{renderHelpWithLinks(help)}</div>
      )}
    </label>
  );
}


// Auto-linkify ``https://...`` URLs in field help text so the
// OpenWeatherMap / Gemini AI Studio sign-up links the connection
// specs reference are clickable. Anything that isn't a URL renders as
// plain text — kept inside the same parent so styling cascades cleanly.
const URL_RE = /(https?:\/\/[^\s]+)/g;

function renderHelpWithLinks(text: string): React.ReactNode {
  const parts = text.split(URL_RE);
  return parts.map((part, i) => {
    if (URL_RE.test(part)) {
      // .test() leaves lastIndex on the regex; reset so subsequent
      // .test() / .split() calls behave predictably.
      URL_RE.lastIndex = 0;
      // Drop a trailing punctuation char (period, comma, paren, etc.)
      // that the URL_RE greedy match likely swallowed.
      const trailing = part.match(/[.,;:!?)\]]+$/);
      const url = trailing ? part.slice(0, part.length - trailing[0].length) : part;
      const tail = trailing ? trailing[0] : "";
      return (
        <span key={i}>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-sky-400 hover:underline"
          >
            {url}
          </a>
          {tail}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}
