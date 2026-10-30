// Quota pace (#110): where a quota window stands against an even pace, a range of scenarios from past
// weekday burn, and an observed ratio between quota points and recorded tokens. Account-scoped only:
// nothing here is split by project or model, and the ratio is not a conversion rule.
import { bucketer, percentile, round } from "../analytics";
import type { Dataset, QuotaSample, RequestRow } from "../ocx/store";
import { nextBucketStart } from "../time/window";
import { ROLLOUT_ACCOUNT } from "../codex/quota";
import { evidenceFor } from "./scope";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/**
 * Samples of one window instance report a reset time a few seconds apart. Real rollouts spread by up to
 * two minutes, and the next instance on the same label is hours away at the least.
 */
const RESET_TOLERANCE_MS = 5 * MINUTE;
/** A longer gap between samples is unobserved, not a day of no use. */
export const MAX_GAP_MS = DAY;
export const FRESH_MS = DAY;
/** A weekday seen in fewer past instances uses the pooled all-days burn. */
export const WEEKDAY_MIN_INSTANCES = 3;
export const FORECAST_MIN_INSTANCES = 3;
export const EXCHANGE_MIN_INTERVALS = 10;
export const EXCHANGE_MIN_POINTS = 5;
const CHART_STEPS = 96;
const RATIO_POINTS = 200;

export function windowLengthMs(window: string): number | null {
  const minutes = /^(\d+)m$/.exec(window);
  if (minutes) return Number(minutes[1]) * MINUTE;
  if (/week|7d/i.test(window)) return 7 * DAY;
  if (/month|30d/i.test(window)) return 30 * DAY;
  if (/five.?hour|5h/i.test(window)) return 5 * HOUR;
  if (/dai|24h|1d/i.test(window)) return DAY;
  return null;
}

interface Sample { ts: number; usedPercent: number; resetAtMs: number; source: string }
/** The period between two resets. `used` is the running maximum: a stale snapshot is not a fall in usage. */
interface Instance { resetAtMs: number; samples: Sample[]; used: number[] }

function instancesOf(samples: Sample[]): Instance[] {
  const byReset = [...samples].sort((a, b) => a.resetAtMs - b.resetAtMs || a.ts - b.ts);
  const groups: Sample[][] = [];
  let last = 0;
  for (const sample of byReset) {
    if (groups.length && sample.resetAtMs - last <= RESET_TOLERANCE_MS) groups.at(-1)!.push(sample);
    else groups.push([sample]);
    last = sample.resetAtMs;
  }
  return groups.map(group => {
    const ordered = [...group].sort((a, b) => a.ts - b.ts);
    let peak = 0;
    return { resetAtMs: group[0]!.resetAtMs, samples: ordered, used: ordered.map(sample => (peak = Math.max(peak, sample.usedPercent))) };
  });
}

const weekdayName = (tz: string) => {
  const format = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz });
  return (ts: number) => format.format(ts);
};
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Burn per local day, split at local midnight in proportion to time. A day inside a gap over 24 hours has no entry. */
function dayBurns(instance: Instance, tz: string, dayOf: (ts: number) => number): { days: Map<number, number>; gaps: number } {
  const days = new Map<number, number>();
  let gaps = 0;
  instance.samples.forEach((sample, index) => {
    if (!index) return;
    const from = instance.samples[index - 1]!.ts;
    const to = sample.ts;
    const change = instance.used[index]! - instance.used[index - 1]!;
    if (to - from > MAX_GAP_MS) { gaps++; return; }
    const firstDay = dayOf(from);
    if (firstDay === dayOf(to)) {
      days.set(firstDay, (days.get(firstDay) ?? 0) + change);
      return;
    }
    for (let day = firstDay; day < to; day = nextBucketStart(day, "day", tz)) {
      const overlap = Math.min(to, nextBucketStart(day, "day", tz)) - Math.max(from, day);
      days.set(day, (days.get(day) ?? 0) + change * overlap / (to - from));
    }
  });
  return { days, gaps };
}

interface Burn { p25: number; median: number; p75: number }
const burnOf = (values: number[]): Burn => ({ p25: percentile(values, 0.25)!, median: percentile(values, 0.5)!, p75: percentile(values, 0.75)! });

