import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import {
  apiGet,
  apiPut,
  SettingRow,
  SettingsResponse,
} from "../lib/api";


interface TypeCount {
  label: string;
  count: number;
  // "notification_type" | "webhook_type" | "null" — tells the drill-down
  // which inbox filter to apply when the bar is clicked.
  label_source?: string;
}


interface StorageBucket {
  label: string;
  bytes: number;
  file_count: number;
}


interface ModelSpend {
  model: string;
  runs: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}


interface PricingRow {
  model: string;
  input_per_1m_usd: number;
  output_per_1m_usd: number;
  fetched_at: string;
}


interface SystemLoad {
  cpu_percent: number;
  cpu_count: number;
  load_avg_1m: number | null;
  load_avg_5m: number | null;
  load_avg_15m: number | null;
  mem_total_bytes: number;
  mem_used_bytes: number;
  mem_percent: number;
  swap_used_bytes: number;
  disk_total_bytes: number;
  disk_used_bytes: number;
  disk_percent: number;
  process_rss_bytes: number;
  process_threads: number;
  uptime_seconds: number;
  sampled_at: string;
}


interface StatsOverview {
  generated_at: string;
  webhooks_total: number;
  webhooks_last_24h: number;
  webhooks_last_7d: number;
  webhooks_last_30d: number;
  webhooks_by_type: TypeCount[];
  webhooks_by_family: TypeCount[];
  runs_total: number;
  runs_last_24h: number;
  runs_success_rate: number | null;
  storage: StorageBucket[];
  storage_total_bytes: number;
  gemini_spend_30d_usd: number;
  gemini_spend_by_model: ModelSpend[];
  gemini_pricing: PricingRow[];
}


function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}


function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}


