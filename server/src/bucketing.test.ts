import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as analytics from "./analytics";
import type { RequestRow } from "./ocx/store";
import { zonedBucketStart } from "./time/window";

// Every per-row bucketing loop reads memoized buckets (#98). These tests hold each one to the
// exact per-row answer in zones with DST changes, half-hour DST and odd offsets, with rows out of order.

const H = 3_600_000;
const D = 24 * H;

function row(id: number, ts: number): RequestRow {
  return {
    measurements: { outcome: true, duration: true, ttft: id % 3 !== 0, retries: true, input: true, output: true, cacheRead: true, cacheWrite: true, usage: "logical" },
    id: `r${id}`, ts, provider: id % 2 ? "openai" : "anthropic", model: `m${id % 4}`, requestedModel: null, resolvedModel: null,
    effort: "high", status: id % 7 ? 200 : 502, ok: id % 7 !== 0, durationMs: 100 + (id * 37) % 5000, ttftMs: id % 3 ? 50 + (id * 13) % 900 : null,
    inputTokens: 100 + id % 50, outputTokens: 20 + id % 9, cacheReadTokens: 40, cacheWriteTokens: 10, reasoningTokens: 2, totalTokens: 120 + id % 59,
    cost: 0.01 + (id % 5) / 1000, priced: true, estimated: false, rateIn: 1, rateOut: 2, rateCacheRead: 0.1, rateCacheWrite: 0.2,
    conversationId: `c${id % 6}`, errorCode: id % 7 ? null : "upstream", closeReason: null, routeKind: "native", account: null,
    protocol: "responses", attempts: 1, sends: 1, settled: 1, unresolved: 0, cacheProvenance: "observed", contextTier: null,
    serviceTier: "default", retried: false, usageFromAttempts: false, usageStatus: "reported", attemptTokens: 120, cwd: null,
  };
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Rows over [from, to): random instants plus rows on every hour edge, shuffled. */
function rowsBetween(from: number, to: number, count: number, seed: number): RequestRow[] {
  const random = seeded(seed);
  const instants: number[] = [];
  for (let i = 0; i < count; i++) instants.push(Math.floor(from + random() * (to - from)));
  for (let ts = from; ts < to; ts += H) instants.push(ts, ts - 1);
  const rows = instants.filter(ts => ts >= from && ts < to).map((ts, i) => row(i, ts));
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rows[i], rows[j]] = [rows[j]!, rows[i]!];
  }
  return rows;
}

const CASES = [
  { tz: "America/New_York", centre: "2026-11-01T06:00:00Z" },
  { tz: "Europe/London", centre: "2026-03-29T01:00:00Z" },
  { tz: "Australia/Lord_Howe", centre: "2026-10-03T15:30:00Z" },
  { tz: "Asia/Kathmandu", centre: "2026-10-11T00:00:00Z" },
  { tz: "Asia/Kolkata", centre: "2026-10-11T00:00:00Z" },
  { tz: "Pacific/Chatham", centre: "2026-04-04T14:00:00Z" },
];

/** The pre-#98 heatmap reader: one formatToParts per row. */
const referenceFormatters = new Map<string, Intl.DateTimeFormat>();
function referenceParts(ts: number, timeZone: string) {
  let formatter = referenceFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23" });
    referenceFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(ts);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "00";
  const weekdays: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: weekdays[get("weekday")] ?? 0, hour: Number(get("hour")) };
}

describe.each(CASES)("memoized buckets in $tz", ({ tz, centre }) => {
  const from = Date.parse(centre) - 3 * D;
  const to = Date.parse(centre) + 3 * D;
  // Shuffled rows mostly miss the remembered bucket and take the exact path, so keep this small.
  const rows = rowsBetween(from, to, 300, tz.length);
  /** Rows per bucket, from one exact zonedBucketStart call per row. */
  const count = (unit: analytics.Bucket) => {
    const counts = new Map<number, number>();
    for (const r of rows) {
      const start = zonedBucketStart(r.ts, unit, tz);
      counts.set(start, (counts.get(start) ?? 0) + 1);
    }
    return counts;
  };

  test.each(["hour", "day", "week"] as const)("every %s series puts each row in its exact bucket", unit => {
    const expected = count(unit);
    const counted = (points: { ts: number; requests?: number; totalRequests?: number }[]) =>
      new Map(points.filter(point => (point.requests ?? point.totalRequests)! > 0).map(point => [point.ts, point.requests ?? point.totalRequests]));
    expect(counted(analytics.buildSeries(rows, { bucket: unit, metric: "requests", groupBy: "model", from, to, tz }).buckets)).toEqual(expected);
    expect(counted(analytics.cumulativeSeries(rows, unit, from, to, "requests", tz))).toEqual(expected);
    expect(counted(analytics.cacheTimeline(rows, unit, from, to, tz))).toEqual(expected);
    expect(counted(analytics.compositionSeries(rows, unit, from, to, tz))).toEqual(expected);
    expect(counted(analytics.latencyTimeline(rows, unit, from, to, tz).points)).toEqual(expected);
    // The same rows in time order give the same series as shuffled ones.
    const sorted = [...rows].sort((a, b) => a.ts - b.ts);
    expect(analytics.latencyTimeline(sorted, unit, from, to, tz)).toEqual(analytics.latencyTimeline(rows, unit, from, to, tz));
  });

  test("reliability days and heatmap cells match the per-row readers", () => {
    const days = count("day");
    const timeline = analytics.reliability(rows, tz).errorTimeline;
    expect(new Map(timeline.map(slot => [slot.ts, slot.ok + slot.error + slot.cancelled + slot.unobserved]))).toEqual(days);

    const cells = new Map<string, number>();
    const byDate = new Map<string, number>();
    for (const r of rows) {
      const parts = referenceParts(r.ts, tz);
      cells.set(`${parts.weekday}:${parts.hour}`, (cells.get(`${parts.weekday}:${parts.hour}`) ?? 0) + 1);
      if (parts.weekday === 6 && parts.hour === 1) byDate.set(parts.date, (byDate.get(parts.date) ?? 0) + 1);
    }
    const heatmap = analytics.heatmap(rows, "requests", tz);
    expect(new Map(heatmap.cells.filter(cell => cell.requests > 0).map(cell => [`${cell.weekday}:${cell.hour}`, cell.requests]))).toEqual(cells);
    const detail = analytics.heatmapDateBreakdown(rows, { weekday: 6, hour: 1, metric: "requests", timeZone: tz, limit: 100 });
    expect(new Map(detail.dates.map(date => [date.date, date.requests]))).toEqual(byDate);
  });
});

