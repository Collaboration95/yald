// Working style (#105): how sessions are shaped and when work happens, from `ts`, conversation id,
// cost and source. Rule-based labels for size and span, never for value. A session is not a task,
// and a day with no data is not a day without work.
import { allConversations, bucketer, bucketStarts, heatmap, percentile, round, topN, type ConversationRow } from "./analytics";
import type { RequestRow } from "./ocx/store";
import { sourceOf } from "./report/source";
import { isoInZone } from "./time/window";

/** Evaluated in this order. Adjust here only: docs/metrics.md publishes the same table. */
export const ARCHETYPE_RULES = {
  poke: { maxRequests: 3 },
  quick: { maxRequests: 24 },
  marathon: { minRequests: 1_000, minRequestsAcrossDays: 25 },
} as const;

export type Archetype = "poke" | "quick" | "deep" | "marathon";
export const ARCHETYPES: readonly Archetype[] = ["poke", "quick", "deep", "marathon"];

export const CONCURRENCY_BIN_MS = 10 * 60_000;
export const NIGHT_END_HOUR = 6;
/** Below this many sessions or requests a recap note reads "too little data", never a rounded zero. */
export const NOTE_MIN = 5;

export function archetypeOf(requests: number, spansDays: boolean): Archetype {
  if (requests <= ARCHETYPE_RULES.poke.maxRequests) return "poke";
  if (requests <= ARCHETYPE_RULES.quick.maxRequests) return "quick";
  if (requests >= ARCHETYPE_RULES.marathon.minRequests || (spansDays && requests >= ARCHETYPE_RULES.marathon.minRequestsAcrossDays)) return "marathon";
  return "deep";
}

export interface ArchetypeRow {
  name: Archetype;
  sessions: number;
  requests: number;
  /** List-price equivalent of priced requests only. */
  costUsd: number;
  sessionShare: number | null;
  requestShare: number | null;
  costShare: number | null;
  medianRequests: number | null;
  medianSpanMs: number | null;
  unpricedRequests: number;
  /** Sessions with requests outside the window: their archetype is a lower bound. */
  clippedSessions: number;
}

export interface WorkingStyle {
  archetypes: ArchetypeRow[];
  totals: { sessions: number; requests: number; requestsWithoutSession: number; costUsd: number; unpricedRequests: number };
  concurrency: {
    binMinutes: number;
    days: { date: string; peak: number }[];
    medianPeak: number | null;
    p90Peak: number | null;
    maxPeak: number;
    busiestDay: string | null;
    /** Bin starts of the busiest day that had any session, with their counts. */
    busiestSeries: { ts: number; sessions: number }[];
    peakHistogram: { peak: number; days: number }[];
  };
  activity: { days: { date: string; requests: number }[]; activeDays: number; windowDays: number; longestStreak: number; currentStreak: number };
  hours: { hour: number; requests: number }[];
  night: { requests: number; share: number | null };
}

const share = (part: number, whole: number): number | null => (whole > 0 ? round(part / whole, 4) : null);
const dayName = (dayStart: number, tz: string) => isoInZone(dayStart, tz).slice(0, 10);

function archetypeRows(sessions: ConversationRow[], tz: string, clipped: ReadonlySet<string>): ArchetypeRow[] {
  const dayOf = bucketer("day", tz);
  const groups = new Map<Archetype, ConversationRow[]>(ARCHETYPES.map(name => [name, []]));
  for (const session of sessions) groups.get(archetypeOf(session.requests, dayOf(session.startedAt) !== dayOf(session.endedAt)))!.push(session);
  const totalRequests = sessions.reduce((sum, session) => sum + session.requests, 0);
  const totalCost = sessions.reduce((sum, session) => sum + session.cost, 0);
  return ARCHETYPES.map(name => {
    const list = groups.get(name)!;
    const requests = list.reduce((sum, session) => sum + session.requests, 0);
    const costUsd = list.reduce((sum, session) => sum + session.cost, 0);
    return {
      name, sessions: list.length, requests, costUsd: round(costUsd, 4),
      sessionShare: share(list.length, sessions.length), requestShare: share(requests, totalRequests), costShare: share(costUsd, totalCost),
      medianRequests: percentile(list.map(session => session.requests), 0.5),
      medianSpanMs: percentile(list.map(session => (session.requests > 1 ? session.spanMs : 0)), 0.5),
      unpricedRequests: list.reduce((sum, session) => sum + session.unpricedRequests, 0),
      clippedSessions: list.filter(session => clipped.has(JSON.stringify([session.source, session.id]))).length,
    };
  });
}

function concurrency(rows: readonly RequestRow[], tz: string): WorkingStyle["concurrency"] {
  const bins = new Map<number, Set<string>>();
  for (const row of rows) {
    if (!row.conversationId) continue;
    const bin = row.ts - (row.ts % CONCURRENCY_BIN_MS);
    let sessions = bins.get(bin);
    if (!sessions) bins.set(bin, sessions = new Set());
    sessions.add(JSON.stringify([sourceOf(row), row.conversationId]));
  }
  const dayOf = bucketer("day", tz);
  const peaks = new Map<number, number>();
  for (const [bin, sessions] of [...bins].sort((a, b) => a[0] - b[0])) {
    const day = dayOf(bin);
    peaks.set(day, Math.max(peaks.get(day) ?? 0, sessions.size));
  }
  const days = [...peaks].map(([day, peak]) => ({ day, date: dayName(day, tz), peak }));
  const values = days.map(entry => entry.peak);
  const busiest = topN(days, 1, (a, b) => b.peak - a.peak || a.day - b.day)[0] ?? null;
  const counts = new Map<number, number>();
  for (const peak of values) counts.set(peak, (counts.get(peak) ?? 0) + 1);
  return {
    binMinutes: CONCURRENCY_BIN_MS / 60_000,
    days: days.map(({ date, peak }) => ({ date, peak })),
    medianPeak: percentile(values, 0.5), p90Peak: percentile(values, 0.9), maxPeak: Math.max(0, ...values),
    busiestDay: busiest?.date ?? null,
    busiestSeries: busiest ? [...bins].filter(([bin]) => dayOf(bin) === busiest.day).sort((a, b) => a[0] - b[0]).map(([ts, sessions]) => ({ ts, sessions: sessions.size })) : [],
    peakHistogram: [...counts].sort((a, b) => a[0] - b[0]).map(([peak, count]) => ({ peak, days: count })),
  };
}

