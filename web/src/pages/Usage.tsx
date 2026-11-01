import { useEffect, useMemo, useState } from "react";
import { filtersKey, useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { Card, CardHeader, Segmented, Stat, StateBlock, Td, Th } from "../components/ui";
import { ActivityGrid } from "../components/ActivityGrid";
import { formatCompact, formatInteger, formatPercent, formatShortDate } from "../lib/format";
import type { UsageHeatmapDatesResponse, UsageResponse } from "../types";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DETAIL_PAGE_SIZE = 20;
type HeatmapSelection = { weekday: number; hour: number; filterKey: string; metric: "tokens" | "requests" };

export function UsagePage() {
  const { filters } = useFilters();
  const query = useEndpoint<UsageResponse>("/api/usage", filters, { metric: "tokens", groupBy: "model" });
  const data = query.data;
  const [heatmapMetric, setHeatmapMetric] = useState<"tokens" | "requests">("tokens");
  const filterKey = filtersKey(filters);
  const [selection, setSelection] = useState<HeatmapSelection | null>(null);
  const [detailOffset, setDetailOffset] = useState(0);
  const [detailRows, setDetailRows] = useState<UsageHeatmapDatesResponse["dates"]>([]);
  const activeSelection = selection?.filterKey === filterKey && selection.metric === heatmapMetric ? selection : null;
  const detailQuery = useEndpoint<UsageHeatmapDatesResponse>("/api/usage/heatmap-dates", filters, {
    weekday: activeSelection?.weekday, hour: activeSelection?.hour, metric: heatmapMetric, limit: DETAIL_PAGE_SIZE, offset: detailOffset,
  }, { enabled: Boolean(activeSelection), refetchInterval: false, keepPrevious: false });
  useEffect(() => {
    setSelection(current => current && current.filterKey === filterKey && current.metric === heatmapMetric ? current : null);
    setDetailOffset(0);
    setDetailRows([]);
  }, [filterKey, heatmapMetric]);
  useEffect(() => {
    const result = detailQuery.data;
    if (!result || !activeSelection || result.weekday !== activeSelection.weekday || result.hour !== activeSelection.hour || result.metric !== heatmapMetric) return;
    setDetailRows(current => detailOffset === 0 ? result.dates : current.length === detailOffset ? [...current, ...result.dates] : current);
  }, [detailQuery.data, detailOffset, activeSelection, heatmapMetric]);

  const heatmap = data?.heatmap;
  const heatmapCells = useMemo(() => heatmap?.cells.map(cell => ({
    ...cell,
    value: heatmapMetric === "tokens" ? cell.value : cell.requests,
  })) ?? [], [heatmap, heatmapMetric]);
  const heatmapUnit = heatmapMetric === "tokens" ? "tokens" : "requests";
  const chooseCell = (weekday: number, hour: number) => {
    // Cells from the previous selection are not this selection's cells.
    if (query.isPlaceholderData) return;
    setSelection({ weekday, hour, filterKey, metric: heatmapMetric });
    setDetailOffset(0);
    setDetailRows([]);
  };
  const summary = data?.summary;
  const cacheCoverage = data?.summary.measurementCoverage.cache;
  const cachePartial = cacheCoverage && cacheCoverage.totalRequests > 0 && cacheCoverage.eligibleRequests / cacheCoverage.totalRequests < 0.95
    ? `Partial: measured on ${formatInteger(cacheCoverage.eligibleRequests)} of ${formatInteger(cacheCoverage.totalRequests)} requests.` : undefined;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total tokens" value={summary ? formatCompact(summary.tokens.total) : "—"} hint={summary ? `${formatPercent(summary.tokens.cacheRead / Math.max(1, summary.tokens.total), 0)} from cache` : undefined} tone="neutral" />
        <Stat label="Output tokens" value={summary ? formatCompact(summary.tokens.output) : "—"} tone="info" />
        <Stat label="Reasoning tokens" value={summary ? formatCompact(summary.tokens.reasoning) : "—"} hint="Included in output" tone="violet" />
        <Stat label="Cache hit rate" value={summary ? formatPercent(summary.cache.hitRate) : "—"} info={cachePartial} tone="good" />
      </div>

      <Card className="max-w-[980px]">
        <CardHeader className="flex-col sm:flex-row" title="When you work" action={
          <Segmented size="sm" value={heatmapMetric} options={[{ id: "tokens", label: "Tokens" }, { id: "requests", label: "Requests" }]} onChange={setHeatmapMetric} />
        } />
        <StateBlock loading={query.isLoading} error={query.error} empty={!heatmap}>
          {heatmap ? <ActivityGrid key={`${filterKey}:${heatmapMetric}`} cells={heatmapCells} disabled={query.isPlaceholderData} unit={heatmapUnit} onChoose={chooseCell} /> : null}
        </StateBlock>
        {activeSelection ? <section className="mt-3 border-t border-line pt-3" aria-live="polite" aria-label="Selected heatmap cell dates">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div><h3 className="text-[13px] font-semibold text-ink">{WEEKDAYS[activeSelection.weekday]} at {String(activeSelection.hour).padStart(2, "0")}:00</h3><p className="text-[11px] text-muted">Busiest dates by {heatmapUnit}</p></div>
            <button type="button" className="rounded px-2 py-1 text-[11px] text-muted hover:bg-surface-2 hover:text-ink" onClick={() => { setSelection(null); setDetailRows([]); setDetailOffset(0); }}>Clear selection</button>
          </div>
          {detailQuery.isLoading && detailOffset === 0 ? <p className="py-4 text-center text-[12px] text-muted">Loading dates…</p> : null}
          {detailQuery.error ? <div className="py-3 text-center text-[12px] text-danger">Could not load dates. <button className="underline" onClick={() => void detailQuery.refetch()}>Try again</button></div> : null}
          {!detailQuery.isLoading && !detailQuery.error && detailQuery.data?.totalDates === 0 ? <p className="py-4 text-center text-[12px] text-muted">No dates with activity in this cell.</p> : null}
          {detailRows.length > 0 ? <>
            <div className="mb-2 flex justify-between text-[11px] text-muted"><span>{formatCompact(detailQuery.data?.total ?? 0)} {heatmapUnit} total</span><span>{detailRows.length} of {detailQuery.data?.totalDates ?? detailRows.length} dates</span></div>
            <div className="rounded border border-line"><table className="w-full text-[11px]"><thead className="text-muted"><tr><Th>Date</Th><Th align="right">{heatmapUnit}</Th><Th align="right">Requests</Th></tr></thead><tbody>
              {detailRows.map(row => <tr key={row.date} className="border-t border-line"><Td>{formatShortDate(row.date)}</Td><Td align="right">{formatCompact(row.value)}</Td><Td align="right">{formatInteger(row.requests)}</Td></tr>)}
            </tbody></table></div>
            {detailQuery.data?.hasMore ? <button type="button" disabled={detailQuery.isFetching} className="mt-2 w-full rounded border border-line px-3 py-1.5 text-[11px] text-ink disabled:opacity-50" onClick={() => setDetailOffset(detailRows.length)}>{detailQuery.isFetching ? "Loading…" : "Show more dates"}</button> : null}
          </> : null}
        </section> : null}
      </Card>

    </div>
  );
}
