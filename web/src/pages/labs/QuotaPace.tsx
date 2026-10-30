import { useMemo, useState } from "react";
import { filtersKey, useEndpoint } from "../../api";
import { Chart } from "../../components/Chart";
import { lineChart, scatterChart } from "../../components/chartOptions";
import { Card, CardHeader, InfoTip, TableShell, Td, Th } from "../../components/ui";
import { formatCompact, formatDuration, formatInteger, formatNumber, formatShortDate, formatUsd, quotaLabel, shortId } from "../../lib/format";
import { colorAt } from "../../lib/palette";
import { useTheme } from "../../lib/theme";
import type { QuotaPaceEntry, QuotaPaceResponse } from "../../types";
import { InvestigationState } from "./InvestigationState";
import { Verdict, useLabsFilters } from "./shared";

const pct = (value: number) => `${Math.round(value)}%`;
const hourLabel = (ts: number) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", hourCycle: "h23" });
const entryName = (entry: QuotaPaceEntry) => `${quotaLabel(entry.window)} · ${entry.account === "codex-rollouts" ? "Codex sessions" : shortId(entry.account, 12)}`;
const caseHref = (entry: QuotaPaceEntry) => entry.evidence ? `${entry.evidence.href}&investigation=quota-pace` : null;

/** The range in words. Never one date: a path that reaches the reset first is said so. */
export function forecastSentence(forecast: NonNullable<QuotaPaceEntry["forecast"]>) {
  if (forecast.state === "insufficient") return "Insufficient history for a range.";
  if (forecast.state === "not-applicable") return "A range needs a window of at least a week.";
  const { runsOutIn, earliestAt, latestAt } = forecast;
  if (!runsOutIn || earliestAt === null) return "At your usual weekday pattern it does not run out before the reset in any of the three paths.";
  if (latestAt !== null) return `At your usual weekday pattern it runs out between ${formatShortDate(earliestAt)} and ${formatShortDate(latestAt)} in all three paths.`;
  return `At your usual weekday pattern it runs out in ${runsOutIn} of 3 paths, from ${formatShortDate(earliestAt)}, and not before the reset in the other ${3 - runsOutIn}.`;
}

function headline(entry: QuotaPaceEntry) {
  const delta = entry.pace!.deltaPoints;
  const name = quotaLabel(entry.window).toLowerCase();
  if (Math.abs(delta) < 0.5) return `The ${name} is on an even pace`;
  return `The ${name} is ${formatNumber(Math.abs(delta))} points ${delta > 0 ? "ahead of" : "behind"} an even pace`;
}

