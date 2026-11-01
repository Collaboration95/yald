import { useMemo } from "react";
import { Zap } from "lucide-react";
import { useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Card, CardHeader, CodexOnly, InfoTip, Stat, StateBlock } from "../components/ui";
import { Chart } from "../components/Chart";
import { boxplotChart, lineChart, scatterChart, stackedBarChart } from "../components/chartOptions";
import { formatCompact, formatNumber } from "../lib/format";
import type { PerformanceResponse, ReliabilityResponse } from "../types";

export function PerformancePage() {
  const { filters } = useFilters();
  const { chartTheme } = useTheme();
  const query = useEndpoint<PerformanceResponse>("/api/performance", filters);
  const reliability = useEndpoint<ReliabilityResponse>("/api/reliability", filters);
  const data = query.data;
  const outcomes = reliability.data;

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

  const boxRows = useMemo(() => (data?.speedByModel.box ?? []).map(row => ({
    label: row.model, n: row.n, p99: row.p99, max: row.max,
    box: row.p10 !== null && row.p25 !== null && row.p50 !== null && row.p75 !== null && row.p90 !== null
      ? [row.p10, row.p25, row.p50, row.p75, row.p90] as [number, number, number, number, number] : null,
  })), [data]);
  const drawn = boxRows.filter(row => row.box !== null).length;
  const boxOption = useMemo(() => drawn ? boxplotChart(chartTheme, boxRows, {
    formatter: value => `${formatNumber(value, 1)} tok/s`, scale: "linear",
  }) : null, [chartTheme, boxRows, drawn]);
  const percentiles = data?.percentiles;
  const failed = outcomes?.outcomes.find(entry => entry.name === "error")?.value ?? 0;
  const cancelled = outcomes?.outcomes.find(entry => entry.name === "cancelled")?.value ?? 0;

  return (
    <div className="space-y-3 editorial editorial-performance">
      <div className="flex items-center gap-2 px-1 text-[11.5px] text-muted">
        <span>Speed and reliability</span> <CodexOnly />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Stat label="Output tok/s" value={percentiles?.throughput.p50 ? formatNumber(percentiles.throughput.p50, 1) : "—"} hint="median" tone="good" icon={<Zap size={13} />} />
      </div>

      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-1.5">Speed by model
          <InfoTip label="How to read this chart">Box: p25 to p75 with a line at the median. Whiskers: p10 and p90. Diamond: p99 (100+ requests). Ring: max. Linear scale, output tokens per second. Shows the 10 most used models. Each needs 10 eligible requests.</InfoTip></span>} />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data}>
          {boxOption ? <Chart option={boxOption} height={Math.max(180, drawn * 30 + 50)} /> : <p className="py-8 text-center text-[12px] text-muted">No model has 10 eligible requests yet.</p>}
          {boxRows.length > drawn ? <p className="mt-2 text-[10.5px] text-muted">Too few requests to draw: {boxRows.length - drawn} of {boxRows.length} models.</p> : null}
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

      {failed + cancelled > 0 ? (
        <Card>
          <CardHeader title="Failures over time" />
          <StateBlock loading={reliability.isLoading} error={reliability.error} empty={!failuresOption}>
            {failuresOption ? <Chart option={failuresOption} height={220} /> : null}
          </StateBlock>
        </Card>
      ) : null}
    </div>
  );
}
