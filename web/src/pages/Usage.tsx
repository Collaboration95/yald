import { useEffect, useMemo, useState } from "react";
import { useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Card, CardHeader, Segmented, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { barChart, heatmapChart, lineChart, stackedAreaChart } from "../components/chartOptions";
import { formatCompact, formatDuration, formatPercent } from "../lib/format";
import type { UsageHeatmapDatesResponse, UsageResponse } from "../types";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DETAIL_PAGE_SIZE = 20;
type HeatmapSelection = { weekday: number; hour: number; filterKey: string; metric: "tokens" | "requests" };

function formatLocalDate(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(timestamp);
}

export function UsagePage() {
  const { filters, set } = useFilters();
  const { chartTheme } = useTheme();
  const query = useEndpoint<UsageResponse>("/api/usage", filters, { metric: filters.metric, groupBy: filters.groupBy });
  const tokenHeatmapQuery = useEndpoint<UsageResponse>("/api/usage", filters, { metric: "tokens", groupBy: filters.groupBy });
  const data = query.data;
  const [heatmapMetric, setHeatmapMetric] = useState<"tokens" | "requests">("tokens");
  const [minimumActivity, setMinimumActivity] = useState(0);
  const filterKey = JSON.stringify([filters.range, filters.providers, filters.models, filters.efforts, filters.statuses, filters.metric, filters.groupBy, filters.bucket, filters.search]);
  useEffect(() => setMinimumActivity(0), [heatmapMetric, filterKey]);
  const [selection, setSelection] = useState<HeatmapSelection | null>(null);
  const [detailOffset, setDetailOffset] = useState(0);
  const [detailRows, setDetailRows] = useState<UsageHeatmapDatesResponse["dates"]>([]);
  const activeSelection = selection?.filterKey === filterKey && selection.metric === heatmapMetric ? selection : null;
  const detailQuery = useEndpoint<UsageHeatmapDatesResponse>("/api/usage/heatmap-dates", filters, {
    weekday: activeSelection?.weekday, hour: activeSelection?.hour, metric: heatmapMetric, limit: DETAIL_PAGE_SIZE, offset: detailOffset,
  }, { enabled: Boolean(activeSelection), refetchInterval: false });
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

  const compositionOption = useMemo(() => {
    if (!data) return null;
    const labels = data.composition.map(point => point.label);
    const series = [
      { name: "Cache read", data: data.composition.map(point => point.cacheRead) },
      { name: "Fresh input", data: data.composition.map(point => point.freshInput) },
      { name: "Output", data: data.composition.map(point => point.output) },
      { name: "Reasoning", data: data.composition.map(point => point.reasoning) },
    ].filter(entry => entry.data.some(value => value > 0));
    return stackedAreaChart(chartTheme, labels, series, { formatter: value => formatCompact(value) });
  }, [data, chartTheme]);

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
    return lineChart(chartTheme, data.cache.map(point => point.label), [
      { name: "Cache hit rate", data: data.cache.map(point => point.hitRate === null ? null : point.hitRate * 100) },
      { name: "Savings (USD)", data: data.cache.map(point => point.savingsUsd), dashed: true },
    ], { formatter: value => value.toFixed(value < 10 ? 2 : 0) });
  }, [data, chartTheme]);

  const heatmap = tokenHeatmapQuery.data?.heatmap;
  const heatmapCells = useMemo(() => heatmap?.cells.map(cell => ({
    ...cell,
    value: heatmapMetric === "tokens" ? cell.value : cell.requests,
  })) ?? [], [heatmap, heatmapMetric]);
  const heatmapMax = heatmapCells.reduce((max, cell) => Math.max(max, cell.value), 0);
  const matchingCells = heatmapCells.filter(cell => cell.value >= minimumActivity && (heatmapMax > 0 || cell.value > 0)).length;
  const heatmapUnit = heatmapMetric === "tokens" ? "tokens" : "requests";
  const heatmapOption = useMemo(() => {
    if (!heatmap) return null;
    return heatmapChart(chartTheme, heatmapCells, heatmapMax, {
      formatter: value => formatCompact(value), unit: heatmapUnit, minimum: minimumActivity,
    });
  }, [heatmap, heatmapCells, heatmapMax, chartTheme, heatmapUnit, minimumActivity]);
  const chooseCell = (weekday: number, hour: number) => {
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
  }), [heatmapCells, filterKey, heatmapMetric]);
  const keyboardCell = activeSelection ? activeSelection.weekday * 24 + activeSelection.hour : 0;

  const contextOption = useMemo(() => {
    if (!data) return null;
    return barChart(chartTheme, data.context.buckets.map(bucket => bucket.name), data.context.buckets.map(bucket => bucket.value), {
      formatter: value => formatCompact(value, 0),
      color: "#7c3aed",
    });
  }, [data, chartTheme]);

  const summary = data?.summary;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total tokens" value={summary ? formatCompact(summary.tokens.total) : "—"} hint={summary ? `${formatCompact(summary.tokens.cacheRead)} from cache` : undefined} tone="neutral" />
        <Stat label="Output tokens" value={summary ? formatCompact(summary.tokens.output) : "—"} hint={summary ? `${formatPercent(summary.tokens.output / Math.max(1, summary.tokens.total), 2)} of all tokens` : undefined} tone="info" />
        <Stat label="Reasoning tokens" value={summary ? formatCompact(summary.tokens.reasoning) : "—"} hint={summary ? `${formatPercent(summary.tokens.reasoning / Math.max(1, summary.tokens.output), 1)} of output` : undefined} tone="violet" />
        <Stat label="Cache hit rate" value={summary ? formatPercent(summary.cache.hitRate) : "—"} hint={summary ? `${formatCompact(summary.cache.readTokens)} cache reads` : undefined} tone="good" />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Token composition"
            subtitle="Input tokens already include cache reads, so fresh input is what you paid full price for"
          />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.composition.length === 0}>
            {compositionOption ? <Chart option={compositionOption} height={272} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Cache efficiency" subtitle="Hit rate and estimated dollars saved by caching" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {cacheOption ? <Chart option={cacheOption} height={272} /> : null}
          </StateBlock>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Grouped volume"
          subtitle="Switch dimension to see which axis the tokens move on"
          action={
            <div className="flex items-center gap-1.5">
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
                  { id: "account", label: "Account" },
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

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="flex-col sm:flex-row" title="Activity heatmap" subtitle="Local weekday and hour activity" action={
            <Segmented size="sm" value={heatmapMetric} options={[{ id: "tokens", label: "Tokens" }, { id: "requests", label: "Requests" }]} onChange={setHeatmapMetric} />
          } />
          <StateBlock loading={tokenHeatmapQuery.isLoading} error={tokenHeatmapQuery.error} empty={!heatmap}>
            {heatmapOption ? <>
              <div className="mb-2 grid gap-2 sm:grid-cols-[minmax(160px,1fr)_auto] sm:items-center">
                <label className="min-w-0 text-[11.5px] text-muted">
                  <span className="mb-1 flex flex-wrap items-center justify-between gap-x-2">
                    <span>Minimum activity</span>
                    <span className="num font-medium text-ink" aria-live="polite">At least {formatCompact(minimumActivity)} {heatmapUnit} · {matchingCells} of 168 cells</span>
                  </span>
                  <input
                    aria-label={`Minimum activity in ${heatmapUnit}`}
                    type="range" min={0} max={heatmapMax} step={Math.max(1, Math.floor(heatmapMax / 100))}
                    value={Math.min(minimumActivity, heatmapMax)} disabled={heatmapMax === 0}
                    onChange={event => setMinimumActivity(Number(event.currentTarget.value))}
                    className="heatmap-slider w-full disabled:opacity-50"
                  />
                </label>
                <div className="flex items-center gap-2 text-[10px] text-muted" aria-label={`${heatmapUnit} scale from 0 to ${formatCompact(heatmapMax)}`}>
                  <span>0</span><span className="h-2 w-20 rounded-full" style={{ background: chartTheme.split === "#1e293b" ? "linear-gradient(90deg, #132033, #1d4ed8, #22c55e, #fbbf24)" : "linear-gradient(90deg, #eef1f5, #bfdbfe, #4ade80, #facc15)" }} /><span>{formatCompact(heatmapMax)} {heatmapUnit}</span>
                </div>
              </div>
              {heatmapMax > 0
                ? <>
                  <Chart option={heatmapOption} height={230} onEvents={heatmapEvents} />
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
              <div><h3 className="text-[13px] font-semibold text-ink">{WEEKDAYS[activeSelection.weekday]} at {String(activeSelection.hour).padStart(2, "0")}:00 · {detailQuery.data ? `${formatLocalDate(detailQuery.data.window.from, detailQuery.data.window.timeZone)} – ${formatLocalDate(detailQuery.data.window.to, detailQuery.data.window.timeZone)} (${detailQuery.data.window.timeZone})` : filters.range}</h3><p className="text-[11px] text-muted">Ranked dates by {heatmapUnit}</p></div>
              <button type="button" className="rounded px-2 py-1 text-[11px] text-muted hover:bg-surface-2 hover:text-ink" onClick={() => { setSelection(null); setDetailRows([]); setDetailOffset(0); }}>Clear selection</button>
            </div>
            {detailQuery.isLoading && detailOffset === 0 ? <p className="py-4 text-center text-[12px] text-muted">Loading dates…</p> : null}
            {detailQuery.error ? <div className="py-3 text-center text-[12px] text-danger">Could not load dates. <button className="underline" onClick={() => void detailQuery.refetch()}>Try again</button></div> : null}
            {!detailQuery.isLoading && !detailQuery.error && detailQuery.data?.totalDates === 0 ? <p className="py-4 text-center text-[12px] text-muted">No dates with activity in this cell.</p> : null}
            {detailRows.length > 0 ? <>
              <div className="mb-2 flex justify-between text-[11px] text-muted"><span>{formatCompact(detailQuery.data?.total ?? 0)} {heatmapUnit} total</span><span>{detailRows.length} of {detailQuery.data?.totalDates ?? detailRows.length} dates</span></div>
              <div className="max-h-56 overflow-y-auto rounded border border-line"><table className="w-full text-[11px]"><thead className="sticky top-0 bg-surface text-muted"><tr><Th>Date</Th><Th align="right">{heatmapUnit}</Th><Th align="right">Requests</Th></tr></thead><tbody>
                {detailRows.map(row => <tr key={row.date} className="border-t border-line"><Td>{row.date}</Td><Td align="right">{formatCompact(row.value)}</Td><Td align="right">{row.requests.toLocaleString()}</Td></tr>)}
              </tbody></table></div>
              {detailQuery.data?.hasMore ? <button type="button" disabled={detailQuery.isFetching} className="mt-2 w-full rounded border border-line px-3 py-1.5 text-[11px] text-ink disabled:opacity-50" onClick={() => setDetailOffset(detailRows.length)}>{detailQuery.isFetching ? "Loading…" : "Reveal more dates"}</button> : null}
            </> : null}
          </section> : null}
        </Card>
        <Card>
          <CardHeader title="Context pressure" subtitle="Input tokens per request" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {contextOption ? <Chart option={contextOption} height={180} /> : null}
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[10px] uppercase tracking-[0.04em] text-muted">p50</p>
                <p className="num text-[12.5px] font-semibold text-ink">{formatCompact(data?.context.p50Input ?? 0)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-[0.04em] text-muted">p95</p>
                <p className="num text-[12.5px] font-semibold text-ink">{formatCompact(data?.context.p95Input ?? 0)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-[0.04em] text-muted">max</p>
                <p className="num text-[12.5px] font-semibold text-ink">{formatCompact(data?.context.maxInput ?? 0)}</p>
              </div>
            </div>
          </StateBlock>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card>
          <CardHeader title="By model" subtitle="Tokens and cost share" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.byModel.length === 0}>
            <BreakdownTable rows={data?.byModel ?? []} dimension="Model" />
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="By effort" subtitle="Reasoning effort selection" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.byEffort.length === 0}>
            <BreakdownTable rows={data?.byEffort ?? []} dimension="Effort" />
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="By route & provider" subtitle="How requests were routed" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            <BreakdownTable rows={[...(data?.byRoute ?? []), ...(data?.byProvider ?? [])]} dimension="Dimension" />
          </StateBlock>
        </Card>
      </div>
    </div>
  );
}

function BreakdownTable({ rows, dimension }: { rows: { key: string; requests: number; tokens: number; cost: number; share: number; p50DurationMs: number | null; successRate: number | null }[]; dimension: string }) {
  return (
    <TableShell className="max-h-[300px] overflow-y-auto">
      <thead>
        <tr>
          <Th>{dimension}</Th>
          <Th align="right">Req</Th>
          <Th align="right">Tokens</Th>
          <Th align="right">Share</Th>
          <Th align="right">Cost</Th>
          <Th align="right">p50</Th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 12).map(row => (
          <tr key={row.key} className="transition hover:bg-surface-2">
            <Td className="max-w-[180px] truncate">{row.key}</Td>
            <Td align="right">{row.requests.toLocaleString()}</Td>
            <Td align="right">{formatCompact(row.tokens)}</Td>
            <Td align="right">{formatPercent(row.share)}</Td>
            <Td align="right">{row.cost > 0 ? `$${row.cost.toFixed(2)}` : "—"}</Td>
            <Td align="right">{formatDuration(row.p50DurationMs)}</Td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}
