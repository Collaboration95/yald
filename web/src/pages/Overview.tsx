import { useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { Activity, CircleDollarSign, Flame, Gauge, Layers, Timer, Zap } from "lucide-react";
import { conversationLink, sourceLabel, useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { usePreferences } from "../lib/preferences";
import { Badge, Card, CardHeader, InfoTip, MiniSpark, ModelTag, ProgressBar, Segmented, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { stackedAreaChart } from "../components/chartOptions";
import { formatCompact, formatCountdown, formatDuration, formatInteger, formatPercent, formatRelative, formatShortDate, formatUsd, quotaLabel, sessionLabel } from "../lib/format";
import type { OverviewResponse } from "../types";
import { displayNow } from "../lib/demo";

const STALE_QUOTA_MS = 24 * 3_600_000;

export function OverviewPage() {
  const { labsEnabled } = usePreferences();
  const { filters, set } = useFilters();
  const { chartTheme } = useTheme();
  const { search } = useLocation();
  const metric = filters.metric === "cost" || filters.metric === "requests" ? filters.metric : "tokens";
  const groupBy = filters.groupBy === "provider" || filters.groupBy === "effort" ? filters.groupBy : "model";

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

  const summary = data?.summary;
  const unpricedShare = summary ? summary.unpricedRequests / Math.max(1, summary.requests) : 0;
  const quotaWindows = data?.quotaScope.available === false ? [] : data?.quota.windows ?? [];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Requests"
          value={summary ? formatInteger(summary.requests) : "—"}
          hint={summary && summary.errors > 0 ? `${formatInteger(summary.errors)} failed` : undefined}
          delta={data?.deltas.requests}
          deltaTone="none"
          spark={data?.sparkline.requests}
          icon={<Layers size={13} />}
        />
        <Stat
          label="Tokens"
          value={summary ? formatCompact(summary.tokens.total) : "—"}
          hint={summary ? `${formatCompact(summary.tokens.output)} output` : undefined}
          delta={data?.deltas.tokens}
          deltaTone="none"
          spark={data?.sparkline.tokens}
          icon={<Activity size={13} />}
        />
        <Stat
          label="Estimated cost"
          value={summary && summary.pricedRequests > 0 ? formatUsd(summary.cost) : "—"}
          info={unpricedShare >= 0.05 && summary ? `${formatInteger(summary.unpricedRequests)} of ${formatInteger(summary.requests)} requests have no list price (subscription or free routes) and add no dollars. Costs are API list-price equivalents, not a bill.` : "API list-price equivalents, not a bill."}
          delta={data?.deltas.cost}
          deltaTone="none"
          spark={data?.sparkline.cost}
          tone="good"
          icon={<CircleDollarSign size={13} />}
        />
        <Stat
          label="Success rate"
          tag="Codex only"
          value={summary ? formatPercent(summary.successRate) : "—"}
          delta={data?.deltas.successRate}
          tone={summary && summary.successRate !== null && summary.successRate < 0.95 ? "warn" : "neutral"}
          icon={<Gauge size={13} />}
        />
        <Stat
          label="Median TTFT"
          tag="Codex only"
          value={summary ? formatDuration(summary.ttft.p50) : "—"}
          delta={data?.deltas.ttftP50}
          deltaTone="inverse"
          tone="info"
          icon={<Timer size={13} />}
        />
        <Stat
          label="Cache savings"
          value={summary && summary.pricedRequests > 0 ? formatUsd(summary.cache.savingsUsd) : "—"}
          hint={summary && summary.cache.hitRate !== null ? `${formatPercent(summary.cache.hitRate, 0)} cache hit` : undefined}
          info="What caching saved against paying the full input price for every cached token."
          delta={data?.deltas.cacheHitRate}
          deltaTone="none"
          tone="good"
          icon={<Zap size={13} />}
        />
      </div>

      <Card>
        <CardHeader
          title="Usage over time"
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
                onChange={value => set({ metric: value })}
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

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Top models"
            action={<Link to={{ pathname: "/cost", search }} className="text-[11px] font-medium text-accent">All models</Link>}
          />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.topModels.length === 0}>
            <TableShell>
              <thead>
                <tr>
                  <Th>Model</Th>
                  <Th align="right">Tokens</Th>
                  <Th align="right">Share</Th>
                  <Th align="right">Cost</Th>
                </tr>
              </thead>
              <tbody>
                {data?.topModels.slice(0, 6).map(model => (
                  <tr key={model.key} className="transition hover:bg-surface-2">
                    <Td className="max-w-[260px]"><ModelTag model={model.key} /></Td>
                    <Td align="right">{formatCompact(model.tokens)}</Td>
                    <Td align="right">{formatPercent(model.share, 0)}</Td>
                    <Td align="right">{model.pricedRequests > 0 ? formatUsd(model.cost) : <span className="text-muted">—</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </StateBlock>
        </Card>

        <div className="space-y-3">
          {quotaWindows.length > 0 ? (
            <Card>
              <CardHeader
                title={<span className="inline-flex items-center gap-1.5">Plan usage
                  <InfoTip label="About plan usage">An account-wide reading from opencodex, or from Codex rollouts where marked. It is not one project's own usage, so filters do not narrow it.</InfoTip></span>}
                action={labsEnabled ? <Link to="/labs/quota-pace" className="text-[11px] font-medium text-accent">Pace</Link> : undefined}
              />
              <ul className="space-y-3">
                {quotaWindows.map(window => {
                  const burn = data?.quota.burn.find(entry => entry.account === window.account && entry.window === window.window);
                  const tone = window.usedPercent >= 90 ? "bad" : window.usedPercent >= 70 ? "warn" : "accent";
                  const now = displayNow();
                  const stale = now - window.updatedAt > STALE_QUOTA_MS || (window.resetAtMs !== null && window.resetAtMs < now);
                  const history = data?.quota.series.find(entry => entry.account === window.account && entry.window === window.window)?.points ?? [];
                  return (
                    <li key={`${window.account}-${window.window}`}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-[11.5px] font-medium text-ink">{quotaLabel(window.window)}</p>
                        <span className="num text-[12px] font-semibold text-ink">{window.usedPercent}% used</span>
                      </div>
                      <ProgressBar value={window.usedPercent} max={100} tone={tone} className="mt-1.5" />
                      {history.length > 1 ? <MiniSpark values={history.map(point => point.usedPercent)} className="mt-1 h-5 w-full" /> : null}
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[10.5px] text-muted">
                        {window.account === "codex-rollouts" ? <span>from Codex rollouts</span> : null}
                        {window.resetAtMs && !stale ? <span>resets {formatCountdown(window.resetAtMs)}</span> : null}
                        {stale ? <Badge tone="warn">Stale · last reading {formatRelative(window.updatedAt)}</Badge> : null}
                        {burn?.willExhaustBeforeReset && !stale ? <span className="inline-flex items-center gap-1 font-medium text-warn"><Flame size={11} /> on track to run out before reset</span> : null}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Biggest sessions" action={<Link to={{ pathname: "/sessions", search }} className="text-[11px] font-medium text-accent">All</Link>} />
            <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.topConversations.length === 0}>
              <ul className="space-y-2">
                {data?.topConversations.slice(0, 5).map(session => (
                  <li key={JSON.stringify([session.source, session.id])} className="flex items-center justify-between gap-2">
                    <Link to={conversationLink(session, search)} className="min-w-0 truncate text-[11.5px] text-info hover:underline" title={`${session.project ?? session.id} · ${sourceLabel(session.source)}`}>
                      {sessionLabel(session)} <span className="text-[10.5px] text-muted">· {formatShortDate(session.startedAt)}</span>
                    </Link>
                    <span className="num shrink-0 text-[11px] text-muted">{formatCompact(session.tokens)}</span>
                  </li>
                ))}
              </ul>
            </StateBlock>
          </Card>
        </div>
      </div>
    </div>
  );
}
