import { useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ArrowLeft, MessagesSquare } from "lucide-react";
import { conversationLink, sourceLabel, useEndpoint, useSessionTitles } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Badge, Card, CardHeader, Expandable, ModelTag, Segmented, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { lineChart } from "../components/chartOptions";
import { formatCompact, formatDuration, formatInteger, formatRelative, formatShortDate, formatUsd, sessionLabel, shortPath } from "../lib/format";
import type { ConversationDetailResponse, ConversationsResponse } from "../types";

type SortOption = "tokens" | "cost" | "requests" | "recent" | "errors";
const SORTS: { id: SortOption; label: string }[] = [
  { id: "tokens", label: "Tokens" },
  { id: "cost", label: "Cost" },
  { id: "requests", label: "Requests" },
  { id: "recent", label: "Recent" },
  { id: "errors", label: "Errors" },
];

/** Only Claude Code records titles, and only its ids may look one up. */
const sessionTitle = (session: { id: string; source: string }, titles: Record<string, string>): string | undefined =>
  session.source === "claude-code" ? titles[session.id] : undefined;

const clock = (ts: number) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

export function ConversationsPage() {
  const { search } = useLocation();
  const { filters } = useFilters();
  const [sort, setSort] = useState<SortOption>("tokens");
  const query = useEndpoint<ConversationsResponse>("/api/conversations", filters, { sort, limit: 200 });
  const data = query.data;
  const titles = useSessionTitles();

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Sessions" value={data ? formatInteger(data.totals.conversations) : "—"} icon={<MessagesSquare size={13} />} />
        <Stat label="Median requests" value={data?.totals.medianRequests ? formatInteger(data.totals.medianRequests) : "—"} hint="per session" tone="info" />
        <Stat label="Median tokens" value={data?.totals.medianTokens ? formatCompact(data.totals.medianTokens) : "—"} hint="per session" tone="good" />
      </div>

      <Card>
        <CardHeader
          title="Sessions"
          action={<Segmented size="sm" value={sort} options={SORTS} onChange={setSort} />}
        />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.conversations.length === 0}>
          <Expandable items={data?.conversations ?? []} limit={25}>
            {rows => (
              <TableShell>
                <thead>
                  <tr>
                    <Th>Session</Th>
                    <Th>Models</Th>
                    <Th align="right">Requests</Th>
                    <Th align="right">Tokens</Th>
                    <Th align="right">Cost</Th>
                    <Th align="right">Span</Th>
                    <Th align="right">Errors</Th>
                    <Th align="right">Last active</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(session => (
                    <tr key={JSON.stringify([session.source, session.id])} className="transition hover:bg-surface-2">
                      <Td className="max-w-[260px]">
                        <Link to={conversationLink(session, search)} className="block truncate font-medium text-info hover:underline" title={session.project ?? session.id}>
                          {sessionTitle(session, titles) ?? sessionLabel(session)}
                        </Link>
                        <span className="block truncate text-[10.5px] text-muted">{sessionTitle(session, titles) ? `${sessionLabel(session)} · ` : ""}{sourceLabel(session.source)} · {formatShortDate(session.startedAt)}</span>
                      </Td>
                      <Td className="max-w-[240px]">
                        <span className="flex flex-wrap gap-1">
                          {session.models.slice(0, 2).map(model => (
                            <span key={model} className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-soft">{model}</span>
                          ))}
                          {session.models.length > 2 ? <span className="text-[10px] text-muted">+{session.models.length - 2}</span> : null}
                        </span>
                      </Td>
                      <Td align="right">{formatInteger(session.requests)}</Td>
                      <Td align="right">{formatCompact(session.tokens)}</Td>
                      <Td align="right">{session.pricedRequests > 0 ? formatUsd(session.cost) : <span className="text-muted">—</span>}</Td>
                      <Td align="right">{formatDuration(session.spanMs)}</Td>
                      <Td align="right" className={session.errors > 0 ? "text-bad" : undefined}>{session.errors || "—"}</Td>
                      <Td align="right" className="text-muted">{formatRelative(session.endedAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Expandable>
        </StateBlock>
      </Card>
    </div>
  );
}

export function ConversationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { chartTheme } = useTheme();
  const { search } = useLocation();
  const { filters } = useFilters();
  const sessionSource = new URLSearchParams(search).get("sessionSource") ?? undefined;
  const ROW_LIMIT = 150;
  // Another session's requests must never stand in for this one's.
  const query = useEndpoint<ConversationDetailResponse>("/api/conversations/" + encodeURIComponent(id ?? ""), filters, { sessionSource }, { keepPrevious: false });
  const data = query.data;
  const titles = useSessionTitles();
  const title = data ? sessionTitle({ id: id ?? "", source: data.source }, titles) : undefined;

  const labels = useMemo(() => data?.points.map(point => `${formatShortDate(point.ts)} ${clock(point.ts)}`) ?? [], [data]);
  const cumulativeOption = useMemo(() => {
    if (!data || data.points.length === 0) return null;
    return lineChart(chartTheme, labels, [{ name: "Cumulative tokens", data: data.points.map(point => point.cumulative), area: true }], { formatter: value => formatCompact(value), showLegend: false });
  }, [data, chartTheme, labels]);
  // The context window of each request is a different scale from the running total: its own chart, never a flat line under it.
  const contextOption = useMemo(() => {
    if (!data || !data.points.some(point => point.contextEligible)) return null;
    return lineChart(chartTheme, labels, [{ name: "Input per request", data: data.points.map(point => point.contextEligible ? point.contextTokens : null) }], { formatter: value => formatCompact(value), showLegend: false, preserveGaps: true });
  }, [data, chartTheme, labels]);

  const project = useMemo(() => [...(data?.requests ?? [])].reverse().find(row => row.cwd)?.cwd ?? null, [data]);
  const models = data?.models ?? [];
  const nothingLeftOut = data ? data.scope.matched > 0 && data.scope.excluded.window === 0 && data.scope.excluded.filters === 0 : false;
  const timed = (data?.summary.latency.p50 ?? null) !== null;
  const outcomesKnown = (data?.summary.measurementCoverage.outcomes.eligibleRequests ?? 0) > 0;
  // A request that read nothing from the cache while sending a real prompt re-paid the whole input: it costs far more than its neighbours.
  const isCacheMiss = (row: ConversationDetailResponse["requests"][number]) => row.measurements.cacheRead && row.cacheReadTokens === 0 && row.measurements.input && row.inputTokens >= 2000 && row.priced;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to={{ pathname: "/sessions", search }} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11.5px] font-medium text-ink-soft transition hover:border-line-strong">
          <ArrowLeft size={12} /> All sessions
        </Link>
        <span className="text-[13px] font-semibold text-ink" title={project ?? id}>{title ?? (project ? shortPath(project) : `Session ${(id ?? "").slice(0, 6)}`)}</span>
        {data ? <span className="text-[11.5px] text-muted">{sourceLabel(data.source)}</span> : null}
        <span className="flex flex-wrap gap-1">{models.slice(0, 3).map(model => <ModelTag key={model.name} model={model.name} className="text-[11px]" />)}</span>
      </div>

      {data && !nothingLeftOut ? <p role="status" className="text-[11.5px] leading-5 text-muted">
        {data.scope.matched === 0
          ? "No requests in this session match these filters. Change the selection or reset filters."
          : `Showing ${formatInteger(data.scope.matched)} of ${formatInteger(data.scope.sessionTotal)} requests in this session (${formatInteger(data.scope.excluded.window)} outside the time range, ${formatInteger(data.scope.excluded.filters)} filtered out).`}
      </p> : null}

      {data ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          <Stat label="Requests" value={formatInteger(data.summary.requests)} />
          <Stat label="Tokens" value={formatCompact(data.summary.tokens.total)} hint={formatCompact(data.summary.tokens.cacheRead) + " cached"} tone="good" />
          <Stat label="Cost" value={data.summary.pricedRequests > 0 ? formatUsd(data.summary.cost) : "—"} tone="good" />
          <Stat label="Span" value={data.points.length ? formatDuration(data.points[data.points.length - 1]!.ts - data.points[0]!.ts) : "—"} hint={data.points.length ? `from ${formatShortDate(data.points[0]!.ts)}` : undefined} icon={<MessagesSquare size={13} />} />
          {timed ? <Stat label="Median latency" tag="Codex only" value={formatDuration(data.summary.latency.p50)} hint={"p95 " + formatDuration(data.summary.latency.p95)} tone="info" /> : null}
          {outcomesKnown ? <Stat label="Failed or cancelled" tag="Codex only" value={formatInteger(data.summary.errors + data.summary.cancelled)} tone={data.summary.errors > 0 ? "bad" : "neutral"} /> : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title="Tokens over the session" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!cumulativeOption}>
            {cumulativeOption ? <Chart option={cumulativeOption} height={240} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Context size per request" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!contextOption} emptyLabel="No measured context sizes">
            {contextOption ? <Chart option={contextOption} height={240} /> : null}
          </StateBlock>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Requests"
          subtitle={data && data.requests.length > ROW_LIMIT ? `Newest ${ROW_LIMIT} of ${formatInteger(data.requests.length)}` : undefined}
        />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.requests.length === 0}>
          <Expandable items={[...(data?.requests ?? [])].reverse().slice(0, ROW_LIMIT)} limit={25}>
            {rows => (
              <TableShell>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Model</Th>
                    <Th align="right">Input</Th>
                    <Th align="right">Cached</Th>
                    <Th align="right">Output</Th>
                    <Th align="right">Cost</Th>
                    {timed ? <Th align="right">Total time</Th> : null}
                    {outcomesKnown ? <Th align="center">Result</Th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => {
                    const miss = isCacheMiss(row);
                    return (
                      <tr key={row.id} className={miss ? "bg-warn-soft transition" : "transition hover:bg-surface-2"}>
                        <Td className="whitespace-nowrap text-muted">{formatShortDate(row.ts)}, {clock(row.ts)}</Td>
                        <Td><ModelTag model={row.model} className="max-w-[210px]" /></Td>
                        <Td align="right">{formatCompact(row.measurements.input ? row.inputTokens : null)}</Td>
                        <Td align="right">{miss ? <Badge tone="warn">cache miss</Badge> : formatCompact(row.measurements.cacheRead ? row.cacheReadTokens : null)}</Td>
                        <Td align="right">{formatCompact(row.measurements.output ? row.outputTokens : null)}</Td>
                        <Td align="right" className={miss ? "font-semibold text-warn" : undefined}>{row.priced ? formatUsd(row.cost) : "—"}</Td>
                        {timed ? <Td align="right">{formatDuration(row.measurements.duration ? row.durationMs : null)}</Td> : null}
                        {outcomesKnown ? <Td align="center">
                          {row.outcome === "ok" ? <Badge tone="good">ok</Badge>
                            : row.outcome === "cancelled" ? <Badge tone="warn">cancelled</Badge>
                            : row.outcome === "error" ? <Badge tone="bad">{row.status}</Badge> : <span className="text-muted">—</span>}
                        </Td> : null}
                      </tr>
                    );
                  })}
                </tbody>
              </TableShell>
            )}
          </Expandable>
        </StateBlock>
      </Card>
    </div>
  );
}
