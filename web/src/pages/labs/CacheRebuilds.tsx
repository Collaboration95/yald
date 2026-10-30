import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Chart } from "../../components/Chart";
import { barChart, stackedBarChart } from "../../components/chartOptions";
import { Card, CardHeader, InfoTip, TableShell, Td, Th } from "../../components/ui";
import { formatCompact, formatInteger, formatPercent, formatUsd } from "../../lib/format";
import { colorAt } from "../../lib/palette";
import { useTheme } from "../../lib/theme";
import type { CacheEconomicsTotals, CacheRebuilds, LedgerRow } from "../../types";
import { TopList, Verdict, type TopRow } from "./shared";

export const LEDGER_NAMES: Record<LedgerRow["class"], string> = {
  "session-start": "Session start", "subagent-start": "Subagent start", reported: "API reported", compaction: "After compaction",
  "model-switch": "At model switch", "idle-gap": "After idle gap", "no-evidence": "No evidence",
};
const CLASS_NAMES = { freshInput: "Fresh input", cacheRead: "Cache reads", cacheWrite: "Cache writes", output: "Output" } as const;
const CLASSES = Object.keys(CLASS_NAMES) as (keyof typeof CLASS_NAMES)[];
const caseHref = (evidence: CacheEconomicsTotals["evidence"]) => `${evidence.href}${evidence.href.includes("?") ? "&" : "?"}investigation=cache-detective`;

function finding(data: CacheRebuilds): { headline: ReactNode; detail: ReactNode } {
  const bill = data.writeBill;
  const { totals } = data;
  const count = (value: number, what: string) => `${formatInteger(value)} ${what}`;
  return {
    headline: bill?.tokenShare ? `Cache writes were ${formatPercent(bill.tokenShare.cacheWrite)} of Claude tokens and ${formatPercent(bill.costShare!.cacheWrite)} of Claude cost` : "Cache writes have no price in this selection",
    detail: `Of ${count(totals.requests, totals.requests === 1 ? "rebuild" : "rebuilds")}, ${formatInteger(totals.reported)} carry an API-reported miss reason. Inferred: ${count(totals.afterIdleGap, "after an idle gap longer than the cache lifetime")}, ${count(totals.atModelSwitch, "at a model switch")}, ${count(totals.afterCompaction, "after a compaction")}. ${count(totals.noEvidence, "have no evidence")}. Rebuilds cost at most ${formatUsd(totals.premiumUsd)} in list-price equivalents.`,
  };
}

function LedgerTable({ rows }: { rows: LedgerRow[] }) {
  return <TableShell>
    <thead><tr>
      <Th>Where it came from</Th><Th>Label</Th><Th align="right">Requests</Th><Th align="right">Written</Th><Th align="right">Write cost</Th><Th align="right">Rewritten</Th>
      <Th align="right">Premium</Th><Th align="right">Priced</Th>
    </tr></thead>
    <tbody>{rows.map(row => <tr key={row.class}>
      <Td className="font-medium text-ink">{row.requests ? <Link to={caseHref(row.evidence)} className="hover:text-accent">{LEDGER_NAMES[row.class]}</Link> : LEDGER_NAMES[row.class]}</Td>
      <Td>{row.label}</Td>
      <Td align="right">{formatInteger(row.requests)}</Td>
      <Td align="right">{formatCompact(row.writeTokens)}</Td>
      <Td align="right">{formatUsd(row.writeCostUsd)}</Td>
      <Td align="right">{row.rewrittenTokens === null ? "not a rebuild" : formatCompact(row.rewrittenTokens)}</Td>
      <Td align="right">{row.rewrittenTokens === null ? "—" : row.premiumUsd === null ? "unpriced" : formatUsd(row.premiumUsd)}</Td>
      <Td align="right">{row.pricedRequests === null ? "—" : `${formatInteger(row.pricedRequests)} of ${formatInteger(row.requests)}`}</Td>
    </tr>)}</tbody>
  </TableShell>;
}

