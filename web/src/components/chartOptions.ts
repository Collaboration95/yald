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

export function legendCommon(theme: ThemeTokens, show = true) {
  return {
    show,
    top: 0,
    right: 4,
    itemWidth: 8,
    itemHeight: 8,
    icon: "roundRect",
    textStyle: { color: theme.axis, fontSize: 11 },
  };
}

export function stackedAreaChart(
  theme: ThemeTokens,
  labels: string[],
  series: SeriesLike[],
  options: { formatter?: (value: number) => string; showLegend?: boolean; smooth?: number } = {},
): ChartOption {
  const formatter = options.formatter ?? ((value: number) => String(value));
  return {
    grid: baseGrid({ top: options.showLegend === false ? 16 : 30 }),
    tooltip: { ...tooltipCommon(theme), valueFormatter: (value: unknown) => formatter(Number(value)) },
    legend: legendCommon(theme, options.showLegend !== false),
    xAxis: { type: "category", boundaryGap: false, data: labels, ...axisCommon(theme) },
    yAxis: { type: "value", ...axisCommon(theme), axisLabel: { color: theme.axis, fontSize: 11, formatter: (value: number) => formatter(value) } },
    series: series.map((entry, index) => ({
      name: entry.name,
      type: "line",
      stack: "total",
      smooth: options.smooth ?? 0.2,
      symbol: "none",
      lineStyle: { width: 1.4, color: colorAt(index) },
      itemStyle: { color: colorAt(index) },
      areaStyle: { opacity: 0.72, color: colorAt(index) },
      emphasis: { focus: "series" },
      data: entry.data,
    })),
  };
}

export function stackedBarChart(
  theme: ThemeTokens,
  labels: string[],
  series: SeriesLike[],
  options: { formatter?: (value: number) => string; showLegend?: boolean; horizontal?: boolean } = {},
): ChartOption {
  const formatter = options.formatter ?? ((value: number) => String(value));
  const categoryAxis = { type: "category" as const, data: labels, ...axisCommon(theme) };
  const valueAxis = { type: "value" as const, ...axisCommon(theme) };
  return {
    grid: baseGrid({ top: options.showLegend === false ? 16 : 30 }),
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
  series: (SeriesLike & { dashed?: boolean; area?: boolean })[],
  options: { formatter?: (value: number) => string; showLegend?: boolean } = {},
): ChartOption {
  const formatter = options.formatter ?? ((value: number) => String(value));
  return {
    grid: baseGrid({ top: options.showLegend === false ? 16 : 30 }),
    tooltip: { ...tooltipCommon(theme), valueFormatter: (value: unknown) => formatter(Number(value)) },
    legend: legendCommon(theme, options.showLegend !== false),
    xAxis: { type: "category", boundaryGap: false, data: labels, ...axisCommon(theme) },
    yAxis: { type: "value", ...axisCommon(theme), axisLabel: { color: theme.axis, fontSize: 11, formatter: (value: number) => formatter(value) } },
    series: series.map((entry, index) => ({
      name: entry.name,
      type: "line",
      smooth: 0.2,
      symbol: "none",
      lineStyle: { width: 2, color: colorAt(index), type: entry.dashed ? "dashed" : "solid" },
      itemStyle: { color: colorAt(index) },
      areaStyle: entry.area ? { opacity: 0.14, color: colorAt(index) } : undefined,
      connectNulls: true,
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
  values: number[],
  options: {
    horizontal?: boolean;
    formatter?: (value: number) => string;
    color?: string | ((index: number) => string);
    showAxis?: boolean;
    showLabels?: boolean;
  } = {},
): ChartOption {
  const formatter = options.formatter ?? ((value: number) => String(value));
  const categoryAxis = { type: "category" as const, data: labels, ...axisCommon(theme), splitLine: { show: false } };
  const valueAxis = { type: "value" as const, ...axisCommon(theme), axisLabel: { show: options.showAxis !== false, color: theme.axis, fontSize: 11, formatter: (value: number) => formatter(value) } };
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

export function heatmapChart(
  theme: ThemeTokens,
  cells: { weekday: number; hour: number; value: number; requests: number }[],
  max: number,
  options: { formatter?: (value: number) => string } = {},
): ChartOption {
  const formatter = options.formatter ?? ((value: number) => String(value));
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
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
        return `${weekdays[cell.weekday]} ${hours[cell.hour]}:00<br/><b>${formatter(cell.value)}</b><br/>${cell.requests.toLocaleString()} requests`;
      },
    },
    xAxis: { type: "category", data: hours, axisLine: axis.axisLine, axisTick: axis.axisTick, axisLabel: { color: theme.axis, fontSize: 10, interval: 1 }, splitLine: { show: false } },
    yAxis: { type: "category", data: weekdays, axisLine: axis.axisLine, axisTick: axis.axisTick, axisLabel: { color: theme.axis, fontSize: 10 }, splitLine: { show: false } },
    visualMap: {
      show: false,
      min: 0,
      max: max || 1,
      inRange: { color: dark ? ["#132033", "#1d4ed8", "#22c55e", "#fbbf24"] : ["#eef1f5", "#bfdbfe", "#4ade80", "#facc15"] },
    },
    series: [{
      type: "heatmap",
      data: cells.map(cell => [cell.hour, cell.weekday, cell.value]),
      itemStyle: { borderColor: "transparent", borderWidth: 2, borderRadius: 3 },
      emphasis: { itemStyle: { borderColor: theme.text, borderWidth: 1 } },
    }],
  };
}

export function scatterChart(
  theme: ThemeTokens,
  series: { name: string; points: [number, number, number?][]; color?: string }[],
  options: { xFormatter?: (value: number) => string; yFormatter?: (value: number) => string; xName?: string; yName?: string; scaleSize?: number } = {},
): ChartOption {
  const xFormatter = options.xFormatter ?? ((value: number) => String(value));
  const yFormatter = options.yFormatter ?? ((value: number) => String(value));
  const divisor = options.scaleSize ?? 12;
  return {
    grid: baseGrid({ top: 34, right: 24, bottom: 26 }),
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
    xAxis: { type: "value", ...axisCommon(theme), name: options.xName, nameTextStyle: { color: theme.axis, fontSize: 11 }, axisLabel: { color: theme.axis, fontSize: 11, formatter: (value: number) => xFormatter(value) } },
    yAxis: { type: "value", ...axisCommon(theme), name: options.yName, nameTextStyle: { color: theme.axis, fontSize: 11 }, axisLabel: { color: theme.axis, fontSize: 11, formatter: (value: number) => yFormatter(value) } },
    series: series.map((entry, index) => ({
      name: entry.name,
      type: "scatter",
      symbolSize: (data: number[]) => Math.max(8, Math.min(40, Math.sqrt(data[2] ?? 1) / divisor)),
      itemStyle: { color: entry.color ?? colorAt(index), opacity: 0.7 },
      data: entry.points,
    })),
  };
}
