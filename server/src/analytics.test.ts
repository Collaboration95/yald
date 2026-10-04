import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as analytics from "./analytics";
import type { Dataset, RequestRow } from "./ocx/store";

process.env.TZ = "America/New_York";

const now = new Date("2026-03-08T16:00:00-04:00").getTime();
function row(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: "r1", ts: now, provider: "openai", model: "gpt-test", requestedModel: "openai/gpt-test", resolvedModel: "gpt-test",
    effort: "high", status: 200, ok: true, durationMs: 1000, ttftMs: 200, inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 40, cacheWriteTokens: 10, reasoningTokens: 2, totalTokens: 120, cost: 0.01, priced: true, estimated: false,
    rateIn: 1, rateOut: 2, rateCacheRead: 0.1, rateCacheWrite: 0.2, conversationId: "c1", errorCode: null,
    closeReason: null, routeKind: "native", account: null, protocol: "responses", attempts: 1, sends: 1, settled: 1,
    unresolved: 0, cacheProvenance: "observed", contextTier: null, serviceTier: "default", retried: false,
    usageFromAttempts: false, usageStatus: "reported", attemptTokens: 120, ...overrides,
  };
}

const rows = [row(), row({ id: "r2", ts: now + 60_000, model: "other", status: 502, ok: false, errorCode: "upstream", conversationId: "c1", usageStatus: "unreported", cacheProvenance: "synthesized", cacheReadTokens: 80, retried: true, totalTokens: 80, attemptTokens: 130, cost: 0.02 })];

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
  expect(analytics.startOfDay(now).getHours()).toBe(0);
  expect(analytics.startOfWeek(now).getDay()).toBe(1);
  expect(analytics.startOfHour(now).getMinutes()).toBe(0);
  expect(analytics.bucketStart(now, "hour")).toBe(analytics.startOfHour(now).getTime());
  expect(analytics.bucketStart(now, "day")).toBe(analytics.startOfDay(now).getTime());
  expect(analytics.bucketStart(now, "week")).toBe(analytics.startOfWeek(now).getTime());
  expect(analytics.bucketLabel(now, "hour")).toBe("03-08 16:00");
  expect(analytics.bucketLabel(now, "day")).toBe("2026-03-08");
  expect(analytics.bucketLabel(analytics.bucketStart(now, "week"), "week")).toBe("2026-03-02");
  expect(analytics.pickBucket(60_000)).toBe("hour");
  expect(analytics.resolveWindow({ range: "7d", to: now }, { first: now - 1, last: now }).bucket).toBe("day");
  expect(analytics.filterRows(rows, { providers: ["openai"], models: ["other"], efforts: ["high"], statuses: ["error"], routeKinds: ["native"], conversationId: "c1", search: "UPSTREAM", from: now, to: now + 60_000 })).toHaveLength(1);
  expect(analytics.filterRows(rows, { providers: ["openai"] })).toHaveLength(2);
  expect(analytics.filterRows(rows, { models: ["other"] })).toHaveLength(1);
  expect(analytics.filterRows(rows, { efforts: ["high"] })).toHaveLength(2);
  expect(analytics.filterRows(rows, { statuses: ["error"] })).toHaveLength(1);
  expect(analytics.filterRows(rows, { routeKinds: ["native"] })).toHaveLength(2);
  expect(analytics.filterRows(rows, { conversationId: "missing" })).toHaveLength(0);
  expect(analytics.filterRows(rows, { search: "UPSTREAM" })).toHaveLength(1);
  expect(analytics.filterRows(rows, { from: now + 1 })).toHaveLength(1);
  expect(analytics.filterRows(rows, { to: now })).toHaveLength(1);
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
  expect(analytics.buildSeries(rows, { bucket: "day", metric: "tokens", groupBy: "model", from: now, to: now + 60_000 }).buckets.length).toBeGreaterThan(0);
  expect(analytics.breakdown(rows, r => r.model)).toHaveLength(2);
  expect(analytics.costComposition(rows).unpricedRequests).toBe(0);
  expect(analytics.heatmap(rows).cells).toHaveLength(168);
  expect(analytics.latencyTimeline(rows, "day", now, now + 60_000).points.length).toBeGreaterThan(0);
  expect(analytics.reliability(rows).errors[0]?.name).toBe("upstream");
  expect(analytics.conversations(rows)).toHaveLength(1);
  expect(analytics.conversationTimeline(rows, "c1").summary.requests).toBe(2);
  const quota = analytics.quotaView(dataset(), { from: now - 86_400_000, to: now });
  expect(quota.burn[0]?.status).toBe("measured");
  expect(quota.burn[0]?.willExhaustBeforeReset).toBe(true);
  const laterReset = dataset();
  laterReset.quota.windows[0]!.resetAtMs = Date.now() + 86_400_000;
  expect(analytics.quotaView(laterReset, { from: now - 86_400_000, to: now }).burn[0]?.willExhaustBeforeReset).toBe(false);
  const baseline = analytics.quotaView(dataset(), { from: now - 60_000, to: now });
  expect(baseline.series[0]?.baselineIncluded).toBe(true);
  expect(baseline.burn[0]?.status).toBe("insufficient");
  expect(analytics.sparkline(rows, now, now + 60_000, "tokens", 4)).toHaveLength(4);
  const composition = analytics.compositionSeries(rows, "day", now, now + 60_000);
  expect(composition.every(point => point.freshInput >= 0)).toBe(true);
  expect(analytics.cumulativeSeries(rows, "day", now, now + 60_000, "tokens")[0]?.cumulative).toBe(200);
  expect(analytics.cacheTimeline(rows, "day", now, now + 60_000)[0]?.hitRate).toBe(0.4);
  expect(analytics.contextPressure(rows).maxInput).toBe(100);
  expect(analytics.round(1.234, 2)).toBe(1.23);
  const nextDay = new Date("2026-03-09T12:00:00-04:00").getTime();
  expect(analytics.bucketStart(nextDay, "day") - analytics.bucketStart(now, "day")).toBe(23 * 60 * 60 * 1000);
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
  const usage = rows.map((r, i) => ({ requestId: r.id, timestamp: r.ts, provider: r.provider, model: r.model, requestedModel: r.requestedModel, effectiveEffort: r.effort, status: r.status, durationMs: r.durationMs, firstOutputMs: r.ttftMs, usageStatus: r.usageStatus, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, totalTokens: r.totalTokens, cacheReadInputTokens: r.cacheReadTokens, cachedInputTokens: r.cacheWriteTokens, reasoningOutputTokens: r.reasoningTokens }, totalTokens: r.totalTokens, cacheProvenance: r.cacheProvenance, conversationId: r.conversationId, attempts: [], routeDecision: { selected: { provider: r.provider, model: r.model } }, errorCode: r.errorCode, spend: { sends: 1, settled: 1 }, _i: i }));
  await writeFile(join(home, "usage.jsonl"), usage.map(x => JSON.stringify(x)).join("\n") + "\n");
  await writeFile(join(home, "spend-ledger.jsonl"), [JSON.stringify({ kind: "dispatch", send: "s1", at: now }), JSON.stringify({ kind: "settle", send: "s1", tokens: 120, at: now })].join("\n") + "\n");
  await writeFile(join(home, "codex-quota-cache.json"), JSON.stringify({ version: 1, history: { accounts: { a: { samples: [{ observedAt: now - 86_400_000, windows: [{ family: "account", window: "weekly", usedPercent: 40 }] }, { observedAt: now, windows: [{ family: "account", window: "weekly", usedPercent: 50 }] }] } } }, quotas: { a: { updatedAt: now, weeklyPercent: 50, weeklyResetAt: Math.floor((now + 7 * 86_400_000) / 1000) } } }));
  process.env.OCX_HOME = home;
  process.env.CLAUDE_PROJECTS_DIR = join(home, "claude-projects");
  const { api } = await import("./api");
  const paths: [string, string][] = [
    ["/api/health", "revision"], ["/api/meta", "totals"], ["/api/overview?range=7d", "summary"],
    ["/api/timeseries?range=7d", "series"], ["/api/models?range=7d", "scatter"], ["/api/usage?range=7d", "composition"],
    ["/api/usage/heatmap-dates?range=all&weekday=6&hour=12&metric=tokens", "dates"],
    ["/api/cost?range=7d", "cumulative"], ["/api/performance?range=7d", "percentiles"], ["/api/reliability?range=7d", "metering"],
    ["/api/quota?range=7d", "burn"], ["/api/ledger?range=7d", "buckets"], ["/api/conversations?range=7d", "conversations"],
    ["/api/conversations/c1", "points"], ["/api/filters?range=7d", "providers"],
  ];
  let etag = "";
  for (const [path, field] of paths) {
    const response = await api.request(path);
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toHaveProperty("ok", true);
    expect(payload).toHaveProperty(field);
    if (path === "/api/overview?range=7d") {
      etag = response.headers.get("etag") ?? "";
      expect(etag.length).toBeGreaterThan(0);
    }
  }
  expect((await api.request("/api/overview?range=7d", { headers: { "if-none-match": etag } })).status).toBe(304);
  const quota = await (await api.request(`/api/quota?from=${now - 60_000}&to=${now}`)).json() as { observed: { samples: number } };
  expect(quota.observed.samples).toBe(1);
  const ledger = await (await api.request(`/api/ledger?from=${now - 60_000}&to=${now}`)).json() as { distinctSends: number };
  expect(ledger.distinctSends).toBe(1);
  expect((await api.request("/api/export?range=7d")).headers.get("content-type")).toContain("text/csv");
  expect((await api.request("/api/conversations/missing")).status).toBe(404);
  const invalidHeatmapDate = await api.request("/api/usage/heatmap-dates?weekday=7&hour=24");
  expect(invalidHeatmapDate.status).toBe(400);
});
