import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { filtersKey, sourceLabel, useContextReplay } from "../../api";
import { Chart } from "../../components/Chart";
import { Card, CardHeader, TableShell, Td, Th } from "../../components/ui";
import { useChartStyle } from "../../lib/chartStyle";
import { formatDuration, formatInteger } from "../../lib/format";
import { colorAt } from "../../lib/palette";
import { useTheme } from "../../lib/theme";
import { useFilters } from "../../lib/useFilters";
import type { ContextObservation, ContextReplayResponse, ContextSession } from "../../types";
import { InvestigationScope } from "./InvestigationScope";
import { InvestigationState } from "./InvestigationState";
import { contextCost, contextEvidenceHref, contextModelColor, contextTimelineOption, contextTimestamp, contextTokens } from "./contextReplayChart";

export function ContextReplay() {
  const { filters } = useFilters();
  const query = useContextReplay(filters);
  if (query.isLoading) return <InvestigationState kind="loading" />;
  if (query.error) return <InvestigationState kind="error" detail={query.error.message} onRetry={() => void query.refetch()} />;
  if (!query.data) return <InvestigationState kind="empty" />;
  return <ContextReplayView key={filtersKey(filters)} data={query.data} />;
}

const signedTokens = (value: number | null) => value === null ? "Unavailable" : `${value > 0 ? "+" : ""}${formatInteger(value)}`;
const requestKey = (row: ContextObservation) => JSON.stringify([row.ordinal, row.ts, row.id]);

export function ContextReplayView({ data }: { data: ContextReplayResponse }) {
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const session = data.sessions.find(item => item.key === sessionKey) ?? data.sessions[0];
  return <div className="space-y-3" aria-label="Context Replay">
    <header>
      <h1 className="text-lg font-semibold text-ink">Context Replay</h1>
      <p className="mt-1 text-[12px] leading-5 text-ink-soft">Submitted input across time-ordered requests. Cache read and write are already included in input.</p>
      <p className="mt-1 text-[12px] leading-5 text-ink" aria-label="Replay period">
        <time dateTime={data.window.fromIso}>{contextTimestamp(data.window.from, data.window.tz)}</time> (included)
        {" → "}<time dateTime={data.window.toIso}>{contextTimestamp(data.window.to, data.window.tz)}</time> (excluded) · {data.window.tz}
      </p>
      <p className="mt-1 text-[12px] leading-5 text-muted">{formatInteger(data.coverage.eligibleRequests)} of {formatInteger(data.coverage.totalRequests)} requests eligible
        {" · "}{formatInteger(data.coverage.excludedRequests)} excluded from context comparisons
        {" · "}{formatInteger(data.unnamedRequests)} without a session ID.</p>
    </header>

    {data.coverage.totalRequests === 0 ? <InvestigationState kind="empty" /> : !session ? <InvestigationState kind="insufficient"
      title="No named sessions" detail="Requests without a session ID remain in scope coverage and evidence. A session sequence is unavailable." /> : <>
      <Card>
        <CardHeader title="Sessions by input change" subtitle="Server order: signed change from the first-three eligible input median to the last-three median. At least six eligible requests are required." />
        <TableShell className="max-h-[280px] overflow-auto">
          <thead><tr><Th>Source / session</Th><Th align="right">Eligible / selected</Th><Th align="right">First median</Th><Th align="right">Last median</Th><Th align="right">Change · tokens</Th><Th align="right">Last / first</Th></tr></thead>
          <tbody>{data.sessions.map(item => <tr key={item.key} className={item.key === session.key ? "bg-surface-3" : "hover:bg-surface-2"}>
            <Td><button type="button" aria-pressed={item.key === session.key} aria-label={`Select ${sourceLabel(item.source)} session ${item.conversationId}`}
              className="block w-full rounded text-left text-ink" onClick={() => setSessionKey(item.key)}>
              <span className="block text-[11px] text-ink-soft">{sourceLabel(item.source)}</span>
              <span className="block max-w-[320px] truncate font-mono text-[11px]" title={item.conversationId}>{item.conversationId}</span>
              {!item.growth.ranked ? <span className="block text-[11px] text-muted">Insufficient data · unranked</span> : null}
              {item.truncated ? <span className="block text-[11px] text-muted">Window or cohort limits history</span> : null}
            </button></Td>
            <Td align="right">{formatInteger(item.eligibleRequests)} / {formatInteger(item.inWindowRequests)}</Td>
            <Td align="right">{contextTokens(item.growth.baseline)}</Td><Td align="right">{contextTokens(item.growth.latest)}</Td>
            <Td align="right">{item.growth.ranked ? signedTokens(item.growth.absoluteChange) : "Unranked"}</Td>
            <Td align="right">{item.growth.ratio === null ? (item.growth.ranked && item.growth.baseline === 0 ? "Unavailable · zero baseline" : "Unavailable") : `${item.growth.ratio.toLocaleString("en-US", { maximumFractionDigits: 3 })}×`}</Td>
          </tr>)}</tbody>
        </TableShell>
      </Card>
      <ContextSessionReplay key={session.key} session={session} tz={data.window.tz} />
    </>}

    <div className="flex flex-wrap items-center gap-3 text-[12px]">
      <Link className="rounded border border-line px-3 py-2 text-ink hover:border-line-strong" to={contextEvidenceHref(data.coverage.evidence)}>Open scope requests</Link>
      <span className="text-muted">Evidence includes excluded requests and requests without a session ID.</span>
    </div>
    <details className="space-y-3 text-[12px]">
      <summary className="cursor-pointer rounded py-2 font-medium text-ink">Scope, coverage and loaded-history limits</summary>
      <InvestigationScope window={data.window} cohort={data.cohort} sample={data.coverage}
        unpricedRequests={data.coverage.unpricedRequests} unattributedRequests={data.coverage.unattributedRequests} />
      <Card><h2 className="text-[13px] font-semibold text-ink">Context exclusions</h2>
        <Exclusions counts={data.coverage.exclusions} />
        {data.coverage.projectCoverage ? <p className="mt-2 leading-5 text-ink-soft">Project selection excluded {formatInteger(data.coverage.projectCoverage.attribution.outsideProjects.rows)} requests in other projects
          {" and "}{formatInteger(data.coverage.projectCoverage.attribution.unattributed.rows)} requests without a known folder.</p> : null}
        <ul className="mt-3 list-disc space-y-1 pl-5 leading-5 text-ink-soft">{data.limitations.map(note => <li key={note}>{note}</li>)}</ul>
      </Card>
    </details>
  </div>;
}