function weekdayProfile(past: Instance[], tz: string) {
  const weekday = weekdayName(tz);
  const seen = new Map<string, { values: number[]; instances: Set<number> }>(WEEKDAYS.map(name => [name, { values: [], instances: new Set() }]));
  const pool: number[] = [];
  const dayOf = bucketer("day", tz);
  let gaps = 0;
  past.forEach((instance, index) => {
    const burns = dayBurns(instance, tz, dayOf);
    gaps += burns.gaps;
    for (const [day, burn] of burns.days) {
      const entry = seen.get(weekday(day))!;
      entry.values.push(burn);
      entry.instances.add(index);
      pool.push(burn);
    }
  });
  const pooled = pool.length ? burnOf(pool) : null;
  const weekdays = WEEKDAYS.map(name => {
    const { values, instances } = seen.get(name)!;
    const own = instances.size >= WEEKDAY_MIN_INSTANCES;
    const burn = own ? burnOf(values) : pooled;
    return { weekday: name, days: values.length, instances: instances.size, usesPooled: !own, burn };
  });
  return { weekdays, days: pool.length, gaps, instances: past.filter((_, index) => [...seen.values()].some(entry => entry.instances.has(index))).length };
}

type Path = "low" | "typical" | "high";
const PATH_BURN: Record<Path, keyof Burn> = { low: "p25", typical: "median", high: "p75" };

/** Walks local days from the latest sample to the reset. Each path stops at 100%. */
function walk(path: Path, start: number, used: number, resetAtMs: number, tz: string, weekdays: ReturnType<typeof weekdayProfile>["weekdays"]) {
  const weekday = weekdayName(tz);
  const dayOf = bucketer("day", tz);
  const points: { ts: number; used: number }[] = [{ ts: start, used }];
  let at = start;
  let level = used;
  while (at < resetAtMs) {
    const dayStart = dayOf(at);
    const dayEnd = nextBucketStart(dayStart, "day", tz);
    const end = Math.min(dayEnd, resetAtMs);
    const burn = weekdays.find(entry => entry.weekday === weekday(dayStart))!.burn![PATH_BURN[path]] * (end - at) / (dayEnd - dayStart);
    if (level + burn >= 100) {
      const runsOutAt = Math.round(at + (end - at) * (100 - level) / burn);
      points.push({ ts: runsOutAt, used: 100 });
      return { runsOutAt, points };
    }
    level += burn;
    at = end;
    points.push({ ts: at, used: level });
  }
  return { runsOutAt: null, points };
}

const pathAt = (points: { ts: number; used: number }[], ts: number): number | null => {
  if (ts < points[0]!.ts) return null;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!, b = points[index]!;
    if (ts <= b.ts) return b.ts === a.ts ? b.used : a.used + (b.used - a.used) * (ts - a.ts) / (b.ts - a.ts);
  }
  return points.at(-1)!.used;
};

function forecast(current: Instance, past: Instance[], lengthMs: number, tz: string) {
  const profile = weekdayProfile(past, tz);
  const history = { instances: profile.instances, days: profile.days, samples: past.reduce((sum, instance) => sum + instance.samples.length, 0), excludedGaps: profile.gaps };
  const base = { weekdays: profile.weekdays.map(({ burn, ...entry }) => ({ ...entry, burn: burn && { p25: round(burn.p25, 2), median: round(burn.median, 2), p75: round(burn.p75, 2) } })), history };
  if (lengthMs < 7 * DAY) return { state: "not-applicable" as const, ...base, paths: null, runsOutIn: null, earliestAt: null, latestAt: null, curves: null };
  if (profile.instances < FORECAST_MIN_INSTANCES) return { state: "insufficient" as const, ...base, paths: null, runsOutIn: null, earliestAt: null, latestAt: null, curves: null };
  const start = current.samples.at(-1)!.ts;
  const used = current.used.at(-1)!;
  const curves = Object.fromEntries((Object.keys(PATH_BURN) as Path[]).map(path => [path, walk(path, start, used, current.resetAtMs, tz, profile.weekdays)])) as Record<Path, ReturnType<typeof walk>>;
  const dates = Object.values(curves).flatMap(curve => curve.runsOutAt ?? []);
  return {
    state: "range" as const, ...base,
    paths: { low: curves.low.runsOutAt, typical: curves.typical.runsOutAt, high: curves.high.runsOutAt },
    runsOutIn: dates.length,
    /** The range, never one date. `latestAt` is null when a path reaches the reset first. */
    earliestAt: dates.length ? Math.min(...dates) : null,
    latestAt: dates.length === 3 ? Math.max(...dates) : null,
    curves,
  };
}

interface AccountRequests { ts: number[]; rows: RequestRow[]; tokens: number[]; freshInput: number[]; cacheRead: number[]; output: number[]; cost: number[]; priced: number[] }

