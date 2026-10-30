import { useMemo } from "react";
import { Timer, Zap } from "lucide-react";
import { useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Card, CardHeader, CodexOnly, Expandable, ModelTag, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { lineChart, scatterChart, stackedBarChart } from "../components/chartOptions";
import { formatCompact, formatDuration, formatInteger, formatNumber, formatPercent, formatRelative, formatShortDate } from "../lib/format";
import type { PerformanceResponse, ReliabilityResponse, RequestRow } from "../types";

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