function Exclusions({ counts }: { counts: ContextSession["exclusions"] }) {
  return <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted">{counts.map(item => <li key={item.reason}>{item.reason}: {formatInteger(item.requests)}</li>)}</ul>;
}

function ContextSessionReplay({ session, tz }: { session: ContextSession; tz: string }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = session.requests.find(row => requestKey(row) === selectedKey) ?? session.requests[0];
  const { chartTheme } = useTheme();
  const design = useChartStyle();
  const modelColor = design?.modelColor ?? contextModelColor;
  const option = useMemo(() => contextTimelineOption(chartTheme, session, tz, modelColor), [chartTheme, session, tz, modelColor]);
  return <>
    <Card>
      <CardHeader title="Submitted and cached input" subtitle={<><span className="font-medium">{sourceLabel(session.source)}</span> · <span className="break-all font-mono">{session.conversationId}</span></>}
        action={<Link className="rounded border border-line px-3 py-2 text-[12px] text-ink hover:border-line-strong" to={contextEvidenceHref(session.evidence)}>Open session requests</Link>} />
      <p className="text-[12px] leading-5 text-ink-soft">{formatInteger(session.eligibleRequests)} of {formatInteger(session.inWindowRequests)} selected requests eligible; {formatInteger(session.excludedRequests)} excluded.
        {" "}History covers loaded data only.</p>
      {session.truncated ? <p className="mt-1 text-[12px] leading-5 text-ink-soft">Sequence limited by {session.history.rangeLimited ? "the window" : ""}{session.history.rangeLimited && session.history.cohortLimited ? " and " : ""}{session.history.cohortLimited ? "the cohort" : ""}:
        {" "}{formatInteger(session.history.beforeWindowRequests)} loaded requests before the window, {formatInteger(session.history.afterWindowRequests)} at or after its end,
        {" "}{formatInteger(session.history.outsideCohortRequests)} within the window outside the cohort. {formatInteger(session.totalRequests)} loaded requests in this source/session.</p> : null}
      <Exclusions counts={session.exclusions} />
      {!session.growth.ranked ? <div className="mt-3"><InvestigationState kind="insufficient" title="Insufficient data for growth ranking"
        detail={`${formatInteger(session.eligibleRequests)} eligible requests; at least six are needed. Every selected request remains inspectable below.`} /></div> : <p className="mt-2 text-[12px] text-ink-soft">
        First-three median {contextTokens(session.growth.baseline)} → last-three median {contextTokens(session.growth.latest)} input tokens · change {signedTokens(session.growth.absoluteChange)} tokens.
      </p>}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-soft" aria-label="Input series legend">
        {["Submitted input", "Cache read", "Cache write"].map((name, index) => <span key={name} className="inline-flex items-center gap-1.5">
          <span className="w-4 border-t-2" style={{ borderColor: design?.color(colorAt(index)) ?? colorAt(index), borderTopStyle: index === 0 ? "solid" : "dashed" }} aria-hidden="true" />
          {name} · {index === 0 ? "solid" : "dashed"}
        </span>)}
      </div>
      <div aria-label="Context input chart"><Chart option={option} height={320} onEvents={{ click: params => {
        const row = session.requests[(params as { dataIndex: number }).dataIndex];
        if (row) setSelectedKey(requestKey(row));
      } }} /></div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-soft" aria-label="Model markers">{[...new Set(session.requests.map(row => row.model))].map(model =>
        <span key={model} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: modelColor(model) }} aria-hidden="true" />{model}</span>)}</div>
      <p className="mt-2 text-[11.5px] leading-5 text-muted">Points mark observed context, including reported zero. Excluded requests leave gaps in every series. Select a request below to inspect gaps.
        {" "}Request order can include concurrent agents. Input decreases and model changes are observations; their proximity does not establish a cause.</p>
    </Card>
    <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)]">
      <Card>
        <CardHeader title="Requests in this sequence" subtitle="Index follows server order. Equal timestamps remain separate requests. Select a row button with Tab, then Enter or Space." />
        <TableShell className="max-h-[540px] overflow-auto">
          <thead><tr><Th>Request / time</Th><Th>Model</Th><Th align="right">Input tokens</Th><Th align="right">Cost · USD</Th></tr></thead>
          <tbody>{session.requests.map(row => <tr key={requestKey(row)} className={row === selected ? "bg-surface-3" : "hover:bg-surface-2"}>
            <Td><button type="button" aria-label={`Select request ${row.ordinal + 1}: ${row.id}`} aria-pressed={row === selected}
              className="block w-full rounded text-left text-ink" onClick={() => setSelectedKey(requestKey(row))}>
              <span className="block font-mono text-[11px]">#{row.ordinal + 1} · {row.id}</span>
              <time className="block whitespace-nowrap text-[10.5px] text-muted" dateTime={new Date(row.ts).toISOString()}>{contextTimestamp(row.ts, tz)}</time>
              {!row.eligible ? <span className="block text-[11px] text-muted">Excluded · {row.exclusionReason}</span> : null}
            </button></Td>
            <Td><span className="inline-flex items-center gap-1.5 break-all text-[11px]"><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: modelColor(row.model) }} aria-hidden="true" />{row.model}</span></Td>
            <Td align="right">{contextTokens(row.eligible ? row.inputTokens : null)}</Td><Td align="right">{contextCost(row)}</Td>
          </tr>)}</tbody>
        </TableShell>
      </Card>
      {selected ? <ContextRequestDetails row={selected} session={session} tz={tz} /> : null}
    </div>
  </>;
}

