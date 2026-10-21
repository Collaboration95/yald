import { expect, test } from "bun:test";
import type { RequestRow } from "./ocx/store";
import { gini, spendStructure, tierOf } from "./spendStructure";

const start = Date.parse("2026-10-10T00:00:00Z");
const DAY = 86_400_000;
function row(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: "r", ts: start, provider: "anthropic", model: "m", requestedModel: null, resolvedModel: null, effort: null,
    status: 200, ok: true, durationMs: 100, ttftMs: 10, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 1100, cost: 1, priced: true, estimated: false, rateIn: 3, rateOut: 15, rateCacheRead: 0.3,
    rateCacheWrite: 3.75, conversationId: "s", errorCode: null, closeReason: null, routeKind: null, account: null, protocol: "messages",
    attempts: 1, sends: 1, settled: 1, unresolved: 0, cacheProvenance: "observed", contextTier: null, serviceTier: null,
    retried: false, usageFromAttempts: false, usageStatus: "reported", attemptTokens: 1100, cwd: null,
    measurements: { outcome: true, duration: true, ttft: true, retries: true, input: true, output: true, cacheRead: true, cacheWrite: true, usage: "logical" },
    ...overrides,
  };
}
const run = (rows: RequestRow[], extra: Partial<Parameters<typeof spendStructure>[1]> = {}) =>
  spendStructure(rows, { bucket: "day", from: start, to: start + 3 * DAY, tz: "UTC", datasetRows: rows, ...extra });

test("price tiers are fixed bands of the list input rate", () => {
  expect([0, 0.99, 1, 4.99, 5, 15].map(tierOf)).toEqual(["economy", "economy", "standard", "standard", "premium", "premium"]);
  expect(tierOf(null)).toBeNull();
});

test("gini of equal and of fully concentrated spend", () => {
  expect(gini([5, 5, 5, 5])).toBe(0);
  expect(gini([0, 0, 0, 10])).toBe(0.75);
  expect(gini([3])).toBeNull();
  expect(gini([0, 0])).toBeNull();
});

test("concentration ranks every session by priced cost and withholds figures below their minimum sample", () => {
  const few = run([row({ id: "a", conversationId: "a", cost: 9 }), row({ id: "b", conversationId: "b", cost: 1 })]);
  expect(few.concentration).toMatchObject({ sessions: 2, totalCost: 10, top1pct: null, top5pct: null, top10Sessions: null, gini: null });
  // 200 sessions: one costs 100, the rest 1 each.
  const rows = [row({ id: "big", conversationId: "big", cost: 100 }), ...Array.from({ length: 199 }, (_, i) => row({ id: `s${i}`, conversationId: `s${i}`, cost: 1 }))];
  const { concentration } = run(rows);
  expect(concentration.sessions).toBe(200);
  expect(concentration.top1pct).toEqual({ sessions: 2, cost: 101, share: round4(101 / 299) });
  expect(concentration.top5pct).toMatchObject({ sessions: 10 });
  expect(concentration.top10Sessions).toMatchObject({ sessions: 10, cost: 109 });
  expect(concentration.gini).toBeGreaterThan(0.3);
  const last = concentration.curve.at(-1)!;
  expect(last).toEqual({ x: 1, y: 1 });
  expect(concentration.curve[0]).toEqual({ x: 0.005, y: round4(100 / 299) });
  for (let i = 1; i < concentration.curve.length; i++) expect(concentration.curve[i]!.y).toBeGreaterThanOrEqual(concentration.curve[i - 1]!.y);
});

const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

test("unpriced requests are counted and never become $0 sessions; partly priced sessions are flagged", () => {
  const result = run([
    row({ id: "p", conversationId: "partly", cost: 2 }),
    row({ id: "u", conversationId: "partly", priced: false, cost: 0, totalTokens: 500 }),
    row({ id: "only", conversationId: "none", priced: false, cost: 0, totalTokens: 700 }),
    row({ id: "anon", conversationId: null, cost: 3 }),
    row({ id: "anon2", conversationId: null, priced: false, cost: 0 }),
  ]);
  expect(result.pricing).toMatchObject({ totalRequests: 5, pricedRequests: 2, unpricedRequests: 3, pricedTokens: 2200, unpricedTokens: 2300, cost: 5 });
  expect(result.concentration).toMatchObject({ sessions: 1, partlyPricedSessions: 1, unpricedSessions: 1, totalCost: 2, noSessionId: { requests: 2, pricedRequests: 1, cost: 3 } });
});

