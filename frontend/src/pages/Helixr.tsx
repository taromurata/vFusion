import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiGet,
  apiPost,
  apiPut,
  Connection,
  HelixEventType,
} from "../lib/api";


/**
 * Helixr — Helix event type CRUD.
 *
 * Lists every Helix event type for a chosen Verkada connection (the same
 * rows the Sync helix button populates), and lets the user create new
 * types or edit existing ones (name + attribute schema). Mutations call
 * Verkada's API directly; on success the backend re-syncs and the new /
 * updated row appears in the list.
 *
 * Scope is deliberately narrow: types only, not event instances. Posting
 * actual events still happens via flows (the verkada_helix_event action).
 */

type AttrType = "string" | "integer" | "float";


export default function Helixr() {
  const conns = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
  });
  const verkadaConns = useMemo(
    () =>
      (conns.data ?? []).filter(
        (c) => c.type === "verkada" && c.setup_complete,
      ),
    [conns.data],
  );
  const [connId, setConnId] = useState<string>("");
  // Default to first connection once they load.
  if (!connId && verkadaConns.length > 0 && verkadaConns[0]) {
    setConnId(verkadaConns[0].id);
  }
  const [editing, setEditing] = useState<HelixEventType | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-6">
      {verkadaConns.length === 0 ? (
        <Card>
          <div className="text-sm text-amber-200">
            You need at least one ready Verkada org in{" "}
            <a href="/connections" className="text-sky-300 hover:underline">
              Connections
            </a>{" "}
            to manage Helix event types.
          </div>
        </Card>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-slate-300">Verkada org</span>
              <select
                value={connId}
                onChange={(e) => setConnId(e.target.value)}
                className="px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
              >
                {verkadaConns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() => setCreating(true)}
              disabled={!connId}
              className="text-sm px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
            >
              + Create event type
            </button>
          </div>

          {connId && (
            <EventTypeList
              connId={connId}
              onEdit={(et) => setEditing(et)}
            />
          )}

          {creating && (
            <EventTypeEditor
              connId={connId}
              mode="create"
              onClose={() => setCreating(false)}
            />
          )}
          {editing && (
            <EventTypeEditor
              connId={connId}
              mode="edit"
              existing={editing}
              onClose={() => setEditing(null)}
            />
          )}
        </>
      )}
    </div>
  );
}