export function ContextRequestDetails({ row, session, tz }: { row: ContextObservation; session: ContextSession; tz: string }) {
  const values: [string, string][] = [
    ["Source", sourceLabel(row.source)], ["Session", session.conversationId], ["Request ID", row.id],
    ["Time", `${contextTimestamp(row.ts, tz)} · ${tz}`], ["Provider", row.provider], ["Model", row.model],
    ["Requested model", row.requestedModel ?? "Unavailable"], ["Resolved model", row.resolvedModel ?? "Unavailable"], ["Effort", row.effort ?? "Unavailable"],
    ["Submitted input · tokens", contextTokens(row.eligible ? row.inputTokens : null)], ["Cache read · tokens", contextTokens(row.cacheReadTokens)],
    ["Cache write · tokens", contextTokens(row.cacheWriteTokens)], ["Output · tokens", contextTokens(row.outputTokens)],
    ["Reasoning within output · tokens", contextTokens(row.reasoningTokens)], ["Total · input + output tokens", contextTokens(row.totalTokens)],
    ["API list-price equivalent · USD", contextCost(row)], ["Price estimate", row.priced && row.cost !== null ? (row.estimated ? "Estimated" : "Listed rate") : "Unavailable"],
    ["Duration", row.durationMs === null ? "Unavailable" : formatDuration(row.durationMs)], ["Time to first token", row.ttftMs === null ? "Unavailable" : formatDuration(row.ttftMs)],
    ["Usage accounting", row.measurements.usage], ["Usage status", row.usageStatus], ["Cache provenance", row.cacheProvenance ?? "Unavailable"], ["Protocol", row.protocol ?? "Unavailable"],
  ];
  return <section className="card min-w-0 p-4" aria-label="Selected request" aria-live="polite">
    <h2 className="text-[13.5px] font-semibold text-ink">Selected request #{row.ordinal + 1}</h2>
    <p className="mt-1 text-[12px] leading-5 text-ink-soft">{row.eligible ? "Eligible context observation." : `Excluded from context comparisons: ${row.exclusionReason}.`}</p>
    {row.usageFromAttempts || row.measurements.usage === "attempt-sum" ? <p className="mt-2 text-[11.5px] leading-5 text-muted">Token counters below describe summed attempts. They do not provide request context; every context chart series is unavailable here.</p> : null}
    <dl className="mt-3 grid gap-x-3 gap-y-2 text-[11.5px] leading-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">{values.map(([label, value]) =>
      <div key={label} className="contents"><dt className="text-muted">{label}</dt><dd className="min-w-0 whitespace-pre-wrap break-words text-ink">{value}</dd></div>)}</dl>
    <p className="mt-3 text-[11px] leading-5 text-muted">Cache counters are within submitted input. Reasoning is within output and is never added again. Missing price or timing remains unavailable.</p>
  </section>;
}
