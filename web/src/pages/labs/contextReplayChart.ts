import type { ChartOption } from "../../components/Chart";
import { axisCommon, lineChart, type ThemeTokens } from "../../components/chartOptions";
import { formatCompact, formatInteger } from "../../lib/format";
import { colorAt } from "../../lib/palette";
import type { ContextEvidence, ContextObservation, ContextSession } from "../../types";

export const contextTokens = (value: number | null): string => value === null ? "Unavailable" : formatInteger(value);
export const contextCost = (row: ContextObservation): string => !row.priced || row.cost === null ? "Unavailable (unpriced)"
  : `$${row.cost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

export function contextTimestamp(ts: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23" }).format(ts);
}

/** Preserve the server's complete selector and fixed scope; only identify the investigation. */
export function contextEvidenceHref(evidence: ContextEvidence): string {
  const [path, search = ""] = evidence.href.split("?");
  const params = new URLSearchParams(search);
  params.set("investigation", "context-replay");
  return `${path}?${params}`;
}

/** Identity-based fallback for consumers outside RelayProvider, including SSR. */
export function contextModelColor(model: string): string {
  return colorAt([...model].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0));
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Presentation only: no growth calculation, sorting, token sums or price estimates. */
export function contextTimelineOption(theme: ThemeTokens, session: ContextSession, tz: string,
  modelColor: (model: string) => string = contextModelColor): ChartOption {
  const rows = session.requests;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23" });
  const labels = rows.map(row => `#${row.ordinal + 1}\n${time.format(row.ts)}`);
  // Attempt-summed cache counters may be present in details. They are not context points.
  const value = (row: ContextObservation, field: "inputTokens" | "cacheReadTokens" | "cacheWriteTokens") => row.eligible ? row[field] : null;
  const base = lineChart(theme, labels, [
    { name: "Submitted input", data: rows.map(row => value(row, "inputTokens")) },
    { name: "Cache read (within input)", data: rows.map(row => value(row, "cacheReadTokens")), dashed: true },
    { name: "Cache write (within input)", data: rows.map(row => value(row, "cacheWriteTokens")), dashed: true },
  ], { formatter: formatCompact, preserveGaps: true, showLegend: false });
  const models = [...new Set(rows.map(row => row.model))];
  return {
    ...base,
    grid: { left: 12, right: 24, top: 30, bottom: 62, containLabel: true },
    xAxis: { type: "category", data: labels, boundaryGap: true, ...axisCommon(theme),
      name: `Request index · time (${tz})`, nameLocation: "middle", nameGap: 43, nameTextStyle: { color: theme.axis, fontSize: 11 } },
    yAxis: { type: "value", min: 0, ...axisCommon(theme), name: "Input tokens", nameTextStyle: { color: theme.axis, fontSize: 11 },
      axisLabel: { color: theme.axis, fontSize: 11, formatter: formatCompact } },
    tooltip: {
      ...(base.tooltip as Record<string, unknown>),
      confine: true,
      formatter: (params: { dataIndex: number }[]) => {
        const row = rows[params[0]?.dataIndex];
        if (!row) return "";
        return `<b>Request #${row.ordinal + 1}</b> · ${escapeHtml(row.id)}<br/>${escapeHtml(contextTimestamp(row.ts, tz))}<br/>Model: ${escapeHtml(row.model)}<br/>`
          + `Submitted input: ${contextTokens(value(row, "inputTokens"))}<br/>Cache read: ${contextTokens(value(row, "cacheReadTokens"))}<br/>Cache write: ${contextTokens(value(row, "cacheWriteTokens"))}`
          + (row.eligible ? "" : `<br/>Excluded: ${escapeHtml(row.exclusionReason ?? "input accounting unavailable")}`);
      },
    },
    series: [
      ...(base.series as Record<string, unknown>[]).map(series => ({ ...series, smooth: 0, symbol: "circle", symbolSize: 4, showAllSymbol: true })),
      ...models.map(model => ({
        name: `Model · ${model}`, type: "scatter", symbol: "circle", symbolSize: 9,
        itemStyle: { color: modelColor(model), borderColor: theme.tooltipBg, borderWidth: 1 },
        data: rows.map(row => row.eligible && row.model === model ? row.inputTokens : null),
      })),
    ],
  };
}
