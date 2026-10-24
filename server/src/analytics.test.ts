import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as analytics from "./analytics";
import type { Dataset, RequestRow } from "./ocx/store";
import { parseWindow } from "./time/window";

const tz = "America/New_York";

const now = new Date("2026-03-08T16:00:00-04:00").getTime();
function row(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    measurements: { outcome: true, duration: true, ttft: true, retries: true, input: true, output: true, cacheRead: true, cacheWrite: true, usage: "logical" },
    id: "r1", ts: now, provider: "openai", model: "gpt-test", requestedModel: "openai/gpt-test", resolvedModel: "gpt-test",
    effort: "high", status: 200, ok: true, durationMs: 1000, ttftMs: 200, inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 40, cacheWriteTokens: 10, reasoningTokens: 2, totalTokens: 120, cost: 0.01, priced: true, estimated: false,
    rateIn: 1, rateOut: 2, rateCacheRead: 0.1, rateCacheWrite: 0.2, conversationId: "c1", errorCode: null,
    closeReason: null, routeKind: "native", account: null, protocol: "responses", attempts: 1, sends: 1, settled: 1,
    unresolved: 0, cacheProvenance: "observed", contextTier: null, serviceTier: "default", retried: false,
    usageFromAttempts: false, usageStatus: "reported", attemptTokens: 120, cwd: null, ...overrides,
  };
}

const rows = [row(), row({ id: "r2", ts: now + 60_000, model: "other", status: 502, ok: false, errorCode: "upstream", conversationId: "c1", usageStatus: "unreported", cacheProvenance: "synthesized", cacheReadTokens: 80, retried: true, totalTokens: 80, attemptTokens: 130, cost: 0.02 })];

test("aggregate price presence separates unpriced models and sessions from a priced zero", () => {
  const samples = [
    row({ id: "free", model: "free", conversationId: "free", cost: 0, priced: true }),
    row({ id: "unknown", model: "unknown", conversationId: "unknown", cost: 0, priced: false }),
  ];
  const models = analytics.breakdown(samples, r => r.model);
  expect(models.find(r => r.key === "free")).toMatchObject({ cost: 0, pricedRequests: 1, costPer1MTokens: 0 });
  expect(models.find(r => r.key === "unknown")).toMatchObject({ cost: 0, pricedRequests: 0, costPer1MTokens: null });
  const sessions = analytics.conversations(samples);
  expect(sessions.find(r => r.id === "free")).toMatchObject({ cost: 0, pricedRequests: 1, unpricedRequests: 0 });
  expect(sessions.find(r => r.id === "unknown")).toMatchObject({ cost: 0, pricedRequests: 0, unpricedRequests: 1 });
});

test("7d uses exactly 168 hours across DST and ignores future-dated source rows", () => {
  const window = parseWindow({ range: "7d", tz }, { now, first: now - 30 * 86_400_000 });
  expect(window.to).toBe(now);
  expect(window.to - window.from).toBe(168 * 3_600_000);
  // Half-open: a row exactly at `to` belongs to the next window.
  expect(analytics.filterRows([
    row({ ts: window.from - 1 }), row({ ts: window.from }), row({ ts: now - 1 }), row({ ts: now }), row({ ts: now + 1 }),
  ], window)).toHaveLength(2);
});

function dataset(): Dataset {
  return {
    rows,
    quota: {
      windows: [{ account: "a", window: "weekly", usedPercent: 50, resetAtMs: Date.now() + 7 * 86_400_000, updatedAt: now }],
      samples: [
        { account: "a", family: "account", window: "weekly", usedPercent: 40, resetAtMs: Date.now() + 7 * 86_400_000, observedAt: now - 86_400_000, source: "response-header" },
        { account: "a", family: "account", window: "weekly", usedPercent: 50, resetAtMs: Date.now() + 7 * 86_400_000, observedAt: now, source: "response-header" },
      ], updatedAt: now,
    },
    ledger: { events: [{ kind: "dispatch", at: now, sendId: "s1", tokens: 0 }, { kind: "settle", at: now, sendId: "s1", tokens: 120 }], byKind: { dispatch: 1, settle: 1 }, settledTokens: 120, updatedAt: now },
    files: { usage: null, spend: null, quota: null }, parse: { malformedLines: 0, durationMs: 1 }, builtAt: now, revision: "test",
  };
}

