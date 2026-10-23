import { useSearchParams, Link } from "react-router-dom";
import { useState } from "react";
import { filtersKey, useEndpoint } from "../../api";
import { Chart, type ChartOption } from "../../components/Chart";
import { axisCommon, baseGrid, legendCommon, tooltipCommon, type ThemeTokens } from "../../components/chartOptions";
import { Card, CardHeader, Segmented } from "../../components/ui";
import { YaldiFindingArtwork } from "../../components/YaldiArtwork";
import { formatInteger, formatUsdAxis } from "../../lib/format";
import { colorAt } from "../../lib/palette";
import { useTheme } from "../../lib/theme";
import { useFilters } from "../../lib/useFilters";
import type { SpendChangesResponse, SpendCut, SpendCutData, SpendDay, SpendDecomposition, SpendGroup } from "../../types";
import { InvestigationScope } from "./InvestigationScope";
import { InvestigationState } from "./InvestigationState";

type Day = SpendDay;
type Decomposition = SpendDecomposition;
type CutData = SpendCutData;
type GroupRow = SpendGroup;

const focusClass = "rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--relay-coral)]";
const usd = (value: number | null) => value === null ? "Unavailable" : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${usd(Math.abs(value))}`;
const CUTS: { id: SpendCut; label: string }[] = [
  { id: "project", label: "Project" }, { id: "model", label: "Model" }, { id: "tokenClass", label: "Token class" }, { id: "session", label: "Session" },
];
const STATE_TEXT: Record<Day["state"], string> = {
  spike: "Spike", normal: "Not above threshold", insufficient: "Insufficient baseline", partial: "Partial day", "no-priced": "No priced request",
};

function whyNot(day: Day): string {
  if (day.state === "partial") return day.partialReason === "in-progress" ? "The local day is still in progress." : "The day is cut by the edge of the selected window.";
  if (day.state === "insufficient") return day.insufficientReason === "zero-baseline" ? "The baseline median is $0." : `Only ${day.baseline.activeDays} active baseline days; ${7} are needed.`;
  if (day.state === "no-priced") return "No request that day has a price.";
  return "";
}

export function SpendChanges() {
  const { filters } = useFilters();
  const [params, setParams] = useSearchParams();
  const day = params.get("day") ?? undefined;
  const query = useEndpoint<SpendChangesResponse>("/api/labs/spend", filters, day ? { day } : {}, { keepPrevious: false, persist: false });
  const pick = (next: string | null) => setParams(current => {
    const out = new URLSearchParams(current);
    if (next) out.set("day", next); else out.delete("day");
    return out;
  }, { replace: true });
  if (query.error) return <InvestigationState kind="error" detail={query.error.message} onRetry={() => void query.refetch()} />;
  if (!query.data) return <InvestigationState kind="loading" />;
  return <SpendChangesResult key={filtersKey(filters)} data={query.data} onPick={pick} />;
}

/** One server snapshot: the rule, the days, the decomposition and the coverage all come from the same response. */
export function SpendChangesResult({ data, onPick }: { data: SpendChangesResponse; onPick?: (day: string | null) => void }) {
  const [cutId, setCutId] = useState<SpendCut>("project");
  const { chartTheme } = useTheme();
  const { rule, coverage, selected } = data;
  const spikes = data.days.filter(day => day.state === "spike");
  const decomposition = selected?.decomposition ?? null;
  const supported = !!decomposition && !!selected && selected.day.pricedRequests > 0;
  const empty = coverage.totalRequests === 0;
  const cut = decomposition?.cuts[cutId];
  return <div className="space-y-3" data-spend-changes>
    <section className="card p-4" data-finding-summary="spend-changes" aria-labelledby="spend-title">
      <div className="flex items-start gap-4">
        <YaldiFindingArtwork evidenceSufficient={supported} />
        <div className="min-w-0 flex-1" aria-live="polite" aria-atomic="true">
          <p className="text-[11px] uppercase tracking-wider text-muted">Spend spikes</p>
          <h2 id="spend-title" className="text-[16px] font-semibold text-ink">
            {empty ? "No requests recorded in this window" : spikes.length === 0 ? "No day above the spike threshold" : `${spikes.length} ${spikes.length === 1 ? "day" : "days"} above ${rule.spikeMultiple}× the trailing median`}
          </h2>
          <p className="mt-2 text-[13px] text-ink" data-spend-finding>
            {empty ? "Days without loaded observations do not establish zero usage." : spikes.length === 0
              ? `${coverage.activeDays} days with a priced request; none exceeded the threshold, and ${coverage.insufficientDays} ${coverage.insufficientDays === 1 ? "day has" : "days have"} too little baseline to judge.`
              : `${usd(coverage.spikeCostUsd)} of ${usd(coverage.pricedCostUsd)} priced API list-price equivalents landed on those days${coverage.spikeCostShare === null ? "" : ` (${(coverage.spikeCostShare * 100).toFixed(1)}%)`}.`}
          </p>
          <p className="mt-1 text-[12px] text-ink-soft">
            Unusual means high against your own loaded recent history. It is not a budget, an alarm or a judgement.
          </p>
        </div>
      </div>
      <p className="mt-3 text-[11.5px] leading-5 text-muted" data-spend-rule>
        Rule ({rule.id}): {rule.baseline}; a spike is {rule.spike}. A day needs at least {rule.minBaselineActiveDays} active baseline days
        (an active day is {rule.activeDay}) or it is shown as insufficient, never as normal. Parameters: {rule.baselineActiveDays} baseline days, {rule.spikeMultiple}× multiple.
        Costs are API list-price equivalents at today's loaded prices for priced requests only, not subscription bills.
      </p>
      <p className="mt-2 text-[11.5px] text-ink-soft" data-spend-coverage>
        Priced: {formatInteger(coverage.pricedRequests)} of {formatInteger(coverage.totalRequests)} requests; {formatInteger(coverage.unpricedRequests)} unpriced add requests and tokens, never dollars.
        {" "}Known project folder: {formatInteger(coverage.attributedRequests)} of {formatInteger(coverage.totalRequests)} requests.
        {" "}Window days: {coverage.windowDays}; with a priced request: {coverage.activeDays}; partial: {coverage.partialDays}; insufficient baseline: {coverage.insufficientDays}.
      </p>
    </section>

    {empty ? <InvestigationState kind="empty" detail="No requests were recorded for this cohort in the window." /> : <>
      <Card>
        <CardHeader title="Daily priced cost" subtitle={`Bars are priced API-equivalent USD per local day (${data.window.tz}). Line: trailing median. Dashed: ${rule.spikeMultiple}× threshold. Hollow bars are partial or insufficient days, not normal ones.`} />
        <div role="img" aria-label="Daily priced cost with the trailing median and spike threshold; values in the table below"><Chart option={spendDailyOption(data.days, chartTheme)} height={260} /></div>
        <details className="mt-3 text-[11.5px]"><summary className={`${focusClass} cursor-pointer text-ink`}>Daily values, baselines and states</summary>
          <div className="mt-2 max-h-[320px] overflow-auto"><table className="w-full text-left text-[11px]" aria-label="Daily spend values">
            <thead className="sticky top-0 bg-surface text-muted"><tr><th className="p-2">Local day</th><th className="p-2 text-right">Priced USD</th><th className="p-2 text-right">Median</th><th className="p-2 text-right">Threshold</th><th className="p-2 text-right">× median</th><th className="p-2">State</th><th className="p-2 text-right">Priced / requests</th></tr></thead>
            <tbody>{data.days.map(day => <tr key={day.ts} data-spend-day={day.date} data-state={day.state} className={`border-t border-line ${selected?.day.date === day.date ? "bg-surface-2" : ""}`}>
              <th scope="row" className="p-2 font-normal">{onPick ? <button type="button" className={`${focusClass} text-ink hover:text-[var(--relay-coral)]`} onClick={() => onPick(day.date)}>{day.date}</button> : day.date}</th>
              <td className="p-2 text-right num">{usd(day.pricedCostUsd)}</td><td className="p-2 text-right num">{usd(day.baseline.medianUsd)}</td><td className="p-2 text-right num">{usd(day.baseline.thresholdUsd)}</td>
              <td className="p-2 text-right num">{day.baseline.ratio === null ? "Unavailable" : `${day.baseline.ratio.toFixed(2)}×`}</td>
              <td className="p-2">{STATE_TEXT[day.state]}{whyNot(day) ? <span className="block text-[10px] text-muted">{whyNot(day)}</span> : null}</td>
              <td className="p-2 text-right num">{day.pricedRequests} / {day.requests}</td>
            </tr>)}</tbody>
          </table></div>
        </details>
        <p className="mt-2 text-[11px] text-muted">{data.history.note}</p>
      </Card>

      {spikes.length ? <Card>
        <CardHeader title="Spike days" subtitle="Choose a day to see what changed against its own baseline." />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Spike days">
          {spikes.map(day => <button key={day.ts} type="button" aria-pressed={selected?.day.date === day.date} data-spend-pick={day.date} onClick={() => onPick?.(day.date)}
            className={`${focusClass} border border-line px-3 py-1.5 text-[12px] text-ink hover:bg-surface-2 aria-pressed:bg-surface-3`}>
            {day.date} · {usd(day.pricedCostUsd)} · {day.baseline.ratio?.toFixed(1)}×</button>)}
        </div>
      </Card> : null}

      {selected && !decomposition ? <InvestigationState kind="insufficient" title={`${selected.day.date} is not decomposed`} detail={selected.limitations.join(" ")} /> : null}

      {selected && decomposition && cut ? <>
        <Card>
          <CardHeader title={`What changed on ${selected.day.date}`}
            subtitle={`${usd(decomposition.dayCostUsd)} that day against a ${usd(decomposition.baselineMeanUsd)} mean over ${decomposition.keptBaselineDays} of the ${decomposition.baselineDays} baseline days (${signed(decomposition.changeUsd)}). The median used for detection was ${usd(decomposition.baselineMedianUsd)}.`}
            action={<Segmented size="sm" value={cutId} options={CUTS} onChange={setCutId} />} />
          {decomposition.excludedBaselineDates.length ? <p className="mb-2 text-[11.5px] text-ink-soft" data-spend-excluded>
            Left out of the mean because they exceed {rule.spikeMultiple}× the baseline median: {decomposition.excludedBaselineDates.join(", ")}.</p> : null}
          <div role="img" aria-label={`Change by ${CUTS.find(c => c.id === cutId)?.label.toLowerCase()}; values in the table below`}><Chart option={spendWaterfallOption(decomposition, cut, chartTheme)} height={300} /></div>
          <p className="mt-1 text-[11px] text-muted">Each step is the cost on the day minus the baseline mean for that group; steps sum to the total change. "New" means no baseline cost on any kept day. A share of dollars shows where they landed, not why.</p>
          <Contributors cut={cut} />
        </Card>
        <Card>
          <CardHeader title="Drill-down" subtitle={`Order: ${decomposition.drilldown.order.join(" → ")}. Projects with the largest change first; token classes sum to their model.`} />
          <div className="space-y-2">{decomposition.drilldown.projects.map(project => <details key={project.key} className="border border-line p-2 text-[11.5px]">
            <summary className={`${focusClass} cursor-pointer break-all text-ink`}>{project.label} · {signed(project.changeUsd)}{project.isNew ? " · new" : ""}</summary>
            <div className="mt-2 space-y-2">{project.models.map(model => <div key={model.key} className="ml-3">
              <p className="break-words text-ink">{model.label} · {signed(model.changeUsd)}{model.isNew ? " · new" : ""}</p>
              <p className="ml-3 text-[11px] text-ink-soft">{model.tokenClasses.map(c => `${c.label} ${signed(c.changeUsd)}`).join(" · ")}</p>
            </div>)}
            {project.otherModels ? <p className="ml-3 text-[11px] text-muted">{project.otherModels.groups} smaller models · {signed(project.otherModels.changeUsd)}</p> : null}</div>
          </details>)}
          {decomposition.drilldown.otherProjects ? <p className="text-[11px] text-muted">{decomposition.drilldown.otherProjects.groups} smaller projects · {signed(decomposition.drilldown.otherProjects.changeUsd)}</p> : null}</div>
        </Card>
        <Card>
          <CardHeader title="Coverage for this day" subtitle="Separate denominators; none is hidden inside the dollars." />
          <ul className="space-y-1 text-[11.5px] text-ink-soft" data-spend-day-coverage>
            <li>Priced requests that day: {selected.day.pricedRequests} of {selected.day.requests}.</li>
            <li>Unpriced that day: {formatInteger(decomposition.unpriced.dayRequests)} requests, {formatInteger(decomposition.unpriced.dayTokens)} recorded tokens (baseline mean {decomposition.unpriced.baselineMeanRequests.toFixed(1)} requests, change {decomposition.unpriced.requestChange >= 0 ? "+" : "−"}{Math.abs(decomposition.unpriced.requestChange).toFixed(1)}). They carry no dollars.</li>
            <li>Known project folder: {decomposition.attribution.attributedRequests} of {decomposition.attribution.dayRequests} requests that day ({usd(decomposition.attribution.attributedPricedCostUsd)} of {usd(decomposition.attribution.dayPricedCostUsd)} priced); {decomposition.attribution.baselineAttributedRequests} of {decomposition.attribution.baselineRequests} on the baseline days.</li>
            <li>Baseline days: {selected.baselineDays.map(entry => entry.date).join(", ") || "none"}.</li>
          </ul>
          {selected.evidence ? <div className="mt-3"><Link to={selected.evidence.href} data-spend-evidence className={`${focusClass} inline-block border border-line px-3 py-1.5 text-[12px] text-ink hover:bg-surface-2`}>Open this day's requests as a fixed case</Link></div> : null}
        </Card>
      </> : null}
    </>}

    <details className="card p-4 text-[12px]">
      <summary className={`${focusClass} cursor-pointer font-medium text-ink`}>Scope and excluded populations</summary>
      <div className="mt-3"><InvestigationScope window={data.window} cohort={data.cohort} sample={{ eligibleRequests: coverage.pricedRequests, totalRequests: coverage.totalRequests }} unpricedRequests={coverage.unpricedRequests}
        unattributedRequests={coverage.totalRequests - coverage.attributedRequests} notes={["Baselines read loaded history before the window, in the same cohort."]} /></div>
    </details>
  </div>;
}

function Contributors({ cut }: { cut: CutData }) {
  const rows: (GroupRow & { new?: boolean })[] = [...cut.groups, ...cut.new.map(group => ({ ...group, new: true }))];
  return <details className="mt-3 text-[11.5px]" open><summary className={`${focusClass} cursor-pointer text-ink`}>Exact values</summary>
    <div className="mt-2 max-h-[320px] overflow-auto"><table className="w-full text-left text-[11px]" aria-label="Contributors to the change">
      <thead className="sticky top-0 bg-surface text-muted"><tr><th className="p-2">Group</th><th className="p-2 text-right">Day</th><th className="p-2 text-right">Baseline mean</th><th className="p-2 text-right">Change</th></tr></thead>
      <tbody>{rows.map(row => <tr key={`${row.new ? "n" : "g"}${row.key}`} className="border-t border-line" data-new={row.new ? "true" : undefined}>
        <th scope="row" className="max-w-[320px] break-all p-2 font-normal">{row.evidence ? <Link to={row.evidence.href} className={`${focusClass} text-ink hover:text-[var(--relay-coral)]`}>{row.label}</Link> : row.label}{row.new ? <span className="ml-1 text-[10px] text-muted">new</span> : null}</th>
        <td className="p-2 text-right num">{usd(row.dayCostUsd)}</td><td className="p-2 text-right num">{usd(row.baselineMeanUsd)}</td><td className="p-2 text-right num">{signed(row.changeUsd)}</td>
      </tr>)}
      {cut.other ? <tr className="border-t border-line"><th scope="row" className="p-2 font-normal">Other ({cut.other.groups} smaller{cut.other.newGroups ? `, ${cut.other.newGroups} new` : ""})</th>
        <td className="p-2 text-right num">{usd(cut.other.dayCostUsd)}</td><td className="p-2 text-right num">{usd(cut.other.baselineMeanUsd)}</td><td className="p-2 text-right num">{signed(cut.other.changeUsd)}</td></tr> : null}</tbody>
    </table></div></details>;
}

/** Whole dollars on large axes; cents when every value is small, so ticks stay distinct. */

/** Bars per local day with the median line and dashed threshold. Hollow = partial or insufficient. */
export function spendDailyOption(days: Day[], theme: ThemeTokens): ChartOption {
  const spike = colorAt(5);
  const base = colorAt(1);
  const hollow = (color: string) => ({ color: "transparent", borderColor: color, borderWidth: 1.5, borderType: "dashed" as const });
  return {
    animation: false,
    grid: baseGrid({ top: 34, bottom: 8 }),
    legend: legendCommon(theme),
    tooltip: { ...tooltipCommon(theme), trigger: "axis", renderMode: "richText", formatter: (raw: unknown) => {
      const index = (raw as { dataIndex: number }[])[0]?.dataIndex ?? 0;
      const day = days[index]!;
      return [day.date, `${day.pricedCostUsd === null ? "No priced cost" : usd(day.pricedCostUsd)} · ${STATE_TEXT[day.state]}`,
        day.baseline.medianUsd === null ? "Baseline unavailable" : `Median ${usd(day.baseline.medianUsd)}${day.baseline.thresholdUsd === null ? "" : ` · threshold ${usd(day.baseline.thresholdUsd)}`}`,
        whyNot(day), `${day.pricedRequests}/${day.requests} requests priced`].filter(Boolean).join("\n");
    } },
    xAxis: { ...axisCommon(theme), type: "category", data: days.map(day => day.date.slice(5)), splitLine: { show: false } },
    yAxis: { ...axisCommon(theme), type: "value", min: 0, axisLabel: { color: theme.axis, fontSize: 10, formatter: (value: number) => formatUsdAxis(value) } },
    series: [
      { name: "Priced cost", type: "bar", barMaxWidth: 18, data: days.map(day => {
        if (day.pricedCostUsd === null) return null;
        const partial = day.state === "partial" || day.state === "insufficient";
        return { value: day.pricedCostUsd,
          itemStyle: partial ? hollow(base) : { color: day.state === "spike" ? spike : base, borderRadius: [3, 3, 0, 0] },
          label: day.state === "spike" ? { show: true, position: "top", formatter: "Spike", color: theme.text, fontSize: 10 } : undefined };
      }) },
      { name: "Trailing median", type: "line", showSymbol: false, connectNulls: false, lineStyle: { width: 1.5, color: theme.text }, itemStyle: { color: theme.text },
        data: days.map(day => day.baseline.medianUsd !== null && day.state !== "partial" ? day.baseline.medianUsd : null) },
      { name: `${days.length ? "Spike threshold" : "Threshold"}`, type: "line", showSymbol: false, connectNulls: false, lineStyle: { width: 1.5, type: "dashed", color: spike }, itemStyle: { color: spike },
        data: days.map(day => day.baseline.thresholdUsd) },
    ],
  };
}

/** Floating steps from the baseline mean to the day's cost: increases first, then decreases, so the base never dips below zero. */
export function spendWaterfallOption(d: Decomposition, cut: CutData, theme: ThemeTokens): ChartOption {
  const items = [...cut.groups.map(g => ({ label: g.label, change: g.changeUsd, isNew: false })), ...cut.new.map(g => ({ label: `${g.label} (new)`, change: g.changeUsd, isNew: true })),
    ...(cut.other ? [{ label: `Other (${cut.other.groups})`, change: cut.other.changeUsd, isNew: false }] : [])];
  const ordered = [...items.filter(i => i.change >= 0).sort((a, b) => b.change - a.change), ...items.filter(i => i.change < 0).sort((a, b) => a.change - b.change)];
  // Axis text uses the last folder name; the full path stays in the tooltip and the exact-values table.
  const short = (label: string) => { const text = label.startsWith("/") ? label.replace(/ \(new\)$/, "").split("/").filter(Boolean).at(-1) + (label.endsWith(" (new)") ? " (new)" : "") : label; return text.length > 24 ? `${text.slice(0, 23)}…` : text; };
  const labels = ["Baseline mean", ...ordered.map(i => short(i.label)), "Day total"];
  const base: (number | null)[] = [0];
  const up: (number | null)[] = [null];
  const down: (number | null)[] = [null];
  const total: (number | null)[] = [d.baselineMeanUsd];
  let running = d.baselineMeanUsd;
  for (const item of ordered) {
    const next = running + item.change;
    base.push(Math.min(running, next));
    (item.change >= 0 ? up : down).push(Math.abs(item.change));
    (item.change >= 0 ? down : up).push(null);
    total.push(null);
    running = next;
  }
  base.push(0); up.push(null); down.push(null); total.push(d.dayCostUsd);
  const bar = (name: string, data: (number | null)[], color: string, extra: object = {}) => ({ name, type: "bar", stack: "waterfall", barMaxWidth: 28, data, itemStyle: { color }, ...extra });
  return {
    animation: false,
    grid: baseGrid({ top: 34, bottom: 8, left: 12 }),
    legend: { ...legendCommon(theme), data: ["Increase", "Decrease", "Totals"] },
    tooltip: { ...tooltipCommon(theme), trigger: "axis", axisPointer: { type: "shadow" }, renderMode: "richText", formatter: (raw: unknown) => {
      const index = (raw as { dataIndex: number }[])[0]?.dataIndex ?? 0;
      if (index === 0) return `Baseline mean\n${usd(d.baselineMeanUsd)}`;
      if (index === labels.length - 1) return `Day total\n${usd(d.dayCostUsd)}`;
      const item = ordered[index - 1]!;
      return `${item.label}\n${signed(item.change)}`;
    } },
    xAxis: { ...axisCommon(theme), type: "category", data: labels, axisLabel: { color: theme.axis, fontSize: 10, interval: 0, rotate: labels.length > 6 ? 30 : 0 }, splitLine: { show: false } },
    yAxis: { ...axisCommon(theme), type: "value", axisLabel: { color: theme.axis, fontSize: 10, formatter: (value: number) => formatUsdAxis(value) } },
    series: [
      bar("Base", base, "transparent", { silent: true, tooltip: { show: false } }),
      bar("Increase", up, colorAt(5)), bar("Decrease", down, colorAt(0)), bar("Totals", total, colorAt(1)),
    ],
  };
}
