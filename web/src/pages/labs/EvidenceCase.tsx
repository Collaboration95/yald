import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { caseQuery, parseCaseIntent, type CaseIntent, type CaseSelector } from "../../../../server/src/labs/evidence-intent";
import { ApiError, fetchJson, sourceLabel } from "../../api";
import type { CaseObservation, EvidenceCaseResponse, EvidenceRow } from "../../labs/evidence-types";
import type { RadarPeriod, RadarWindow } from "../../types";
import { InvestigationScope } from "./InvestigationScope";
import { InvestigationState } from "./InvestigationState";

const titles = { "project-radar": "Project Radar", "cache-detective": "Cache Detective", "context-replay": "Context Replay", "spend-changes": "Spend spikes" };
const count = (value: number | null) => value === null ? "Unavailable" : value.toLocaleString("en-US");
export const evidenceMoney = (value: number | null) => value === null ? "Unavailable" : `$${value.toFixed(6)}`;
const control = "rounded-lg border border-line bg-surface px-3 py-2 text-[12px] font-medium text-ink disabled:opacity-40";
function selectionText(selection: CaseSelector["selection"]) {
  return selection.kind === "scope" ? "Entire fixed cohort" : selection.kind === "project" ? `Project: ${selection.project}`
    : selection.kind === "session" ? `${sourceLabel(selection.source)} · session ${selection.conversationId}`
    : `${selection.source ? sourceLabel(selection.source) + " · " : ""}Unnamed requests (no session ID)`;
}

/** Mounts only inside LabsLayout. Toolbar filters are deliberately absent from the query key. */
export function EvidenceCase() {
  const { search } = useLocation();
  const decoded = useMemo(() => {
    try { return { intent: parseCaseIntent(new URLSearchParams(search)) }; }
    catch (error) { return { error: error instanceof Error ? error.message : "Open the finding again to recover this case link." }; }
  }, [search]);
  return decoded.intent ? <EvidenceCaseQuery intent={decoded.intent} /> : <div className="space-y-3">
    <InvestigationState kind="error" title="Invalid case link" detail={decoded.error} />
    <Link to="/labs" className="inline-block rounded px-1 py-2 text-[12px] text-accent">Choose an investigation</Link>
  </div>;
}
function EvidenceCaseQuery({ intent }: { intent: CaseIntent }) {
  const query = caseQuery(intent);
  const result = useQuery<EvidenceCaseResponse>({ queryKey: ["labs-evidence", query],
    queryFn: () => fetchJson<EvidenceCaseResponse>("/api/labs/evidence", query),
    retry: (attempt, error) => !(error instanceof ApiError && error.status === 400) && attempt < 1,
    staleTime: 15_000, refetchInterval: 30_000, refetchOnWindowFocus: false, refetchIntervalInBackground: false });
  if (result.isPending) return <InvestigationState kind="loading" title="Loading case file" detail="Reading the fixed request population." />;
  if (result.isError) return <InvestigationState kind="error" title={result.error instanceof ApiError && result.error.status === 400 ? "Invalid case link" : "Case file unavailable"}
    detail={result.error instanceof ApiError && result.error.status === 400 ? result.error.message : "The fixed case could not be loaded. Try again."}
    onRetry={() => void result.refetch()} />;
  return <EvidenceCaseView data={result.data} refreshing={result.isFetching} onRefresh={() => void result.refetch()} />;
}