test("analytics exports cover bucketing, filters, summaries, and view aggregates", () => {
  expect(analytics.bucketStart(now + 59 * 60_000, "hour", tz)).toBe(now);
  expect(analytics.bucketStart(now, "day", tz)).toBe(new Date("2026-03-08T00:00:00-05:00").getTime());
  expect(analytics.bucketStart(now, "week", tz)).toBe(new Date("2026-03-02T00:00:00-05:00").getTime());
  expect(analytics.bucketLabel(now, "hour", tz)).toBe("03-08 16:00");
  expect(analytics.bucketLabel(now, "day", tz)).toBe("2026-03-08");
  expect(analytics.bucketLabel(analytics.bucketStart(now, "week", tz), "week", tz)).toBe("2026-03-02");
  expect(analytics.bucketLabel(now, "hour", "Asia/Singapore")).toBe("03-09 04:00");
  expect(analytics.pickBucket(60_000)).toBe("hour");
  expect(analytics.pickBucket(7 * 86_400_000)).toBe("day");
  expect(analytics.filterRows(rows, { providers: ["openai"], models: ["other"], efforts: ["high"], statuses: ["error"], routeKinds: ["native"], conversationId: "c1", search: "UPSTREAM", from: now, to: now + 60_001 })).toHaveLength(1);
  expect(analytics.filterRows(rows, { providers: ["openai"] })).toHaveLength(2);
  expect(analytics.filterRows(rows, { models: ["other"] })).toHaveLength(1);
  expect(analytics.filterRows(rows, { efforts: ["high"] })).toHaveLength(2);
  expect(analytics.filterRows(rows, { statuses: ["error"] })).toHaveLength(1);
  expect(analytics.filterRows(rows, { routeKinds: ["native"] })).toHaveLength(2);
  expect(analytics.filterRows(rows, { conversationId: "missing" })).toHaveLength(0);
  expect(analytics.filterRows(rows, { search: "UPSTREAM" })).toHaveLength(1);
  expect(analytics.filterRows(rows, { from: now + 1 })).toHaveLength(1);
  expect(analytics.filterRows(rows, { to: now + 60_000 })).toHaveLength(1);
  expect(analytics.outcome(rows[0]!)).toBe("ok");
  expect(analytics.outcome(rows[1]!)).toBe("error");
  expect(analytics.percentile([], 0.5)).toBeNull();
  expect(analytics.percentile([10], 0.5)).toBe(10);
  expect(analytics.percentile([0, 10], 0.25)).toBe(2.5);
  const summary = analytics.summarize(rows);
  expect(summary.cache.hitRate).toBe(0.4);
  expect(summary.metering.coverage).toBe(0.5);
  expect(summary.retryOverhead.tokens).toBe(50);
  expect(analytics.groupKey(rows[0]!, "provider")).toBe("openai");
  expect(analytics.buildSeries(rows, { bucket: "day", metric: "tokens", groupBy: "model", from: now, to: now + 60_000, tz }).buckets.length).toBeGreaterThan(0);
  expect(analytics.breakdown(rows, r => r.model)).toHaveLength(2);
  expect(analytics.costComposition(rows).unpricedRequests).toBe(0);
  expect(analytics.heatmap(rows).cells).toHaveLength(168);
  expect(analytics.latencyTimeline(rows, "day", now, now + 60_000, tz).points.length).toBeGreaterThan(0);
  expect(analytics.reliability(rows, tz).errors[0]?.name).toBe("upstream");
  expect(analytics.conversations(rows)).toHaveLength(1);
  expect(analytics.conversationTimeline(rows, "c1").summary.requests).toBe(2);
  const quota = analytics.quotaView(dataset(), { from: now - 86_400_000, to: now + 1 });
  expect(quota.burn[0]?.status).toBe("measured");
  expect(quota.burn[0]?.willExhaustBeforeReset).toBe(true);
  const laterReset = dataset();
  laterReset.quota.windows[0]!.resetAtMs = Date.now() + 86_400_000;
  expect(analytics.quotaView(laterReset, { from: now - 86_400_000, to: now + 1 }).burn[0]?.willExhaustBeforeReset).toBe(false);
  const baseline = analytics.quotaView(dataset(), { from: now - 60_000, to: now });
  expect(baseline.series[0]?.baselineIncluded).toBe(true);
  expect(baseline.burn[0]?.status).toBe("insufficient");
  expect(analytics.sparkline(rows, now, now + 60_000, "tokens", 4)).toHaveLength(4);
  const composition = analytics.compositionSeries(rows, "day", now, now + 60_000, tz);
  expect(composition.every(point => point.freshInput >= 0)).toBe(true);
  expect(analytics.cumulativeSeries(rows, "day", now, now + 60_000, "tokens", tz)[0]?.cumulative).toBe(200);
  expect(analytics.cacheTimeline(rows, "day", now, now + 60_000, tz)[0]?.hitRate).toBe(0.4);
  expect(analytics.contextPressure(rows).maxInput).toBe(100);
  expect(analytics.round(1.234, 2)).toBe(1.23);
  const nextDay = new Date("2026-03-09T12:00:00-04:00").getTime();
  expect(analytics.bucketStart(nextDay, "day", tz) - analytics.bucketStart(now, "day", tz)).toBe(23 * 60 * 60 * 1000);
  expect(analytics.bucketStarts("day", now - 86_400_000, nextDay, tz).map(ts => analytics.bucketLabel(ts, "day", tz))).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
});

