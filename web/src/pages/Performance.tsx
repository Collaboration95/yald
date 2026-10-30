import { useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { Timer, Zap } from "lucide-react";
import { useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Badge, Card, CardHeader, CodexOnly, Expandable, InfoTip, ModelTag, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { laneTimelineChart, lineChart, scatterChart, stackedBarChart } from "../components/chartOptions";
import { formatCompact, formatDuration, formatInteger, formatNumber, formatPercent, formatRelative, formatShortDate } from "../lib/format";
import { colorAt } from "../lib/palette";
import type { OutageEpisode, OutageEpisodes, PerformanceResponse, ReliabilityResponse, RequestRow } from "../types";

/** Failures that share a model and an error, as one line: "gpt-5.6-luna · upstream_server_error · 23×, 02:54–08:18". */
function groupFailures(rows: RequestRow[]) {
  const groups = new Map<string, { model: string; error: string; count: number; first: number; last: number }>();
  for (const row of rows) {
    const error = row.errorCode ?? (row.outcome === "cancelled" ? "cancelled" : row.closeReason ?? "unknown");
    const key = `${row.model}\u0000${error}`;
    const group = groups.get(key);
    if (group) {
      group.count++;
      group.first = Math.min(group.first, row.ts);
      group.last = Math.max(group.last, row.ts);
    } else groups.set(key, { model: row.model, error, count: 1, first: row.ts, last: row.ts });
  }
  return [...groups.values()].sort((a, b) => b.last - a.last);
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

/** Text for the class, so the chart never relies on colour alone. */
const CLASS_LABEL: Record<string, string> = { "upstream or capacity": "upstream", "configuration or request": "config", other: "other" };
const CLASS_COLOR: Record<string, number> = { "upstream or capacity": 0, "configuration or request": 2, other: 4 };
const when = (ts: number) => `${formatShortDate(ts)}, ${clock(ts)}`;
const durationText = (episode: OutageEpisode) => (episode.durationMs === null ? "single error" : formatDuration(episode.durationMs));

/** The same page, narrowed to one episode's window and its errors: every row, not the capped failure list. */
function episodeLink(episode: OutageEpisode, search: string) {
  const params = new URLSearchParams(search);
  params.set("from", String(episode.start));
  params.set("to", String(episode.end + 1));
  params.set("statuses", "error");
  params.delete("range");
  params.delete("last");
  return { pathname: "/performance", search: `?${params}` };
}

function EpisodeCard({ data, loading, error }: { data: OutageEpisodes | undefined; loading: boolean; error: unknown }) {
  const { chartTheme } = useTheme();
  const { search } = useLocation();
  const option = useMemo(() => {
    if (!data?.episodes.length) return null;
    const lanes = [...new Set(data.episodes.flatMap(episode => episode.providers))].sort();
    const bars = data.episodes.flatMap(episode => episode.providers.map(provider => ({
      lane: lanes.indexOf(provider), start: episode.start, end: episode.end,
      label: `${formatInteger(episode.size)} ${CLASS_LABEL[episode.dominantClass] ?? "other"}`,
      color: colorAt(CLASS_COLOR[episode.dominantClass] ?? 4),
      tooltip: `${when(episode.start)} · ${durationText(episode)}<br/>${formatInteger(episode.size)} errors · ${episode.statuses.map(status => `${status.name} (${formatInteger(status.value)})`).join(", ")}<br/>${episode.models.join(", ")}`,
    })));
    const span = Math.max(...data.episodes.map(episode => episode.end)) - Math.min(...data.episodes.map(episode => episode.start));
    return laneTimelineChart(chartTheme, lanes, bars, { zoom: span > 3 * 86_400_000 });
  }, [data, chartTheme]);
  const after = data?.persistence.afterError;
  const base = data?.persistence.base;
  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-1.5">Outage episodes <InfoTip>Errors less than {data ? Math.round(data.gapMs / 60_000) : 10} minutes apart form one episode. Classes are inferred from the status code: yald sees no response bodies, so a 401 suggests configuration and does not prove it. Clustering is an observation, not a cause. Only requests with an observed outcome count: {data ? `${formatInteger(data.coverage.observedRequests)} of ${formatInteger(data.coverage.totalRequests)}` : "—"} here, and Claude Code requests are unobserved.</InfoTip></span>}
        subtitle={data?.episodes.length ? `${formatInteger(data.coverage.errors)} errors in ${formatInteger(data.episodes.length)} episodes${data.marks.p50 ? `. The largest ${formatInteger(data.marks.p50)} held half of them, ${formatInteger(data.marks.p75 ?? 0)} held three quarters` : ""}.` : undefined}
      />
      <StateBlock loading={loading} error={error} empty={!option} emptyLabel="No errors in this window">
        {option ? <Chart option={option} height={Math.max(120, 56 + 34 * new Set(data!.episodes.flatMap(episode => episode.providers)).size)} /> : null}
        {after && base ? <p className="mt-2 text-[11.5px] leading-5 text-ink-soft">
          After an error, the next observed request also failed {formatInteger(after.errors)} of {formatInteger(after.total)} times{after.rate === null ? "" : ` (${formatPercent(after.rate, 1)})`}, against {formatPercent(base.rate, 1)} of all {formatInteger(base.total)} observed requests.
        </p> : null}
        <div className="mt-3">
          <Expandable items={data?.episodes ?? []} limit={6}>
            {rows => (
              <TableShell>
                <thead>
                  <tr><Th>Start</Th><Th align="right">Length</Th><Th align="right">Errors</Th><Th>Status (inferred class)</Th><Th>Models</Th><Th align="right">Succeeded inside</Th><Th align="right">Tokens reported</Th></tr>
                </thead>
                <tbody>
                  {rows.map(episode => (
                    <tr key={episode.start} className="transition hover:bg-surface-2">
                      <Td className="whitespace-nowrap">
                        <Link to={episodeLink(episode, search)} className="text-info hover:underline">{when(episode.start)}</Link>
                        {episode.clippedStart ? <> <Badge tone="warn">may start earlier</Badge></> : null}
                        {episode.ongoing ? <> <Badge tone="warn">may be ongoing</Badge></> : null}
                      </Td>
                      <Td align="right">{durationText(episode)}</Td>
                      <Td align="right">{formatInteger(episode.size)} <span className="text-muted">({formatPercent(episode.share, 0)})</span></Td>
                      <Td>{episode.statuses.slice(0, 3).map(status => `${status.name} ×${formatInteger(status.value)}`).join(", ")} <span className="text-muted">({CLASS_LABEL[episode.dominantClass] ?? "other"})</span></Td>
                      <Td className="max-w-[200px] truncate" >{episode.providers.join(", ")} · {episode.models.slice(0, 2).join(", ")}{episode.models.length > 2 ? ` +${episode.models.length - 2}` : ""}</Td>
                      <Td align="right">{formatInteger(episode.successesInside)}</Td>
                      <Td align="right">{episode.usage.tokens === null ? <span className="text-muted">none reported</span> : `${formatCompact(episode.usage.tokens)} (${formatInteger(episode.usage.reportedRows)} of ${formatInteger(episode.usage.failedRows)})`}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Expandable>
        </div>
      </StateBlock>
    </Card>
  );
}

export function PerformancePage() {
  const { filters } = useFilters();
  const { chartTheme } = useTheme();
  const query = useEndpoint<PerformanceResponse>("/api/performance", filters);
  const reliability = useEndpoint<ReliabilityResponse>("/api/reliability", filters);
  const data = query.data;
  const outcomes = reliability.data;

  const latencyOption = useMemo(() => {
    if (!data) return null;
    const labels = data.timeline.points.map(point => point.label);
    return lineChart(chartTheme, labels, [
      { name: "Latency p50", data: data.timeline.points.map(point => point.p50) },
      { name: "Latency p95", data: data.timeline.points.map(point => point.p95) },
      { name: "TTFT p50", data: data.timeline.points.map(point => point.ttftP50) },
      { name: "TTFT p95", data: data.timeline.points.map(point => point.ttftP95), dashed: true },
    ], { formatter: value => `${formatNumber(value / 1000, 1)}s` });
  }, [data, chartTheme]);

  const throughputOption = useMemo(() => {
    if (!data) return null;
    return lineChart(chartTheme, data.timeline.points.map(point => point.label), [
      { name: "Output tokens/sec p50", data: data.timeline.points.map(point => point.throughputP50), area: true },
    ], { formatter: value => formatNumber(value, 0), showLegend: false });
  }, [data, chartTheme]);

  const scatter = useMemo(() => {
    if (!data) return null;
    const byModel = new Map<string, [number, number, number][]>();
    for (const point of data.ttftVsOutput) {
      const list = byModel.get(point.model) ?? [];
      list.push([point.ttftMs, point.outputTokens, 1]);
      byModel.set(point.model, list);
    }
    const series = [...byModel.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 6)
      .map(([name, points]) => ({ name, points }));
    return scatterChart(chartTheme, series, {
      xFormatter: value => `${formatNumber(value / 1000, 1)}s`,
      yFormatter: value => formatCompact(value, 0),
      xName: "TTFT",
      yName: "output tokens",
      scaleSize: 4,
    });
  }, [data, chartTheme]);

  const failuresOption = useMemo(() => {
    if (!outcomes || outcomes.errorTimeline.length === 0) return null;
    return stackedBarChart(chartTheme, outcomes.errorTimeline.map(point => point.label), [
      { name: "Failed", data: outcomes.errorTimeline.map(point => point.error) },
      { name: "Cancelled", data: outcomes.errorTimeline.map(point => point.cancelled) },
    ], { formatter: value => formatCompact(value, 0) });
  }, [outcomes, chartTheme]);

  const percentiles = data?.percentiles;
  const failedByModel = new Map(outcomes?.failureByModel.map(entry => [entry.name, entry]) ?? []);
  // Claude Code requests have no timing: they are not rows of "—", the section says Codex only.
  const timedModels = data?.byModel.filter(model => model.ttftP50 !== null || model.p50DurationMs !== null || model.outputTokensPerSecond) ?? [];
  const failed = outcomes?.outcomes.find(entry => entry.name === "error")?.value ?? 0;
  const cancelled = outcomes?.outcomes.find(entry => entry.name === "cancelled")?.value ?? 0;
  const grouped = useMemo(() => groupFailures(outcomes?.recentFailures ?? []), [outcomes]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-1 text-[11.5px] text-muted">
        <span>Speed and reliability</span> <CodexOnly />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="TTFT p50" value={formatDuration(percentiles?.ttft.p50)} info="Time to first token. p95 is the slowest 5% of first tokens." hint={percentiles ? `p95 ${formatDuration(percentiles.ttft.p95)}` : undefined} tone="info" icon={<Timer size={13} />} />
        <Stat label="Latency p50" value={formatDuration(percentiles?.duration.p50)} hint={percentiles ? `p95 ${formatDuration(percentiles.duration.p95)}` : undefined} />
        <Stat label="Latency p99" value={formatDuration(percentiles?.duration.p99)} tone="warn" />
        <Stat label="Output tok/s" value={percentiles?.throughput.p50 ? formatNumber(percentiles.throughput.p50, 1) : "—"} hint="median" tone="good" icon={<Zap size={13} />} />
        <Stat label="Success rate" value={formatPercent(outcomes?.successRate ?? null)} hint={outcomes ? `${formatInteger(failed)} failed · ${formatInteger(cancelled)} cancelled` : undefined} tone={outcomes?.successRate != null && outcomes.successRate < 0.95 ? "warn" : "neutral"} />
      </div>

      <Card>
        <CardHeader title="Latency and first token over time" />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.timeline.points.length === 0}>
          {latencyOption ? <Chart option={latencyOption} height={280} /> : null}
        </StateBlock>
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title="Generation speed" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {throughputOption ? <Chart option={throughputOption} height={230} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="First token vs output length" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.ttftVsOutput.length === 0}>
            {scatter ? <Chart option={scatter} height={230} /> : null}
          </StateBlock>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title="By model" />
          <StateBlock loading={query.isLoading} error={query.error} empty={timedModels.length === 0}>
            <Expandable items={timedModels}>
              {rows => (
                <TableShell>
                  <thead>
                    <tr>
                      <Th>Model</Th>
                      <Th align="right">Requests</Th>
                      <Th align="right">TTFT p50</Th>
                      <Th align="right">Latency p50</Th>
                      <Th align="right">tok/s</Th>
                      <Th align="right">Failed</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(model => {
                      const failures = failedByModel.get(model.key);
                      return (
                        <tr key={model.key} className="transition hover:bg-surface-2">
                          <Td className="max-w-[220px]"><ModelTag model={model.key} /></Td>
                          <Td align="right">{formatInteger(model.requests)}</Td>
                          <Td align="right">{formatDuration(model.ttftP50)}</Td>
                          <Td align="right">{formatDuration(model.p50DurationMs)}</Td>
                          <Td align="right">{model.outputTokensPerSecond ? formatNumber(model.outputTokensPerSecond, 1) : "—"}</Td>
                          <Td align="right">{failures && failures.failures > 0 ? `${formatInteger(failures.failures)} (${formatPercent(failures.rate, 1)})` : "—"}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </TableShell>
              )}
            </Expandable>
          </StateBlock>
        </Card>

        <Card>
          <CardHeader title="Slowest requests" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.slowest.length === 0}>
            <Expandable items={data?.slowest ?? []} limit={6}>
              {rows => (
                <TableShell>
                  <thead>
                    <tr>
                      <Th>When</Th>
                      <Th>Model</Th>
                      <Th align="right">TTFT</Th>
                      <Th align="right">Total</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <tr key={row.id} className="transition hover:bg-surface-2">
                        <Td className="whitespace-nowrap text-muted" >{formatShortDate(row.ts)}, {clock(row.ts)}</Td>
                        <Td className="max-w-[200px]"><ModelTag model={row.model} /></Td>
                        <Td align="right">{formatDuration(row.measurements.ttft ? row.ttftMs : null)}</Td>
                        <Td align="right" className="font-semibold text-ink">{formatDuration(row.measurements.duration ? row.durationMs : null)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </TableShell>
              )}
            </Expandable>
          </StateBlock>
        </Card>
      </div>

      {failed + cancelled > 0 ? (
        <>
          <Card>
            <CardHeader title="Failures over time" />
            <StateBlock loading={reliability.isLoading} error={reliability.error} empty={!failuresOption}>
              {failuresOption ? <Chart option={failuresOption} height={220} /> : null}
            </StateBlock>
          </Card>
          {failed > 0 ? <EpisodeCard data={outcomes?.episodes} loading={reliability.isLoading} error={reliability.error} /> : null}
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <Card>
              <CardHeader title="Error breakdown" />
              <StateBlock loading={reliability.isLoading} error={reliability.error} empty={!outcomes || outcomes.errors.length === 0}>
                <Expandable items={outcomes?.errors ?? []} limit={6}>
                  {rows => (
                    <TableShell>
                      <thead>
                        <tr><Th>Error</Th><Th align="right">Count</Th><Th align="right">Models</Th><Th align="right">Last seen</Th></tr>
                      </thead>
                      <tbody>
                        {rows.map(error => (
                          <tr key={error.name} className="transition hover:bg-surface-2">
                            <Td className="font-medium text-ink">{error.name}</Td>
                            <Td align="right">{formatInteger(error.value)}</Td>
                            <Td align="right">{error.models}</Td>
                            <Td align="right" className="text-muted">{formatRelative(error.lastSeen)}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </TableShell>
                  )}
                </Expandable>
              </StateBlock>
            </Card>
            <Card>
              <CardHeader title="Recent failures" />
              <StateBlock loading={reliability.isLoading} error={reliability.error} empty={grouped.length === 0}>
                <Expandable items={grouped} limit={6}>
                  {rows => (
                    <ul className="space-y-2">
                      {rows.map(group => (
                        <li key={`${group.model}|${group.error}`} className="text-[11.5px] leading-5 text-ink-soft">
                          <span className="font-medium text-ink">{group.model}</span> · <span className="text-bad">{group.error}</span> · {formatInteger(group.count)}×
                          <span className="text-muted"> · {formatShortDate(group.first)}{group.count > 1 ? `, ${clock(group.first)}–${clock(group.last)}` : `, ${clock(group.first)}`}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Expandable>
              </StateBlock>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
