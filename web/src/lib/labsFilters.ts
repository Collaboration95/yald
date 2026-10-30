import { DEFAULT_FILTERS, type Filters } from "../api";

/** Direct investigation links use these defaults; the board uses one 30-day window. */
export const LAB_TABS = [
  { path: "spend-spikes", label: "Spikes", range: "30d" },
  { path: "project-radar", label: "Projects", range: "7d" },
  { path: "cache-detective", label: "Cache savings", range: "7d" },
  { path: "context-replay", label: "Context growth", range: "30d" },
] as const;
export type LabPath = (typeof LAB_TABS)[number]["path"];
export const labRange = (pathname: string): string => LAB_TABS.find(tab => pathname.replace(/\/+$/, "") === `/labs/${tab.path}`)?.range ?? "30d";
export const isLabsAnalysis = (pathname: string): boolean => {
  const path = pathname.replace(/\/+$/, "");
  return path === "/labs" || LAB_TABS.some(tab => path === `/labs/${tab.path}`);
};

/** Only visible investigation controls constrain Labs. Explicit evidence selectors are a separate contract. */
export function labsFilters(filters: Filters): Filters {
  const { range, from, to, last, tz, sources, projects, models } = filters;
  return { ...DEFAULT_FILTERS, range, from, to, last, tz, sources, projects, models, groupBy: "", metric: "", bucket: "" };
}
