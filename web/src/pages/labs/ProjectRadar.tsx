import { useMemo } from "react";
import { Link } from "react-router-dom";
import { filtersKey, useEndpoint } from "../../api";
import { Chart } from "../../components/Chart";
import { pairedBarChart } from "../../components/chartOptions";
import { Card, CardHeader, Expandable, TableShell, Td, Th } from "../../components/ui";
import { formatDelta, formatInteger, formatUsd, formatUsdAxis, formatUsdDelta, shortPath } from "../../lib/format";
import { colorAt } from "../../lib/palette";
import { useTheme } from "../../lib/theme";
import type { ProjectRadarResponse, RadarChange, RadarTotals } from "../../types";
import { InvestigationState } from "./InvestigationState";
import { ProjectBranches } from "./ProjectBranches";
import { Verdict, periodPhrase, useLabsFilters } from "./shared";

type Project = ProjectRadarResponse["projects"][number];

export const projectLabel = (project: string) => project === "(unattributed)" ? "Unattributed" : shortPath(project);
const cost = (totals: RadarTotals) => totals.pricedRequests > 0 ? formatUsd(totals.pricedCostUsd) : "—";

/** Keep both original windows. Prior evidence must never become a new comparison. */
export function projectRadarEvidenceHref(project: Project, period: "current" | "prior") {
  const url = new URL(project.current.evidence.href, "http://yald.invalid");
  url.searchParams.set("investigation", "project-radar");
  url.searchParams.set("priorSelector", JSON.stringify(project.prior.evidence.selector));
  url.searchParams.set("period", period);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function ProjectRadar() {
  const filters = useLabsFilters();
  const query = useEndpoint<ProjectRadarResponse>("/api/labs/projects", filters, {}, { keepPrevious: false, persist: false });
  if (query.error) return <InvestigationState kind="error" detail={query.error.message} onRetry={() => void query.refetch()} />;
  if (!query.data) return <InvestigationState kind="loading" />;
  return <ProjectRadarResult key={filtersKey(filters)} data={query.data} />;
}

/** The named project whose priced cost moved the most against the period before. */
export function projectMover(projects: Project[]): Project | undefined {
  return projects.filter(project => project.project !== "(unattributed)" && project.comparison.pricedCostUsd.absoluteChange !== null && project.comparison.pricedCostUsd.state !== "insufficient")
    .sort((a, b) => Math.abs(b.comparison.pricedCostUsd.absoluteChange!) - Math.abs(a.comparison.pricedCostUsd.absoluteChange!))[0];
}

function change(change: RadarChange, metric: "cost" | "requests"): string {
  if (change.state === "new") return "new";
  if (change.state === "insufficient" || change.absoluteChange === null) return "—";
  const relative = change.relativeChange === null ? "" : ` (${formatDelta(change.relativeChange, 0)})`;
  return metric === "cost" ? `${formatUsdDelta(change.absoluteChange)}${relative}` : `${change.absoluteChange > 0 ? "+" : ""}${formatInteger(change.absoluteChange)}${relative}`;
}

/** The whole finding, chart and list share one server snapshot. */
export function ProjectRadarResult({ data }: { data: ProjectRadarResponse }) {
  const { chartTheme } = useTheme();
  const empty = data.current.totals.requests === 0 && data.prior.totals.requests === 0;
  const named = data.projects.filter(project => project.project !== "(unattributed)");
  const mover = useMemo(() => projectMover(data.projects), [data.projects]);
  const top5 = data.projects.slice(0, 5);
  const option = useMemo(() => pairedBarChart(chartTheme, top5.map(project => projectLabel(project.project)), [
    { name: "Now", data: top5.map(project => project.current.totals.pricedRequests ? project.current.totals.pricedCostUsd : null), color: colorAt(1) },
    { name: "Before", data: top5.map(project => project.prior.totals.pricedRequests ? project.prior.totals.pricedCostUsd : null), color: colorAt(9) },
  ], { formatter: value => formatUsdAxis(value) }), [top5, chartTheme]);

  const absolute = mover?.comparison.pricedCostUsd.absoluteChange ?? 0;
  const info = <>
    Compares {periodPhrase(data.window)} with the equally long period right before it. Dollars are API list-price equivalents for requests that have a price, at today's prices in both periods, not a bill. Requests with no known folder are shown as Unattributed.
    {" "}{formatInteger(data.current.totals.requests)} requests now, {formatInteger(data.prior.totals.requests)} before; {formatInteger(data.current.totals.unpricedRequests)} have no price. {data.history.note}
  </>;

  return <div className="space-y-3" data-project-radar>
    {empty ? <InvestigationState kind="empty" detail="No requests were recorded for this selection in either period." /> : <>
      <Verdict
        found={!!mover}
        headline={mover ? `${projectLabel(mover.project)} ${absolute >= 0 ? "spent more" : "spent less"} than the period before` : "No project changed in cost"}
        detail={mover ? `${cost(mover.current.totals)} now, ${cost(mover.prior.totals)} before.` : `${formatInteger(named.length)} projects compared; none has a priced change to report.`}
        big={mover ? formatUsdDelta(absolute) : undefined}
        bigLabel={mover ? `vs the previous period` : undefined}
        info={info}
        action={mover ? { href: projectRadarEvidenceHref(mover, "current"), label: "See the requests" } : null}
      />
      <Card>
        <CardHeader title="Top projects by cost" />
        <Chart option={option} height={Math.max(150, top5.length * 44 + 56)} />
      </Card>
      <Card>
        <CardHeader title="Projects" />
        <Expandable items={data.projects} limit={5}>
          {rows => (
            <TableShell>
              <thead>
                <tr><Th>Project</Th><Th align="right">Now</Th><Th align="right">Before</Th><Th align="right">Change</Th><Th align="right">Requests</Th><Th align="right"> </Th></tr>
              </thead>
              <tbody>
                {rows.map(project => (
                  <tr key={project.project} className="transition hover:bg-surface-2">
                    <Td className="max-w-[240px] truncate font-medium text-ink"><span title={project.project}>{projectLabel(project.project)}</span></Td>
                    <Td align="right">{cost(project.current.totals)}</Td>
                    <Td align="right">{cost(project.prior.totals)}</Td>
                    <Td align="right">{change(project.comparison.pricedCostUsd, "cost")}</Td>
                    <Td align="right">{formatInteger(project.current.totals.requests)}</Td>
                    <Td align="right"><Link to={projectRadarEvidenceHref(project, "current")} className="text-accent hover:underline">See the requests</Link></Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Expandable>
      </Card>
      <ProjectBranches projects={data.projects} initial={mover} label={projectLabel} />
    </>}
  </div>;
}
