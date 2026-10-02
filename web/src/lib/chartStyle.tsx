import { createContext, useContext } from "react";
import type { ChartOption } from "../components/Chart";

/** Chart presentation shared by the production Relay UI. */
export interface ChartStyle {
  color: (color: string) => string;
  colorFor: (label: string, color: string) => string;
  modelColor: (model: string) => string;
  heatmapGradient: string;
  chart: (option: ChartOption) => ChartOption;
}

export const ChartStyleContext = createContext<ChartStyle | null>(null);
export function useChartStyle() { return useContext(ChartStyleContext); }
