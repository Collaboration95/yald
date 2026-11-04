import { describe, expect, test } from "bun:test";
import { cacheBounds, cacheComparison, cachePercent } from "../src/components/cacheComparison";
import type { CachePoint } from "../src/types";
import type { ThemeTokens } from "../src/components/chartOptions";
const theme: ThemeTokens = { text: "#111", axis: "#444", split: "#eee", tooltipBg: "#fff", tooltipBorder: "#ddd", area: "#eee" };
const point = (hitRate: number | null, read = 97000000, input = 100000000, eligible = 1): CachePoint => ({ ts: 1, label: "2026-11-01", hitRate, cacheRead: read, input, eligibleRequests: eligible, totalRequests: 2, savingsUsd: 0 });
describe("cache comparison", () => {
  test("narrow range gets padding in ratio units with accurate percent labels", () => {
    const [min, max] = cacheBounds([0.971, null, NaN, Infinity, 0.98]);
    expect(min).toBeLessThan(0.971); expect(min).toBeGreaterThan(0.96);
    expect(max).toBeGreaterThan(0.98); expect(max).toBeLessThan(0.99);
    expect(cachePercent(0.971)).toBe("97.1%");
  });
  for (const values of [[0], [1], [0.971], [0, 0], [1, 1], [0, 1], [null], [], [NaN, Infinity]]) test(`valid bounds: ${values}`, () => {
    const [min, max] = cacheBounds(values);
    expect(min).toBeGreaterThanOrEqual(0); expect(max).toBeLessThanOrEqual(1); expect(min).toBeLessThan(max);
    for (const value of values) if (value !== null && Number.isFinite(value)) { expect(min).toBeLessThanOrEqual(value); expect(max).toBeGreaterThanOrEqual(value); }
  });
  test("New isolation actually removes huge Cached data, refresh recalculates, and zero differs from missing", () => {
    const initial = cacheComparison(theme, [point(0.98, 98000000), point(null, 0, 0, 0), point(0, 0, 0)], "New");
    const tokens = initial.tokens as any, rate = initial.rate as any;
    expect(tokens.series.map((s: any) => s.name)).toEqual(["New"]);
    expect(tokens.series[0].data).toEqual([2000000, null, 0]);
    expect(tokens.series[0].connectNulls).toBe(false);
    expect(tokens.series[0].symbol).toBe("circle");
    expect(rate.series[0].data).toEqual([0.98, null, 0]);
    expect(tokens.tooltip.valueFormatter(123456789)).toBe("123,456,789 tokens");
    expect(tokens.tooltip.valueFormatter(null)).toBe("Unavailable");
    expect(rate.tooltip.valueFormatter(0.98)).toBe("98%");
    const refreshed = cacheComparison(theme, [point(0.5)], "New") as any;
    expect(refreshed.tokens.series[0].name).toBe("New");
    expect(refreshed.bounds[1]).toBeLessThan(0.6);
    expect(cacheComparison(theme, [point(null, 0, 0, 0)], "New").hasTokens).toBe(false);
    expect(cacheComparison(theme, [point(null, 0, 0)], "New").hasTokens).toBe(true);
  });
});
