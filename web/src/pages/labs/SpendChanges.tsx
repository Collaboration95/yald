import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { filtersKey, useEndpoint } from "../../api";
import { Chart, type ChartOption } from "../../components/Chart";
import { axisCommon, baseGrid, LEGEND_SPACE, legendCommon, tooltipCommon, type ThemeTokens } from "../../components/chartOptions";
import { Card, CardHeader, Segmented } from "../../components/ui";
import { formatInteger, formatRatio, formatShortDate, formatUsd, formatUsdAxis, formatUsdDelta, shortPath } from "../../lib/format";
import { colorAt } from "../../lib/palette";
import { useTheme } from "../../lib/theme";
import type { SpendChangesResponse, SpendCut, SpendDay, SpendGroup } from "../../types";
import { InvestigationState } from "./InvestigationState";
import { TopList, Verdict, periodPhrase, useLabsFilters, type TopRow } from "./shared";

const CUTS: { id: SpendCut; label: string }[] = [
  { id: "model", label: "Model" }, { id: "project", label: "Project" }, { id: "session", label: "Session" }, { id: "tokenClass", label: "Token class" },
];
const STATE_TEXT: Record<SpendDay["state"], string> = {
  spike: "Unusual", normal: "Normal", insufficient: "Not enough history", partial: "Partial day", "no-priced": "No priced requests",
};

function whyNot(day: SpendDay): string {
  if (day.state === "partial") return day.partialReason === "in-progress" ? "The day is still in progress." : "The day is cut by the edge of the window.";
  if (day.state === "insufficient") return day.insufficientReason === "zero-baseline" ? "Typical spend was $0." : `Only ${day.baseline.activeDays} earlier days of history.`;
  return "";
}

