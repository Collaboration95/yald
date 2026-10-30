import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useEndpoint } from "../api";
import { Card, CardHeader, Expandable, InfoTip, Segmented, Stat, StateBlock, TableShell, Td, Th } from "../components/ui";
import { Chart } from "../components/Chart";
import { barChart, lineChart, pairedBarChart, scatterChart, stackedBarChart } from "../components/chartOptions";
import { useFilters } from "../lib/useFilters";
import { useTheme } from "../lib/theme";
import { useChartStyle } from "../lib/chartStyle";
import { colorAt } from "../lib/palette";
import { formatCompact, formatInteger, formatNumber, formatPercent, formatUsd, formatUsdAxis, shortPath } from "../lib/format";
import type { AgentKind, AgentSplit, SubagentsResponse } from "../types";

const KIND_LABELS: Record<AgentKind, string> = { main: "Main thread", subagent: "Subagents", unlabelled: "Unlabelled" };
const KINDS = Object.keys(KIND_LABELS) as AgentKind[];
const percent = (value: number) => `${Math.round(value)}%`;
const tally = { requests: "requests", tokens: "tokens", cost: "costUsd" } as const;
type OverTimeMetric = keyof typeof tally;

/** One row's main / subagent / unlabelled split by priced cost, falling back to requests with nothing priced. */
function SplitBar({ split }: { split: AgentSplit }) {
  const design = useChartStyle();
  const priced = KINDS.reduce((sum, kind) => sum + split[kind].costUsd, 0) > 0;
  const value = (kind: AgentKind) => (priced ? split[kind].costUsd : split[kind].requests);
  const total = KINDS.reduce((sum, kind) => sum + value(kind), 0) || 1;
  const label = KINDS.map(kind => `${KIND_LABELS[kind]} ${Math.round((value(kind) / total) * 100)}%`).join(", ");
  return <div role="img" aria-label={label} title={label} className="flex h-2 w-full min-w-[90px] overflow-hidden rounded-full bg-surface-3">
    {KINDS.map((kind, index) => <span key={kind} style={{ width: `${(value(kind) / total) * 100}%`, background: design?.color(colorAt(index)) ?? colorAt(index) }} />)}
  </div>;
}

function SplitTable({ title, rows, name }: { title: string; rows: { key: string; split: AgentSplit }[]; name: (key: string) => string }) {
  return <Card>
    <CardHeader title={title} subtitle="Top 10 by priced cost" />
    <Expandable items={rows}>
      {shown => <TableShell>
        <thead><tr><Th>Name</Th><Th align="right">Requests</Th><Th align="right">Priced cost</Th><Th>Split</Th></tr></thead>
        <tbody>
          {shown.map(row => {
            const total = KINDS.reduce((sum, kind) => ({ requests: sum.requests + row.split[kind].requests, cost: sum.cost + row.split[kind].costUsd }), { requests: 0, cost: 0 });
            return <tr key={row.key}>
              <Td className="max-w-[240px] truncate font-medium text-ink"><span title={row.key}>{name(row.key)}</span></Td>
              <Td align="right">{formatInteger(total.requests)}</Td>
              <Td align="right">{formatUsd(total.cost)}</Td>
              <Td><SplitBar split={row.split} /></Td>
            </tr>;
          })}
        </tbody>
      </TableShell>}
    </Expandable>
  </Card>;
}