/** Prefix sums over one account's requests in time order: a pair of samples costs two binary searches. */
function accountRequests(rows: readonly RequestRow[]): Map<string, AccountRequests> {
  const grouped = new Map<string, RequestRow[]>();
  for (const row of rows) {
    if (!row.account) continue;
    const list = grouped.get(row.account);
    if (list) list.push(row);
    else grouped.set(row.account, [row]);
  }
  const result = new Map<string, AccountRequests>();
  for (const [account, list] of grouped) {
    const ordered = [...list].sort((a, b) => a.ts - b.ts);
    const prefix = (read: (row: RequestRow) => number) => {
      const sums = [0];
      for (const row of ordered) sums.push(sums.at(-1)! + read(row));
      return sums;
    };
    result.set(account, {
      ts: ordered.map(row => row.ts), rows: ordered, tokens: prefix(row => row.totalTokens),
      freshInput: prefix(row => Math.max(0, row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens)), cacheRead: prefix(row => row.cacheReadTokens),
      output: prefix(row => row.outputTokens), cost: prefix(row => (row.priced ? row.cost : 0)), priced: prefix(row => (row.priced ? 1 : 0)),
    });
  }
  return result;
}

/** The count of requests at or before `ts`. An interval (a, b] is `upTo(b) - upTo(a)`. */
function upTo(timestamps: number[], ts: number): number {
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (timestamps[middle]! <= ts) low = middle + 1;
    else high = middle;
  }
  return low;
}

export type IntervalExclusion = "reset" | "fell" | "no-change" | "gap";

/** Every pair of consecutive samples of one account and window, oldest first, with the reason it does not count. */
function intervalsOf(instances: Instance[], requests: AccountRequests | null) {
  const ordered = instances.flatMap((instance, position) => instance.samples.map(sample => ({ sample, position }))).sort((a, b) => a.sample.ts - b.sample.ts);
  return ordered.slice(1).map((after, index) => {
    const before = ordered[index]!;
    const a = before.sample, b = after.sample;
    const change = b.usedPercent - a.usedPercent;
    const exclusion: IntervalExclusion | null = before.position !== after.position ? "reset" : change < 0 ? "fell" : change === 0 ? "no-change" : b.ts - a.ts > MAX_GAP_MS ? "gap" : null;
    const first = requests ? upTo(requests.ts, a.ts) : 0;
    const last = requests ? upTo(requests.ts, b.ts) : 0;
    const sum = (values: number[]) => values[last]! - values[first]!;
    return {
      fromTs: a.ts, toTs: b.ts, resetAtMs: instances[after.position]!.resetAtMs, usedBefore: a.usedPercent, usedAfter: b.usedPercent, change, exclusion,
      requests: requests ? last - first : null, tokens: requests ? sum(requests.tokens) : null,
      costUsd: requests ? (sum(requests.priced) ? round(sum(requests.cost), 6) : null) : null, firstRequest: first, lastRequest: last,
      mix: requests ? { freshInput: sum(requests.freshInput), cacheRead: sum(requests.cacheRead), output: sum(requests.output) } : null,
    };
  });
}

function exchangeRate(intervals: ReturnType<typeof intervalsOf>, joined: boolean) {
  const excluded = { reset: 0, fell: 0, "no-change": 0, gap: 0 } satisfies Record<IntervalExclusion, number>;
  for (const interval of intervals) if (interval.exclusion) excluded[interval.exclusion]++;
  const usable = intervals.filter(interval => !interval.exclusion);
  const points = usable.reduce((sum, interval) => sum + interval.change, 0);
  const base = { intervals: usable.length, totalIntervals: intervals.length, excluded, points: round(points, 2), minIntervals: EXCHANGE_MIN_INTERVALS, minPoints: EXCHANGE_MIN_POINTS };
  const empty = { tokensPerPoint: null, costPerPoint: null, spread: null, mix: null, ratios: [] };
  if (!joined) return { state: "unavailable" as const, reason: "no-account-join" as const, ...base, ...empty };
  if (usable.length < EXCHANGE_MIN_INTERVALS || points < EXCHANGE_MIN_POINTS) return { state: "unavailable" as const, reason: "too-few-intervals" as const, ...base, ...empty };
  const sum = (read: (interval: typeof usable[number]) => number) => usable.reduce((total, interval) => total + read(interval), 0);
  const ratios = usable.map(interval => interval.tokens! / interval.change);
  const step = Math.max(1, Math.ceil(usable.length / RATIO_POINTS));
  return {
    state: "available" as const, reason: null, ...base,
    tokensPerPoint: Math.round(sum(interval => interval.tokens!) / points),
    costPerPoint: round(sum(interval => interval.costUsd ?? 0) / points, 4),
    spread: { p25: Math.round(percentile(ratios, 0.25)!), p75: Math.round(percentile(ratios, 0.75)!) },
    mix: { freshInput: sum(interval => interval.mix!.freshInput), cacheRead: sum(interval => interval.mix!.cacheRead), output: sum(interval => interval.mix!.output) },
    ratios: usable.filter((_, index) => index % step === 0).map(interval => ({ ts: interval.toTs, tokensPerPoint: Math.round(interval.tokens! / interval.change) })),
  };
}