/** Short names: the last two folders of a project, the model name without its source and provider, a session by its first characters. */
function shortLabel(cut: SpendCut, label: string): string {
  if (/^\(?unattributed/i.test(label)) return "Unattributed";
  if (cut === "project") return shortPath(label);
  if (cut === "model") return label.split(" · ").at(-1) ?? label;
  if (cut === "session") return `Session ${(label.split(" · ").at(-1) ?? label).slice(0, 6)}`;
  return label;
}

export function SpendChanges() {
  const filters = useLabsFilters();
  const [params, setParams] = useSearchParams();
  const day = params.get("day") ?? undefined;
  const query = useEndpoint<SpendChangesResponse>("/api/labs/spend", filters, day ? { day } : {}, { keepPrevious: false, persist: false });
  const pick = (next: string | null) => setParams(current => {
    const out = new URLSearchParams(current);
    if (next) out.set("day", next); else out.delete("day");
    return out;
  }, { replace: true });
  const biggest = query.data?.days.filter(entry => entry.state === "spike").sort((a, b) => (b.pricedCostUsd ?? 0) - (a.pricedCostUsd ?? 0))[0];
  // Open on the biggest unusual day, so the breakdown is already there.
  useEffect(() => { if (!day && biggest) pick(biggest.date); }, [day, biggest?.date]);
  if (query.error) return <InvestigationState kind="error" detail={query.error.message} onRetry={() => void query.refetch()} />;
  if (!query.data) return <InvestigationState kind="loading" />;
  return <SpendChangesResult key={filtersKey(filters)} data={query.data} onPick={pick} />;
}

/** One server snapshot: the rule, the days and the breakdown all come from the same response. */
export function SpendChangesResult({ data, onPick }: { data: SpendChangesResponse; onPick?: (day: string | null) => void }) {
  const { chartTheme } = useTheme();
  const [chosenCut, setChosenCut] = useState<SpendCut | null>(null);
  const { rule, coverage, selected } = data;
  const spikes = data.days.filter(day => day.state === "spike").sort((a, b) => (b.pricedCostUsd ?? 0) - (a.pricedCostUsd ?? 0));
  const top = spikes[0];
  const decomposition = selected?.decomposition ?? null;
  const empty = coverage.totalRequests === 0;

  // When most of the change sits in requests with no known project, a project breakdown says nothing: open on Model.
  const projectGroups = decomposition ? [...decomposition.cuts.project.groups, ...decomposition.cuts.project.new] : [];
  const totalChange = projectGroups.reduce((sum, group) => sum + Math.abs(group.changeUsd), 0);
  const unattributedDominates = projectGroups.some(group => /^\(?unattributed/i.test(group.label) && Math.abs(group.changeUsd) > totalChange / 2);
  const cutId = chosenCut ?? (unattributedDominates ? "model" : "project");
  const cut = decomposition?.cuts[cutId];

  const rows: TopRow[] = cut ? ([...cut.groups, ...cut.new] as SpendGroup[])
    .filter(group => group.changeUsd > 0)
    .sort((a, b) => b.changeUsd - a.changeUsd)
    .map(group => ({
      key: `${group.isNew ? "n" : "g"}${group.key}`, label: shortLabel(cutId, group.label), title: group.label,
      value: formatUsdDelta(group.changeUsd), amount: group.changeUsd, note: group.isNew ? "new" : undefined, href: group.evidence?.href,
    })) : [];

  const info = <>
    A day is unusual when its priced cost is over {rule.spikeMultiple}× the median of the {rule.baselineActiveDays} days before it. A day needs at least {rule.minBaselineActiveDays} earlier days of history, otherwise it is shown as "not enough history", never as normal. It is not a budget or an alarm.
    {" "}Dollars are API list-price equivalents for the {formatInteger(coverage.pricedRequests)} of {formatInteger(coverage.totalRequests)} requests that have a price, not a bill.
    {" "}The breakdown compares the day with the average of its baseline days, group by group. Window: {periodPhrase(data.window)} ({data.window.tz}).
  </>;

  return <div className="space-y-3" data-spend-changes>
    {empty ? <InvestigationState kind="empty" detail="No requests were recorded for this selection in the window." /> : <>
      <Verdict
        found={!!top}
        headline={top ? `${spikes.length} unusual ${spikes.length === 1 ? "day" : "days"} in ${periodPhrase(data.window)}` : "No unusually expensive days"}
        detail={top ? `Biggest: ${formatShortDate(top.date)}, ${formatUsd(top.pricedCostUsd)}${top.baseline.medianUsd ? ` against a typical ${formatUsd(top.baseline.medianUsd)}` : ""}.`
          : `${coverage.activeDays} days with priced requests; none was far above its usual spend${coverage.insufficientDays ? `, and ${coverage.insufficientDays} had too little history to judge` : ""}.`}
        big={top ? formatUsd(top.pricedCostUsd) : undefined}
        bigLabel={top?.baseline.ratio ? `${formatRatio(top.baseline.ratio)} a typical day` : undefined}
        info={info}
        action={selected?.evidence ? { href: selected.evidence.href, label: "See the requests" } : null}
      />

      <Card>
        <CardHeader title="Daily cost" subtitle={spikes.length ? "Click a bar to see what drove that day." : undefined} />
        <div role="img" aria-label="Daily priced cost with the typical level and spike threshold">
          <Chart option={spendDailyOption(data.days, chartTheme, selected?.day.date)} height={260}
            onEvents={onPick ? { click: (raw: unknown) => { const index = (raw as { dataIndex?: number }).dataIndex; const day = typeof index === "number" ? data.days[index] : undefined; if (day) onPick(day.date); } } : undefined} />
        </div>
        {spikes.length > 1 ? <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-muted" role="group" aria-label="Unusual days">
          <span>Biggest days:</span>
          {spikes.slice(0, 3).map(day => <button key={day.date} type="button" aria-pressed={selected?.day.date === day.date} onClick={() => onPick?.(day.date)}
            className="rounded-full border border-line px-2.5 py-1 text-ink aria-pressed:bg-surface-3">{formatShortDate(day.date)} · {formatUsd(day.pricedCostUsd)}</button>)}
        </div> : null}
      </Card>

      {selected && !decomposition ? <InvestigationState kind="insufficient" title={`${formatShortDate(selected.day.date)} can't be broken down`} detail={selected.limitations[0] ?? whyNot(selected.day)} /> : null}

      {selected && decomposition && cut ? <Card>
        <CardHeader
          title={`What drove ${formatShortDate(selected.day.date)}`}
          subtitle={`${formatUsd(decomposition.dayCostUsd)} against a typical ${formatUsd(decomposition.baselineMedianUsd)} (${formatUsdDelta(decomposition.dayCostUsd - decomposition.baselineMedianUsd)}).`}
          action={<Segmented size="sm" value={cutId} options={CUTS} onChange={setChosenCut} />}
        />
        {rows.length ? <TopList rows={rows} tone="bad" /> : <p className="text-[12px] text-muted">Nothing in this breakdown rose above its usual level.</p>}
      </Card> : null}
    </>}
  </div>;
}

/** Bars per local day with the median line and the threshold. Hollow = partial or not enough history. */
export function spendDailyOption(days: SpendDay[], theme: ThemeTokens, selectedDate?: string): ChartOption {
  const spike = colorAt(5);
  const base = colorAt(1);
  const hollow = (color: string) => ({ color: "transparent", borderColor: color, borderWidth: 1.5, borderType: "dashed" as const });
  return {
    animation: false,
    grid: baseGrid({ top: 16, bottom: LEGEND_SPACE }),
    legend: legendCommon(theme),
    tooltip: { ...tooltipCommon(theme), trigger: "axis", renderMode: "richText", formatter: (raw: unknown) => {
      const index = (raw as { dataIndex: number }[])[0]?.dataIndex ?? 0;
      const day = days[index]!;
      return [formatShortDate(day.date), `${day.pricedCostUsd === null ? "No priced cost" : formatUsd(day.pricedCostUsd)} · ${STATE_TEXT[day.state]}`,
        day.baseline.medianUsd === null ? "" : `Typical ${formatUsd(day.baseline.medianUsd)}${day.baseline.thresholdUsd === null ? "" : ` · unusual above ${formatUsd(day.baseline.thresholdUsd)}`}`,
        whyNot(day)].filter(Boolean).join("\n");
    } },
    xAxis: { ...axisCommon(theme), type: "category", data: days.map(day => formatShortDate(day.date)), splitLine: { show: false }, axisLabel: { color: theme.axis, fontSize: 10, hideOverlap: true } },
    yAxis: { ...axisCommon(theme), type: "value", min: 0, axisLabel: { color: theme.axis, fontSize: 10, formatter: (value: number) => formatUsdAxis(value) } },
    series: [
      { name: "Daily cost", type: "bar", barMaxWidth: 18, data: days.map(day => {
        if (day.pricedCostUsd === null) return null;
        const partial = day.state === "partial" || day.state === "insufficient";
        const color = day.state === "spike" ? spike : base;
        return { value: day.pricedCostUsd,
          itemStyle: partial ? hollow(base) : { color, borderRadius: [3, 3, 0, 0], ...(day.date === selectedDate ? { borderColor: theme.text, borderWidth: 2 } : {}) } };
      }) },
      { name: "Typical day", type: "line", showSymbol: false, connectNulls: false, lineStyle: { width: 1.5, color: theme.text }, itemStyle: { color: theme.text },
        data: days.map(day => day.baseline.medianUsd !== null && day.state !== "partial" ? day.baseline.medianUsd : null) },
      { name: "Unusual above", type: "line", showSymbol: false, connectNulls: false, lineStyle: { width: 1.5, type: "dashed", color: spike }, itemStyle: { color: spike },
        data: days.map(day => day.baseline.thresholdUsd) },
    ],
  };
}
