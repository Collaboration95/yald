import { lazy, Suspense, useMemo } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { useChartStyle } from "../lib/chartStyle";

export type ChartOption = EChartsCoreOption;

export interface ChartProps {
  option: ChartOption;
  height?: number | string;
  className?: string;
  onEvents?: Record<string, (params: unknown) => void>;
  loading?: boolean;
}

const ChartRenderer = lazy(() => import("./ChartRenderer").then(module => ({ default: module.ChartRenderer })));

export function Chart(props: ChartProps) {
  const height = props.height ?? 260;
  const design = useChartStyle();
  const option = useMemo(() => design ? design.chart(props.option) : props.option, [design, props.option]);
  return (
    <Suspense fallback={<div className={`w-full ${props.className ?? ""}`} style={{ height }} aria-hidden="true" />}>
      <ChartRenderer {...props} option={option} />
    </Suspense>
  );
}