function activity(rows: readonly RequestRow[], tz: string, from: number, to: number, now: number): WorkingStyle["activity"] {
  const dayOf = bucketer("day", tz);
  const perDay = new Map<number, number>();
  for (const row of rows) {
    const day = dayOf(row.ts);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const starts = bucketStarts("day", from, to, tz);
  let longest = 0;
  let run = 0;
  for (const day of starts) {
    run = perDay.has(day) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const today = dayOf(Math.min(now, to - 1));
  let current = 0;
  for (let index = starts.lastIndexOf(today); index >= 0 && perDay.has(starts[index]!); index--) current++;
  return {
    days: starts.map(day => ({ date: dayName(day, tz), requests: perDay.get(day) ?? 0 })),
    activeDays: perDay.size, windowDays: starts.length, longestStreak: longest, currentStreak: current,
  };
}

/** `rows` is the selection; `datasetRows` only reveals which of its sessions the window clipped. */
export function workingStyle(rows: readonly RequestRow[], options: { tz: string; from: number; to: number; now: number; datasetRows?: readonly RequestRow[] }): WorkingStyle {
  const { tz, from, to, now } = options;
  const sessions = allConversations(rows as RequestRow[]);
  const clipped = new Set<string>();
  const inSelection = new Set(sessions.map(session => JSON.stringify([session.source, session.id])));
  for (const row of options.datasetRows ?? []) {
    if (!row.conversationId || (row.ts >= from && row.ts < to)) continue;
    const key = JSON.stringify([sourceOf(row), row.conversationId]);
    if (inSelection.has(key)) clipped.add(key);
  }
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 0 }));
  for (const cell of heatmap(rows as RequestRow[], "requests", tz).cells) hours[cell.hour]!.requests += cell.requests;
  const nightRequests = hours.slice(0, NIGHT_END_HOUR).reduce((sum, hour) => sum + hour.requests, 0);
  return {
    archetypes: archetypeRows(sessions, tz, clipped),
    totals: {
      sessions: sessions.length, requests: rows.length, requestsWithoutSession: rows.filter(row => !row.conversationId).length,
      costUsd: round(sessions.reduce((sum, session) => sum + session.cost, 0), 4),
      unpricedRequests: sessions.reduce((sum, session) => sum + session.unpricedRequests, 0),
    },
    concurrency: concurrency(rows, tz),
    activity: activity(rows, tz, from, to, now),
    hours,
    night: { requests: nightRequests, share: share(nightRequests, rows.length) },
  };
}

export interface RecapNote {
  text: string;
  /** How many sessions or requests the sentence rests on. */
  n: number;
  /** Names a session: left out of a shared image unless asked for. */
  identifying?: boolean;
  /** States dollars, so a shared image must carry the list-price note. */
  money?: boolean;
}

const percent = (value: number | null) => `${Math.round((value ?? 0) * 100)}%`;
const usd = (value: number) => `$${value.toFixed(2)}`;

/** Fixed sentences with their n, composed here so the CLI, the HTML report and the card print the same text. */
export function recapNotes(style: WorkingStyle, biggest: { id: string; requests: number; costUsd: number | null } | null): RecapNote[] {
  const { totals, archetypes, concurrency: peaks, activity: days, night } = style;
  const tooLittle = (what: string, n: number): RecapNote => ({ text: `Too little data for ${what}: ${n} of ${NOTE_MIN} needed.`, n });
  const poke = archetypes.find(row => row.name === "poke")!;
  const notes: RecapNote[] = [
    totals.sessions >= NOTE_MIN
      ? { text: `Of ${totals.sessions} sessions, ${percent(poke.sessionShare)} were 3 requests or fewer and held ${percent(poke.costShare)} of priced cost.`, n: totals.sessions }
      : tooLittle("the session mix", totals.sessions),
    peaks.busiestDay !== null && totals.sessions >= NOTE_MIN
      ? { text: `At most ${peaks.maxPeak} sessions made a request in the same 10 minutes, on ${peaks.busiestDay}.`, n: totals.sessions }
      : tooLittle("concurrency", totals.sessions),
    { text: `${days.activeDays} of ${days.windowDays} days had data. The longest run of days with data was ${days.longestStreak}.`, n: days.windowDays },
    totals.requests >= NOTE_MIN
      ? { text: `${percent(night.share)} of ${totals.requests} requests fell between 00:00 and 05:59 on the local clock.`, n: totals.requests }
      : tooLittle("hours", totals.requests),
  ];
  if (biggest) {
    const cost = biggest.costUsd === null ? "" : ` (${usd(biggest.costUsd)} list-price equivalent)`;
    notes.push({ text: `The largest session by tokens, ${biggest.id}, made ${biggest.requests} requests${cost}.`, n: biggest.requests, identifying: true, money: biggest.costUsd !== null });
  }
  return notes;
}
