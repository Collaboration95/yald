import { attributionCoverage, type AttributionCoverage } from "./attribution";
import type { Dataset, RequestRow } from "./ocx/store";
import { projectMatcher } from "./projects";
import { ALL_SOURCES, cacheEligible, contextEligible, sourceOf, throughputEligible } from "./report/source";
import type { Source } from "./report/types";
import { isoInZone, makeBucketer, nextBucketStart, zonedBucketStart } from "./time/window";

export type Bucket = "hour" | "day" | "week";
export type Metric = "tokens" | "cost" | "requests" | "outputTokens" | "inputTokens" | "cacheReadTokens" | "reasoningTokens";

export interface RowFilter {
  from?: number;
  to?: number;
  providers?: string[];
  sources?: Source[];
  models?: string[];
  efforts?: string[];
  statuses?: Outcome[];
  routeKinds?: string[];
  conversationId?: string;
  search?: string;
  /** Folder globs; a row matches when its cwd or an ancestor does. Rows without a cwd never match. */
  projects?: string[];
  /** `main`, `subagent` or `unlabelled`; a row with no marker is only ever `unlabelled`. A Codex row is `subagent` only where its rollout names a parent thread. */
  agents?: AgentKind[];
  agentTypes?: string[];
}

export type AgentKind = "main" | "subagent" | "unlabelled";

export const agentKind = (row: RequestRow): AgentKind => row.details?.agent ?? (row.codexSession?.parentThreadId ? "subagent" : "unlabelled");
export const agentTypeOf = (row: RequestRow): string => row.details?.agentType ?? row.codexSession?.agentRole ?? (row.details?.agent === "main" ? "main" : "unknown");

const DAY_MS = 86_400_000;

/** Local hour, day or Monday-based week in `tz`; never the process timezone. */
export function bucketStart(ts: number, bucket: Bucket, tz: string): number {
  return zonedBucketStart(ts, bucket, tz);
}

/** `bucketStart` for a loop over many rows: exact, but the zone is consulted about once per bucket. */
export function bucketer(bucket: Bucket, tz: string): (ts: number) => number {
  return makeBucketer(bucket, tz);
}

/** Chart tick label in `tz`; the response's `window.label` states the offset. */
export function bucketLabel(ts: number, bucket: Bucket, tz: string): string {
  const iso = isoInZone(ts, tz);
  return bucket === "hour" ? `${iso.slice(5, 10)} ${iso.slice(11, 13)}:00` : iso.slice(0, 10);
}

/** Every bucket start in the half-open window [from, to). Local days and weeks may be 23h or 25h long. */
export function bucketStarts(bucket: Bucket, from: number, to: number, tz: string): number[] {
  const starts: number[] = [];
  for (let ts = bucketStart(from, bucket, tz); ts < to; ts = nextBucketStart(ts, bucket, tz)) starts.push(ts);
  return starts;
}

/** Auto-bucket boundaries: hour for short windows, day up to 120 days, week beyond. */
export function pickBucket(spanMs: number): Bucket {
  if (spanMs <= 48 * 3_600_000) return "hour";
  if (spanMs <= 120 * DAY_MS) return "day";
  return "week";
}

/** Recent filterRows results for each rows array, so header and page requests for one selection share a scan. */
const filtered = new WeakMap<readonly RequestRow[], Map<string, RequestRow[]>>();
const FILTER_MEMO_SIZE = 24;
let scans = 0;

/** Row scans performed by filterRows (memo hits excluded); for tests. */
export const filterScans = (): number => scans;

/**
 * The filter as filterRows reads it: list order, duplicates and blank values do not change the
 * result, and every row has one of ALL_SOURCES, so naming all of them is the same as naming none.
 */
function filterKey(filter: RowFilter): string {
  const set = (values: readonly string[] | undefined) => (values?.length ? [...new Set(values)].sort() : null);
  const sources = set(filter.sources);
  const everySource = sources !== null && ALL_SOURCES.every(source => sources.includes(source));
  return JSON.stringify([
    filter.from ?? null, filter.to ?? null, set(filter.providers), everySource ? null : sources, set(filter.models), set(filter.efforts),
    set(filter.statuses), set(filter.routeKinds), filter.conversationId || null, filter.search?.toLowerCase().trim() || null, set(filter.projects), set(filter.agents), set(filter.agentTypes),
  ]);
}