export default function Stats() {
  const stats = useQuery({
    queryKey: ["stats-overview"],
    queryFn: () => apiGet<StatsOverview>("/api/stats/overview"),
    refetchInterval: 30000,
  });
  const system = useQuery({
    queryKey: ["stats-system"],
    queryFn: () => apiGet<SystemLoad>("/api/stats/system"),
    refetchInterval: 5000,
  });

  const s = stats.data;
  const sys = system.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Stats</h1>
        <p className="text-slate-300 text-sm mt-1">
          Aggregate counters for ingest, flow runs, and on-disk storage. A
          future Gemini-backed trend view will live here too.
        </p>
      </div>

      {stats.isLoading && (
        <Card>
          <div className="text-sm text-slate-400">Loading…</div>
        </Card>
      )}

      {s && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile label="Webhooks (24h)" value={s.webhooks_last_24h.toLocaleString()} />
            <StatTile label="Webhooks (7d)" value={s.webhooks_last_7d.toLocaleString()} />
            <StatTile label="Webhooks (30d)" value={s.webhooks_last_30d.toLocaleString()} />
            <StatTile label="Webhooks (all time)" value={s.webhooks_total.toLocaleString()} />
            <StatTile label="Flow runs (24h)" value={s.runs_last_24h.toLocaleString()} />
            <StatTile label="Flow runs (all time)" value={s.runs_total.toLocaleString()} />
            <StatTile
              label="Run success (24h)"
              value={
                s.runs_success_rate === null
                  ? "—"
                  : `${(s.runs_success_rate * 100).toFixed(0)}%`
              }
            />
            <StatTile label="Disk used" value={fmtBytes(s.storage_total_bytes)} />
            <StatTile
              label="Gemini spend (30d est.)"
              value={fmtUsd(s.gemini_spend_30d_usd)}
            />
          </div>

          {sys && <ServerLoadCard sys={sys} />}

          <Card title="Webhooks by family">
            <BarList
              items={s.webhooks_by_family}
              linkBuilder={(item) =>
                item.label === "(unknown)"
                  ? `/inbox?family=unknown`
                  : `/inbox?family=${encodeURIComponent(item.label)}`
              }
            />
          </Card>

          <Card title="Top event types">
            <BarList
              items={s.webhooks_by_type}
              linkBuilder={(item) => {
                if (item.label_source === "webhook_type")
                  return `/inbox?webhook_type=${encodeURIComponent(item.label)}`;
                if (item.label_source === "null" || item.label === "(unrecognized)")
                  return `/inbox?notification_type=__null__&webhook_type=__null__`;
                return `/inbox?notification_type=${encodeURIComponent(item.label)}`;
              }}
            />
          </Card>

          <Card title="Storage">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 text-xs uppercase tracking-wider">
                  <th className="pb-2 pr-4">Bucket</th>
                  <th className="pb-2 pr-4">Files</th>
                  <th className="pb-2">Size</th>
                </tr>
              </thead>
              <tbody>
                {s.storage.map((b) => (
                  <tr key={b.label} className="border-t border-white/10">
                    <td className="py-2 pr-4 text-slate-200">{b.label}</td>
                    <td className="py-2 pr-4 text-slate-400">{b.file_count.toLocaleString()}</td>
                    <td className="py-2 text-slate-200">{fmtBytes(b.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Gemini spend by model (30d)">
            {s.gemini_spend_by_model.length === 0 ? (
              <div className="text-sm text-slate-500">
                No Gemini runs in the last 30 days yet — kick off a BYOA or a
                flow that uses a Gemini analyze step.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-400 text-xs uppercase tracking-wider">
                    <th className="pb-2 pr-4">Model</th>
                    <th className="pb-2 pr-4">Runs</th>
                    <th className="pb-2 pr-4">In tok</th>
                    <th className="pb-2 pr-4">Out tok</th>
                    <th className="pb-2">Cost (est.)</th>
                  </tr>
                </thead>
                <tbody>
                  {s.gemini_spend_by_model.map((m) => (
                    <tr key={m.model} className="border-t border-white/10">
                      <td className="py-2 pr-4 text-slate-200 font-mono text-xs">
                        {m.model}
                      </td>
                      <td className="py-2 pr-4 text-slate-300">
                        {m.runs.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-slate-400">
                        {m.tokens_in.toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-slate-400">
                        {m.tokens_out.toLocaleString()}
                      </td>
                      <td className="py-2 text-slate-200">
                        {fmtUsd(m.cost_usd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-[11px] text-slate-500 mt-3">
              Estimate based on Google's published per-token rates × the
              usage_metadata each call reports. Not invoice reconciliation —
              ignores credits, free-tier, batch discounts.
            </p>
          </Card>

          <Card title="Current Gemini rates (per 1M tokens)">
            {s.gemini_pricing.length === 0 ? (
              <div className="text-sm text-slate-500">No rates loaded yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-400 text-xs uppercase tracking-wider">
                    <th className="pb-2 pr-4">Model</th>
                    <th className="pb-2 pr-4">Input</th>
                    <th className="pb-2 pr-4">Output</th>
                    <th className="pb-2">Last refreshed</th>
                  </tr>
                </thead>
                <tbody>
                  {s.gemini_pricing.map((p) => (
                    <tr key={p.model} className="border-t border-white/10">
                      <td className="py-2 pr-4 text-slate-200 font-mono text-xs">
                        {p.model}
                      </td>
                      <td className="py-2 pr-4 text-slate-300">
                        ${p.input_per_1m_usd.toFixed(2)}
                      </td>
                      <td className="py-2 pr-4 text-slate-300">
                        ${p.output_per_1m_usd.toFixed(2)}
                      </td>
                      <td className="py-2 text-slate-500 text-xs">
                        {new Date(p.fetched_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <RetentionSettingsCard />

          <Card title="Coming soon">
            <ul className="text-sm text-slate-300 space-y-1 list-disc list-inside">
              <li>Daily webhook volume sparkline</li>
              <li>Per-flow run timing breakdown</li>
              <li>Top failing actions</li>
            </ul>
          </Card>

          <p className="text-xs text-slate-500">
            Refreshed {new Date(s.generated_at).toLocaleString()}.
          </p>
        </>
      )}
    </div>
  );
}


function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}


function Meter({
  label,
  pct,
  detail,
}: {
  label: string;
  pct: number;
  detail: string;
}) {
  const tone =
    pct >= 90
      ? "bg-rose-500/70"
      : pct >= 75
        ? "bg-amber-500/70"
        : "bg-sky-500/70";
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-400">
          {pct.toFixed(0)}% <span className="text-slate-500">· {detail}</span>
        </span>
      </div>
      <div className="h-1.5 bg-white/5 rounded mt-1 overflow-hidden">
        <div
          className={`h-full ${tone}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}


function ServerLoadCard({ sys }: { sys: SystemLoad }) {
  const loadDetail =
    sys.load_avg_1m !== null
      ? `load ${sys.load_avg_1m.toFixed(2)} / ${(sys.load_avg_5m ?? 0).toFixed(2)} / ${(sys.load_avg_15m ?? 0).toFixed(2)} · ${sys.cpu_count} cores`
      : `${sys.cpu_count} cores`;
  return (
    <Card title="Server load">
      <div className="space-y-3">
        <Meter
          label="CPU"
          pct={sys.cpu_percent}
          detail={loadDetail}
        />
        <Meter
          label="Memory"
          pct={sys.mem_percent}
          detail={`${fmtBytes(sys.mem_used_bytes)} / ${fmtBytes(sys.mem_total_bytes)}`}
        />
        <Meter
          label="Disk (/)"
          pct={sys.disk_percent}
          detail={`${fmtBytes(sys.disk_used_bytes)} / ${fmtBytes(sys.disk_total_bytes)}`}
        />
        <div className="grid grid-cols-3 gap-3 pt-2 border-t border-white/10 text-xs">
          <div>
            <div className="text-slate-500 uppercase tracking-wider text-[10px]">
              Backend RSS
            </div>
            <div className="text-slate-200 mt-0.5">
              {fmtBytes(sys.process_rss_bytes)}
            </div>
          </div>
          <div>
            <div className="text-slate-500 uppercase tracking-wider text-[10px]">
              Threads
            </div>
            <div className="text-slate-200 mt-0.5">{sys.process_threads}</div>
          </div>
          <div>
            <div className="text-slate-500 uppercase tracking-wider text-[10px]">
              Host uptime
            </div>
            <div className="text-slate-200 mt-0.5">
              {fmtDuration(sys.uptime_seconds)}
            </div>
          </div>
        </div>
        {sys.swap_used_bytes > 0 && (
          <div className="text-[11px] text-amber-300">
            ⚠ swap in use: {fmtBytes(sys.swap_used_bytes)} — host is memory-pressured.
          </div>
        )}
        <p className="text-[11px] text-slate-500">
          Live from the backend container (5s refresh). Memory & disk are
          cgroup-aware — they reflect the container's limits, not the host.
        </p>
      </div>
    </Card>
  );
}


function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4">
      <div className="text-[10px] uppercase tracking-wider text-slate-400">
        {label}
      </div>
      <div className="text-2xl font-semibold text-white mt-1">{value}</div>
    </div>
  );
}


function Card({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white/5 backdrop-blur-sm border border-white/15 rounded-lg p-4">
      {title && (
        <h2 className="text-xs uppercase tracking-wider text-slate-400 mb-3">
          {title}
        </h2>
      )}
      {children}
    </div>
  );
}


function BarList({
  items,
  linkBuilder,
}: {
  items: TypeCount[];
  // Build a destination URL from the row. When provided, each row
  // renders as a Link so users can click through to inspect those
  // events in the inbox.
  linkBuilder?: (item: TypeCount) => string;
}) {
  if (items.length === 0)
    return <div className="text-sm text-slate-500">No data yet.</div>;
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <ul className="space-y-1">
      {items.map((i) => {
        const body = (
          <>
            <div className="flex justify-between text-xs text-slate-300">
              <span className="truncate">{i.label}</span>
              <span className="text-slate-400 ml-2">
                {i.count.toLocaleString()}
              </span>
            </div>
            <div className="h-1.5 bg-white/5 rounded mt-1 overflow-hidden">
              <div
                className="h-full bg-sky-500/70"
                style={{ width: `${(i.count / max) * 100}%` }}
              />
            </div>
          </>
        );
        return (
          <li key={`${i.label_source ?? ""}:${i.label}`} className="text-sm">
            {linkBuilder ? (
              <Link
                to={linkBuilder(i)}
                className="block hover:bg-white/5 rounded -mx-2 px-2 py-1 transition-colors"
                title="Open these events in the Webhook Inbox"
              >
                {body}
              </Link>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}


// ---- Settings card ----
//
// Retention knobs for the cleanup cron. Each row reflects one
// app_settings key; 0 means "keep forever / unlimited". The cron picks
// up changes on its next tick (settings_store has a 30-second cache).

function RetentionSettingsCard() {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<SettingsResponse>("/api/settings"),
  });
  if (!settings.data) {
    return (
      <Card title="Retention">
        <div className="text-sm text-slate-500">Loading…</div>
      </Card>
    );
  }
  return (
    <Card title="Retention">
      <p className="text-xs text-slate-400 mb-4">
        How long captured data stays before the hourly cleanup cron sweeps it.
        Set any row to <code className="font-mono text-slate-300">0</code> to
        keep forever. Changes apply on the next cron tick (within ~30 seconds).
      </p>
      <div className="space-y-3">
        {settings.data.items.map((row) => (
          <SettingEditor key={row.key} row={row} />
        ))}
      </div>
    </Card>
  );
}


function SettingEditor({ row }: { row: SettingRow }) {
  const qc = useQueryClient();
  const [value, setValue] = useState<string>(row.value ?? row.default);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // If another tab edits the setting, refresh the local input.
  useEffect(() => {
    setValue(row.value ?? row.default);
  }, [row.value, row.default]);

  const save = useMutation({
    mutationFn: (next: string) =>
      apiPut<SettingRow>(`/api/settings/${row.key}`, { value: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      setSavedAt(Date.now());
      window.setTimeout(() => setSavedAt(null), 1500);
    },
  });

  const isUnlimited = value === "0" || value === "";
  const isDirty = value !== (row.value ?? row.default);

  return (
    <div className="border border-white/10 rounded-md p-3 bg-white/5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-200">{row.label}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {row.description}
          </div>
        </div>
        <div className="text-[10px] text-slate-500 uppercase tracking-wider shrink-0">
          default {row.default} {row.unit}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <input
          type="number"
          min={0}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-24 px-2 py-1.5 rounded bg-slate-950 border border-white/15 text-sm font-mono"
        />
        <span className="text-xs text-slate-400">{row.unit}</span>
        {isUnlimited && row.allow_zero && (
          <span className="text-[10px] text-amber-300 bg-amber-950/40 border border-amber-900/50 rounded px-1.5 py-0.5">
            unlimited — never deleted
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setValue(row.default)}
          className="text-xs px-2 py-1 rounded border border-white/15 text-slate-400 hover:text-slate-200 hover:border-white/30"
          disabled={value === row.default}
          title="Reset to default"
        >
          reset
        </button>
        <button
          onClick={() => save.mutate(value)}
          disabled={!isDirty || save.isPending}
          className="text-xs px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {save.isPending ? "Saving…" : savedAt ? "Saved ✓" : "Save"}
        </button>
      </div>
      {save.isError && (
        <div className="text-xs text-rose-300 mt-2">
          {(save.error as Error).message}
        </div>
      )}
    </div>
  );
}
