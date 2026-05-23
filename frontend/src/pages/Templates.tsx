import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  Flow,
  FlowTemplateDetail,
  FlowTemplateListItem,
  PromptTemplate,
} from "../lib/api";


interface BuiltinTemplate {
  name: string;
  value: string;
}


type EditingState =
  | PromptTemplate
  | { kind: "new"; seedName?: string; seedValue?: string }
  | null;


type Tab = "flows" | "prompts";


export default function Templates() {
  const [tab, setTab] = useState<Tab>("flows");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Templates</h1>
        <p className="text-slate-300 text-sm mt-1">
          Starter flows you can use as-is, and saved prompts you reuse across
          Gemini analyze actions.
        </p>
      </div>

      <nav className="flex items-center gap-1 border-b border-white/10 -mb-2">
        <TabButton active={tab === "flows"} onClick={() => setTab("flows")}>
          Flow templates
        </TabButton>
        <TabButton active={tab === "prompts"} onClick={() => setTab("prompts")}>
          Prompt templates
        </TabButton>
      </nav>

      {tab === "flows" ? <FlowTemplatesPanel /> : <PromptTemplatesPanel />}
    </div>
  );
}


function TabButton({
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
      onClick={onClick}
      className={`px-3 py-2 text-sm rounded-t-md border-b-2 transition-colors ${
        active
          ? "border-sky-500 text-white"
          : "border-transparent text-slate-400 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}


// ---------------------------------------------------------------------------
// Flow templates panel — built-in starter flows
// ---------------------------------------------------------------------------

function FlowTemplatesPanel() {
  const navigate = useNavigate();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["flow-templates"],
    queryFn: () => apiGet<FlowTemplateListItem[]>("/api/flow-templates"),
  });

  const useTemplate = async (id: string) => {
    setBusyId(id);
    setErr(null);
    try {
      const tpl = await apiGet<FlowTemplateDetail>(`/api/flow-templates/${id}`);
      // Imported / template-applied flows start disabled so the user can
      // wire up connections before the trigger goes live.
      const created = await apiPost<Flow>("/api/flows", {
        name: tpl.default_name || tpl.name,
        enabled: false,
        trigger_type: tpl.flow.trigger_type,
        trigger_config: tpl.flow.trigger_config,
        nodes: tpl.flow.nodes,
        edges: tpl.flow.edges,
      });
      navigate(`/flows/${created.id}/edit`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  if (list.isLoading) {
    return <div className="text-sm text-slate-400">Loading…</div>;
  }
  if (!list.data || list.data.length === 0) {
    return (
      <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-6 text-sm text-slate-400">
        No flow templates available. Drop new JSON files into
        <code className="font-mono mx-1 text-slate-300">backend/app/data/flow_templates/</code>
        and reload.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500 leading-relaxed">
        Each template creates a new flow pre-wired with the right trigger,
        actions, and conditions. Connections (Verkada org, Gemini key, Helix
        event type) start empty — pick them in the editor, then enable.
      </p>
      {err && (
        <div className="text-sm text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
          {err}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {list.data.map((tpl) => (
          <div
            key={tpl.id}
            className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4 flex flex-col gap-3"
          >
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="text-sm font-medium text-slate-100">
                  {tpl.name}
                </div>
                {tpl.category && (
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-900/60 text-sky-200">
                    {tpl.category}
                  </span>
                )}
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-300">
                  {tpl.trigger_type === "schedule" ? "schedule" : "webhook"}
                </span>
              </div>
              {tpl.description && (
                <div className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
                  {tpl.description}
                </div>
              )}
              {tpl.summary && (
                <div className="mt-2 text-[11px] font-mono text-slate-500 bg-slate-950/60 rounded px-2 py-1 border border-white/5">
                  {tpl.summary}
                </div>
              )}
            </div>
            <div className="mt-auto">
              <button
                onClick={() => useTemplate(tpl.id)}
                disabled={busyId !== null}
                className="text-xs px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-50"
              >
                {busyId === tpl.id ? "Creating…" : "Use this template"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Prompt templates panel — the original analytics-prompt library
// ---------------------------------------------------------------------------

function PromptTemplatesPanel() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<EditingState>(null);

  const list = useQuery({
    queryKey: ["prompt-templates"],
    queryFn: () => apiGet<PromptTemplate[]>("/api/prompt-templates"),
  });
  const builtins = useQuery({
    queryKey: ["prompt-templates-builtins"],
    queryFn: () => apiGet<BuiltinTemplate[]>("/api/prompt-templates/builtins"),
    staleTime: 60_000,
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/prompt-templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prompt-templates"] }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-slate-500 leading-relaxed">
          Save prompts you reuse across Gemini analyze actions. They show up in
          the action editor's template dropdown alongside the built-ins.
        </p>
        <button
          onClick={() => setEditing({ kind: "new" })}
          className="text-sm px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-white whitespace-nowrap"
        >
          + New template
        </button>
      </div>

      {/* User-saved templates */}
      <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg overflow-hidden">
        <div className="px-4 py-2 border-b border-white/10 text-xs uppercase tracking-wider text-slate-400">
          Your templates
        </div>
        {list.isLoading ? (
          <div className="p-6 text-sm text-slate-400">Loading…</div>
        ) : !list.data || list.data.length === 0 ? (
          <div className="p-6 text-sm text-slate-400">
            No saved templates yet. Click <strong className="text-slate-100">+ New template</strong> or
            duplicate one of the defaults below as a starting point.
          </div>
        ) : (
          <ul className="divide-y divide-white/5">
            {list.data.map((t) => (
              <li key={t.id} className="p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm font-medium text-slate-100 truncate">
                    {t.name}
                  </div>
                  <div className="text-[10px] text-slate-500 whitespace-nowrap">
                    edited {new Date(t.updated_at).toLocaleString()}
                  </div>
                </div>
                <pre className="mt-2 text-xs text-slate-300 whitespace-pre-wrap line-clamp-4 font-sans">
                  {t.value}
                </pre>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => setEditing(t)}
                    className="text-xs px-2 py-1 rounded border border-white/15 hover:border-sky-500 hover:bg-white/5 text-slate-200"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete template "${t.name}"?`)) del.mutate(t.id);
                    }}
                    className="text-xs px-2 py-1 rounded border border-white/15 text-slate-300 hover:text-rose-300 hover:border-rose-700"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Built-in (default) templates — read-only, duplicate to edit. */}
      {builtins.data && builtins.data.length > 0 && (
        <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b border-white/10 text-xs uppercase tracking-wider text-slate-400">
            Defaults (read-only)
          </div>
          <ul className="divide-y divide-white/5">
            {builtins.data.map((t) => (
              <li key={t.name} className="p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm font-medium text-slate-100 truncate flex items-center gap-2">
                    <span>{t.name}</span>
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-900/60 text-sky-200">
                      default
                    </span>
                  </div>
                </div>
                <pre className="mt-2 text-xs text-slate-300 whitespace-pre-wrap line-clamp-4 font-sans">
                  {t.value}
                </pre>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() =>
                      setEditing({
                        kind: "new",
                        seedName: `${t.name} (copy)`,
                        seedValue: t.value,
                      })
                    }
                    className="text-xs px-2 py-1 rounded border border-white/15 hover:border-sky-500 hover:bg-white/5 text-slate-200"
                  >
                    Duplicate to edit
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {editing && (
        <EditorModal
          state={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["prompt-templates"] });
          }}
        />
      )}
    </div>
  );
}


