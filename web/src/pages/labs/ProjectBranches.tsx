import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { sourceLabel } from "../../api";
import { Chart } from "../../components/Chart";
import { barChart, laneTimelineChart } from "../../components/chartOptions";
import { Card, CardHeader, Expandable, InfoTip, TableShell, Td, Th } from "../../components/ui";
import { formatCompact, formatInteger, formatPercent, formatShortDate, formatUsd, formatUsdAxis } from "../../lib/format";
import { colorAt } from "../../lib/palette";
import { useTheme } from "../../lib/theme";
import type { BranchRow, ProjectRadarResponse } from "../../types";
import { InvestigationState } from "./InvestigationState";
import { Verdict } from "./shared";

type Project = ProjectRadarResponse["projects"][number];
const TOP_BARS = 8;
const HALF_DAY = 12 * 3_600_000;
const TOP_NAMED = 3;
const MIN_RECORDED_SHARE = 0.5;

const branchName = (row: BranchRow) => row.state === "detached" ? "Detached HEAD" : row.state === "unrecorded" ? "No branch recorded" : row.name!;
const rowKey = (row: BranchRow) => `${row.state}:${row.name ?? ""}`;
const span = (row: BranchRow) => row.firstTs === row.lastTs ? formatShortDate(row.firstTs) : `${formatShortDate(row.firstTs)} to ${formatShortDate(row.lastTs)}`;

/** The same fixed pair as the project's own case, narrowed to one branch. */
export function branchEvidenceHref(project: Project, row: BranchRow) {
  const selection = row.state === "named" ? { kind: "branch", project: project.project, state: "named", branch: row.name } : { kind: "branch", project: project.project, state: row.state };
  const url = new URL(project.current.evidence.href, "http://yald.invalid");
  url.searchParams.set("investigation", "project-radar");
  url.searchParams.set("selector", JSON.stringify({ ...project.current.evidence.selector, selection }));
  url.searchParams.set("priorSelector", JSON.stringify({ ...project.prior.evidence.selector, selection }));
  url.searchParams.set("period", "current");
  return `${url.pathname}${url.search}${url.hash}`;
}

function BranchCharts({ rows }: { rows: BranchRow[] }) {
  const { chartTheme } = useTheme();
  const barOption = useMemo(() => {
    const ranked = [...rows].sort((a, b) => b.pricedCostUsd - a.pricedCostUsd);
    const top = ranked.slice(0, TOP_BARS);
    const rest = ranked.slice(TOP_BARS).reduce((sum, row) => sum + row.pricedCostUsd, 0);
    const entries = [...top.map(row => ({ label: branchName(row), value: row.pricedRequests ? row.pricedCostUsd : null })), ...(rest ? [{ label: "Other", value: rest }] : [])].reverse();
    return barChart(chartTheme, entries.map(entry => entry.label), entries.map(entry => entry.value), { horizontal: true, formatter: value => formatUsdAxis(value), color: () => colorAt(0) });
  }, [rows, chartTheme]);
  const lanes = useMemo(() => rows.filter(row => row.days).sort((a, b) => a.pricedCostUsd - b.pricedCostUsd), [rows]);
  const spanOption = useMemo(() => {
    const bars = lanes.map((row, lane) => ({ lane, start: row.firstTs, end: row.lastTs, label: "", color: colorAt(9), tooltip: `${branchName(row)}: ${span(row)}` }));
    const option = laneTimelineChart(chartTheme, lanes.map(branchName), bars, { minWidth: 3 }) as { series: Record<string, unknown>[]; tooltip: Record<string, unknown>; xAxis: { axisLabel?: object } };
    const peak = Math.max(0, ...lanes.flatMap(row => row.days!.map(day => day.costUsd))) || 1;
    const dots = lanes.flatMap((row, lane) => row.days!.map(day => ({ value: [Math.min(row.lastTs, Math.max(row.firstTs, day.ts + HALF_DAY)), lane, day.costUsd], name: `${branchName(row)}, ${day.date}: ${formatUsd(day.costUsd)}` })));
    return { ...option, xAxis: { ...option.xAxis, axisLabel: { ...option.xAxis.axisLabel, hideOverlap: true, formatter: (value: number) => formatShortDate(value) } },
      tooltip: { ...option.tooltip, formatter: (params: { seriesType: string; dataIndex: number; name: string }) => params.seriesType === "scatter" ? params.name : bars[params.dataIndex]?.tooltip ?? "" },
      series: [...option.series, { type: "scatter", data: dots, symbolSize: (value: number[]) => 5 + 14 * Math.sqrt(value[2]! / peak), itemStyle: { color: colorAt(0) } }] };
  }, [lanes, chartTheme]);
  return <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
    <Card>
      <CardHeader title="Priced cost by branch" />
      <Chart option={barOption} height={Math.max(150, Math.min(TOP_BARS + 1, rows.length) * 34 + 40)} />
    </Card>
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-1.5">When each branch was active <InfoTip>One lane from first to last request, with a dot per active day sized by priced cost, for the costliest branches. Overlapping lanes are branches in parallel.</InfoTip></span>} />
      <Chart option={spanOption} height={Math.max(150, lanes.length * 32 + 40)} />
    </Card>
  </div>;
}

