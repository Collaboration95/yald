import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { canonicalSources, DEFAULT_FILTERS, filtersFromParams, type Filters } from "../api";
import { isLabsAnalysis, labRange, labsFilters } from "./labsFilters";

/** The time window and zone: part of the view, not a request filter, so Reset keeps them. */
const WINDOW_KEYS = new Set(["range", "from", "to", "last", "tz"]);

export function patchFilterParams(current: URLSearchParams, patch: Partial<Filters>): URLSearchParams {
  const next = new URLSearchParams(current);
  // A preset replaces explicit bounds. Time strings otherwise go straight to the server parser.
  if (patch.range !== undefined) for (const key of ["from", "to", "last"]) next.delete(key);
  for (const [key, rawValue] of Object.entries(patch)) {
    const value = key === "sources" && Array.isArray(rawValue) ? canonicalSources(rawValue) : rawValue;
    if (Array.isArray(value)) {
      if (value.length) next.set(key, value.join(","));
      else next.delete(key);
    } else if (value === undefined || value === null || value === "") {
      next.delete(key);
    } else {
      next.set(key, String(value));
    }
  }
  // A picked spike is local to its old window/zone. Let the new response pick its own day.
  if ([...WINDOW_KEYS].some(key => current.get(key) !== next.get(key))) next.delete("day");
  return next;
}

type FilterListKey = "providers" | "models" | "efforts" | "statuses" | "sources" | "projects" | "agents";

interface FiltersContextValue {
  filters: Filters;
  set: (patch: Partial<Filters>) => void;
  toggleIn: (key: FilterListKey, value: string) => void;
  reset: () => void;
}

const FiltersContext = createContext<FiltersContextValue | null>(null);

export function FiltersProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();

  const filters = useMemo(() => {
    const parsed = filtersFromParams(searchParams);
    if (!isLabsAnalysis(pathname)) return parsed;
    const effective = labsFilters(parsed);
    if (!["range", "from", "to", "last"].some(key => searchParams.has(key))) effective.range = labRange(pathname);
    return effective;
  }, [searchParams, pathname]);

  const set = useCallback((patch: Partial<Filters>) => {
    setSearchParams(current => patchFilterParams(current, patch), { replace: true });
  }, [setSearchParams]);

  const toggleIn = useCallback((key: FilterListKey, value: string) => {
    // Empty means both sources, so toggling one off leaves just the other selected.
    if (key === "sources" && filters.sources.length === 0) {
      set({ sources: [value === "ocx" ? "claude-code" : "ocx"] });
      return;
    }
    const current = filters[key];
    const next = current.includes(value) ? current.filter(entry => entry !== value) : [...current, value];
    set({ [key]: next } as Partial<Filters>);
  }, [filters, set]);

  const reset = useCallback(() => {
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      // Reset request filters only. The time window is not a filter, and case intent (including paired selectors) stays.
      for (const key of Object.keys(DEFAULT_FILTERS)) if (!WINDOW_KEYS.has(key)) next.delete(key);
      // Session identity is not a cohort filter. Reset must still open the same source's session.
      if (pathname.startsWith("/sessions/") && current.has("sessionSource")) next.set("sessionSource", current.get("sessionSource")!);
      return next;
    }, { replace: true });
  }, [setSearchParams, pathname]);

  const value = useMemo(() => ({ filters, set, toggleIn, reset }), [filters, set, toggleIn, reset]);
  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): FiltersContextValue {
  const context = useContext(FiltersContext);
  if (!context) throw new Error("useFilters must be used inside FiltersProvider");
  return context;
}
