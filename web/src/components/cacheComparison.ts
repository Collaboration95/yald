import type { CachePoint } from "../types";
import { lineChart, type ThemeTokens } from "./chartOptions";
import { formatCompact, formatInteger } from "../lib/format";

export type CacheSeries = "all" | "Cached" | "New";
const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);
export const cachePercent = (value: number) => `${Number((value * 100).toFixed(6))}%`;

/** Ratio units throughout; only presentation converts to percent. */
export function cacheBounds(values: (number | null)[]): [number, number] {
  const observed = values.filter(finite);
  if (!observed.length) return [0, 1];
  const low = Math.min(...observed);
  const high = Math.max(...observed);
  const padding = Math.max((high - low) * 0.15, 0.001);
  return [Math.max(0, low - padding), Math.min(1, high + padding)];
}

export function cacheComparison(theme: ThemeTokens, points: CachePoint[], selection: CacheSeries) {
  const labels = points.map(point => point.label);
  const rates = points.map(point => finite(point.hitRate) ? point.hitRate : null);
  const bounds = cacheBounds(rates);
  const rate = lineChart(theme, labels, [{ name: "Cache hit rate", data: rates }], { formatter: cachePercent, showLegend: false, preserveGaps: true });
  rate.yAxis = { ...(rate.yAxis as object), min: bounds[0], max: bounds[1], splitNumber: 4 };
  const series = [
    { name: "Cached", color: "#15803d", data: points.map(p => p.eligibleRequests > 0 && finite(p.cacheRead) ? p.cacheRead : null) },
    { name: "New", color: "#1d4ed8", data: points.map(p => p.eligibleRequests > 0 && finite(p.input) && finite(p.cacheRead) ? p.input - p.cacheRead : null) },
  ].filter(series => selection === "all" || series.name === selection);
  const tokens = lineChart(theme, labels, series, { formatter: formatCompact, showLegend: false, preserveGaps: true, wholeNumbers: true });
  tokens.tooltip = { ...(tokens.tooltip as object), valueFormatter: (value: unknown) => typeof value === "number" && Number.isFinite(value) ? `${formatInteger(value)} tokens` : "Unavailable" };
  // Dots keep single-point and isolated measurements visible. Straight segments do not invent extrema.
  for (const option of [rate, tokens]) option.series = (option.series as object[]).map(series => ({ ...series, smooth: false, symbol: "circle", symbolSize: 5, showSymbol: true }));
  return { rate, tokens, bounds, hasRates: rates.some(finite), hasTokens: series.some(s => s.data.some(finite)) };
}