test("filterRows shares one frozen result per equivalent filter and never one across arrays or filters", () => {
  const source = [...rows, row({ id: "r3", ts: now + 120_000, provider: "anthropic", protocol: "claude-code" })];
  const scans = analytics.filterScans();
  const first = analytics.filterRows(source, { from: now, to: now + 600_000, providers: ["openai", "anthropic"], search: " R " });
  // Order, duplicates, case and blank values are the same filter; naming every source is no source filter.
  expect(analytics.filterRows(source, { to: now + 600_000, from: now, providers: ["anthropic", "openai", "openai"], search: "r", sources: ["ocx", "claude-code"], conversationId: "" })).toBe(first);
  expect(analytics.filterScans()).toBe(scans + 1);
  expect(Object.isFrozen(first)).toBe(true);
  expect(() => (first as RequestRow[]).sort((a, b) => b.ts - a.ts)).toThrow();
  expect(first.map(r => r.id)).toEqual(["r1", "r2", "r3"]);
  expect(analytics.filterRows(source, { from: now, to: now + 600_000, providers: ["openai"] }).map(r => r.id)).toEqual(["r1", "r2"]);
  expect(analytics.filterRows(source, { sources: ["claude-code"] }).map(r => r.id)).toEqual(["r3"]);
  expect(analytics.filterRows([...source], { from: now, to: now + 600_000, providers: ["openai", "anthropic"], search: "r" })).not.toBe(first);
});

