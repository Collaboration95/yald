import { useMemo } from "react";
import { Timer, Waves, Zap } from "lucide-react";
import { useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Badge, Card, CardHeader, ModelTag, OutcomeDot, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { barChart, lineChart, scatterChart } from "../components/chartOptions";
import { formatCompact, formatDateTime, formatDuration, formatPercent, shortId } from "../lib/format";
import type { PerformanceResponse } from "../types";

export function PerformancePage() {
  const { filters } = useFilters();
  const { chartTheme } = useTheme();
  const query = useEndpoint<PerformanceResponse>("/api/performance", filters);
  const data = query.data;

  const latencyOption = useMemo(() => {
    if (!data) return null;
    const labels = data.timeline.points.map(point => point.label);
    return lineChart(chartTheme, labels, [
      { name: "Latency p50", data: data.timeline.points.map(point => point.p50) },
      { name: "Latency p95", data: data.timeline.points.map(point => point.p95) },
      { name: "TTFT p50", data: data.timeline.points.map(point => point.ttftP50) },
      { name: "TTFT p95", data: data.timeline.points.map(point => point.ttftP95), dashed: true },
    ], { formatter: value => `${(value / 1000).toFixed(1)}s` });
  }, [data, chartTheme]);

  const throughputOption = useMemo(() => {
    if (!data) return null;
    return lineChart(chartTheme, data.timeline.points.map(point => point.label), [
      { name: "Output tokens/sec p50", data: data.timeline.points.map(point => point.throughputP50), area: true },
    ], { formatter: value => value.toFixed(0), showLegend: false });
  }, [data, chartTheme]);

  const durationHistogram = useMemo(() => {
    if (!data) return null;
    return barChart(chartTheme, data.histogram.duration.map(bucket => bucket.name), data.histogram.duration.map(bucket => bucket.value), { formatter: value => formatCompact(value, 0), color: "#2563eb" });
  }, [data, chartTheme]);

  const ttftHistogram = useMemo(() => {
    if (!data) return null;
    return barChart(chartTheme, data.histogram.ttft.map(bucket => bucket.name), data.histogram.ttft.map(bucket => bucket.value), { formatter: value => formatCompact(value, 0), color: "#7c3aed" });
  }, [data, chartTheme]);

  const throughputHistogram = useMemo(() => {
    if (!data) return null;
    return barChart(chartTheme, data.histogram.throughput.map(bucket => bucket.name), data.histogram.throughput.map(bucket => bucket.value), { formatter: value => formatCompact(value, 0), color: "#16a34a" });
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
      xFormatter: value => `${(value / 1000).toFixed(1)}s`,
      yFormatter: value => formatCompact(value, 0),
      xName: "TTFT",
      yName: "output tokens",
      scaleSize: 4,
    });
  }, [data, chartTheme]);

  const percentiles = data?.percentiles;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="TTFT p50" value={formatDuration(percentiles?.ttft.p50)} hint={data ? `${formatPercent(percentiles?.ttft.coverage ?? 0, 0)} of rows measure TTFT` : undefined} tone="info" icon={<Timer size={13} />} />
        <Stat label="TTFT p95" value={formatDuration(percentiles?.ttft.p95)} hint="Slowest 5% of first tokens" tone="warn" />
        <Stat label="Latency p50" value={formatDuration(percentiles?.duration.p50)} hint="Whole request" />
        <Stat label="Latency p95" value={formatDuration(percentiles?.duration.p95)} hint="Tail behaviour" tone="warn" />
        <Stat label="Latency p99" value={formatDuration(percentiles?.duration.p99)} hint="Worst case" tone="bad" />
        <Stat label="Output tok/s p50" value={percentiles?.throughput.p50?.toFixed(1) ?? "—"} hint={percentiles?.throughput.mean ? `mean ${percentiles.throughput.mean.toFixed(1)}` : undefined} tone="good" icon={<Zap size={13} />} />
      </div>

      <Card>
        <CardHeader
          title="Latency and first-token timeline"
          subtitle="Dashed lines are TTFT; solid lines are full request duration"
          action={<Badge tone="info">{data?.timeline.bucket ?? "day"} buckets</Badge>}
        />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.timeline.points.length === 0}>
          {latencyOption ? <Chart option={latencyOption} height={280} /> : null}
        </StateBlock>
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Generation speed over time" subtitle="Median output tokens per second per bucket" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {throughputOption ? <Chart option={throughputOption} height={220} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Latency distribution" subtitle="Share of requests per duration bucket" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {durationHistogram ? <Chart option={durationHistogram} height={220} /> : null}
          </StateBlock>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card>
          <CardHeader title="TTFT distribution" subtitle="How fast the first token arrives" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {ttftHistogram ? <Chart option={ttftHistogram} height={188} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Throughput distribution" subtitle="Output tokens per second" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {throughputHistogram ? <Chart option={throughputHistogram} height={188} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="TTFT vs output length" subtitle="Each dot is a request, sampled to 2k" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
            {scatter ? <Chart option={scatter} height={188} /> : null}
          </StateBlock>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title="Slowest requests" subtitle="Where the tail actually lives" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.slowest.length === 0}>
            <TableShell>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Model</Th>
                  <Th align="right">TTFT</Th>
                  <Th align="right">Total</Th>
                  <Th align="right">Out</Th>
                  <Th align="center">Status</Th>
                </tr>
              </thead>
              <tbody>
                {data?.slowest.map(row => (
                  <tr key={row.id} className="transition hover:bg-surface-2">
                    <Td className="whitespace-nowrap text-muted">{formatDateTime(row.ts)}</Td>
                    <Td><ModelTag model={row.model} provider={row.provider} className="max-w-[200px]" /></Td>
                    <Td align="right">{formatDuration(row.ttftMs)}</Td>
                    <Td align="right" className="font-semibold text-ink">{formatDuration(row.durationMs)}</Td>
                    <Td align="right">{formatCompact(row.outputTokens)}</Td>
                    <Td align="center"><OutcomeDot outcome={row.outcome} /></Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </StateBlock>
        </Card>

        <Card>
          <CardHeader title="Performance by model" subtitle="Median latency, TTFT and generation speed" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.byModel.length === 0}>
            <TableShell>
              <thead>
                <tr>
                  <Th>Model</Th>
                  <Th align="right">Req</Th>
                  <Th align="right">TTFT p50</Th>
                  <Th align="right">p50</Th>
                  <Th align="right">p95</Th>
                  <Th align="right">tok/s</Th>
                </tr>
              </thead>
              <tbody>
                {data?.byModel.slice(0, 12).map(model => (
                  <tr key={model.key} className="transition hover:bg-surface-2">
                    <Td className="max-w-[200px] truncate font-medium text-ink">{model.key}</Td>
                    <Td align="right">{formatCompact(model.requests, 0)}</Td>
                    <Td align="right">{formatDuration(model.ttftP50)}</Td>
                    <Td align="right">{formatDuration(model.p50DurationMs)}</Td>
                    <Td align="right">{formatDuration(model.p95DurationMs)}</Td>
                    <Td align="right">{model.outputTokensPerSecond ? model.outputTokensPerSecond.toFixed(1) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </StateBlock>
        </Card>
      </div>

      <Card>
        <CardHeader title="Context pressure" subtitle="Input tokens per request — long context prices differently" />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
            <div className="flex items-end gap-2">
              {data?.context.buckets.map(bucket => {
                const total = data.context.buckets.reduce((sum, entry) => sum + entry.value, 0) || 1;
                const height = Math.max(4, (bucket.value / total) * 140);
                return (
                  <div key={bucket.name} className="flex flex-1 flex-col items-center gap-1">
                    <span className="num text-[10px] text-muted">{formatCompact(bucket.value, 0)}</span>
                    <div className="w-full rounded-t bg-info/70" style={{ height }} />
                    <span className="text-[10px] text-muted">{bucket.name}</span>
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-3 gap-2 self-center lg:grid-cols-1">
              <div>
                <p className="text-[10px] uppercase tracking-[0.04em] text-muted">p50 input</p>
                <p className="num text-[14px] font-semibold text-ink">{formatCompact(data?.context.p50Input ?? 0)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-[0.04em] text-muted">p95 input</p>
                <p className="num text-[14px] font-semibold text-ink">{formatCompact(data?.context.p95Input ?? 0)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-[0.04em] text-muted">max input</p>
                <p className="num text-[14px] font-semibold text-ink">{formatCompact(data?.context.maxInput ?? 0)}</p>
              </div>
            </div>
          </div>
        </StateBlock>
      </Card>

      <p className="px-1 text-[10.5px] text-muted">
        <Waves size={11} className="mr-1 inline" />
        Percentiles are computed over the filtered window; TTFT only exists for streaming responses, so coverage is shown next to it.
      </p>
    </div>
  );
}
