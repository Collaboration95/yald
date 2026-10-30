import { describe, expect, test } from "bun:test";
import { ROLLOUT_ACCOUNT } from "../codex/quota";
import type { Dataset, QuotaSample, RequestRow } from "../ocx/store";
import { buildEvidenceCase } from "./evidence";
import { EvidenceIntentError, parseCaseIntent } from "./evidence-intent";
import { buildQuotaPace, EXCHANGE_MIN_INTERVALS, windowLengthMs } from "./quota";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// A Monday, midnight UTC.
const monday = Date.UTC(2026, 9, 5);
const sample = (observedAt: number, usedPercent: number, resetAtMs: number | null, overrides: Partial<QuotaSample> = {}): QuotaSample =>
  ({ account: "acct", family: "account", window: "weekly", usedPercent, resetAtMs, observedAt, source: "opencodex", ...overrides });
const quota = (samples: QuotaSample[], windows: Dataset["quota"]["windows"] = []): Dataset["quota"] => ({ samples, windows, updatedAt: null });
const pace = (data: Dataset["quota"], now: number, rows: RequestRow[] = [], tz = "UTC") => buildQuotaPace(data, rows, { now, tz }).entries;
const request = (ts: number, totalTokens: number, account = "acct") => ({ id: `q${ts}`, ts, account, totalTokens, inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.5, priced: true, protocol: "responses", provider: "openai", model: "m", conversationId: null, cwd: null,
  measurements: { input: true, output: true, cacheRead: false, cacheWrite: false, usage: "logical", duration: true, ttft: false } } as unknown as RequestRow);
/** A past instance that burns `points` over `monday + start` for one day, with samples at both ends. */
const pastWeek = (week: number, points: number, day = 0): QuotaSample[] => {
  const start = monday + week * WEEK;
  return [sample(start + day * DAY + HOUR, 0, start + WEEK), sample(start + day * DAY + 13 * HOUR, points, start + WEEK)];
};

test("window lengths come from the names both sources use", () => {
  expect(["weekly", "7d", "monthly", "fiveHour", "daily", "90m", "odd"].map(windowLengthMs)).toEqual([WEEK, WEEK, 30 * DAY, 5 * HOUR, DAY, 90 * 60_000, null]);
});

describe("pace", () => {
  const reset = monday + WEEK;

  test("works from a single opencodex snapshot and shows its age", () => {
    const now = monday + 2 * DAY;
    const [entry] = pace(quota([], [{ account: "acct", window: "weekly", usedPercent: 40, resetAtMs: reset, updatedAt: now - HOUR }]), now);
    expect(entry).toMatchObject({ state: "current", sources: ["snapshot"], age: { ageMs: HOUR, fresh: true } });
    expect(entry!.pace!.deltaPoints).toBeCloseTo(40 - 100 * (2 * DAY - HOUR) / WEEK, 1);
    expect(entry!.forecast!.state).toBe("insufficient");
  });

  test("after the reset the window is expired and shows no percentage", () => {
    const [entry] = pace(quota([sample(monday + DAY, 40, reset)]), reset + 1);
    expect(entry).toMatchObject({ state: "expired", pace: null, forecast: null });
  });

  test("a stale sample from a parallel session does not read as a fall", () => {
    const [entry] = pace(quota([sample(monday, 0, reset), sample(monday + HOUR, 30, reset), sample(monday + 2 * HOUR, 1, reset)]), monday + 3 * HOUR);
    expect(entry!.pace!.usedPercent).toBe(30);
  });

  test("reset times a few seconds apart are one window, and hours apart are two", () => {
    const entries = pace(quota([sample(monday, 0, reset), sample(monday + HOUR, 5, reset + 40_000), sample(monday + 2 * HOUR, 9, reset + 3 * HOUR)]), monday + 3 * HOUR);
    expect(entries[0]).toMatchObject({ instanceCount: 2, otherOpenWindows: 1, instance: { samples: 1 } });
  });

  test("a sample with no reset is counted, not placed", () => {
    expect(pace(quota([sample(monday, 5, null)]), monday + HOUR)[0]).toMatchObject({ state: "no-reset", samplesWithoutReset: 1, pace: null });
  });

  test("an unknown window has no pace", () => {
    expect(pace(quota([sample(monday, 5, reset, { window: "odd" })]), monday + HOUR)[0]).toMatchObject({ state: "unknown-length", pace: null, evidence: null });
  });

  test("a sample from the future is not read", () => {
    expect(pace(quota([sample(monday + DAY, 5, reset)]), monday)).toHaveLength(0);
  });
});

