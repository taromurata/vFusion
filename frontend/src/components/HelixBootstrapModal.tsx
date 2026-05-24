import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";

import {
  apiGet,
  apiPost,
  Connection,
  HelixBootstrapResponse,
  HelixEventTypeDef,
} from "../lib/api";

/**
 * Modal shown when an imported flow or applied template references one
 * or more Helix event-type definitions. Lets the operator pick a target
 * Verkada connection, opt in to recreating any missing types, and
 * returns a uid rewrite map so the caller can finish the import / apply
 * with each node's ``event_type_uid`` pointing at the right thing.
 *
 * Verkada assigns uids server-side, so a "bear" recreated on a fresh
 * deploy gets a different uid than the one in the export. The bootstrap
 * endpoint matches by name on the target connection — existing types
 * are reused as-is, missing ones get created and the new uid lands in
 * the map. Skipping returns an empty map (callers proceed without
 * rewriting; runtime will fail until the operator wires it up by hand).
 */
export default function HelixBootstrapModal({
  defs,
  onCancel,
  onConfirm,
}: {
  defs: HelixEventTypeDef[];
  onCancel: () => void;
  // Called with the uid rewrite map (empty when the operator skipped).
  onConfirm: (uidMap: Record<string, string>) => void;
}) {

  // Verkada connections only — Helix types are scoped to a Verkada org.
  const conns = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiGet<Connection[]>("/api/connections"),
  });
  const verkadaConns = useMemo(
    () => (conns.data ?? []).filter((c) => c.type === "verkada" && c.setup_complete),
    [conns.data],
  );

  // Auto-select when there's exactly one — same rule as connection rebind.
  const [targetConnId, setTargetConnId] = useState<string>("");
  const effectiveTarget = targetConnId || (verkadaConns.length === 1 ? verkadaConns[0].id : "");

  // Default every embedded type to "create me". Operator unchecks any
  // they already have under that exact name (the bootstrap also detects
  // name matches server-side, but the checkbox is the explicit opt-in).
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(defs.map((d) => [d.event_type_uid, true])),
  );

  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const bootstrapMut = useMutation({
    mutationFn: async () => {
      if (!effectiveTarget) {
        throw new Error("Pick a target Verkada connection first.");
      }
      const create_uids = defs
        .map((d) => d.event_type_uid)
        .filter((uid) => selected[uid]);
      return apiPost<HelixBootstrapResponse>("/api/flows/helix-bootstrap", {
        target_connection_id: effectiveTarget,
        event_types: defs,
        create_uids,
      });
    },
    onSuccess: (res) => {
      // Any hard failures from Verkada — surface them so the operator
      // doesn't get a half-bootstrapped import without knowing.
      const failed = res.results.filter((r) => r.status === "failed");
      if (failed.length > 0) {
        setBootstrapError(
          `Verkada rejected: ${failed
            .map((f) => `${f.name ?? f.event_type_uid} (${f.error})`)
            .join("; ")}`,
        );
        return;
      }
      onConfirm(res.uid_map);
    },
    onError: (e: Error) => setBootstrapError(e.message),
  });

  const handleSkip = () => onConfirm({});

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-3 border-b border-slate-800">
          <h2 className="text-lg font-semibold text-white">
            Helix event types referenced by this flow
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            This import uses {defs.length === 1 ? "a Helix event type" : "Helix event types"} that
            may not exist on your Verkada org yet. Recommended: let us create{" "}
            {defs.length === 1 ? "it" : "them"} now so the flow works on first run. If you
            already have {defs.length === 1 ? "it" : "them"} set up under the same name, the
            bootstrap will detect that and reuse what's there.
          </p>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex flex-col gap-4 flex-1">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-300">Target Verkada connection</span>
            {verkadaConns.length === 0 ? (
              <span className="text-rose-300 text-xs">
                No Verkada connection set up — finish setup on the Connections page first.
              </span>
            ) : (
              <select
                value={effectiveTarget}
                onChange={(e) => setTargetConnId(e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100"
              >
                {verkadaConns.length > 1 && <option value="">Pick one…</option>}
                {verkadaConns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </label>

          <div className="flex flex-col gap-2">
            {defs.map((d) => {
              const schemaEntries = Object.entries(d.event_schema ?? {});
              return (
                <label
                  key={d.event_type_uid}
                  className="flex items-start gap-3 bg-slate-800/50 border border-slate-700 rounded px-3 py-2 cursor-pointer hover:border-slate-600"
                >
                  <input
                    type="checkbox"
                    checked={!!selected[d.event_type_uid]}
                    onChange={(e) =>
                      setSelected((s) => ({ ...s, [d.event_type_uid]: e.target.checked }))
                    }
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-100 font-medium">
                      {d.name || <span className="text-slate-500 italic">(no name)</span>}
                    </div>
                    {schemaEntries.length > 0 ? (
                      <div className="text-[11px] text-slate-400 font-mono mt-1">
                        {schemaEntries.map(([k, v]) => `${k}: ${v}`).join(" · ")}
                      </div>
                    ) : (
                      <div className="text-[11px] text-slate-500 mt-1">
                        No attribute schema embedded — can't recreate automatically.
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>

          {bootstrapError && (
            <div className="text-xs text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
              {bootstrapError}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-between gap-2">
          <button
            onClick={onCancel}
            className="text-sm px-3 py-1.5 rounded-md border border-white/15 text-slate-300 hover:bg-white/10"
          >
            Cancel
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSkip}
              disabled={bootstrapMut.isPending}
              title="Import without creating any types — runs will fail until the operator sets them up by hand."
              className="text-sm px-3 py-1.5 rounded-md border border-white/15 text-slate-300 hover:bg-white/10 disabled:opacity-50"
            >
              Skip &amp; import anyway
            </button>
            <button
              onClick={() => {
                setBootstrapError(null);
                bootstrapMut.mutate();
              }}
              disabled={
                bootstrapMut.isPending ||
                verkadaConns.length === 0 ||
                !effectiveTarget
              }
              className="text-sm px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
            >
              {bootstrapMut.isPending ? "Creating…" : "Create selected & import"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
