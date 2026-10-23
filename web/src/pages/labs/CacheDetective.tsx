import { useMemo } from "react";
import { filtersKey, sourceLabel, useEndpoint } from "../../api";
import { Chart } from "../../components/Chart";
import { barChart } from "../../components/chartOptions";
import { Card, CardHeader } from "../../components/ui";
import { formatInteger, formatUsd, formatUsdAxis, formatUsdDelta } from "../../lib/format";
import { useTheme } from "../../lib/theme";
import type { CacheEconomicsResponse, CacheEconomicsTotals } from "../../types";
import { InvestigationState } from "./InvestigationState";
import { TopList, Verdict, periodPhrase, useLabsFilters, type TopRow } from "./shared";

const SESSION_LIMIT = 100;

// Eligibility is independent of engine loading and of whether a dollar value is zero.
const available = (totals: CacheEconomicsTotals) => totals.eligibleRequests > 0 && totals.direction !== "insufficient";

/** Semantic finding; all meaning remains in text with artwork hidden. */
export function cacheFinding(totals: CacheEconomicsTotals) {
  if (totals.totalRequests === 0) return { state: "empty" as const, summary: "No requests in this selection." };
  if (!available(totals)) return { state: "insufficient" as const, summary: "Not enough cache data to compare." };
  const summary = totals.direction === "benefit" ? "Caching saved you money."
    : totals.direction === "cost" ? "Caching cost more than it saved."
    : "Caching roughly broke even.";
  return { state: totals.direction, summary };
}

const evidenceHref = (evidence: CacheEconomicsTotals["evidence"]) => `${evidence.href}${evidence.href.includes("?") ? "&" : "?"}investigation=cache-detective`;

export function CacheDetective() {
  const filters = useLabsFilters("cache-detective");
  // A finding belongs to one exact cohort and dataset: never show a previous selection's or page load's response.
  const query = useEndpoint<CacheEconomicsResponse>("/api/labs/cache", filters, { limit: SESSION_LIMIT }, { keepPrevious: false, persist: false });
  if (!query.data) {
    if (query.isError) return <InvestigationState kind="error" title="Cache savings unavailable" detail={query.error.message} onRetry={() => { void query.refetch(); }} />;
    return <InvestigationState kind="loading" title="Loading cache savings" />;
  }
  return <CacheResults key={filtersKey(filters)} data={query.data} />;
}

export function CacheResults({ data }: { data: CacheEconomicsResponse }) {
  const { chartTheme } = useTheme();
  const { totals } = data;
  const finding = cacheFinding(totals);
  const ok = available(totals);
  const rows: TopRow[] = data.sessions
    .filter(session => available(session) && session.netUsd !== 0)
    .map(session => ({
      key: session.key, label: `Session ${session.conversationId.slice(0, 6)}`, title: session.conversationId, note: sourceLabel(session.source),
      value: formatUsdDelta(session.netUsd), amount: session.netUsd, href: evidenceHref(session.evidence),
    }));
  const option = useMemo(() => barChart(chartTheme, ["Saved on reads", "Paid extra for writes", "Net"],
    [totals.readDiscountUsd, totals.writePremiumUsd, totals.netUsd], { formatter: value => formatUsdAxis(value), showLabels: true, color: index => ["#16a34a", "#f59e0b", "#2563eb"][index]! }),
  [totals, chartTheme]);
  const info = <>
    Compares what your cached requests cost with the same requests priced as if nothing were cached: cache reads are cheaper than fresh input, cache writes cost a premium, and the saving is the difference. Dollars are API list-price equivalents, not a bill or a subscription saving.
    {" "}{formatInteger(totals.eligibleRequests)} of {formatInteger(totals.totalRequests)} requests had the cache and price data needed; the rest are left out. Window: {periodPhrase(data.scope.window)}.
  </>;

  if (finding.state === "empty") return <InvestigationState kind="empty" />;
  return <div className="space-y-3" data-investigation="cache-detective" data-finding={finding.state}>
    <Verdict
      found={ok}
      headline={ok ? (totals.direction === "cost" ? `Caching cost ${formatUsd(Math.abs(totals.netUsd))} more than it saved` : totals.direction === "even" ? `Caching roughly broke even in ${periodPhrase(data.scope.window)}` : `Caching saved ${formatUsd(totals.netUsd)} in ${periodPhrase(data.scope.window)}`) : finding.summary}
      detail={ok ? `${formatUsd(totals.readDiscountUsd)} saved on cache reads, ${formatUsd(totals.writePremiumUsd)} paid extra for cache writes.` : "Cache accounting and a price for the same requests are needed to compare."}
      big={ok ? formatUsd(totals.netUsd) : undefined}
      bigLabel={ok ? "net" : undefined}
      info={info}
      action={ok ? { href: evidenceHref(totals.evidence), label: "See the requests" } : null}
    />
    {ok ? <>
      <Card>
        <CardHeader title="Reads vs writes" />
        <Chart option={option} height={220} />
      </Card>
      {rows.length ? <Card>
        <CardHeader title="Sessions that saved the most" />
        <TopList rows={rows} />
      </Card> : null}
    </> : null}
  </div>;
}
