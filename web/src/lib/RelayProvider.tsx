import { useEffect, useMemo, type ReactNode } from "react";
import { useMeta } from "../api";
import { useTheme } from "./theme";
import { ChartStyleContext } from "./chartStyle";
import { makeRelayStyle } from "./relayStyle";

/** The most-used models get their own colour; a longer tail would only repeat colours on screen. */
const MODEL_COLOURS = 9;

/** One palette for canvas plots, HTML legends, and model tags across every page. */
export function RelayProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const meta = useMeta();
  const style = useMemo(() => makeRelayStyle(theme === "dark", meta.data?.modelsByUse?.slice(0, MODEL_COLOURS) ?? meta.data?.models), [theme, meta.data?.modelsByUse, meta.data?.models]);
  useEffect(() => {
    document.documentElement.style.setProperty("--heatmap-gradient", style.heatmapGradient);
    return () => { document.documentElement.style.removeProperty("--heatmap-gradient"); };
  }, [style]);
  return <ChartStyleContext.Provider value={style}>{children}</ChartStyleContext.Provider>;
}
