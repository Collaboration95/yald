import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Source } from "./types";

export const RANGES = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "90d", label: "90d" },
  { id: "all", label: "All" },
] as const;

/** Sources are determined by ingestion protocol, never by provider (see docs/metrics.md). */
export const SOURCES: { id: Source; label: string; detail: string }[] = [
  { id: "claude-code", label: "Claude Code", detail: "Claude Code transcripts" },
  { id: "ocx", label: "Codex · opencodex", detail: "Requests through the opencodex proxy" },
];

/** CLI aliases the server also accepts, mapped to the canonical source id. */
const SOURCE_ALIASES: Record<string, Source> = { "claude-code": "claude-code", claude: "claude-code", ocx: "ocx", codex: "ocx" };

/** Canonical source ids for a raw list; a name the server would reject is kept so it can answer 400 and stay removable. */
export function canonicalSources(values: string[]): string[] {
  const sources = [...new Set(values.map(value => value.trim()).filter(Boolean).map(value => SOURCE_ALIASES[value.toLowerCase()] ?? value))];
  return sources.length === SOURCES.length && SOURCES.every(source => sources.includes(source.id)) ? [] : sources;
}

export const sourceLabel = (id: string): string => SOURCES.find(source => source.id === id)?.label ?? id;

/** A folder path as a literal glob: the server matches projects with `Bun.Glob`, where these characters are special. */
export const escapeGlob = (path: string): string => path.replace(/[\\*?[\]{}()!]/g, "\\$&");
export const unescapeGlob = (glob: string): string => glob.replace(/\\([\\*?[\]{}()!])/g, "$1");

export interface Filters {
  range: string;
  providers: string[];
  models: string[];
  efforts: string[];
  statuses: string[];
  routeKinds: string[];
  conversationId: string;
  /** Canonical source ids; empty means every source. */
  sources: string[];
  /** Folder globs matched against a request's working directory or any ancestor; empty means every project. */
  projects: string[];
  groupBy: string;
  metric: string;
  bucket: string;
  search: string;
  /** Optional explicit window, read by the server's time parser (`from`/`to` instants, IANA `tz`). Empty means the range preset. */
  from: string;
  to: string;
  tz: string;
  last: string;
}

export const DEFAULT_FILTERS: Filters = {
  range: "30d",
  providers: [],
  models: [],
  efforts: [],
  statuses: [],
  routeKinds: [],
  conversationId: "",
  sources: [],
  projects: [],
  groupBy: "model",
  metric: "tokens",
  bucket: "auto",
  search: "",
  from: "",
  to: "",
  tz: "",
  last: "",
};

export function filtersFromParams(params: URLSearchParams): Filters {
  const list = (key: string) => (params.get(key) ?? "").split(",").map(value => value.trim()).filter(Boolean);
  return {
    ...DEFAULT_FILTERS,
    ...Object.fromEntries(["range", "groupBy", "metric", "bucket", "search", "from", "to", "tz", "last", "conversationId"]
      .map(key => [key, params.get(key) ?? DEFAULT_FILTERS[key as keyof Filters]])),
    providers: list("providers"), models: list("models"), efforts: list("efforts"), statuses: list("statuses"),
    routeKinds: list("routeKinds"), projects: list("projects"), sources: canonicalSources(list("sources")),
  };
}

/** Keep the entire URL cohort, adding only the identity of the session being opened. */
export function conversationLink(conversation: { id: string; source: Source }, search: string) {
  const params = new URLSearchParams(search);
  params.set("sessionSource", conversation.source);
  return { pathname: `/conversations/${encodeURIComponent(conversation.id)}`, search: `?${params}` };
}

/** True for a selection that narrows beyond the time window: anything the scope strip and no-match state report on. */
export function hasScope(filters: Filters): boolean {
  return Boolean(filters.sources.length || filters.projects.length || filters.providers.length || filters.models.length
    || filters.efforts.length || filters.statuses.length || filters.routeKinds.length || filters.conversationId || filters.search.trim());
}

