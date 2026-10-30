import type { ChartOption } from "./Chart";
import { colorAt } from "../lib/palette";

export interface ThemeTokens {
  text: string;
  axis: string;
  split: string;
  tooltipBg: string;
  tooltipBorder: string;
  area: string;
}

export interface SeriesLike {
  name: string;
  data: (number | null)[];
}

export function baseGrid(overrides: Record<string, unknown> = {}) {
  return { left: 8, right: 14, top: 28, bottom: 4, containLabel: true, ...overrides };
}

export function axisCommon(theme: ThemeTokens) {
  return {
    axisLine: { lineStyle: { color: theme.split } },
    axisTick: { show: false },
    axisLabel: { color: theme.axis, fontSize: 11 },
    splitLine: { lineStyle: { color: theme.split, type: "dashed" as const } },
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Axis text for a bucket label: "2026-09-23" reads "Sep 23". Anything else is left alone; tooltips keep the full label. */
export function shortAxisLabel(label: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(label);
  if (!match) return label;
  const day = `${MONTHS[Number(match[2]) - 1] ?? match[2]} ${Number(match[3])}`;
  return match[4] ? `${day} ${match[4]}` : day;
}

const dateAxisLabel = (theme: ThemeTokens) => ({ ...axisCommon(theme).axisLabel, formatter: shortAxisLabel });

export function tooltipCommon(theme: ThemeTokens) {
  return {
    trigger: "axis" as const,
    backgroundColor: theme.tooltipBg,
    borderColor: theme.tooltipBorder,
    borderWidth: 1,
    padding: [8, 10] as [number, number],
    textStyle: { color: theme.text, fontSize: 12 },
    extraCssText: "border-radius:10px;box-shadow:0 12px 32px -16px rgba(0,0,0,.35);",
    axisPointer: { type: "line" as const, lineStyle: { color: theme.axis, type: "dashed" as const } },
  };
}

/** Space the grid keeps for the legend; the legend sits below the plot so it can never cover an axis label. */
export const LEGEND_SPACE = 30;

export function legendCommon(theme: ThemeTokens, show = true) {
  return {
    show,
    // One scrolling row at the bottom: a long legend pages instead of wrapping onto the plot.
    type: "scroll" as const,
    bottom: 0,
    left: "center",
    width: "92%",
    itemWidth: 8,
    itemHeight: 8,
    icon: "roundRect",
    pageIconSize: 10,
    textStyle: { color: theme.axis, fontSize: 11 },
  };
}

export function stackedAreaChart(
  theme: ThemeTokens,
  labels: string[],
  series: SeriesLike[],
  options: { formatter?: (value: number) => string; showLegend?: boolean; smooth?: number; colors?: Record<string, string>; max?: number } = {},
): ChartOption {
  const formatter = options.formatter ?? ((value: number) => String(value));
  const colorOf = (name: string, index: number) => options.colors?.[name] ?? colorAt(index);
  return {
    grid: baseGrid({ top: 16, bottom: options.showLegend === false ? 4 : LEGEND_SPACE }),
    tooltip: { ...tooltipCommon(theme), valueFormatter: (value: unknown) => formatter(Number(value)) },
    legend: legendCommon(theme, options.showLegend !== false),
    xAxis: { type: "category", boundaryGap: false, data: labels, ...axisCommon(theme), axisLabel: dateAxisLabel(theme) },
    yAxis: { type: "value", ...(options.max !== undefined ? { max: options.max } : {}), ...axisCommon(theme), axisLabel: { color: theme.axis, fontSize: 11, formatter: (value: number) => formatter(value) } },
    series: series.map((entry, index) => ({
      name: entry.name,
      type: "line",
      stack: "total",
      smooth: options.smooth ?? 0.2,
      symbol: "none",
      lineStyle: { width: 1.4, color: colorOf(entry.name, index) },
      itemStyle: { color: colorOf(entry.name, index) },
      areaStyle: { opacity: 0.72, color: colorOf(entry.name, index) },
      emphasis: { focus: "series" },
      data: entry.data,
    })),
  };
}

export function stackedBarChart(
  theme: ThemeTokens,
  labels: string[],
  series: SeriesLike[],
  options: { formatter?: (value: number) => string; showLegend?: boolean; horizontal?: boolean; max?: number } = {},
): ChartOption {
  const formatter = options.formatter ?? ((value: number) => String(value));
  const categoryAxis = { type: "category" as const, data: labels, ...axisCommon(theme), axisLabel: dateAxisLabel(theme) };
  const valueAxis = { type: "value" as const, ...(options.max !== undefined ? { max: options.max } : {}), ...axisCommon(theme) };
  return {
    grid: baseGrid({ top: 16, bottom: options.showLegend === false ? 4 : LEGEND_SPACE }),
    tooltip: { ...tooltipCommon(theme), valueFormatter: (value: unknown) => formatter(Number(value)) },
    legend: legendCommon(theme, options.showLegend !== false),
    xAxis: options.horizontal ? valueAxis : categoryAxis,
    yAxis: options.horizontal ? categoryAxis : valueAxis,
    series: series.map((entry, index) => ({
      name: entry.name,
      type: "bar",
      stack: "total",
      barMaxWidth: 24,
      itemStyle: { color: colorAt(index), borderRadius: options.horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0] },
      emphasis: { focus: "series" },
      data: entry.data,
    })),
  };
}

export function lineChart(
  theme: ThemeTokens,
  labels: string[],
  series: (SeriesLike & { dashed?: boolean; area?: boolean; color?: string })[],
  options: {
    formatter?: (value: number) => string;
    showLegend?: boolean;
    /** Opt in to disconnected nulls and unavailable tooltips; legacy defaults stay intact. */
    preserveGaps?: boolean;
    /** Counts: no ticks between whole numbers, so a formatted axis never repeats a label. */
    wholeNumbers?: boolean;
  } = {},
): ChartOption {
  const formatter = options.formatter ?? ((value: number) => String(value));
  return {
    grid: baseGrid({ top: 16, bottom: options.showLegend === false ? 4 : LEGEND_SPACE }),
    tooltip: { ...tooltipCommon(theme), valueFormatter: (value: unknown) => options.preserveGaps && (typeof value !== "number" || !Number.isFinite(value))
      ? "Unavailable" : formatter(Number(value)) },
    legend: legendCommon(theme, options.showLegend !== false),
    xAxis: { type: "category", boundaryGap: false, data: labels, ...axisCommon(theme), axisLabel: dateAxisLabel(theme) },
    yAxis: { type: "value", ...(options.wholeNumbers ? { minInterval: 1 } : {}), ...axisCommon(theme), axisLabel: { color: theme.axis, fontSize: 11, formatter: (value: number) => formatter(value) } },
    series: series.map((entry, index) => ({
      name: entry.name,
      type: "line",
      smooth: 0.2,
      symbol: "none",
      lineStyle: { width: 2, color: entry.color ?? colorAt(index), type: entry.dashed ? "dashed" : "solid" },
      itemStyle: { color: entry.color ?? colorAt(index) },
      areaStyle: entry.area ? { opacity: 0.14, color: entry.color ?? colorAt(index) } : undefined,
      connectNulls: !options.preserveGaps,
      data: entry.data,
    })),
  };
}

export function donutChart(
  theme: ThemeTokens,
  data: { name: string; value: number }[],
  options: { formatter?: (value: number) => string; colors?: Record<string, string>; centerLabel?: string; centerValue?: string } = {},
): ChartOption {
  const formatter = options.formatter ?? ((value: number) => String(value));
  const total = data.reduce((sum, entry) => sum + entry.value, 0) || 1;
  return {
    tooltip: {
      trigger: "item",
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text, fontSize: 12 },
      formatter: (params: { name: string; value: number }) => `${params.name}<br/><b>${formatter(params.value)}</b> · ${((params.value / total) * 100).toFixed(1)}%`,
    },
    legend: { show: false },
    graphic: options.centerValue
      ? [
          { type: "text", left: "center", top: "43%", style: { text: options.centerValue, fontSize: 20, fontWeight: 700, fill: theme.text, textAlign: "center" } },
          { type: "text", left: "center", top: "58%", style: { text: options.centerLabel ?? "", fontSize: 11, fill: theme.axis, textAlign: "center" } },
        ]
      : undefined,
    series: [{
      type: "pie",
      radius: ["62%", "88%"],
      center: ["50%", "52%"],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: "transparent", borderWidth: 2, borderRadius: 4 },
      label: { show: false },
      labelLine: { show: false },
      emphasis: { scale: false },
      data: data.map((entry, index) => ({
        ...entry,
        itemStyle: { color: options.colors?.[entry.name] ?? colorAt(index) },
      })),
    }],
  };
}