/** Even grid over the instance: used up to the latest sample, then the three paths. */
function chartOf(current: Instance, startMs: number, lengthMs: number, curves: ReturnType<typeof forecast>["curves"], now: number) {
  const usedAt = (ts: number) => {
    if (ts < current.samples[0]!.ts || ts > current.samples.at(-1)!.ts) return null;
    let low = 0;
    let high = current.samples.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (current.samples[middle]!.ts <= ts) low = middle;
      else high = middle - 1;
    }
    return current.used[low]!;
  };
  const end = curves ? current.resetAtMs : Math.min(current.resetAtMs, Math.max(now, current.samples.at(-1)!.ts));
  const steps = Math.max(1, Math.round(CHART_STEPS * (end - startMs) / lengthMs));
  const grid = Array.from({ length: steps + 1 }, (_, index) => Math.round(startMs + (end - startMs) * index / steps));
  const last = current.samples.at(-1)!.ts;
  if (!grid.includes(last)) grid.push(last);
  grid.sort((a, b) => a - b);
  const curve = (points: { ts: number; used: number }[] | undefined, ts: number) => {
    if (!points) return null;
    const value = pathAt(points, ts);
    return value === null ? null : round(value, 2);
  };
  return grid.map(ts => ({
    ts, used: usedAt(ts), even: round(100 * (ts - startMs) / lengthMs, 2),
    low: curve(curves?.low.points, ts), typical: curve(curves?.typical.points, ts), high: curve(curves?.high.points, ts),
  }));
}

function streamsOf(quota: Dataset["quota"], now: number) {
  const streams = new Map<string, { account: string; window: string; samples: Sample[]; withoutReset: number }>();
  const stream = (account: string, window: string) => {
    const key = JSON.stringify([account, window]);
    let entry = streams.get(key);
    if (!entry) streams.set(key, entry = { account, window, samples: [], withoutReset: 0 });
    return entry;
  };
  const add = ({ account, window, usedPercent, resetAtMs, observedAt, source }: Pick<QuotaSample, "account" | "window" | "usedPercent" | "resetAtMs" | "observedAt" | "source">) => {
    if (observedAt > now) return;
    const entry = stream(account, window);
    if (resetAtMs === null) entry.withoutReset++;
    else entry.samples.push({ ts: observedAt, usedPercent, resetAtMs, source });
  };
  for (const sample of quota.samples) add(sample);
  // A snapshot alone is enough for pace. It adds nothing when the history already reaches it.
  for (const snapshot of quota.windows) {
    const entry = stream(snapshot.account, snapshot.window);
    const latest = entry.samples.reduce((max, sample) => Math.max(max, sample.ts), 0);
    if ((snapshot.updatedAt ?? 0) > latest) add({ ...snapshot, observedAt: snapshot.updatedAt ?? 0, source: "snapshot" });
  }
  return [...streams.values()];
}

const NOTES = [
  "Quota is an account observation. It is never split by project, model or session.",
  "Even pace is a reference line, not a target.",
  "Used percent is the highest value seen so far in the window, because parallel sessions can report a stale value. Samples with reset times within five minutes count as one window.",
  "The range comes from your past weekday burn. It is not a prediction, and a plan or limit change invalidates it. Days with no samples are left out, so it reads as if you use this window on every remaining day.",
  "The exchange rate is an observed ratio for this account and period, not a conversion rule. Usage on another device or client also moves used percent, which makes tokens per point look lower than what a point buys.",
  "Dollars are API list-price equivalents, not what the plan costs.",
];

