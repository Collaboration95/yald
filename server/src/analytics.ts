import type { Dataset, RequestRow } from "./ocx/store";

export type Bucket = "hour" | "day" | "week";
export type Metric = "tokens" | "cost" | "requests" | "outputTokens" | "inputTokens" | "cacheReadTokens" | "reasoningTokens";

export interface RowFilter {
  from?: number;
  to?: number;
  providers?: string[];
  models?: string[];
  efforts?: string[];
  statuses?: ("ok" | "error" | "cancelled")[];
  routeKinds?: string[];
  conversationId?: string;
  search?: string;
}

const DAY_MS = 86_400_000;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function startOfDay(ts: number): Date {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function startOfWeek(ts: number): Date {
  const d = startOfDay(ts);
  const weekday = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - weekday);
  return d;
}

export function startOfHour(ts: number): Date {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d;
}

export function bucketStart(ts: number, bucket: Bucket): number {
  if (bucket === "hour") return startOfHour(ts).getTime();
  if (bucket === "day") return startOfDay(ts).getTime();
  return startOfWeek(ts).getTime();
}

export function bucketLabel(ts: number, bucket: Bucket): string {
  const d = new Date(ts);
  if (bucket === "hour") {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`;
  }
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return base;
}

export function pickBucket(spanMs: number): Bucket {
  if (spanMs <= 48 * 3_600_000) return "hour";
  if (spanMs <= 120 * DAY_MS) return "day";
  return "week";
}

/** Auto-bucket boundaries: hour for short windows, day up to 120 days, week beyond. */
export function resolveWindow(query: { from?: number; to?: number; range?: string }, available: { first: number; last: number }): { from: number; to: number; bucket: Bucket } {
  const now = Date.now();
  const to = query.to ?? Math.max(available.last, now);
  let from = query.from;
  if (from === undefined) {
    switch (query.range) {
      case "24h": from = to - DAY_MS; break;
      case "7d": from = to - 7 * DAY_MS; break;
      case "30d": from = to - 30 * DAY_MS; break;
      case "90d": from = to - 90 * DAY_MS; break;
      case "all": from = available.first; break;
      default: from = to - 30 * DAY_MS;
    }
  }
  const span = Math.max(0, to - from);
  return { from, to, bucket: query.range === "all" ? "day" : pickBucket(span) };
}

export function filterRows(rows: RequestRow[], filter: RowFilter): RequestRow[] {
  const search = filter.search?.toLowerCase().trim();
  const providerSet = filter.providers?.length ? new Set(filter.providers) : null;
  const modelSet = filter.models?.length ? new Set(filter.models) : null;
  const effortSet = filter.efforts?.length ? new Set(filter.efforts) : null;
  const statusSet = filter.statuses?.length ? new Set(filter.statuses) : null;
  const routeSet = filter.routeKinds?.length ? new Set(filter.routeKinds) : null;
  return rows.filter(row => {
    if (filter.from !== undefined && row.ts < filter.from) return false;
    if (filter.to !== undefined && row.ts > filter.to) return false;
    if (providerSet && !providerSet.has(row.provider)) return false;
    if (modelSet && !modelSet.has(row.model)) return false;
    if (effortSet && !effortSet.has(row.effort ?? "unknown")) return false;
    if (routeSet && !routeSet.has(row.routeKind ?? "unrouted")) return false;
    if (filter.conversationId && row.conversationId !== filter.conversationId) return false;
    if (statusSet) {
      const kind = outcome(row);
      if (!statusSet.has(kind)) return false;
    }
    if (search) {
      const haystack = `${row.model} ${row.requestedModel ?? ""} ${row.provider} ${row.errorCode ?? ""} ${row.conversationId ?? ""} ${row.id}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

export type Outcome = "ok" | "error" | "cancelled";

export function outcome(row: RequestRow): Outcome {
  if (row.ok) return "ok";
  if (row.closeReason === "client_closed" || row.errorCode === "client_closed_request") return "cancelled";
  return "error";
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface Summary {
  requests: number;
  ok: number;
  errors: number;
  cancelled: number;
  successRate: number | null;
  tokens: TokenTotals;
  cost: number;
  pricedRequests: number;
  unpricedRequests: number;
  estimatedCostShare: number;
  latency: { p50: number | null; p95: number | null; p99: number | null; mean: number | null };
  ttft: { p50: number | null; p95: number | null; coverage: number };
  throughput: { p50: number | null; mean: number | null };
  cache: {
    readTokens: number;
    writeTokens: number;
    observedRequests: number;
    synthesizedRequests: number;
    unknownRequests: number;
    hitRate: number | null;
    savingsUsd: number;
  };
  waste: { failedRequests: number; failedTokens: number; failedCostUsd: number; cancelledTokens: number; cancelledCostUsd: number };
  metering: { reported: number; estimated: number; unreported: number; unsupported: number; other: number; coverage: number };
  retryOverhead: { tokens: number; requests: number };
  retries: { retriedRequests: number; sends: number; settledSends: number; unresolvedSends: number };
  firstRequestAt: number | null;
  lastRequestAt: number | null;
}

export function summarize(rows: RequestRow[]): Summary {
  const durations: number[] = [];
  const ttfts: number[] = [];
  const throughputs: number[] = [];
  const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
  let ok = 0;
  let errors = 0;
  let cancelled = 0;
  let cost = 0;
  let priced = 0;
  let estimatedCost = 0;
  let savings = 0;
  let observed = 0;
  let observedCacheRead = 0;
  let observedInput = 0;
  let synthesized = 0;
  let unknown = 0;
  let retried = 0;
  let sends = 0;
  let settled = 0;
  let unresolved = 0;
  const metering = { reported: 0, estimated: 0, unreported: 0, unsupported: 0, other: 0 };
  const retryOverhead = { tokens: 0, requests: 0 };
  const waste = { failedRequests: 0, failedTokens: 0, failedCostUsd: 0, cancelledTokens: 0, cancelledCostUsd: 0 };
  let first: number | null = null;
  let last: number | null = null;

  for (const row of rows) {
    const kind = outcome(row);
    if (kind === "ok") ok++;
    else if (kind === "cancelled") cancelled++;
    else errors++;

    tokens.input += row.inputTokens;
    tokens.output += row.outputTokens;
    tokens.cacheRead += row.cacheReadTokens;
    tokens.cacheWrite += row.cacheWriteTokens;
    tokens.reasoning += row.reasoningTokens;
    tokens.total += row.totalTokens;
    cost += row.cost;
    if (row.priced) {
      priced++;
      if (row.estimated) estimatedCost += row.cost;
      if (row.rateIn !== null && row.rateCacheRead !== null) {
        savings += (row.cacheReadTokens * (row.rateIn - row.rateCacheRead)) / 1e6;
      }
    }
    if (row.cacheProvenance === "observed") {
      observed++;
      observedCacheRead += row.cacheReadTokens;
      observedInput += row.inputTokens;
    }
    else if (row.cacheProvenance === "synthesized") synthesized++;
    else unknown++;

    if (row.durationMs > 0) durations.push(row.durationMs);
    if (row.ttftMs !== null) ttfts.push(row.ttftMs);
    if (row.outputTokens > 0 && row.durationMs > 0) throughputs.push(row.outputTokens / (row.durationMs / 1000));
    if (row.retried) retried++;
    sends += row.sends;
    settled += row.settled;
    unresolved += row.unresolved;

    if (row.usageStatus === "reported") metering.reported++;
    else if (row.usageStatus === "estimated") metering.estimated++;
    else if (row.usageStatus === "unreported") metering.unreported++;
    else if (row.usageStatus === "unsupported") metering.unsupported++;
    else metering.other++;

    if (row.retried && row.attemptTokens > row.totalTokens) {
      retryOverhead.tokens += row.attemptTokens - row.totalTokens;
      retryOverhead.requests++;
    }

    if (kind !== "ok") {
      if (kind === "cancelled") {
        waste.cancelledTokens += row.totalTokens;
        waste.cancelledCostUsd += row.cost;
      } else {
        waste.failedRequests += 1;
        waste.failedTokens += row.totalTokens;
        waste.failedCostUsd += row.cost;
      }
    }
    if (first === null || row.ts < first) first = row.ts;
    if (last === null || row.ts > last) last = row.ts;
  }

  const requests = rows.length;
  return {
    requests,
    ok,
    errors,
    cancelled,
    successRate: requests > 0 ? round(ok / requests, 4) : null,
    tokens,
    cost: round(cost, 4),
    pricedRequests: priced,
    unpricedRequests: requests - priced,
    estimatedCostShare: cost > 0 ? round(estimatedCost / cost, 4) : 0,
    latency: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      mean: durations.length ? round(durations.reduce((a, b) => a + b, 0) / durations.length, 1) : null,
    },
    ttft: {
      p50: percentile(ttfts, 0.5),
      p95: percentile(ttfts, 0.95),
      coverage: requests > 0 ? round(ttfts.length / requests, 4) : 0,
    },
    throughput: {
      p50: percentile(throughputs, 0.5),
      mean: throughputs.length ? round(throughputs.reduce((a, b) => a + b, 0) / throughputs.length, 2) : null,
    },
    cache: {
      readTokens: tokens.cacheRead,
      writeTokens: tokens.cacheWrite,
      observedRequests: observed,
      synthesizedRequests: synthesized,
      unknownRequests: unknown,
      hitRate: observedInput > 0 ? round(observedCacheRead / observedInput, 4) : null,
      savingsUsd: round(savings, 4),
    },
    waste,
    metering: {
      ...metering,
      coverage: requests > 0 ? round((metering.reported + metering.estimated) / requests, 4) : 0,
    },
    retryOverhead: { tokens: retryOverhead.tokens, requests: retryOverhead.requests },
    retries: { retriedRequests: retried, sends, settledSends: settled, unresolvedSends: unresolved },
    firstRequestAt: first,
    lastRequestAt: last,
  };
}

export interface SeriesBucket {
  ts: number;
  label: string;
  total: number;
  groups: Record<string, number>;
  requests: number;
}

export interface Series {
  bucket: Bucket;
  metric: Metric;
  groupBy: string;
  groups: { name: string; total: number }[];
  buckets: SeriesBucket[];
}

function metricValue(row: RequestRow, metric: Metric): number {
  switch (metric) {
    case "tokens": return row.totalTokens;
    case "cost": return row.cost;
    case "requests": return 1;
    case "outputTokens": return row.outputTokens;
    case "inputTokens": return row.inputTokens;
    case "cacheReadTokens": return row.cacheReadTokens;
    case "reasoningTokens": return row.reasoningTokens;
  }
}

export function groupKey(row: RequestRow, groupBy: string): string {
  switch (groupBy) {
    case "model": return row.model;
    case "provider": return row.provider;
    case "effort": return row.effort ?? "unknown";
    case "route": return row.routeKind ?? "unrouted";
    case "outcome": return outcome(row);
    case "account": return row.account ?? "unattributed";
    case "serviceTier": return row.serviceTier ?? "default";
    case "none":
    default: return "all";
  }
}

export function buildSeries(rows: RequestRow[], options: { bucket: Bucket; metric: Metric; groupBy: string; from: number; to: number; limit?: number; fill?: boolean }): Series {
  const { bucket, metric, groupBy, from, to } = options;
  const buckets = new Map<number, SeriesBucket>();
  const groupTotals = new Map<string, number>();

  const step = bucket === "hour" ? 3_600_000 : bucket === "day" ? DAY_MS : 7 * DAY_MS;
  if (options.fill !== false) {
    for (let ts = bucketStart(from, bucket); ts <= to; ts += step) {
      buckets.set(ts, { ts, label: bucketLabel(ts, bucket), total: 0, groups: {}, requests: 0 });
    }
  }

  for (const row of rows) {
    const key = bucketStart(row.ts, bucket);
    let entry = buckets.get(key);
    if (!entry) {
      entry = { ts: key, label: bucketLabel(key, bucket), total: 0, groups: {}, requests: 0 };
      buckets.set(key, entry);
    }
    const value = metricValue(row, metric);
    const group = groupKey(row, groupBy);
    entry.total += value;
    entry.groups[group] = (entry.groups[group] ?? 0) + value;
    entry.requests += 1;
    groupTotals.set(group, (groupTotals.get(group) ?? 0) + value);
  }

  const limit = options.limit ?? 8;
  const ranked = [...groupTotals.entries()].sort((a, b) => b[1] - a[1]);
  const keep = new Set(ranked.slice(0, limit).map(([name]) => name));
  const collapsed: SeriesBucket[] = [...buckets.values()]
    .sort((a, b) => a.ts - b.ts)
    .map(entry => {
      const groups: Record<string, number> = {};
      let other = 0;
      for (const [name, value] of Object.entries(entry.groups)) {
        if (keep.has(name)) groups[name] = round(value, 6);
        else other += value;
      }
      if (other > 0) groups.Other = round(other, 6);
      return { ...entry, total: round(entry.total, 6), groups };
    });

  const groups = ranked.slice(0, limit).map(([name, total]) => ({ name, total: round(total, 6) }));
  const otherTotal = ranked.slice(limit).reduce((sum, [, total]) => sum + total, 0);
  if (otherTotal > 0) groups.push({ name: "Other", total: round(otherTotal, 6) });

  return { bucket, metric, groupBy, groups, buckets: collapsed };
}

export interface BreakdownRow {
  key: string;
  requests: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  cost: number;
  share: number;
  costShare: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  ttftP50: number | null;
  successRate: number | null;
  cacheHitRate: number | null;
  outputTokensPerSecond: number | null;
  costPer1kTokens: number | null;
  costPer1MTokens: number | null;
  firstSeen: number;
  lastSeen: number;
  unpricedRequests: number;
}

export function breakdown(rows: RequestRow[], dimension: (row: RequestRow) => string): BreakdownRow[] {
  const map = new Map<string, RequestRow[]>();
  for (const row of rows) {
    const key = dimension(row);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
  const result: BreakdownRow[] = [];
  for (const [key, list] of map) {
    const summary = summarize(list);
    const throughputs = list
      .filter(row => row.outputTokens > 0 && row.durationMs > 0)
      .map(row => row.outputTokens / (row.durationMs / 1000));
    result.push({
      key,
      requests: summary.requests,
      tokens: summary.tokens.total,
      inputTokens: summary.tokens.input,
      outputTokens: summary.tokens.output,
      cacheReadTokens: summary.tokens.cacheRead,
      reasoningTokens: summary.tokens.reasoning,
      cost: summary.cost,
      share: totalTokens > 0 ? round(summary.tokens.total / totalTokens, 6) : 0,
      costShare: totalCost > 0 ? round(summary.cost / totalCost, 6) : 0,
      p50DurationMs: summary.latency.p50,
      p95DurationMs: summary.latency.p95,
      ttftP50: summary.ttft.p50,
      successRate: summary.successRate,
      cacheHitRate: summary.cache.hitRate,
      outputTokensPerSecond: percentile(throughputs, 0.5),
      costPer1kTokens: summary.tokens.total > 0 ? round((summary.cost / summary.tokens.total) * 1000, 4) : null,
      costPer1MTokens: summary.tokens.total > 0 ? round((summary.cost / summary.tokens.total) * 1_000_000, 2) : null,
      firstSeen: summary.firstRequestAt ?? 0,
      lastSeen: summary.lastRequestAt ?? 0,
      unpricedRequests: summary.unpricedRequests,
    });
  }
  return result.sort((a, b) => b.tokens - a.tokens);
}

export function costComposition(rows: RequestRow[]): {
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
  cacheSavingsUsd: number;
  unpricedRequests: number;
  unmeteredRequests: number;
} {
  let freshInput = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  let savings = 0;
  let unpriced = 0;
  let unmetered = 0;
  for (const row of rows) {
    if (!row.priced) {
      unpriced++;
      if (row.totalTokens === 0) unmetered++;
      continue;
    }
    if (row.rateIn !== null) {
      const freshTokens = Math.max(0, row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens);
      freshInput += (freshTokens * row.rateIn) / 1e6;
    }
    if (row.rateCacheRead !== null) cacheRead += (row.cacheReadTokens * row.rateCacheRead) / 1e6;
    if (row.rateCacheWrite !== null) cacheWrite += (row.cacheWriteTokens * row.rateCacheWrite) / 1e6;
    if (row.rateOut !== null) output += (row.outputTokens * row.rateOut) / 1e6;
    if (row.rateIn !== null && row.rateCacheRead !== null) savings += (row.cacheReadTokens * (row.rateIn - row.rateCacheRead)) / 1e6;
  }
  const total = freshInput + cacheRead + cacheWrite + output;
  return {
    freshInput: round(freshInput, 4),
    cacheRead: round(cacheRead, 4),
    cacheWrite: round(cacheWrite, 4),
    output: round(output, 4),
    total: round(total, 4),
    cacheSavingsUsd: round(savings, 4),
    unpricedRequests: unpriced,
    unmeteredRequests: unmetered,
  };
}

export function heatmap(rows: RequestRow[], metric: Metric = "tokens"): { cells: { weekday: number; hour: number; value: number; requests: number }[]; max: number } {
  const grid = new Map<string, { value: number; requests: number }>();
  for (const row of rows) {
    const d = new Date(row.ts);
    const weekday = (d.getDay() + 6) % 7;
    const key = `${weekday}:${d.getHours()}`;
    const cell = grid.get(key) ?? { value: 0, requests: 0 };
    cell.value += metricValue(row, metric);
    cell.requests += 1;
    grid.set(key, cell);
  }
  const cells: { weekday: number; hour: number; value: number; requests: number }[] = [];
  let max = 0;
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const cell = grid.get(`${weekday}:${hour}`) ?? { value: 0, requests: 0 };
      max = Math.max(max, cell.value);
      cells.push({ weekday, hour, value: round(cell.value, 4), requests: cell.requests });
    }
  }
  return { cells, max: round(max, 4) };
}

export function latencyTimeline(rows: RequestRow[], bucket: Bucket, from: number, to: number): {
  bucket: Bucket;
  points: { ts: number; label: string; requests: number; p50: number | null; p90: number | null; p95: number | null; ttftP50: number | null; ttftP95: number | null; throughputP50: number | null }[];
} {
  const groups = new Map<number, RequestRow[]>();
  const step = bucket === "hour" ? 3_600_000 : bucket === "day" ? DAY_MS : 7 * DAY_MS;
  for (let ts = bucketStart(from, bucket); ts <= to; ts += step) groups.set(ts, []);
  for (const row of rows) {
    const key = bucketStart(row.ts, bucket);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const points = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, list]) => {
      const durations = list.filter(row => row.durationMs > 0).map(row => row.durationMs);
      const ttfts = list.filter(row => row.ttftMs !== null).map(row => row.ttftMs as number);
      const throughputs = list.filter(row => row.outputTokens > 0 && row.durationMs > 0).map(row => row.outputTokens / (row.durationMs / 1000));
      return {
        ts,
        label: bucketLabel(ts, bucket),
        requests: list.length,
        p50: percentile(durations, 0.5),
        p90: percentile(durations, 0.9),
        p95: percentile(durations, 0.95),
        ttftP50: percentile(ttfts, 0.5),
        ttftP95: percentile(ttfts, 0.95),
        throughputP50: percentile(throughputs, 0.5),
      };
    });
  return { bucket, points };
}