export function barChart(
  theme: ThemeTokens,
  labels: string[],
  /** A null is a gap: no bar and no label, never a zero. */
  values: (number | null)[],
  options: {
    horizontal?: boolean;
    formatter?: (value: number) => string;
    color?: string | ((index: number) => string);
    showAxis?: boolean;
    showLabels?: boolean;
    /** Counts: no ticks between whole numbers, so a formatted axis never repeats a label. */
    wholeNumbers?: boolean;
  } = {},
): ChartOption {
  const formatter = options.formatter ?? ((value: number) => String(value));
  const categoryAxis = { type: "category" as const, data: labels, ...axisCommon(theme), splitLine: { show: false } };
  const valueAxis = { type: "value" as const, ...(options.wholeNumbers ? { minInterval: 1 } : {}), ...axisCommon(theme), axisLabel: { show: options.showAxis !== false, color: theme.axis, fontSize: 11, formatter: (value: number) => formatter(value) } };
  return {
    grid: baseGrid({ top: 12, bottom: 4 }),
    tooltip: { ...tooltipCommon(theme), valueFormatter: (value: unknown) => formatter(Number(value)) },
    xAxis: options.horizontal ? valueAxis : categoryAxis,
    yAxis: options.horizontal ? categoryAxis : valueAxis,
    series: [{
      type: "bar",
      barMaxWidth: 20,
      itemStyle: {
        borderRadius: options.horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
        color: (params: { dataIndex: number }) => typeof options.color === "function" ? options.color(params.dataIndex) : (options.color ?? colorAt(params.dataIndex)),
      },
      label: {
        show: Boolean(options.showLabels),
        position: options.horizontal ? "right" : "top",
        formatter: (params: { value: number }) => formatter(params.value),
        color: theme.axis,
        fontSize: 10,
      },
      data: values,
    }],
  };
}

