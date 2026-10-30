import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { conversationLink, filtersKey, sourceLabel, useContextReplay } from "../../api";
import { Chart } from "../../components/Chart";
import { YaldiFindingArtwork } from "../../components/YaldiArtwork";
import { Card, CardHeader, Expandable, TableShell, Td, Th } from "../../components/ui";
import { formatCompact, formatDuration, formatInteger, formatNumber, formatRatio, formatShortDate, shortId } from "../../lib/format";
import { useTheme } from "../../lib/theme";
import type { ContextChain, ContextCompaction, ContextReplayResponse, ContextSession } from "../../types";
import { InvestigationState } from "./InvestigationState";
import { TopList, Verdict, periodPhrase, useLabsFilters, type TopRow } from "./shared";
import { contextEvidenceHref, contextTimelineOption } from "./contextReplayChart";

export function ContextReplay() {
  const filters = useLabsFilters();
  const query = useContextReplay(filters);
  if (query.isLoading) return <InvestigationState kind="loading" />;
  if (query.error) return <InvestigationState kind="error" detail={query.error.message} onRetry={() => void query.refetch()} />;
  if (!query.data) return <InvestigationState kind="empty" />;
  return <ContextReplayView key={filtersKey(filters)} data={query.data} />;
}

const sessionName = (session: ContextSession) => `Session ${session.conversationId.slice(0, 6)}`;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const chainLabel = (chain: ContextChain) => chain.agent === "main" ? "Main thread" : chain.agent === "unlabelled" ? "Unlabelled requests" : `${chain.agentType ?? "Subagent"} ${shortId(chain.key, 6)}`;

const compactionCell = ({ state, auto, manual, other }: ContextCompaction) => state === "recorded" ? `${formatInteger(auto + manual + other)} recorded` : state === "none recorded" ? "no recorded compaction" : "capture unavailable";
const plural = (count: number, noun: string) => `${formatInteger(count)} ${noun}${count === 1 ? "" : "s"}`;

/** The session's finding in fixed words. "No recorded compaction" is never "no compaction". */
function compactionSentence(compaction: ContextCompaction): string {
  const { state, events, auto, manual, other, requestsUntilFirst, requestsUntilFirstUnavailable } = compaction;
  if (state === "none recorded") return "This session has no recorded compaction.";
  if (state === "unavailable") return "Compaction capture is unavailable for this session: it was not read with event capture.";
  if (!events.length) return `${plural(compaction.outsideWindowEvents, "recorded compaction")} outside this window.`;
  const first = events[0]!;
  return [
    `This session recorded ${plural(auto + manual + other, "compaction")}: ${formatInteger(auto)} automatic and ${formatInteger(manual)} manual${other ? `, ${formatInteger(other)} other` : ""}.`,
    requestsUntilFirst !== null ? `The first came after ${plural(requestsUntilFirst, "request")}.` : `Requests until the first: unavailable, ${requestsUntilFirstUnavailable}.`,
    first.preTokens !== null && first.postTokens !== null ? `Claude Code recorded ${formatCompact(first.preTokens)} tokens before it and ${formatCompact(first.postTokens)} after.` : "",
  ].filter(Boolean).join(" ");
}

function CompactionCard({ session, tz }: { session: ContextSession; tz: string }) {
  const { compaction } = session;
  const supported = compaction.state === "recorded" && compaction.events.length > 0 && !session.truncated;
  const when = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  return <Card>
    <CardHeader title="Recorded compactions" subtitle={compaction.outsideWindowEvents && compaction.events.length ? `${plural(compaction.outsideWindowEvents, "more")} outside this window` : undefined} />
    <div className="flex items-start gap-3">
      {supported ? <YaldiFindingArtwork evidenceSufficient size={72} /> : null}
      <p className="text-[12.5px] leading-5 text-ink-soft">{compactionSentence(compaction)}</p>
    </div>
    {compaction.events.length ? <Expandable items={compaction.events} limit={6}>
      {rows => <TableShell className="mt-3">
        <thead><tr><Th>Time</Th><Th>Trigger</Th><Th>Chain</Th><Th align="right">Before</Th><Th align="right">After</Th><Th align="right">Took</Th><Th align="right">Requests since previous</Th></tr></thead>
        <tbody>{rows.map(event => <tr key={event.ts}>
          <Td className="whitespace-nowrap text-muted" >{when.format(event.ts)}</Td>
          <Td>{event.trigger ?? "not recorded"}</Td>
          <Td>{event.chain ? shortId(event.chain, 6) : "not split by agent"}</Td>
          <Td align="right">{formatCompact(event.preTokens)}</Td>
          <Td align="right">{formatCompact(event.postTokens)}</Td>
          <Td align="right">{formatDuration(event.durationMs)}</Td>
          <Td align="right">{formatInteger(event.requestsSincePrevious)}</Td>
        </tr>)}</tbody>
      </TableShell>}
    </Expandable> : null}
  </Card>;
}

