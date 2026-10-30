import type { ChartOption } from "../../components/Chart";
import { lineChart, type ThemeTokens } from "../../components/chartOptions";
import { formatCompact } from "../../lib/format";
import type { ContextCompaction, ContextEvidence, ContextSession } from "../../types";

/** Preserve the server's complete selector and fixed scope; only identify the investigation. */
export function contextEvidenceHref(evidence: ContextEvidence): string {
  const [path, search = ""] = evidence.href.split("?");
  const params = new URLSearchParams(search);
  params.set("investigation", "context-replay");
  return `${path}?${params}`;
}

type ChartEvent = ContextCompaction["events"][number];

/**
 * Presentation only: submitted input per request, in time order. Requests without measured input
 * leave a gap, not a zero. Each recorded event takes a blank slot between the two requests it fell
 * between, so its dashed line sits on that boundary and is never drawn without a recorded event.
 */
export function contextTimelineOption(theme: ThemeTokens, session: Pick<ContextSession, "requests">, tz: string, events: readonly ChartEvent[] = []): ChartOption {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const labels: string[] = [];
  const values: (number | null)[] = [];
  const slots: { index: number; event: ChartEvent }[] = [];
  const pending = [...events].sort((a, b) => a.ts - b.ts);
  const place = (before: number) => {
    while (pending.length && pending[0]!.ts <= before) {
      const event = pending.shift()!;
      slots.push({ index: labels.length, event });
      labels.push(day.format(event.ts));
      values.push(null);
    }
  };
  for (const row of session.requests) {
    place(row.ts - 1);
    labels.push(day.format(row.ts));
    values.push(row.eligible ? row.inputTokens : null);
  }
  place(Number.POSITIVE_INFINITY);
  // The formatter takes only the value: chart axes also pass an index as a second argument.
  const option = lineChart(theme, labels, [{ name: "Input per request", data: values, area: true }], { formatter: value => formatCompact(value), preserveGaps: true, showLegend: false }) as { series: Record<string, unknown>[] };
  if (!slots.length) return option;
  return { ...option, series: option.series.map(series => ({ ...series, markLine: {
    symbol: "none", silent: true, animation: false, lineStyle: { type: "dashed", color: theme.axis, width: 1 },
    label: { position: "end", color: theme.text, fontSize: 10, formatter: (params: { dataIndex: number }) => slots[params.dataIndex]?.event.trigger ?? "compaction" },
    data: slots.map(slot => ({ xAxis: slot.index })),
  } })) };
}
