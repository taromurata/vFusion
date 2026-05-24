import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";

import {
  apiGet,
  apiPost,
  Connection,
  HelixBootstrapResponse,
  HelixEventType,
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
 * deploy gets a different uid than the one in the export. We pre-check
 * the target connection's existing types client-side so:
 *   1. Types that already exist by name get a "✓ Already on this org"
 *      badge + unchecked-by-default (no need to create them again).
 *   2. If *every* referenced type already exists, the modal auto-closes
 *      and the caller proceeds with the pre-built uid_map. Solves the
 *      "applied this template twice" case where the second pass
 *      otherwise asks to create what's already there.
 * Skipping returns an empty map (callers proceed without rewriting;
 * runtime will fail until the operator wires it up by hand).
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

  // Existing Helix types on the target connection. Used to detect
  // by-name matches client-side so we can pre-mark "already exists"
  // rows + skip the modal entirely when nothing needs creating.
  const existing = useQuery({
    queryKey: ["helix-event-types", effectiveTarget],
    queryFn: () =>
      apiGet<HelixEventType[]>(`/api/connections/${effectiveTarget}/helix-event-types`),
    enabled: !!effectiveTarget,
  });

  // name (lowercased) -> existing event type. Case-insensitive because
  // names are user-supplied and casing drifts.
  const existingByName = useMemo(() => {
    const m = new Map<string, HelixEventType>();
    for (const row of existing.data ?? []) {
      if (row.name) m.set(row.name.trim().toLowerCase(), row);
    }
    return m;
  }, [existing.data]);

  // Per-def lookup: { match: existing-row-or-null }.
  const matches = useMemo(() => {
    return defs.map((d) => {
      const key = (d.name ?? "").trim().toLowerCase();
      return key ? existingByName.get(key) ?? null : null;
    });
  }, [defs, existingByName]);

  // Selection state, keyed by the export's event_type_uid. Defaults
  // to checked for missing types, unchecked for ones that already
  // exist. Resets whenever the lookup completes.
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!existing.isSuccess) return;
    const next: Record<string, boolean> = {};
    defs.forEach((d, i) => {
      next[d.event_type_uid] = matches[i] === null;
    });
    setSelected(next);
  }, [existing.isSuccess, existing.data, defs, matches]);

  // Pre-built uid map for the types that already exist — caller can
  // proceed with this even when they hit "Skip & import anyway".
  const prebuiltUidMap = useMemo(() => {
    const m: Record<string, string> = {};
    defs.forEach((d, i) => {
      const ex = matches[i];
      if (ex) m[d.event_type_uid] = ex.event_type_uid;
    });
    return m;
  }, [defs, matches]);

  const allExist =
    existing.isSuccess && defs.length > 0 && matches.every((m) => m !== null);

  // Auto-skip when everything's already there — no point making the
  // operator click "OK" on a modal that has nothing to do. Guard with
  // a ref-like flag so we only fire once per resolution.
  const [autoConfirmed, setAutoConfirmed] = useState(false);
  useEffect(() => {
    if (allExist && !autoConfirmed) {
      setAutoConfirmed(true);
      onConfirm(prebuiltUidMap);
    }
  }, [allExist, autoConfirmed, onConfirm, prebuiltUidMap]);

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

  // Skip still hands back the prebuilt map so any types that *do*
  // already exist get rewritten correctly — the only thing skipping
  // does is opt out of creating the missing ones.
  const handleSkip = () => onConfirm(prebuiltUidMap);

  const probeLoading = !!effectiveTarget && existing.isLoading;
  const missingCount = matches.filter((m) => m === null).length;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-3 border-b border-slate-800">
          <h2 className="text-lg font-semibold text-white">
            Helix event types referenced by this flow
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            {probeLoading
              ? "Checking your Verkada org for existing types…"
              : missingCount === 0 && existing.isSuccess
                ? "Everything this flow needs is already on your Verkada org — proceeding."
                : `This import uses ${defs.length === 1 ? "a Helix event type" : "Helix event types"} that may not exist on your Verkada org yet. Recommended: let us create the missing ${missingCount === 1 ? "one" : "ones"} now so the flow works on first run.`}
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
            {defs.map((d, i) => {
              const schemaEntries = Object.entries(d.event_schema ?? {});
              const match = matches[i];
              const alreadyExists = match !== null;
              return (
                <label
                  key={d.event_type_uid}
                  className={`flex items-start gap-3 border rounded px-3 py-2 ${
                    alreadyExists
                      ? "bg-emerald-950/30 border-emerald-900/60"
                      : "bg-slate-800/50 border-slate-700 hover:border-slate-600 cursor-pointer"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={!!selected[d.event_type_uid]}
                    disabled={alreadyExists}
                    onChange={(e) =>
                      setSelected((s) => ({ ...s, [d.event_type_uid]: e.target.checked }))
                    }
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="text-sm text-slate-100 font-medium">
                        {d.name || <span className="text-slate-500 italic">(no name)</span>}
                      </div>
                      {alreadyExists && (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-200">
                          ✓ Already on this org
                        </span>
                      )}
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
            type="button"
            onClick={onCancel}
            className="text-sm px-3 py-1.5 rounded-md border border-white/15 text-slate-300 hover:bg-white/10"
          >
            Cancel
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSkip}
              disabled={bootstrapMut.isPending}
              title="Import without creating any missing types — runs will fail on missing types until the operator sets them up by hand."
              className="text-sm px-3 py-1.5 rounded-md border border-white/15 text-slate-300 hover:bg-white/10 disabled:opacity-50"
            >
              Skip &amp; import anyway
            </button>
            <button
              type="button"
              onClick={() => {
                setBootstrapError(null);
                bootstrapMut.mutate();
              }}
              disabled={
                bootstrapMut.isPending ||
                verkadaConns.length === 0 ||
                !effectiveTarget ||
                missingCount === 0
              }
              className="text-sm px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
            >
              {bootstrapMut.isPending
                ? "Creating…"
                : missingCount > 0
                  ? `Create ${missingCount} & import`
                  : "Nothing to create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
