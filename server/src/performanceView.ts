import { percentileOfSorted, sortedSample } from "./analytics";
import { CONTEXT_MIN_N, CONTEXT_TOP_MODELS } from "./contextView";
import type { RequestRow } from "./ocx/store";
import { sourceOf, throughputEligible } from "./report/source";

export function speedByModel(rows: readonly RequestRow[]) {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    if (sourceOf(row) !== "ocx" || !throughputEligible(row)) continue;
    const values = groups.get(row.model) ?? [];
    values.push(row.outputTokens / (row.durationMs / 1000));
    groups.set(row.model, values);
  }
  const ranked = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const top: [string | null, number[]][] = ranked.slice(0, CONTEXT_TOP_MODELS);
  const rest = ranked.slice(CONTEXT_TOP_MODELS);
  if (rest.length) top.push([null, rest.flatMap(([, values]) => values)]);
  return {
    minimums: { box: CONTEXT_MIN_N.box, p99: CONTEXT_MIN_N.p99 },
    box: top.map(([model, values]) => {
      const sample = sortedSample(values);
      const n = sample.length;
      const at = (p: number, min: number = CONTEXT_MIN_N.box) => n >= min ? percentileOfSorted(sample, p) : null;
      return {
        model, n,
        p10: at(0.1), p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9),
        p99: at(0.99, CONTEXT_MIN_N.p99), max: sample[n - 1] ?? null,
      };
    }),
  };
}