describe("forecast", () => {
  const start = monday + 3 * WEEK;
  const now = start + DAY;
  const current = [sample(start + HOUR, 0, start + WEEK), sample(now, 50, start + WEEK)];

  test("a reset inside the history is not burn: each instance climbs from its own start", () => {
    const history = [...pastWeek(0, 80), ...pastWeek(1, 80), ...pastWeek(2, 80)];
    const [entry] = pace(quota([...history, ...current]), now + HOUR);
    const monday80 = entry!.forecast!.weekdays.find(day => day.weekday === "Mon")!;
    expect(monday80).toMatchObject({ days: 3, instances: 3, usesPooled: false });
    expect(monday80.burn!.median).toBeCloseTo(80, 5);
  });

  test("a gap over 24 hours is unobserved, not zero", () => {
    const s = monday + 4 * WEEK;
    const gap = [sample(s, 0, s + WEEK), sample(s + 3 * DAY, 30, s + WEEK)];
    const [entry] = pace(quota([...pastWeek(0, 10), ...pastWeek(1, 10), ...gap, sample(s + 3 * DAY + HOUR, 30, s + 2 * WEEK)]), s + 3 * DAY + 2 * HOUR);
    expect(entry!.forecast!.history).toMatchObject({ excludedGaps: 1, days: 2 });
    expect(entry!.forecast!.weekdays.find(day => day.weekday === "Tue")!.days).toBe(0);
  });

  test("two samples and no change is a real zero day", () => {
    const s = monday + 5 * WEEK;
    const flat = [sample(s + HOUR, 20, s + WEEK), sample(s + 5 * HOUR, 20, s + WEEK)];
    const [entry] = pace(quota([...flat, sample(s + 6 * HOUR, 0, s + 2 * WEEK)]), s + 7 * HOUR);
    expect(entry!.forecast!.weekdays.find(day => day.weekday === "Mon")).toMatchObject({ days: 1, instances: 1 });
    expect(entry!.forecast!.history.days).toBe(1);
  });

  test("burn is split at local midnight, in the selected time zone", () => {
    const s = monday + 6 * WEEK;
    const over = [sample(s + 23 * HOUR, 0, s + WEEK), sample(s + 25 * HOUR, 10, s + WEEK)];
    const utc = pace(quota([...over, sample(s + 26 * HOUR, 0, s + 2 * WEEK)]), s + 27 * HOUR)[0]!;
    expect(utc.forecast!.history.days).toBe(2);
    const shifted = pace(quota([...over, sample(s + 26 * HOUR, 0, s + 2 * WEEK)]), s + 27 * HOUR, [], "Asia/Singapore")[0]!;
    expect(shifted.forecast!.history.days).toBe(1);
  });

  test("a weekday with too little history uses all days pooled, and says so", () => {
    const history = [...pastWeek(0, 80), ...pastWeek(1, 80), ...pastWeek(2, 80, 1)];
    const [entry] = pace(quota([...history, ...current]), now + HOUR);
    expect(entry!.forecast!.weekdays.find(day => day.weekday === "Tue")).toMatchObject({ instances: 1, usesPooled: true });
    expect(entry!.forecast!.weekdays.find(day => day.weekday === "Tue")!.burn!.median).toBeCloseTo(80, 5);
  });

  test("too little history gives no range and no date", () => {
    const [entry] = pace(quota([...pastWeek(0, 80), ...pastWeek(1, 80), ...current]), now + HOUR);
    expect(entry!.forecast).toMatchObject({ state: "insufficient", paths: null, earliestAt: null, latestAt: null });
  });

  test("the range gives earliest and latest and counts paths, never one date", () => {
    const history = [...pastWeek(0, 1), ...pastWeek(1, 2, 1), ...pastWeek(2, 40, 2)];
    const [entry] = pace(quota([...history, ...current]), now + HOUR);
    const forecast = entry!.forecast!;
    expect(forecast.state).toBe("range");
    expect(forecast.runsOutIn).toBeGreaterThan(0);
    expect(forecast.runsOutIn).toBeLessThan(3);
    expect(forecast.latestAt).toBeNull();
    expect(entry!.chart.filter(point => point.typical !== null).length).toBeGreaterThan(0);
  });

  test("a short window has no range", () => {
    const fiveHour = (at: number, used: number, reset: number) => sample(at, used, reset, { window: "fiveHour" });
    const [entry] = pace(quota([fiveHour(monday, 10, monday + 5 * HOUR), fiveHour(monday + DAY, 10, monday + DAY + 5 * HOUR)]), monday + DAY + HOUR);
    expect(entry!.forecast!.state).toBe("not-applicable");
  });
});

