import { useEffect, useMemo, useRef, useState } from "react";
import { sourceLabel } from "../api";
import { useTheme } from "../lib/theme";
import { Card, CardHeader, InfoTip, StateBlock } from "../components/ui";
import { Chart } from "../components/Chart";
import { pairedBarChart } from "../components/chartOptions";
import { colorAt } from "../lib/palette";
import { formatInteger, formatPercent, formatUsd } from "../lib/format";
import type { SpendStructureResponse } from "../types";

/** True once the element has come within `margin` of the viewport (and stays true); false without IntersectionObserver. */
export function useInView<T extends Element>(margin = "800px"): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setSeen(true);
        observer.disconnect();
      }
    }, { rootMargin: margin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [margin, seen]);
  return [ref, seen];
}

interface Section {
  data: SpendStructureResponse | undefined;
  loading: boolean;
  error: unknown;
}

const CLASS_NAMES = { freshInput: "Fresh input", cacheRead: "Cache read", cacheWrite: "Cache write", output: "Output" } as const;
const CLASS_KEYS = ["freshInput", "cacheRead", "cacheWrite", "output"] as const;

/** One tokens-versus-cost pair per source: which token class holds the volume and which holds the dollars. */
export function TokenClassCard({ data, loading, error }: Section) {
  const { chartTheme } = useTheme();
  const sources = data?.classMix ?? [];
  const charts = useMemo(() => sources.map(source => ({
    source,
    option: pairedBarChart(chartTheme, CLASS_KEYS.map(key => CLASS_NAMES[key]), [
      { name: "Share of tokens", data: CLASS_KEYS.map(key => source.tokenShare[key]), color: colorAt(9) },
      { name: "Share of cost", data: CLASS_KEYS.map(key => source.costShare[key]), color: colorAt(1) },
    ], { formatter: value => formatPercent(value, 0) }),
  })), [sources, chartTheme]);
  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-1.5">Where the tokens and dollars go
          <InfoTip label="About this chart">Each class's share of tokens beside its share of cost, for requests that have a list price. Reasoning is inside output. Dollars are API list-price equivalents, not a bill.</InfoTip></span>}
      />
      <StateBlock loading={loading} error={error} empty={!data || sources.length === 0} emptyLabel="Nothing priced in this window">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {charts.map(({ source, option }) => (
            <div key={source.source}>
              <p className="text-[11.5px] font-medium text-ink-soft">
                {sourceLabel(source.source)} <span className="font-normal text-muted">· {formatUsd(source.totalCost)} across {formatInteger(source.pricedRequests)} requests</span>
              </p>
              <Chart option={option} height={190} />
            </div>
          ))}
        </div>
      </StateBlock>
    </Card>
  );
}
