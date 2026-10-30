import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { caseQuery, parseCaseIntent, type CaseIntent, type CaseSelector } from "../../../../server/src/labs/evidence-intent";
import { ApiError, fetchJson, sourceLabel } from "../../api";
import type { EvidenceCaseResponse, QuotaInterval } from "../../labs/evidence-types";
import { InfoTip, ModelTag, TableShell, Td, Th } from "../../components/ui";
import { formatCompact, formatDuration, formatInteger, formatNumber, formatUsd, quotaLabel, shortPath } from "../../lib/format";
import { LEDGER_NAMES } from "./CacheRebuilds";
import { InvestigationState } from "./InvestigationState";

const TABS = { "project-radar": { label: "Projects", path: "project-radar" }, "cache-detective": { label: "Cache savings", path: "cache-detective" },
  "context-replay": { label: "Context growth", path: "context-replay" }, "spend-changes": { label: "Spikes", path: "spend-spikes" }, "quota-pace": { label: "Quota pace", path: "quota-pace" } } as const;
const control = "rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink disabled:opacity-40";
const clock = (ts: number, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);

function selectionText({ selection, eligibility, cause }: CaseSelector) {
  if (eligibility === "rebuild" && selection.kind === "scope") return cause ? LEDGER_NAMES[cause] : "All cache rebuilds";
  if (selection.kind === "branch") return `${shortPath(selection.project)} · ${selection.state === "named" ? selection.branch : selection.state === "detached" ? "Detached HEAD" : "No branch recorded"}`;
  if (selection.kind === "account") return `${quotaLabel(selection.window)} · ${selection.account === "codex-rollouts" ? "Codex sessions" : selection.account}`;
  return selection.kind === "scope" ? "All matching requests" : selection.kind === "project" ? shortPath(selection.project)
    : selection.kind === "chain" ? `Session ${selection.conversationId.slice(0, 6)} · ${selection.agentId === "main" ? "main agent" : "subagent"} · cache rebuilds`
    : selection.kind === "session" ? `Session ${selection.conversationId.slice(0, 6)} · ${sourceLabel(selection.source)}`
    : `${selection.source ? sourceLabel(selection.source) + " · " : ""}Requests with no session`;
}

/** Mounts only inside LabsLayout. Toolbar filters are deliberately absent from the query key. */
export function EvidenceCase() {
  const { search } = useLocation();
  const decoded = useMemo(() => {
    try { return { intent: parseCaseIntent(new URLSearchParams(search)) }; }
    catch (error) { return { error: error instanceof Error ? error.message : "Open the finding again to recover this link." }; }
  }, [search]);
  return decoded.intent ? <EvidenceCaseQuery intent={decoded.intent} /> : <div className="space-y-3">
    <InvestigationState kind="error" title="Invalid link" detail={decoded.error} />
    <Link to="/labs" className="inline-block rounded px-1 py-2 text-[12px] text-accent">Back to Labs</Link>
  </div>;
}

function EvidenceCaseQuery({ intent }: { intent: CaseIntent }) {
  const query = caseQuery(intent);
  const result = useQuery<EvidenceCaseResponse>({ queryKey: ["labs-evidence", query],
    queryFn: () => fetchJson<EvidenceCaseResponse>("/api/labs/evidence", query),
    retry: (attempt, error) => !(error instanceof ApiError && error.status === 400) && attempt < 1,
    staleTime: 15_000, refetchInterval: 30_000, refetchOnWindowFocus: false, refetchIntervalInBackground: false });
  if (result.isPending) return <InvestigationState kind="loading" title="Loading requests" detail="Reading the requests behind this finding." />;
  if (result.isError) return <InvestigationState kind="error" title={result.error instanceof ApiError && result.error.status === 400 ? "Invalid link" : "Requests unavailable"}
    detail={result.error instanceof ApiError && result.error.status === 400 ? result.error.message : "The requests could not be loaded. Try again."}
    onRetry={() => void result.refetch()} />;
  return <EvidenceCaseView data={result.data} />;
}

const EXCLUSIONS: Record<NonNullable<QuotaInterval["exclusion"]>, string> = { reset: "reset", fell: "used percent fell", "no-change": "no change", gap: "gap over 24 hours" };

