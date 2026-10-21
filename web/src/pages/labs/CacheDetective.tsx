import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { filtersKey, sourceLabel, useEndpoint } from "../../api";
import { YaldiFindingArtwork } from "../../components/YaldiArtwork";
import { formatInteger } from "../../lib/format";
import { useFilters } from "../../lib/useFilters";
import type { AnalysisWindow, CacheEconomicsResponse, CacheEconomicsTotals, CacheExclusion } from "../../types";
import { InvestigationScope } from "./InvestigationScope";
import { InvestigationState } from "./InvestigationState";

const SESSION_LIMIT = 100;
const EXCLUSIONS: Record<CacheExclusion, string> = {
  unpriced: "No price",
  "attempt-sum": "Usage summed from attempts",
  "usage-estimated": "Usage not reported",
  "input-missing": "Input not measured",
  "cache-unmeasured": "Cache counters not measured",
  "cache-synthesized": "Synthesized cache accounting",
  "cache-unknown": "Cache provenance not observed",
  "economics-unavailable": "Actual/baseline price pair unavailable",
  "accounting-mismatch": "Priced and recorded counters differ",
  "rate-unavailable": "Required rate unavailable",
};

// Eligibility is independent of engine loading and of whether a dollar value is zero.
const available = (totals: CacheEconomicsTotals) => totals.eligibleRequests > 0 && totals.direction !== "insufficient";
const money = (value: number, supported: boolean, signed = false) => supported
  ? `${value < 0 ? "−" : signed && value > 0 ? "+" : ""}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 })}`
  : "Unavailable";
const signLabel = (totals: CacheEconomicsTotals) => !available(totals) ? "Unavailable"
  : totals.direction === "benefit" ? "Positive" : totals.direction === "cost" ? "Negative" : "Even";

/** Semantic finding; all meaning remains in text with artwork hidden. */
export function cacheFinding(totals: CacheEconomicsTotals) {
  if (totals.totalRequests === 0) return { state: "empty" as const, summary: "No requests in this selection." };
  if (!available(totals)) return { state: "insufficient" as const, summary: "No eligible cache comparison. Observed cache accounting and a valid actual/baseline price pair are required." };
  const summary = totals.direction === "benefit" ? "Positive net: read discounts exceed write premiums."
    : totals.direction === "cost" ? "Negative net: write premiums exceed read discounts."
    : "Even at six decimals: read discounts and write premiums balance.";
  return { state: totals.direction, summary };
}

export function CacheDetective() {
  const { filters } = useFilters();
  const query = useEndpoint<CacheEconomicsResponse>("/api/labs/cache", filters, { limit: SESSION_LIMIT });
  if (!query.data) {
    if (query.isError) return <InvestigationState kind="error" title="Cache comparison unavailable" detail={query.error.message} onRetry={() => { void query.refetch(); }} />;
    return <InvestigationState kind="loading" title="Loading Cache Detective" />;
  }
  return <>
    {query.isError ? <InvestigationState kind="error" title="Cache comparison could not refresh" detail="The last loaded fixed window is shown below." onRetry={() => { void query.refetch(); }} /> : null}
    <CacheResults key={filtersKey(filters)} data={query.data} findingFresh={!query.isError} />
  </>;
}