test("heatmap date detail ranks actual local dates across range boundaries and DST", () => {
  // New York jumps over 02:00 in spring and repeats 01:00 in fall.
  const samples = [
    row({ id: "before-midnight", ts: new Date("2026-03-08T04:59:59Z").getTime(), totalTokens: 9 }),
    row({ id: "sunday-1", ts: new Date("2026-03-08T06:30:00Z").getTime(), totalTokens: 30 }),
    row({ id: "sunday-3", ts: new Date("2026-03-08T07:30:00Z").getTime(), totalTokens: 500 }),
    row({ id: "next-sunday", ts: new Date("2026-03-15T05:30:00Z").getTime(), totalTokens: 10 }),
  ];
  const tokens = analytics.heatmapDateBreakdown(samples, { weekday: 6, hour: 1, metric: "tokens", timeZone: "America/New_York", limit: 1 });
  expect(tokens.total).toBe(40);
  expect(tokens.totalDates).toBe(2);
  expect(tokens.dates).toEqual([{ date: "2026-03-08", value: 30, requests: 1 }]);
  expect(tokens.hasMore).toBe(true);
  const requests = analytics.heatmapDateBreakdown(samples, { weekday: 6, hour: 1, metric: "requests", timeZone: "America/New_York" });
  expect(requests.dates).toEqual([
    { date: "2026-03-15", value: 1, requests: 1 },
    { date: "2026-03-08", value: 1, requests: 1 },
  ]);
  expect(analytics.heatmap(samples, "tokens", "America/New_York").cells.find(cell => cell.weekday === 6 && cell.hour === 1)?.value).toBe(40);
  expect(analytics.heatmapDateBreakdown([], { weekday: 6, hour: 1, metric: "tokens", timeZone: "America/New_York" })).toMatchObject({ total: 0, dates: [], totalDates: 0, hasMore: false });

  const fallBack = [
    row({ id: "fall-before-midnight", ts: new Date("2026-11-01T03:59:59Z").getTime(), totalTokens: 7 }),
    row({ id: "fall-first-one", ts: new Date("2026-11-01T05:30:00Z").getTime(), totalTokens: 11 }),
    row({ id: "fall-second-one", ts: new Date("2026-11-01T06:30:00Z").getTime(), totalTokens: 13 }),
    row({ id: "fall-after-midnight", ts: new Date("2026-11-02T05:00:00Z").getTime(), totalTokens: 17 }),
  ];
  const repeatedHour = analytics.heatmapDateBreakdown(fallBack, { weekday: 6, hour: 1, metric: "tokens", timeZone: "America/New_York" });
  expect(repeatedHour.total).toBe(24);
  expect(repeatedHour.dates).toEqual([{ date: "2026-11-01", value: 24, requests: 2 }]);
  expect(analytics.heatmapDateBreakdown(fallBack, { weekday: 5, hour: 23, metric: "tokens", timeZone: "America/New_York" }).dates)
    .toEqual([{ date: "2026-10-31", value: 7, requests: 1 }]);
});

