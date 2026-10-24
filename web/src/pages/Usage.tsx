import { useEffect, useMemo, useState } from "react";
import { filtersKey, useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Card, CardHeader, Expandable, InfoTip, Segmented, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { heatmapChart, lineChart, stackedAreaChart, type ThemeTokens } from "../components/chartOptions";
import { formatCompact, formatInteger, formatPercent, formatShortDate, formatUsd } from "../lib/format";
import { effortLabel } from "../components/ScopeControls";
import type { UsageHeatmapDatesResponse, UsageResponse } from "../types";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DETAIL_PAGE_SIZE = 20;
type HeatmapSelection = { weekday: number; hour: number; filterKey: string; metric: "tokens" | "requests" };

export function usageCompositionOption(chartTheme: ThemeTokens, composition: UsageResponse["composition"]) {
  return stackedAreaChart(chartTheme, composition.map(point => point.label), [
    { name: "Cached", data: composition.map(point => point.cacheRead) },
    // Writes are new input; reasoning is already included in output.
    { name: "New", data: composition.map(point => point.freshInput + point.cacheWrite + point.output) },
  ], { formatter: value => formatCompact(value), colors: { Cached: "#16a34a", New: "#f59e0b" } });
}

export function UsagePage() {
  const { filters, set } = useFilters();
  const { chartTheme } = useTheme();
  const query = useEndpoint<UsageResponse>("/api/usage", filters, { metric: filters.metric, groupBy: filters.groupBy });
  const tokenHeatmapQuery = useEndpoint<UsageResponse>("/api/usage", filters, { metric: "tokens", groupBy: filters.groupBy });
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

  const compositionOption = useMemo(() => data ? usageCompositionOption(chartTheme, data.composition) : null, [data, chartTheme]);

  const groupedOption = useMemo(() => {
    if (!data) return null;
    const labels = data.series.buckets.map(bucket => bucket.label);
    const series = data.series.groups.map(group => ({
      name: group.name,
      data: data.series.buckets.map(bucket => bucket.groups[group.name] ?? 0),
    }));
    return stackedAreaChart(chartTheme, labels, series, { formatter: value => formatCompact(value) });
  }, [data, chartTheme]);

  const cacheOption = useMemo(() => {
    if (!data) return null;
    // Hit rate only: dollars saved live on Overview and in Labs, and share no axis with a percentage.
    return lineChart(chartTheme, data.cache.map(point => point.label), [
      { name: "Cache hit rate", data: data.cache.map(point => point.hitRate === null ? null : point.hitRate * 100), area: true },
    ], { formatter: value => `${Math.round(value)}%`, showLegend: false, preserveGaps: true });
  }, [data, chartTheme]);

  const heatmap = tokenHeatmapQuery.data?.heatmap;
  const heatmapCells = useMemo(() => heatmap?.cells.map(cell => ({
    ...cell,
    value: heatmapMetric === "tokens" ? cell.value : cell.requests,
  })) ?? [], [heatmap, heatmapMetric]);
  const heatmapMax = heatmapCells.reduce((max, cell) => Math.max(max, cell.value), 0);
  const heatmapUnit = heatmapMetric === "tokens" ? "tokens" : "requests";
  const heatmapOption = useMemo(() => {
    if (!heatmap) return null;
    return heatmapChart(chartTheme, heatmapCells, heatmapMax, {
      formatter: value => formatCompact(value), unit: heatmapUnit,
    });
  }, [heatmap, heatmapCells, heatmapMax, chartTheme, heatmapUnit]);
  const chooseCell = (weekday: number, hour: number) => {
    // Cells from the previous selection are not this selection's cells.
    if (tokenHeatmapQuery.isPlaceholderData) return;
    setSelection({ weekday, hour, filterKey, metric: heatmapMetric });
    setDetailOffset(0);
    setDetailRows([]);
  };
  const heatmapEvents = useMemo(() => ({
    click: (raw: unknown) => {
      const params = raw as { dataIndex?: number };
      const cell = typeof params.dataIndex === "number" ? heatmapCells[params.dataIndex] : undefined;
      if (cell) chooseCell(cell.weekday, cell.hour);
    },
  }), [heatmapCells, filterKey, heatmapMetric, tokenHeatmapQuery.isPlaceholderData]);
  const keyboardCell = activeSelection ? activeSelection.weekday * 24 + activeSelection.hour : 0;

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

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Cached vs new tokens" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.composition.length === 0}>
            {compositionOption ? <Chart option={compositionOption} height={272} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Cache hit rate" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {cacheOption ? <Chart option={cacheOption} height={272} /> : null}
          </StateBlock>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Tokens by group"
          action={
            <div className="flex flex-wrap items-center gap-1.5">
              <Segmented
                size="sm"
                value={filters.metric as "tokens" | "outputTokens" | "inputTokens" | "cacheReadTokens" | "reasoningTokens" | "requests"}
                options={[
                  { id: "tokens", label: "Total" },
                  { id: "inputTokens", label: "Input" },
                  { id: "outputTokens", label: "Output" },
                  { id: "cacheReadTokens", label: "Cache" },
                  { id: "requests", label: "Requests" },
                ]}
                onChange={metric => set({ metric })}
              />
              <Segmented
                size="sm"
                value={filters.groupBy as "model" | "provider" | "effort" | "route" | "account"}
                options={[
                  { id: "model", label: "Model" },
                  { id: "provider", label: "Provider" },
                  { id: "effort", label: "Effort" },
                ]}
                onChange={groupBy => set({ groupBy })}
              />
            </div>
          }
        />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.series.buckets.length === 0}>
          {groupedOption ? <Chart option={groupedOption} height={260} /> : null}
        </StateBlock>
      </Card>

      <Card>
        <CardHeader className="flex-col sm:flex-row" title="When you work" action={
          <Segmented size="sm" value={heatmapMetric} options={[{ id: "tokens", label: "Tokens" }, { id: "requests", label: "Requests" }]} onChange={setHeatmapMetric} />
        } />
        <StateBlock loading={tokenHeatmapQuery.isLoading} error={tokenHeatmapQuery.error} empty={!heatmap}>
          {heatmapOption ? <>
            {heatmapMax > 0
              ? <>
                <Chart option={heatmapOption} height={230} onEvents={heatmapEvents} />
                <div className="mt-2 flex items-center gap-2 text-[10px] text-muted" aria-label={`${heatmapUnit} scale from 0 to ${formatCompact(heatmapMax)}`}>
                  <span>0</span><span className="h-2 w-20 rounded-full" style={{ background: "var(--heatmap-gradient)" }} /><span>{formatCompact(heatmapMax)} {heatmapUnit}</span>
                </div>
                <div role="group" aria-label={`Activity heatmap cells by weekday and hour, values in ${heatmapUnit}`} className="sr-only overflow-hidden focus-within:not-sr-only focus-within:fixed focus-within:inset-x-4 focus-within:bottom-4 focus-within:z-50 focus-within:w-[calc(100vw-2rem)] focus-within:max-h-56 focus-within:flex focus-within:flex-col focus-within:overflow-x-hidden focus-within:overflow-y-auto focus-within:rounded-lg focus-within:border focus-within:border-line focus-within:bg-surface focus-within:p-2 focus-within:shadow-lg" onKeyDown={event => {
                  const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 24, ArrowUp: -24 };
                  if (event.key in moves) {
                    event.preventDefault();
                    const next = Math.max(0, Math.min(167, keyboardCell + moves[event.key]));
                    chooseCell(Math.floor(next / 24), next % 24);
                    document.getElementById(`heatmap-cell-${next}`)?.focus();
                  }
                }}>
                  {heatmapCells.map(cell => {
                    const index = cell.weekday * 24 + cell.hour;
                    return <button id={`heatmap-cell-${index}`} key={index} tabIndex={keyboardCell === index ? 0 : -1}
                      aria-label={`${WEEKDAYS[cell.weekday]} at ${String(cell.hour).padStart(2, "0")}:00, ${formatCompact(cell.value)} ${heatmapUnit}, ${cell.requests} requests`}
                      className="w-full shrink-0 rounded px-2 py-1 text-left text-[11px] text-ink hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      onClick={() => chooseCell(cell.weekday, cell.hour)}>{WEEKDAYS[cell.weekday]} {cell.hour}:00</button>;
                  })}
                </div>
                </>
              : <p className="flex h-[120px] items-center justify-center text-[12px] text-muted">No activity for these filters</p>}
          </> : null}
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

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title="By effort" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.byEffort.length === 0}>
            <BreakdownTable rows={data?.byEffort ?? []} dimension="Effort" label={effortLabel} />
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="By provider" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.byProvider.length === 0}>
            <BreakdownTable rows={data?.byProvider ?? []} dimension="Provider" />
          </StateBlock>
        </Card>
      </div>
    </div>
  );
}

function BreakdownTable({ rows, dimension, label }: { rows: { key: string; requests: number; tokens: number; cost: number; pricedRequests: number; share: number; p50DurationMs: number | null; successRate: number | null }[]; dimension: string; label?: (key: string) => string }) {
  return (
    <Expandable items={rows}>
      {visible => (
        <TableShell>
          <thead>
            <tr>
              <Th>{dimension}</Th>
              <Th align="right">Requests</Th>
              <Th align="right">Tokens</Th>
              <Th align="right">Share</Th>
              <Th align="right">Cost</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map(row => (
              <tr key={row.key} className="transition hover:bg-surface-2">
                <Td className="max-w-[180px] truncate" >{label?.(row.key) ?? row.key}{row.key === "unknown" ? <InfoTip className="ml-1" label="About not recorded">Claude Code transcripts do not record an effort level.</InfoTip> : null}</Td>
                <Td align="right">{formatInteger(row.requests)}</Td>
                <Td align="right">{formatCompact(row.tokens)}</Td>
                <Td align="right">{formatPercent(row.share, 0)}</Td>
                <Td align="right">{row.pricedRequests > 0 ? formatUsd(row.cost) : <span className="text-muted">—</span>}</Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
    </Expandable>
  );
}