function CompactionStrip({ scope }: { scope: ContextReplayResponse["coverage"]["compaction"] }) {
  const captured = scope.recordedSessions + scope.noneRecordedSessions;
  if (!captured) return null;
  return <p className="px-1 text-[11.5px] leading-5 text-muted">
    {formatInteger(scope.recordedSessions)} of {formatInteger(captured)} sessions with event capture recorded a compaction: {formatInteger(scope.auto)} automatic, {formatInteger(scope.manual)} manual{scope.other ? `, ${formatInteger(scope.other)} other` : ""}.
    {scope.medianRequestsUntilFirst !== null ? ` Median ${formatNumber(scope.medianRequestsUntilFirst)} requests until the first (n=${formatInteger(scope.requestsUntilFirstSessions)}).` : ""}
    {scope.unavailableSessions ? ` Not available for ${formatInteger(scope.unavailableSessions)} Codex or older sessions.` : ""}
  </p>;
}

/** One session's input per request, one chain at a time: main by default, since interleaved agents have unrelated contexts. */
function SessionChart({ session, tz }: { session: ContextSession; tz: string }) {
  const { chartTheme } = useTheme();
  const chains = session.chains ?? [];
  const [picked, setPicked] = useState(chains[0]?.key ?? "");
  const chain = chains.find(item => item.key === picked);
  const shown = useMemo(() => (chain ? { ...session, requests: session.requests.filter(row => (row.chain ?? "unlabelled") === chain.key) } : session), [session, chain]);
  const events = useMemo(() => session.compaction.events.filter(event => !chain || (event.chain ?? "main") === chain.key), [session, chain]);
  const option = useMemo(() => contextTimelineOption(chartTheme, shown, tz, events), [shown, events, chartTheme, tz]);
  return <Card>
    <CardHeader
      title={`Input per request · ${sessionName(session)}`}
      subtitle={`${sourceLabel(session.source)} · ${formatInteger(shown.requests.filter(row => row.eligible).length)} measured requests${chain?.growth.ratio != null ? ` · ${formatRatio(chain.growth.ratio)} growth in this chain` : ""}${events.length ? " · dashed lines are recorded compactions" : ""}`}
      action={<><Link to={conversationLink({ id: session.conversationId, source: session.source }, "")} className="text-[11px] font-medium text-accent">Open session</Link>{chains.length > 1 ? <select aria-label="Chain" value={picked} onChange={event => setPicked(event.target.value)} className="max-w-[220px] rounded-lg border border-line bg-surface px-2 py-1 text-[11.5px] text-ink-soft">
        {chains.map(item => <option key={item.key} value={item.key}>{chainLabel(item)} ({formatInteger(item.requests)})</option>)}
        <option value="">All requests, interleaved</option>
      </select> : null}</>}
    />
    <Chart option={option} height={260} />
  </Card>;
}

export function ContextReplayView({ data }: { data: ContextReplayResponse }) {
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  // Server order: largest signed change first, unranked sessions last.
  const ranked = data.sessions.filter(session => session.growth.ranked && session.growth.ratio !== null);
  const biggest = [...ranked].sort((a, b) => b.growth.ratio! - a.growth.ratio!)[0];
  const session = data.sessions.find(item => item.key === sessionKey) ?? biggest ?? data.sessions[0];
  const typical = ranked.length ? median(ranked.map(item => item.growth.ratio!)) : null;

  const rows: TopRow[] = [...ranked].sort((a, b) => b.growth.ratio! - a.growth.ratio!).map(item => ({
    key: item.key, label: sessionName(item), title: item.conversationId, note: `${sourceLabel(item.source)} · ${formatShortDate(item.requests[0]?.ts)} · ${compactionCell(item.compaction)}`,
    value: formatRatio(item.growth.ratio), amount: item.growth.ratio!, onSelect: () => setSessionKey(item.key), selected: item.key === session?.key,
  }));
  const info = <>
    Growth compares the median input of a session's last three requests with its first three, for sessions with at least six measured requests. Input already includes cache reads and writes.
    {" "}{formatInteger(data.coverage.eligibleRequests)} of {formatInteger(data.coverage.totalRequests)} requests had a measured input size; {formatInteger(data.unnamedRequests)} have no session. Window: {periodPhrase(data.window)}.
  </>;

  if (data.coverage.totalRequests === 0) return <InvestigationState kind="empty" />;
  return <div className="space-y-3" aria-label="Context growth">
    <Verdict
      found={typical !== null}
      headline={typical !== null ? `Sessions grow about ${formatRatio(typical)} from start to finish` : "Not enough long sessions to measure growth"}
      detail={biggest ? `Biggest: ${sessionName(biggest)}, ${formatCompact(biggest.growth.baseline)} → ${formatCompact(biggest.growth.latest)} tokens per request.` : "Sessions need at least six measured requests."}
      big={typical !== null ? formatRatio(typical) : undefined}
      bigLabel={typical !== null ? "median growth" : undefined}
      info={info}
      action={session ? { href: contextEvidenceHref(session.evidence), label: "See the requests" } : null}
    />
    {session ? <SessionChart key={session.key} session={session} tz={data.window.tz} /> : null}
    {session?.source === "claude-code" ? <CompactionCard session={session} tz={data.window.tz} /> : null}
    <CompactionStrip scope={data.coverage.compaction} />
    {rows.length ? <Card>
      <CardHeader title="Fastest-growing sessions" />
      <TopList rows={rows} />
    </Card> : null}
  </div>;
}