/** Where cache writes come from. Its population is its own: the net comparison above must not shrink it. */
export function RebuildSection({ data }: { data: CacheRebuilds }) {
  const { chartTheme } = useTheme();
  const bill = data.writeBill;
  const billOption = useMemo(() => {
    if (!bill?.tokenShare) return null;
    return stackedBarChart(chartTheme, ["Cost", "Tokens"], CLASSES.map(key => ({
      name: CLASS_NAMES[key], data: [bill.costShare![key], bill.tokenShare![key]].map(value => (value === null ? null : value * 100)),
    })), { horizontal: true, max: 100, formatter: value => `${Math.round(value)}%` });
  }, [bill, chartTheme]);
  const warmOption = useMemo(() => {
    if (!data.warmByGap.some(bucket => bucket.warmShare !== null)) return null;
    return barChart(chartTheme, data.warmByGap.map(bucket => `${bucket.label}\nn=${formatInteger(bucket.requests)}${bucket.warmShare === null ? ", too few" : ""}`), data.warmByGap.map(bucket => (bucket.warmShare === null ? null : bucket.warmShare * 100)),
      { formatter: value => `${Math.round(value)}%`, color: () => colorAt(0) });
  }, [data.warmByGap, chartTheme]);

  if (data.state === "not-applicable") return <Card>
    <CardHeader title="Cache rebuilds" />
    <p className="text-[12.5px] text-ink-soft">Not applicable: these requests have no cache write premium, which applies to Claude requests only.</p>
  </Card>;

  const { headline, detail } = finding(data);
  const { coverage, interleaving } = data;
  const chains: TopRow[] = data.topChains.map(chain => ({
    key: chain.key, label: `Session ${chain.conversationId.slice(0, 6)}`, title: chain.conversationId, note: chain.agentId === "main" ? "main agent" : `subagent ${chain.agentId.slice(0, 6)}`,
    value: chain.premiumUsd === 0 && chain.unpricedRequests ? "unpriced" : formatUsd(chain.premiumUsd), amount: chain.premiumUsd, href: caseHref(chain.evidence),
  }));
  const ttl = bill?.ttl;
  return <>
    <Verdict found={data.state === "observed"} headline={headline} detail={detail}
      info={<>A rebuild is a request after the first in its chain that wrote more cache than it read. That is a threshold on counters, and it does not prove a cache entry expired. Reported means the API said so; everything else is inferred from the request sequence. {formatInteger(coverage.eligibleChains)} of {formatInteger(coverage.totalChains)} chains are eligible.</>}
      action={data.totals.requests ? { href: caseHref(data.evidence), label: "See the rebuilds" } : null} />
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-1.5">Cache write bill <InfoTip>Share of priced Claude tokens and cost by token class. Dollars use the engine's single write rate, so 1-hour writes are understated.</InfoTip></span>} />
        {billOption ? <Chart option={billOption} height={170} /> : null}
        {ttl ? <p className="mt-2 text-[11.5px] text-muted">Written for 5 minutes: {formatCompact(ttl.fiveMinuteTokens)}. Written for 1 hour: {formatCompact(ttl.oneHourTokens)}{ttl.unsplitTokens ? `. No lifetime recorded: ${formatCompact(ttl.unsplitTokens)}` : ""}.</p> : null}
      </Card>
      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-1.5">Warm rate by gap <InfoTip>Share of requests that read at least as much cache as they wrote, by the time since the previous request in the same chain. Gaps with fewer than {formatInteger(data.warmMinRequests)} requests show their count and no rate.</InfoTip></span>} />
        {warmOption ? <Chart option={warmOption} height={200} /> : <p className="text-[12.5px] text-muted">Too few requests after a gap to show a rate.</p>}
      </Card>
    </div>
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-1.5">Rebuild ledger <InfoTip>Rewritten tokens are what the previous request in the chain had cached and this one wrote again. The premium prices them at write rate minus read rate: an upper bound, in list-price equivalents, that assumes the earlier prefix could have been reused. It is a different figure from the write premium above, so the two are not added.{data.totals.borrowedRateRequests ? ` ${formatInteger(data.totals.borrowedRateRequests)} rebuilds read no cache and use the read rate of an earlier request in their chain.` : ""}</InfoTip></span>} />
      <LedgerTable rows={data.ledger} />
      <div className="mt-2 space-y-1 text-[11.5px] text-muted">
        {data.reasons.length ? <p>Reported reasons: {data.reasons.map(entry => `${entry.reason} (${formatInteger(entry.requests)})`).join(", ")}.</p> : null}
        <p>Ordered by session alone, {formatInteger(interleaving.bySession)} requests look like a lost cache. Ordered within each agent's own chain, {formatInteger(interleaving.byChain)} do: {formatInteger(interleaving.disappeared)} were agents interleaved under one session.</p>
        {data.notApplicableRequests ? <p>{formatInteger(data.notApplicableRequests)} requests from other providers are not applicable: they have no cache write premium.</p> : null}
        {coverage.clippedChains ? <p>{formatInteger(coverage.clippedChains)} chains started before this selection, so their first request is not counted.</p> : null}
        {coverage.excluded["no-agent-marker"] ? <p>{formatInteger(coverage.excluded["no-agent-marker"])} requests have no agent marker and are left out.</p> : null}
      </div>
    </Card>
    {chains.length ? <Card>
      <CardHeader title="Chains with the largest premium" />
      <TopList rows={chains} />
    </Card> : null}
  </>;
}
