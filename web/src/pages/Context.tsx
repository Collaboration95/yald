import { useMemo } from "react";
import { sourceLabel, useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Card, CardHeader, InfoTip, PartialBadge, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { barChart, boxplotChart, lineChart } from "../components/chartOptions";
import { colorAt } from "../lib/palette";
import { formatCompact, formatInteger, formatPercent, formatUsd } from "../lib/format";
import type { ContextModelRow, ContextResponse, ContextSpread } from "../types";

const SOURCE_COLOR = { "claude-code": colorAt(0), ocx: colorAt(1) } as const;

/** Row label that stays unique when one model name appears under both sources. */
function labelsFor(rows: ContextModelRow[]): string[] {
  const names = rows.map(row => row.model ?? "Other");
  return rows.map((row, index) => {
    if (row.model === null) return "Other";
    const clash = names.filter(name => name === names[index]).length > 1;
    return clash && row.source ? `${row.model} · ${sourceLabel(row.source)}` : row.model;
  });
}

export function ContextPage() {
  const { filters } = useFilters();
  const { chartTheme } = useTheme();
  const query = useEndpoint<ContextResponse>("/api/context", filters);
  const data = query.data;
  const eligible = data?.eligibility.eligibleRequests ?? 0;
  const hasData = Boolean(data && eligible > 0);

  const boxRows = useMemo(() => {
    if (!data) return [];
    const labels = labelsFor(data.box);
    return data.box.map((row, index) => ({
      label: labels[index]!, n: row.n, p99: row.p99, max: row.max,
      box: row.p10 !== null && row.p25 !== null && row.p50 !== null && row.p75 !== null && row.p90 !== null
        ? [row.p10, row.p25, row.p50, row.p75, row.p90] as [number, number, number, number, number] : null,
    }));
  }, [data]);
  const drawn = boxRows.filter(row => row.box !== null).length;
  const boxOption = useMemo(() => (drawn > 0 ? boxplotChart(chartTheme, boxRows, { formatter: value => formatCompact(value, 0) }) : null), [boxRows, drawn, chartTheme]);

  const timelineOption = useMemo(() => {
    if (!data || data.timeline.series.length === 0) return null;
    return lineChart(chartTheme, data.timeline.buckets.map(bucket => bucket.label), data.timeline.series.flatMap(series => [
      { name: `${sourceLabel(series.source)} p50`, data: series.p50, color: SOURCE_COLOR[series.source] },
      { name: `${sourceLabel(series.source)} p90`, data: series.p90, color: SOURCE_COLOR[series.source], dashed: true },
    ]), { formatter: value => formatCompact(value, 0), preserveGaps: true });
  }, [data, chartTheme]);

  const histogramOption = useMemo(() => {
    if (!data) return null;
    return barChart(chartTheme, data.histogram.buckets.map(bucket => bucket.name), data.histogram.buckets.map(bucket => bucket.value), {
      formatter: value => formatCompact(value, 0), color: "#2563eb",
    });
  }, [data, chartTheme]);

  const at = (index: number) => data?.thresholds[index];
  const spreadStat = (key: "p50" | "p90", spread: ContextSpread | undefined) => {
    const value = spread?.[key];
    return value === null || value === undefined ? (spread && spread.n > 0 ? "few requests" : "—") : formatCompact(value);
  };
  const spreadExact = (key: "p50" | "p90", spread: ContextSpread | undefined) => {
    const value = spread?.[key];
    return value === null || value === undefined ? undefined : formatInteger(value);
  };
  const left = data?.eligibility.excludedRequests ?? 0;
  const leftOutShare = data && data.eligibility.totalRequests > 0 ? left / data.eligibility.totalRequests : 0;

  return (
    <div className="space-y-3">
      {leftOutShare >= 0.05 && data ? (
        <div className="flex items-center gap-2 px-1 text-[11.5px] text-muted">
          <PartialBadge>{formatInteger(left)} of {formatInteger(data.eligibility.totalRequests)} requests are left out because their input size was not measured as one request (summed over retries, or no usage reported). They are never counted as zero.</PartialBadge>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Median context" value={spreadStat("p50", data?.overall)} exact={spreadExact("p50", data?.overall)} hint="input tokens per request" info="Input tokens already include cache reads and writes." />
        <Stat label="p90" value={spreadStat("p90", data?.overall)} exact={spreadExact("p90", data?.overall)} hint="9 in 10 requests are smaller" />
        <Stat label="Requests ≥150k" value={formatPercent(at(1)?.requestShare)} hint={at(1) ? `${formatInteger(at(1)!.requests)} requests` : undefined} tone="info" />
        <Stat label="Cost ≥150k" value={formatPercent(at(1)?.costShare)} hint="of list-price cost" tone="warn" />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title={<span className="inline-flex items-center gap-1.5">Context length by model
              <InfoTip label="How to read this chart">Box: p25 to p75 with a line at the median. Whiskers: p10 and p90. Diamond: p99. Ring: max. Log scale.</InfoTip></span>}
          />
          <StateBlock loading={query.isLoading} error={query.error} empty={!hasData} emptyLabel="No requests with a measured context length in this selection">
            {boxOption ? <Chart option={boxOption} height={drawn * 30 + 50} /> : <p className="py-8 text-center text-[12px] text-muted">No model has {data?.minimums.box} measured requests yet.</p>}
            {data && boxRows.length > drawn ? <p className="mt-2 text-[10.5px] text-muted">{boxRows.length - drawn} {boxRows.length - drawn === 1 ? "model has" : "models have"} too few requests to draw.</p> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Requests by context size" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!hasData}>
            {histogramOption ? <Chart option={histogramOption} height={236} /> : null}
          </StateBlock>
        </Card>
      </div>

      <Card>
        <CardHeader
          title={<span className="inline-flex items-center gap-1.5">Context length over time
            <InfoTip label="How to read this chart">Median (solid) and p90 (dashed) per {data?.timeline.bucket ?? "day"}, per source. p90 needs {data?.minimums.p90 ?? 10}+ requests in the bucket.</InfoTip></span>}
        />
        <StateBlock loading={query.isLoading} error={query.error} empty={!timelineOption}>
          {timelineOption ? <Chart option={timelineOption} height={248} /> : null}
        </StateBlock>
      </Card>

      <Card>
        <CardHeader
          title={<span className="inline-flex items-center gap-1.5">What longer contexts coincide with
            <InfoTip label="About these numbers">These are associations in your data, not causes: a long context coincides with a higher cost per request, but that does not show that trimming it would save money. Costs are API list-price equivalents for priced requests. Bands have fixed edges, so they do not move with your selection. Bands with fewer than {data?.minimums.band ?? 10} requests are greyed. Claude numbers mix a main conversation with its subagents' smaller contexts unless the Agent filter narrows them.</InfoTip></span>}
        />
        <StateBlock loading={query.isLoading} error={query.error} empty={!hasData}>
          <TableShell>
            <thead>
              <tr>
                <Th>Context size</Th><Th align="right">Requests</Th><Th align="right">% of requests</Th><Th align="right">Cost</Th><Th align="right">% of cost</Th>
                <Th align="right">Cost per request</Th>
              </tr>
            </thead>
            <tbody>
              {data?.tax.map(band => (
                <tr key={band.id} className={band.belowMinimum ? "opacity-60" : undefined}>
                  <Td className="font-medium text-ink">{band.label}</Td>
                  <Td align="right">{formatInteger(band.requests)}</Td>
                  <Td align="right">{formatPercent(band.requestShare, 0)}</Td>
                  <Td align="right">{band.cost === null ? "—" : formatUsd(band.cost)}</Td>
                  <Td align="right">{formatPercent(band.costShare, 0)}</Td>
                  <Td align="right">{band.costPerPricedRequest === null ? (band.pricedRequests === 0 ? "—" : <span className="text-[10px] text-muted">few requests</span>) : formatUsd(band.costPerPricedRequest)}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </StateBlock>
      </Card>
    </div>
  );
}