export function reliability(rows: RequestRow[]): {
  outcomes: { name: Outcome; value: number }[];
  statuses: { name: string; value: number }[];
  errors: { name: string; value: number; models: number; lastSeen: number; tokens: number; cost: number }[];
  errorTimeline: { ts: number; label: string; ok: number; error: number; cancelled: number }[];
  attempts: { name: string; value: number }[];
  failureByModel: { name: string; failures: number; requests: number; rate: number }[];
} {
  const outcomes = new Map<Outcome, number>();
  const statuses = new Map<string, number>();
  const errors = new Map<string, { value: number; models: Set<string>; lastSeen: number; tokens: number; cost: number }>();
  const timeline = new Map<number, { ok: number; error: number; cancelled: number }>();
  const attempts = new Map<string, number>();
  const byModel = new Map<string, { failures: number; requests: number }>();

  for (const row of rows) {
    const kind = outcome(row);
    outcomes.set(kind, (outcomes.get(kind) ?? 0) + 1);
    statuses.set(String(row.status), (statuses.get(String(row.status)) ?? 0) + 1);
    const day = startOfDay(row.ts).getTime();
    const slot = timeline.get(day) ?? { ok: 0, error: 0, cancelled: 0 };
    slot[kind] += 1;
    timeline.set(day, slot);
    attempts.set(String(row.attempts), (attempts.get(String(row.attempts)) ?? 0) + 1);

    const model = byModel.get(row.model) ?? { failures: 0, requests: 0 };
    model.requests += 1;
    if (kind !== "ok") model.failures += 1;
    byModel.set(row.model, model);

    if (kind === "error") {
      const key = row.errorCode ?? `http_${row.status}`;
      const entry = errors.get(key) ?? { value: 0, models: new Set<string>(), lastSeen: 0, tokens: 0, cost: 0 };
      entry.value += 1;
      entry.models.add(row.model);
      entry.lastSeen = Math.max(entry.lastSeen, row.ts);
      entry.tokens += row.totalTokens;
      entry.cost += row.cost;
      errors.set(key, entry);
    }
  }

  return {
    outcomes: [...outcomes.entries()].map(([name, value]) => ({ name, value })),
    statuses: [...statuses.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    errors: [...errors.entries()]
      .map(([name, entry]) => ({ name, value: entry.value, models: entry.models.size, lastSeen: entry.lastSeen, tokens: entry.tokens, cost: round(entry.cost, 4) }))
      .sort((a, b) => b.value - a.value),
    errorTimeline: [...timeline.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ts, slot]) => ({ ts, label: bucketLabel(ts, "day"), ...slot })),
    attempts: [...attempts.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => Number(a.name) - Number(b.name)),
    failureByModel: [...byModel.entries()]
      .map(([name, entry]) => ({ name, failures: entry.failures, requests: entry.requests, rate: entry.requests > 0 ? round(entry.failures / entry.requests, 4) : 0 }))
      .filter(entry => entry.failures > 0)
      .sort((a, b) => b.failures - a.failures),
  };
}