describe("exchange rate", () => {
  const reset = monday + WEEK;
  const steps = (count: number) => Array.from({ length: count + 1 }, (_, index) => sample(monday + index * HOUR, index, reset));
  const rows = Array.from({ length: 11 }, (_, index) => request(monday + index * HOUR - 1000, 1000));

  test("pools tokens over points and reports the spread", () => {
    const [entry] = pace(quota(steps(EXCHANGE_MIN_INTERVALS)), monday + 12 * HOUR, rows);
    expect(entry!.exchange).toMatchObject({ state: "available", tokensPerPoint: 1000, costPerPoint: 0.5, spread: { p25: 1000, p75: 1000 }, intervals: EXCHANGE_MIN_INTERVALS });
  });

  test("the request at a sample's own time counts in the interval it ends", () => {
    const [entry] = pace(quota(steps(EXCHANGE_MIN_INTERVALS)), monday + 12 * HOUR, Array.from({ length: 10 }, (_, index) => request(monday + (index + 1) * HOUR, 500)));
    expect(entry!.exchange.tokensPerPoint).toBe(500);
  });

  test("excludes reset, fell, no-change and gap intervals, and counts them", () => {
    const later = reset + WEEK;
    const samples = [...steps(EXCHANGE_MIN_INTERVALS), sample(monday + 11 * HOUR, 10, reset), sample(monday + 12 * HOUR, 9, reset),
      sample(monday + 40 * HOUR, 15, reset), sample(reset + HOUR, 1, later)];
    const [entry] = pace(quota(samples), reset + 2 * HOUR, rows);
    expect(entry!.exchange).toMatchObject({ intervals: EXCHANGE_MIN_INTERVALS, excluded: { "no-change": 1, fell: 1, gap: 1, reset: 1 } });
  });

  test("below the minimums it is unavailable, with the count", () => {
    const [entry] = pace(quota(steps(EXCHANGE_MIN_INTERVALS - 1)), monday + 12 * HOUR, rows);
    expect(entry!.exchange).toMatchObject({ state: "unavailable", reason: "too-few-intervals", intervals: EXCHANGE_MIN_INTERVALS - 1, tokensPerPoint: null });
  });

  test("without an account join it is unavailable, never zero", () => {
    const rollout = steps(EXCHANGE_MIN_INTERVALS).map(entry => ({ ...entry, account: ROLLOUT_ACCOUNT, source: "rollout" }));
    expect(pace(quota(rollout), monday + 12 * HOUR, rows)[0]!.exchange).toMatchObject({ state: "unavailable", reason: "no-account-join", tokensPerPoint: null });
    expect(pace(quota(steps(EXCHANGE_MIN_INTERVALS)), monday + 12 * HOUR, [])[0]!.exchange).toMatchObject({ reason: "no-account-join" });
  });
});