export function EvidenceCaseView({ data, refreshing = false, onRefresh }: { data: EvidenceCaseResponse; refreshing?: boolean; onRefresh?: () => void }) {
  const [, setParams] = useSearchParams();
  const { search } = useLocation();
  const { intent, observation, population, page } = data;
  const change = (patch: { offset?: number; period?: "current" | "prior" }) => setParams(current => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(patch)) next.set(key, String(value));
    return next;
  });
  return <div className="space-y-4" data-evidence-case={intent.investigation}>
    <Link to={{ pathname: "/labs", search }} className="inline-block rounded px-1 py-2 text-[12px] text-accent">All investigations</Link>
    <section className="card space-y-3 p-4 text-[12px] leading-5 text-ink-soft" aria-labelledby="case-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><p className="text-[11px] uppercase tracking-wider text-muted">Fixed case file</p>
          <h2 id="case-title" className="text-[18px] font-semibold text-ink">{titles[intent.investigation]}</h2>
          <p className="break-words font-medium text-ink" data-case-selection>{selectionText(intent.selector.selection)}</p></div>
        {onRefresh ? <button type="button" onClick={onRefresh} disabled={refreshing} className={control}>{refreshing ? "Refreshing case…" : "Refresh case"}</button> : null}
      </div>
      <p data-case-summary>{observation.summary}</p>
      <p className="font-medium text-ink">This case keeps its fixed scope. Global toolbar changes apply to your next investigation.</p>
      <div className="grid gap-3 lg:grid-cols-2">
        <FixedWindow title={intent.priorSelector ? "Original current window" : "Fixed window"} window={intent.selector.window} />
        {intent.priorSelector ? <FixedWindow title="Original prior window" window={intent.priorSelector.window} /> : null}
      </div>
      {intent.priorSelector ? <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Original period to inspect">
        <button type="button" aria-pressed={intent.period === "current"} className={control} onClick={() => change({ period: "current", offset: 0 })}>Current requests</button>
        <button type="button" aria-pressed={intent.period === "prior"} className={control} onClick={() => change({ period: "prior", offset: 0 })}>Prior requests</button>
        <p role="status">Inspecting original {intent.period} requests.</p>
      </div> : null}
      <ObservationValues observation={observation} />
      {observation.state !== "observed" ? <InvestigationState kind={observation.state}
        title={observation.state === "empty" ? "No requests in this case" : "Comparison unavailable"}
        detail={observation.state === "empty" ? "The fixed selection has no loaded requests. Open another finding to choose a new population."
          : "The observed requests remain inspectable. Eligible accounting or baseline history is insufficient for this comparison."} /> : null}
      <p data-case-sample>{count(population.eligibleRequests)} of {count(population.original.requests)} original requests eligible; {count(population.excludedRequests)} excluded from comparisons.</p>
      <p>{count(population.original.unpricedRequests)} original requests without a price; {count(population.original.unattributedRequests)} without project attribution.</p>
      {population.exclusions.length ? <ul className="list-disc pl-5" aria-label="Comparison exclusions">{population.exclusions.map(exclusion => <li key={exclusion.reason}>{exclusion.reason}: {count(exclusion.requests)}</li>)}</ul> : null}
      <ul className="list-disc space-y-1 pl-5" aria-label="Case limitations">{observation.notes.map(note => <li key={note}>{note}</li>)}</ul>
      <details><summary className="cursor-pointer rounded py-2 font-medium text-ink">Complete fixed cohort and coverage</summary>
        <InvestigationScope window={data.scope.window} cohort={data.scope.cohort}
          sample={{ eligibleRequests: population.eligibleRequests, totalRequests: population.original.requests }}
          unpricedRequests={population.original.unpricedRequests} unattributedRequests={population.original.unattributedRequests} />
        <p className="mt-2">Recorded token totals for the selected original population: {count(population.original.tokens)}. Priced subtotal: {evidenceMoney(population.original.pricedRequests ? population.original.pricedCostUsd : null)} ({count(population.original.pricedRequests)} priced requests). These totals include comparison exclusions.</p>
      </details>
    </section>
    <section className="card p-4 text-[12px] leading-5 text-ink-soft" aria-labelledby="evidence-title">
      <h2 id="evidence-title" className="text-[14px] font-semibold text-ink">Request evidence</h2>
      <p className="mt-1">{intent.selector.eligibility === "cache" ? "Only exact cache-accounting eligible requests are listed. Original population and exclusions are disclosed above."
        : "All selected requests are listed, including observations excluded from comparisons."}</p>
      <p className="mt-1" role="status" data-evidence-page>{page.returned ? `${page.offset + 1}–${page.offset + page.returned}` : "0"} of {count(page.total)} evidence requests. Totals describe the full population.</p>
      <p data-evidence-totals>Full evidence population: {count(population.evidence.tokens)} recorded tokens; priced subtotal {evidenceMoney(population.evidence.pricedRequests ? population.evidence.pricedCostUsd : null)} ({count(population.evidence.pricedRequests)} priced / {count(population.evidence.unpricedRequests)} unpriced requests).</p>
      <p>Order: timestamp, source, request ID, original order. Ordinals are zero-based within the original selected population.</p>
      <p>Cache is within input; reasoning is within output. Request metadata only.</p>
      {data.rows.length ? <ol className="mt-3 divide-y divide-line" aria-label="Source-qualified request evidence">
        {data.rows.map(row => <li key={row.identity} data-evidence-identity={row.identity}>
          <EvidenceRequest row={row} tz={data.scope.window.tz} />
        </li>)}
      </ol> : <InvestigationState kind="empty" title={page.total ? "No requests on this page" : "No matching evidence requests"}
        detail={page.total ? "Use the previous page or return to the first page to inspect this population." : "This fixed population has no requests that meet its evidence eligibility."} />}
      <nav className="mt-4 flex flex-wrap items-center gap-2" aria-label="Evidence pagination">
        <button className={control} type="button" disabled={page.offset === 0} onClick={() => change({ offset: 0 })}>First page</button>
        <button className={control} type="button" disabled={page.offset === 0} onClick={() => change({ offset: Math.max(0, page.offset - page.limit) })}>Previous page</button>
        <button className={control} type="button" disabled={page.nextOffset === null} onClick={() => change({ offset: page.nextOffset! })}>Next page</button>
      </nav>
    </section>
  </div>;
}
function FixedWindow({ title, window }: { title: string; window: RadarWindow }) {
  return <div className="rounded-lg border border-line p-3" data-case-window={title}>
    <h3 className="font-semibold text-ink">{title}</h3><p>{window.label} · {window.tz}</p>
    <p className="break-words font-mono text-[11px]">[<time>{new Date(window.from).toISOString()}</time>, <time>{new Date(window.to).toISOString()}</time>)</p>
    <p>From included; until excluded.</p>
  </div>;
}
function Definition({ label, value }: { label: string; value: string | number }) {
  return <><dt className="font-medium text-ink">{label}</dt><dd className="min-w-0 break-words whitespace-pre-wrap">{value}</dd></>;
}
function RadarValues({ period, label }: { period: RadarPeriod; label: string }) {
  return <div><h3 className="font-semibold text-ink">{label}</h3><p>{count(period.totals.requests)} requests · {count(period.totals.tokens)} recorded tokens</p>
    <p>{evidenceMoney(period.totals.pricedRequests ? period.totals.pricedCostUsd : null)} · {count(period.totals.pricedRequests)} priced / {count(period.totals.unpricedRequests)} unpriced</p></div>;
}
function ObservationValues({ observation: o }: { observation: CaseObservation }) {
  if (o.investigation === "project-radar") return <div className="space-y-2">
    <div className="grid gap-3 sm:grid-cols-2"><RadarValues period={o.current} label="Original current observations" /><RadarValues period={o.prior} label="Original prior observations" /></div>
    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
      {(["requests", "tokens", "pricedCostUsd"] as const).map(metric => {
        const comparison = o.comparison[metric];
        return <Definition key={metric} label={metric === "pricedCostUsd" ? "Priced cost comparison" : `${metric === "requests" ? "Request" : "Token"} comparison`}
          value={`${comparison.state === "new" ? "Newly observed in these windows" : comparison.state === "insufficient" ? "Insufficient baseline or price coverage" : "Compared"}; absolute change ${metric === "pricedCostUsd" ? evidenceMoney(comparison.absoluteChange) : count(comparison.absoluteChange)}; relative change ${comparison.relativeChange === null ? "Unavailable" : `${(comparison.relativeChange * 100).toFixed(2)}%`}`} />;
      })}
    </dl>
    <p>Earliest loaded request: {o.history.firstLoadedAt === null ? "Unavailable" : new Date(o.history.firstLoadedAt).toISOString()}. {o.history.current.startsBeforeLoadedHistory ? "Current starts before loaded history. " : ""}{o.history.prior.startsBeforeLoadedHistory ? "Prior starts before loaded history. " : ""}Loaded history completeness is unknown.</p>
    {o.project && !o.project.present ? <p>This exact project group is absent from the currently loaded data.</p> : null}
  </div>;
  if (o.investigation === "spend-changes") {
    const { day, decomposition: d } = o;
    return <div className="space-y-2" data-spend-case>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
        <Definition label="Day state" value={day.state} />
        <Definition label="Priced cost that day" value={evidenceMoney(day.pricedCostUsd)} />
        <Definition label="Baseline median / threshold" value={`${evidenceMoney(day.baseline.medianUsd)} / ${evidenceMoney(day.baseline.thresholdUsd)}`} />
        <Definition label="Priced requests" value={`${count(day.pricedRequests)} of ${count(day.requests)}`} />
        <Definition label="Baseline active days" value={`${day.baseline.activeDays}${day.baseline.firstDate ? ` (${day.baseline.firstDate} to ${day.baseline.lastDate})` : ""}`} />
        {d ? <Definition label="Change vs baseline mean" value={`${evidenceMoney(d.changeUsd)} (${evidenceMoney(d.dayCostUsd)} against a ${evidenceMoney(d.baselineMeanUsd)} mean over ${d.keptBaselineDays} days)`} /> : null}
      </dl>
      <p>Rule: {o.rule.spike}, against {o.rule.baseline}. Recomputed from only the two fixed windows of this case.</p>
      {d && d.excludedBaselineDates.length ? <p>Baseline days left out of the mean as earlier spikes: {d.excludedBaselineDates.join(", ")}.</p> : null}
    </div>;
  }
  if (o.investigation === "cache-detective") {
    const t = o.totals, available = t.eligibleRequests > 0;
    return <div className="space-y-2"><dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
      {([["Cache-read discount", t.readDiscountUsd], ["Cache-write premium", t.writePremiumUsd], ["Net API-equivalent benefit", t.netUsd],
        ["Actual fixed-workload price", t.actualUsd], ["Same workload priced uncached", t.baselineUsd]] as const)
        .map(([label, value]) => <Definition key={label} label={label} value={evidenceMoney(available ? value : null)} />)}
      <Definition label="Eligible read / write tokens" value={available ? `${count(t.readTokens)} / ${count(t.writeTokens)}` : "Unavailable"} />
    </dl>
      <p>Net = read discount − write premium; each component is rounded once to six decimal places by the server.</p>
      <p>Eligible tier coverage: {t.longContextRequests} long-context; {t.confirmedTierRequests} confirmed service tier; {t.requestedTierOnlyRequests} requested/configured tier only; {t.priorityRequests} priority; {t.lowerBoundRequests} lower-bound; {t.derivedRateRequests} derived rate; {t.explicitFreeRequests} explicitly free.</p>
      <ProjectExclusions coverage={o.projectCoverage} />
    </div>;
  }
  return <div className="space-y-2">
    {o.growth ? <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
      <Definition label="First-three eligible input median" value={count(o.growth.baseline)} />
      <Definition label="Last-three eligible input median" value={count(o.growth.latest)} />
      <Definition label="Submitted-input change · tokens" value={count(o.growth.absoluteChange)} />
      <Definition label="Latest / baseline median" value={o.growth.ratio === null ? o.growth.ranked && o.growth.baseline === 0 ? "Unavailable (zero baseline)" : "Unavailable" : String(o.growth.ratio)} />
    </dl> : null}
    {o.history ? <p>Loaded session history: {o.history.beforeWindowRequests} before the window; {o.history.afterWindowRequests} at/after its end; {o.history.outsideCohortRequests} inside the window but outside this cohort. {o.history.rangeLimited || o.history.cohortLimited ? "This sequence is limited by the fixed window or cohort." : "No loaded requests outside this selection."}</p> : null}
    <ProjectExclusions coverage={o.projectCoverage} />
  </div>;
}
function ProjectExclusions({ coverage }: { coverage: { unattributedRows: number; attribution: { outsideProjects: { rows: number } } } | null }) {
  return coverage ? <p>Outside the strict project-filtered cohort: {coverage.unattributedRows} unattributed requests and {coverage.attribution.outsideProjects.rows} requests in other projects. These are outside case totals.</p> : null;
}