export interface ConversationRow {
  id: string;
  requests: number;
  tokens: number;
  cost: number;
  models: string[];
  providers: string[];
  startedAt: number;
  endedAt: number;
  spanMs: number;
  errors: number;
  cacheReadTokens: number;
  outputTokens: number;
  avgDurationMs: number;
  intensity: number;
}

export function conversations(rows: RequestRow[], limit = 200): ConversationRow[] {
  const map = new Map<string, RequestRow[]>();
  for (const row of rows) {
    if (!row.conversationId) continue;
    const list = map.get(row.conversationId);
    if (list) list.push(row);
    else map.set(row.conversationId, [row]);
  }
  const result: ConversationRow[] = [];
  for (const [id, list] of map) {
    const models = new Set<string>();
    const providers = new Set<string>();
    let tokens = 0;
    let cost = 0;
    let errors = 0;
    let cacheRead = 0;
    let output = 0;
    let duration = 0;
    let started = Infinity;
    let ended = 0;
    for (const row of list) {
      models.add(row.model);
      providers.add(row.provider);
      tokens += row.totalTokens;
      cost += row.cost;
      if (outcome(row) === "error") errors++;
      cacheRead += row.cacheReadTokens;
      output += row.outputTokens;
      duration += row.durationMs;
      if (row.ts < started) started = row.ts;
      if (row.ts > ended) ended = row.ts;
    }
    const spanMs = Math.max(1, ended - started);
    result.push({
      id,
      requests: list.length,
      tokens,
      cost: round(cost, 4),
      models: [...models],
      providers: [...providers],
      startedAt: started,
      endedAt: ended,
      spanMs,
      errors,
      cacheReadTokens: cacheRead,
      outputTokens: output,
      avgDurationMs: Math.round(duration / list.length),
      intensity: round(tokens / (spanMs / 3_600_000), 1),
    });
  }
  return result.sort((a, b) => b.tokens - a.tokens).slice(0, limit);
}