export interface HeatmapOptions {
  formatter?: (value: number) => string;
  unit?: string;
  minimum?: number;
  /**
   * Column and row labels. Without them the grid is weekday rows by hour columns, and a cell's
   * `weekday` and `hour` are its row and column index; with them those fields index the labels.
   */
  columns?: string[];
  rows?: string[];
  /** Tooltip body for a labelled grid; the default describes weekday, hour, value and requests. */
  describe?: (cell: { weekday: number; hour: number; value: number; requests: number }, column: string, row: string) => string;
  /** Print this text inside each cell (labelled grids only). */
  cellLabel?: (value: number, requests: number) => string;
}

export function heatmapChart(
  theme: ThemeTokens,
  cells: { weekday: number; hour: number; value: number; requests: number }[],
  max: number,
  options: HeatmapOptions = {},
): ChartOption {
  const formatter = options.formatter ?? ((value: number) => String(value));
  const weekdays = options.rows ?? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = options.columns ?? Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
  const axis = axisCommon(theme);
  const dark = theme.split === "#1e293b";
  return {
    grid: { left: 6, right: 6, top: 10, bottom: 22, containLabel: true },
    tooltip: {
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text, fontSize: 12 },
      formatter: (params: { dataIndex: number }) => {
        const cell = cells[params.dataIndex];
        if (!cell) return "";
        if (options.describe) return options.describe(cell, hours[cell.hour] ?? "", weekdays[cell.weekday] ?? "");
        return `${weekdays[cell.weekday]} ${hours[cell.hour]}:00<br/><b>${formatter(cell.value)} ${options.unit ?? ""}</b><br/>${cell.requests.toLocaleString()} requests`;
      },
    },
    xAxis: { type: "category", data: hours, axisLine: axis.axisLine, axisTick: axis.axisTick, axisLabel: { color: theme.axis, fontSize: 10, interval: options.columns ? 0 : 1 }, splitLine: { show: false } },
    yAxis: { type: "category", data: weekdays, inverse: Boolean(options.rows), axisLine: axis.axisLine, axisTick: axis.axisTick, axisLabel: { color: theme.axis, fontSize: 10 }, splitLine: { show: false } },
    visualMap: {
      show: false,
      min: 0,
      max: max || 1,
      inRange: { color: dark ? ["#132033", "#1d4ed8", "#22c55e", "#fbbf24"] : ["#eef1f5", "#bfdbfe", "#4ade80", "#facc15"] },
    },
    series: [{
      type: "heatmap",
      data: cells.map(cell => ({
        value: [cell.hour, cell.weekday, cell.value],
        ...(options.minimum !== undefined && cell.value < options.minimum ? { itemStyle: { opacity: 0.2 } } : {}),
      })),
      itemStyle: { borderColor: "transparent", borderWidth: 2, borderRadius: 3 },
      ...(options.cellLabel ? { label: { show: true, color: theme.text, fontSize: 10, formatter: (params: { dataIndex: number }) => {
        const cell = cells[params.dataIndex];
        return cell ? options.cellLabel!(cell.value, cell.requests) : "";
      } } } : {}),
      emphasis: { itemStyle: { borderColor: theme.text, borderWidth: 1 } },
    }],
  };
}

