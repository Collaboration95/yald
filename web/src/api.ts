import { useQuery, type UseQueryResult } from "@tanstack/react-query";

export const RANGES = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "90d", label: "90d" },
  { id: "all", label: "All" },
] as const;

export interface Filters {
  range: string;
  providers: string[];
  models: string[];
  efforts: string[];
  statuses: string[];
  groupBy: string;
  metric: string;
  bucket: string;
  search: string;
}

export const DEFAULT_FILTERS: Filters = {
  range: "30d",
  providers: [],
  models: [],
  efforts: [],
  statuses: [],
  groupBy: "model",
  metric: "tokens",
  bucket: "auto",
  search: "",
};

export function filtersToParams(filters: Filters, extra: Record<string, unknown> = {}): string {
  const params = new URLSearchParams();
  params.set("range", filters.range);
  if (filters.providers.length) params.set("providers", filters.providers.join(","));
  if (filters.models.length) params.set("models", filters.models.join(","));
  if (filters.efforts.length) params.set("efforts", filters.efforts.join(","));
  if (filters.statuses.length) params.set("statuses", filters.statuses.join(","));
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

export async function fetchJson<T>(path: string, params?: Record<string, unknown> | string): Promise<T> {
  const query = typeof params === "string" ? params : params ? new URLSearchParams(
    Object.entries(params).reduce<Record<string, string>>((acc, [key, value]) => {
      if (value !== undefined && value !== null) acc[key] = String(value);
      return acc;
    }, {}),
  ).toString() : "";
  const url = query ? `${path}?${query}` : path;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(body.slice(0, 200) || `Request failed with ${response.status}`, response.status);
  }
  return (await response.json()) as T;
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
    refetchOnWindowFocus: false,
    enabled: options.enabled ?? true,
  });
}

export function exportUrl(filters: Filters, dataset: string): string {
  return `/api/export?${filtersToParams(filters, { dataset })}`;
}
