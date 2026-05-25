import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiPost, apiPut, HelixEventType } from "../lib/api";


export type AttrType = "string" | "integer" | "float";


interface AttrRow {
  key: string;
  type: AttrType;
}


/**
 * Modal form for creating or editing a Verkada Helix event type.
 *
 * Two consumers:
 *
 *   1. **Helixr page** — the dedicated "manage Helix types" UI on the
 *      Workbench. Used for both create + edit.
 *   2. **StepConfigForm's helix_event_ref field** — when the operator
 *      is configuring a ``verkada_helix_event`` step and the type they
 *      want doesn't exist yet, a "+ New type" button next to the
 *      dropdown opens this in ``create`` mode so they can land back
 *      with a brand-new type selected without leaving the flow editor.
 *
 * On success, the editor invalidates the ``helix-event-types`` query
 * for the connection so any consumer's dropdown picks up the change.
 * Pass ``onCreated(newType)`` if you want to react beyond the auto
 * cache invalidation (e.g. auto-select the new type in a picker).
 */
export default function HelixEventTypeEditor({
  connId,
  mode,
  existing,
  seed,
  onClose,
  onCreated,
}: {
  connId: string;
  mode: "create" | "edit";
  existing?: HelixEventType;
  /**
   * Pre-fill values for ``create`` mode — used by paired-prompt flows
   * (BYOA, action editor) where the prompt knows what Helix type it
   * pairs with, so the operator clicks once and lands on a form
   * with name + attributes already populated. Ignored in ``edit`` mode
   * (the existing row's fields take precedence).
   */
  seed?: { name?: string | null; event_schema?: Record<string, string> | null };
  onClose: () => void;
  onCreated?: (created: HelixEventType) => void;
}) {
  const qc = useQueryClient();
  const initialName = existing?.name ?? (mode === "create" ? seed?.name ?? "" : "");
  const initialSchema =
    existing?.event_schema ??
    (mode === "create" ? seed?.event_schema ?? null : null);
  const [name, setName] = useState<string>(initialName ?? "");
  const [attrs, setAttrs] = useState<AttrRow[]>(() => {
    if (initialSchema) {
      return Object.entries(initialSchema).map(([k, t]) => ({
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
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["helix-event-types", connId] });
      if (mode === "create" && onCreated) onCreated(row);
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
            type="button"
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
              Each attribute becomes a typed field on events posted against
              this type. Pick a name and the data type. For example, an event
              for "person detected" might have{" "}
              <code className="font-mono">person_name</code> (string) and{" "}
              <code className="font-mono">confidence</code> (float).
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
                    onChange={(e) =>
                      setAttr(i, { type: e.target.value as AttrType })
                    }
                    className="px-2 py-1.5 rounded bg-white/5 border border-white/15 text-sm"
                  >
                    <option value="string">string</option>
                    <option value="integer">integer</option>
                    <option value="float">float</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => removeAttr(i)}
                    disabled={attrs.length === 1}
                    className="text-xs px-2 py-1 rounded border border-white/15 text-slate-400 hover:text-rose-300 hover:border-rose-800 disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setAttrs((cur) => [...cur, { key: "", type: "string" }])
                }
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
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded border border-white/15 text-slate-300 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="text-sm px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
          >
            {save.isPending
              ? "Saving…"
              : mode === "create"
                ? "Create"
                : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}


function normalizeType(t: string): AttrType {
  const lower = t.toLowerCase();
  if (lower === "integer" || lower === "int") return "integer";
  if (lower === "float" || lower === "number" || lower === "double")
    return "float";
  return "string";
}