/**
 * Pareto curve of spend over sessions: x is the cumulative share of sessions (log axis, so the top 1%
 * is readable), y the cumulative share of cost. `marks` are labelled points on the curve (for
 * example the top 1% and top 5%); the dashed line is an even spread. No in-chart legend.
 */
export function paretoChart(
  theme: ThemeTokens,
  curve: { x: number; y: number }[],
  marks: { label: string; x: number; y: number }[],
  options: { color?: string } = {},
): ChartOption {
  const percent = (value: number) => `${value >= 0.1 ? Math.round(value * 100) : +(value * 100).toPrecision(2)}%`;
  const color = options.color ?? colorAt(1);
  const floor = Math.min(...curve.map(point => point.x), 1);
  const axis = axisCommon(theme);
  return {
    grid: baseGrid({ top: 14, right: 28, bottom: 4 }),
    tooltip: {
      trigger: "item",
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text, fontSize: 12 },
      formatter: (params: { seriesName?: string; value?: number[] }) => {
        const [x, y] = params.value ?? [0, 0];
        return params.seriesName === "Even spread" ? "Even spread: every session costs the same" : `${params.seriesName ?? ""}<br/>top ${percent(x!)} of sessions hold <b>${percent(y!)}</b> of cost`;
      },
    },
    xAxis: { type: "log", min: floor, max: 1, ...axis, axisLabel: { color: theme.axis, fontSize: 11, formatter: percent } },
    yAxis: { type: "value", min: 0, max: 1, ...axis, axisLabel: { color: theme.axis, fontSize: 11, formatter: percent } },
    series: [
      { name: "Even spread", type: "line", symbol: "none", lineStyle: { width: 1, color: theme.axis, type: "dashed" }, silent: true, data: [[floor, floor], [1, 1]] },
      { name: "Cumulative cost share", type: "line", symbol: "none", lineStyle: { width: 2.2, color }, itemStyle: { color }, areaStyle: { opacity: 0.1, color }, data: curve.map(point => [point.x, point.y]) },
      {
        name: "Marked", type: "scatter", symbolSize: 9, itemStyle: { color }, z: 5,
        label: { show: true, position: "right", color: theme.text, fontSize: 11, formatter: (params: { dataIndex: number }) => marks[params.dataIndex]?.label ?? "" },
        data: marks.map(mark => [mark.x, mark.y]),
      },
    ],
  };
}

