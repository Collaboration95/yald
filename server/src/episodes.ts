// Outage episodes (#109): when requests failed, whether that was a few outages or scattered
// failures. Observations only. Status classes are inferred from the code, and clustering says
// nothing about why errors cluster.
import { outcome } from "./analytics";
import type { RequestRow } from "./ocx/store";

export const EPISODE_GAP_MS = 10 * 60_000;

export type StatusClass = "upstream or capacity" | "configuration or request" | "other";

const UPSTREAM = new Set([429, 500, 502, 503, 504]);
const CONFIGURATION = new Set([400, 401, 403, 404, 422]);

/** A mapping of status codes, labelled inferred wherever it is shown. Yald sees no response bodies. */
export function statusClass(status: number): StatusClass {
  return UPSTREAM.has(status) ? "upstream or capacity" : CONFIGURATION.has(status) ? "configuration or request" : "other";
}

interface Named { name: string; value: number }

export interface Episode {
  start: number;
  end: number;
  /** Null for a single error, which has no duration. */
  durationMs: number | null;
  size: number;
  share: number;
  statuses: (Named & { class: StatusClass })[];
  errorCodes: Named[];
  dominantClass: StatusClass;
  providers: string[];
  models: string[];
  /** Successful requests inside the span: zero is a hard outage, more is a partial one. */
  successesInside: number;
  /** The first error sits within one gap of the window start, so it may have begun earlier. */
  clippedStart: boolean;
  /** The last error sits within one gap of the window end, so it may still be going. */
  ongoing: boolean;
  /** Tokens and dollars only from failed rows that reported usage; null when none did, never 0. */
  usage: { reportedRows: number; failedRows: number; tokens: number | null; costUsd: number | null };
}

export interface Persistence {
  afterError: { errors: number; total: number; rate: number | null };
  base: { errors: number; total: number; rate: number | null };
}

export interface OutageEpisodes {
  gapMs: number;
  episodes: Episode[];
  /** Cumulative share of errors held by the largest episodes, largest first. */
  concentration: { episodes: number; errors: number; share: number }[];
  /** How many of the largest episodes reach 50% and 75% of errors; null without errors. */
  marks: { p50: number | null; p75: number | null };
  persistence: Persistence & { byProvider: (Persistence & { provider: string })[] };
  classMix: { name: StatusClass; value: number }[];
  coverage: { totalRequests: number; observedRequests: number; unobservedRequests: number; errors: number; cancelled: number };
}

const share = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);
const ranked = (counts: Map<string, number>): Named[] => [...counts].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
const add = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

function persistence(observed: RequestRow[]): Persistence {
  let errors = 0;
  let afterTotal = 0;
  let afterErrors = 0;
  observed.forEach((row, index) => {
    const failed = outcome(row) === "error";
    if (failed) errors++;
    const previous = observed[index - 1];
    if (previous && outcome(previous) === "error") {
      afterTotal++;
      if (failed) afterErrors++;
    }
  });
  return {
    afterError: { errors: afterErrors, total: afterTotal, rate: share(afterErrors, afterTotal) },
    base: { errors, total: observed.length, rate: share(errors, observed.length) },
  };
}

function toEpisode(errors: RequestRow[], totalErrors: number, successesInside: number, gapMs: number, from: number, to: number): Episode {
  const start = errors[0]!.ts;
  const end = errors[errors.length - 1]!.ts;
  const statuses = new Map<string, number>();
  const codes = new Map<string, number>();
  const classes = new Map<string, number>();
  const reporting = errors.filter(row => row.measurements.usage !== "missing");
  for (const row of errors) {
    add(statuses, String(row.status));
    add(codes, row.errorCode ?? `http_${row.status}`);
    add(classes, statusClass(row.status));
  }
  const priced = reporting.filter(row => row.priced);
  return {
    start, end, durationMs: errors.length > 1 ? end - start : null, size: errors.length, share: share(errors.length, totalErrors) ?? 0,
    statuses: ranked(statuses).map(entry => ({ ...entry, class: statusClass(Number(entry.name)) })),
    errorCodes: ranked(codes),
    dominantClass: ranked(classes)[0]!.name as StatusClass,
    providers: [...new Set(errors.map(row => row.provider))].sort(),
    models: [...new Set(errors.map(row => row.model))].sort(),
    successesInside,
    clippedStart: start - from < gapMs,
    ongoing: to - end < gapMs,
    usage: {
      reportedRows: reporting.length, failedRows: errors.length,
      tokens: reporting.length ? reporting.reduce((sum, row) => sum + row.totalTokens, 0) : null,
      costUsd: priced.length ? priced.reduce((sum, row) => sum + row.cost, 0) : null,
    },
  };
}

/** Groups errors in time order: a gap of `gapMs` or more starts a new episode. Cancelled and unobserved rows are never errors. */
export function outageEpisodes(rows: readonly RequestRow[], options: { from: number; to: number; gapMs?: number }): OutageEpisodes {
  const gapMs = options.gapMs ?? EPISODE_GAP_MS;
  const observed = rows.filter(row => outcome(row) !== "unobserved").sort((a, b) => a.ts - b.ts);
  const errors = observed.filter(row => outcome(row) === "error");
  const groups: RequestRow[][] = [];
  for (const row of errors) {
    const current = groups[groups.length - 1];
    if (current && row.ts - current[current.length - 1]!.ts < gapMs) current.push(row);
    else groups.push([row]);
  }
  const oks = observed.filter(row => outcome(row) === "ok");
  const episodes = groups.map(group => {
    const [start, end] = [group[0]!.ts, group[group.length - 1]!.ts];
    const inside = oks.reduce((count, row) => count + Number(row.ts >= start && row.ts <= end), 0);
    return toEpisode(group, errors.length, inside, gapMs, options.from, options.to);
  }).sort((a, b) => b.size - a.size || a.start - b.start);

  let held = 0;
  const concentration = episodes.map((episode, index) => {
    held += episode.size;
    return { episodes: index + 1, errors: held, share: share(held, errors.length) ?? 0 };
  });
  const reach = (level: number) => concentration.find(point => point.share >= level)?.episodes ?? null;

  const byProvider = new Map<string, RequestRow[]>();
  for (const row of observed) {
    const list = byProvider.get(row.provider);
    if (list) list.push(row);
    else byProvider.set(row.provider, [row]);
  }
  const classes = new Map<string, number>();
  for (const row of errors) add(classes, statusClass(row.status));
  return {
    gapMs, episodes, concentration, marks: { p50: reach(0.5), p75: reach(0.75) },
    persistence: {
      ...persistence(observed),
      byProvider: [...byProvider].map(([provider, list]) => ({ provider, ...persistence(list) })).sort((a, b) => b.base.total - a.base.total || a.provider.localeCompare(b.provider)),
    },
    classMix: ranked(classes) as { name: StatusClass; value: number }[],
    coverage: {
      totalRequests: rows.length, observedRequests: observed.length, unobservedRequests: rows.length - observed.length,
      errors: errors.length, cancelled: observed.filter(row => outcome(row) === "cancelled").length,
    },
  };
}
