import { useEffect, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "../api";
import type { MetaResponse } from "../types";
import { useTheme } from "./theme";
import { ChartStyleContext } from "./chartStyle";
import { makeRelayStyle } from "./relayStyle";

/** One palette for canvas plots, HTML legends, and model tags across every page. */
export function RelayProvider({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const meta = useQuery<MetaResponse>({
    queryKey: ["/api/meta"],
    queryFn: () => fetchJson<MetaResponse>("/api/meta"),
    staleTime: 60_000,
  });
  const style = useMemo(() => makeRelayStyle(theme === "dark", meta.data?.models), [theme, meta.data?.models]);
  useEffect(() => {
    document.documentElement.style.setProperty("--heatmap-gradient", style.heatmapGradient);
    return () => { document.documentElement.style.removeProperty("--heatmap-gradient"); };
  }, [style]);
  return <ChartStyleContext.Provider value={style}>{children}</ChartStyleContext.Provider>;
}