/** Horizontal bars grouped by category, one bar per series (for example share of tokens beside share of cost). */
export function pairedBarChart(
  theme: ThemeTokens,
  labels: string[],
  series: { name: string; data: (number | null)[]; color?: string }[],
  options: { formatter?: (value: number) => string } = {},
): ChartOption {
  const formatter = options.formatter ?? ((value: number) => String(value));
  return {
    grid: baseGrid({ top: 12, right: 36, bottom: LEGEND_SPACE }),
    tooltip: { ...tooltipCommon(theme), axisPointer: { type: "shadow" }, valueFormatter: (value: unknown) => (typeof value === "number" ? formatter(value) : "Unavailable") },
    legend: legendCommon(theme),
    xAxis: { type: "value", ...axisCommon(theme), axisLabel: { color: theme.axis, fontSize: 11, formatter: (value: number) => formatter(value) } },
    yAxis: { type: "category", inverse: true, data: labels, ...axisCommon(theme), splitLine: { show: false } },
    series: series.map((entry, index) => ({
      name: entry.name,
      type: "bar",
      barMaxWidth: 12,
      itemStyle: { color: entry.color ?? colorAt(index), borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: "right", color: theme.axis, fontSize: 10, formatter: (params: { value: number }) => formatter(params.value) },
      data: entry.data,
    })),
  };
}

export interface BoxRow {
  label: string;
  /** p10, p25, p50, p75, p90; a row without one is left out of the chart. */
  box: [number, number, number, number, number] | null;
  p99: number | null;
  max: number | null;
  n: number;
}

/**
 * Horizontal box plot on a log value axis: the box is p25-p75 with a line at p50, the whiskers are
 * p10 and p90, and p99 and the maximum are drawn as markers. Statistics come from the server;
 * the browser never sees the individual points. No in-chart legend (the caller explains the marks).
 */
export function boxplotChart(
  theme: ThemeTokens,
  rows: BoxRow[],
  options: { formatter?: (value: number) => string; color?: string } = {},
): ChartOption {
  const formatter = options.formatter ?? ((value: number) => String(value));
  const shown = rows.filter(row => row.box !== null);
  const at = (value: number) => Math.max(1, value); // a log axis cannot hold 0
  const markers = (pick: (row: BoxRow) => number | null) => shown.flatMap((row, index) => {
    const value = pick(row);
    return value === null ? [] : [[at(value), index]];
  });
  const color = options.color ?? colorAt(1);
  const axis = axisCommon(theme);
  return {
    grid: baseGrid({ top: 12, bottom: 4, right: 20 }),
    tooltip: {
      trigger: "item",
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text, fontSize: 12 },
      formatter: (params: { dataIndex?: number; seriesType?: string; value?: unknown }) => {
        const row = params.seriesType === "boxplot" ? shown[params.dataIndex ?? -1] : shown[Number((params.value as number[] | undefined)?.[1])];
        if (!row?.box) return "";
        const [p10, p25, p50, p75, p90] = row.box;
        return `<b>${row.label}</b><br/>${row.n.toLocaleString()} requests<br/>p10 ${formatter(p10)} · p25 ${formatter(p25)}<br/>p50 ${formatter(p50)}<br/>p75 ${formatter(p75)} · p90 ${formatter(p90)}<br/>p99 ${row.p99 === null ? "too few requests" : formatter(row.p99)} · max ${row.max === null ? "—" : formatter(row.max)}`;
      },
    },
    xAxis: { type: "log", min: 10 ** Math.floor(Math.log10(Math.min(...shown.map(row => at(row.box![0])), 1e6))), ...axis, axisLabel: { color: theme.axis, fontSize: 11, formatter: (value: number) => formatter(value) } },
    yAxis: { type: "category", inverse: true, data: shown.map(row => row.label), ...axis, splitLine: { show: false } },
    series: [
      {
        name: "p10-p90",
        type: "boxplot",
        boxWidth: [6, 16],
        itemStyle: { color: "transparent", borderColor: color, borderWidth: 1.6 },
        data: shown.map(row => (row.box as number[]).map(at)),
      },
      { name: "p99", type: "scatter", symbol: "diamond", symbolSize: 8, itemStyle: { color }, data: markers(row => row.p99), z: 5 },
      { name: "max", type: "scatter", symbol: "circle", symbolSize: 7, itemStyle: { color: "transparent", borderColor: color, borderWidth: 1.6 }, data: markers(row => row.max), z: 5 },
    ],
  };
}

