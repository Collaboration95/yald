import type { OverviewResponse, QuotaWindowSnapshot } from "../types";

export function overviewSeries(series: OverviewResponse["series"], isolated: string | null) {
  const selected = isolated && series.groups.some(group => group.name === isolated) ? isolated : null;
  return series.groups.filter(group => !selected || group.name === selected).map(group => ({
    name: group.name,
    // A group with no list price has no cost to plot, which is not a cost of zero.
    data: series.metric === "cost" && group.pricedRequests === 0 ? series.buckets.map(() => null) : series.buckets.map(bucket => bucket.groups[group.name] ?? 0),
  }));
}

export function planAccounts(windows: QuotaWindowSnapshot[]) {
  const accounts = new Map<string, QuotaWindowSnapshot[]>();
  for (const window of windows) accounts.set(window.account, [...(accounts.get(window.account) ?? []), window]);
  // Numbered by account, not freshness, so a newer reading never renames an account.
  const numbers = new Map([...accounts.keys()].sort((a, b) => a.localeCompare(b)).map((key, index) => [key, index + 1]));
  return [...accounts].map(([key, rows]) => ({ key, number: numbers.get(key)!, windows: rows }))
    .sort((a, b) => Math.max(...b.windows.map(row => row.updatedAt)) - Math.max(...a.windows.map(row => row.updatedAt)) || a.key.localeCompare(b.key));
}

export type GridPoint = { weekday: number; hour: number };
export type GridRange = { anchor: GridPoint; end: GridPoint };
export function inHeatmapRange(cell: GridPoint, range: GridRange) {
  return cell.weekday >= Math.min(range.anchor.weekday, range.end.weekday) && cell.weekday <= Math.max(range.anchor.weekday, range.end.weekday)
    && cell.hour >= Math.min(range.anchor.hour, range.end.hour) && cell.hour <= Math.max(range.anchor.hour, range.end.hour);
}
export function heatmapTotals(cells: (GridPoint & { value: number; requests: number })[], range: GridRange) {
  return cells.filter(cell => inHeatmapRange(cell, range)).reduce((sum, cell) => ({ value: sum.value + cell.value, requests: sum.requests + cell.requests }), { value: 0, requests: 0 });
}
