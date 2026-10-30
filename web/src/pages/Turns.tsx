import { useMemo } from "react";
import { useEndpoint } from "../api";
import { Card, CardHeader, Expandable, InfoTip, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { barChart, lineChart, pairedBarChart, stackedAreaChart, stackedBarChart } from "../components/chartOptions";
import { useChartStyle } from "../lib/chartStyle";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { colorAt } from "../lib/palette";
import { formatInteger, formatNumber, formatPercent, shortPath } from "../lib/format";
import type { ToolTableRow, TurnsResponse } from "../types";

const percent = (value: number) => `${Math.round(value)}%`;
const pct = (value: number | null) => (value === null ? null : value * 100);
const NEUTRAL = ["#64748b", "#94a3b8"];

/** Series for a chart from per-bucket records, in the order of the overall totals. A null bucket has no data: a gap, not a zero. */
const seriesOf = <T,>(names: string[], points: T[], pick: (point: T) => Record<string, number> | null) =>
  names.map(name => ({ name, data: points.map(point => { const values = pick(point); return values && (values[name] ?? 0); }) }));

function GroupBar({ row, groups }: { row: ToolTableRow; groups: string[] }) {
  const design = useChartStyle();
  const label = groups.filter(group => row.groups[group]).map(group => `${group} ${formatPercent((row.groups[group] ?? 0) / (row.calls || 1), 0)}`).join(", ");
  return <div role="img" aria-label={label || "No tool calls"} title={label} className="flex h-2 w-full min-w-[90px] overflow-hidden rounded-full bg-surface-3">
    {groups.map((group, index) => <span key={group} style={{ width: `${((row.groups[group] ?? 0) / (row.calls || 1)) * 100}%`, background: design?.color(colorAt(index)) ?? colorAt(index) }} />)}
  </div>;
}

function ToolTable({ title, rows, groups, name }: { title: string; rows: ToolTableRow[]; groups: string[]; name: (key: string) => string }) {
  return <Card>
    <CardHeader title={title} subtitle="Top 10 by steps" />
    <Expandable items={rows}>
      {shown => <TableShell>
        <thead><tr><Th>Name</Th><Th align="right">Steps</Th><Th align="right">Tool calls</Th><Th>Mix</Th></tr></thead>
        <tbody>{shown.map(row => <tr key={row.key}>
          <Td className="max-w-[240px] truncate font-medium text-ink"><span title={row.key}>{name(row.key)}</span></Td>
          <Td align="right">{formatInteger(row.requests)}</Td>
          <Td align="right">{formatInteger(row.calls)}</Td>
          <Td><GroupBar row={row} groups={groups} /></Td>
        </tr>)}</tbody>
      </TableShell>}
    </Expandable>
  </Card>;
}

function ToolViews({ data, tools }: { data: TurnsResponse; tools: NonNullable<TurnsResponse["tools"]> }) {
  const { chartTheme } = useTheme();
  const groups = tools.groups.map(group => group.name);
  const mix = useMemo(() => {
    const shares = data.overTime.map(point => {
      const total = Object.values(point.groups).reduce((sum, count) => sum + count, 0);
      return { groups: total ? Object.fromEntries(Object.entries(point.groups).map(([group, count]) => [group, (count / total) * 100])) : null };
    });
    return stackedAreaChart(chartTheme, data.overTime.map(point => point.label), seriesOf(groups, shares, point => point.groups), { formatter: percent, max: 100 });
  }, [data, groups.join(), chartTheme]);
  const top = useMemo(() => barChart(chartTheme, [...tools.top].reverse().map(tool => tool.name.replace(/^mcp__/, "mcp: ")), [...tools.top].reverse().map(tool => pct(tool.stepShare)), { horizontal: true, formatter: percent, color: () => colorAt(1), showLabels: true }), [tools, chartTheme]);
  return <>
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-1.5">Tool mix over time <InfoTip>Share of requested tool calls per bucket, by one published grouping. A count is a requested call, not a successful one. No cost is attributed to a tool.</InfoTip></span>} />
      <Chart option={mix} height={260} />
    </Card>
    <Card>
      <CardHeader title="Steps with a tool" subtitle={`Share of steps using each tool. These overlap, since a step can use several · ${formatPercent(tools.stepsWithToolsShare, 0)} of steps used any`} />
      <Chart option={top} height={Math.max(160, 26 * tools.top.length + 40)} />
    </Card>
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <ToolTable title="Tools by project" rows={tools.byProject} groups={groups} name={shortPath} />
      <ToolTable title="Tools by model" rows={tools.byModel} groups={groups} name={key => key} />
    </div>
  </>;
}

export function TurnsPage() {
  const { filters } = useFilters();
  const { chartTheme } = useTheme();
  const query = useEndpoint<TurnsResponse>("/api/turns", { ...filters, groupBy: "", metric: "" });
  const data = query.data;

  const depth = useMemo(() => data ? pairedBarChart(chartTheme, data.turns.bins.map(bin => (bin.label === "1" ? "1 step" : `${bin.label} steps`)), [
    { name: "Share of turns", data: data.turns.bins.map(bin => pct(bin.turnShare)), color: NEUTRAL[0] },
    { name: "Share of priced cost", data: data.turns.bins.map(bin => pct(bin.costShare)), color: NEUTRAL[1] },
  ], { formatter: percent }) : null, [data, chartTheme]);
  const autonomy = useMemo(() => data?.autonomy?.weeks.length ? lineChart(chartTheme, data.autonomy.weeks.map(week => week.label), [
    { name: "Median", data: data.autonomy.weeks.map(week => week.median), color: NEUTRAL[0] },
    { name: "p90", data: data.autonomy.weeks.map(week => week.p90), dashed: true, color: NEUTRAL[1] },
  ], { formatter: value => formatNumber(value), preserveGaps: true }) : null, [data, chartTheme]);
  const stops = useMemo(() => {
    if (!data?.stops.length) return null;
    return stackedBarChart(chartTheme, data.overTime.map(point => point.label), seriesOf(data.stops.map(stop => stop.name), data.overTime, point => point.stops), { formatter: value => formatInteger(value) });
  }, [data, chartTheme]);
  const empty = !data?.coverage.steps;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Autonomy ratio" value={data?.autonomy ? formatNumber(data.autonomy.median) : "—"} hint={data?.autonomy ? `median per session, p90 ${formatNumber(data.autonomy.p90)}` : "unavailable"} info="Main-chain API calls per human prompt. It is a count, not a measure of how much the agent did for you." />
        <Stat label="Median turn depth" value={data && !empty ? formatNumber(data.turns.medianDepth) : "—"} hint={data && !empty ? `${formatInteger(data.turns.total)} turns, p90 ${formatNumber(data.turns.p90Depth)}` : undefined} info="Steps from a prompt until the model stops asking for tools. A deep turn is not good or bad." />
        <Stat label="Turns of 20+ steps" value={formatPercent(data?.turns.deep.turnShare ?? null, 0)} hint={data && !empty ? `${formatPercent(data.turns.deep.costShare, 0)} of priced cost` : undefined} />
        <Stat label="Coverage" value={formatPercent(data?.coverage.stopReasonShare ?? null, 0)} hint="of steps have a stop reason" info={data ? `Claude Code only: ${formatInteger(data.coverage.excludedRequests)} other requests are left out because their close reasons mean something else. ${formatPercent(data.coverage.pricedShare, 0)} of steps are priced. ${formatInteger(data.coverage.clippedTurns)} turns started before this window. A filter changes turn shapes, since turns are built from the filtered rows.` : undefined} />
      </div>
      <StateBlock loading={query.isLoading} error={query.error} empty={empty} emptyLabel="No Claude Code steps in this selection">
        {data?.approximate ? <p role="status" className="px-1 text-[11.5px] text-muted">Approximate: these requests have no transcript structure, so turns come from stop reasons alone ({formatPercent(data.coverage.stopReasonShare, 0)} of steps have one). Autonomy and tool mix are unavailable.</p> : null}
        <div className="space-y-3">
          <Card>
            <CardHeader title={<span className="inline-flex items-center gap-1.5">Turn depth <InfoTip>Share of turns next to their share of list-price cost, priced steps only. The gap between the two bars is where cost concentrates, not a judgement of those turns.</InfoTip></span>} subtitle="Share of turns and of priced cost by steps per turn" />
            {depth ? <Chart option={depth} height={260} /> : null}
          </Card>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <Card>
              <CardHeader title="Autonomy over time" subtitle="Main-chain steps per human prompt, by week" />
              {autonomy ? <Chart option={autonomy} height={230} /> : <p className="py-10 text-center text-[12px] text-muted">Unavailable: no human prompts recorded in this selection</p>}
            </Card>
            <Card>
              <CardHeader title="Stop reasons" subtitle="Steps by recorded stop reason" />
              {stops ? <Chart option={stops} height={230} /> : null}
            </Card>
          </div>
          {data?.tools ? <ToolViews data={data} tools={data.tools} /> : null}
          {data?.turns.ends.length ? <Card>
            <CardHeader title={<span className="inline-flex items-center gap-1.5">How turns end <InfoTip>The stop reason of each turn's last step, as recorded. A turn ending in tool_use was interrupted or the transcript ended there.</InfoTip></span>} />
            <TableShell>
              <thead><tr><Th>Stop reason</Th><Th align="right">Turns</Th><Th align="right">Share</Th></tr></thead>
              <tbody>{data.turns.ends.map(end => <tr key={end.name}><Td className="font-medium text-ink">{end.name}</Td><Td align="right">{formatInteger(end.count)}</Td><Td align="right">{formatPercent(end.count / data.turns.total)}</Td></tr>)}</tbody>
            </TableShell>
          </Card> : null}
        </div>
      </StateBlock>
    </div>
  );
}