export function scatterChart(
  theme: ThemeTokens,
  series: { name: string; points: [number, number, number?][]; color?: string }[],
  options: { xFormatter?: (value: number) => string; yFormatter?: (value: number) => string; xName?: string; yName?: string; scaleSize?: number; xLog?: boolean; yMax?: number } = {},
): ChartOption {
  const xFormatter = options.xFormatter ?? ((value: number) => String(value));
  const yFormatter = options.yFormatter ?? ((value: number) => String(value));
  const divisor = options.scaleSize ?? 12;
  return {
    grid: baseGrid({ top: 34, right: 24, bottom: 26 + (series.length > 1 ? LEGEND_SPACE : 0) }),
    tooltip: {
      trigger: "item",
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.text, fontSize: 12 },
      formatter: (params: { seriesName: string; value: [number, number, number?] }) => {
        const [x, y, size] = params.value;
        return `<b>${params.seriesName}</b><br/>${options.xName ?? "x"}: ${xFormatter(x)}<br/>${options.yName ?? "y"}: ${yFormatter(y)}${size ? `<br/>tokens: ${Math.round(size).toLocaleString()}` : ""}`;
      },
    },
    legend: series.length > 1 ? legendCommon(theme) : { show: false },
    xAxis: { type: options.xLog ? "log" : "value", ...axisCommon(theme), name: options.xName, nameTextStyle: { color: theme.axis, fontSize: 11 }, axisLabel: { color: theme.axis, fontSize: 11, formatter: (value: number) => xFormatter(value) } },
    yAxis: { type: "value", ...(options.yMax !== undefined ? { max: options.yMax } : {}), ...axisCommon(theme), name: options.yName, nameTextStyle: { color: theme.axis, fontSize: 11 }, axisLabel: { color: theme.axis, fontSize: 11, formatter: (value: number) => yFormatter(value) } },
    series: series.map((entry, index) => ({
      name: entry.name,
      type: "scatter",
      symbolSize: (data: number[]) => Math.max(8, Math.min(40, Math.sqrt(data[2] ?? 1) / divisor)),
      itemStyle: { color: entry.color ?? colorAt(index), opacity: 0.7 },
      data: entry.points,
    })),
  };
}

export interface TimelineBar { lane: number; start: number; end: number; label: string; color: string; tooltip: string }

/** Bars on a time axis, one lane per category. A bar never gets thinner than `minWidth`, so a one-minute burst stays visible in a long window. */
export function laneTimelineChart(theme: ThemeTokens, lanes: string[], bars: TimelineBar[], options: { minWidth?: number; zoom?: boolean } = {}): ChartOption {
  const minWidth = options.minWidth ?? 6;
  type Api = { value: (index: number) => number; coord: (point: [number, number]) => [number, number]; size: (point: [number, number]) => [number, number] };
  return {
    grid: baseGrid({ top: 12, bottom: options.zoom ? 40 : 8 }),
    tooltip: { ...tooltipCommon(theme), trigger: "item" as const, formatter: (params: { dataIndex: number }) => bars[params.dataIndex]?.tooltip ?? "" },
    xAxis: { type: "time" as const, ...axisCommon(theme), splitLine: { show: false } },
    yAxis: { type: "category" as const, data: lanes, ...axisCommon(theme), splitLine: { show: false } },
    ...(options.zoom ? { dataZoom: [{ type: "inside" as const }, { type: "slider" as const, height: 18, bottom: 6, showDetail: false, borderColor: theme.split }] } : {}),
    series: [{
      type: "custom",
      encode: { x: [1, 2], y: 0 },
      data: bars.map(bar => [bar.lane, bar.start, bar.end]),
      renderItem: (params: { dataIndex: number }, api: Api) => {
        const bar = bars[params.dataIndex]!;
        const [x, y] = api.coord([api.value(1), api.value(0)]);
        const [xEnd] = api.coord([api.value(2), api.value(0)]);
        const height = Math.min(18, api.size([0, 1])[1] * 0.6);
        const width = Math.max(minWidth, xEnd - x);
        return {
          type: "group",
          children: [
            { type: "rect", shape: { x, y: y - height / 2, width, height, r: 2 }, style: { fill: bar.color } },
            { type: "text", style: { x: x + width + 4, y, text: bar.label, fill: theme.text, fontSize: 10, verticalAlign: "middle" } },
          ],
        };
      },
    }],
  };
}
