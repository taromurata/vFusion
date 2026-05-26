import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useEffect, useRef, useState } from "react";

import { apiDelete, apiGet, apiPost, apiPut, Flow, FlowExportFormat } from "../lib/api";
import HelixBootstrapModal from "../components/HelixBootstrapModal";


export default function Flows() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // When the picked file embeds Helix event-type defs we pause the
  // import to let the operator bootstrap them on a target Verkada
  // connection. Null = no modal, just import directly.
  const [pendingImport, setPendingImport] = useState<FlowExportFormat | null>(null);

  const importMut = useMutation({
    mutationFn: async (payload: FlowExportFormat) =>
      apiPost<Flow>("/api/flows/import", payload),
    onSuccess: (flow) => {
      setImportError(null);
      setPendingImport(null);
      qc.invalidateQueries({ queryKey: ["flows"] });
      navigate(`/flows/${flow.id}/edit`);
    },
    onError: (e: Error) => setImportError(e.message),
  });

  const handleImportClick = () => {
    setImportError(null);
    fileRef.current?.click();
  };
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset early so picking the same file twice in a row still fires onChange.
    e.target.value = "";
    if (!file) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setImportError("That file isn't valid JSON.");
      return;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { format?: unknown }).format !== "vfusion-flow"
    ) {
      setImportError(
        "Doesn't look like a vFusion flow export — expected a `format: \"vfusion-flow\"` field.",
      );
      return;
    }
    const payload = parsed as FlowExportFormat;
    // If the export embeds Helix type defs, route through the bootstrap
    // modal first. Otherwise just import.
    if ((payload.helix_event_types?.length ?? 0) > 0) {
      setPendingImport(payload);
    } else {
      importMut.mutate(payload);
    }
  };

  // If we land here with ?from_event=<id> (e.g. from the inbox's "+ Create
  // flow"), bounce straight to the canvas editor with the same param so the
  // prefill flow runs there.
  useEffect(() => {
    const fromEvent = searchParams.get("from_event");
    if (fromEvent) {
      navigate(`/flows/new?from_event=${fromEvent}`, { replace: true });
    }
  }, [searchParams, navigate]);

  const flows = useQuery({
    queryKey: ["flows"],
    queryFn: () => apiGet<Flow[]>("/api/flows"),
    refetchInterval: 5000,
  });

  const toggle = useMutation({
    mutationFn: (f: Flow) => apiPut(`/api/flows/${f.id}`, { enabled: !f.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flows"] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/flows/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flows"] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Flows</h1>
          <p className="text-slate-400 text-sm mt-1">
            Visual editor — wire a Verkada webhook trigger to one or more action
            steps. Watch executions on the{" "}
            <Link to="/runs" className="text-sky-400 hover:underline">
              Runs
            </Link>{" "}
            page.
          </p>
        </div>
        <div className="flex items-center gap-2 whitespace-nowrap">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={handleFileChange}
            className="hidden"
          />
          <Link
            to="/templates"
            className="text-sm px-3 py-1.5 rounded-md border border-white/15 text-slate-200 hover:bg-white/10"
            title="Start from a built-in or saved template"
          >
            Browse templates
          </Link>
          <button
            onClick={handleImportClick}
            disabled={importMut.isPending}
            title="Import a flow from a .vfusion.json file"
            className="text-sm px-3 py-1.5 rounded-md border border-white/15 text-slate-200 hover:bg-white/10 disabled:opacity-50"
          >
            {importMut.isPending ? "Importing…" : "Import"}
          </button>
          <Link
            to="/flows/new"
            className="text-sm px-3 py-1.5 rounded-md bg-sky-700 hover:bg-sky-600 text-white"
          >
            + Create flow
          </Link>
        </div>
      </div>

      {importError && (
        <div className="text-sm text-rose-300 bg-rose-950/50 border border-rose-900 rounded px-3 py-2">
          {importError}
        </div>
      )}

      <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900/50">
        {flows.isLoading ? (
          <div className="p-6 text-sm text-slate-500">Loading…</div>
        ) : !flows.data || flows.data.length === 0 ? (
          <div className="p-6 text-sm text-slate-400">
            <p className="font-medium text-slate-200 mb-1">No flows yet.</p>
            <p>
              Click <strong className="text-slate-200">+ Create flow</strong> to open
              the canvas editor.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-2">Name</th>
                <th className="text-left px-3 py-2">Trigger</th>
                <th className="text-left px-3 py-2">Steps</th>
                <th className="text-left px-3 py-2">Enabled</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {flows.data.map((f) => (
                <tr key={f.id}>
                  <td className="px-3 py-2 font-medium">
                    <Link
                      to={`/flows/${f.id}/edit`}
                      className="text-slate-100 hover:text-sky-300"
                    >
                      {f.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400">
                    {f.trigger_type === "schedule" ? (
                      <ScheduleTriggerLabel cfg={f.trigger_config} />
                    ) : (
                      <>
                        {f.trigger_config.family ?? "(any)"}
                        {f.trigger_config.notification_type
                          ? ` / ${f.trigger_config.notification_type}`
                          : ""}
                        {f.trigger_config.filters &&
                          Object.entries(f.trigger_config.filters).length > 0 && (
                            <span className="text-slate-500">
                              {" "}
                              [
                              {Object.entries(f.trigger_config.filters)
                                .map(([k, v]) => `${k}=${v}`)
                                .join(", ")}
                              ]
                            </span>
                          )}
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400 font-mono">
                    {(f.nodes ?? []).map((n) => n.name).join(" · ") || "(none)"}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => toggle.mutate(f)}
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        f.enabled
                          ? "bg-emerald-900 text-emerald-200"
                          : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {f.enabled ? "ON" : "OFF"}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Link
                      to={`/flows/${f.id}/edit`}
                      className="text-xs px-2 py-1 rounded border border-slate-700 hover:border-sky-600 mr-2 inline-block"
                    >
                      Edit
                    </Link>
                    <button
                      onClick={() => {
                        if (confirm(`Delete "${f.name}"?`)) del.mutate(f.id);
                      }}
                      className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-rose-300 hover:border-rose-800"
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

      {pendingImport && (
        <HelixBootstrapModal
          defs={pendingImport.helix_event_types ?? []}
          onCancel={() => setPendingImport(null)}
          onConfirm={(uidMap, connId) =>
            importMut.mutate({
              ...pendingImport,
              helix_uid_map: uidMap,
              // Forward the operator's chosen Verkada connection so
              // /api/flows/import rebinds every verkada_connection_id
              // slot to it instead of leaving them null.
              verkada_connection_id: connId || null,
            })
          }
        />
      )}
    </div>
  );
}


function ScheduleTriggerLabel({
  cfg,
}: {
  cfg: Flow["trigger_config"];
}) {
  const kind = cfg.kind;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (kind === "interval") {
    return (
      <span>
        every <span className="text-slate-200">{cfg.every_minutes}</span> min
      </span>
    );
  }
  if (kind === "daily") {
    return (
      <span>
        daily at{" "}
        <span className="text-slate-200">
          {pad(cfg.hour ?? 0)}:{pad(cfg.minute ?? 0)}
        </span>{" "}
        UTC
      </span>
    );
  }
  if (kind === "weekly") {
    const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return (
      <span>
        weekly{" "}
        <span className="text-slate-200">{wd[cfg.weekday ?? 0]}</span> at{" "}
        <span className="text-slate-200">
          {pad(cfg.hour ?? 0)}:{pad(cfg.minute ?? 0)}
        </span>{" "}
        UTC
      </span>
    );
  }
  return <span className="text-slate-500">schedule</span>;
}
