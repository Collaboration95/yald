import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { caseQuery, parseCaseIntent, type CaseIntent, type CaseSelector } from "../../../../server/src/labs/evidence-intent";
import { ApiError, fetchJson, sourceLabel } from "../../api";
import type { EvidenceCaseResponse } from "../../labs/evidence-types";
import { InfoTip, ModelTag, TableShell, Td, Th } from "../../components/ui";
import { formatCompact, formatInteger, formatUsd, shortPath } from "../../lib/format";
import { InvestigationState } from "./InvestigationState";

const TABS = { "project-radar": { label: "Projects", path: "project-radar" }, "cache-detective": { label: "Cache savings", path: "cache-detective" },
  "context-replay": { label: "Context growth", path: "context-replay" }, "spend-changes": { label: "Spikes", path: "spend-spikes" } } as const;
const control = "rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink disabled:opacity-40";
const clock = (ts: number, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);

function selectionText(selection: CaseSelector["selection"]) {
  return selection.kind === "scope" ? "All matching requests" : selection.kind === "project" ? shortPath(selection.project)
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

/** The requests behind a finding as a plain table: time, model, project, tokens, cost. */
export function EvidenceCaseView({ data }: { data: EvidenceCaseResponse }) {
  const [, setParams] = useSearchParams();
  const { intent, observation, population, page } = data;
  const tab = TABS[intent.investigation];
  const tz = data.scope.window.tz;
  const change = (patch: { offset?: number; period?: "current" | "prior" }) => setParams(current => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(patch)) next.set(key, String(value));
    return next;
  });
  const info = <>
    <span className="block">{observation.summary}</span>
    <span className="mt-1 block">Window: {data.scope.window.label} ({tz}). {formatInteger(population.eligibleRequests)} of {formatInteger(population.original.requests)} requests were usable for the comparison; {formatInteger(population.excludedRequests)} are left out of it but still listed.</span>
    <span className="mt-1 block">{formatInteger(population.original.unpricedRequests)} requests have no price. Costs are API list-price equivalents, not a bill. This list keeps its own fixed scope; changing the toolbar affects your next investigation.</span>
    {observation.notes.map(note => <span key={note} className="mt-1 block">{note}</span>)}
  </>;
  return <div className="space-y-3" data-evidence-case={intent.investigation}>
    <Link to={`/labs/${tab.path}`} className="inline-block rounded px-1 py-1 text-[12px] text-accent">← Back to {tab.label}</Link>
    <section className="card space-y-3 p-4" aria-labelledby="case-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="case-title" className="flex items-center gap-1.5 text-[15px] font-semibold text-ink" data-case-selection>
          {selectionText(intent.selector.selection)}
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
      {data.rows.length ? <TableShell>
        <thead>
          <tr><Th>Time</Th><Th>Model</Th><Th>Project</Th><Th align="right">Tokens</Th><Th align="right">Cost</Th></tr>
        </thead>
        <tbody>
          {data.rows.map(row => <tr key={row.identity} className={row.eligible ? "transition hover:bg-surface-2" : "opacity-60"} data-evidence-identity={row.identity}>
            <Td className="whitespace-nowrap text-muted" ><time dateTime={new Date(row.ts).toISOString()} title={new Date(row.ts).toISOString()}>{clock(row.ts, tz)}</time></Td>
            <Td className="max-w-[220px]"><ModelTag model={row.model} /></Td>
            <Td className="max-w-[200px] truncate" ><span title={row.cwd ?? undefined}>{row.project.project === "(unattributed)" ? "—" : shortPath(row.project.project)}</span></Td>
            <Td align="right">{row.totalTokens === null ? "—" : formatCompact(row.totalTokens)}</Td>
            <Td align="right">{row.cost === null ? "—" : formatUsd(row.cost)}</Td>
          </tr>)}
        </tbody>
      </TableShell> : <InvestigationState kind="empty" title={page.total ? "No requests on this page" : "No requests"} detail={page.total ? "Go back a page." : "This finding has no requests to list."} />}
      <nav className="flex flex-wrap items-center gap-2" aria-label="Pages">
        <button className={control} type="button" disabled={page.offset === 0} onClick={() => change({ offset: Math.max(0, page.offset - page.limit) })}>Previous</button>
        <button className={control} type="button" disabled={page.nextOffset === null} onClick={() => change({ offset: page.nextOffset! })}>Next</button>
        <span className="text-[11.5px] text-muted" role="status" data-evidence-page>{page.returned ? `${page.offset + 1}–${page.offset + page.returned}` : "0"} of {formatInteger(page.total)} requests</span>
      </nav>
    </section>
  </div>;
}
