import { expect, test } from "bun:test";
import { breakdown, cacheTimeline, contextPressure, filterRows, latencyTimeline, reliability, summarize } from "../../server/src/analytics";
import { toUsageEntry } from "../../server/src/claude/transcripts";
import { normalizeRow } from "../../server/src/ocx/store";
import { cacheEligible, contextEligible, sourceOf, SOURCE_CAPABILITIES } from "../../server/src/report/source";

const ts = Date.parse("2026-10-01T01:00:00Z");
const usage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 40, cacheCreationInputTokens: 0 };
const proxy = (extra: Record<string, unknown> = {}) => normalizeRow({ requestId: "proxy", timestamp: ts, provider: "anthropic", model: "synthetic", inboundProtocol: "messages", status: 200, durationMs: 1000, firstOutputMs: 10, usage, usageStatus: "reported", cacheProvenance: "observed", attempts: [{ usage }], ...extra });
const transcript = (u: Record<string, unknown> = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 }) => normalizeRow(toUsageEntry({ type: "assistant", requestId: "transcript", timestamp: new Date(ts).toISOString(), message: { model: "synthetic", usage: u } })!);

test("Claude-only usage retains volume but cannot supply synthetic reliability, retry, timing or quota evidence", () => {
  const row = transcript();
  const summary = summarize([row]);
  expect(sourceOf(row)).toBe("claude-code");
  expect(SOURCE_CAPABILITIES["claude-code"]).toEqual({ outcomes: false, retries: false, timing: false, quota: false, cache: true, effort: true, agents: true });
  expect(summary).toMatchObject({ requests: 1, ok: 0, errors: 0, cancelled: 0, unobserved: 1, successRate: null, tokens: { input: 140, total: 150 }, latency: { p50: null }, ttft: { p50: null }, retries: { sends: 0, retriedRequests: 0 } });
  for (const key of ["outcomes", "duration", "ttft", "throughput", "retries"] as const) {
    expect(summary.measurementCoverage[key]).toEqual({ eligibleRequests: 0, totalRequests: 1 });
  }
  for (const status of ["ok", "error", "cancelled"] as const) expect(filterRows([row], { statuses: [status] })).toHaveLength(0);
  expect(filterRows([row], { statuses: ["unobserved"] })).toEqual([row]);
  expect(reliability([row], "UTC")).toMatchObject({ outcomes: [{ name: "unobserved", value: 1 }], statuses: [], attempts: [], errors: [], failureByModel: [] });
  // Even a malformed/legacy transcript entry carrying synthetic timing is unsupported.
  const forged = proxy({ inboundProtocol: "claude-code", status: 200 });
  expect(summarize([forged]).latency.p50).toBeNull();
  expect(latencyTimeline([forged], "hour", ts, ts + 1000, "UTC").points[0]?.p50).toBeNull();
  expect(breakdown([forged], r => r.model)[0]?.outputTokensPerSecond).toBeNull();
});

test("mixed failures use observed logical denominator and protocol keeps Anthropic proxy capable", () => {
  const rows = [transcript(), proxy(), proxy({ requestId: "failed", status: 502, errorCode: "upstream" }), proxy({ requestId: "cancelled", status: 499, closeReason: "client_closed" })];
  const summary = summarize(rows);
  expect(sourceOf(rows[1]!)).toBe("ocx");
  expect(rows[1]!.measurements.outcome).toBe(true);
  expect(summary.successRate).toBe(0.3333);
  expect(summary.measurementCoverage.outcomes).toEqual({ eligibleRequests: 3, totalRequests: 4 });
  expect(summary.ok + summary.errors + summary.cancelled + summary.unobserved).toBe(summary.requests);
  expect(summary.tokens.total).toBe(480);
  expect(summary.cache.observedRequests).toBe(4);
  expect(filterRows(rows, { statuses: ["ok"] }).map(r => r.id)).toEqual(["proxy"]);
  const detail = reliability(rows, "UTC");
  expect(detail.outcomes.reduce((n, x) => n + x.value, 0)).toBe(4);
  expect(detail.statuses.find(x => x.name === "200")?.value).toBe(1);
  expect(detail.errorTimeline[0]).toMatchObject({ ok: 1, error: 1, cancelled: 1, unobserved: 1 });
});