function CacheResults({ data, findingFresh }: { data: CacheEconomicsResponse; findingFresh: boolean }) {
  const [selection, setSelection] = useState<string | null>(null);
  const detailId = useId();
  const selectedSession = data.sessions.find(session => session.key === selection) ?? data.sessions[0];
  const unnamedSelected = selection === "unnamed" || (!selectedSession && data.unnamed.totalRequests > 0);
  const selected = unnamedSelected ? data.unnamed : selectedSession;
  const finding = cacheFinding(data.totals);
  return <div className="space-y-5" data-investigation="cache-detective">
    <header>
      <h2 className="text-lg font-semibold tracking-tight text-ink">Cache Detective</h2>
      <p className="mt-1 text-[12px] leading-5 text-ink-soft">API list-price equivalents in USD, not bills or realized subscription savings. Compare recorded cache use with the identical workload priced uncached.</p>
      <FixedWindow window={data.scope.window} />
    </header>

    <section className="card space-y-4 p-4" aria-label="Scope cache comparison" data-finding-summary="cache-detective" data-finding={finding.state}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold text-ink">Selected scope · named and unnamed requests</h3>
        <EvidenceLink evidence={data.totals.evidence} label="Open scope evidence" />
      </div>
      {finding.state === "empty" ? <InvestigationState kind="empty" />
        : finding.state === "insufficient" ? <InvestigationState kind="insufficient" title="Cache comparison unavailable" detail={finding.summary} />
        : <div className="flex items-start gap-4">
          <YaldiFindingArtwork evidenceSufficient={findingFresh && available(data.totals)} />
          <p role="status" aria-label="Cache finding" className="min-w-0 flex-1 text-sm font-medium text-ink">{finding.summary}</p>
        </div>}
      <Comparison totals={data.totals} />
      <Coverage totals={data.totals} />
      <p className="border-t border-line pt-3 text-[12px] leading-5 text-ink-soft">The dashboard’s older gross cache-read discount uses base list rates before write premiums and tier adjustments. This net comparison uses effective tier rates and its own eligible requests; the two metrics have different coverage.</p>
    </section>

    <section aria-labelledby="cache-session-ranking" className="space-y-3">
      <h3 id="cache-session-ranking" className="font-semibold text-ink">Session ranking</h3>
      <p className="text-[12px] leading-5 text-ink-soft">Showing {formatInteger(data.sessions.length)} of {formatInteger(data.sessionCount)} named sessions (limit {SESSION_LIMIT}). Server order: largest absolute net first, then source and session ID. Unavailable rows have no monetary comparison.</p>
      {data.sessionsTruncated ? <p className="text-[12px] text-ink">Session list limited. Scope and unnamed totals still include all selected requests.</p> : null}
      {data.sessions.length ? <div className="table-shell max-h-[28rem] overflow-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Session ranking table">
        <table className="w-full text-left text-[12px]">
          <caption className="sr-only">Source-qualified sessions; all amounts are eligible API list-price equivalents in USD. Select a session to inspect its breakdown.</caption>
          <thead><tr>{["Session / source", "Eligible / total", "Read discount", "Write premium", "Net (USD)"].map(label => <th key={label} scope="col" className="whitespace-nowrap p-3">{label}</th>)}</tr></thead>
          <tbody>{data.sessions.map(session => <tr key={session.key} className={!unnamedSelected && selectedSession?.key === session.key ? "selected" : undefined}>
            <td className="max-w-64 p-3">
              <button type="button" aria-pressed={!unnamedSelected && selectedSession?.key === session.key} aria-controls={detailId}
                className="block w-full rounded text-left text-ink underline decoration-line-strong underline-offset-4"
                onClick={() => setSelection(session.key)} aria-label={`Inspect ${session.source} session ${session.conversationId}`}>
                <span className="block break-all font-medium">{session.conversationId}</span>
                <span className="mt-1 block text-[11px] text-ink-soft">{sourceLabel(session.source)} · {session.source}</span>
              </button>
            </td>
            <td className="whitespace-nowrap p-3 num">{formatInteger(session.eligibleRequests)} / {formatInteger(session.totalRequests)}</td>
            <td className="whitespace-nowrap p-3 num">{money(session.readDiscountUsd, available(session))}</td>
            <td className="whitespace-nowrap p-3 num">{money(session.writePremiumUsd, available(session))}</td>
            <td className="whitespace-nowrap p-3 num"><span className="block font-medium text-ink">{money(session.netUsd, available(session), true)}</span><span className="text-[11px] text-ink-soft">{signLabel(session)}</span></td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="text-[12px] text-ink-soft">No named sessions in the displayed list. Unnamed requests and full scope totals remain below and above.</p>}
    </section>

    <section className="card p-4" aria-label="Unnamed request totals">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="font-semibold text-ink">Unnamed requests</h3><p className="mt-1 text-[12px] text-ink-soft">{formatInteger(data.unnamed.eligibleRequests)} eligible / {formatInteger(data.unnamed.totalRequests)} total · Net {money(data.unnamed.netUsd, available(data.unnamed), true)} · {signLabel(data.unnamed)}</p></div>
        <button type="button" aria-pressed={unnamedSelected} aria-controls={selected ? detailId : undefined} onClick={() => setSelection("unnamed")}
          className="rounded-lg border border-line px-3 py-2 text-[12px] text-ink">Inspect unnamed requests</button>
      </div>
      <p className="mt-2 text-[12px] text-ink-soft">Included in scope totals. These requests have no conversation ID and never form a named session.</p>
    </section>

    {selected ? <section id={detailId} className="card space-y-4 p-4" aria-label="Selected cache breakdown">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-ink">{unnamedSelected ? "Unnamed request breakdown" : "Selected-session breakdown"}</h3>
          {unnamedSelected ? <p className="mt-1 text-[12px] text-ink-soft">No conversation ID · sources from the fixed cohort below</p>
            : <p className="mt-1 break-all text-[12px] text-ink-soft">{sourceLabel(selectedSession!.source)} · {selectedSession!.source} · {selectedSession!.conversationId}</p>}
        </div>
        <EvidenceLink evidence={selected.evidence} label={unnamedSelected ? "Open unnamed evidence" : "Open session evidence"} />
      </div>
      <FixedWindow window={data.scope.window} />
      <p className="text-[12px] text-ink-soft" aria-live="polite">{cacheFinding(selected).summary}</p>
      <Comparison totals={selected} />
      <Coverage totals={selected} />
      <dl className="grid gap-2 text-[12px] text-ink-soft sm:grid-cols-2">
        <div><dt>Cache-read tokens (eligible)</dt><dd className="num text-ink">{available(selected) ? formatInteger(selected.readTokens) : "Unavailable"}</dd></div>
        <div><dt>Cache-write tokens (eligible)</dt><dd className="num text-ink">{available(selected) ? formatInteger(selected.writeTokens) : "Unavailable"}</dd></div>
        <div><dt>Long-context / priority requests</dt><dd className="num">{formatInteger(selected.longContextRequests)} / {formatInteger(selected.priorityRequests)}</dd></div>
        <div><dt>Confirmed tier / requested or configured only</dt><dd className="num">{formatInteger(selected.confirmedTierRequests)} / {formatInteger(selected.requestedTierOnlyRequests)}</dd></div>
      </dl>
    </section> : null}

    <section className="card p-4 text-[12px] leading-5 text-ink-soft" aria-label="Cache comparison limitations">
      <h3 className="font-semibold text-ink">Method and limitations</h3>
      <p className="mt-2">Identical recorded input and output; the same model, pricing options, context tier and service-tier record. Only cache accounting changes. Current engine and overlay rates apply.</p>
      <p className="mt-2">Write TTL splits are unavailable. The engine’s single write rate can understate premiums for 1-hour writes.</p>
      <p className="mt-2">All dollar values use six decimals. Actual and baseline round independently and can differ from net by up to $0.000002. Rounded session amounts may not sum exactly to rounded scope totals.</p>
      <details className="mt-3"><summary className="cursor-pointer rounded text-ink">Server pricing and coverage notes</summary>
        <p className="mt-2">Pricing engine: {data.pricing.detail}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">{data.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
      </details>
    </section>
    <InvestigationScope window={data.scope.window} cohort={data.scope.cohort} sample={data.totals}
      unpricedRequests={data.totals.excluded.unpriced} notes={data.coverage ? [
        `Project selection: ${formatInteger(data.coverage.attribution.matched.rows)} matched requests; ${formatInteger(data.coverage.attribution.outsideProjects.rows)} outside the selected projects; ${formatInteger(data.coverage.unattributedRows)} excluded because their folder is unknown. Attribution coverage precedes the project filter.`,
      ] : []} />
  </div>;
}

function Comparison({ totals }: { totals: CacheEconomicsTotals }) {
  const supported = available(totals);
  const metrics = [
    ["Read discount", money(totals.readDiscountUsd, supported), "Effective uncached input equivalent less recorded read cost"],
    ["Write premium", money(totals.writePremiumUsd, supported), "Recorded write cost less effective uncached input equivalent"],
    [`Net · ${signLabel(totals)}`, money(totals.netUsd, supported, true), "Read discount − write premium"],
  ];
  return <div>
    <dl className="grid gap-3 sm:grid-cols-3">{metrics.map(([label, value, detail]) => <div key={label} className="min-w-0 rounded-lg bg-surface-2 p-3">
      <dt className="text-[12px] font-medium text-ink-soft">{label}</dt><dd className="mt-1 break-words text-lg font-semibold tracking-tight text-ink num">{value}</dd>
      <dd className="mt-1 text-[11px] leading-4 text-ink-soft">{detail}</dd>
    </div>)}</dl>
    <dl className="mt-3 grid gap-3 text-[12px] leading-5 sm:grid-cols-2">
      <div><dt className="text-ink-soft">Actual · recorded cache accounting</dt><dd className="font-medium text-ink num">{money(totals.actualUsd, supported)}</dd></div>
      <div><dt className="text-ink-soft">Baseline · identical workload, uncached input</dt><dd className="font-medium text-ink num">{money(totals.baselineUsd, supported)}</dd></div>
    </dl>
  </div>;
}

function Coverage({ totals }: { totals: CacheEconomicsTotals }) {
  const excluded = (Object.entries(EXCLUSIONS) as [CacheExclusion, string][]).filter(([reason]) => totals.excluded[reason] > 0);
  return <div className="space-y-2 text-[12px] leading-5 text-ink-soft">
    <p>{!available(totals) ? "Insufficient coverage: " : totals.eligibleRequests < totals.totalRequests ? "Partial coverage: " : "Coverage: "}{formatInteger(totals.eligibleRequests)} eligible / {formatInteger(totals.totalRequests)} total requests. Excluded requests contribute no dollars.</p>
    {excluded.length ? <dl className="flex flex-wrap gap-x-5 gap-y-1" aria-label="Partitioned exclusion reasons">{excluded.map(([reason, label]) => <div key={reason} className="flex gap-1"><dt>{label}:</dt><dd className="num font-medium text-ink">{formatInteger(totals.excluded[reason])}</dd></div>)}</dl> : null}
    {available(totals) && totals.readTokens === 0 && totals.writeTokens === 0 ? <p>No cache tokens observed in the eligible requests. Measured zero counters support this zero comparison.</p> : null}
    {totals.lowerBoundRequests > 0 ? <p>{formatInteger(totals.lowerBoundRequests)} eligible requests have lower-bound prices: tier pricing is incomplete on both prices; net is not a guaranteed savings floor.</p> : null}
    {totals.derivedRateRequests > 0 ? <p>{formatInteger(totals.derivedRateRequests)} eligible requests use derived rates.</p> : null}
    {totals.explicitFreeRequests > 0 ? <p>{formatInteger(totals.explicitFreeRequests)} eligible requests use explicit user-overlay zero rates. Their zero price is explicit, not missing.</p> : null}
  </div>;
}

function FixedWindow({ window }: { window: AnalysisWindow }) {
  const time = (ts: number) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "long", timeZone: window.tz }).format(ts);
  return <p className="mt-2 text-[11px] leading-5 text-ink-soft">From (included) <time dateTime={new Date(window.from).toISOString()}>{time(window.from)}</time> · Until (excluded) <time dateTime={new Date(window.to).toISOString()}>{time(window.to)}</time> · {window.tz}</p>;
}

function EvidenceLink({ evidence, label }: { evidence: CacheEconomicsTotals["evidence"]; label: string }) {
  // Preserve the server href and authoritative selector, including unnamed/cache eligibility.
  const href = `${evidence.href}${evidence.href.includes("?") ? "&" : "?"}investigation=cache-detective`;
  return <Link to={href} className="inline-block rounded py-1 text-[12px] text-ink underline decoration-line-strong underline-offset-4">{label}</Link>;
}