function EventTypeList({
  connId,
  onEdit,
}: {
  connId: string;
  onEdit: (et: HelixEventType) => void;
}) {
  const types = useQuery({
    queryKey: ["helix-event-types", connId],
    queryFn: () =>
      apiGet<HelixEventType[]>(`/api/connections/${connId}/helix-event-types`),
    enabled: !!connId,
  });
  const qc = useQueryClient();
  const sync = useMutation({
    mutationFn: () =>
      apiPost(`/api/connections/${connId}/sync-helix`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["helix-event-types", connId] }),
  });
  const list = types.data ?? [];
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs uppercase tracking-wider text-slate-400">
          Event types ({list.length})
        </div>
        <button
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:text-white hover:border-white/30 disabled:opacity-40"
        >
          {sync.isPending ? "Syncing…" : "↻ Re-sync from Verkada"}
        </button>
      </div>
      {types.isLoading && (
        <div className="text-sm text-slate-500">Loading…</div>
      )}
      {!types.isLoading && list.length === 0 && (
        <div className="text-sm text-slate-500 italic px-3 py-6 text-center border border-dashed border-white/10 rounded">
          No event types yet. Click <strong className="text-slate-200">+ Create event type</strong> above to make one.
        </div>
      )}
      <ul className="divide-y divide-white/10">
        {list.map((et) => {
          const schema = (et.event_schema ?? {}) as Record<string, string>;
          const attrs = Object.entries(schema);
          return (
            <li
              key={et.id}
              onClick={() => onEdit(et)}
              className="py-3 cursor-pointer hover:bg-white/5 px-2 -mx-2 rounded transition-colors"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-medium text-slate-100">
                  {et.name ?? "(unnamed)"}
                </div>
                <code className="text-[10px] font-mono text-slate-500">
                  {et.event_type_uid}
                </code>
              </div>
              {attrs.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {attrs.map(([k, t]) => (
                    <span
                      key={k}
                      className="text-[11px] font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5"
                    >
                      <span className="text-slate-200">{k}</span>
                      <span className="text-slate-500">: {t}</span>
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}


interface AttrRow {
  key: string;
  type: AttrType;
}


function EventTypeEditor({
  connId,
  mode,
  existing,
  onClose,
}: {
  connId: string;
  mode: "create" | "edit";
  existing?: HelixEventType;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState<string>(existing?.name ?? "");
  const [attrs, setAttrs] = useState<AttrRow[]>(() => {
    if (existing?.event_schema) {
      return Object.entries(existing.event_schema).map(([k, t]) => ({
        key: k,
        type: normalizeType(String(t)),
      }));
    }
    return [{ key: "", type: "string" }];
  });
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error("Name is required");
      const event_schema: Record<string, string> = {};
      for (const a of attrs) {
        const k = a.key.trim();
        if (!k) continue;
        if (event_schema[k]) throw new Error(`duplicate attribute name: ${k}`);
        event_schema[k] = a.type;
      }
      if (Object.keys(event_schema).length === 0) {
        throw new Error("Add at least one attribute");
      }
      if (mode === "create") {
        return apiPost<HelixEventType>(
          `/api/connections/${connId}/helix-event-types`,
          { name: trimmedName, event_schema },
        );
      }
      return apiPut<HelixEventType>(
        `/api/connections/${connId}/helix-event-types/${existing!.event_type_uid}`,
        { name: trimmedName, event_schema },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["helix-event-types", connId] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const setAttr = (i: number, patch: Partial<AttrRow>) => {
    setAttrs((cur) => cur.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  };
  const removeAttr = (i: number) => {
    setAttrs((cur) => cur.filter((_, idx) => idx !== i));
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-white/15 rounded-xl w-full max-w-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">
            {mode === "create" ? "Create event type" : "Edit event type"}
          </h2>
          <button
            onClick={onClose}
            className="text-sm px-2 py-1 rounded text-slate-400 hover:text-slate-200"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          <label className="block">
            <div className="text-xs font-medium text-slate-300 mb-1">
              Name <span className="text-rose-400">*</span>
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Forklift movement detected"
              className="w-full px-3 py-1.5 rounded bg-white/5 border border-white/15 text-sm focus:outline-none focus:border-sky-600"
            />
          </label>

          <div>
            <div className="text-xs font-medium text-slate-300 mb-2">
              Attributes <span className="text-rose-400">*</span>
            </div>
            <div className="text-[11px] text-slate-500 mb-3">
              Each attribute becomes a typed field on events posted against this
              type. Pick a name and the data type. For example, an event for
              "person detected" might have <code className="font-mono">person_name</code> (string) and
              <code className="font-mono"> confidence</code> (float).
            </div>
            <div className="space-y-2">
              {attrs.map((a, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    value={a.key}
                    onChange={(e) => setAttr(i, { key: e.target.value })}
                    placeholder="attribute_name"
                    className="flex-1 px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm font-mono"
                  />
                  <select
                    value={a.type}
                    onChange={(e) => setAttr(i, { type: e.target.value as AttrType })}
                    className="px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                  >
                    <option value="string">string</option>
                    <option value="integer">integer</option>
                    <option value="float">float</option>
                  </select>
                  <button
                    onClick={() => removeAttr(i)}
                    disabled={attrs.length === 1}
                    className="text-xs px-2 py-1 rounded border border-white/15 text-slate-400 hover:text-rose-300 hover:border-rose-800 disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                onClick={() => setAttrs((cur) => [...cur, { key: "", type: "string" }])}
                className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:text-white hover:border-white/30"
              >
                + Add attribute
              </button>
            </div>
          </div>

          {mode === "edit" && (
            <div className="text-[11px] text-amber-300/90 bg-amber-950/30 border border-amber-900/50 rounded px-3 py-2">
              ⚠ Changing the schema of a type that already has events posted
              against it can break downstream tools that read those events.
              Adding new fields is safe; renaming or removing fields is not.
            </div>
          )}

          {err && (
            <div className="text-sm text-rose-300 bg-rose-950/40 border border-rose-900/50 rounded px-3 py-2">
              {err}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded border border-white/15 text-slate-300 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="text-sm px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
          >
            {save.isPending ? "Saving…" : mode === "create" ? "Create" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}


function normalizeType(t: string): AttrType {
  const lower = t.toLowerCase();
  if (lower === "integer" || lower === "int") return "integer";
  if (lower === "float" || lower === "number" || lower === "double") return "float";
  return "string";
}


function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4">
      {children}
    </div>
  );
}
