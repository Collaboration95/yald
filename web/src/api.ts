import { keepPreviousData, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { MetaResponse, Source } from "./types";
import type { ContextReplayResponse } from "./labs/context-types";
import { savedResponse, savedTime, saveResponse } from "./lib/persist";
import { useMarkPlaceholder, useMarkSaved } from "./lib/staleness";

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
  { id: "ocx", label: "Codex", detail: "Requests through the opencodex proxy" },
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
  return { pathname: `/sessions/${encodeURIComponent(conversation.id)}`, search: `?${params}` };
}

/** True for a selection that narrows beyond the time window: anything the scope strip and no-match state report on. */
export function hasScope(filters: Filters): boolean {
  return Boolean(filters.sources.length || filters.projects.length || filters.providers.length || filters.models.length
    || filters.efforts.length || filters.statuses.length || filters.routeKinds.length || filters.conversationId || filters.search.trim());
}

export const hasCustomWindow = (filters: Filters): boolean => Boolean(filters.from || filters.to || filters.last);

/** How many request filters narrow the data. The time range, a custom window and the time zone are not filters. */
export function activeFilterCount(filters: Filters): number {
  return filters.sources.length + filters.projects.length + filters.providers.length + filters.models.length
    + filters.efforts.length + filters.statuses.length + filters.routeKinds.length + Number(Boolean(filters.search.trim()))
    + Number(Boolean(filters.conversationId));
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

const responseCache = new Map<string, { etag: string; value: unknown; size: number }>();

function requestUrl(path: string, params?: Record<string, unknown> | string): string {
  const query = typeof params === "string" ? params : params ? new URLSearchParams(
    Object.entries(params).reduce<Record<string, string>>((acc, [key, value]) => {
      if (value !== undefined && value !== null) acc[key] = String(value);
      return acc;
    }, {}),
  ).toString() : "";
  return query ? `${path}?${query}` : path;
}

/**
 * GET one API response. With `persist`, a successful response is also kept in this browser
 * (lib/persist.ts) for the next page load, and a saved ETag can turn that load's first
 * request into a 304. Errors are never kept.
 */
export async function fetchJson<T>(path: string, params?: Record<string, unknown> | string, options: { persist?: boolean } = {}): Promise<T> {
  const url = requestUrl(path, params);
  const saved = options.persist ? savedResponse(url) : undefined;
  const cached = responseCache.get(url) ?? (saved?.etag ? { etag: saved.etag, value: saved.body, size: saved.size } : undefined);
  const response = await fetch(url, {
    headers: { accept: "application/json", ...(cached ? { "if-none-match": cached.etag } : {}) },
  });
  if (response.status === 304 && cached) {
    // Confirmed current: keep it, and date it now.
    if (options.persist) saveResponse(url, cached.value, cached.etag, cached.size);
    return cached.value as T;
  }
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
  const text = await response.text();
  const value = JSON.parse(text) as T;
  const etag = response.headers.get("etag");
  if (etag) responseCache.set(url, { etag, value, size: text.length });
  if (options.persist) saveResponse(url, value, etag, text.length);
  return value;
}

/**
 * One persisted GET query. On the first mount after a page load it starts from the response
 * saved by an earlier load (with its save time as the data time), so the page shows at once
 * while the fresh request runs; the layout labels it "as of" until fresh data replaces it.
 */
function useSavedQuery<T>(
  queryKey: readonly unknown[],
  path: string,
  params: string | undefined,
  options: { persist: boolean; staleTime: number; refetchInterval: number | false; enabled: boolean; keepPrevious: boolean },
): UseQueryResult<T> {
  const queryClient = useQueryClient();
  const saved = options.persist && queryClient.getQueryData(queryKey) === undefined ? savedResponse(requestUrl(path, params)) : undefined;
  const query = useQuery<T>({
    queryKey,
    queryFn: () => fetchJson<T>(path, params, { persist: options.persist }),
    initialData: saved?.body as T | undefined,
    initialDataUpdatedAt: saved?.savedAt,
    // A saved response is never the fresh answer, however recently it was saved.
    refetchOnMount: query => (showsSaved(query.state.data, query.state.dataUpdatedAt) ? "always" : true),
    staleTime: options.staleTime,
    refetchInterval: options.refetchInterval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    enabled: options.enabled,
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
  });
  useMarkPlaceholder(query.isPlaceholderData);
  useMarkSaved(showsSaved(query.data, query.dataUpdatedAt) ? query.dataUpdatedAt : null, query.isError);
  return query;
}

/** Still the body saved by an earlier page load, neither replaced nor reconfirmed since (a refresh moves dataUpdatedAt). */
function showsSaved(data: unknown, dataUpdatedAt: number): boolean {
  const savedAt = savedTime(data);
  return savedAt !== undefined && savedAt === dataUpdatedAt;
}

/**
 * Recorded Claude Code session titles by id. Never persisted: `docs/install.md` promises that
 * what this browser keeps holds no prompt text, and a generated title is drawn from one.
 */
export function useSessionTitles(): Record<string, string> {
  const query = useQuery<{ titles: Record<string, string> }>({
    queryKey: ["/api/session-titles"], queryFn: () => fetchJson("/api/session-titles"), staleTime: 60_000, refetchOnWindowFocus: false,
  });
  return query.data?.titles ?? {};
}

/** `/api/meta`, shared by the layout and the chart palette; persisted like the views. */
export function useMeta(): UseQueryResult<MetaResponse> {
  return useSavedQuery<MetaResponse>(["/api/meta"], "/api/meta", undefined, { persist: true, staleTime: 60_000, refetchInterval: false, enabled: true, keepPrevious: false });
}

/**
 * The filters a selection summary depends on. `/api/scope` and `/api/projects` ignore chart
 * controls, so changing `groupBy`, `metric` or `bucket` must not refetch them.
 */
export const selectionFilters = (filters: Filters): Filters => ({ ...filters, groupBy: "", metric: "", bucket: "auto" });

export interface EndpointOptions {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
  /**
   * Keep showing the previous selection's response while a new one loads (default true).
   * It is marked as not yet updated. Views whose state belongs to one exact selection opt out.
   */
  keepPrevious?: boolean;
  /**
   * Keep the last successful response in this browser and show it, labelled with its save
   * time, on the next page load (default true). Labs findings opt out: their evidence
   * identities belong to the dataset they were computed from.
   */
  persist?: boolean;
}

export function useEndpoint<T>(
  path: string,
  filters: Filters,
  extra: Record<string, unknown> = {},
  options: EndpointOptions = {},
): UseQueryResult<T> {
  const params = filtersToParams(filters, extra);
  return useSavedQuery<T>([path, params], path, params, {
    persist: options.persist ?? true,
    staleTime: options.staleTime ?? 15_000,
    refetchInterval: options.refetchInterval ?? 30_000,
    enabled: options.enabled ?? true,
    keepPrevious: options.keepPrevious ?? true,
  });
}

export function exportUrl(filters: Filters, dataset: string): string {
  return `/api/export?${filtersToParams(filters, { dataset })}`;
}

/**
 * Mount only when Labs is enabled; extra accepts resolved bounds and source/project scope.
 * Its evidence belongs to one exact cohort, so it never shows a previous selection's response.
 */
export function useContextReplay(
  filters: Filters,
  extra: Record<string, unknown> = {},
  options: EndpointOptions = {},
): UseQueryResult<ContextReplayResponse> {
  return useEndpoint<ContextReplayResponse>("/api/labs/context", filters, extra, { ...options, keepPrevious: false, persist: false });
}
