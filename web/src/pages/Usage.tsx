import { useEffect, useMemo, useState } from "react";
import { useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Card, CardHeader, Segmented, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { barChart, heatmapChart, lineChart, stackedAreaChart } from "../components/chartOptions";
import { formatCompact, formatDuration, formatPercent } from "../lib/format";
import type { UsageResponse } from "../types";

export function UsagePage() {
  const { filters, set } = useFilters();
  const { chartTheme } = useTheme();
  const query = useEndpoint<UsageResponse>("/api/usage", filters, { metric: filters.metric, groupBy: filters.groupBy });
  const tokenHeatmapQuery = useEndpoint<UsageResponse>("/api/usage", filters, { metric: "tokens", groupBy: filters.groupBy });
  const data = query.data;
  const [heatmapMetric, setHeatmapMetric] = useState<"tokens" | "requests">("tokens");
  const [minimumActivity, setMinimumActivity] = useState(0);
  const filterKey = JSON.stringify([filters.range, filters.providers, filters.models, filters.efforts, filters.statuses, filters.metric, filters.search]);
  useEffect(() => setMinimumActivity(0), [heatmapMetric, filterKey]);

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
                    type="range" min={0} max={heatmapMax} step={1}
                    value={Math.min(minimumActivity, heatmapMax)} disabled={heatmapMax === 0}
                    onChange={event => setMinimumActivity(Number(event.currentTarget.value))}
                    className="w-full accent-blue-600 disabled:opacity-50"
                  />
                </label>
                <div className="flex items-center gap-2 text-[10px] text-muted" aria-label={`${heatmapUnit} scale from 0 to ${formatCompact(heatmapMax)}`}>
                  <span>0</span><span className="h-2 w-20 rounded-full" style={{ background: chartTheme.split === "#1e293b" ? "linear-gradient(90deg, #132033, #1d4ed8, #22c55e, #fbbf24)" : "linear-gradient(90deg, #eef1f5, #bfdbfe, #4ade80, #facc15)" }} /><span>{formatCompact(heatmapMax)} {heatmapUnit}</span>
                </div>
              </div>
              {heatmapMax > 0
                ? <Chart option={heatmapOption} height={230} />
                : <p className="flex h-[120px] items-center justify-center text-[12px] text-muted">No activity for these filters</p>}
            </> : null}
          </StateBlock>
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
