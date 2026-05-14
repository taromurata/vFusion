import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiGet,
  apiPost,
  ApiEndpoint,
  ApiEndpointDetail,
  ApiEndpointList,
  ApiSpec,
} from "../lib/api";
import JsonView from "../components/JsonView";
import { useBrand } from "../lib/brand";

const METHOD_STYLE: Record<string, string> = {
  GET: "bg-sky-900 text-sky-200",
  POST: "bg-emerald-900 text-emerald-200",
  PUT: "bg-amber-900 text-amber-200",
  PATCH: "bg-violet-900 text-violet-200",
  DELETE: "bg-rose-900 text-rose-200",
};

export default function ApiCatalog() {
  const qc = useQueryClient();
  const brand = useBrand();
  const [namespace, setNamespace] = useState<string>("");
  const [search, setSearch] = useState("");
  const [recentOnly, setRecentOnly] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const specs = useQuery({
    queryKey: ["api-specs"],
    queryFn: () => apiGet<ApiSpec[]>("/api/verkada/catalog/specs"),
    refetchInterval: 30_000,
  });

  const endpoints = useQuery({
    queryKey: ["api-endpoints", namespace, debouncedSearch, recentOnly, showDeleted],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "500" });
      if (namespace) params.set("namespace", namespace);
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (recentOnly) params.set("changed_since_days", "7");
      if (showDeleted) params.set("include_deleted", "true");
      return apiGet<ApiEndpointList>(
        `/api/verkada/catalog/endpoints?${params.toString()}`
      );
    },
  });

  const detail = useQuery({
    queryKey: ["api-endpoint", selectedId],
    queryFn: () =>
      apiGet<ApiEndpointDetail>(`/api/verkada/catalog/endpoints/${selectedId}`),
    enabled: selectedId !== null,
  });

  const crawlNow = useMutation({
    mutationFn: () => apiPost<unknown[]>("/api/verkada/catalog/crawl", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api-specs"] });
      qc.invalidateQueries({ queryKey: ["api-endpoints"] });
    },
  });

  const items = endpoints.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">API Catalog</h1>
          <p className="text-slate-400 text-sm mt-1">
            {brand} fetches every Verkada OpenAPI spec every 4 hours and
            tracks added / changed / removed endpoints. This is your source of
            truth for what the Verkada API can do today.
          </p>
        </div>
        <button
          onClick={() => crawlNow.mutate()}
          disabled={crawlNow.isPending}
          className="shrink-0 text-xs px-3 py-1.5 rounded border border-slate-700 hover:border-sky-600 disabled:opacity-50"
        >
          {crawlNow.isPending ? "Crawling…" : "Crawl now"}
        </button>
      </div>

      <SpecsBar specs={specs.data ?? []} selected={namespace} onSelect={setNamespace} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[16rem] max-w-md">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search path, summary, operation_id"
            className="w-full px-3 py-1.5 rounded-md bg-slate-900 border border-slate-700 text-sm focus:outline-none focus:border-sky-600"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200 text-sm"
            >
              ×
            </button>
          )}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={recentOnly}
            onChange={(e) => setRecentOnly(e.target.checked)}
          />
          Changed in last 7d
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
          />
          Show removed
        </label>
        <span className="text-xs text-slate-500 ml-auto">
          {endpoints.data?.total ?? 0} endpoint
          {(endpoints.data?.total ?? 0) === 1 ? "" : "s"}
        </span>
      </div>

      {/* Two-pane layout: the left endpoint tree scrolls naturally with the
          page (it's tall — hundreds of operations) while the right detail
          panel is sticky-pinned to the top of the viewport and scrolls
          internally. So no matter how far you scroll the left list before
          clicking, the picked endpoint's docs always render in view. */}
      <div className="grid grid-cols-12 gap-4 min-h-[60vh] items-start">
        <div className="col-span-5 border border-slate-800 rounded-lg overflow-hidden bg-slate-900/50">
          {endpoints.isLoading ? (
            <div className="p-6 text-sm text-slate-500">Loading…</div>
          ) : items.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">
              {specs.data && specs.data.length === 0
                ? 'No specs crawled yet. Click "Crawl now" to fetch them.'
                : "No endpoints match."}
            </div>
          ) : (
            <EndpointTree
              items={items}
              groupByNamespace={!namespace}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>

        <div className="col-span-7 sticky top-16 max-h-[calc(100vh-5rem)] border border-slate-800 rounded-lg bg-slate-900/50 overflow-hidden flex flex-col">
          {detail.data ? (
            <EndpointDetailView detail={detail.data} />
          ) : (
            <div className="p-6 text-sm text-slate-500">
              Select an endpoint to view its full OpenAPI operation object.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SpecsBar({
  specs,
  selected,
  onSelect,
}: {
  specs: ApiSpec[];
  selected: string;
  onSelect: (ns: string) => void;
}) {
  if (specs.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={() => onSelect("")}
        className={`text-xs px-2.5 py-1 rounded-md border ${
          selected === ""
            ? "border-sky-600 bg-sky-950/50 text-sky-200"
            : "border-slate-700 text-slate-400 hover:border-slate-500"
        }`}
      >
        All
      </button>
      {specs.map((s) => (
        <button
          key={s.id}
          onClick={() => onSelect(s.namespace)}
          title={
            s.fetch_status === "error"
              ? `Last fetch failed: ${s.fetch_error}`
              : s.last_fetched_at
                ? `Last fetched ${new Date(s.last_fetched_at).toLocaleString()}`
                : "Not yet fetched"
          }
          className={`text-xs px-2.5 py-1 rounded-md border flex items-center gap-1.5 ${
            selected === s.namespace
              ? "border-sky-600 bg-sky-950/50 text-sky-200"
              : s.fetch_status === "error"
                ? "border-rose-900 text-rose-300 hover:border-rose-700"
                : "border-slate-700 text-slate-300 hover:border-slate-500"
          }`}
        >
          <span>{s.namespace}</span>
          <span className="text-slate-500">{s.endpoint_count}</span>
        </button>
      ))}
    </div>
  );
}

function EndpointTree({
  items,
  groupByNamespace,
  selectedId,
  onSelect,
}: {
  items: ApiEndpoint[];
  groupByNamespace: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // Group items by (namespace?, tag). Tag defaults to "(untagged)".
  type Bucket = { key: string; label: string; items: ApiEndpoint[] };
  const groups: Array<{ namespace: string | null; tags: Bucket[] }> = [];
  const byNs = new Map<string, Map<string, ApiEndpoint[]>>();
  for (const e of items) {
    const ns = groupByNamespace ? e.namespace : "";
    const tag = e.tags && e.tags.length > 0 ? e.tags[0] : "(untagged)";
    if (!byNs.has(ns)) byNs.set(ns, new Map());
    const tagMap = byNs.get(ns)!;
    if (!tagMap.has(tag)) tagMap.set(tag, []);
    tagMap.get(tag)!.push(e);
  }
  for (const [ns, tagMap] of [...byNs.entries()].sort()) {
    const tags: Bucket[] = [...tagMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, list]) => ({
        key: `${ns}::${tag}`,
        label: tag,
        items: list.sort((a, b) => a.path.localeCompare(b.path)),
      }));
    groups.push({ namespace: groupByNamespace ? ns : null, tags });
  }

  return (
    <div className="divide-y divide-slate-800">
      {groups.map((g, gi) => (
        <div key={gi}>
          {g.namespace && (
            <div className="px-3 py-1.5 bg-slate-900/80 text-[10px] font-bold uppercase tracking-wider text-slate-400 sticky top-0">
              {g.namespace}
            </div>
          )}
          {g.tags.map((bucket) => (
            <TagGroup
              key={bucket.key}
              label={bucket.label}
              items={bucket.items}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function TagGroup({
  label,
  items,
  selectedId,
  onSelect,
}: {
  label: string;
  items: ApiEndpoint[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // Default collapsed so a fresh page load doesn't drop hundreds of
  // endpoints on the user — they expand the tags they care about.
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-1.5 flex items-center justify-between bg-slate-900/40 hover:bg-slate-800/50 text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
          <span className="text-slate-500 w-3 inline-block">{open ? "▾" : "▸"}</span>{" "}
          {label}
        </span>
        <span className="text-[10px] text-slate-500">{items.length}</span>
      </button>
      {open && (
        <ul className="divide-y divide-slate-800/50">
          {items.map((e) => (
            <EndpointRow
              key={e.id}
              e={e}
              selected={selectedId === e.id}
              onClick={() => onSelect(e.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function EndpointRow({
  e,
  selected,
  onClick,
}: {
  e: ApiEndpoint;
  selected: boolean;
  onClick: () => void;
}) {
  const ageMs = Date.now() - new Date(e.last_changed_at).getTime();
  const dayMs = 24 * 3600 * 1000;
  const isNew = Date.now() - new Date(e.first_seen_at).getTime() < 7 * dayMs;
  const isRecentlyChanged = !isNew && ageMs < 7 * dayMs;
  const label = e.summary || e.operation_id || e.path;
  return (
    <li
      onClick={onClick}
      className={`px-3 py-2 cursor-pointer text-sm transition-colors ${
        selected ? "bg-slate-800" : "hover:bg-slate-800/50"
      }`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
            METHOD_STYLE[e.method] ?? "bg-slate-800 text-slate-200"
          }`}
        >
          {e.method}
        </span>
        <span className="text-slate-100 truncate">{label}</span>
        {e.docs_url && (
          <a
            href={e.docs_url}
            target="_blank"
            rel="noreferrer"
            onClick={(ev) => ev.stopPropagation()}
            title="Open Verkada docs for this endpoint"
            className="text-[10px] text-sky-300 hover:text-sky-200 hover:underline shrink-0"
          >
            docs ↗
          </a>
        )}
        {e.deleted_at && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-900 text-rose-200">
            REMOVED
          </span>
        )}
        {!e.deleted_at && isNew && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-900 text-emerald-200">
            NEW
          </span>
        )}
        {!e.deleted_at && isRecentlyChanged && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-900 text-amber-200">
            CHANGED
          </span>
        )}
      </div>
    </li>
  );
}

function EndpointDetailView({ detail }: { detail: ApiEndpointDetail }) {
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
              METHOD_STYLE[detail.method] ?? "bg-slate-800 text-slate-200"
            }`}
          >
            {detail.method}
          </span>
          <span className="font-mono text-sm text-slate-100">{detail.path}</span>
          {detail.docs_url && (
            <a
              href={detail.docs_url}
              target="_blank"
              rel="noreferrer"
              className="ml-auto text-xs text-sky-300 hover:text-sky-200 hover:underline"
              title="Open this endpoint's Verkada docs page"
            >
              docs ↗
            </a>
          )}
        </div>
        <div className="text-sm text-slate-300 mt-1">{detail.summary ?? ""}</div>
        <div className="text-xs text-slate-500 mt-1">
          {detail.namespace}
          {detail.operation_id && (
            <>
              {" · "}
              <code>{detail.operation_id}</code>
            </>
          )}
          {detail.tags && detail.tags.length > 0 && (
            <>
              {" · "}
              {detail.tags.join(", ")}
            </>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-5">
        {detail.description && (
          <Section title="Description">
            <p className="text-sm text-slate-300 whitespace-pre-wrap">
              {detail.description}
            </p>
          </Section>
        )}
        <OperationBody raw={detail.raw} />
        <details>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300">
            Raw OpenAPI operation
          </summary>
          <div className="mt-2 bg-slate-950 rounded p-3 overflow-x-auto">
            <JsonView value={detail.raw} />
          </div>
        </details>
      </div>
    </div>
  );
}


// ---- Structured operation renderer ---------------------------------------
//
// Reads a $ref-resolved OpenAPI operation object and renders the bits a
// human cares about — parameters by location, request body schema,
// responses by status code — as tables and labeled blocks rather than
// raw JSON. Matches the shape of Verkada's docs site closely enough to
// be usable as the primary reference without leaving the app.

interface OpenAPIParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: Schema;
  example?: unknown;
}


interface Schema {
  type?: string;
  format?: string;
  description?: string;
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  example?: unknown;
  default?: unknown;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  $ref?: string;
  _recursive?: boolean;
}


function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}


function OperationBody({ raw }: { raw: unknown }) {
  if (!raw || typeof raw !== "object") return null;
  const op = raw as Record<string, unknown>;
  const params = Array.isArray(op.parameters) ? (op.parameters as OpenAPIParameter[]) : [];
  const byIn = {
    path: params.filter((p) => p.in === "path"),
    query: params.filter((p) => p.in === "query"),
    header: params.filter((p) => p.in === "header"),
  };
  const body = op.requestBody as
    | { description?: string; required?: boolean; content?: Record<string, { schema?: Schema; example?: unknown }> }
    | undefined;
  const responses = (op.responses ?? {}) as Record<
    string,
    { description?: string; content?: Record<string, { schema?: Schema; example?: unknown }> }
  >;
  return (
    <div className="space-y-5">
      {byIn.path.length > 0 && (
        <Section title="Path parameters">
          <ParamTable params={byIn.path} />
        </Section>
      )}
      {byIn.query.length > 0 && (
        <Section title="Query parameters">
          <ParamTable params={byIn.query} />
        </Section>
      )}
      {byIn.header.length > 0 && (
        <Section title="Headers">
          <ParamTable params={byIn.header} />
        </Section>
      )}
      {body && (
        <Section
          title={`Request body${body.required ? " (required)" : ""}`}
        >
          {body.description && (
            <p className="text-xs text-slate-400 mb-2">{body.description}</p>
          )}
          {Object.entries(body.content ?? {}).map(([ct, c]) => (
            <ContentBlock key={ct} contentType={ct} schema={c.schema} example={c.example} />
          ))}
        </Section>
      )}
      {Object.keys(responses).length > 0 && (
        <Section title="Responses">
          <div className="space-y-3">
            {Object.entries(responses)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([code, r]) => (
                <ResponseBlock key={code} code={code} response={r} />
              ))}
          </div>
        </Section>
      )}
    </div>
  );
}


function ParamTable({ params }: { params: OpenAPIParameter[] }) {
  return (
    <div className="overflow-x-auto rounded border border-white/10">
      <table className="w-full text-xs">
        <thead className="bg-white/5 text-slate-400 uppercase tracking-wider">
          <tr>
            <th className="text-left px-2 py-1.5 font-medium">Name</th>
            <th className="text-left px-2 py-1.5 font-medium">Type</th>
            <th className="text-left px-2 py-1.5 font-medium">Required</th>
            <th className="text-left px-2 py-1.5 font-medium">Description</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {params.map((p) => (
            <tr key={p.name}>
              <td className="px-2 py-1.5 font-mono text-slate-100 align-top">
                {p.name}
              </td>
              <td className="px-2 py-1.5 text-slate-300 align-top">
                {schemaShortType(p.schema)}
              </td>
              <td className="px-2 py-1.5 align-top">
                {p.required ? (
                  <span className="text-rose-300">yes</span>
                ) : (
                  <span className="text-slate-500">no</span>
                )}
              </td>
              <td className="px-2 py-1.5 text-slate-300 align-top whitespace-pre-wrap">
                {p.description ?? ""}
                {p.schema?.enum && (
                  <div className="mt-1 text-[10px] text-slate-400">
                    one of:{" "}
                    {p.schema.enum
                      .map((v) => JSON.stringify(v))
                      .join(", ")}
                  </div>
                )}
                {p.example !== undefined && (
                  <div className="mt-1 text-[10px] text-slate-500 font-mono">
                    e.g. {JSON.stringify(p.example)}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


function ContentBlock({
  contentType,
  schema,
  example,
}: {
  contentType: string;
  schema?: Schema;
  example?: unknown;
}) {
  return (
    <div className="border border-white/10 rounded">
      <div className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-slate-400 bg-white/5">
        {contentType}
      </div>
      <div className="p-2">
        {schema ? (
          <SchemaTable schema={schema} />
        ) : (
          <div className="text-xs text-slate-500">no schema declared</div>
        )}
        {example !== undefined && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-200">
              Example
            </summary>
            <pre className="mt-1 bg-slate-950 rounded p-2 text-[11px] font-mono whitespace-pre-wrap break-words text-slate-300">
              {typeof example === "string"
                ? example
                : JSON.stringify(example, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}


function ResponseBlock({
  code,
  response,
}: {
  code: string;
  response: { description?: string; content?: Record<string, { schema?: Schema; example?: unknown }> };
}) {
  const okish = code.startsWith("2");
  const errish = code.startsWith("4") || code.startsWith("5");
  return (
    <div className="border border-white/10 rounded">
      <div className="px-2 py-1.5 flex items-center gap-2 bg-white/5">
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            okish
              ? "bg-emerald-900/60 text-emerald-200"
              : errish
                ? "bg-rose-900/60 text-rose-200"
                : "bg-slate-800 text-slate-300"
          }`}
        >
          {code}
        </span>
        {response.description && (
          <span className="text-xs text-slate-300">{response.description}</span>
        )}
      </div>
      <div className="p-2 space-y-2">
        {Object.entries(response.content ?? {}).map(([ct, c]) => (
          <ContentBlock
            key={ct}
            contentType={ct}
            schema={c.schema}
            example={c.example}
          />
        ))}
        {Object.keys(response.content ?? {}).length === 0 && (
          <div className="text-xs text-slate-500">no body</div>
        )}
      </div>
    </div>
  );
}


function SchemaTable({
  schema,
  depth = 0,
}: {
  schema: Schema;
  depth?: number;
}) {
  if (schema._recursive) {
    return (
      <div className="text-xs text-slate-400 italic">
        recursive ref: {schema.$ref}
      </div>
    );
  }
  if (schema.oneOf || schema.anyOf || schema.allOf) {
    const variants = schema.oneOf || schema.anyOf || schema.allOf || [];
    const tag = schema.oneOf ? "one of" : schema.anyOf ? "any of" : "all of";
    return (
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">
          {tag}
        </div>
        <div className="space-y-2 pl-2 border-l border-white/10">
          {variants.map((v, i) => (
            <SchemaTable key={i} schema={v} depth={depth + 1} />
          ))}
        </div>
      </div>
    );
  }
  if (schema.type === "array") {
    return (
      <div>
        <div className="text-xs text-slate-300">
          array of {schemaShortType(schema.items) || "?"}
        </div>
        {schema.items && (
          <div className="mt-1 pl-2 border-l border-white/10">
            <SchemaTable schema={schema.items} depth={depth + 1} />
          </div>
        )}
      </div>
    );
  }
  if (schema.type === "object" || schema.properties) {
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    return (
      <div className="overflow-x-auto rounded border border-white/10">
        <table className="w-full text-xs">
          <thead className="bg-white/5 text-slate-400 uppercase tracking-wider">
            <tr>
              <th className="text-left px-2 py-1.5 font-medium">Field</th>
              <th className="text-left px-2 py-1.5 font-medium">Type</th>
              <th className="text-left px-2 py-1.5 font-medium">Required</th>
              <th className="text-left px-2 py-1.5 font-medium">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {Object.entries(props).map(([name, sub]) => (
              <tr key={name}>
                <td className="px-2 py-1.5 font-mono text-slate-100 align-top">
                  {name}
                </td>
                <td className="px-2 py-1.5 text-slate-300 align-top">
                  {schemaShortType(sub)}
                </td>
                <td className="px-2 py-1.5 align-top">
                  {required.has(name) ? (
                    <span className="text-rose-300">yes</span>
                  ) : (
                    <span className="text-slate-500">no</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-slate-300 align-top whitespace-pre-wrap">
                  {sub.description ?? ""}
                  {sub.enum && (
                    <div className="mt-1 text-[10px] text-slate-400">
                      one of:{" "}
                      {sub.enum.map((v) => JSON.stringify(v)).join(", ")}
                    </div>
                  )}
                  {sub.default !== undefined && (
                    <div className="mt-1 text-[10px] text-slate-500 font-mono">
                      default {JSON.stringify(sub.default)}
                    </div>
                  )}
                  {sub.example !== undefined && (
                    <div className="mt-1 text-[10px] text-slate-500 font-mono">
                      e.g. {JSON.stringify(sub.example)}
                    </div>
                  )}
                  {/* Inline nested object/array tables — keep depth low so
                      multi-level schemas don't run off the screen. */}
                  {depth < 3 &&
                    (sub.type === "object" ||
                      sub.properties ||
                      sub.type === "array" ||
                      sub.oneOf ||
                      sub.anyOf ||
                      sub.allOf) && (
                      <div className="mt-2">
                        <SchemaTable schema={sub} depth={depth + 1} />
                      </div>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  // Primitive leaf.
  return (
    <div className="text-xs text-slate-300">
      {schemaShortType(schema)}
      {schema.description && (
        <div className="text-slate-500 mt-0.5">{schema.description}</div>
      )}
    </div>
  );
}


function schemaShortType(schema?: Schema | null): string {
  if (!schema) return "?";
  if (schema._recursive) return "(recursive)";
  if (schema.$ref) {
    const slash = schema.$ref.lastIndexOf("/");
    return slash >= 0 ? schema.$ref.slice(slash + 1) : schema.$ref;
  }
  if (schema.oneOf) return "oneOf";
  if (schema.anyOf) return "anyOf";
  if (schema.allOf) return "allOf";
  if (schema.type === "array") {
    return `array<${schemaShortType(schema.items)}>`;
  }
  if (schema.type) {
    return schema.format ? `${schema.type} (${schema.format})` : schema.type;
  }
  if (schema.properties) return "object";
  return "?";
}
