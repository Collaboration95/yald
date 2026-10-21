import { expect, test } from "bun:test";
import type { RequestRow } from "./ocx/store";
import { contextBreakdown, CONTEXT_TOP_MODELS } from "./contextView";
import { buildContextReplay } from "./labs/context";

const start = Date.parse("2026-10-10T00:00:00Z");
const DAY = 86_400_000;
function row(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: "request", ts: start, provider: "anthropic", model: "m", requestedModel: null, resolvedModel: null, effort: "high",
    status: 200, ok: true, durationMs: 100, ttftMs: 10, inputTokens: 1000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 1020, cost: 0.01, priced: true, estimated: false, rateIn: 1, rateOut: 2, rateCacheRead: 0.1,
    rateCacheWrite: 0.2, conversationId: "s", errorCode: null, closeReason: null, routeKind: "native", account: null, protocol: "messages",
    attempts: 1, sends: 1, settled: 1, unresolved: 0, cacheProvenance: "observed", contextTier: null, serviceTier: "default",
    retried: false, usageFromAttempts: false, usageStatus: "reported", attemptTokens: 1020, cwd: "/p",
    measurements: { outcome: true, duration: true, ttft: true, retries: true, input: true, output: true, cacheRead: true, cacheWrite: true, usage: "logical" },
    ...overrides,
  };
}
const claude = (overrides: Partial<RequestRow> = {}) => row({
  protocol: "claude-code", ttftMs: null, durationMs: 0,
  measurements: { ...row().measurements, outcome: false, duration: false, ttft: false, retries: false }, ...overrides,
});
const run = (rows: RequestRow[], extra: Partial<Parameters<typeof contextBreakdown>[1]> = {}) =>
  contextBreakdown(rows, { bucket: "day", from: start, to: start + 3 * DAY, tz: "UTC", datasetRows: rows, ...extra });

test("statistics need a minimum sample and never turn a gap into zero", () => {
  const few = run(Array.from({ length: 9 }, (_, i) => row({ id: `r${i}`, inputTokens: (i + 1) * 1000 })));
  expect(few.overall).toMatchObject({ n: 9, mean: 5000, p50: 5000, max: 9000, p10: null, p90: null, p99: null });
  const ten = run(Array.from({ length: 10 }, (_, i) => row({ id: `r${i}`, inputTokens: (i + 1) * 1000 })));
  expect(ten.overall.p90).toBe(9100);
  expect(ten.overall.p99).toBeNull();
  const hundred = run(Array.from({ length: 100 }, (_, i) => row({ id: `r${i}`, inputTokens: (i + 1) * 1000 })));
  expect(hundred.overall.p99).toBe(99_010);
  const empty = run([]);
  expect(empty.overall).toMatchObject({ n: 0, mean: null, p50: null, max: null });
});

test("ineligible rows are counted as coverage and never enter a distribution", () => {
  const summed = row({ id: "sum", inputTokens: 900_000, usageFromAttempts: true, measurements: { ...row().measurements, usage: "attempt-sum" } });
  const absent = row({ id: "absent", inputTokens: 0, measurements: { ...row().measurements, input: false, usage: "missing" } });
  const zero = row({ id: "zero", inputTokens: 0 });
  const result = run([summed, absent, zero, row({ id: "ok", inputTokens: 10 })]);
  expect(result.eligibility).toMatchObject({ totalRequests: 4, eligibleRequests: 2, excludedRequests: 2 });
  expect(result.overall).toMatchObject({ n: 2, max: 10, mean: 5 });
});

test("thresholds and the context tax share one eligible, priced denominator", () => {
  const rows = [
    row({ id: "a", inputTokens: 10_000, cost: 1 }),
    row({ id: "b", inputTokens: 60_000, cost: 2 }),
    row({ id: "c", inputTokens: 200_000, cost: 3, contextTier: "long" }),
    row({ id: "d", inputTokens: 350_000, cost: 0, priced: false }),
  ];
  const result = run(rows);
  const at = (value: number | null) => result.thresholds.find(entry => entry.at === value)!;
  expect(at(150_000)).toMatchObject({ requests: 2, requestShare: 0.5, cost: 3, costShare: 0.5 });
  // The only request above 300k has no price: its cost is unavailable, not $0.
  expect(at(300_000)).toMatchObject({ requests: 1, requestShare: 0.25, pricedRequests: 0, cost: null, costShare: null });
  expect(at(null)).toMatchObject({ requests: 1, requestShare: 0.25, cost: 3, costShare: 0.5 });
  expect(result.eligibility).toMatchObject({ pricedEligibleRequests: 3, unpricedEligibleRequests: 1 });
  expect(result.tax.map(band => [band.id, band.requests, band.pricedRequests])).toEqual([["lt50k", 1, 1], ["50-150k", 1, 1], ["150-300k", 1, 1], ["300k+", 1, 0]]);
  // The unpriced 300k+ row has no dollars: the band has no cost, not a $0 cost.
  expect(result.tax[3]).toMatchObject({ cost: null, costShare: null, costPerPricedRequest: null });
  expect(result.tax[0]!.belowMinimum).toBe(true);
  expect(result.tax[0]!.costPerPricedRequest).toBeNull();
});