describe("fixed case", () => {
  const reset = monday + WEEK;
  const data = quota([sample(monday - DAY, 90, monday), sample(monday + HOUR, 0, reset), sample(monday + 2 * HOUR, 5, reset), sample(monday + 3 * HOUR, 5, reset), sample(monday + 4 * HOUR, 3, reset)]);
  const rows = [request(monday + 90 * 60_000, 700), request(monday + 100 * 60_000, 300), request(monday + 90 * 60_000, 50, "other")];
  const now = monday + 5 * HOUR;
  const selector = pace(data, now, rows)[0]!.evidence!.selector;
  const intent = (extra: Record<string, string> = {}, value: unknown = selector) => parseCaseIntent(new URLSearchParams({ investigation: "quota-pace", selector: JSON.stringify(value), ...extra }));
  const run = (extra: Record<string, string> = {}) => buildEvidenceCase(rows, intent(extra), [], { quota: data, now });

  test("lists intervals with their exclusion reasons, not requests", () => {
    const body = run();
    expect(body.rows).toHaveLength(0);
    if (body.observation.investigation !== "quota-pace") throw new Error("wrong observation");
    expect(body.observation.intervals.map(interval => [interval.exclusion, interval.tokens])).toEqual([["reset", 0], [null, 1000], ["no-change", 0], ["fell", 0]]);
    expect(body.observation).toMatchObject({ joined: true, state: "observed", samples: 4, intervalPage: { total: 4 } });
  });

  test("an interval opens its requests in the evidence row shape, for this account only", () => {
    const body = run({ interval: "1" });
    expect(body.rows.map(row => row.id).sort()).toEqual([rows[0]!.id, rows[1]!.id].sort());
    expect(body.page.total).toBe(2);
  });

  test("the case survives the window ending and pages its intervals", () => {
    const body = buildEvidenceCase(rows, intent({ limit: "1", offset: "1" }), [], { quota: data, now: reset + DAY });
    if (body.observation.investigation !== "quota-pace") throw new Error("wrong observation");
    expect(body.observation.intervals[0]).toMatchObject({ index: 1, exclusion: null });
    expect(body.observation.intervalPage).toMatchObject({ offset: 1, nextOffset: 2 });
  });

  test("rollout samples list intervals with request figures unavailable", () => {
    const rollout = quota(data.samples.map(entry => ({ ...entry, account: ROLLOUT_ACCOUNT, source: "rollout" })));
    const value = { ...selector, selection: { kind: "account", account: ROLLOUT_ACCOUNT, window: "weekly" } };
    const body = buildEvidenceCase(rows, intent({}, value), [], { quota: rollout, now });
    if (body.observation.investigation !== "quota-pace") throw new Error("wrong observation");
    expect(body.observation.joined).toBe(false);
    expect(body.observation.intervals[1]).toMatchObject({ requests: null, tokens: null, costUsd: null });
  });

  test("invalid selectors and intervals are refused", () => {
    const refused = [
      { ...selector, selection: { kind: "scope" } }, { ...selector, selection: { kind: "account", account: "a" } }, { ...selector, selection: { kind: "account", account: "", window: "weekly" } },
      { ...selector, cohort: { ...selector.cohort, sources: ["claude-code"] } }, { ...selector, eligibility: "cache" },
    ];
    for (const value of refused) expect(() => intent({}, value)).toThrow(EvidenceIntentError);
    expect(() => run({ interval: "99" })).toThrow(EvidenceIntentError);
    expect(() => parseCaseIntent(new URLSearchParams({ investigation: "cache-detective", selector: JSON.stringify(selector), interval: "1" }))).toThrow(EvidenceIntentError);
    const account = { ...selector, eligibility: "cache" };
    expect(() => parseCaseIntent(new URLSearchParams({ investigation: "cache-detective", selector: JSON.stringify(account) }))).toThrow(EvidenceIntentError);
  });

  test("nothing is split by project or model", () => {
    const text = JSON.stringify(pace(data, now, rows).map(({ evidence: _evidence, ...entry }) => entry)).toLowerCase();
    for (const word of ['"project', '"model']) expect(text).not.toContain(word);
  });
});