/** A quota case lists sample intervals, not requests. An interval with requests opens them. */
function QuotaIntervals({ intervals, tz, open }: { intervals: QuotaInterval[]; tz: string; open: (index: number) => void }) {
  return <TableShell>
    <thead><tr><Th>From</Th><Th>To</Th><Th align="right">Before</Th><Th align="right">After</Th><Th align="right">Change</Th><Th align="right">Requests</Th><Th align="right">Tokens</Th><Th align="right">Cost</Th><Th>Left out</Th></tr></thead>
    <tbody>{intervals.map(interval => <tr key={interval.index} className={interval.exclusion ? "opacity-60" : undefined}>
      <Td className="whitespace-nowrap text-muted">{clock(interval.fromTs, tz)}</Td><Td className="whitespace-nowrap text-muted">{clock(interval.toTs, tz)}</Td>
      <Td align="right">{formatNumber(interval.usedBefore)}%</Td><Td align="right">{formatNumber(interval.usedAfter)}%</Td><Td align="right">{formatNumber(interval.change)}</Td>
      <Td align="right">{interval.requests ? <button type="button" className="text-accent" onClick={() => open(interval.index)}>{formatInteger(interval.requests)}</button> : interval.requests === null ? "unavailable" : "0"}</Td>
      <Td align="right">{interval.tokens === null ? "unavailable" : formatCompact(interval.tokens)}</Td>
      <Td align="right">{interval.costUsd === null ? "unavailable" : formatUsd(interval.costUsd)}</Td>
      <Td>{interval.exclusion ? EXCLUSIONS[interval.exclusion] : ""}</Td>
    </tr>)}</tbody>
  </TableShell>;
}

/** Each row shows what the class was read from, so it can be checked by eye. */
function RebuildRows({ rows, tz }: { rows: EvidenceCaseResponse["rows"]; tz: string }) {
  return <TableShell>
    <thead>
      <tr><Th>Time</Th><Th>Model</Th><Th>Class</Th><Th>Label</Th><Th align="right">Gap</Th><Th>Previous model</Th><Th align="right">Previous read / write</Th><Th align="right">Read / write</Th><Th align="right">Rewritten</Th><Th align="right">Premium</Th></tr>
    </thead>
    <tbody>
      {rows.map(row => {
        const rebuild = row.rebuild!;
        const also = rebuild.signals.slice(1).map(signal => LEDGER_NAMES[signal].toLowerCase());
        return <tr key={row.identity} className="transition hover:bg-surface-2" data-evidence-identity={row.identity}>
          <Td className="whitespace-nowrap text-muted"><time dateTime={new Date(row.ts).toISOString()} title={new Date(row.ts).toISOString()}>{clock(row.ts, tz)}</time></Td>
          <Td className="max-w-[180px]"><ModelTag model={row.model} /></Td>
          <Td><span title={[rebuild.reason, also.length ? `also ${also.join(", ")}` : null].filter(Boolean).join("; ") || undefined}>{LEDGER_NAMES[rebuild.class]}</span></Td>
          <Td>{rebuild.label}</Td>
          <Td align="right">{rebuild.gapMs === null ? "first" : formatDuration(rebuild.gapMs)}</Td>
          <Td className="max-w-[180px]">{rebuild.previous ? <ModelTag model={rebuild.previous.model} /> : "first"}</Td>
          <Td align="right">{rebuild.previous ? `${formatCompact(rebuild.previous.cacheReadTokens)} / ${formatCompact(rebuild.previous.cacheWriteTokens)}` : "first"}</Td>
          <Td align="right">{formatCompact(row.cacheReadTokens)} / {formatCompact(row.cacheWriteTokens)}</Td>
          <Td align="right">{formatCompact(rebuild.rewrittenTokens)}</Td>
          <Td align="right">{rebuild.premiumUsd === null ? "unpriced" : formatUsd(rebuild.premiumUsd)}</Td>
        </tr>;
      })}
    </tbody>
  </TableShell>;
}

