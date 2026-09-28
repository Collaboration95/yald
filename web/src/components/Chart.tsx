import { lazy, Suspense } from "react";
import type { EChartsCoreOption } from "echarts/core";

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
  return (
    <Suspense fallback={<div className={`w-full ${props.className ?? ""}`} style={{ height }} aria-hidden="true" />}>
      <ChartRenderer {...props} />
    </Suspense>
  );
}