function CodexThreads({ codex }: { codex: SubagentsResponse["codex"] }) {
  if (!codex.requests) return null;
  return <Card>
    <CardHeader title={<span className="inline-flex items-center gap-1.5">Codex threads <InfoTip>Codex subagent traffic often reuses the parent thread's id, so a root thread may hold subagent requests and cannot be split. Only a rollout that names a parent thread marks a subagent thread.</InfoTip></span>} />
    <TableShell>
      <thead><tr><Th>Thread</Th><Th align="right">Requests</Th><Th align="right">Tokens</Th><Th align="right">Priced cost</Th></tr></thead>
      <tbody>
        <tr><Td className="font-medium text-ink">Root thread (may include subagents)</Td><Td align="right">{formatInteger(codex.rootThread.requests)}</Td><Td align="right">{formatCompact(codex.rootThread.tokens)}</Td><Td align="right">{formatUsd(codex.rootThread.costUsd)}</Td></tr>
        <tr><Td className="font-medium text-ink">Subagent thread ({formatInteger(codex.subagentThread.threads)})</Td><Td align="right">{formatInteger(codex.subagentThread.requests)}</Td><Td align="right">{formatCompact(codex.subagentThread.tokens)}</Td><Td align="right">{formatUsd(codex.subagentThread.costUsd)}</Td></tr>
      </tbody>
    </TableShell>
  </Card>;
}

function ClaudeViews({ data }: { data: SubagentsResponse["claude"] }) {
  const { chartTheme } = useTheme();
  const [metric, setMetric] = useState<OverTimeMetric>("cost");
  const headline = useMemo(() => stackedBarChart(chartTheme, ["Priced cost", "Input tokens", "Requests"], data.shares.map(row => ({
    name: KIND_LABELS[row.kind], data: [row.costShare, row.inputShare, row.requestShare].map(value => (value === null ? null : value * 100)),
  })), { horizontal: true, max: 100, formatter: percent }), [data, chartTheme]);
  const overTime = useMemo(() => stackedBarChart(chartTheme, data.overTime.map(point => point.label), KINDS.map(kind => ({
    name: KIND_LABELS[kind], data: data.overTime.map(point => point.split[kind][tally[metric]]),
  })), { formatter: metric === "cost" ? formatUsdAxis : formatCompact }), [data, chartTheme, metric]);
  const coverage = useMemo(() => lineChart(chartTheme, data.overTime.map(point => point.label), [
    { name: "Labelled", data: data.overTime.map(point => (point.labelledShare === null ? null : point.labelledShare * 100)) },
  ], { formatter: percent, showLegend: false, preserveGaps: true }), [data, chartTheme]);
  const fanOut = useMemo(() => barChart(chartTheme, data.fanOut.bins.map(bin => bin.label), data.fanOut.bins.map(bin => bin.sessions), { formatter: formatInteger, color: () => colorAt(1), wholeNumbers: true }), [data, chartTheme]);
  const types = useMemo(() => barChart(chartTheme, data.byType.map(row => row.type), data.byType.map(row => (row.costShare === null ? null : row.costShare * 100)), { horizontal: true, formatter: percent, color: () => colorAt(1), showLabels: true }), [data, chartTheme]);
  const depth = useMemo(() => pairedBarChart(chartTheme, data.byDepth.map(row => `Depth ${row.depth}`), [
    { name: "Requests", data: data.byDepth.map(row => (row.requestShare === null ? null : row.requestShare * 100)) },
    { name: "Priced cost", data: data.byDepth.map(row => (row.costShare === null ? null : row.costShare * 100)) },
  ], { formatter: percent }), [data, chartTheme]);
  const startup = useMemo(() => {
    const option = scatterChart(chartTheme, [{ name: "Subagent", points: data.startup.points.map(point => [point.requests, point.costShare * 100]) }], {
      xLog: true, yMax: 100, xName: "Requests", yName: "First-request write", xFormatter: formatInteger, yFormatter: percent,
    });
    return { ...option, grid: { ...(option.grid as object), right: 64 } };
  }, [data, chartTheme]);

  return <>
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-1.5">Claude Code by agent <InfoTip>Each request counts once, under its own agent. A share is where usage was recorded, not waste or overhead. Cost covers priced requests only.</InfoTip></span>}
        subtitle={`${formatInteger(data.labelledRequests)} of ${formatInteger(data.requests)} requests labelled`}
      />
      <Chart option={headline} height={190} />
    </Card>

    <Card>
      <CardHeader title="Over time" action={<Segmented size="sm" value={metric} options={[{ id: "cost", label: "Cost" }, { id: "tokens", label: "Tokens" }, { id: "requests", label: "Requests" }]} onChange={setMetric} />} />
      <Chart option={overTime} height={260} />
      <p className="mt-2 text-[11px] text-muted">Share of requests labelled</p>
      <Chart option={coverage} height={84} />
    </Card>

    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <Card>
        <CardHeader title="Fan-out" subtitle={`Subagents per session · median ${formatNumber(data.fanOut.median)}, p90 ${formatNumber(data.fanOut.p90)}, max ${formatInteger(data.fanOut.max)}`} />
        <StateBlock empty={!data.fanOut.sessions} emptyLabel="No labelled sessions"><Chart option={fanOut} height={220} /></StateBlock>
      </Card>
      <Card>
        <CardHeader title="Spawn depth" subtitle="As Claude Code recorded it" />
        <StateBlock empty={!data.byDepth.length} emptyLabel="No subagent requests"><Chart option={depth} height={220} /></StateBlock>
      </Card>
    </div>

    <Card>
      <CardHeader title="By agent type" subtitle="Share of subagent priced cost" />
      <StateBlock empty={!data.byType.length} emptyLabel="No subagent requests">
        <Chart option={types} height={Math.max(120, 44 * data.byType.length + 30)} />
        <Expandable items={data.byType}>
          {rows => <TableShell>
            <thead><tr><Th>Type</Th><Th align="right">Spawns</Th><Th align="right">Requests</Th><Th align="right">Median per spawn</Th><Th align="right">Tokens</Th><Th align="right">Priced cost</Th><Th align="right">First-request write</Th></tr></thead>
            <tbody>{rows.map(row => <tr key={row.type}>
              <Td className="font-medium text-ink">{row.type}</Td>
              <Td align="right">{formatInteger(row.spawns)}</Td>
              <Td align="right">{formatInteger(row.requests)}</Td>
              <Td align="right">{formatNumber(row.medianRequestsPerSpawn)}</Td>
              <Td align="right">{formatCompact(row.tokens)}</Td>
              <Td align="right">{formatUsd(row.costUsd)}</Td>
              <Td align="right">{formatUsd(row.startupCostUsd)}</Td>
            </tr>)}</tbody>
          </TableShell>}
        </Expandable>
      </StateBlock>
    </Card>

    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-1.5">Cost of a subagent's first request <InfoTip>A subagent starts by writing its context to the cache. This is the cache-write part of its first request, in list-price equivalents, not a penalty. The 1h write premium is understated: the engine prices all writes at one rate. A subagent whose first request is outside the selection is unavailable, not zero.</InfoTip></span>}
        subtitle={`Share of each subagent's cost · ${formatUsd(data.startup.costUsd)} in total, ${formatUsd(data.startup.medianCostUsd)} median per subagent, ${formatCompact(data.startup.cacheWriteTokens)} tokens written · ${formatPercent(data.startup.shortSpawnShare)} made 2 requests or fewer`}
      />
      <StateBlock empty={!data.startup.points.length} emptyLabel="No priced subagent starts">
        <Chart option={startup} height={280} />
        <p className="mt-2 text-[11px] text-muted">
          {formatInteger(data.startup.spawns)} subagents, {formatInteger(data.startup.unavailableSpawns)} with the first request outside this selection, {formatInteger(data.startup.unpricedSpawns)} unpriced.
          {data.startup.pointsOmitted ? ` Showing the newest ${formatInteger(data.startup.points.length)}; ${formatInteger(data.startup.pointsOmitted)} older points left out.` : ""}
        </p>
      </StateBlock>
    </Card>

    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <SplitTable title="By project" rows={data.byProject} name={key => shortPath(key)} />
      <SplitTable title="By model" rows={data.byModel} name={key => key} />
    </div>
  </>;
}

export function SubagentsPage() {
  const { filters, set } = useFilters();
  const { search } = useLocation();
  const query = useEndpoint<SubagentsResponse>("/api/subagents", { ...filters, groupBy: "", metric: "" });
  const data = query.data;
  const scope = filters.agents.length === 1 && filters.agents[0] !== "unlabelled" ? filters.agents[0]! : filters.agents.length ? "" : "all";
  const claude = data?.claude;
  const subagent = claude?.shares.find(row => row.kind === "subagent");
  const labelled = (claude?.labelledRequests ?? 0) > 0;
  const fullSplit = filters.agents.length === 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Segmented value={scope as "all" | "main" | "subagent"} options={[{ id: "all", label: "All" }, { id: "main", label: "Main only" }, { id: "subagent", label: "Subagents only" }]} onChange={value => set({ agents: value === "all" ? [] : [value] })} />
        <Link to={{ pathname: "/sessions", search }} className="text-[11px] font-medium text-accent">All sessions</Link>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Subagent share" value={labelled && fullSplit ? formatPercent(subagent?.requestShare ?? null, 0) : "—"} hint="of Claude requests" info="A share is where requests were recorded, not waste or overhead." />
        <Stat label="Priced cost share" value={labelled && fullSplit ? formatPercent(subagent?.costShare ?? null, 0) : "—"} hint={subagent?.pricedShare != null ? `${formatPercent(subagent.pricedShare, 0)} of its requests priced` : undefined} />
        <Stat label="Sessions with subagents" value={claude?.fanOut.sessions ? formatPercent(claude.fanOut.withSubagentsShare, 0) : "—"} hint={claude ? `${formatInteger(claude.fanOut.withSubagents)} of ${formatInteger(claude.fanOut.sessions)}` : undefined} />
        <Stat label="Label coverage" value={labelled ? formatPercent(claude?.labelledShare ?? null, 0) : "—"} hint={claude ? `${formatInteger(claude.labelledRequests)} of ${formatInteger(claude.requests)} Claude requests` : undefined} info="Older archive lines have no marker and stay unlabelled. They are never counted as main." />
      </div>
      <StateBlock loading={query.isLoading} error={query.error} empty={!claude?.requests && !data?.codex.requests} emptyLabel="No requests in this window">
        {claude && claude.requests > 0 && !labelled ? <Card>
          <p className="py-4 text-center text-[12px] text-muted">Subagent markers unavailable: {formatInteger(claude.requests - claude.labelledRequests)} of {formatInteger(claude.requests)} Claude requests are unlabelled.</p>
        </Card> : null}
        {claude && labelled ? <ClaudeViews data={claude} /> : null}
        {data ? <CodexThreads codex={data.codex} /> : null}
      </StateBlock>
    </div>
  );
}
