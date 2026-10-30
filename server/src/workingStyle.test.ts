import { describe, expect, test } from "bun:test";
import type { RequestRow } from "./ocx/store";
import { archetypeOf, CONCURRENCY_BIN_MS, recapNotes, workingStyle } from "./workingStyle";

const tz = "UTC";
const from = Date.UTC(2026, 9, 1);
const to = Date.UTC(2026, 9, 11);
const hour = 3_600_000;
const row = (ts: number, conversationId: string | null, overrides: Partial<RequestRow> = {}): RequestRow => ({
  id: `${conversationId}-${ts}`, ts, conversationId, protocol: "responses", provider: "p", model: "m", totalTokens: 10, cost: 1, priced: true, ok: true, status: 200,
  durationMs: 0, errorCode: null, closeReason: null, cacheReadTokens: 0, outputTokens: 0, cwd: null, measurements: { outcome: true },
  ...overrides,
} as RequestRow);
const style = (rows: RequestRow[], now = to, datasetRows?: RequestRow[]) => workingStyle(rows, { tz, from, to, now, datasetRows });
const session = (id: string, count: number, start = from + hour, step = 1000) => Array.from({ length: count }, (_, index) => row(start + index * step, id));

describe("archetypes", () => {
  test("the published edges", () => {
    expect([1, 3].map(n => archetypeOf(n, false))).toEqual(["poke", "poke"]);
    expect([4, 24].map(n => archetypeOf(n, true))).toEqual(["quick", "quick"]);
    expect([25, 999].map(n => archetypeOf(n, false))).toEqual(["deep", "deep"]);
    expect(archetypeOf(1000, false)).toBe("marathon");
    expect(archetypeOf(25, true)).toBe("marathon");
  });

  test("shares of sessions, requests and priced cost, with unpriced and clipped counts", () => {
    const pokes = [...session("a", 1), ...session("b", 3)];
    const quick = session("c", 4).map(item => ({ ...item, priced: false, cost: 0 }));
    const clippedRow = row(from - hour, "a");
    const result = style([...pokes, ...quick], to, [clippedRow, ...pokes, ...quick]);
    const poke = result.archetypes.find(item => item.name === "poke")!;
    expect(poke).toMatchObject({ sessions: 2, requests: 4, sessionShare: 0.6667, requestShare: 0.5, costShare: 1, clippedSessions: 1 });
    expect(result.archetypes.find(item => item.name === "quick")).toMatchObject({ costShare: 0, unpricedRequests: 4, clippedSessions: 0 });
    expect(result.archetypes.find(item => item.name === "marathon")).toMatchObject({ sessions: 0, medianRequests: null });
  });

  test("a session across two local days is a marathon in one zone and deep in another", () => {
    const rows = session("late", 25, Date.UTC(2026, 9, 2, 23, 50), 60_000);
    expect(style(rows).archetypes.find(item => item.name === "marathon")!.sessions).toBe(1);
    const shifted = workingStyle(rows, { tz: "Pacific/Honolulu", from, to, now: to });
    expect(shifted.archetypes.find(item => item.name === "deep")!.sessions).toBe(1);
  });

  test("rows without a session are counted apart, not as sessions", () => {
    expect(style([row(from, null), ...session("a", 1)]).totals).toMatchObject({ sessions: 1, requests: 2, requestsWithoutSession: 1 });
  });
});

test("concurrency counts distinct sessions per 10-minute bin and picks the busiest local day", () => {
  const start = Date.UTC(2026, 9, 3, 10);
  const result = style([row(start, "a"), row(start + 1, "a"), row(start + 2, "b"), row(start + CONCURRENCY_BIN_MS, "c"), row(Date.UTC(2026, 9, 4), "d")]).concurrency;
  expect(result.days).toEqual([{ date: "2026-10-03", peak: 2 }, { date: "2026-10-04", peak: 1 }]);
  expect(result).toMatchObject({ maxPeak: 2, busiestDay: "2026-10-03", medianPeak: 1.5 });
  expect(result.busiestSeries).toEqual([{ ts: start, sessions: 2 }, { ts: start + CONCURRENCY_BIN_MS, sessions: 1 }]);
  expect(result.peakHistogram).toEqual([{ peak: 1, days: 1 }, { peak: 2, days: 1 }]);
});

test("streaks count days with data, and the current run ends today", () => {
  const day = (n: number) => row(from + n * 86_400_000, "a");
  const rows = [day(1), day(2), day(3), day(5), day(9)];
  expect(style(rows).activity).toMatchObject({ activeDays: 5, windowDays: 10, longestStreak: 3, currentStreak: 1 });
  expect(style(rows, from + 8 * 86_400_000).activity.currentStreak).toBe(0);
});

test("hours sum to the requests and night is 00:00 to 05:59 local", () => {
  const rows = [row(from + 0, "a"), row(from + 5 * hour + 59 * 60_000, "a"), row(from + 6 * hour, "a"), row(from + 23 * hour, "a")];
  const result = style(rows);
  expect(result.hours.reduce((sum, item) => sum + item.requests, 0)).toBe(4);
  expect(result.night).toEqual({ requests: 2, share: 0.5 });
});

describe("recap notes", () => {
  test("carry their n, and a thin window says too little data rather than a zero", () => {
    const thin = recapNotes(style(session("a", 2)), null);
    expect(thin[0]!.text).toBe("Too little data for the session mix: 1 of 5 needed.");
    expect(thin.every(note => note.n >= 0)).toBe(true);
    expect(recapNotes(style(session("a", 2)), { id: "abc12345", requests: 2, costUsd: 2 }).at(-1)).toMatchObject({ identifying: true, money: true });
  });

  test("print counts and days the way the page does", () => {
    const rows = ["a", "b", "c", "d", "e"].flatMap(id => session(id, 2_000, Date.UTC(2026, 9, 3, 10), 100));
    const text = recapNotes(style(rows), { id: "x", requests: 2_000, costUsd: 1_234.5 }).map(note => note.text).join(" ");
    expect(text).toContain("of 10,000 requests");
    expect(text).toContain("on Oct 3.");
    expect(text).toContain("made 2,000 requests ($1,234.50 list-price equivalent)");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test("never praise or blame", () => {
    const rows = ["a", "b", "c", "d", "e", "f"].flatMap(id => session(id, 5));
    const text = recapNotes(style(rows), { id: "x", requests: 5, costUsd: null }).map(note => note.text).join(" ").toLowerCase();
    expect(text).not.toMatch(/great|good|bad|impressive|productive|too much|overwork|healthy|keep it up/);
  });
});