/** The requests behind a finding as a plain table: time, model, project, tokens, cost. */
export function EvidenceCaseView({ data }: { data: EvidenceCaseResponse }) {
  const [, setParams] = useSearchParams();
  const { intent, observation, population, page } = data;
  const tab = TABS[intent.investigation];
  const tz = data.scope.window.tz;
  const change = (patch: { offset?: number; period?: "current" | "prior"; interval?: number | null }) => setParams(current => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, String(value));
    }
    return next;
  });
  const intervals = observation.investigation === "quota-pace" && intent.interval === undefined ? observation : null;
  const shown = intervals ? intervals.intervalPage : page;
  const info = <>
    <span className="block">{observation.summary}</span>
    <span className="mt-1 block">Window: {new Date(data.scope.window.from).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz })} to {new Date(data.scope.window.to).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz })} ({tz}). {formatInteger(population.eligibleRequests)} of {formatInteger(population.original.requests)} requests were usable for the comparison; {formatInteger(population.excludedRequests)} are left out of it but still listed.</span>
    <span className="mt-1 block">{formatInteger(population.original.unpricedRequests)} requests have no price. Costs are API list-price equivalents, not a bill. This list keeps its own fixed scope; changing the toolbar affects your next investigation.</span>
    {observation.notes.map(note => <span key={note} className="mt-1 block">{note}</span>)}
  </>;
  return <div className="space-y-3" data-evidence-case={intent.investigation}>
    <Link to={`/labs/${tab.path}`} className="inline-block rounded px-1 py-1 text-[12px] text-accent">← Back to {tab.label}</Link>
    <section className="card space-y-3 p-4" aria-labelledby="case-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="case-title" className="flex items-center gap-1.5 text-[15px] font-semibold text-ink" data-case-selection>
          {selectionText(intent.selector)}
          <InfoTip label="About these requests">{info}</InfoTip>
        </h2>
        {intent.priorSelector ? <div className="flex items-center gap-1" role="group" aria-label="Period">
          <button type="button" aria-pressed={intent.period === "current"} className={`${control} aria-pressed:bg-surface-3`} onClick={() => change({ period: "current", offset: 0 })}>Now</button>
          <button type="button" aria-pressed={intent.period === "prior"} className={`${control} aria-pressed:bg-surface-3`} onClick={() => change({ period: "prior", offset: 0 })}>Before</button>
        </div> : null}
      </div>
      {observation.state !== "observed" ? <InvestigationState kind={observation.state}
        title={observation.state === "empty" ? "No requests here" : "Not enough data to compare"}
        detail={observation.state === "empty" ? "Nothing matches this finding any more." : "The requests are listed below; the comparison itself needs more data."} /> : null}
      {observation.investigation === "context-replay" && observation.compaction?.events.length ? <div>
        <p className="mb-1 text-[11.5px] text-muted">Recorded compactions in this window{observation.compaction.outsideWindowEvents ? ` (${formatInteger(observation.compaction.outsideWindowEvents)} more outside it, not listed)` : ""}</p>
        <TableShell>
          <thead><tr><Th>Time</Th><Th>Trigger</Th><Th align="right">Before</Th><Th align="right">After</Th><Th align="right">After request</Th></tr></thead>
          <tbody>{observation.compaction.events.map(event => <tr key={event.ts}>
            <Td>{clock(event.ts, tz)}</Td><Td>{event.trigger ?? "not recorded"}</Td>
            <Td align="right">{formatCompact(event.preTokens)}</Td><Td align="right">{formatCompact(event.postTokens)}</Td><Td align="right">{formatInteger(event.position)}</Td>
          </tr>)}</tbody>
        </TableShell>
      </div> : null}
      {intent.interval !== undefined ? <button type="button" className={control} onClick={() => change({ interval: null, offset: 0 })}>Back to intervals</button> : null}
      {intervals ? (intervals.intervals.length ? <QuotaIntervals intervals={intervals.intervals} tz={tz} open={index => change({ interval: index, offset: 0 })} />
        : <InvestigationState kind="empty" title="No intervals here" detail="A window needs two samples to have an interval." />)
        : intent.selector.eligibility === "rebuild" && data.rows.length ? <RebuildRows rows={data.rows} tz={tz} /> : data.rows.length ? <TableShell>
        <thead>
          <tr><Th>Time</Th><Th>Model</Th><Th>Project</Th>{intent.investigation === "project-radar" ? <Th>Branch</Th> : null}<Th align="right">Tokens</Th><Th align="right">Cost</Th></tr>
        </thead>
        <tbody>
          {data.rows.map(row => <tr key={row.identity} className={row.eligible ? "transition hover:bg-surface-2" : "opacity-60"} data-evidence-identity={row.identity}>
            <Td className="whitespace-nowrap text-muted" ><time dateTime={new Date(row.ts).toISOString()} title={new Date(row.ts).toISOString()}>{clock(row.ts, tz)}</time></Td>
            <Td className="max-w-[220px]"><ModelTag model={row.model} /></Td>
            <Td className="max-w-[200px] truncate" ><span title={row.cwd ?? undefined}>{row.project.project === "(unattributed)" ? "—" : shortPath(row.project.project)}</span></Td>
            {intent.investigation === "project-radar" ? <Td className="max-w-[180px] truncate"><span title={row.gitBranch ?? undefined}>{row.gitBranch ?? "not recorded"}</span></Td> : null}
            <Td align="right">{row.totalTokens === null ? "—" : formatCompact(row.totalTokens)}</Td>
            <Td align="right">{row.cost === null ? "—" : formatUsd(row.cost)}</Td>
          </tr>)}
        </tbody>
      </TableShell> : <InvestigationState kind="empty" title={page.total ? "No requests on this page" : "No requests"} detail={page.total ? "Go back a page." : "This finding has no requests to list."} />}
      <nav className="flex flex-wrap items-center gap-2" aria-label="Pages">
        <button className={control} type="button" disabled={shown.offset === 0} onClick={() => change({ offset: Math.max(0, shown.offset - shown.limit) })}>Previous</button>
        <button className={control} type="button" disabled={shown.nextOffset === null} onClick={() => change({ offset: shown.nextOffset! })}>Next</button>
        <span className="text-[11.5px] text-muted" role="status" data-evidence-page>{shown.returned ? `${shown.offset + 1}–${shown.offset + shown.returned}` : "0"} of {formatInteger(shown.total)} {intervals ? "intervals" : "requests"}</span>
      </nav>
    </section>
  </div>;
}