function BranchTable({ project, rows }: { project: Project; rows: BranchRow[] }) {
  return <Card>
    <CardHeader title={<span className="inline-flex items-center gap-1.5">Branches and pull requests <InfoTip>Branch cost is where usage was recorded, not the value of the work. A name is a label at request time, and branches get renamed and reused. Claude Code records a branch per request; Codex records it once, at session start. PR links appear only when a transcript records them, and a branch lists the PRs seen in its sessions. PR figures overlap, so they are not added together. Dollars are API list-price equivalents.</InfoTip></span>} />
    <Expandable items={rows} limit={10}>
      {visible => <TableShell>
        <thead><tr><Th>Branch</Th><Th>Basis</Th><Th align="right">Sessions</Th><Th align="right">Requests</Th><Th align="right">Tokens</Th><Th align="right">Priced cost</Th><Th>Active</Th><Th>Pull requests</Th></tr></thead>
        <tbody>{visible.map(row => <tr key={rowKey(row)} className="transition hover:bg-surface-2">
          <Td className="max-w-[240px] truncate font-medium text-ink"><Link to={branchEvidenceHref(project, row)} title={branchName(row)} className="hover:text-accent">{branchName(row)}</Link></Td>
          <Td>{row.bases.length ? row.bases.join(", ") : "not recorded"}<span className="block text-[10.5px] text-muted">{row.sources.map(entry => `${sourceLabel(entry.source)} ${formatInteger(entry.requests)}`).join(", ")}</span></Td>
          <Td align="right">{formatInteger(row.sessions)}</Td>
          <Td align="right">{formatInteger(row.requests)}</Td>
          <Td align="right">{formatCompact(row.tokens)}</Td>
          <Td align="right">{row.pricedRequests ? formatUsd(row.pricedCostUsd) : "unpriced"}{row.unpricedRequests ? <span className="block text-[10.5px] text-muted">{formatInteger(row.pricedRequests)} of {formatInteger(row.requests)} priced</span> : null}</Td>
          <Td className="whitespace-nowrap">{span(row)}<span className="block text-[10.5px] text-muted">{formatInteger(row.activeDays)} {row.activeDays === 1 ? "day" : "days"}</span></Td>
          <Td className="max-w-[220px] truncate"><span title={row.prs.join(", ")}>{row.prs.slice(0, 2).map(link => link.slice(link.indexOf("/") + 1)).join(", ")}{row.prCount > 2 ? ` +${formatInteger(row.prCount - 2)}` : ""}</span></Td>
        </tr>)}</tbody>
      </TableShell>}
    </Expandable>
  </Card>;
}

function ProjectFinding({ project, label }: { project: Project; label: string }) {
  const { branches, totals } = project.current;
  const named = branches.rows.filter(row => row.state === "named").sort((a, b) => b.pricedCostUsd - a.pricedCostUsd);
  const top = named.slice(0, TOP_NAMED);
  const topShare = totals.pricedCostUsd > 0 ? top.reduce((sum, row) => sum + row.pricedCostUsd, 0) / totals.pricedCostUsd : null;
  const { requests } = branches;
  const known = new Set(branches.rows.map(rowKey));
  const before = project.prior.branches.rows.filter(row => !known.has(rowKey(row))).map(branchName);
  return <>
    <Verdict headline={`${label} had activity on ${formatInteger(branches.namedBranches)} ${branches.namedBranches === 1 ? "branch" : "branches"}`}
      detail={<>{topShare === null ? "" : `The ${top.length === 1 ? "costliest held" : `${formatInteger(top.length)} costliest held`} ${formatPercent(topShare, 0)} of its priced cost. `}{formatInteger(requests.unrecorded)} of {formatInteger(requests.total)} requests had no recorded branch, {formatInteger(requests.onMain)} were on main and {formatInteger(requests.detached)} on a detached HEAD.</>}
      info={<>Branch coverage: {branches.coverage.map(entry => `${sourceLabel(entry.source)} ${formatInteger(entry.recorded)} of ${formatInteger(entry.requests)} requests`).join(", ")}. A missing branch is unavailable: it is never treated as main or inferred from the folder or from timing.</>} />
    <BranchCharts rows={branches.rows} />
    <BranchTable project={project} rows={branches.rows} />
    {before.length ? <p className="text-[11.5px] text-muted">Seen only in the period before: {before.slice(0, 5).join(", ")}{before.length > 5 ? ` and ${formatInteger(before.length - 5)} more` : ""}.</p> : null}
  </>;
}

/** Below the project: the selected project's branches. Radar's own totals are unchanged by anything here. */
export function ProjectBranches({ projects, initial, label }: { projects: Project[]; initial?: Project; label: (project: string) => string }) {
  const choices = projects.filter(project => project.project !== "(unattributed)" && project.current.totals.requests > 0);
  const [key, setKey] = useState<string | null>(null);
  const project = choices.find(choice => choice.project === key) ?? (initial && choices.includes(initial) ? initial : choices[0]);
  if (!project) return null;
  const { branches, totals } = project.current;
  const usable = totals.pricedRequests > 0 && (branches.recordedShare ?? 0) >= MIN_RECORDED_SHARE;
  return <div className="space-y-3" data-project-branches>
    <label className="flex items-center gap-2 text-[12px] text-muted">Branches in
      <select className="max-w-[280px] rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] text-ink" value={project.project} onChange={event => setKey(event.target.value)}>
        {choices.map(choice => <option key={choice.project} value={choice.project}>{label(choice.project)}</option>)}
      </select>
    </label>
    {usable ? <ProjectFinding key={project.project} project={project} label={label(project.project)} />
      : <InvestigationState kind="insufficient" title="Not enough branch data for this project" detail={`${formatInteger(branches.requests.recorded)} of ${formatInteger(branches.requests.total)} requests record a branch, and ${formatInteger(totals.pricedRequests)} have a price. This view needs a price and a branch on at least half of them.`} />}
  </div>;
}