test("API routes return their documented payloads and range-scoped quota and ledger", async () => {
  const home = await mkdtemp(join(tmpdir(), "yald-api-test-"));
  try {
    const usage = rows.map((r, i) => ({ requestId: r.id, timestamp: r.ts, provider: r.provider, model: r.model, requestedModel: r.requestedModel, effectiveEffort: r.effort, status: r.status, durationMs: r.durationMs, firstOutputMs: r.ttftMs, usageStatus: r.usageStatus, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, totalTokens: r.totalTokens, cacheReadInputTokens: r.cacheReadTokens, cachedInputTokens: r.cacheWriteTokens, reasoningOutputTokens: r.reasoningTokens }, totalTokens: r.totalTokens, cacheProvenance: r.cacheProvenance, conversationId: r.conversationId, attempts: [], routeDecision: { selected: { provider: r.provider, model: r.model } }, errorCode: r.errorCode, spend: { sends: 1, settled: 1 }, _i: i }));
    await writeFile(join(home, "usage.jsonl"), usage.map(x => JSON.stringify(x)).join("\n") + "\n");
    await writeFile(join(home, "spend-ledger.jsonl"), [JSON.stringify({ kind: "dispatch", send: "s1", at: now }), JSON.stringify({ kind: "settle", send: "s1", tokens: 120, at: now })].join("\n") + "\n");
    await writeFile(join(home, "codex-quota-cache.json"), JSON.stringify({ version: 1, history: { accounts: { a: { samples: [{ observedAt: now - 86_400_000, windows: [{ family: "account", window: "weekly", usedPercent: 40 }] }, { observedAt: now, windows: [{ family: "account", window: "weekly", usedPercent: 50 }] }] } } }, quotas: { a: { updatedAt: now, weeklyPercent: 50, weeklyResetAt: Math.floor((now + 7 * 86_400_000) / 1000) } } }));
    const pricing = join(home, "pricing");
    await mkdir(join(home, "codex"));
    await mkdir(join(home, "claude-projects"));
    await mkdir(join(pricing, "src/usage"), { recursive: true });
    // This case tests routes, cache identity and time boundaries, not the installed price catalog.
    await writeFile(join(pricing, "src/usage/cost.ts"), "export function estimateRequestCost() { return null; }\n");
    const root = resolve(import.meta.dir, "../..");
    const result = spawnSync(process.execPath, [join(root, "tests/helpers/analytics-api-probe.ts"), String(now)], {
      cwd: root,
      env: {
        ...process.env, NODE_ENV: "test", OCX_HOME: home, CODEX_HOME: join(home, "codex"),
        CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), OCX_PACKAGE_DIR: pricing,
        TZ: tz, YALD_TZ: tz, YALD_CLOCK_QUANTUM_MS: "10000",
      },
      encoding: "utf8", timeout: 5000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("analytics API assertions passed");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("class costs use the engine split, or keep an explicit adjustment so they always add up to the row cost", () => {
  // A long-context-tier row: the engine charged double the table rates.
  const tokens = { inputTokens: 10_000_000, cacheReadTokens: 4_000_000, cacheWriteTokens: 1_000_000, outputTokens: 2_000_000 };
  const tiered = row({ ...tokens, cost: 19.2, contextTier: "long" });
  const withParts = row({ ...tiered, costParts: { input: 10, cacheRead: 0.8, cacheWrite: 0.4, output: 8 } });
  const total = (list: RequestRow[]) => analytics.costComposition(list);
  expect(total([withParts]).adjustment).toBe(0);
  const exact = total([withParts]);
  expect(exact.freshInput + exact.cacheRead + exact.cacheWrite + exact.output).toBeCloseTo(withParts.cost, 8);
  // Without the split, the tier uplift is its own line, never folded into a class.
  const fallback = total([tiered]);
  expect(fallback.total).toBeCloseTo(tiered.cost, 8);
  expect(fallback.adjustment).toBeCloseTo(9.6, 8);
  expect(fallback.freshInput).toBeCloseTo(5, 8);
  // Unpriced rows add no dollars to any class.
  expect(total([row({ priced: false, cost: 0 })]).total).toBe(0);
});

test("blended price per model divides priced cost by priced tokens only", () => {
  const mixed = [row({ id: "a", cost: 1, totalTokens: 1_000_000 }), row({ id: "b", priced: false, cost: 0, totalTokens: 9_000_000 })];
  const [model] = analytics.breakdown(mixed, r => r.model);
  expect(model).toMatchObject({ tokens: 10_000_000, pricedTokens: 1_000_000, costPer1MTokens: 1, costPer1kTokens: 0.001 });
});

test("the slowest list leaves out stalled streams that stayed open for hours", () => {
  const list = [
    row({ id: "stalled", durationMs: 5 * 3_600_000 }),
    row({ id: "slow", durationMs: 90_000 }),
    row({ id: "fast", durationMs: 800 }),
  ];
  expect(analytics.slowestRequests(list, 5).map(r => r.id)).toEqual(["slow", "fast"]);
});

test("a session reports where it last ran, and allConversations is not cut", () => {
  const list = [
    row({ id: "a", conversationId: "s1", ts: 1000, cwd: "/work/old" }),
    row({ id: "b", conversationId: "s1", ts: 2000, cwd: "/work/app" }),
    row({ id: "c", conversationId: "s1", ts: 3000, cwd: null }),
    row({ id: "d", conversationId: "s2", ts: 1000, cwd: null }),
  ];
  const all = analytics.allConversations(list);
  expect(all).toHaveLength(2);
  expect(all.find(c => c.id === "s1")!.project).toBe("/work/app");
  expect(all.find(c => c.id === "s2")!.project).toBeNull();
  expect(analytics.conversations(list, 1)).toHaveLength(1);
});

test("conversations rank by the requested order across every session before the cut", () => {
  const list = [
    ...Array.from({ length: 5 }, (_, i) => row({ id: `t${i}`, conversationId: `t${i}`, totalTokens: 1000 + i, cost: 0.01 })),
    row({ id: "c", conversationId: "costly", totalTokens: 5, cost: 9 }),
  ];
  expect(analytics.conversations(list, 2, "tokens").map(c => c.id)).toEqual(["t4", "t3"]);
  expect(analytics.conversations(list, 2, "cost").map(c => c.id)).toEqual(["costly", "t4"]);
});