export const hasCustomWindow = (filters: Filters): boolean => Boolean(filters.from || filters.to || filters.last);

export function activeFilterCount(filters: Filters): number {
  return filters.sources.length + filters.projects.length + filters.providers.length + filters.models.length
    + filters.efforts.length + filters.statuses.length + filters.routeKinds.length + Number(Boolean(filters.search))
    + Number(Boolean(filters.conversationId)) + Number(hasCustomWindow(filters) || filters.range !== DEFAULT_FILTERS.range) + Number(Boolean(filters.tz));
}

/** The complete request scope as one string, to reset state that belongs to a particular selection. */
export const filtersKey = (filters: Filters): string => filtersToParams(filters);

export function filtersToParams(filters: Filters, extra: Record<string, unknown> = {}): string {
  const params = new URLSearchParams();
  params.set("range", filters.range);
  if (filters.providers.length) params.set("providers", filters.providers.join(","));
  if (filters.models.length) params.set("models", filters.models.join(","));
  if (filters.efforts.length) params.set("efforts", filters.efforts.join(","));
  if (filters.statuses.length) params.set("statuses", filters.statuses.join(","));
  if (filters.routeKinds.length) params.set("routeKinds", filters.routeKinds.join(","));
  if (filters.conversationId) params.set("conversationId", filters.conversationId);
  const sources = canonicalSources(filters.sources);
  if (sources.length) params.set("sources", sources.join(","));
  if (filters.projects.length) params.set("projects", filters.projects.join(","));
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.tz) params.set("tz", filters.tz);
  if (filters.last) params.set("last", filters.last);
  if (filters.groupBy) params.set("groupBy", filters.groupBy);
  if (filters.metric) params.set("metric", filters.metric);
  if (filters.bucket && filters.bucket !== "auto") params.set("bucket", filters.bucket);
  if (filters.search) params.set("search", filters.search);
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const responseCache = new Map<string, { etag: string; value: unknown }>();

export async function fetchJson<T>(path: string, params?: Record<string, unknown> | string): Promise<T> {
  const query = typeof params === "string" ? params : params ? new URLSearchParams(
    Object.entries(params).reduce<Record<string, string>>((acc, [key, value]) => {
      if (value !== undefined && value !== null) acc[key] = String(value);
      return acc;
    }, {}),
  ).toString() : "";
  const url = query ? `${path}?${query}` : path;
  const cached = responseCache.get(url);
  const response = await fetch(url, {
    headers: { accept: "application/json", ...(cached ? { "if-none-match": cached.etag } : {}) },
  });
  if (response.status === 304 && cached) return cached.value as T;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let message = body.slice(0, 200) || `Request failed with ${response.status}`;
    try {
      const error = JSON.parse(body).error;
      if (typeof error === "string") message = error;
      else if (typeof error?.message === "string") message = error.message;
    } catch { /* A non-JSON error response still has the bounded fallback above. */ }
    throw new ApiError(message, response.status);
  }
  const value = await response.json() as T;
  const etag = response.headers.get("etag");
  if (etag) responseCache.set(url, { etag, value });
  return value;
}

export function useEndpoint<T>(
  path: string,
  filters: Filters,
  extra: Record<string, unknown> = {},
  options: { enabled?: boolean; staleTime?: number; refetchInterval?: number | false } = {},
): UseQueryResult<T> {
  const params = filtersToParams(filters, extra);
  return useQuery<T>({
    queryKey: [path, params],
    queryFn: () => fetchJson<T>(path, params),
    staleTime: options.staleTime ?? 15_000,
    refetchInterval: options.refetchInterval ?? 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    enabled: options.enabled ?? true,
  });
}

export function exportUrl(filters: Filters, dataset: string): string {
  return `/api/export?${filtersToParams(filters, { dataset })}`;
}