function EditorModal({
  state,
  onClose,
  onSaved,
}: {
  state: Exclude<EditingState, null>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = "id" in state ? state : null;
  const seed = !existing && "kind" in state ? state : null;
  const [name, setName] = useState(existing?.name ?? seed?.seedName ?? "");
  const [value, setValue] = useState(existing?.value ?? seed?.seedValue ?? "");
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      if (existing) {
        return apiPut<PromptTemplate>(
          `/api/prompt-templates/${existing.id}`,
          { name, value },
        );
      }
      return apiPost<PromptTemplate>("/api/prompt-templates", { name, value });
    },
    onSuccess: onSaved,
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
      <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-lg w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-white">
          {existing ? "Edit template" : "New template"}
        </h2>
        <label className="block">
          <div className="text-xs font-medium text-slate-300 mb-1">
            Name <span className="text-rose-400">*</span>
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 focus:outline-none focus:border-sky-500 text-sm"
            placeholder="e.g. Detect packages on porch"
          />
        </label>
        <label className="block">
          <div className="text-xs font-medium text-slate-300 mb-1">
            Prompt <span className="text-rose-400">*</span>
          </div>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={10}
            spellCheck={false}
            className="w-full px-2 py-1.5 rounded bg-white/5 border border-white/15 focus:outline-none focus:border-sky-500 text-sm"
            placeholder="Describe what Gemini should look for…"
          />
        </label>
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
            Cancel
          </button>
          <button
            onClick={() => {
              setErr(null);
              if (!name.trim()) return setErr("Name is required.");
              if (!value.trim()) return setErr("Prompt is required.");
              save.mutate();
            }}
            disabled={save.isPending}
            className="px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-sm disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