test("input presence survives normalization, observed zero wins over attempts, and sums are not context", () => {
  const missing = proxy({ usage: { outputTokens: 10 }, attempts: [] });
  const zero = proxy({ usage: { ...usage, inputTokens: 0, outputTokens: 0 }, attempts: [{ usage }] });
  const summed = proxy({ usage: undefined, attempts: [{ usage }, { usage }] });
  expect(missing.inputTokens).toBe(0);
  expect(missing.measurements.input).toBe(false);
  expect(zero.inputTokens).toBe(0);
  expect(zero.measurements).toMatchObject({ input: true, usage: "logical" });
  expect(zero.usageFromAttempts).toBe(false);
  expect(summed).toMatchObject({ inputTokens: 200, usageFromAttempts: true, measurements: { input: true, usage: "attempt-sum" } });
  const aliases = proxy({ usage: undefined, attempts: [{ usage: { inputTokens: 100, outputTokens: 1, cachedInputTokens: 40, cacheWriteInputTokens: 3 } }] });
  expect(aliases).toMatchObject({ cacheReadTokens: 40, cacheWriteTokens: 3, measurements: { cacheRead: true, cacheWrite: true, usage: "attempt-sum" } });
  expect(contextEligible(missing)).toBe(false);
  expect(contextEligible(zero)).toBe(true);
  expect(contextEligible(summed)).toBe(false);
  expect(contextPressure([missing, zero, summed])).toMatchObject({ eligibleRequests: 1, totalRequests: 3, p50Input: 0 });
  const absentClaude = transcript({ output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const zeroClaude = transcript({ input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  expect(absentClaude.inputTokens).toBe(zeroClaude.inputTokens);
  expect(absentClaude.measurements.input).toBe(false);
  expect(zeroClaude.measurements.input).toBe(true);
  // Legacy archive numeric defaults are not evidence of raw presence.
  expect(proxy({ inboundProtocol: "claude-code" }).measurements.input).toBe(false);
});

test("cache ratios and price presence distinguish absent data from observed and priced zero", () => {
  const observed = proxy();
  const missingInput = proxy({ usage: { outputTokens: 10, cacheReadInputTokens: 900 }, attempts: [] });
  const missingCache = proxy({ usage: { inputTokens: 1000, outputTokens: 10 }, attempts: [] });
  const zero = proxy({ usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 }, attempts: [] });
  const unpriced = { ...observed, priced: false, cost: 0, rateIn: null, rateCacheRead: null };
  const free = { ...zero, priced: true, cost: 0, rateIn: 0, rateCacheRead: 0 };
  const rows = [observed, missingInput, missingCache, zero];
  expect(rows.map(cacheEligible)).toEqual([true, false, false, true]);
  const summary = summarize(rows);
  expect(summary.cache.hitRate).toBe(0.4);
  expect(summary.measurementCoverage.cache).toEqual({ eligibleRequests: 2, totalRequests: 4 });
  expect(cacheTimeline(rows, "hour", ts, ts + 1000, "UTC")[0]).toMatchObject({ hitRate: 0.4, eligibleRequests: 2, totalRequests: 4, input: 100 });
  expect(summarize([unpriced, free])).toMatchObject({ cost: 0, pricedRequests: 1, unpricedRequests: 1, cache: { savingsUsd: 0 } });
  expect(summarize([zero]).cache.hitRate).toBeNull();
});

test("observed zero timing is measured while absent and invalid timing are unavailable", () => {
  const zero = proxy({ durationMs: 0, firstOutputMs: 0 });
  const missing = proxy({ durationMs: undefined, firstOutputMs: undefined });
  const invalid = proxy({ durationMs: -1, firstOutputMs: -1 });
  expect(summarize([zero, missing, invalid])).toMatchObject({ latency: { p50: 0 }, ttft: { p50: 0 }, throughput: { p50: null }, measurementCoverage: { duration: { eligibleRequests: 1, totalRequests: 3 } } });
});