/**
 * The rows matching `filter`, in their original order. Results are memoized per rows array
 * (a small LRU per array, released with it) and shared between callers, so they must never
 * be mutated; under test they are frozen to catch any caller that tries.
 */
export function filterRows(rows: RequestRow[], filter: RowFilter): RequestRow[] {
  let memo = filtered.get(rows);
  if (!memo) {
    memo = new Map();
    filtered.set(rows, memo);
  }
  const key = filterKey(filter);
  const known = memo.get(key);
  if (known) {
    memo.delete(key);
    memo.set(key, known);
    return known;
  }
  const result = scanRows(rows, filter);
  scans++;
  if (process.env.NODE_ENV === "test") Object.freeze(result);
  memo.set(key, result);
  if (memo.size > FILTER_MEMO_SIZE) memo.delete(memo.keys().next().value!);
  return result;
}

function scanRows(rows: RequestRow[], filter: RowFilter): RequestRow[] {
  const search = filter.search?.toLowerCase().trim();
  const providerSet = filter.providers?.length ? new Set(filter.providers) : null;
  const sourceSet = filter.sources?.length ? new Set(filter.sources) : null;
  const modelSet = filter.models?.length ? new Set(filter.models) : null;
  const effortSet = filter.efforts?.length ? new Set(filter.efforts) : null;
  const statusSet = filter.statuses?.length ? new Set(filter.statuses) : null;
  const routeSet = filter.routeKinds?.length ? new Set(filter.routeKinds) : null;
  const inProject = filter.projects?.length ? projectMatcher(filter.projects) : null;
  const agentSet = filter.agents?.length ? new Set<string>(filter.agents) : null;
  const agentTypeSet = filter.agentTypes?.length ? new Set(filter.agentTypes) : null;
  return rows.filter(row => {
    if (filter.from !== undefined && row.ts < filter.from) return false;
    if (filter.to !== undefined && row.ts >= filter.to) return false; // half-open: a row at `to` belongs to the next window
    if (providerSet && !providerSet.has(row.provider)) return false;
    if (sourceSet && !sourceSet.has(sourceOf(row))) return false;
    if (modelSet && !modelSet.has(row.model)) return false;
    if (effortSet && !effortSet.has(row.effort ?? "unknown")) return false;
    if (routeSet && !routeSet.has(row.routeKind ?? "unrouted")) return false;
    if (filter.conversationId && row.conversationId !== filter.conversationId) return false;
    if (inProject && !inProject(row.cwd)) return false;
    if (agentSet && !agentSet.has(agentKind(row))) return false;
    if (agentTypeSet && !agentTypeSet.has(agentTypeOf(row))) return false;
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

/**
 * With a project filter active, the rows it had to drop because their folder is unknown:
 * everything else about them matched. `attribution` splits the same population into kept,
 * elsewhere and unknown-folder rows, with the reasons behind the last. Null without a project filter.
 */
export function projectCoverage(rows: RequestRow[], filter: RowFilter): ProjectCoverage | null {
  if (!filter.projects?.length) return null;
  const attribution = attributionCoverage(filterRows(rows, { ...filter, projects: undefined }), projectMatcher(filter.projects));
  return { unattributedRows: attribution.unattributed.rows, unattributedTokens: attribution.unattributed.tokens, attribution };
}

export interface ProjectCoverage {
  unattributedRows: number;
  unattributedTokens: number;
  attribution: AttributionCoverage;
}

export type Outcome = "ok" | "error" | "cancelled" | "unobserved";

export function outcome(row: RequestRow): Outcome {
  if (!row.measurements.outcome) return "unobserved";
  if (row.ok) return "ok";
  if (row.closeReason === "client_closed" || row.errorCode === "client_closed_request") return "cancelled";
  return "error";
}

/** An ascending copy, so one sort serves every percentile read from the same values. */
export function sortedSample(values: readonly number[]): Float64Array {
  return Float64Array.from(values).sort();
}

/** Linear interpolation between the closest ranks of an ascending sample; null when it is empty. */
export function percentileOfSorted(sorted: ArrayLike<number>, p: number): number | null {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

export function percentile(values: number[], p: number): number | null {
  return values.length === 0 ? null : percentileOfSorted(sortedSample(values), p);
}

/**
 * The first `limit` items a stable sort by `compare` would give, without sorting them all:
 * the same items in the same order as `[...items].sort(compare).slice(0, limit)`, ties included.
 */
export function topN<T>(items: Iterable<T>, limit: number, compare: (a: T, b: T) => number): T[] {
  const top: T[] = [];
  if (!(limit > 0)) return top;
  for (const item of items) {
    if (top.length >= limit && compare(top[top.length - 1]!, item) <= 0) continue;
    // Insert after every kept item that sorts before it or ties with it.
    let low = 0;
    let high = top.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compare(top[middle]!, item) <= 0) low = middle + 1;
      else high = middle;
    }
    top.splice(low, 0, item);
    if (top.length > limit) top.pop();
  }
  return top;
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

export interface MeasurementSample { eligibleRequests: number; totalRequests: number }
export interface MeasurementCoverage {
  totalRequests: number;
  outcomes: MeasurementSample;
  duration: MeasurementSample;
  ttft: MeasurementSample;
  throughput: MeasurementSample;
  retries: MeasurementSample;
  input: MeasurementSample;
  context: MeasurementSample;
  cache: MeasurementSample;
  pricing: MeasurementSample;
}

export function measurementCoverage(rows: RequestRow[]): MeasurementCoverage {
  const sample = (): MeasurementSample => ({ eligibleRequests: 0, totalRequests: rows.length });
  const coverage: MeasurementCoverage = {
    totalRequests: rows.length, outcomes: sample(), duration: sample(), ttft: sample(), throughput: sample(),
    retries: sample(), input: sample(), context: sample(), cache: sample(), pricing: sample(),
  };
  for (const row of rows) {
    if (row.measurements.outcome) coverage.outcomes.eligibleRequests++;
    if (row.measurements.duration) coverage.duration.eligibleRequests++;
    if (row.measurements.ttft) coverage.ttft.eligibleRequests++;
    if (throughputEligible(row)) coverage.throughput.eligibleRequests++;
    if (row.measurements.retries) coverage.retries.eligibleRequests++;
    if (row.measurements.input) coverage.input.eligibleRequests++;
    if (contextEligible(row)) coverage.context.eligibleRequests++;
    if (cacheEligible(row)) coverage.cache.eligibleRequests++;
    if (row.priced) coverage.pricing.eligibleRequests++;
  }
  return coverage;
}

export interface Summary {
  requests: number;
  ok: number;
  errors: number;
  cancelled: number;
  unobserved: number;
  measurementCoverage: MeasurementCoverage;
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
  let unobserved = 0;
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
    else if (kind === "error") errors++;
    else unobserved++;

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
    if (row.cacheProvenance === "observed") observed++;
    else if (row.cacheProvenance === "synthesized") synthesized++;
    else unknown++;
    if (cacheEligible(row)) {
      observedCacheRead += row.cacheReadTokens;
      observedInput += row.inputTokens;
    }

    if (row.measurements.duration) durations.push(row.durationMs);
    if (row.measurements.ttft) ttfts.push(row.ttftMs!);
    if (throughputEligible(row)) throughputs.push(row.outputTokens / (row.durationMs / 1000));
    if (row.measurements.retries) {
      if (row.retried) retried++;
      sends += row.sends;
      settled += row.settled;
      unresolved += row.unresolved;
    }

    if (row.usageStatus === "reported") metering.reported++;
    else if (row.usageStatus === "estimated") metering.estimated++;
    else if (row.usageStatus === "unreported") metering.unreported++;
    else if (row.usageStatus === "unsupported") metering.unsupported++;
    else metering.other++;

    if (row.measurements.retries && row.retried && row.attemptTokens > row.totalTokens) {
      retryOverhead.tokens += row.attemptTokens - row.totalTokens;
      retryOverhead.requests++;
    }

    if (kind === "error" || kind === "cancelled") {
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
  const durationSample = sortedSample(durations);
  const ttftSample = sortedSample(ttfts);
  return {
    requests,
    ok,
    errors,
    cancelled,
    unobserved,
    measurementCoverage: measurementCoverage(rows),
    successRate: ok + errors + cancelled > 0 ? round(ok / (ok + errors + cancelled), 4) : null,
    tokens,
    cost: round(cost, 4),
    pricedRequests: priced,
    unpricedRequests: requests - priced,
    estimatedCostShare: cost > 0 ? round(estimatedCost / cost, 4) : 0,
    latency: {
      p50: percentileOfSorted(durationSample, 0.5),
      p95: percentileOfSorted(durationSample, 0.95),
      p99: percentileOfSorted(durationSample, 0.99),
      mean: durations.length ? round(durations.reduce((a, b) => a + b, 0) / durations.length, 1) : null,
    },
    ttft: {
      p50: percentileOfSorted(ttftSample, 0.5),
      p95: percentileOfSorted(ttftSample, 0.95),
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
    case "agent": return agentKind(row);
    case "agentType": return agentTypeOf(row);
    case "none":
    default: return "all";
  }
}

export function buildSeries(rows: RequestRow[], options: { bucket: Bucket; metric: Metric; groupBy: string; from: number; to: number; tz: string; limit?: number; fill?: boolean }): Series {
  const { bucket, metric, groupBy, from, to, tz } = options;
  const buckets = new Map<number, SeriesBucket>();
  const groupTotals = new Map<string, number>();

  if (options.fill !== false) {
    for (const ts of bucketStarts(bucket, from, to, tz)) {
      buckets.set(ts, { ts, label: bucketLabel(ts, bucket, tz), total: 0, groups: {}, requests: 0 });
    }
  }

  const bucketOf = bucketer(bucket, tz);
  for (const row of rows) {
    const key = bucketOf(row.ts);
    let entry = buckets.get(key);
    if (!entry) {
      entry = { ts: key, label: bucketLabel(key, bucket, tz), total: 0, groups: {}, requests: 0 };
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
  /** Tokens of priced requests only: the denominator of the blended prices below. */
  pricedTokens: number;
  costPer1kTokens: number | null;
  costPer1MTokens: number | null;
  firstSeen: number;
  lastSeen: number;
  unpricedRequests: number;
  pricedRequests: number;
  measurementCoverage: MeasurementCoverage;
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
    let pricedTokens = 0;
    for (const row of list) if (row.priced) pricedTokens += row.totalTokens;
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
      // summarize reads the same throughput-eligible rows with the same formula.
      outputTokensPerSecond: summary.throughput.p50,
      pricedTokens,
      costPer1kTokens: pricedTokens > 0 ? round((summary.cost / pricedTokens) * 1000, 4) : null,
      costPer1MTokens: pricedTokens > 0 ? round((summary.cost / pricedTokens) * 1_000_000, 2) : null,
      firstSeen: summary.firstRequestAt ?? 0,
      lastSeen: summary.lastRequestAt ?? 0,
      unpricedRequests: summary.unpricedRequests,
      pricedRequests: summary.pricedRequests,
      measurementCoverage: summary.measurementCoverage,
    });
  }
  return result.sort((a, b) => b.tokens - a.tokens);
}

export interface ClassCost {
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Row cost not explained by the four classes; 0 whenever the engine's own split is on the row. */
  adjustment: number;
}

/**
 * The four token-class costs of one priced row. They are the engine's own split when the row carries
 * it, so they add up to `row.cost` on long-context-tier and priority rows too. Without it (rows from
 * before the split was kept) they are tokens times the table rates, and `adjustment` holds whatever
 * the tier or priority multiplier added on top, so the parts still add up to `row.cost`.
 */
export function classCost(row: RequestRow): ClassCost {
  const parts = row.costParts;
  if (parts) return { freshInput: parts.input, cacheRead: parts.cacheRead, cacheWrite: parts.cacheWrite, output: parts.output, adjustment: 0 };
  const fresh = Math.max(0, row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens);
  const freshInput = row.rateIn !== null ? (fresh * row.rateIn) / 1e6 : 0;
  const cacheRead = row.rateCacheRead !== null ? (row.cacheReadTokens * row.rateCacheRead) / 1e6 : 0;
  const cacheWrite = row.rateCacheWrite !== null ? (row.cacheWriteTokens * row.rateCacheWrite) / 1e6 : 0;
  const output = row.rateOut !== null ? (row.outputTokens * row.rateOut) / 1e6 : 0;
  return { freshInput, cacheRead, cacheWrite, output, adjustment: row.cost - (freshInput + cacheRead + cacheWrite + output) };
}

export function costComposition(rows: RequestRow[]): {
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Tier or priority cost the class split could not place; 0 when every row carries the engine's split. */
  adjustment: number;
  total: number;
  cacheSavingsUsd: number;
  unpricedRequests: number;
  unmeteredRequests: number;
} {
  let freshInput = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  let adjustment = 0;
  let savings = 0;
  let unpriced = 0;
  let unmetered = 0;
  for (const row of rows) {
    if (!row.priced) {
      unpriced++;
      if (row.totalTokens === 0) unmetered++;
      continue;
    }
    const parts = classCost(row);
    freshInput += parts.freshInput;
    cacheRead += parts.cacheRead;
    cacheWrite += parts.cacheWrite;
    output += parts.output;
    adjustment += parts.adjustment;
    if (row.priced && row.rateIn !== null && row.rateCacheRead !== null) savings += (row.cacheReadTokens * (row.rateIn - row.rateCacheRead)) / 1e6;
  }
  const total = freshInput + cacheRead + cacheWrite + output + adjustment;
  return {
    freshInput: round(freshInput, 4),
    cacheRead: round(cacheRead, 4),
    cacheWrite: round(cacheWrite, 4),
    output: round(output, 4),
    adjustment: round(adjustment, 4),
    total: round(total, 4),
    cacheSavingsUsd: round(savings, 4),
    unpricedRequests: unpriced,
    unmeteredRequests: unmetered,
  };
}

const calendarFormatters = new Map<string, Intl.DateTimeFormat>();

interface CalendarParts { date: string; weekday: number; hour: number }

function calendarParts(ts: number, timeZone: string): CalendarParts {
  let formatter = calendarFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23",
    });
    calendarFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(ts);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "00";
  const weekdays: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: weekdays[get("weekday")] ?? 0, hour: Number(get("hour")) };
}

/**
 * `calendarParts` for a loop over many rows. A local-hour bucket ends at every offset change,
 * so the local date, weekday and hour are fixed inside one and are read once per bucket.
 */
function calendarReader(timeZone: string): (ts: number) => CalendarParts {
  const hourOf = bucketer("hour", timeZone);
  let hour = Number.NaN;
  let parts: CalendarParts | null = null;
  return ts => {
    const start = hourOf(ts);
    if (start !== hour || !parts) {
      hour = start;
      parts = calendarParts(ts, timeZone);
    }
    return parts;
  };
}

export function heatmap(rows: RequestRow[], metric: Metric = "tokens", timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): { cells: { weekday: number; hour: number; value: number; requests: number }[]; max: number } {
  const grid = new Map<string, { value: number; requests: number }>();
  const partsOf = calendarReader(timeZone);
  for (const row of rows) {
    const { weekday, hour } = partsOf(row.ts);
    const key = `${weekday}:${hour}`;
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

export interface HeatmapDateBreakdown {
  weekday: number;
  hour: number;
  metric: Metric;
  total: number;
  dates: { date: string; value: number; requests: number }[];
  totalDates: number;
  hasMore: boolean;
  limit: number;
  offset: number;
}

/** Ranked local calendar dates for one weekday/hour cell. */
export function heatmapDateBreakdown(
  rows: RequestRow[], options: { weekday: number; hour: number; metric: Metric; timeZone: string; limit?: number; offset?: number },
): HeatmapDateBreakdown {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const byDate = new Map<string, { value: number; requests: number }>();
  let total = 0;
  const partsOf = calendarReader(options.timeZone);
  for (const row of rows) {
    const local = partsOf(row.ts);
    if (local.weekday !== options.weekday || local.hour !== options.hour) continue;
    const value = metricValue(row, options.metric);
    total += value;
    const current = byDate.get(local.date) ?? { value: 0, requests: 0 };
    current.value += value;
    current.requests++;
    byDate.set(local.date, current);
  }
  const ranked = [...byDate.entries()].map(([date, value]) => ({ date, value: round(value.value, 4), requests: value.requests }))
    .sort((a, b) => b.value - a.value || b.date.localeCompare(a.date));
  const dates = ranked.slice(offset, offset + limit);
  return { weekday: options.weekday, hour: options.hour, metric: options.metric, total: round(total, 4), dates, totalDates: ranked.length, hasMore: offset + dates.length < ranked.length, limit, offset };
}

export function latencyTimeline(rows: RequestRow[], bucket: Bucket, from: number, to: number, tz: string): {
  bucket: Bucket;
  points: { ts: number; label: string; requests: number; p50: number | null; p90: number | null; p95: number | null; ttftP50: number | null; ttftP95: number | null; throughputP50: number | null }[];
} {
  const groups = new Map<number, RequestRow[]>();
  for (const ts of bucketStarts(bucket, from, to, tz)) groups.set(ts, []);
  const bucketOf = bucketer(bucket, tz);
  for (const row of rows) {
    const key = bucketOf(row.ts);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const points = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, list]) => {
      const durations = sortedSample(list.filter(row => row.measurements.duration).map(row => row.durationMs));
      const ttfts = sortedSample(list.filter(row => row.measurements.ttft).map(row => row.ttftMs as number));
      const throughputs = list.filter(throughputEligible).map(row => row.outputTokens / (row.durationMs / 1000));
      return {
        ts,
        label: bucketLabel(ts, bucket, tz),
        requests: list.length,
        p50: percentileOfSorted(durations, 0.5),
        p90: percentileOfSorted(durations, 0.9),
        p95: percentileOfSorted(durations, 0.95),
        ttftP50: percentileOfSorted(ttfts, 0.5),
        ttftP95: percentileOfSorted(ttfts, 0.95),
        throughputP50: percentile(throughputs, 0.5),
      };
    });
  return { bucket, points };
}

export function reliability(rows: RequestRow[], tz: string): {
  outcomes: { name: Outcome; value: number }[];
  statuses: { name: string; value: number }[];
  errors: { name: string; value: number; models: number; lastSeen: number; tokens: number; cost: number }[];
  errorTimeline: { ts: number; label: string; ok: number; error: number; cancelled: number; unobserved: number }[];
  attempts: { name: string; value: number }[];
  failureByModel: { name: string; failures: number; requests: number; rate: number }[];
} {
  const outcomes = new Map<Outcome, number>();
  const statuses = new Map<string, number>();
  const errors = new Map<string, { value: number; models: Set<string>; lastSeen: number; tokens: number; cost: number }>();
  const timeline = new Map<number, { ok: number; error: number; cancelled: number; unobserved: number }>();
  const attempts = new Map<string, number>();
  const byModel = new Map<string, { failures: number; requests: number }>();
  const dayOf = bucketer("day", tz);

  for (const row of rows) {
    const kind = outcome(row);
    outcomes.set(kind, (outcomes.get(kind) ?? 0) + 1);
    if (row.measurements.outcome && row.status > 0) statuses.set(String(row.status), (statuses.get(String(row.status)) ?? 0) + 1);
    const day = dayOf(row.ts);
    const slot = timeline.get(day) ?? { ok: 0, error: 0, cancelled: 0, unobserved: 0 };
    slot[kind] += 1;
    timeline.set(day, slot);
    if (row.measurements.retries) attempts.set(String(row.attempts), (attempts.get(String(row.attempts)) ?? 0) + 1);
    if (kind === "unobserved") continue;

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
      .map(([ts, slot]) => ({ ts, label: bucketLabel(ts, "day", tz), ...slot })),
    attempts: [...attempts.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => Number(a.name) - Number(b.name)),
    failureByModel: [...byModel.entries()]
      .map(([name, entry]) => ({ name, failures: entry.failures, requests: entry.requests, rate: entry.requests > 0 ? round(entry.failures / entry.requests, 4) : 0 }))
      .filter(entry => entry.failures > 0)
      .sort((a, b) => b.failures - a.failures),
  };
}

/** A request open longer than this was a stalled stream, not a slow answer: it would bury every real tail. */
export const STALLED_REQUEST_MS = 10 * 60_000;

export function slowestRequests(rows: RequestRow[], limit = 10): RequestRow[] {
  return topN(rows.filter(row => row.measurements.duration && row.durationMs <= STALLED_REQUEST_MS), limit, (a, b) => b.durationMs - a.durationMs);
}

export interface ConversationRow {
  id: string;
  /** A conversation id is only unique within its source, so sessions group by `(source, id)`. */
  source: Source;
  requests: number;
  tokens: number;
  cost: number;
  pricedRequests: number;
  unpricedRequests: number;
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
  /** Where the session last ran (a working directory), or null when it cannot be attributed. */
  project: string | null;
}

export type ConversationSort = "tokens" | "cost" | "requests" | "recent" | "errors";

const tieBreak = (a: ConversationRow, b: ConversationRow) => b.tokens - a.tokens || a.source.localeCompare(b.source) || a.id.localeCompare(b.id);
const CONVERSATION_ORDER: Record<ConversationSort, (a: ConversationRow, b: ConversationRow) => number> = {
  tokens: tieBreak,
  cost: (a, b) => b.cost - a.cost || tieBreak(a, b),
  requests: (a, b) => b.requests - a.requests || tieBreak(a, b),
  recent: (a, b) => b.endedAt - a.endedAt || tieBreak(a, b),
  errors: (a, b) => b.errors - a.errors || tieBreak(a, b),
};

/** Sessions ranked by `order` across every session in `rows`, then cut to `limit`: the cut never decides the ranking. */
export function conversations(rows: RequestRow[], limit = 200, order: ConversationSort = "tokens"): ConversationRow[] {
  return allConversations(rows, order).slice(0, limit);
}

/** Every session in `rows`, ranked: the list a page shows is cut from this, but counts and medians cover all of it. */
export function allConversations(rows: RequestRow[], order: ConversationSort = "tokens"): ConversationRow[] {
  const map = new Map<string, RequestRow[]>();
  for (const row of rows) {
    if (!row.conversationId) continue;
    const key = JSON.stringify([sourceOf(row), row.conversationId]);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  const result: ConversationRow[] = [];
  for (const list of map.values()) {
    const id = list[0]!.conversationId!;
    const models = new Set<string>();
    const providers = new Set<string>();
    let tokens = 0;
    let cost = 0;
    let pricedRequests = 0;
    let errors = 0;
    let cacheRead = 0;
    let output = 0;
    let duration = 0;
    let started = Infinity;
    let ended = 0;
    let project: string | null = null;
    let projectAt = -Infinity;
    for (const row of list) {
      if (row.cwd && row.ts >= projectAt) { project = row.cwd; projectAt = row.ts; }
      models.add(row.model);
      providers.add(row.provider);
      tokens += row.totalTokens;
      cost += row.cost;
      if (row.priced) pricedRequests++;
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
      source: sourceOf(list[0]!),
      requests: list.length,
      tokens,
      cost: round(cost, 4),
      pricedRequests,
      unpricedRequests: list.length - pricedRequests,
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
      project,
    });
  }
  return result.sort(CONVERSATION_ORDER[order]);
}

export function conversationTimeline(rows: RequestRow[], id: string): {
  id: string;
  points: { ts: number; tokens: number; cumulative: number; model: string; outcome: Outcome; cost: number; durationMs: number; ttftMs: number | null; contextTokens: number; contextEligible: boolean }[];
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
      contextEligible: contextEligible(row),
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

const QUOTA_CHART_POINTS = 500;

/** Evenly spaced points, first and last kept. Only for the response: burn is measured on every point first. */
function thinPoints<T>(points: T[]): T[] {
  if (points.length <= QUOTA_CHART_POINTS) return points;
  const step = (points.length - 1) / (QUOTA_CHART_POINTS - 1);
  return Array.from({ length: QUOTA_CHART_POINTS }, (_, index) => points[Math.round(index * step)]!);
}

/** Groups quota samples into series, optionally trimmed to a time window. `now` dates the exhaustion projection. */
export function quotaView(dataset: Pick<Dataset, "quota">, selected?: { from?: number; to?: number }, now = Date.now()): QuotaView {
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
  const inWindow = (ts: number) => (from === undefined || ts >= from) && (to === undefined || ts < to);
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
    const projectedExhaustionAt = percentPerDay > 0 ? now + (remaining / percentPerDay) * DAY_MS : null;
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
    series: series.map(entry => ({ ...entry, points: thinPoints(entry.points) })),
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
export function compositionSeries(rows: RequestRow[], bucket: Bucket, from: number, to: number, tz: string): CompositionPoint[] {
  const buckets = new Map<number, CompositionPoint>();
  for (const ts of bucketStarts(bucket, from, to, tz)) {
    buckets.set(ts, { ts, label: bucketLabel(ts, bucket, tz), freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, requests: 0 });
  }
  const bucketOf = bucketer(bucket, tz);
  for (const row of rows) {
    const key = bucketOf(row.ts);
    let point = buckets.get(key);
    if (!point) {
      point = { ts: key, label: bucketLabel(key, bucket, tz), freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, requests: 0 };
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

export function cumulativeSeries(rows: RequestRow[], bucket: Bucket, from: number, to: number, metric: Metric, tz: string): CumulativePoint[] {
  const buckets = new Map<number, { value: number; requests: number }>();
  for (const ts of bucketStarts(bucket, from, to, tz)) buckets.set(ts, { value: 0, requests: 0 });
  const bucketOf = bucketer(bucket, tz);
  for (const row of rows) {
    const key = bucketOf(row.ts);
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
        label: bucketLabel(ts, bucket, tz),
        value: round(entry.value, 4),
        cumulative: round(running, 4),
        requests: entry.requests,
      };
    });
}

export function cacheTimeline(rows: RequestRow[], bucket: Bucket, from: number, to: number, tz: string): { ts: number; label: string; hitRate: number | null; savingsUsd: number; cacheRead: number; input: number; eligibleRequests: number; totalRequests: number }[] {
  const buckets = new Map<number, { read: number; input: number; savings: number; eligible: number; total: number }>();
  for (const ts of bucketStarts(bucket, from, to, tz)) buckets.set(ts, { read: 0, input: 0, savings: 0, eligible: 0, total: 0 });
  const bucketOf = bucketer(bucket, tz);
  for (const row of rows) {
    const key = bucketOf(row.ts);
    const entry = buckets.get(key);
    if (!entry) continue;
    entry.total++;
    if (cacheEligible(row)) {
      entry.eligible++;
      entry.read += row.cacheReadTokens;
      entry.input += row.inputTokens;
    }
    if (row.priced && row.rateIn !== null && row.rateCacheRead !== null) {
      entry.savings += (row.cacheReadTokens * (row.rateIn - row.rateCacheRead)) / 1e6;
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, entry]) => ({
      ts,
      label: bucketLabel(ts, bucket, tz),
      hitRate: entry.input > 0 ? round(entry.read / entry.input, 4) : null,
      savingsUsd: round(entry.savings, 4),
      eligibleRequests: entry.eligible,
      totalRequests: entry.total,
      cacheRead: entry.read,
      input: entry.input,
    }));
}

export function contextPressure(rows: RequestRow[]): { buckets: { name: string; value: number }[]; maxInput: number; p50Input: number | null; p95Input: number | null; eligibleRequests: number; totalRequests: number } {
  const edges = [0, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000, Infinity];
  const labels = ["<8k", "8-16k", "16-32k", "32-64k", "64-128k", "128-256k", "256-512k", "512k+"];
  const counts = Array.from({ length: labels.length }, () => 0);
  const inputs: number[] = [];
  for (const row of rows) {
    if (!contextEligible(row)) continue;
    inputs.push(row.inputTokens);
    for (let i = 0; i < labels.length; i++) {
      if (row.inputTokens >= edges[i]! && row.inputTokens < edges[i + 1]!) {
        counts[i] += 1;
        break;
      }
    }
  }
  const sorted = sortedSample(inputs);
  return {
    buckets: labels.map((name, index) => ({ name, value: counts[index]! })),
    eligibleRequests: inputs.length,
    totalRequests: rows.length,
    maxInput: inputs.length ? sorted[sorted.length - 1]! : 0,
    p50Input: percentileOfSorted(sorted, 0.5),
    p95Input: percentileOfSorted(sorted, 0.95),
  };
}

export { round };
