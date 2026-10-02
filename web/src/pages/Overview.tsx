import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Activity, CircleDollarSign, Flame, Gauge, Layers, Timer, TrendingUp, Zap } from "lucide-react";
import { useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Badge, Card, CardHeader, Legend, MiniSpark, ModelTag, OutcomeDot, ProgressBar, Segmented, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { barChart, donutChart, heatmapChart, stackedAreaChart } from "../components/chartOptions";
import { COMPOSITION_COLORS } from "../lib/palette";
import { formatCompact, formatCountdown, formatDuration, formatInteger, formatPercent, formatRelative, formatUsd, formatUsdPrecise, shortId } from "../lib/format";
import type { OverviewResponse } from "../types";

export function OverviewPage() {
  const { filters, set } = useFilters();
  const { chartTheme } = useTheme();
  const { search } = useLocation();
  const metric = filters.metric === "cost" || filters.metric === "requests" ? filters.metric : "tokens";
  const groupBy = filters.groupBy === "provider" || filters.groupBy === "effort" ? filters.groupBy : "model";
  const [heatmapMetric, setHeatmapMetric] = useState<"tokens" | "requests">("tokens");
  const [minimumActivity, setMinimumActivity] = useState(0);
  const heatmapFilterKey = JSON.stringify([filters.range, filters.providers, filters.models, filters.efforts, filters.statuses, filters.metric, filters.groupBy, filters.bucket, filters.search]);
  useEffect(() => setMinimumActivity(0), [heatmapMetric, heatmapFilterKey]);

  const query = useEndpoint<OverviewResponse>("/api/overview", filters, { metric, groupBy });
  const data = query.data;

  const seriesOption = useMemo(() => {
    if (!data) return null;
    const labels = data.series.buckets.map(bucket => bucket.label);
    const names = data.series.groups.map(group => group.name);
    const series = names.map(name => ({
      name,
      data: data.series.buckets.map(bucket => bucket.groups[name] ?? 0),
    }));
    const formatter = metric === "cost" ? (value: number) => formatUsd(value) : (value: number) => formatCompact(value);
    return stackedAreaChart(chartTheme, labels, series, { formatter });
  }, [data, chartTheme, metric]);

  const compositionOption = useMemo(() => {
    if (!data) return null;
    const entries = [
      { name: "Fresh input", value: data.composition.freshInput },
      { name: "Cache read", value: data.composition.cacheRead },
      { name: "Cache write", value: data.composition.cacheWrite },
      { name: "Output", value: data.composition.output },
    ].filter(entry => entry.value > 0);
    return donutChart(chartTheme, entries, {
      formatter: value => formatUsdPrecise(value),
      colors: COMPOSITION_COLORS,
      centerValue: formatUsd(data.composition.total),
      centerLabel: "estimated",
    });
  }, [data, chartTheme]);

  const heatmapCells = useMemo(() => data?.heatmap.cells.map(cell => ({
    ...cell,
    value: heatmapMetric === "tokens" ? cell.value : cell.requests,
  })) ?? [], [data, heatmapMetric]);
  const heatmapMax = heatmapCells.reduce((max, cell) => Math.max(max, cell.value), 0);
  const heatmapUnit = heatmapMetric === "tokens" ? "tokens" : "requests";
  const matchingHeatmapCells = heatmapCells.filter(cell => cell.value >= minimumActivity && (heatmapMax > 0 || cell.value > 0)).length;
  const heatmapOption = useMemo(() => {
    if (!data) return null;
    return heatmapChart(chartTheme, heatmapCells, heatmapMax, {
      formatter: value => formatCompact(value), unit: heatmapUnit, minimum: minimumActivity,
    });
  }, [data, chartTheme, heatmapCells, heatmapMax, heatmapUnit, minimumActivity]);

  const contextOption = useMemo(() => {
    if (!data) return null;
    return barChart(chartTheme, data.context.buckets.map(bucket => bucket.name), data.context.buckets.map(bucket => bucket.value), {
      formatter: value => formatCompact(value, 0),
      color: "#2563eb",
    });
  }, [data, chartTheme]);

  const summary = data?.summary;
  const compositionTotal = data ? data.composition.total : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Requests"
          value={summary ? formatInteger(summary.requests) : "—"}
          hint={summary ? `${formatInteger(summary.ok)} ok · ${formatInteger(summary.errors)} failed` : undefined}
          delta={data?.deltas.requests}
          deltaTone="none"
          spark={data?.sparkline.requests}
          icon={<Layers size={13} />}
        />
        <Stat
          label="Tokens"
          value={summary ? formatCompact(summary.tokens.total) : "—"}
          hint={summary ? `${formatCompact(summary.tokens.output)} out · ${formatCompact(summary.tokens.input)} in` : undefined}
          delta={data?.deltas.tokens}
          deltaTone="none"
          spark={data?.sparkline.tokens}
          icon={<Activity size={13} />}
        />
        <Stat
          label="Estimated cost"
          value={summary ? formatUsd(summary.cost) : "—"}
          hint={summary ? `${formatInteger(summary.pricedRequests)} priced · ${formatInteger(summary.unpricedRequests)} unpriced` : undefined}
          delta={data?.deltas.cost}
          deltaTone="none"
          spark={data?.sparkline.cost}
          tone="good"
          icon={<CircleDollarSign size={13} />}
        />
        <Stat
          label="Success rate"
          value={summary ? formatPercent(summary.successRate) : "—"}
          hint={summary ? `${formatInteger(summary.cancelled)} client-closed` : undefined}
          delta={data?.deltas.successRate}
          tone={summary && summary.successRate !== null && summary.successRate < 0.95 ? "warn" : "neutral"}
          icon={<Gauge size={13} />}
        />
        <Stat
          label="Median TTFT"
          value={summary ? formatDuration(summary.ttft.p50) : "—"}
          hint={summary ? `p95 ${formatDuration(summary.ttft.p95)} · ${formatPercent(summary.ttft.coverage, 0)} measured` : undefined}
          delta={data?.deltas.ttftP50}
          deltaTone="inverse"
          tone="info"
          icon={<Timer size={13} />}
        />
        <Stat
          label="Cache savings"
          value={summary ? formatUsd(summary.cache.savingsUsd) : "—"}
          hint={summary ? `${formatPercent(summary.cache.hitRate)} of input served from cache` : undefined}
          delta={data?.deltas.cacheHitRate}
          deltaTone="none"
          tone="good"
          icon={<Zap size={13} />}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Usage over time"
            subtitle={data ? `${data.window.bucket} buckets · ${formatInteger(data.window.requests)} requests in window` : "loading"}
            action={
              <div className="flex items-center gap-1.5">
                <Segmented
                  size="sm"
                  value={metric}
                  options={[
                    { id: "tokens", label: "Tokens" },
                    { id: "cost", label: "Cost" },
                    { id: "requests", label: "Requests" },
                  ]}
                  onChange={value => {
                    set({ metric: value });
                  }}
                />
                <Segmented
                  size="sm"
                  value={groupBy}
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
            {seriesOption ? <Chart option={seriesOption} height={288} /> : null}
          </StateBlock>
        </Card>

        <Card>
          <CardHeader
            title="Cost composition"
            subtitle="Estimated from published rates per token class"
            action={<Link to={{ pathname: "/cost", search }} className="text-[11px] font-medium text-accent">Details</Link>}
          />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || compositionTotal === 0}>
            <div className="flex flex-col items-center gap-3 sm:flex-row">
              {compositionOption ? <Chart option={compositionOption} height={172} className="max-w-[190px]" /> : null}
              {data ? (
                <div className="w-full min-w-0 flex-1">
                  <Legend
                    items={[
                      { label: "Fresh input", color: COMPOSITION_COLORS["Fresh input"]!, value: formatUsd(data.composition.freshInput) },
                      { label: "Cache read", color: COMPOSITION_COLORS["Cache read"]!, value: formatUsd(data.composition.cacheRead) },
                      { label: "Cache write", color: COMPOSITION_COLORS["Cache write"]!, value: formatUsd(data.composition.cacheWrite) },
                      { label: "Output", color: COMPOSITION_COLORS.Output!, value: formatUsd(data.composition.output) },
                    ].filter(entry => entry.value !== formatUsd(0))}
                  />
                  <div className="mt-3 rounded-xl bg-accent-soft p-2.5">
                    <p className="flex items-center gap-1.5 text-[11px] font-medium text-accent">
                      <Zap size={12} /> Cache saved {formatUsd(data.summary.cache.savingsUsd)}
                    </p>
                    <p className="mt-0.5 text-[10.5px] leading-4 text-accent/80">
                      {formatCompact(data.summary.cache.readTokens)} cached tokens re-read at the cache rate instead of full input price.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
            {data && data.composition.unpricedRequests > 0 ? (
              <p className="mt-3 text-[10.5px] leading-4 text-muted">
                {formatInteger(data.composition.unpricedRequests)} requests had no published price (subscription or free routes) and are excluded from cost.
              </p>
            ) : null}
          </StateBlock>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card>
          <CardHeader
            title="Model leaderboard"
            subtitle="Share of tokens in the selected window"
            action={<Link to={{ pathname: "/models", search }} className="text-[11px] font-medium text-accent">All models</Link>}
          />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.topModels.length === 0}>
            <ul className="space-y-2.5">
              {data?.topModels.map(model => (
                <li key={model.key}>
                  <div className="flex items-baseline justify-between gap-2">
                    <ModelTag model={model.key} className="max-w-[190px] text-[12px]" />
                    <span className="num shrink-0 text-[11px] text-muted">
                      {formatCompact(model.tokens)} · {formatUsd(model.cost)}
                    </span>
                  </div>
                  <ProgressBar value={model.share} max={data.topModels[0]?.share ?? 1} className="mt-1.5" />
                  <div className="mt-1 flex justify-between text-[10.5px] text-muted">
                    <span>{formatPercent(model.share)} of tokens</span>
                    <span className="num">
                      {model.successRate !== null ? formatPercent(model.successRate) : "—"} ok · p50 {formatDuration(model.p50DurationMs)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </StateBlock>
        </Card>

        <Card>
          <CardHeader title="Activity heatmap" subtitle={`${heatmapMetric === "tokens" ? "Tokens" : "Requests"} by weekday and hour (local time)`} action={
            <Segmented size="sm" value={heatmapMetric} options={[{ id: "tokens", label: "Tokens" }, { id: "requests", label: "Requests" }]} onChange={value => { setHeatmapMetric(value); setMinimumActivity(0); }} />
          } />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || heatmapMax === 0}>
            <label className="mb-1 block text-[10.5px] text-muted">
              <span className="mb-0.5 flex flex-wrap items-center justify-between gap-x-2">
                <span>Minimum activity</span>
                <span className="num font-medium text-ink" aria-live="polite">At least {formatCompact(minimumActivity)} {heatmapUnit} · {matchingHeatmapCells} of 168 cells</span>
              </span>
              <input
                aria-label={`Minimum activity in ${heatmapUnit}`}
                type="range" min={0} max={heatmapMax} step={Math.max(1, Math.floor(heatmapMax / 100))}
                value={Math.min(minimumActivity, heatmapMax)} disabled={heatmapMax === 0}
                onChange={event => setMinimumActivity(Number(event.currentTarget.value))}
                className="heatmap-slider w-full disabled:opacity-50"
              />
            </label>
            {heatmapOption ? <Chart option={heatmapOption} height={196} /> : null}
          </StateBlock>
          <div className="mt-2 flex items-center justify-between text-[10.5px] text-muted">
            <span>quiet</span>
            <span className="mx-2 h-1.5 flex-1 rounded-full bg-gradient-to-r from-line to-accent" />
            <span>{formatCompact(heatmapMax)} {heatmapUnit} peak</span>
          </div>
        </Card>

        <Card>
          <CardHeader title="Quota" subtitle="Plan windows reported by the provider" action={<Link to={{ pathname: "/quota", search }} className="text-[11px] font-medium text-accent">Details</Link>} />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.quota.windows.length === 0} emptyLabel="No quota samples recorded">
            <ul className="space-y-3">
              {data?.quota.windows.map(window => {
                const burn = data.quota.burn.find(entry => entry.account === window.account && entry.window === window.window);
                const tone = window.usedPercent >= 90 ? "bad" : window.usedPercent >= 70 ? "warn" : "accent";
                return (
                  <li key={`${window.account}-${window.window}`}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-[11.5px] font-medium text-ink">{window.window} · {window.account === "__main__" ? "main policy" : shortId(window.account, 14)}</p>
                      <span className="num text-[12px] font-semibold text-ink">{window.usedPercent}%</span>
                    </div>
                    <ProgressBar value={window.usedPercent} max={100} tone={tone} className="mt-1.5" />
                    <div className="mt-1 flex justify-between text-[10.5px] text-muted">
                      <span>{window.resetAtMs ? `resets ${formatCountdown(window.resetAtMs)}` : "no reset reported"}</span>
                      <span>
                        {!burn || burn.status === "insufficient"
                          ? "no data in range"
                          : burn.percentPerDay > 0
                            ? `${burn.percentPerDay.toFixed(2)}%/day`
                            : "flat"}
                      </span>
                    </div>
                    {burn?.willExhaustBeforeReset ? (
                      <p className="mt-1 flex items-center gap-1 text-[10.5px] font-medium text-warn">
                        <Flame size={11} /> projected to run out before reset
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </StateBlock>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Recent requests" subtitle="Newest rows in the ledger" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.recent.length === 0}>
            <TableShell>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Model</Th>
                  <Th align="right">Tokens</Th>
                  <Th align="right">Cost</Th>
                  <Th align="right">TTFT</Th>
                  <Th align="right">Total</Th>
                  <Th align="center">Status</Th>
                </tr>
              </thead>
              <tbody>
                {data?.recent.map(row => (
                  <tr key={row.id} className="transition hover:bg-surface-2">
                    <Td className="whitespace-nowrap text-muted">{formatRelative(row.ts)}</Td>
                    <Td><ModelTag model={row.model} provider={row.provider} className="max-w-[210px]" /></Td>
                    <Td align="right">{formatCompact(row.totalTokens)}</Td>
                    <Td align="right">{row.priced ? formatUsd(row.cost) : <span className="text-muted">unpriced</span>}</Td>
                    <Td align="right">{formatDuration(row.ttftMs)}</Td>
                    <Td align="right">{formatDuration(row.durationMs)}</Td>
                    <Td align="center">
                      <span className="inline-flex items-center gap-1.5">
                        <OutcomeDot outcome={row.outcome} />
                        <span className="num text-[10.5px] text-muted">{row.status}</span>
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </StateBlock>
        </Card>

        <div className="space-y-3">
          <Card>
            <CardHeader title="Context pressure" subtitle="Input size distribution per request" />
            <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
              {contextOption ? <Chart option={contextOption} height={148} /> : null}
              <div className="mt-2 flex justify-between text-[10.5px] text-muted">
                <span>p50 {formatCompact(data?.context.p50Input ?? 0)}</span>
                <span>p95 {formatCompact(data?.context.p95Input ?? 0)}</span>
                <span>max {formatCompact(data?.context.maxInput ?? 0)}</span>
              </div>
            </StateBlock>
          </Card>
          <Card>
            <CardHeader title="Biggest conversations" subtitle="Tokens per session" action={<Link to={{ pathname: "/conversations", search }} className="text-[11px] font-medium text-accent">All</Link>} />
            <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.topConversations.length === 0}>
              <ul className="space-y-2">
                {data?.topConversations.map(conversation => (
                  <li key={conversation.id} className="flex items-center justify-between gap-2">
                    <Link to={{ pathname: `/conversations/${conversation.id}`, search }} className="min-w-0 truncate font-mono text-[11px] text-info hover:underline">
                      {shortId(conversation.id, 12)}
                    </Link>
                    <span className="num shrink-0 text-[11px] text-muted">
                      {formatCompact(conversation.tokens)} · {formatInteger(conversation.requests)} req
                    </span>
                  </li>
                ))}
              </ul>
            </StateBlock>
          </Card>
          <Card>
            <CardHeader title="Throughput & latency" subtitle="End-to-end output rate" />
            <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10.5px] uppercase tracking-[0.04em] text-muted">Tokens/sec p50</p>
                  <p className="num mt-1 text-[18px] font-semibold text-ink">{summary?.throughput.p50?.toFixed(1) ?? "—"}</p>
                  <MiniSpark values={data?.sparkline.tokens ?? []} className="mt-1" />
                </div>
                <div>
                  <p className="text-[10.5px] uppercase tracking-[0.04em] text-muted">Latency p95</p>
                  <p className="num mt-1 text-[18px] font-semibold text-ink">{formatDuration(summary?.latency.p95)}</p>
                  <p className="mt-1 text-[10.5px] text-muted">p50 {formatDuration(summary?.latency.p50)}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Badge tone="info"><TrendingUp size={10} /> {formatInteger(summary?.retries.sends ?? 0)} upstream sends</Badge>
                {summary && summary.retryOverhead.tokens > 0 ? (
                  <Badge tone="warn">{formatCompact(summary.retryOverhead.tokens)} tokens re-sent on retries</Badge>
                ) : null}
                <Badge>{formatPercent(summary?.metering.coverage, 0)} metered</Badge>
              </div>
            </StateBlock>
          </Card>
        </div>
      </div>

      <p className="px-1 text-[10.5px] text-muted">
        Source: <span className="font-mono">usage.jsonl</span>, <span className="font-mono">spend-ledger.jsonl</span> and <span className="font-mono">codex-quota-cache.json</span>
        {query.dataUpdatedAt ? ` · recomputed ${formatRelative(query.dataUpdatedAt)}` : ""}
      </p>
    </div>
  );
}