export function conversationTimeline(rows: RequestRow[], id: string): {
  id: string;
  points: { ts: number; tokens: number; cumulative: number; model: string; outcome: Outcome; cost: number; durationMs: number; ttftMs: number | null; contextTokens: number }[];
  summary: Summary;
  models: { name: string; value: number }[];
} {
  const list = rows.filter(row => row.conversationId === id).sort((a, b) => a.ts - b.ts);
  let cumulative = 0;
  const models = new Map<string, number>();
  const points = list.map(row => {
    cumulative += row.totalTokens;
    models.set(row.model, (models.get(row.model) ?? 0) + 1);
    return {
      ts: row.ts,
      tokens: row.totalTokens,
      cumulative,
      model: row.model,
      outcome: outcome(row),
      cost: row.cost,
      durationMs: row.durationMs,
      ttftMs: row.ttftMs,
      contextTokens: row.inputTokens,
    };
  });
  return {
    id,
    points,
    summary: summarize(list),
    models: [...models.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
  };
}

export interface QuotaView {
  windows: Dataset["quota"]["windows"];
  series: {
    account: string;
    window: string;
    points: { ts: number; usedPercent: number }[];
    /** True when the point immediately before the window was kept as a baseline. */
    baselineIncluded: boolean;
    sampleCount: number;
  }[];
  burn: {
    account: string;
    window: string;
    percentPerDay: number;
    projectedExhaustionAt: number | null;
    resetAtMs: number | null;
    usedPercent: number;
    willExhaustBeforeReset: boolean;
    /** "insufficient" means the selected range holds fewer than two samples for this window. */
    status: "measured" | "insufficient";
    sampleCount: number;
  }[];
  updatedAt: number | null;
  window: { from: number | null; to: number | null };
  observed: { samples: number; first: number | null; last: number | null };
}

/** Groups quota samples into series, optionally trimmed to a time window. */
export function quotaView(dataset: Dataset, selected?: { from?: number; to?: number }): QuotaView {
  const from = selected?.from;
  const to = selected?.to;
  const all = new Map<string, { account: string; window: string; points: { ts: number; usedPercent: number }[] }>();
  for (const sample of dataset.quota.samples) {
    const key = `${sample.account}|${sample.window}`;
    const entry = all.get(key) ?? { account: sample.account, window: sample.window, points: [] };
    entry.points.push({ ts: sample.observedAt, usedPercent: sample.usedPercent });
    all.set(key, entry);
  }

  // Keeping the sample immediately before the window means a short range still shows
  // the change across its boundary instead of rendering an empty chart, and the burn
  // rate is then measured over exactly the points the chart shows.
  const inWindow = (ts: number) => (from === undefined || ts >= from) && (to === undefined || ts <= to);
  const series: QuotaView["series"] = [];
  for (const entry of all.values()) {
    const points = entry.points.filter(point => inWindow(point.ts));
    const baseline = from === undefined ? undefined : [...entry.points].reverse().find(point => point.ts < from);
    series.push({
      account: entry.account,
      window: entry.window,
      points: baseline ? [baseline, ...points] : points,
      baselineIncluded: Boolean(baseline),
      sampleCount: points.length,
    });
  }

  const burn: QuotaView["burn"] = [];

  for (const entry of dataset.quota.windows) {
    const match = series.find(candidate => candidate.account === entry.account && candidate.window === entry.window);
    const points = match?.points ?? [];
    const inRange = points.filter(point => inWindow(point.ts));
    let percentPerDay = 0;
    const measured = inRange.length >= 2;
    if (measured) {
      const first = points[0]!;
      const last = points[points.length - 1]!;
      const days = Math.max((last.ts - first.ts) / DAY_MS, 1 / 24);
      percentPerDay = round((last.usedPercent - first.usedPercent) / days, 4);
    }
    const remaining = Math.max(0, 100 - entry.usedPercent);
    const projectedExhaustionAt = percentPerDay > 0 ? Date.now() + (remaining / percentPerDay) * DAY_MS : null;
    const resetAtMs = entry.resetAtMs;
    burn.push({
      account: entry.account,
      window: entry.window,
      percentPerDay,
      projectedExhaustionAt,
      resetAtMs,
      usedPercent: entry.usedPercent,
      willExhaustBeforeReset: measured && Boolean(projectedExhaustionAt && resetAtMs && projectedExhaustionAt < resetAtMs),
      status: measured ? "measured" : "insufficient",
      sampleCount: inRange.length,
    });
  }

  const observed = dataset.quota.samples.filter(sample => inWindow(sample.observedAt));
  return {
    windows: dataset.quota.windows,
    series,
    burn,
    updatedAt: dataset.quota.updatedAt,
    window: { from: from ?? null, to: to ?? null },
    observed: {
      samples: observed.length,
      first: observed[0]?.observedAt ?? null,
      last: observed[observed.length - 1]?.observedAt ?? null,
    },
  };
}

export function sparkline(rows: RequestRow[], from: number, to: number, metric: Metric, buckets = 24): number[] {
  const step = Math.max(1, Math.floor((to - from) / buckets));
  const values = Array.from({ length: buckets }, () => 0);
  for (const row of rows) {
    const index = Math.min(buckets - 1, Math.max(0, Math.floor((row.ts - from) / step)));
    values[index] += metricValue(row, metric);
  }
  return values.map(value => round(value, 4));
}

export interface CompositionPoint {
  ts: number;
  label: string;
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  requests: number;
}

/** Token classes per bucket. `inputTokens` already includes cache, so fresh = input - cache. */
export function compositionSeries(rows: RequestRow[], bucket: Bucket, from: number, to: number): CompositionPoint[] {
  const step = bucket === "hour" ? 3_600_000 : bucket === "day" ? DAY_MS : 7 * DAY_MS;
  const buckets = new Map<number, CompositionPoint>();
  for (let ts = bucketStart(from, bucket); ts <= to; ts += step) {
    buckets.set(ts, { ts, label: bucketLabel(ts, bucket), freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, requests: 0 });
  }
  for (const row of rows) {
    const key = bucketStart(row.ts, bucket);
    let point = buckets.get(key);
    if (!point) {
      point = { ts: key, label: bucketLabel(key, bucket), freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, requests: 0 };
      buckets.set(key, point);
    }
    point.freshInput += Math.max(0, row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens);
    point.cacheRead += row.cacheReadTokens;
    point.cacheWrite += row.cacheWriteTokens;
    point.output += row.outputTokens;
    point.reasoning += row.reasoningTokens;
    point.total += row.totalTokens;
    point.requests += 1;
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

export interface CumulativePoint {
  ts: number;
  label: string;
  value: number;
  cumulative: number;
  requests: number;
}

export function cumulativeSeries(rows: RequestRow[], bucket: Bucket, from: number, to: number, metric: Metric): CumulativePoint[] {
  const step = bucket === "hour" ? 3_600_000 : bucket === "day" ? DAY_MS : 7 * DAY_MS;
  const buckets = new Map<number, { value: number; requests: number }>();
  for (let ts = bucketStart(from, bucket); ts <= to; ts += step) buckets.set(ts, { value: 0, requests: 0 });
  for (const row of rows) {
    const key = bucketStart(row.ts, bucket);
    const entry = buckets.get(key);
    if (!entry) continue;
    entry.value += metricValue(row, metric);
    entry.requests += 1;
  }
  let running = 0;
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, entry]) => {
      running += entry.value;
      return {
        ts,
        label: bucketLabel(ts, bucket),
        value: round(entry.value, 4),
        cumulative: round(running, 4),
        requests: entry.requests,
      };
    });
}

