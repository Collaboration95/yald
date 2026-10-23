import { useMemo, useState, type ReactNode } from "react";
import { sourceLabel, useEndpoint } from "../api";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { Badge, Card, CardHeader, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { barChart, boxplotChart, heatmapChart, lineChart } from "../components/chartOptions";
import { colorAt } from "../lib/palette";
import { formatCompact, formatDuration, formatInteger, formatPercent, formatUsd } from "../lib/format";
import type { ContextModelRow, ContextResponse, ContextSpread } from "../types";

type SortKey = "n" | "mean" | "p50" | "p90" | "p99" | "max";

const SOURCE_COLOR = { "claude-code": colorAt(0), ocx: colorAt(1) } as const;
const GREY = "#94a3b8";

/** A statistic the server withheld: "—" when nothing was measured, otherwise the sample was too small. */
function tokenCell(value: number | null, n: number): ReactNode {
  if (value !== null) return formatCompact(value);
  return n === 0 ? "—" : <span className="text-[10px] text-muted">too few requests</span>;
}

/** Row label that stays unique when one model name appears under both sources. */
function labelsFor(rows: ContextModelRow[]): string[] {
  const names = rows.map(row => row.model ?? "Other");
  return rows.map((row, index) => {
    if (row.model === null) return "Other";
    const clash = names.filter(name => name === names[index]).length > 1;
    return clash && row.source ? `${row.model} · ${sourceLabel(row.source)}` : row.model;
  });
}

const BAND_OPACITY = [0.25, 0.5, 0.75, 1];

/** The four band shares of one row as a stacked bar; the tooltip carries the exact figures. */
function BandBar({ row, labels }: { row: ContextModelRow; labels: string[] }) {
  if (row.n === 0) return <span className="text-muted">—</span>;
  const title = row.bandShares.map((share, index) => `${labels[index]}: ${formatPercent(share, 1)} (${formatInteger(row.bandCounts[index])})`).join("\n");
  return (
    <div className="flex h-2 w-28 overflow-hidden rounded-full bg-surface-3" title={title} role="img" aria-label={title.replace(/\n/g, "; ")}>
      {row.bandShares.map((share, index) => (
        <span key={index} style={{ width: `${share * 100}%`, background: "var(--accent)", opacity: BAND_OPACITY[index] }} />
      ))}
    </div>
  );
}

function ShareStat({ label, value, hint, tone }: { label: string; value: string; hint: ReactNode; tone?: "neutral" | "info" | "warn" | "violet" }) {
  return <Stat label={label} value={value} hint={hint} tone={tone ?? "neutral"} />;
}

export function ContextPage() {
  const { filters } = useFilters();
  const { chartTheme } = useTheme();
  const query = useEndpoint<ContextResponse>("/api/context", filters);
  const data = query.data;
  const [sort, setSort] = useState<SortKey>("n");
  const [asc, setAsc] = useState(false);

  const eligible = data?.eligibility.eligibleRequests ?? 0;
  const hasData = Boolean(data && eligible > 0);
  const bandLabels = data?.bands.map(band => band.label) ?? [];

  const sorted = useMemo(() => {
    if (!data) return [];
    return [...data.models].sort((a, b) => ((b[sort] ?? -1) - (a[sort] ?? -1)) * (asc ? -1 : 1));
  }, [data, sort, asc]);
  const tableLabels = useMemo(() => {
    const labels = data ? labelsFor(data.models) : [];
    return new Map((data?.models ?? []).map((row, index) => [row, labels[index]!]));
  }, [data]);

  const toggleSort = (key: SortKey) => {
    if (sort === key) setAsc(current => !current);
    else {
      setSort(key);
      setAsc(false);
    }
  };

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

  const heatmapLabels = useMemo(() => (data ? labelsFor(data.modelBands) : []), [data]);
  const heatmapOption = useMemo(() => {
    if (!data || data.modelBands.length === 0) return null;
    const cells = data.modelBands.flatMap((row, rowIndex) => data.bands.map((_, column) => ({
      weekday: rowIndex, hour: column, value: row.bandShares[column] ?? 0, requests: row.bandCounts[column] ?? 0,
    })));
    return heatmapChart(chartTheme, cells, 1, {
      columns: data.bands.map(band => band.label), rows: heatmapLabels,
      describe: (cell, column, row) => `${row} · ${column}<br/><b>${formatPercent(cell.value, 1)}</b> of its requests<br/>${cell.requests.toLocaleString()} requests`,
      cellLabel: value => (value >= 0.005 ? `${Math.round(value * 100)}%` : ""),
    });
  }, [data, chartTheme, heatmapLabels]);

  const taxCategories = data?.tax.map(band => `${band.label}\nn=${formatCompact(band.requests, 0)}${band.belowMinimum ? " (few)" : ""}`) ?? [];
  const taxChart = (values: (number | null)[], formatter: (value: number) => string) => barChart(
    chartTheme, taxCategories, values,
    { formatter, showLabels: true, color: index => (values[index] === null || data?.tax[index]?.belowMinimum ? GREY : "#2563eb") },
  );
  const costOption = useMemo(() => (data ? taxChart(data.tax.map(band => band.costPerPricedRequest), formatUsd) : null), [data, chartTheme]);
  const ttftOption = useMemo(() => (data ? taxChart(data.tax.map(band => band.ttftP50), value => formatDuration(value)) : null), [data, chartTheme]);
  const cancelOption = useMemo(() => (data ? taxChart(data.tax.map(band => band.cancelRate), value => formatPercent(value, 1)) : null), [data, chartTheme]);
  const recordedTiming = Boolean(data?.tax.some(band => band.ttftMeasured > 0));
  const recordedOutcomes = Boolean(data?.tax.some(band => band.outcomesObserved > 0));

  const growthOption = useMemo(() => {
    if (!data) return null;
    return barChart(chartTheme, data.growth.histogram.map(bucket => bucket.name), data.growth.histogram.map(bucket => bucket.value), {
      formatter: value => formatCompact(value, 0), color: "#7c3aed", showLabels: true,
    });
  }, [data, chartTheme]);

  const at = (index: number) => data?.thresholds[index];
  const spreadStat = (key: "p50" | "p90" | "p99" | "max", spread: ContextSpread | undefined) => {
    const value = spread?.[key];
    return value === null || value === undefined ? (spread && spread.n > 0 ? "too few" : "—") : formatCompact(value);
  };
  const coverage = `${formatInteger(data?.overall.n)} of ${formatInteger(data?.eligibility.totalRequests)} requests measured`;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <ShareStat label="Median context" value={spreadStat("p50", data?.overall)} hint={coverage} />
        <ShareStat label="p90" value={spreadStat("p90", data?.overall)} hint={data ? `needs ${data.minimums.p90}+ requests` : undefined} />
        <ShareStat label="p99" value={spreadStat("p99", data?.overall)} hint={data ? `needs ${data.minimums.p99}+ requests` : undefined} />
        <ShareStat label="Max" value={spreadStat("max", data?.overall)} hint="input tokens, one request" />
        <ShareStat label="Requests ≥150k" value={formatPercent(at(1)?.requestShare)} hint={at(1) ? `${formatInteger(at(1)!.requests)} of ${formatInteger(eligible)}` : undefined} tone="info" />
        <ShareStat label="Cost ≥150k" value={formatPercent(at(1)?.costShare)} hint={at(1) ? `${formatInteger(at(1)!.pricedRequests)} priced requests · list price` : undefined} tone="warn" />
        <ShareStat label="Engine long tier" value={formatPercent(at(3)?.requestShare)} hint={at(3) ? `of requests · ${formatPercent(at(3)!.costShare)} of cost` : undefined} tone="violet" />
      </div>

      {data && data.eligibility.excludedRequests > 0 ? (
        <p className="px-1 text-[11px] leading-5 text-muted">
          {formatInteger(data.eligibility.excludedRequests)} of {formatInteger(data.eligibility.totalRequests)} requests are left out because their input size was not measured as one logical request (attempt-summed or missing usage). They are counted here, never treated as zero.
          {data.eligibility.unpricedEligibleRequests > 0 ? ` ${formatInteger(data.eligibility.unpricedEligibleRequests)} measured requests have no price and carry no cost.` : ""}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Context length by model" subtitle="Box: p25 to p75 with a line at p50 · whiskers p10 and p90 · diamond p99 · ring max · log scale" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!hasData} emptyLabel="No requests with a measured context length in this selection">
            {boxOption ? <Chart option={boxOption} height={Math.max(180, drawn * 30 + 50)} /> : <p className="py-8 text-center text-[12px] text-muted">No model has {data?.minimums.box} measured requests yet.</p>}
            {data && boxRows.length > drawn ? <p className="mt-2 text-[10.5px] text-muted">{boxRows.length - drawn} listed models have too few requests to draw a box.</p> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Context pressure" subtitle="Requests per input size · the existing eight log-scale buckets" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!hasData}>
            {histogramOption ? <Chart option={histogramOption} height={236} /> : null}
          </StateBlock>
        </Card>
      </div>

      <Card>
        <CardHeader title="Context length over time" subtitle={`Median (solid) and p90 (dashed) per ${data?.timeline.bucket ?? "day"}, per source · p90 needs ${data?.minimums.p90 ?? 10}+ requests in the bucket`} />
        <StateBlock loading={query.isLoading} error={query.error} empty={!timelineOption}>
          {timelineOption ? <Chart option={timelineOption} height={248} /> : null}
        </StateBlock>
      </Card>

      <Card>
        <CardHeader title="Per-model summary" subtitle="Click a column to sort · statistics need a minimum sample, otherwise they read too few requests" />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.models.length === 0}>
          <TableShell className="max-h-[480px] overflow-y-auto">
            <thead>
              <tr>
                <Th>Model</Th>
                {([["n", "Requests"], ["mean", "Mean"], ["p50", "p50"], ["p90", "p90"], ["p99", "p99"], ["max", "Max"]] as [SortKey, string][]).map(([key, label]) => (
                  <Th key={key} align="right" onClick={() => toggleSort(key)} active={sort === key} asc={asc}>{label}</Th>
                ))}
                <Th>Bands</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(row => (
                <tr key={`${row.source}|${row.model}`} className="transition hover:bg-surface-2">
                  <Td className="max-w-[240px] truncate font-medium text-ink">
                    {tableLabels.get(row)}
                    {row.source ? <Badge className="ml-1.5">{sourceLabel(row.source)}</Badge> : null}
                  </Td>
                  <Td align="right">{formatInteger(row.n)}</Td>
                  <Td align="right">{tokenCell(row.mean, row.n)}</Td>
                  <Td align="right">{tokenCell(row.p50, row.n)}</Td>
                  <Td align="right">{tokenCell(row.p90, row.n)}</Td>
                  <Td align="right">{tokenCell(row.p99, row.n)}</Td>
                  <Td align="right">{tokenCell(row.max, row.n)}</Td>
                  <Td><BandBar row={row} labels={bandLabels} /></Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
          <p className="mt-2 text-[10.5px] text-muted">
            Bands: {bandLabels.join(" · ")}, darker is longer.{data && data.modelsOmitted > 0 ? ` ${data.modelsOmitted} smaller models are not listed.` : ""}
          </p>
        </StateBlock>
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader title="Model by band" subtitle="Each row adds to 100% of that model's requests · top 12 models, the rest as Other" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!heatmapOption}>
            {heatmapOption ? <Chart option={heatmapOption} height={Math.max(160, (data?.modelBands.length ?? 0) * 30 + 40)} /> : null}
          </StateBlock>
        </Card>
        <Card>
          <CardHeader title="Share above a threshold" subtitle="Eligible requests and list-price cost at or above each context length" />
          <StateBlock loading={query.isLoading} error={query.error} empty={!hasData}>
            <TableShell>
              <thead>
                <tr><Th>Context</Th><Th align="right">Requests</Th><Th align="right">Share</Th><Th align="right">Cost</Th><Th align="right">Share of cost</Th><Th align="right">Priced</Th></tr>
              </thead>
              <tbody>
                {data?.thresholds.map(row => (
                  <tr key={row.label} className="transition hover:bg-surface-2">
                    <Td className="font-medium text-ink">{row.label}</Td>
                    <Td align="right">{formatInteger(row.requests)}</Td>
                    <Td align="right">{formatPercent(row.requestShare)}</Td>
                    <Td align="right">{row.cost === null ? "—" : formatUsd(row.cost)}</Td>
                    <Td align="right">{formatPercent(row.costShare)}</Td>
                    <Td align="right">{formatInteger(row.pricedRequests)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
            <p className="mt-2 text-[10.5px] leading-4 text-muted">
              The engine tier and a fixed threshold differ because the tier cutoff varies by model. Shares use measured requests; cost shares use priced ones ({formatInteger(data?.eligibility.pricedEligibleRequests)} of {formatInteger(eligible)}).
            </p>
          </StateBlock>
        </Card>
      </div>

      <Card>
        <CardHeader title="Context tax by band" subtitle="What longer contexts coincide with · fixed band edges, so they do not move with your selection" />
        <StateBlock loading={query.isLoading} error={query.error} empty={!hasData}>
          <TableShell>
            <thead>
              <tr>
                <Th>Band</Th><Th align="right">Requests</Th><Th align="right">Share</Th><Th align="right">Cost</Th><Th align="right">Share</Th>
                <Th align="right">Per priced request</Th><Th align="right">Median TTFT</Th><Th align="right">Cancel rate</Th><Th>Most common models</Th>
              </tr>
            </thead>
            <tbody>
              {data?.tax.map(band => (
                <tr key={band.id} className={band.belowMinimum ? "opacity-60" : undefined}>
                  <Td className="font-medium text-ink">{band.label}</Td>
                  <Td align="right">{formatInteger(band.requests)}</Td>
                  <Td align="right">{formatPercent(band.requestShare)}</Td>
                  <Td align="right">{band.cost === null ? "—" : formatUsd(band.cost)}</Td>
                  <Td align="right">{formatPercent(band.costShare)}</Td>
                  <Td align="right">{band.costPerPricedRequest === null ? (band.pricedRequests === 0 ? "—" : <span className="text-[10px] text-muted">too few requests</span>) : formatUsd(band.costPerPricedRequest)}<span className="ml-1 text-[10px] text-muted">n {formatInteger(band.pricedRequests)}</span></Td>
                  <Td align="right">{band.ttftMeasured === 0 ? <span className="text-[10px] text-muted">not recorded</span> : band.ttftP50 === null ? <span className="text-[10px] text-muted">too few requests</span> : formatDuration(band.ttftP50)}{band.ttftMeasured > 0 ? <span className="ml-1 text-[10px] text-muted">n {formatInteger(band.ttftMeasured)}</span> : null}</Td>
                  <Td align="right">{band.outcomesObserved === 0 ? <span className="text-[10px] text-muted">not recorded</span> : band.cancelRate === null ? <span className="text-[10px] text-muted">too few requests</span> : formatPercent(band.cancelRate)}{band.outcomesObserved > 0 ? <span className="ml-1 text-[10px] text-muted">n {formatInteger(band.outcomesObserved)}</span> : null}</Td>
                  <Td className="max-w-[240px] truncate text-[11px]">{band.topModels.map(entry => `${entry.model} ${formatPercent(entry.share, 0)}`).join(" · ") || "—"}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div>
              <p className="mb-1 text-[11.5px] font-medium text-ink-soft">Cost per priced request</p>
              {costOption ? <Chart option={costOption} height={190} /> : null}
            </div>
            <div>
              <p className="mb-1 text-[11.5px] font-medium text-ink-soft">Median time to first token</p>
              {recordedTiming && ttftOption ? <Chart option={ttftOption} height={190} /> : <p className="py-10 text-center text-[11.5px] text-muted">Not recorded for the selected sources. Only opencodex requests carry timing.</p>}
            </div>
            <div>
              <p className="mb-1 text-[11.5px] font-medium text-ink-soft">Cancel rate</p>
              {recordedOutcomes && cancelOption ? <Chart option={cancelOption} height={190} /> : <p className="py-10 text-center text-[11.5px] text-muted">Not recorded for the selected sources. Only opencodex requests carry outcomes.</p>}
            </div>
          </div>
          <p className="mt-2 text-[10.5px] leading-4 text-muted">
            Grey bars have fewer than {data?.minimums.band} samples. Cost per request mixes models (longer contexts may be used by pricier models), so read it with the model mix per band above; filter to one model to hold it fixed. Cancel rate is cancelled over observed outcomes among requests with a measured context length, so a request cancelled before any usage was recorded is not in it. A request cancelled before its first token has no time to first token.
          </p>
        </StateBlock>
      </Card>

      <Card>
        <CardHeader title="Session growth" subtitle={`Median input of a session's last 3 requests over its first 3 · sessions with ${data?.growth.minEligible ?? 6}+ measured requests in the window`} />
        <StateBlock loading={query.isLoading} error={query.error} empty={!data || data.growth.sessions === 0} emptyLabel="No named sessions in this selection">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
            {growthOption && data && data.growth.ranked > 0 ? <Chart option={growthOption} height={210} /> : <p className="py-10 text-center text-[11.5px] text-muted">No session has enough measured requests to rank.</p>}
            <dl className="grid grid-cols-2 gap-3 self-center text-[11.5px] lg:grid-cols-1">
              <div><dt className="text-[10px] uppercase tracking-[0.04em] text-muted">Median growth</dt><dd className="num text-[16px] font-semibold text-ink">{data?.growth.medianRatio === null || data?.growth.medianRatio === undefined ? "—" : `${data.growth.medianRatio.toFixed(2)}x`}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-[0.04em] text-muted">Ranked sessions</dt><dd className="num text-ink">{formatInteger(data?.growth.ranked)} of {formatInteger(data?.growth.sessions)}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-[0.04em] text-muted">Not ranked</dt><dd className="num text-ink">{formatInteger(data?.growth.unranked)} (too few measured requests){data && data.growth.noRatio > 0 ? ` · ${data.growth.noRatio} with a zero baseline` : ""}</dd></div>
              <div><dt className="text-[10px] uppercase tracking-[0.04em] text-muted">Clipped by the window</dt><dd className="num text-ink">{formatInteger(data?.growth.clippedRanked)} ranked sessions have loaded requests outside it</dd></div>
            </dl>
          </div>
        </StateBlock>
      </Card>

      <p className="px-1 text-[10.5px] leading-4 text-muted">
        Context length is a request's input tokens, which already include cache reads and writes. These are associations in your loaded data: a long context coincides with a higher cost per request, a longer first-token time and more cancels. They do not show that context length causes any of them, or that trimming it would save money. Costs are API list-price equivalents for priced requests. Claude Code requests from subagents are not labelled yet, so Claude per-model numbers can mix a main conversation with its subagents' smaller contexts.
      </p>
    </div>
  );
}
