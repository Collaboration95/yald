import type { ChartOption } from "../components/Chart";
import type { ChartStyle } from "./chartStyle";
import { PALETTE } from "./palette";

export function makeRelayStyle(dark: boolean, modelNames: string[] = []): ChartStyle {
  const colors = dark
    ? ["#eee9e2", "#f09082", "#acd0be", "#d9bd76", "#a3b5d6", "#d995bc", "#88c4cc", "#bea5d1", "#e4b990", "#a8a8a4"]
    : ["#29292b", "#e7584d", "#8cae99", "#d4ae51", "#8399bd", "#bb779e", "#639fa7", "#a28ab5", "#c89b72", "#8f918d"];
  const mapping = new Map(PALETTE.map((value, index) => [value, colors[index]!]));
  mapping.set("#dc2626", colors[1]!);
  const color = (value: string) => mapping.get(value.toLowerCase()) ?? value;
  const preferredOrder = ["gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "deepseek-flash"];
  const rank = (name: string) => preferredOrder.includes(name) ? preferredOrder.indexOf(name) : 10;
  const modelMap = new Map([...modelNames].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((name, index) => [name, colors[index % colors.length]!]));
  const modelColor = (name: string) => modelMap.get(name) ?? colors[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length]!;
  const outcomes: Record<string, string> = { ok: colors[0]!, error: colors[1]!, cancelled: dark ? "#e0c087" : "#c49c45" };
  const colorFor = (label: string, fallback: string) => outcomes[label] ?? modelMap.get(label) ?? color(fallback);
  const heatmapColors = dark ? ["#302e2c", "#754c45", "#c17c6f", "#f09082"] : ["#f5efec", "#f6d4cb", "#eea99b", "#e7584d"];

  // Restyle presentation only: retain every data value, coordinate and formatter.
  function restyle(value: unknown, key = ""): unknown {
    if (key === "data") return value;
    if (typeof value === "string" && ["color", "fill", "stroke", "borderColor"].includes(key)) return color(value);
    if (typeof value === "function" && key === "color") return (...args: unknown[]) => color(value(...args) as string);
    if (Array.isArray(value)) return value.map(entry => restyle(entry, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, restyle(entry, name)]));
    return value;
  }

  return { color, colorFor, modelColor, heatmapGradient: `linear-gradient(90deg, ${heatmapColors.join(", ")})`, chart: original => {
    const option = restyle(original) as Record<string, any>;
    option.textStyle = { ...option.textStyle, fontFamily: "Manrope, sans-serif" };
    if (Array.isArray(option.graphic)) option.graphic = option.graphic.map((entry: Record<string, any>) => ({ ...entry, style: { ...entry.style, fontFamily: "Manrope, sans-serif" } }));
    if (option.legend) option.legend = { ...option.legend, icon: "circle", itemWidth: 7, itemHeight: 7, itemGap: 15 };
    for (const name of ["xAxis", "yAxis"]) {
      const axis = option[name];
      if (axis && !Array.isArray(axis)) {
        axis.axisLabel = { ...axis.axisLabel, hideOverlap: true };
        if (axis.type === "value" && !axis.axisLabel.formatter && option.tooltip?.valueFormatter) axis.axisLabel.formatter = option.tooltip.valueFormatter;
        if (axis.splitLine?.lineStyle) axis.splitLine.lineStyle.type = "solid";
      }
    }
    if (option.visualMap) option.visualMap.inRange = { color: heatmapColors };
    if (Array.isArray(option.series)) option.series = option.series.map((series: Record<string, any>) => {
      const namedColor = outcomes[series.name] ?? modelMap.get(series.name);
      if (namedColor) series = { ...series, itemStyle: { ...series.itemStyle, color: namedColor }, lineStyle: { ...series.lineStyle, color: namedColor }, areaStyle: series.areaStyle ? { ...series.areaStyle, color: namedColor } : undefined };
      if (series.type === "line") return { ...series, smooth: 0, lineStyle: { ...series.lineStyle, width: 2.4 }, areaStyle: series.areaStyle ? { ...series.areaStyle, opacity: series.stack ? 0.18 : 0.09 } : undefined, emphasis: { ...series.emphasis, scale: 1.4 } };
      if (series.type === "bar") {
        const categories = option.xAxis?.type === "category" ? option.xAxis.data : option.yAxis?.data;
        const modelBars = Array.isArray(categories) && categories.length > 0 && categories.every(name => modelMap.has(name));
        return { ...series, barMaxWidth: 28, itemStyle: modelBars ? { ...series.itemStyle, color: (params: { dataIndex: number }) => modelColor(categories[params.dataIndex]) } : series.itemStyle };
      }
      if (series.type === "pie") return { ...series, radius: ["68%", "88%"], itemStyle: { ...series.itemStyle, borderRadius: 2 }, data: series.data.map((entry: Record<string, any>) => ({ ...entry, itemStyle: { ...restyle(entry.itemStyle) as object, color: colorFor(entry.name, entry.itemStyle?.color ?? colors[0]!) } })) };
      return series;
    });
    return option as ChartOption;
  } };
}