export function cacheTimeline(rows: RequestRow[], bucket: Bucket, from: number, to: number): { ts: number; label: string; hitRate: number | null; savingsUsd: number; cacheRead: number; input: number }[] {
  const step = bucket === "hour" ? 3_600_000 : bucket === "day" ? DAY_MS : 7 * DAY_MS;
  const buckets = new Map<number, { read: number; input: number; savings: number }>();
  for (let ts = bucketStart(from, bucket); ts <= to; ts += step) buckets.set(ts, { read: 0, input: 0, savings: 0 });
  for (const row of rows) {
    const key = bucketStart(row.ts, bucket);
    const entry = buckets.get(key);
    if (!entry) continue;
    if (row.cacheProvenance === "observed") {
      entry.read += row.cacheReadTokens;
      entry.input += row.inputTokens;
    }
    if (row.rateIn !== null && row.rateCacheRead !== null) {
      entry.savings += (row.cacheReadTokens * (row.rateIn - row.rateCacheRead)) / 1e6;
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, entry]) => ({
      ts,
      label: bucketLabel(ts, bucket),
      hitRate: entry.input > 0 ? round(entry.read / entry.input, 4) : null,
      savingsUsd: round(entry.savings, 4),
      cacheRead: entry.read,
      input: entry.input,
    }));
}

export function contextPressure(rows: RequestRow[]): { buckets: { name: string; value: number }[]; maxInput: number; p50Input: number | null; p95Input: number | null } {
  const edges = [0, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000, Infinity];
  const labels = ["<8k", "8-16k", "16-32k", "32-64k", "64-128k", "128-256k", "256-512k", "512k+"];
  const counts = Array.from({ length: labels.length }, () => 0);
  const inputs: number[] = [];
  for (const row of rows) {
    inputs.push(row.inputTokens);
    for (let i = 0; i < labels.length; i++) {
      if (row.inputTokens >= edges[i]! && row.inputTokens < edges[i + 1]!) {
        counts[i] += 1;
        break;
      }
    }
  }
  return {
    buckets: labels.map((name, index) => ({ name, value: counts[index]! })),
    maxInput: inputs.length ? Math.max(...inputs) : 0,
    p50Input: percentile(inputs, 0.5),
    p95Input: percentile(inputs, 0.95),
  };
}

export { round };