function ExchangeRate({ entry }: { entry: QuotaPaceEntry }) {
  const { chartTheme } = useTheme();
  const { exchange } = entry;
  const option = useMemo(() => exchange.ratios.length ? scatterChart(chartTheme, [{ name: "Interval", color: colorAt(0), points: exchange.ratios.map(point => [point.ts, point.tokensPerPoint]) }],
    { xFormatter: value => formatShortDate(value), yFormatter: value => formatCompact(value), yName: "Tokens per 1%" }) : null, [exchange.ratios, chartTheme]);
  const reasons = Object.entries(exchange.excluded).filter(([, count]) => count).map(([reason, count]) => `${formatInteger(count)} ${{ reset: "across a reset", fell: "where used percent fell", "no-change": "with no change", gap: "over a 24-hour gap" }[reason]}`).join(", ");
  return <Card>
    <CardHeader title={<span className="inline-flex items-center gap-1.5">Tokens per 1% <InfoTip>An observed ratio for this account and period, not a conversion rule. The provider's weighting of tokens is unknown. Usage on another device or client also moves used percent, which makes tokens per 1% look lower than what 1% buys. Dollars are API list-price equivalents.</InfoTip></span>} />
    {exchange.state === "available" ? <>
      <p className="text-[12.5px] text-ink-soft">1% of this window matched about <span className="font-semibold text-ink">{formatCompact(exchange.tokensPerPoint)}</span> recorded tokens and {formatUsd(exchange.costPerPoint)} over {formatInteger(exchange.intervals)} intervals. Middle half of intervals: {formatCompact(exchange.spread!.p25)} to {formatCompact(exchange.spread!.p75)}.</p>
      <p className="mt-1 text-[11.5px] text-muted">Fresh input {formatCompact(exchange.mix!.freshInput)}, cache reads {formatCompact(exchange.mix!.cacheRead)}, output {formatCompact(exchange.mix!.output)}.</p>
      {option ? <Chart option={option} height={200} /> : null}
    </> : <p className="text-[12.5px] text-ink-soft">{exchange.reason === "no-account-join"
      ? "Unavailable: these samples name no account, so they cannot be matched to the requests that moved them."
      : `Unavailable: ${formatInteger(exchange.intervals)} of ${formatInteger(exchange.minIntervals)} intervals, ${formatNumber(exchange.points)} of ${formatInteger(exchange.minPoints)} points.`}</p>}
    {reasons ? <p className="mt-2 text-[11.5px] text-muted">Left out: {reasons}.</p> : null}
  </Card>;
}

function WeekdayTable({ forecast }: { forecast: NonNullable<QuotaPaceEntry["forecast"]> }) {
  return <Card>
    <CardHeader title={<span className="inline-flex items-center gap-1.5">Burn by weekday <InfoTip>Points per observed day in past windows. A day inside a gap over 24 hours between samples is left out, not counted as zero. A weekday seen in fewer than three windows uses all days pooled.</InfoTip></span>}
      subtitle={`${formatInteger(forecast.history.instances)} past windows, ${formatInteger(forecast.history.days)} observed days, ${formatInteger(forecast.history.samples)} samples`} />
    <TableShell>
      <thead><tr><Th>Weekday</Th><Th align="right">Days</Th><Th align="right">Low</Th><Th align="right">Typical</Th><Th align="right">High</Th><Th>Basis</Th></tr></thead>
      <tbody>{forecast.weekdays.map(day => <tr key={day.weekday}>
        <Td className="font-medium text-ink">{day.weekday}</Td><Td align="right">{formatInteger(day.days)}</Td>
        <Td align="right">{formatNumber(day.burn?.p25)}</Td><Td align="right">{formatNumber(day.burn?.median)}</Td><Td align="right">{formatNumber(day.burn?.p75)}</Td>
        <Td>{day.usesPooled ? "all days pooled" : "this weekday"}</Td>
      </tr>)}</tbody>
    </TableShell>
  </Card>;
}

function CurrentWindow({ entry }: { entry: QuotaPaceEntry }) {
  const { chartTheme } = useTheme();
  const { pace, forecast, chart, age } = entry;
  const option = useMemo(() => {
    const hasRange = chart.some(point => point.low !== null);
    const option = lineChart(chartTheme, chart.map(point => hourLabel(point.ts)), [
      { name: "Used", data: chart.map(point => point.used) },
      { name: "Even pace", data: chart.map(point => point.even), dashed: true, color: chartTheme.axis },
      ...(hasRange ? [{ name: "Typical path", data: chart.map(point => point.typical), dashed: true, color: colorAt(1) }] : []),
    ], { formatter: pct, preserveGaps: true }) as { series: Record<string, unknown>[]; yAxis: Record<string, unknown>; legend: Record<string, unknown>; tooltip: Record<string, unknown> };
    const band = hasRange ? [
      { name: "Band floor", type: "line", stack: "range", symbol: "none", lineStyle: { opacity: 0 }, data: chart.map(point => point.low) },
      { name: "Scenario range", type: "line", stack: "range", symbol: "none", lineStyle: { opacity: 0 }, itemStyle: { color: colorAt(1) }, areaStyle: { opacity: 0.16, color: colorAt(1) }, data: chart.map(point => (point.low === null || point.high === null ? null : point.high - point.low)) },
    ] : [];
    // The band is drawn as a floor plus a difference, so the tooltip reads its real edges from the points.
    const tooltip = (params: { dataIndex: number }[]) => {
      const point = chart[params[0]!.dataIndex]!;
      const rows = [["Used", point.used], ["Even pace", point.even], ["Typical path", point.typical], ["Scenario range", point.low === null ? null : `${pct(point.low)} to ${pct(point.high!)}`]] as const;
      return [hourLabel(point.ts), ...rows.filter(([, value]) => value !== null).map(([name, value]) => `${name}: ${typeof value === "number" ? pct(value) : value}`)].join("<br/>");
    };
    return { ...option, tooltip: { ...option.tooltip, formatter: tooltip }, yAxis: { ...option.yAxis, min: 0, max: 100 }, series: [...option.series.map(series => ({ ...series, smooth: false })), ...band],
      legend: { ...option.legend, data: ["Used", "Even pace", ...(hasRange ? ["Typical path", "Scenario range"] : [])] } };
  }, [chart, chartTheme]);
  if (!pace || !age || !forecast) return null;
  const stale = !age.fresh;
  if (stale) return <InvestigationState kind="insufficient" title={`The latest sample is ${formatDuration(age.ageMs)} old`} detail="Pace and the range need a recent sample." />;
  const found = forecast.state === "range" || entry.exchange.state === "available";
  const href = caseHref(entry);
  return <>
    <Verdict found={found} headline={headline(entry)}
      detail={<>{formatNumber(pace.daysToReset)} days to reset, latest sample {formatDuration(age.ageMs)} ago. {forecastSentence(forecast)}</>}
      big={`${formatNumber(pace.usedPercent, 0)}%`} bigLabel="used"
      info={<>Even pace is a reference line, not a target: used percent if this window were spent evenly from start to reset. {formatInteger(entry.instance!.samples)} samples in this window, from {entry.instance!.sources.join(", ")}.</>}
      action={href ? { href, label: "See the intervals" } : null} />
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-1.5">This window <InfoTip>The band is a scenario range from your weekday pattern, not a prediction. A plan or limit change invalidates it. Days with no samples are left out, so it reads as if you use this window on every remaining day.</InfoTip></span>}
        subtitle={`${formatShortDate(entry.instance!.startMs)} to ${formatShortDate(entry.instance!.resetAtMs)}`} />
      <Chart option={option} height={280} />
      {entry.otherOpenWindows ? <p className="mt-2 text-[11.5px] text-muted">{formatInteger(entry.otherOpenWindows)} other windows with a different reset time are still open. These samples name no account, so they may belong to other accounts.</p> : null}
    </Card>
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      {forecast.history.days ? <WeekdayTable forecast={forecast} /> : null}
      <ExchangeRate entry={entry} />
    </div>
  </>;
}

function EntryView({ entry }: { entry: QuotaPaceEntry }) {
  if (entry.state === "no-reset") return <InvestigationState kind="insufficient" title="No reset time recorded" detail="Pace needs the time this window resets." />;
  if (entry.state === "unknown-length") return <InvestigationState kind="insufficient" title="Unknown window length" detail="Pace needs the length of this window." />;
  if (entry.state === "expired") return <>
    <InvestigationState kind="insufficient" title="Awaiting a sample from the new window" detail={`This window reset on ${formatShortDate(entry.instance!.resetAtMs)}. Its last percentage is no longer current.`} />
    <ExchangeRate entry={entry} />
  </>;
  return <CurrentWindow entry={entry} />;
}

function Results({ data }: { data: QuotaPaceResponse }) {
  const [key, setKey] = useState<string | null>(null);
  const entry = data.entries.find(candidate => candidate.key === key) ?? data.entries[0]!;
  return <div className="space-y-3" data-investigation="quota-pace">
    {data.entries.length > 1 ? <label className="flex items-center gap-2 text-[12px] text-muted">Window
      <select className="rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] text-ink" value={entry.key} onChange={event => setKey(event.target.value)}>
        {data.entries.map(candidate => <option key={candidate.key} value={candidate.key}>{entryName(candidate)}</option>)}
      </select>
    </label> : null}
    <EntryView key={entry.key} entry={entry} />
  </div>;
}

export function QuotaPace() {
  const filters = useLabsFilters();
  const query = useEndpoint<QuotaPaceResponse>("/api/labs/quota", filters, {}, { keepPrevious: false, persist: false });
  if (!query.data) {
    if (query.isError) return <InvestigationState kind="error" title="Quota pace unavailable" detail={query.error.message} onRetry={() => { void query.refetch(); }} />;
    return <InvestigationState kind="loading" title="Loading quota pace" />;
  }
  if (!query.data.scope.available) return <InvestigationState kind="empty" title="Nothing to show for this selection" detail={query.data.scope.note} />;
  if (!query.data.entries.length) return <InvestigationState kind="empty" title="No quota samples" detail="Quota comes from opencodex and Codex sessions." />;
  return <Results key={filtersKey(filters)} data={query.data} />;
}
