import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Coins, Percent, PiggyBank, Zap } from "lucide-react";
import { exportUrl, useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Card, CardHeader, Legend, ProgressBar, Segmented, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { barChart, donutChart, lineChart, stackedBarChart } from "../components/chartOptions";
import { COMPOSITION_COLORS } from "../lib/palette";
import { formatCompact, formatInteger, formatPercent, formatUsd, formatUsdPrecise, shortId } from "../lib/format";
import type { CostResponse } from "../types";

export function CostPage() {
  const { filters, set } = useFilters();
  const { chartTheme } = useTheme();
  const query = useEndpoint<CostResponse>("/api/cost", filters, { groupBy: filters.groupBy });
  const data = query.data;
  const summary = data?.summary;

  const costSeriesOption = useMemo(() => {
    if (!data) return null;
    const labels = data.series.buckets.map(bucket => bucket.label);
    const series = data.series.groups.map(group => ({
      name: group.name,
      data: data.series.buckets.map(bucket => bucket.groups[group.name] ?? 0),
    }));
    return stackedBarChart(chartTheme, labels, series, { formatter: value => formatUsdPrecise(value) });
  }, [data, chartTheme]);

  const cumulativeOption = useMemo(() => {
    if (!data) return null;
    return lineChart(chartTheme, data.cumulative.map(point => point.label), [
      { name: "Cumulative cost", data: data.cumulative.map(point => point.cumulative), area: true },
      { name: "Per bucket", data: data.cumulative.map(point => point.value), dashed: true },
    ], { formatter: value => formatUsd(value) });
  }, [data, chartTheme]);

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

  const perModelOption = useMemo(() => {
    if (!data) return null;
    const models = data.byModel.filter(model => (model.costPer1MTokens ?? 0) > 0).slice(0, 10);
    return barChart(chartTheme, models.map(model => model.key), models.map(model => model.costPer1MTokens ?? 0), {
      formatter: value => `$${value.toFixed(2)}`,
      horizontal: true,
      showLabels: true,
    });
  }, [data, chartTheme]);

  const savingsOption = useMemo(() => {
    if (!data) return null;
    return lineChart(chartTheme, data.cache.map(point => point.label), [
      { name: "Cache savings", data: data.cache.map(point => point.savingsUsd), area: true },
    ], { formatter: value => formatUsd(value), showLegend: false });
  }, [data, chartTheme]);

  const unpricedShare = summary ? summary.unpricedRequests / Math.max(1, summary.requests) : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="Estimated cost"
          value={summary ? formatUsd(summary.cost) : "—"}
          hint={data ? `${formatInteger(summary?.pricedRequests ?? 0)} priced requests` : undefined}
          delta={undefined}
          tone="good"
          icon={<Coins size={13} />}
        />
        <Stat label="Cost / 1M tokens" value={summary && summary.tokens.total > 0 ? `$${(summary.cost / summary.tokens.total * 1e6).toFixed(2)}` : "—"} hint="Blended rate across every token class" tone="info" />
        <Stat label="Cache savings" value={summary ? formatUsd(summary.cache.savingsUsd) : "—"} hint={summary ? `vs paying full input price` : undefined} tone="good" icon={<PiggyBank size={13} />} />
        <Stat label="Output spend" value={data ? formatUsd(data.composition.output) : "—"} hint={data ? `${formatPercent(data.composition.output / Math.max(1, data.composition.total), 1)} of total` : undefined} tone="warn" icon={<Zap size={13} />} />
        <Stat
          label="Unpriced share"
          value={summary ? formatPercent(unpricedShare) : "—"}
          hint="Requests on subscription or free routes"
          tone={unpricedShare > 0.2 ? "warn" : "neutral"}
          icon={<Percent size={13} />}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Spend over time"
            subtitle="Stacked by the selected dimension"
            action={
              <Segmented
                size="sm"
                value={filters.groupBy as "model" | "provider" | "effort"}
                options={[
                  { id: "model", label: "Model" },
                  { id: "provider", label: "Provider" },
                  { id: "effort", label: "Effort" },
                ]}
                onChange={groupBy => set({ groupBy })}
              />
            }
          />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.series.buckets.length === 0}>
            {costSeriesOption ? <Chart option={costSeriesOption} height={268} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Where the dollars go" subtitle="Split by token class" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.composition.total === 0}>
            <div className="flex flex-col items-center gap-3">
              {compositionOption ? <Chart option={compositionOption} height={196} className="max-w-[220px]" /> : null}
              {data ? (
                <div className="w-full">
                  <Legend
                    items={[
                      { label: "Fresh input", color: COMPOSITION_COLORS["Fresh input"]!, value: formatUsd(data.composition.freshInput) },
                      { label: "Cache read", color: COMPOSITION_COLORS["Cache read"]!, value: formatUsd(data.composition.cacheRead) },
                      { label: "Cache write", color: COMPOSITION_COLORS["Cache write"]!, value: formatUsd(data.composition.cacheWrite) },
                      { label: "Output", color: COMPOSITION_COLORS.Output!, value: formatUsd(data.composition.output) },
                    ].filter(entry => entry.value !== formatUsd(0))}
                  />
                </div>
              ) : null}
            </div>
          </StateBlock>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title="Cumulative spend" subtitle="Running total for the selected window" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {cumulativeOption ? <Chart option={cumulativeOption} height={236} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Cache savings over time" subtitle="What caching returned to you" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {savingsOption ? <Chart option={savingsOption} height={236} /> : null}
          </StateBlock>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Blended price per 1M tokens" subtitle="Cheapest to most expensive model actually used" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.byModel.length === 0}>
            {perModelOption ? <Chart option={perModelOption} height={Math.max(180, (data?.byModel.filter(m => (m.costPer1MTokens ?? 0) > 0).slice(0, 10).length ?? 0) * 26 + 40)} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Most expensive sessions" subtitle="Conversations ranked by spend" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.topConversations.length === 0}>
            <ul className="space-y-2.5">
              {data?.topConversations.map(conversation => (
                <li key={conversation.id}>
                  <div className="flex items-center justify-between gap-2">
                    <Link to={`/conversations/${conversation.id}`} className="min-w-0 truncate font-mono text-[11px] text-info hover:underline">
                      {shortId(conversation.id, 12)}
                    </Link>
                    <span className="num shrink-0 text-[11.5px] font-semibold text-ink">{formatUsd(conversation.cost)}</span>
                  </div>
                  <ProgressBar value={conversation.cost} max={data.topConversations[0]?.cost ?? 1} className="mt-1.5" />
                  <p className="mt-1 text-[10.5px] text-muted">
                    {formatInteger(conversation.requests)} requests · {formatCompact(conversation.tokens)} tokens
                  </p>
                </li>
              ))}
            </ul>
          </StateBlock>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Cost by model"
          subtitle="Blended rates come from opencodex's own pricing engine, including any overlays you set with ocx models set-price"
          action={
            <a href={exportUrl(filters, "models")} className="rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] font-medium text-ink-soft transition hover:border-line-strong">
              Export CSV
            </a>
          }
        />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.byModel.length === 0}>
          <TableShell>
            <thead>
              <tr>
                <Th>Model</Th>
                <Th align="right">Requests</Th>
                <Th align="right">Tokens</Th>
                <Th align="right">Cost</Th>
                <Th align="right">Cost / 1M</Th>
                <Th align="right">Share</Th>
                <Th align="right">Unpriced</Th>
              </tr>
            </thead>
            <tbody>
              {data?.byModel.map(model => (
                <tr key={model.key} className="transition hover:bg-surface-2">
                  <Td className="max-w-[220px] truncate font-medium text-ink">{model.key}</Td>
                  <Td align="right">{formatInteger(model.requests)}</Td>
                  <Td align="right">{formatCompact(model.tokens)}</Td>
                  <Td align="right">{formatUsd(model.cost)}</Td>
                  <Td align="right">{model.costPer1MTokens ? `$${model.costPer1MTokens.toFixed(2)}` : "—"}</Td>
                  <Td align="right">{formatPercent(model.costShare)}</Td>
                  <Td align="right">{model.unpricedRequests > 0 ? formatInteger(model.unpricedRequests) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </StateBlock>
      </Card>
    </div>
  );
}
