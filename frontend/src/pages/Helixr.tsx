import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiGet,
  apiPost,
  Connection,
  HelixEventType,
} from "../lib/api";
import HelixEventTypeEditor from "../components/HelixEventTypeEditor";


/**
 * Helixr — Helix event type CRUD.
 *
 * Lists every Helix event type for a chosen Verkada connection. The
 * editor itself lives in ``components/HelixEventTypeEditor`` so it can
 * also be opened from the flow editor's helix_event_ref picker when an
 * operator needs a new type while wiring up a step.
 *
 * Scope is deliberately narrow: types only, not event instances. Posting
 * actual events still happens via flows (the verkada_helix_event action).
 */


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
            <HelixEventTypeEditor
              connId={connId}
              mode="create"
              onClose={() => setCreating(false)}
            />
          )}
          {editing && (
            <HelixEventTypeEditor
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

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4">
      {children}
    </div>
  );
}