export function buildQuotaPace(quota: Dataset["quota"], rows: readonly RequestRow[], options: { now: number; tz: string }) {
  const { now, tz } = options;
  const requests = accountRequests(rows);
  const entries = streamsOf(quota, now).map(stream => {
    const { account, window } = stream;
    const lengthMs = windowLengthMs(window);
    const instances = instancesOf(stream.samples);
    const sources = [...new Set(stream.samples.map(sample => sample.source))].sort();
    const base = { key: JSON.stringify([account, window]), account, window, lengthMs, sources, sampleCount: stream.samples.length, samplesWithoutReset: stream.withoutReset, instanceCount: instances.length };
    const current = [...instances].sort((a, b) => b.samples.at(-1)!.ts - a.samples.at(-1)!.ts)[0];
    if (!current) return { ...base, state: "no-reset" as const, instance: null, age: null, pace: null, otherOpenWindows: 0, forecast: null, chart: [], exchange: exchangeRate([], false), evidence: null };
    const startMs = lengthMs === null ? null : current.resetAtMs - lengthMs;
    const latest = current.samples.at(-1)!;
    const expired = now >= current.resetAtMs;
    // A rollout names no account, so its samples join no request. Only a label both sides record does.
    const joined = account !== ROLLOUT_ACCOUNT && requests.has(account);
    const exchange = exchangeRate(intervalsOf(instances, joined ? requests.get(account)! : null), joined);
    const instance = { startMs, resetAtMs: current.resetAtMs, samples: current.samples.length, sources: [...new Set(current.samples.map(sample => sample.source))].sort() };
    const evidence = startMs === null ? null : evidenceFor({ sources: ["ocx"] }, { from: startMs, to: current.resetAtMs, tz, label: `${window} window` }, { kind: "account", account, window });
    const age = { sampleAt: latest.ts, ageMs: Math.max(0, now - latest.ts), fresh: now - latest.ts <= FRESH_MS };
    if (expired || lengthMs === null) {
      return { ...base, state: expired ? "expired" as const : "unknown-length" as const, instance, pace: null, age, otherOpenWindows: 0, forecast: null, chart: [], exchange, evidence };
    }
    const used = current.used.at(-1)!;
    const even = 100 * (latest.ts - startMs!) / lengthMs;
    const past = instances.filter(entry => entry !== current);
    const scenario = forecast(current, past, lengthMs, tz);
    const { curves, ...publicForecast } = scenario;
    return {
      ...base, state: "current" as const, instance, age,
      pace: { usedPercent: used, evenPercent: round(even, 2), deltaPoints: round(used - even, 2), daysToReset: round((current.resetAtMs - now) / DAY, 2) },
      otherOpenWindows: past.filter(entry => entry.resetAtMs > now).length,
      forecast: publicForecast, chart: chartOf(current, startMs!, lengthMs, curves, now), exchange, evidence,
    };
  }).sort((a, b) => Number(b.state === "current") - Number(a.state === "current") || b.sampleCount - a.sampleCount || a.key.localeCompare(b.key));
  return { ok: true as const, analysis: "quota-pace" as const, version: 1 as const, entries, minimums: { forecastInstances: FORECAST_MIN_INSTANCES, weekdayInstances: WEEKDAY_MIN_INSTANCES, exchangeIntervals: EXCHANGE_MIN_INTERVALS, exchangePoints: EXCHANGE_MIN_POINTS }, notes: NOTES };
}

/** One account window instance as its sample intervals. `to` names the instance: its first reported reset. */
export function quotaCase(quota: Dataset["quota"], rows: readonly RequestRow[], selection: { account: string; window: string }, instanceTo: number, now: number) {
  const stream = streamsOf(quota, now).find(entry => entry.account === selection.account && entry.window === selection.window);
  const instances = stream ? instancesOf(stream.samples) : [];
  const position = instances.findIndex(instance => Math.abs(instance.resetAtMs - instanceTo) <= RESET_TOLERANCE_MS);
  const instance = instances[position];
  const joined = selection.account !== ROLLOUT_ACCOUNT && rows.some(row => row.account === selection.account);
  const account = joined ? accountRequests(rows.filter(row => row.account === selection.account)).get(selection.account)! : null;
  const intervals = instance ? intervalsOf(instances, account).filter(interval => Math.abs(interval.resetAtMs - instance.resetAtMs) <= RESET_TOLERANCE_MS) : [];
  return { present: Boolean(instance), joined, samples: instance?.samples.length ?? 0, sources: instance ? [...new Set(instance.samples.map(sample => sample.source))].sort() : [], intervals, requestRows: account?.rows ?? [] };
}

export type QuotaPaceResponse = ReturnType<typeof buildQuotaPace>;
