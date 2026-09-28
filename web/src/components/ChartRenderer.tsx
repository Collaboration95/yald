import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { clsx } from "clsx";
import { useTheme } from "../lib/theme";
import type { ChartProps } from "./Chart";

echarts.use([BarChart, HeatmapChart, LineChart, PieChart, ScatterChart, GridComponent, LegendComponent, TitleComponent, TooltipComponent, VisualMapComponent, CanvasRenderer]);

export function ChartRenderer({ option, height = 260, className, onEvents, loading }: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const { theme } = useTheme();

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [theme]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [option, theme]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onEvents) return;
    for (const [event, handler] of Object.entries(onEvents)) chart.on(event, handler);
    return () => {
      for (const [event, handler] of Object.entries(onEvents)) chart.off(event, handler);
    };
  }, [onEvents, theme]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (loading) chart.showLoading("default", { text: "", color: "#16a34a", maskColor: "transparent" });
    else chart.hideLoading();
  }, [loading]);

  return <div ref={containerRef} className={clsx("w-full", className)} style={{ height }} />;
}
