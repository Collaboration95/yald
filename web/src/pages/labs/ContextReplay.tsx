import { useMemo, useState } from "react";
import { filtersKey, sourceLabel, useContextReplay } from "../../api";
import { Chart } from "../../components/Chart";
import { Card, CardHeader } from "../../components/ui";
import { formatCompact, formatInteger, formatRatio, formatShortDate } from "../../lib/format";
import { useTheme } from "../../lib/theme";
import type { ContextReplayResponse, ContextSession } from "../../types";
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

export function ContextReplayView({ data }: { data: ContextReplayResponse }) {
  const { chartTheme } = useTheme();
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  // Server order: largest signed change first, unranked sessions last.
  const ranked = data.sessions.filter(session => session.growth.ranked && session.growth.ratio !== null);
  const biggest = [...ranked].sort((a, b) => b.growth.ratio! - a.growth.ratio!)[0];
  const session = data.sessions.find(item => item.key === sessionKey) ?? biggest ?? data.sessions[0];
  const typical = ranked.length ? median(ranked.map(item => item.growth.ratio!)) : null;
  const option = useMemo(() => (session ? contextTimelineOption(chartTheme, session, data.window.tz) : null), [session, chartTheme, data.window.tz]);

  const rows: TopRow[] = [...ranked].sort((a, b) => b.growth.ratio! - a.growth.ratio!).map(item => ({
    key: item.key, label: sessionName(item), title: item.conversationId, note: `${sourceLabel(item.source)} · ${formatShortDate(item.requests[0]?.ts)}`,
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
    {session && option ? <Card>
      <CardHeader title={`Input per request · ${sessionName(session)}`} subtitle={`${sourceLabel(session.source)} · ${formatInteger(session.eligibleRequests)} measured requests`} />
      <Chart option={option} height={260} />
    </Card> : null}
    {rows.length ? <Card>
      <CardHeader title="Fastest-growing sessions" />
      <TopList rows={rows} />
    </Card> : null}
  </div>;
}
