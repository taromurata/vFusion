import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import {
  apiDelete,
  apiGet,
  API_BASE,
  Family,
  PublicConfig,
  WebhookAsset,
  WebhookEvent,
  WebhookEventListResponse,
} from "../lib/api";
import JsonView from "../components/JsonView";
import { FamilyBadge, SignatureBadge } from "../components/Badges";
import PendingSetupBanner from "../components/PendingSetupBanner";
import { useCameraLookup } from "../lib/cameras";

const methodColor: Record<string, string> = {
  GET: "bg-sky-900 text-sky-200",
  POST: "bg-emerald-900 text-emerald-200",
  PUT: "bg-amber-900 text-amber-200",
  PATCH: "bg-violet-900 text-violet-200",
  DELETE: "bg-rose-900 text-rose-200",
};

const FAMILIES: Family[] = [
  "camera",
  "access",
  "lpr",
  "sensor",
  "intercom",
  "unknown",
];

const PAGE_SIZE = 100;
const MAX_LIMIT = 200; // backend caps individual requests at this

export default function WebhookInbox() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Seed filters from the URL once (e.g. when arriving from a Stats bar
  // click: /inbox?family=unknown or /inbox?notification_type=__null__).
  // After consuming we strip the params so subsequent edits don't fight
  // a stale URL source. The notification_type filter is sent through to
  // the backend as a separate query — "__null__" is the sentinel for
  // "notification_type IS NULL", the Stats page's "(unknown)" bucket.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [familyFilter, setFamilyFilter] = useState<Family | "">(
    (searchParams.get("family") as Family | null) ?? "",
  );
  const [notificationTypeFilter, setNotificationTypeFilter] = useState<string>(
    searchParams.get("notification_type") ?? "",
  );
  const [webhookTypeFilter, setWebhookTypeFilter] = useState<string>(
    searchParams.get("webhook_type") ?? "",
  );
  const [pageCount, setPageCount] = useState(1);
  const qc = useQueryClient();
  useEffect(() => {
    if (
      searchParams.get("family") ||
      searchParams.get("notification_type") ||
      searchParams.get("webhook_type")
    ) {
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce the search input so we don't fire a query every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset to the first page whenever a filter changes.
  useEffect(() => {
    setPageCount(1);
  }, [debouncedSearch, familyFilter, notificationTypeFilter, webhookTypeFilter]);

  const limit = Math.min(pageCount * PAGE_SIZE, MAX_LIMIT);
  const list = useQuery({
    queryKey: [
      "webhook-events",
      debouncedSearch,
      familyFilter,
      notificationTypeFilter,
      webhookTypeFilter,
      limit,
    ],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (familyFilter) params.set("family", familyFilter);
      if (notificationTypeFilter)
        params.set("notification_type", notificationTypeFilter);
      if (webhookTypeFilter) params.set("webhook_type", webhookTypeFilter);
      return apiGet<WebhookEventListResponse>(
        `/api/webhook-events?${params.toString()}`
      );
    },
    refetchInterval: 2000,
  });

  const detail = useQuery({
    queryKey: ["webhook-event", selectedId],
    queryFn: () => apiGet<WebhookEvent>(`/api/webhook-events/${selectedId}`),
    enabled: selectedId !== null,
  });

  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/webhook-events/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["webhook-events"] });
      setSelectedId(null);
    },
  });

  const items = list.data?.items ?? [];
  const unknownCount = list.data?.unknown_count ?? 0;
  const total = list.data?.total ?? 0;
  const canLoadMore = items.length < total && limit < MAX_LIMIT;

  return (
    <div className="h-full flex flex-col gap-4 min-h-0">
      <div>
        <h1 className="text-2xl font-semibold text-white">Webhook Inbox</h1>
        <p className="text-slate-400 text-sm mt-1">
          Every request to{" "}
          <code className="bg-slate-800 px-1.5 py-0.5 rounded text-slate-200">
            {API_BASE}/hooks/&lt;anything&gt;
          </code>{" "}
          is captured, classified, and signature-checked.
        </p>
      </div>

      <WebhookEndpointBanner />

      <PendingSetupBanner />

      {unknownCount > 0 && (
        <Link
          to="/unrecognized"
          className="block bg-rose-950/50 border border-rose-900 hover:bg-rose-950 rounded-lg px-4 py-3 transition-colors"
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="text-rose-200 font-medium text-sm">
                ⚠ {unknownCount} unrecognized event{unknownCount === 1 ? "" : "s"}
              </div>
              <div className="text-rose-300/70 text-xs mt-0.5">
                Webhook variants not yet in the taxonomy. Click to review.
              </div>
            </div>
            <span className="text-rose-300 text-sm">→</span>
          </div>
        </Link>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[12rem] max-w-md">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder='search body, slug, notification_type, camera / door name — e.g. "Front Door"'
            className="w-full px-3 py-1.5 rounded-md bg-slate-900 border border-slate-700 text-sm focus:outline-none focus:border-sky-600"
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200 text-sm"
              aria-label="clear search"
            >
              ×
            </button>
          )}
        </div>
        <select
          value={familyFilter}
          onChange={(e) => setFamilyFilter(e.target.value as Family | "")}
          className="px-3 py-1.5 rounded-md bg-slate-900 border border-slate-700 text-sm focus:outline-none focus:border-sky-600"
        >
          <option value="">All families</option>
          {FAMILIES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        {notificationTypeFilter && (
          <span className="flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-sky-950/40 border border-sky-700 text-sky-200">
            type:{" "}
            <code className="font-mono">
              {notificationTypeFilter === "__null__"
                ? "(none)"
                : notificationTypeFilter}
            </code>
            <button
              onClick={() => setNotificationTypeFilter("")}
              className="text-slate-400 hover:text-white"
              aria-label="clear notification_type filter"
            >
              ×
            </button>
          </span>
        )}
        {webhookTypeFilter && (
          <span className="flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-sky-950/40 border border-sky-700 text-sky-200">
            webhook_type:{" "}
            <code className="font-mono">{webhookTypeFilter}</code>
            <button
              onClick={() => setWebhookTypeFilter("")}
              className="text-slate-400 hover:text-white"
              aria-label="clear webhook_type filter"
            >
              ×
            </button>
          </span>
        )}
        <span className="text-xs text-slate-500">
          {list.data?.total ?? 0} match{(list.data?.total ?? 0) === 1 ? "" : "es"} • auto-refresh 2s
        </span>
      </div>

      <div className="grid grid-cols-12 gap-4 flex-1 min-h-0">
        <div className="col-span-5 border border-slate-800 rounded-lg overflow-hidden bg-slate-900/50 flex flex-col min-h-0">
          {items.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="divide-y divide-slate-800 overflow-y-auto flex-1">
              {items.map((e) => (
                <li
                  key={e.id}
                  onClick={() => setSelectedId(e.id)}
                  className={`px-3 py-2 cursor-pointer text-sm transition-colors ${
                    selectedId === e.id
                      ? "bg-slate-800"
                      : "hover:bg-slate-800/50"
                  }`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        methodColor[e.method] ?? "bg-slate-800 text-slate-200"
                      }`}
                    >
                      {e.method}
                    </span>
                    <FamilyBadge family={e.family} />
                    <span className="text-[11px] font-mono text-slate-300 truncate">
                      {e.notification_type || e.webhook_type || "—"}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1 flex justify-between">
                    <span>{formatTime(e.received_at)}</span>
                    <span>{formatSize(e.body_size)}</span>
                  </div>
                </li>
              ))}
              {canLoadMore && (
                <li className="px-3 py-2 bg-slate-900/40">
                  <button
                    onClick={() => setPageCount((n) => n + 1)}
                    disabled={list.isFetching}
                    className="w-full text-xs px-2 py-1 rounded border border-slate-700 text-slate-300 hover:border-sky-600 disabled:opacity-50"
                  >
                    {list.isFetching
                      ? "Loading…"
                      : `Load older  (${items.length} / ${total})`}
                  </button>
                </li>
              )}
              {!canLoadMore && items.length >= MAX_LIMIT && items.length < total && (
                <li className="px-3 py-2 text-[10px] text-slate-500 text-center">
                  Showing newest {MAX_LIMIT}. Use search or family filter to narrow
                  older results.
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="col-span-7 border border-slate-800 rounded-lg bg-slate-900/50 overflow-hidden flex flex-col min-h-0">
          {detail.data ? (
            <EventDetail
              event={detail.data}
              onDelete={() => del.mutate(detail.data.id)}
            />
          ) : (
            <div className="p-6 text-sm text-slate-500">
              Select an event to view headers and body.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WebhookEndpointBanner() {
  // Quick mode's hostname can take a few seconds to settle after
  // cloudflared starts, so refetch periodically until we get one. Once
  // resolved, refresh every minute in case the operator restarts the
  // tunnel and the URL shifts under us.
  const cfg = useQuery({
    queryKey: ["public-config"],
    queryFn: () => apiGet<PublicConfig>("/api/config"),
    // Poll fast while we don't yet have a URL — covers both "page loaded
    // while cloudflared is still registering" and the genuine quick-mode
    // warmup. Once we have a URL, back off to every 30s in case the
    // operator restarts the tunnel and the URL shifts.
    refetchInterval: (q) =>
      q.state.data?.public_webhook_base ? 30_000 : 2000,
  });
  const [copied, setCopied] = useState(false);
  if (!cfg.data) return null;
  const mode = cfg.data.tunnel_mode;
  if (mode === "lan") {
    return (
      <div className="bg-slate-900/50 border border-white/10 rounded-lg px-4 py-3 text-xs text-slate-400">
        Running in <span className="font-semibold text-slate-200">LAN-only</span> mode —
        webhooks from Verkada's cloud can't reach this server. To accept real webhooks,
        bring up the stack with <code className="bg-slate-800 px-1 py-0.5 rounded text-slate-200">--profile quick</code> (ephemeral URL)
        or <code className="bg-slate-800 px-1 py-0.5 rounded text-slate-200">--profile cloudflared</code> (stable URL on your domain).
      </div>
    );
  }
  const url = cfg.data.public_webhook_base
    ? `${cfg.data.public_webhook_base}/hooks/verkada`
    : null;
  const ephemeral = cfg.data.ephemeral;
  const accent = ephemeral
    ? "bg-amber-950/40 border-amber-900"
    : "bg-emerald-950/40 border-emerald-900";
  const accentText = ephemeral ? "text-amber-200" : "text-emerald-200";
  const copy = () => {
    if (!url) return;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className={`${accent} border rounded-lg px-4 py-3`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className={`text-xs font-semibold ${accentText}`}>
            Public webhook URL{ephemeral ? " — quick mode" : ""}
          </div>
          {url ? (
            <code className="font-mono text-sm text-slate-100 break-all">
              {url}
            </code>
          ) : (
            <div className="text-xs text-slate-400 italic">
              Waiting for cloudflared to come online…
            </div>
          )}
        </div>
        {url && (
          <button
            onClick={copy}
            className="shrink-0 text-xs px-2 py-1 rounded border border-white/15 bg-white/5 hover:bg-white/10 text-slate-200"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {ephemeral && (
        <div className="text-[11px] text-amber-300/80 mt-1.5">
          ⚠ Quick-mode URL changes every time cloudflared restarts. Fine for
          kicking the tires — for production, set up a named tunnel on your
          own domain (see README).
        </div>
      )}
    </div>
  );
}


function EmptyState() {
  return (
    <div className="p-6 text-sm text-slate-400 space-y-3">
      <p className="font-medium text-slate-200">Waiting for your first webhook…</p>
      <p>
        Point a Verkada webhook at{" "}
        <code className="bg-slate-800 px-1 rounded text-slate-100">
          {API_BASE}/hooks/verkada
        </code>{" "}
        (or any slug you want). When the first one arrives, vSplice will auto-detect
        your org and prompt you to enter your API key.
      </p>
      <p className="text-xs text-slate-500">Smoke-test it locally if you want:</p>
      <pre className="p-2 bg-slate-950 rounded text-xs overflow-x-auto text-slate-300">
        {`curl -X POST ${API_BASE}/hooks/test \\
  -H "Content-Type: application/json" \\
  -d '{"hello":"world"}'`}
      </pre>
    </div>
  );
}

function EventDetail({
  event,
  onDelete,
}: {
  event: WebhookEvent;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const cameras = useCameraLookup();
  const cameraId =
    event.body_json &&
    typeof event.body_json === "object" &&
    !Array.isArray(event.body_json) &&
    typeof (event.body_json as Record<string, unknown>).data === "object"
      ? ((event.body_json as Record<string, Record<string, unknown>>).data
          ?.camera_id as string | undefined)
      : undefined;
  const cameraInfo = cameraId ? cameras.get(cameraId) : undefined;
  const bodyView = useMemo(() => {
    if (event.body_json !== null && event.body_json !== undefined) {
      return <JsonView value={event.body_json} />;
    }
    if (event.body_text) {
      return (
        <pre className="font-mono text-xs whitespace-pre-wrap break-all text-slate-300">
          {event.body_text}
        </pre>
      );
    }
    return <span className="text-slate-500 text-sm">(empty body)</span>;
  }, [event]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                methodColor[event.method] ?? "bg-slate-800 text-slate-200"
              }`}
            >
              {event.method}
            </span>
            <FamilyBadge family={event.family} />
            {(event.notification_type || event.webhook_type) && (
              <span className="text-[11px] font-mono text-slate-300">
                {event.notification_type || event.webhook_type}
              </span>
            )}
            <SignatureBadge status={event.signature_status} />
          </div>
          <div className="font-mono text-sm text-slate-100 truncate mt-1">
            {event.path}
            {event.query_string ? `?${event.query_string}` : ""}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {formatTime(event.received_at)} • {formatSize(event.body_size)} • from{" "}
            {event.remote_addr ?? "unknown"}
            {event.org_id && (
              <>
                {" • org "}
                <span className="font-mono">{event.org_id.slice(0, 8)}…</span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1.5 shrink-0">
          {event.family && event.family !== "unknown" && (
            <button
              onClick={() => navigate(`/flows?from_event=${event.id}`)}
              className="text-xs px-2 py-1 rounded bg-sky-700 hover:bg-sky-600 text-white whitespace-nowrap"
            >
              + Create flow
            </button>
          )}
          <button
            onClick={onDelete}
            className="text-xs px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-rose-300 hover:border-rose-800"
          >
            Delete
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {cameraInfo && (
          <Section title="Camera">
            <div className="text-sm">
              <span className="text-slate-100 font-medium">{cameraInfo.name ?? "(unnamed)"}</span>
              {cameraInfo.site && (
                <span className="text-slate-500"> — {cameraInfo.site}</span>
              )}
              {cameraInfo.model && (
                <span className="text-slate-500"> · {cameraInfo.model}</span>
              )}
              <div className="text-xs font-mono text-slate-500 mt-1">{cameraId}</div>
            </div>
          </Section>
        )}
        <Section
          title={`Headers (${Object.keys(event.headers).length})`}
          collapsible
          defaultOpen={false}
        >
          <table className="text-xs font-mono">
            <tbody>
              {Object.entries(event.headers).map(([k, v]) => (
                <tr key={k} className="align-top">
                  <td className="text-sky-400 pr-3 py-0.5">{k}</td>
                  <td className="text-slate-200 py-0.5 break-all">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="Body">
          <div className="bg-slate-950 rounded p-3 overflow-x-auto">{bodyView}</div>
        </Section>

        <AssetGallery eventId={event.id} />
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  collapsible,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!collapsible) {
    return (
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
          {title}
        </h3>
        {children}
      </div>
    );
  }
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300 mb-2"
      >
        <span className="w-3 inline-block">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && children}
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}


function AssetGallery({ eventId }: { eventId: string }) {
  // Verkada signs the source URLs for a short window — we download
  // them server-side immediately and serve them back via /assets/{id}/file.
  // Status flips from "pending" → "ready" (or "failed") within a second or
  // two of the webhook landing, so poll while anything's still pending.
  const assets = useQuery({
    queryKey: ["webhook-assets", eventId],
    queryFn: () => apiGet<WebhookAsset[]>(`/api/webhook-events/${eventId}/assets`),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((a) => a.status === "pending") ? 1500 : false,
  });
  const list = assets.data ?? [];
  if (list.length === 0) return null;
  return (
    <Section title={`Media (${list.length})`}>
      <div className="grid grid-cols-2 gap-2">
        {list.map((a) => (
          <AssetTile key={a.id} asset={a} />
        ))}
      </div>
    </Section>
  );
}


function AssetTile({ asset }: { asset: WebhookAsset }) {
  const fileUrl = `${API_BASE}/api/webhook-events/assets/${asset.id}/file`;
  const isImage =
    !asset.content_type || asset.content_type.startsWith("image/");
  return (
    <div className="border border-slate-800 rounded overflow-hidden bg-slate-950">
      <div className="aspect-video bg-black flex items-center justify-center overflow-hidden">
        {asset.status === "ready" && isImage ? (
          <a href={fileUrl} target="_blank" rel="noreferrer">
            <img
              src={fileUrl}
              alt={asset.source_field}
              className="w-full h-full object-contain"
              loading="lazy"
            />
          </a>
        ) : asset.status === "ready" ? (
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-sky-300 underline"
          >
            Open ({asset.content_type})
          </a>
        ) : asset.status === "pending" ? (
          <span className="text-xs text-slate-500">downloading…</span>
        ) : (
          <span
            className="text-xs text-rose-300 px-2 text-center"
            title={asset.error ?? "download failed"}
          >
            ✗ failed
          </span>
        )}
      </div>
      <div className="px-2 py-1 text-[10px] text-slate-500 flex items-center justify-between">
        <span className="font-mono truncate" title={asset.source_field}>
          {asset.source_field}
        </span>
        {asset.file_size != null && (
          <span>
            {asset.file_size < 1024
              ? `${asset.file_size} B`
              : asset.file_size < 1024 * 1024
                ? `${(asset.file_size / 1024).toFixed(0)} KB`
                : `${(asset.file_size / 1024 / 1024).toFixed(1)} MB`}
          </span>
        )}
      </div>
    </div>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