test("the blended price uses priced tokens only and per-tier lines separate mix from price", () => {
  const rows = [
    // Day 1: only economy, $1 per 1M tokens blended.
    row({ id: "e1", ts: start, rateIn: 0.5, cost: 1.1, totalTokens: 1_100_000, conversationId: "a" }),
    // Day 2: economy at the same price plus premium at ten times the price; plus an unpriced row that must not dilute.
    row({ id: "e2", ts: start + DAY, rateIn: 0.5, cost: 1.1, totalTokens: 1_100_000, conversationId: "b" }),
    row({ id: "p2", ts: start + DAY, rateIn: 15, cost: 11, totalTokens: 1_100_000, conversationId: "c" }),
    row({ id: "u2", ts: start + DAY, rateIn: null, priced: false, cost: 0, totalTokens: 50_000_000, conversationId: "d" }),
  ];
  const { series } = run(rows);
  const [d1, d2, d3] = series.buckets;
  expect(d1!.blendedPer1M).toBe(1);
  expect(d2!.blendedPer1M).toBe(5.5);
  expect(d2!.tiers.economy.blendedPer1M).toBe(1);
  expect(d2!.tiers.premium.blendedPer1M).toBe(10);
  expect(d2!.tiers.premium.requestShare).toBe(0.5);
  expect(d2!.tiers.premium.tokenShare).toBe(0.5);
  expect(d1!.tiers.premium).toMatchObject({ blendedPer1M: null, requestShare: 0 });
  // An empty bucket has no price, not a $0 one.
  expect(d3).toMatchObject({ pricedRequests: 0, cost: null, blendedPer1M: null });
  expect(d3!.tiers.economy.requestShare).toBeNull();
});

test("class mix reconciles with row cost, keeps reasoning inside output, and separates sources", () => {
  const parts = { input: 0.5, cacheRead: 0.1, cacheWrite: 0.2, output: 0.8 };
  const claude = row({ id: "c", protocol: "claude-code", cost: 1.6, costParts: parts, inputTokens: 1000, cacheReadTokens: 400, cacheWriteTokens: 100, outputTokens: 100, reasoningTokens: 50, totalTokens: 1100 });
  const tiered = row({ id: "t", cost: 2, contextTier: "long", rateIn: 3, rateOut: 15, rateCacheRead: 0.3, rateCacheWrite: 3.75, inputTokens: 1000, outputTokens: 100, totalTokens: 1100 });
  const { classMix } = run([claude, tiered]);
  expect(classMix.map(entry => entry.source)).toEqual(["claude-code", "ocx"]);
  const [code, ocx] = classMix;
  expect(code!.totalCost).toBe(1.6);
  expect(code!.cost).toMatchObject({ freshInput: 0.5, cacheRead: 0.1, cacheWrite: 0.2, output: 0.8, adjustment: 0, reasoning: 0.4 });
  expect(code!.tokens).toMatchObject({ freshInput: 500, cacheRead: 400, cacheWrite: 100, output: 100, reasoning: 50 });
  // Reasoning is a subset of output: shares of cost exclude it.
  const shares = code!.costShare;
  expect(shares.freshInput! + shares.cacheRead! + shares.cacheWrite! + shares.output! + shares.adjustment!).toBeCloseTo(1, 3);
  // The tiered row has no engine split: its uplift is an explicit adjustment, and classes still add up to its cost.
  expect(ocx!.totalCost).toBe(2);
  expect(ocx!.cost.adjustment).toBeGreaterThan(0);
  expect(ocx!.buckets[0]!.total).toBe(2);
  expect(ocx!.buckets[1]!.share.output).toBeNull();
});

test("sessions cut by the window are flagged", () => {
  const inside = row({ id: "in", conversationId: "x", ts: start + 10 });
  const outside = row({ id: "out", conversationId: "x", ts: start - DAY });
  expect(run([inside], { datasetRows: [inside, outside] }).concentration.clippedSessions).toBe(1);
  expect(run([inside], { datasetRows: [inside] }).concentration.clippedSessions).toBe(0);
});