describe("formatToParts work no longer scales with rows", () => {
  let spy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => { spy?.mockRestore(); spy = null; });

  const tz = "America/New_York";
  const from = Date.parse("2026-10-30T00:00:00-04:00");
  const to = from + 4 * D;
  /** Evenly spaced rows: every hour of the window has rows at both sizes. */
  const evenly = (count: number) => Array.from({ length: count }, (_, i) => row(i, from + Math.floor((i * (to - from)) / count)));
  const calls = (rows: RequestRow[]) => {
    spy = spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    for (const unit of ["hour", "day"] as const) {
      analytics.buildSeries(rows, { bucket: unit, metric: "cost", groupBy: "model", from, to, tz });
      analytics.cumulativeSeries(rows, unit, from, to, "cost", tz);
      analytics.cacheTimeline(rows, unit, from, to, tz);
      analytics.compositionSeries(rows, unit, from, to, tz);
      analytics.latencyTimeline(rows, unit, from, to, tz);
    }
    analytics.reliability(rows, tz);
    analytics.heatmap(rows, "tokens", tz);
    analytics.heatmapDateBreakdown(rows, { weekday: 0, hour: 9, metric: "tokens", timeZone: tz });
    const total = spy.mock.calls.length;
    spy.mockRestore();
    spy = null;
    return total;
  };

  test("ten times the rows in the same buckets make the same number of zone lookups", () => {
    const small = calls(evenly(2_000));
    const large = calls(evenly(20_000));
    expect(large).toBe(small);
    // Per-row readers made about five lookups per row in each of these twelve passes;
    // the memoized ones make a fixed number per bucket, fewer in total than there are rows.
    expect(large).toBeLessThan(20_000);
  });
});

/** The pre-#98 percentile: copy, sort with a comparator, interpolate. */
function referencePercentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

test("percentiles from one sorted sample equal the copying implementation", () => {
  const random = seeded(42);
  const arrays: number[][] = [[], [7], [3, 3, 3], [5, 1], [0, 0, 1, 1, 2, 2], [-4, 10.5, 1e9, 0.1, 3]];
  for (let i = 0; i < 200; i++) {
    const length = 1 + Math.floor(random() * 300);
    arrays.push(Array.from({ length }, () => (random() < 0.3 ? Math.floor(random() * 10) : random() * 10_000 - 100)));
  }
  const ps = [0, 0.001, 0.1, 0.25, 0.5, 0.9, 0.95, 0.99, 1];
  for (const values of arrays) {
    const sorted = analytics.sortedSample(values);
    for (const p of ps) {
      const expected = referencePercentile(values, p);
      expect(analytics.percentile(values, p)).toBe(expected);
      expect(analytics.percentileOfSorted(sorted, p)).toBe(expected);
    }
  }
  expect(analytics.percentile([], 0.5)).toBeNull();
});

test("topN keeps exactly the rows and tie order of a full stable sort", () => {
  const random = seeded(7);
  for (let round = 0; round < 200; round++) {
    const items = Array.from({ length: Math.floor(random() * 120) }, (_, i) => ({ i, value: Math.floor(random() * 8) }));
    for (const limit of [0, 1, 3, 10, 25, 40, 500]) {
      const desc = (a: { value: number }, b: { value: number }) => b.value - a.value;
      const asc = (a: { value: number }, b: { value: number }) => a.value - b.value;
      expect(analytics.topN(items, limit, desc)).toEqual([...items].sort(desc).slice(0, limit));
      expect(analytics.topN(items, limit, asc)).toEqual([...items].sort(asc).slice(0, limit));
    }
  }
});
