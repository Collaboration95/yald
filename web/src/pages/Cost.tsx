import { useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { Coins, Trophy } from "lucide-react";
import { conversationLink, exportUrl, sourceLabel, useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Card, CardHeader, Expandable, InfoTip, ModelTag, ProgressBar, Segmented, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { lineChart, stackedBarChart } from "../components/chartOptions";
import { formatCompact, formatInteger, formatPercent, formatUsd, formatUsdAxis, sessionLabel } from "../lib/format";
import { TokenClassCard, useInView } from "./CostStructure";
import type { CostResponse, SpendStructureResponse } from "../types";

export function CostPage() {
  const { filters, set } = useFilters();
  const { chartTheme } = useTheme();
  const { search } = useLocation();
  const groupBy = filters.groupBy === "provider" || filters.groupBy === "effort" ? filters.groupBy : "model";
  const query = useEndpoint<CostResponse>("/api/cost", filters, { groupBy });
  const data = query.data;
  const summary = data?.summary;
  // The structure sections have their own endpoint, fetched once this point nears the viewport, so /api/cost stays as fast as before.
  const [sentinel, inView] = useInView<HTMLDivElement>();
  const structure = useEndpoint<SpendStructureResponse>("/api/cost/structure", { ...filters, groupBy: "", metric: "" }, {}, { enabled: inView });
  const section = { data: structure.data, loading: structure.isLoading && inView, error: structure.error };
  const top10 = structure.data?.concentration.top10Sessions;

  const costSeriesOption = useMemo(() => {
    if (!data) return null;
    const labels = data.series.buckets.map(bucket => bucket.label);
    const series = data.series.groups.map(group => ({
      name: group.name,
      data: data.series.buckets.map(bucket => bucket.groups[group.name] ?? 0),
    }));
    return stackedBarChart(chartTheme, labels, series, { formatter: value => formatUsd(value) });
  }, [data, chartTheme]);

  const cumulativeOption = useMemo(() => {
    if (!data) return null;
    return lineChart(chartTheme, data.cumulative.map(point => point.label), [
      { name: "Cumulative cost", data: data.cumulative.map(point => point.cumulative), area: true },
    ], { formatter: value => formatUsdAxis(value), showLegend: false });
  }, [data, chartTheme]);

  // Models with nothing priced (free routes, test names) would pad the table with $0 rows: they fold into "+N unpriced".
  const priced = data?.byModel.filter(model => model.pricedRequests > 0) ?? [];
  const unpriced = data?.byModel.filter(model => model.pricedRequests === 0) ?? [];
  const unpricedShare = summary ? summary.unpricedRequests / Math.max(1, summary.requests) : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat
          label="Estimated cost"
          value={summary && summary.pricedRequests > 0 ? formatUsd(summary.cost) : "—"}
          info={`API list-price equivalents, not a bill.${unpricedShare >= 0.05 && summary ? ` ${formatInteger(summary.unpricedRequests)} of ${formatInteger(summary.requests)} requests have no list price (subscription or free routes) and add no dollars.` : ""}`}
          tone="good"
          icon={<Coins size={13} />}
        />
        <Stat label="Cost / 1M tokens" value={summary && data && summary.pricedRequests > 0 && data.pricedTokens > 0 ? formatUsd(summary.cost / data.pricedTokens * 1e6) : "—"} info="Priced cost over priced tokens, every token class." tone="info" />
        <Stat label="Top 10 sessions" value={top10 ? formatPercent(top10.share, 0) : "—"} hint="of spend" icon={<Trophy size={13} />} />
      </div>

      <Card>
        <CardHeader
          title="Spend over time"
          action={
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
          }
        />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.series.buckets.length === 0}>
          {costSeriesOption ? <Chart option={costSeriesOption} height={288} /> : null}
        </StateBlock>
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title="Cumulative spend" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {cumulativeOption ? <Chart option={cumulativeOption} height={236} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Most expensive sessions" action={<Link to={{ pathname: "/sessions", search }} className="text-[11px] font-medium text-accent">All sessions</Link>} />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.topConversations.length === 0}>
            <ul className="space-y-2.5">
              {data?.topConversations.slice(0, 6).map(session => (
                <li key={JSON.stringify([session.source, session.id])}>
                  <div className="flex items-center justify-between gap-2">
                    <Link to={conversationLink(session, search)} className="min-w-0 truncate text-[11.5px] text-info hover:underline" title={`${session.project ?? session.id} · ${sourceLabel(session.source)}`}>
                      {sessionLabel(session)}
                    </Link>
                    <span className="num shrink-0 text-[11.5px] font-semibold text-ink">{session.pricedRequests > 0 ? formatUsd(session.cost) : "—"}</span>
                  </div>
                  <ProgressBar value={session.cost} max={data.topConversations[0]?.cost ?? 1} className="mt-1.5" />
                </li>
              ))}
            </ul>
          </StateBlock>
        </Card>
      </div>

      <div ref={sentinel} aria-hidden="true" />
      <TokenClassCard {...section} />

      <Card>
        <CardHeader
          title={<span className="inline-flex items-center gap-1.5">Cost by model
            <InfoTip label="About model prices">Rates come from opencodex's own pricing engine, including any overlays you set with <code>ocx models set-price</code>.</InfoTip></span>}
          action={
            <a href={exportUrl(filters, "models")} className="rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] font-medium text-ink-soft transition hover:border-line-strong">
              Export CSV
            </a>
          }
        />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.byModel.length === 0}>
          <Expandable items={priced}>
            {rows => (
              <TableShell>
                <thead>
                  <tr>
                    <Th>Model</Th>
                    <Th align="right">Requests</Th>
                    <Th align="right">Tokens</Th>
                    <Th align="right">Cost</Th>
                    <Th align="right">Per 1M tokens</Th>
                    <Th align="right">Share</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(model => (
                    <tr key={model.key} className="transition hover:bg-surface-2">
                      <Td className="max-w-[260px]"><ModelTag model={model.key} /></Td>
                      <Td align="right">{formatInteger(model.requests)}</Td>
                      <Td align="right">{formatCompact(model.tokens)}</Td>
                      <Td align="right">{formatUsd(model.cost)}</Td>
                      <Td align="right">{model.costPer1MTokens !== null ? formatUsd(model.costPer1MTokens) : "—"}</Td>
                      <Td align="right">{formatPercent(model.costShare, 0)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Expandable>
          {unpriced.length > 0 ? (
            <details className="mt-2 text-[11.5px] text-muted">
              <summary className="cursor-pointer font-medium text-accent">+{unpriced.length} unpriced model{unpriced.length === 1 ? "" : "s"}</summary>
              <p className="mt-1.5 leading-5">
                {unpriced.map(model => `${model.key} (${formatCompact(model.tokens)})`).join(" · ")}
              </p>
            </details>
          ) : null}
        </StateBlock>
      </Card>
    </div>
  );
}