test("TTFT and cancel rate come from observed ocx rows only; Claude reads not recorded", () => {
  const ocx = Array.from({ length: 12 }, (_, i) => row({ id: `o${i}`, inputTokens: 5_000, ttftMs: 100 + i * 10, ...(i < 3 ? { status: 499, ok: false, closeReason: "client_closed" } : {}) }));
  const code = Array.from({ length: 12 }, (_, i) => claude({ id: `c${i}`, inputTokens: 5_000, conversationId: "cl" }));
  const result = run([...ocx, ...code]);
  expect(result.tax[0]).toMatchObject({ requests: 24, ttftMeasured: 12, outcomesObserved: 12, cancelled: 3, cancelRate: 0.25, ttftP50: 155 });
  const onlyClaude = run(code);
  expect(onlyClaude.tax[0]).toMatchObject({ ttftMeasured: 0, ttftP50: null, outcomesObserved: 0, cancelRate: null });
  expect(onlyClaude.sources).toEqual([{ source: "claude-code", totalRequests: 12, eligibleRequests: 12, ttftMeasured: 0, outcomesObserved: 0 }]);
});

test("model by band is row-normalised, keeps the top models and folds the rest into Other", () => {
  const rows: RequestRow[] = [];
  for (let m = 0; m < CONTEXT_TOP_MODELS + 3; m++) {
    for (let i = 0; i < CONTEXT_TOP_MODELS + 3 - m; i++) rows.push(row({ id: `m${m}-${i}`, model: `model-${m}`, inputTokens: i % 2 ? 60_000 : 1000, conversationId: null }));
  }
  const result = run(rows);
  expect(result.modelBands).toHaveLength(CONTEXT_TOP_MODELS + 1);
  const other = result.modelBands.at(-1)!;
  expect(other.model).toBeNull();
  expect(other.source).toBeNull();
  expect(other.n).toBe(3 + 2 + 1);
  for (const entry of result.modelBands) expect(entry.bandShares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
  expect(result.modelBands[0]).toMatchObject({ model: "model-0", n: 15 });
});

test("the same model name stays separate per source", () => {
  const result = run([row({ id: "a", model: "same" }), claude({ id: "b", model: "same" })]);
  expect(result.models.map(entry => [entry.source, entry.model])).toEqual([["claude-code", "same"], ["ocx", "same"]]);
});

test("over time: empty buckets are null, p90 needs a sample, buckets follow the zone", () => {
  const day2 = Array.from({ length: 10 }, (_, i) => row({ id: `d${i}`, ts: start + DAY + i, inputTokens: (i + 1) * 100 }));
  const result = run([row({ id: "d0", ts: start, inputTokens: 500 }), ...day2], { tz: "UTC" });
  expect(result.timeline.buckets.map(bucket => bucket.label)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
  const series = result.timeline.series[0]!;
  expect(series.source).toBe("ocx");
  expect(series.n).toEqual([1, 10, 0]);
  expect(series.p50).toEqual([500, 550, null]);
  expect(series.p90).toEqual([null, 910, null]);
  const shifted = run([row({ ts: start + 3_600_000 })], { tz: "Pacific/Auckland" });
  expect(shifted.timeline.buckets[0]!.label).toBe("2026-10-10");
});

test("session growth matches Context Replay on the same rows", () => {
  const inputs = [10, 100, 20, 100, 900, 200];
  const rows = inputs.map((inputTokens, i) => row({ id: `g${i}`, ts: start + i * 10, inputTokens }));
  const short = [row({ id: "x1", conversationId: "short" }), row({ id: "x2", conversationId: "short", ts: start + 5 })];
  const outside = row({ id: "out", ts: start - 10, inputTokens: 1 });
  const window = { from: start, to: start + 1000, tz: "UTC", label: "w" };
  const replay = buildContextReplay([...rows, ...short], {}, window);
  const result = run([...rows, ...short], { from: window.from, to: window.to });
  const ranked = replay.sessions.filter(session => session.growth.ranked);
  expect(ranked).toHaveLength(1);
  expect(result.growth).toMatchObject({ sessions: 2, ranked: 1, unranked: 1, noRatio: 0, medianRatio: ranked[0]!.growth.ratio, clippedRanked: 0 });
  expect(result.growth.histogram.find(bucket => bucket.value > 0)?.name).toBe("10x+");
  const clipped = contextBreakdown([...rows], { bucket: "day", from: start, to: start + 1000, tz: "UTC", datasetRows: [...rows, outside] });
  expect(clipped.growth.clippedRanked).toBe(1);
});
