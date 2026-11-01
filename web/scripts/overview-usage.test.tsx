import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { ActivityGrid } from "../src/components/ActivityGrid";
import { heatmapTotals, inHeatmapRange, overviewSeries, planAccounts } from "../src/lib/overviewUsage";
import type { OverviewResponse, QuotaWindowSnapshot } from "../src/types";

const series = {
  groups: [{ name: "Synthetic small", total: 2 }, { name: "Other", total: 9 }],
  buckets: [{ label: "one", ts: 0, groups: { "Synthetic small": 2, Other: 9 } }, { label: "two", ts: 1, groups: { Other: 0 } }],
} as OverviewResponse["series"];

describe("Overview series isolation", () => {
  test("an unpriced group plots no cost, while a priced free group plots zero", () => {
    const cost = { ...series, metric: "cost", groups: [{ name: "Unpriced", total: 0, pricedRequests: 0 }, { name: "Free", total: 0, pricedRequests: 1 }], buckets: [{ label: "one", ts: 0, groups: {} }] } as OverviewResponse["series"];
    expect(overviewSeries(cost, null)).toEqual([{ name: "Unpriced", data: [null] }, { name: "Free", data: [0] }]);
  });
  test("draws the response groups including Other, and fills missing buckets", () => {
    expect(overviewSeries(series, null)).toEqual([{ name: "Synthetic small", data: [2, 0] }, { name: "Other", data: [9, 0] }]);
  });
  test("isolation survives replacement data and does not mutate the response", () => {
    expect(overviewSeries(structuredClone(series), "Synthetic small")).toEqual([{ name: "Synthetic small", data: [2, 0] }]);
    expect(series.groups.length).toBe(2);
    expect(overviewSeries(series, null).length).toBe(2);
  });
  test("a removed selection restores all remaining series", () => {
    expect(overviewSeries(series, "gone")).toEqual(overviewSeries(series, null));
  });
});

const cells = Array.from({ length: 168 }, (_, index) => ({ weekday: Math.floor(index / 24), hour: index % 24, value: index + 1, requests: 1 }));
describe("weekday/hour range selection", () => {
  test("sums only a rectangle, independent of drag direction", () => {
    const range = { anchor: { weekday: 3, hour: 11 }, end: { weekday: 1, hour: 9 } };
    const expected = [1, 2, 3].flatMap(day => [9, 10, 11].map(hour => day * 24 + hour + 1)).reduce((sum, value) => sum + value, 0);
    expect(heatmapTotals(cells, range)).toEqual({ value: expected, requests: 9 });
    expect(heatmapTotals(cells, { anchor: range.end, end: range.anchor })).toEqual(heatmapTotals(cells, range));
    expect(inHeatmapRange({ weekday: 2, hour: 12 }, range)).toBe(false);
    expect(inHeatmapRange({ weekday: 4, hour: 10 }, range)).toBe(false);
  });
  test("single cells, zero cells and the full week reconcile", () => {
    const point = { weekday: 0, hour: 0 };
    expect(heatmapTotals(cells, { anchor: point, end: point })).toEqual({ value: 1, requests: 1 });
    expect(heatmapTotals([], { anchor: point, end: point })).toEqual({ value: 0, requests: 0 });
    expect(heatmapTotals(cells, { anchor: point, end: { weekday: 6, hour: 23 } })).toEqual({ value: 168 * 169 / 2, requests: 168 });
  });
  test("one real accessible grid replaces the hidden controls", () => {
    const html = renderToString(<ActivityGrid cells={cells} disabled={false} unit="tokens" onChoose={() => {}} onClearChoice={() => {}} />);
    expect(html.match(/role="gridcell"/g)?.length).toBe(168);
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
    for (const role of ["grid", "row", "columnheader", "rowheader"]) expect(html).toContain(`role="${role}"`);
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("sr-only");
  });
});

describe("Codex plan grouping", () => {
  const window = (account: string, updatedAt: number, name = "weekly"): QuotaWindowSnapshot => ({ account, updatedAt, window: name, usedPercent: 0, resetAtMs: null });
  test("groups windows by account with the latest observed account first", () => {
    const input = [window("synthetic-a", 1), window("synthetic-b", 3), window("synthetic-a", 2, "daily")];
    const groups = planAccounts(input);
    expect(groups.map(group => group.key)).toEqual(["synthetic-b", "synthetic-a"]);
    expect(groups[1]!.windows.map(row => row.window)).toEqual(["weekly", "daily"]);
    expect(input[0]!.account).toBe("synthetic-a");
  });
  test("a newer reading reorders accounts without renaming them", () => {
    const before = planAccounts([window("synthetic-a", 2), window("synthetic-b", 1)]);
    const after = planAccounts([window("synthetic-a", 2), window("synthetic-b", 3)]);
    expect(before.map(group => group.key)).toEqual(["synthetic-a", "synthetic-b"]);
    expect(after.map(group => group.key)).toEqual(["synthetic-b", "synthetic-a"]);
    expect(after.find(group => group.key === "synthetic-a")!.number).toBe(before.find(group => group.key === "synthetic-a")!.number);
  });
  test("empty and Codex-only readings need no Claude placeholder", () => {
    expect(planAccounts([])).toEqual([]);
    expect(planAccounts([window("codex-rollouts", 0)]).length).toBe(1);
  });
});