export function EvidenceRequest({ row, tz }: { row: EvidenceRow; tz: string }) {
  const time = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "long", timeZone: tz }).format(row.ts);
  return <details className="py-3">
    <summary className="cursor-pointer rounded text-ink">
      <span className="break-words">#{row.ordinal} · {sourceLabel(row.source)} · {row.conversationId === null ? "Unnamed (no session ID)" : `session ${row.conversationId}`} · request {row.id}</span>
      <span className="mt-1 block text-[11px] text-ink-soft"><time dateTime={new Date(row.ts).toISOString()}>{time}</time> · {row.ts} ms · original ordinal {row.originalOrdinal}</span>
      <span className="block text-ink-soft">{row.model} · input {count(row.inputTokens)} · {evidenceMoney(row.cost)}{!row.eligible ? " · Excluded from comparison" : ""}</span>
    </summary>
    <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
      <Definition label="Source" value={`${sourceLabel(row.source)} (${row.source})`} /><Definition label="Protocol" value={row.protocol ?? "Unavailable"} />
      <Definition label="Session ID" value={row.conversationId ?? "Unnamed (no session ID)"} /><Definition label="Request ID" value={row.id} />
      <Definition label="Selected population ordinal" value={row.ordinal} /><Definition label="Original loaded ordinal" value={row.originalOrdinal} />
      <Definition label="Timestamp" value={`${new Date(row.ts).toISOString()} (${row.ts} ms)`} />
      <Definition label="Project group" value={row.project.project} /><Definition label="Working folder" value={row.cwd ?? "Unavailable"} />
      <Definition label="Provider / model / effort" value={`${row.provider} / ${row.model} / ${row.effort ?? "Unavailable"}`} />
      <Definition label="Submitted input · tokens" value={count(row.inputTokens)} /><Definition label="Cache read within input · tokens" value={count(row.cacheReadTokens)} />
      <Definition label="Cache write within input · tokens" value={count(row.cacheWriteTokens)} /><Definition label="Output · tokens" value={count(row.outputTokens)} />
      <Definition label="Reasoning within output · tokens" value={count(row.reasoningTokens)} /><Definition label="Recorded token total" value={count(row.totalTokens)} />
      <Definition label="API list-price equivalent · USD" value={evidenceMoney(row.cost)} /><Definition label="Usage / cache accounting" value={`${row.usageStatus}; ${row.measurements.usage}; ${row.cacheProvenance ?? "Unavailable"}`} />
      <Definition label="Duration" value={row.durationMs === null ? "Unavailable" : `${row.durationMs} ms`} /><Definition label="Time to first token" value={row.ttftMs === null ? "Unavailable" : `${row.ttftMs} ms`} />
      <Definition label="Outcome" value={row.outcome} /><Definition label="Comparison eligibility" value={row.eligible ? "Eligible" : row.exclusionReason ?? "Excluded"} />
    </dl>
    {row.inputTokens === null ? <p className="mt-2">Submitted input is unavailable for context comparisons. Recorded totals can include incomplete or attempt-summed accounting.</p> : null}
  </details>;
}
