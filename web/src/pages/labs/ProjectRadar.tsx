import { useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { filtersKey, sourceLabel, useEndpoint } from "../../api";
import { Chart, type ChartOption } from "../../components/Chart";
import { axisCommon, baseGrid, legendCommon, tooltipCommon, type ThemeTokens } from "../../components/chartOptions";
import { Card, CardHeader } from "../../components/ui";
import { YaldiFindingArtwork } from "../../components/YaldiArtwork";
import { formatDelta, formatInteger, formatUsd } from "../../lib/format";
import { colorAt } from "../../lib/palette";
import { useTheme } from "../../lib/theme";
import { useFilters } from "../../lib/useFilters";
import type { ProjectRadarResponse, RadarChange, RadarPeriod, RadarTotals, RadarWindow } from "../../types";
import { InvestigationScope } from "./InvestigationScope";
import { InvestigationState } from "./InvestigationState";

type Project = ProjectRadarResponse["projects"][number];
type Metric = "requests" | "tokens" | "pricedCostUsd";
const METRICS: { id: Metric; label: string }[] = [
  { id: "requests", label: "Requests" }, { id: "tokens", label: "Recorded tokens" }, { id: "pricedCostUsd", label: "API-equivalent USD" },
];
const PERIODS = ["current", "prior"] as const;
const focusClass = "rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--relay-coral)]";
const usd = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 })}`;
const money = (totals: RadarTotals) => totals.pricedRequests > 0 ? usd(totals.pricedCostUsd) : "Unavailable";
const projectLabel = (project: string) => project === "(unattributed)" ? "Unattributed requests" : project.split("/").filter(Boolean).at(-1) || project;
const metricValue = (totals: RadarTotals, metric: Metric) => metric === "pricedCostUsd" ? money(totals) : formatInteger(totals[metric]);

/** Keep both original windows. Prior evidence must never become a new comparison. */
export function projectRadarEvidenceHref(project: Project, period: "current" | "prior") {
  const url = new URL(project.current.evidence.href, "http://yald.invalid");
  url.searchParams.set("investigation", "project-radar");
  url.searchParams.set("priorSelector", JSON.stringify(project.prior.evidence.selector));
  url.searchParams.set("period", period);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function ProjectRadar() {
  const { filters } = useFilters();
  const query = useEndpoint<ProjectRadarResponse>("/api/labs/projects", filters);
  if (query.error) return <InvestigationState kind="error" detail={query.error.message} onRetry={() => void query.refetch()} />;
  if (!query.data) return <InvestigationState kind="loading" />;
  // Selection belongs to this full cohort. A new query never displays a previous response.
  return <ProjectRadarResult key={filtersKey(filters)} data={query.data} />;
}

/** The whole finding, selection, trend, mix and coverage share one server snapshot. */
export function ProjectRadarResult({ data, initialProject }: { data: ProjectRadarResponse; initialProject?: string }) {
  const [selection, setSelection] = useState(initialProject ?? data.projects[0]?.project);
  const [metric, setMetric] = useState<Metric>("requests");
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const { chartTheme } = useTheme();
  const selected = data.projects.find(project => project.project === selection) ?? data.projects[0];
  const empty = data.current.totals.requests === 0 && data.prior.totals.requests === 0;
  const findingSupported = !empty && !!selected && (selected.current.totals.pricedRequests > 0 || selected.prior.totals.pricedRequests > 0)
    && (selected.comparison.pricedCostUsd.state === "compared" || selected.comparison.pricedCostUsd.state === "new");
  const unattributed = data.projects.find(project => project.project === "(unattributed)");
  function selectWithKeyboard(event: KeyboardEvent, index: number) {
    const next = event.key === "ArrowDown" ? Math.min(index + 1, data.projects.length - 1)
      : event.key === "ArrowUp" ? Math.max(index - 1, 0)
      : event.key === "Home" ? 0 : event.key === "End" ? data.projects.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const project = data.projects[next];
    if (project) { setSelection(project.project); buttons.current.get(project.project)?.focus(); }
  }
  return <div className="space-y-3" data-project-radar>
    <section className="card p-4" data-finding-summary="project-radar" aria-labelledby="radar-finding-title">
      <div className="flex items-start gap-4">
        <YaldiFindingArtwork evidenceSufficient={findingSupported} />
        <div className="min-w-0 flex-1" aria-live="polite" aria-atomic="true">
          <h2 id="radar-finding-title" className="text-[16px] font-semibold text-ink">{empty ? "No project activity recorded in these windows" : selected ? projectLabel(selected.project) : "Project Radar"}</h2>
          {selected && !empty ? <>
            <p className="mt-1 break-words text-[11px] text-muted" data-selected-project={selected.project}>{selected.project}</p>
            <p className="mt-2 text-[13px] text-ink" data-radar-finding>
              {formatInteger(selected.current.totals.requests)} current requests · {formatInteger(selected.current.totals.tokens)} recorded tokens · {money(selected.current.totals)} API list-price equivalents.
            </p>
            <p className="mt-1 text-[12px] text-ink-soft">Request change: <Change change={selected.comparison.requests} metric="requests" />. Cost change: <Change change={selected.comparison.pricedCostUsd} metric="pricedCostUsd" />.</p>
          </> : null}
        </div>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <PeriodLabel label="Current" window={data.window} />
        <PeriodLabel label="Prior · preceding equal-length window" window={data.priorWindow} />
      </div>
      <p className="mt-3 text-[11.5px] leading-5 text-muted">Costs are sums of priced requests only, using currently loaded API list prices in both periods. They are not subscription bills. Unpriced requests remain in activity totals.</p>
      {selected && !empty ? <div className="mt-3 flex flex-wrap gap-3 text-[12px]">
        {PERIODS.map(period => <Link key={period} to={projectRadarEvidenceHref(selected, period)} data-radar-evidence={period}
          className={`${focusClass} border border-line px-3 py-1.5 text-ink hover:bg-surface-2`}>{period === "current" ? "Current requests" : "Prior requests"}</Link>)}
      </div> : null}
    </section>

    {empty ? <InvestigationState kind="empty" detail="No requests were recorded for this cohort in either fixed window. Days without loaded observations do not establish zero usage." /> : <>
      <Card>
        <CardHeader title="Ranked projects" subtitle="Server order: named projects by current priced USD, then recorded tokens; unattributed requests last. Unavailable price is not free." />
        <p className="mb-3 text-[11.5px] text-ink-soft">Filtered scope: {formatInteger(data.current.totals.requests)} current / {formatInteger(data.prior.totals.requests)} prior requests.
          {unattributed ? ` Unattributed: ${formatInteger(unattributed.current.totals.requests)} current / ${formatInteger(unattributed.prior.totals.requests)} prior.` : ""} Select a project to inspect both periods. Arrow keys, Home and End also select.</p>
        <div className="max-h-[340px] overflow-auto rounded border border-line">
          <table className="w-full text-left text-[11.5px]" aria-label="Project ranking">
            <thead className="sticky top-0 bg-surface text-muted"><tr><th className="p-2">Project</th><th className="p-2 text-right">Current USD</th><th className="p-2 text-right">Prior USD</th><th className="p-2">Cost change</th><th className="p-2 text-right">Current requests</th><th className="p-2 text-right">Prior requests</th></tr></thead>
            <tbody>{data.projects.map((project, index) => <tr key={project.project} data-radar-project={project.project} className={`border-t border-line ${selected?.project === project.project ? "bg-surface-2" : ""}`}>
              <th scope="row" className="min-w-[180px] max-w-[340px] p-2 font-medium">
                <button type="button" ref={button => { if (button) buttons.current.set(project.project, button); else buttons.current.delete(project.project); }}
                  className={`${focusClass} w-full p-1 text-left text-ink hover:text-[var(--relay-coral)]`} aria-pressed={selected?.project === project.project}
                  onClick={() => setSelection(project.project)} onKeyDown={event => selectWithKeyboard(event, index)}>
                  <span className="text-muted">{index + 1}. </span>{projectLabel(project.project)}<span className="mt-0.5 block break-all text-[10px] font-normal text-muted">{project.project}</span>
                </button>
              </th>
              <td className="p-2 text-right num">{money(project.current.totals)}<PriceSample totals={project.current.totals} /></td>
              <td className="p-2 text-right num">{money(project.prior.totals)}<PriceSample totals={project.prior.totals} /></td>
              <td className="min-w-[140px] p-2 text-ink-soft"><Change change={project.comparison.pricedCostUsd} metric="pricedCostUsd" /></td>
              <td className="p-2 text-right num">{formatInteger(project.current.totals.requests)}</td><td className="p-2 text-right num">{formatInteger(project.prior.totals.requests)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </Card>
      {selected ? <>
        <section className="grid gap-3 sm:grid-cols-3" aria-label="Selected project comparisons">
          {METRICS.map(({ id, label }) => <div key={id} className="card p-4" data-radar-metric={id}>
            <h3 className="text-[11.5px] font-medium text-muted">{label}</h3>
            <p className="num mt-2 text-[18px] font-semibold text-ink" data-period="current">{metricValue(selected.current.totals, id)}</p>
            <p className="mt-1 text-[11.5px] text-muted" data-period="prior">Prior: {metricValue(selected.prior.totals, id)}</p>
            <p className="mt-2 text-[11.5px] text-ink-soft"><Change change={selected.comparison[id]} metric={id} /></p>
          </div>)}
        </section>
        {selected.comparison.requests.state === "insufficient" ? <InvestigationState kind="insufficient" detail={!data.history.prior.hasLoadedHistory
          ? "No loaded history precedes this current window. A prior comparison is unavailable."
          : "The server has no positive prior request baseline for this project. Both windows remain inspectable."} /> : null}
        {selected.comparison.pricedCostUsd.state === "insufficient" ? <InvestigationState kind="insufficient" title="Price comparison unavailable" detail="A priced baseline or enough priced observations are unavailable. Use the request and recorded-token values with their coverage below." /> : null}
        <Card>
          <CardHeader title="Daily observations" subtitle={`${selected.current.activeDays} current / ${selected.prior.activeDays} prior occupied local days. Only recorded daily values are known; gaps are not zero history.`}
            action={<label className="text-[11.5px] text-ink-soft">Daily metric <select aria-label="Daily metric" value={metric} onChange={event => setMetric(event.target.value as Metric)} className={`${focusClass} ml-2 border border-line bg-surface p-1 text-ink`}>
              {METRICS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select></label>} />
          {selected.current.daily.length === 0 && selected.prior.daily.length === 0
            ? <InvestigationState kind="empty" title="No daily observations" detail="This project has no recorded daily values in either window. No points can be shown." />
            : metric === "pricedCostUsd" && selected.current.totals.pricedRequests === 0 && selected.prior.totals.pricedRequests === 0
            ? <InvestigationState kind="insufficient" title="Daily price unavailable" detail="Neither period has a priced request. No price points can be shown." />
            : <div aria-label={`Daily ${METRICS.find(item => item.id === metric)?.label}; values in the daily table`} role="img"><Chart option={radarDailyOption(selected, data.window, data.priorWindow, metric, chartTheme)} height={250} /></div>}
          <p className="text-[11px] text-muted">Points use the original period dates in {data.window.tz}; there are no connecting lines. A missing price has no USD point; a priced zero stays at zero.</p>
          <details className="mt-3 text-[11.5px]"><summary className={`${focusClass} cursor-pointer text-ink`}>Daily values and price coverage</summary><DailyTable project={selected} /></details>
        </Card>
        <Card>
          <CardHeader title="Source and model detail" subtitle="The original source-qualified identities and server values for the selected project." />
          <div className="grid gap-4 xl:grid-cols-2">{PERIODS.map(period => <Mix key={period} label={period === "current" ? "Current" : "Prior"} period={selected[period]} />)}</div>
        </Card>
        <Card>
          <CardHeader title="Coverage and history" subtitle="Activity, price and attribution have separate denominators." />
          <div className="grid gap-4 lg:grid-cols-2">{PERIODS.map(period => <Coverage key={period} label={`${period === "current" ? "Current" : "Prior"} selected project`} period={selected[period]} />)}</div>
          <p className="mt-3 text-[11.5px] text-muted">{selected.gitRoot ? "Grouped by nearest Git root." : selected.project === "(unattributed)" ? "No working directory was recorded for these requests." : "Grouped by recorded working directory; no Git root was found."}</p>
          {selected.folders.length ? <details className="mt-2 text-[11.5px]"><summary className={`${focusClass} cursor-pointer text-ink`}>Recorded folders ({selected.folders.length})</summary><ul className="mt-1 space-y-1 break-all text-ink-soft">{selected.folders.map(folder => <li key={folder}>{folder}</li>)}</ul></details> : null}
          <History data={data} />
        </Card>
      </> : null}
    </>}

    <details className="card p-4 text-[12px]">
      <summary className={`${focusClass} cursor-pointer font-medium text-ink`}>Filtered scope, totals and excluded populations</summary>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">{PERIODS.map(period => <Coverage key={period} label={`${period === "current" ? "Current" : "Prior"} filtered scope`} period={data[period]} />)}</div>
      {empty ? <History data={data} /> : null}
      <div className="mt-3 grid gap-3 xl:grid-cols-2">{PERIODS.map(period => <InvestigationScope key={period} window={period === "current" ? data.window : data.priorWindow} cohort={data.cohort}
        sample={data[period].coverage} unpricedRequests={data[period].totals.unpricedRequests} unattributedRequests={unattributed?.[period].totals.requests}
        notes={[period === "current" ? "Current fixed window." : "Prior fixed window, preceding and equal in elapsed length."]} />)}</div>
    </details>
  </div>;
}

function PeriodLabel({ label, window }: { label: string; window: ProjectRadarResponse["window"] }) {
  return <div className="min-w-0 border-l-2 border-line pl-3 text-[11.5px] text-ink-soft" data-radar-period={label.startsWith("Current") ? "current" : "prior"}>
    <h3 className="font-semibold text-ink">{label}</h3><p>{window.label}</p>
    <p className="mt-1 break-words text-[10.5px] text-muted">[<time dateTime={window.fromIso}>{window.fromIso}</time>, <time dateTime={window.toIso}>{window.toIso}</time>) · {window.tz}</p>
  </div>;
}

function Change({ change, metric }: { change: RadarChange; metric: Metric }) {
  if (change.state === "new") return <span data-comparison-state="new">New observation · no positive baseline</span>;
  if (change.state === "insufficient") return <span data-comparison-state="insufficient">Insufficient baseline / observations</span>;
  const absolute = change.absoluteChange;
  return <span data-comparison-state="compared">{change.relativeChange === null ? "Ratio unavailable" : formatDelta(change.relativeChange)}
    {absolute === null ? " · change unavailable" : ` · ${absolute > 0 ? "+" : absolute < 0 ? "−" : ""}${metric === "pricedCostUsd" ? usd(Math.abs(absolute)) : formatInteger(Math.abs(absolute))}${metric === "pricedCostUsd" ? " USD" : metric === "tokens" ? " tokens" : " requests"}`}</span>;
}

function PriceSample({ totals }: { totals: RadarTotals }) {
  return <span className="mt-0.5 block whitespace-nowrap text-[10px] text-muted">{totals.pricedRequests}/{totals.requests} priced · {totals.unpricedRequests} unpriced</span>;
}

/** Scatter coordinates are only server buckets, with price presence preserved. */
export function radarDailyOption(project: Project, window: RadarWindow, priorWindow: RadarWindow, metric: Metric, theme: ThemeTokens): ChartOption {
  const date = (ts: number) => new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric", timeZone: window.tz }).format(ts);
  return {
    animation: false,
    grid: baseGrid({ left: 12, top: 34, bottom: 12 }),
    legend: legendCommon(theme),
    tooltip: { ...tooltipCommon(theme), trigger: "item", renderMode: "richText", formatter: (params: unknown) => {
      const point = params as { seriesName: string; data: { name: string; value: [number, number | null]; priced: number; requests: number } };
      const value = point.data.value[1];
      return `${point.seriesName} · ${point.data.name}\n${value === null ? "Unavailable" : metric === "pricedCostUsd" ? usd(value) : formatInteger(value)} ${METRICS.find(item => item.id === metric)?.label}\n${point.data.priced}/${point.data.requests} requests priced`;
    } },
    xAxis: { ...axisCommon(theme), type: "time", min: priorWindow.from, max: window.to, axisLabel: { color: theme.axis, fontSize: 10, formatter: date } },
    yAxis: { ...axisCommon(theme), type: "value", min: 0, axisLabel: { color: theme.axis, fontSize: 10, formatter: (value: number) => metric === "pricedCostUsd" ? formatUsd(value) : formatInteger(value) } },
    series: PERIODS.map((period, index) => ({
      name: period === "current" ? "Current" : "Prior", type: "scatter", symbol: period === "current" ? "circle" : "diamond", symbolSize: 9,
      itemStyle: { color: colorAt(index) },
      data: project[period].daily.map(day => ({ name: day.date, value: [day.from, metric === "pricedCostUsd" && day.pricedRequests === 0 ? null : day[metric]], priced: day.pricedRequests, requests: day.requests })),
    })),
  };
}

function DailyTable({ project }: { project: Project }) {
  return <div className="mt-2 max-h-[300px] overflow-auto"><table className="w-full text-left text-[11px]" aria-label="Selected project daily values">
    <thead><tr><th className="p-2">Period / local day</th><th className="p-2 text-right">Requests</th><th className="p-2 text-right">Tokens</th><th className="p-2 text-right">USD / price coverage</th></tr></thead>
    <tbody>{PERIODS.map(period => project[period].daily.length ? project[period].daily.map(day => <tr key={`${period}-${day.ts}`} data-radar-daily={period} data-from={day.from} data-to={day.to} className="border-t border-line">
      <th scope="row" className="p-2 font-normal">{period === "current" ? "Current" : "Prior"} · {day.date}<span className="block text-[10px] text-muted">[{new Date(day.from).toISOString()}, {new Date(day.to).toISOString()})</span></th>
      <td className="p-2 text-right num">{formatInteger(day.requests)}</td><td className="p-2 text-right num">{formatInteger(day.tokens)}</td><td className="p-2 text-right num">{money(day)}<PriceSample totals={day} /></td>
    </tr>) : <tr key={period}><td colSpan={4} className="p-2 text-muted">{period === "current" ? "Current" : "Prior"}: no occupied daily observations.</td></tr>)}</tbody>
  </table></div>;
}

function Mix({ label, period }: { label: string; period: RadarPeriod }) {
  return <section className="min-w-0" data-radar-mix={label.toLowerCase()}><h3 className="mb-2 text-[12px] font-semibold text-ink">{label}</h3>
    {period.totals.requests === 0 ? <p className="text-[11.5px] text-muted">No recorded requests in this period.</p> : <>
      <MixTable label={`${label} sources`} rows={period.sources.map(row => ({ ...row, identity: row.source, label: sourceLabel(row.source) }))} />
      <MixTable label={`${label} models`} rows={period.models.map(row => ({ ...row, identity: JSON.stringify([row.source, row.provider, row.model]), label: `${sourceLabel(row.source)} · ${row.provider} · ${row.model}` }))} />
    </>}
  </section>;
}
function MixTable({ label, rows }: { label: string; rows: (RadarTotals & { identity: string; label: string })[] }) {
  return <div className="mb-3 max-h-[260px] overflow-auto"><table className="w-full text-left text-[11px]" aria-label={label}>
    <caption className="mb-1 text-left text-muted">{label}</caption><thead><tr><th className="p-2">Identity</th><th className="p-2 text-right">Requests</th><th className="p-2 text-right">Tokens</th><th className="p-2 text-right">USD</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.identity} className="border-t border-line"><th scope="row" className="max-w-[220px] break-words p-2 font-normal">{row.label}</th><td className="p-2 text-right num">{formatInteger(row.requests)}</td><td className="p-2 text-right num">{formatInteger(row.tokens)}</td><td className="p-2 text-right num">{money(row)}<PriceSample totals={row} /></td></tr>)}</tbody>
  </table></div>;
}

const reasons = { noConversationId: "No conversation ID", noRollout: "No matching rollout", other: "No recorded working directory" };
function Coverage({ label, period }: { label: string; period: RadarPeriod }) {
  const coverage = period.coverage, excluded = coverage.projectExclusions;
  return <section className="min-w-0 text-[11.5px] leading-5 text-ink-soft" data-radar-coverage={label}>
    <h3 className="font-semibold text-ink">{label}</h3>
    <p>{formatInteger(period.totals.requests)} requests · {formatInteger(period.totals.tokens)} recorded tokens · {money(period.totals)} API-equivalent USD.</p>
    <p>Activity eligible: {coverage.eligibleRequests}/{coverage.totalRequests}. Priced: {coverage.pricing.eligibleRequests}/{coverage.pricing.totalRequests}; {period.totals.unpricedRequests} unpriced.</p>
    <p>Known project folder: {coverage.attribution.eligibleRequests}/{coverage.attribution.totalRequests}. Occupied local days: {period.activeDays}.</p>
    {coverage.unattributedReasons.some(reason => reason.rows > 0) ? <ul>{coverage.unattributedReasons.filter(reason => reason.rows > 0).map(reason => <li key={reason.reason}>{reasons[reason.reason]}: {reason.rows} requests · {formatInteger(reason.tokens)} tokens.</li>)}</ul> : null}
    {excluded ? <div className="mt-2" data-project-exclusions><p>Outside strict totals, with every other filter retained:</p><p>{excluded.attribution.outsideProjects.rows} requests / {formatInteger(excluded.attribution.outsideProjects.tokens)} tokens in other known projects.</p><p>{excluded.attribution.unattributed.rows} requests / {formatInteger(excluded.attribution.unattributed.tokens)} tokens without attribution excluded by the project filter.</p>
      {excluded.attribution.unattributed.reasons.filter(reason => reason.rows > 0).map(reason => <p key={reason.reason}>{reasons[reason.reason]}: {reason.rows} requests.</p>)}</div> : null}
    <details className="mt-2"><summary className={`${focusClass} cursor-pointer text-ink`}>Measurement coverage</summary><dl className="grid grid-cols-2 gap-x-2">{Object.entries(coverage.measurements).filter(([key]) => key !== "totalRequests").map(([key, sample]) => typeof sample === "number" ? null : <div key={key}><dt>{key}</dt><dd>{sample.eligibleRequests}/{sample.totalRequests} eligible</dd></div>)}</dl></details>
  </section>;
}
function History({ data }: { data: ProjectRadarResponse }) {
  return <div className="mt-3 border-t border-line pt-3 text-[11.5px] leading-5 text-muted" data-radar-history>
    <p>Loaded history completeness: unknown. Earliest loaded request: {data.history.firstLoadedAt === null ? "unavailable" : new Date(data.history.firstLoadedAt).toISOString()}.</p>
    {data.history.current.startsBeforeLoadedHistory ? <p>The current window begins before loaded history.</p> : null}
    {data.history.prior.startsBeforeLoadedHistory ? <p>The prior window begins before loaded history; its baseline may be partial.</p> : null}
    <p>{data.history.note}</p>
  </div>;
}
