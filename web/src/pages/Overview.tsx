import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Activity, Flame, Layers } from "lucide-react";
import { filtersKey, useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { usePreferences } from "../lib/preferences";
import { Badge, Card, CardHeader, InfoTip, MiniSpark, ProgressBar, Segmented, Stat, StateBlock } from "../components/ui";
import { SessionLink } from "../components/SessionLink";
import { Chart } from "../components/Chart";
import { stackedAreaChart } from "../components/chartOptions";
import { formatCompact, formatCountdown, formatInteger, formatPercent, formatRelative, formatUsd, quotaLabel } from "../lib/format";
import type { OverviewResponse } from "../types";
import { useChartStyle } from "../lib/chartStyle";
import { colorAt } from "../lib/palette";
import { overviewSeries, planAccounts } from "../lib/overviewUsage";
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

  const design = useChartStyle();
  const [isolated, setIsolated] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const scopeKey = filtersKey(filters);
  useEffect(() => { setIsolated(null); setHighlighted(null); }, [scopeKey, metric, groupBy]);
  useEffect(() => {
    if (data && isolated && !data.series.groups.some(group => group.name === isolated)) setIsolated(null);
  }, [data, isolated]);
  const colors = useMemo(() => Object.fromEntries((data?.series.groups ?? []).map((group, index) => [group.name, group.name === "Other" ? "#64748b" : colorAt(index)])), [data]);

  const seriesOption = useMemo(() => {
    if (!data) return null;
    const labels = data.series.buckets.map(bucket => bucket.label);
    const series = overviewSeries(data.series, isolated);
    const formatter = metric === "cost" ? (value: number) => formatUsd(value) : (value: number) => formatCompact(value);
    return stackedAreaChart(chartTheme, labels, series, { formatter, showLegend: false, colors });
  }, [data, chartTheme, metric, isolated, colors]);

  const summary = data?.summary;
  const quotaWindows = data?.quotaScope.available === false ? [] : data?.quota.windows ?? [];

  const accounts = planAccounts(quotaWindows);

  return (
    <div className="space-y-3 editorial editorial-overview">
      <div className="overview-lead space-y-3">
        {quotaWindows.length > 0 ? (
          <Card>
            <CardHeader
              title={<span className="inline-flex items-center gap-1.5">Plan usage
                <InfoTip label="About plan usage">An account-wide reading from opencodex, or from Codex rollouts where marked. It is not one project's own usage, so filters do not narrow it.</InfoTip></span>}
              action={labsEnabled ? <Link to="/labs/quota-pace" className="text-[11px] font-medium text-accent">Pace</Link> : undefined}
            />
            <p className="mb-2 text-[11px] text-muted">Codex · latest observed account first; active account is not reported by the source.</p>
            {accounts.map((account, index) => {
              const rows = <ul className="space-y-3">
                {account.windows.map(window => {
                  const burn = data?.quota.burn.find(entry => entry.account === window.account && entry.window === window.window);
                  const tone = window.usedPercent >= 90 ? "bad" : window.usedPercent >= 70 ? "warn" : "accent";
                  const now = displayNow();
                  const stale = now - window.updatedAt > STALE_QUOTA_MS || (window.resetAtMs !== null && window.resetAtMs < now);
                  const history = data?.quota.series.find(entry => entry.account === window.account && entry.window === window.window)?.points ?? [];
                  return (
                    <li key={`${window.account}-${window.window}`}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-[11.5px] font-medium text-ink">Codex · Account {account.number} · {quotaLabel(window.window)}</p>
                        <span className="num text-[12px] font-semibold text-ink">{stale ? `${window.usedPercent}% at last reading` : `${window.usedPercent}% used`}</span>
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
              </ul>;
              return index === 0 ? <div key={account.key}>{rows}</div> : <details key={account.key} className="mt-3"><summary className="cursor-pointer text-[11px] text-muted">Codex · Account {account.number}</summary><div className="mt-2">{rows}</div></details>;
            })}
          </Card>
        ) : null}

        <Card>
          <CardHeader
            title={<span className="inline-flex items-center gap-1.5">Usage over time{metric === "cost" ? <InfoTip label="About cost">API list-price equivalents, not a bill. {summary && summary.unpricedRequests > 0 ? `${formatInteger(summary.unpricedRequests)} of ${formatInteger(summary.requests)} requests have no list price and add no dollars.` : ""}</InfoTip> : null}</span>}
            action={
              <div className="flex flex-wrap items-center gap-1.5">
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
            <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(180px,1fr)]">
              {seriesOption ? <Chart option={seriesOption} height={288} highlightedSeries={highlighted} /> : null}
              <ul className="space-y-1" aria-label="Usage series">
                {data?.series.groups.map(group => <li key={group.name}><button type="button" aria-pressed={isolated === group.name}
                  style={{ opacity: (highlighted ?? isolated) && (highlighted ?? isolated) !== group.name ? 0.35 : 1 }} className="usage-series-row flex w-full items-center gap-2 rounded p-2 text-left text-[11px] hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
                  onMouseEnter={() => setHighlighted(group.name)} onMouseLeave={() => setHighlighted(null)} onFocus={() => setHighlighted(group.name)} onBlur={() => setHighlighted(null)}
                  onClick={() => setIsolated(current => current === group.name ? null : group.name)}>
                  <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: design?.colorFor(group.name, colors[group.name]!) ?? colors[group.name] }} />
                  <span className="min-w-0 flex-1 truncate">{group.name}</span><span className="num">{metric === "cost" ? (group.pricedRequests ? formatUsd(group.total) : "—") : formatCompact(group.total)}</span>
                  <span className="num text-muted">{metric === "cost" && !group.pricedRequests ? "—" : formatPercent(group.total / Math.max(1e-9, data.series.groups.reduce((sum, row) => sum + row.total, 0)), 0)}</span>
                </button></li>)}
              </ul>
            </div>
          </StateBlock>
        </Card>

      </div>
      <aside className="overview-aside space-y-3">
        <div className="grid grid-cols-2 gap-3">
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
            value={summary ? formatCompact(summary.tokens.total) : "—"} exact={summary ? formatInteger(summary.tokens.total) : undefined}
            hint={summary ? `${formatCompact(summary.tokens.output)} output` : undefined}
            delta={data?.deltas.tokens}
            deltaTone="none"
            spark={data?.sparkline.tokens}
            icon={<Activity size={13} />}
          />
        </div>

        <Card>
          <CardHeader title="Biggest sessions" action={<Link to={{ pathname: "/sessions", search }} className="text-[11px] font-medium text-accent">All</Link>} />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.topConversations.length === 0}>
            <ul className="space-y-2">
              {data?.topConversations.slice(0, 5).map(session => (
                <li key={JSON.stringify([session.source, session.id])}>
                  <div className="flex items-center justify-between gap-2">
                    <SessionLink session={session} search={search} date />
                    <span className="num shrink-0 text-[11px] text-muted">{formatCompact(session.tokens)}</span>
                  </div>
                  <ProgressBar value={session.tokens} max={data.topConversations[0]?.tokens ?? 1} className="mt-1.5" />
                </li>
              ))}
            </ul>
          </StateBlock>
        </Card>
      </aside>
    </div>
  );
}
