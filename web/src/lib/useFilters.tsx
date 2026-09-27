import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { DEFAULT_FILTERS, type Filters } from "../api";

type FilterListKey = "providers" | "models" | "efforts" | "statuses";

interface FiltersContextValue {
  filters: Filters;
  set: (patch: Partial<Filters>) => void;
  toggleIn: (key: FilterListKey, value: string) => void;
  reset: () => void;
}

const FiltersContext = createContext<FiltersContextValue | null>(null);

function parseList(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").map(entry => entry.trim()).filter(Boolean);
}

export function FiltersProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo<Filters>(() => ({
    range: searchParams.get("range") ?? DEFAULT_FILTERS.range,
    providers: parseList(searchParams.get("providers")),
    models: parseList(searchParams.get("models")),
    efforts: parseList(searchParams.get("efforts")),
    statuses: parseList(searchParams.get("statuses")),
    groupBy: searchParams.get("groupBy") ?? DEFAULT_FILTERS.groupBy,
    metric: searchParams.get("metric") ?? DEFAULT_FILTERS.metric,
    bucket: searchParams.get("bucket") ?? DEFAULT_FILTERS.bucket,
    search: searchParams.get("search") ?? DEFAULT_FILTERS.search,
  }), [searchParams]);

  const set = useCallback((patch: Partial<Filters>) => {
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(patch)) {
        if (Array.isArray(value)) {
          if (value.length) next.set(key, value.join(","));
          else next.delete(key);
        } else if (value === undefined || value === null || value === "") {
          next.delete(key);
        } else {
          next.set(key, String(value));
        }
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const toggleIn = useCallback((key: FilterListKey, value: string) => {
    const current = filters[key];
    const next = current.includes(value) ? current.filter(entry => entry !== value) : [...current, value];
    set({ [key]: next } as Partial<Filters>);
  }, [filters, set]);

  const reset = useCallback(() => {
    setSearchParams(new URLSearchParams({ range: DEFAULT_FILTERS.range }), { replace: true });
  }, [setSearchParams]);

  const value = useMemo(() => ({ filters, set, toggleIn, reset }), [filters, set, toggleIn, reset]);
  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): FiltersContextValue {
  const context = useContext(FiltersContext);
  if (!context) throw new Error("useFilters must be used inside FiltersProvider");
  return context;
}
