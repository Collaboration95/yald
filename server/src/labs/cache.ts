// Net cache economics (L04, #61): did observed cache-read discounts outweigh
// cache-write premiums, against the identical recorded workload priced uncached?
// Rows carry the engine's own actual/baseline pair (pricing.ts); this module only
// decides eligibility and sums. It never prices, and never falls back to base rates.
import { filterRows, projectCoverage, type RowFilter } from "../analytics";
import type { RequestRow } from "../ocx/store";
import { sourceOf } from "../report/source";
import type { Source } from "../report/types";
import { analysisScope, evidenceFor, sessionKey, type AnalysisWindow, type EvidenceSelection } from "./scope";

export const CACHE_EXCLUSIONS = [
  "unpriced", "attempt-sum", "usage-estimated", "input-missing", "cache-unmeasured",
  "cache-synthesized", "cache-unknown", "economics-unavailable", "accounting-mismatch", "rate-unavailable",
] as const;
export type CacheExclusion = typeof CACHE_EXCLUSIONS[number];

export const CACHE_PRECISION_DP = 6 as const;

/**
 * The money-comparison predicate, shared with evidence replay. First match wins,
 * so `eligible + Σ excluded == total` for every group.
 */
export function cacheEligibility(row: RequestRow): { eligible: true } | { eligible: false; reason: CacheExclusion } {
  const no = (reason: CacheExclusion) => ({ eligible: false as const, reason });
  const economics = row.cacheEconomics;
  if (!row.priced) return no("unpriced");
  if (row.usageFromAttempts || row.measurements.usage !== "logical") return no("attempt-sum");
  if (row.usageStatus !== "reported") return no("usage-estimated");
  if (!row.measurements.input) return no("input-missing");
  // A field the source never wrote is not an observed zero.
  if (!row.measurements.cacheRead || !row.measurements.cacheWrite) return no("cache-unmeasured");
  if (row.cacheProvenance === "synthesized") return no("cache-synthesized");
  if (row.cacheProvenance !== "observed") return no("cache-unknown");
  if (!economics?.available) return no("economics-unavailable");
  // The engine must have priced exactly the inclusive input and cache counters the row reports.
  if (economics.inputTokens !== row.inputTokens || economics.readTokens !== row.cacheReadTokens
    || economics.writeTokens !== row.cacheWriteTokens) return no("accounting-mismatch");
  const zero = economics.zeroRate;
  if (zero.cacheRead || zero.cacheWrite || (zero.input && economics.readTokens + economics.writeTokens > 0)) return no("rate-unavailable");
  return { eligible: true };
}

/** Half-away-from-zero at the declared precision; never returns -0. */
export function round6(value: number): number {
  const rounded = Math.sign(value) * Math.round(Math.abs(value) * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}

export interface CacheEconomicsTotals {
  totalRequests: number;
  eligibleRequests: number;
  excluded: Record<CacheExclusion, number>;
  readTokens: number;
  writeTokens: number;
  readDiscountUsd: number;
  writePremiumUsd: number;
  netUsd: number;
  actualUsd: number;
  baselineUsd: number;
  direction: "benefit" | "cost" | "even" | "insufficient";
  longContextRequests: number;
  confirmedTierRequests: number;
  requestedTierOnlyRequests: number;
  priorityRequests: number;
  lowerBoundRequests: number;
  derivedRateRequests: number;
  explicitFreeRequests: number;
  firstTs: number | null;
  lastTs: number | null;
  evidence: ReturnType<typeof evidenceFor>;
}

export interface CacheEconomicsSession extends CacheEconomicsTotals {
  key: string;
  source: Source;
  conversationId: string;
}

interface Accumulator {
  total: number;
  eligible: number;
  excluded: Record<CacheExclusion, number>;
  read: number;
  write: number;
  discount: number;
  premium: number;
  actual: number;
  baseline: number;
  long: number;
  confirmed: number;
  requestedOnly: number;
  priority: number;
  lowerBound: number;
  derived: number;
  free: number;
  first: number | null;
  last: number | null;
}

function accumulator(): Accumulator {
  return {
    total: 0, eligible: 0, excluded: Object.fromEntries(CACHE_EXCLUSIONS.map(reason => [reason, 0])) as Record<CacheExclusion, number>,
    read: 0, write: 0, discount: 0, premium: 0, actual: 0, baseline: 0,
    long: 0, confirmed: 0, requestedOnly: 0, priority: 0, lowerBound: 0, derived: 0, free: 0, first: null, last: null,
  };
}

function add(acc: Accumulator, row: RequestRow): void {
  acc.total++;
  if (acc.first === null || row.ts < acc.first) acc.first = row.ts;
  if (acc.last === null || row.ts > acc.last) acc.last = row.ts;
  const verdict = cacheEligibility(row);
  if (!verdict.eligible) {
    acc.excluded[verdict.reason]++;
    return;
  }
  const economics = row.cacheEconomics;
  if (!economics?.available) return;
  acc.eligible++;
  acc.read += economics.readTokens;
  acc.write += economics.writeTokens;
  acc.discount += economics.readDiscountUsd;
  acc.premium += economics.writePremiumUsd;
  acc.actual += economics.actualUsd;
  acc.baseline += economics.baselineUsd;
  if (economics.contextTier === "long") acc.long++;
  if (economics.serviceTier.response) acc.confirmed++;
  else if (economics.serviceTier.requested || economics.serviceTier.configured) acc.requestedOnly++;
  if (economics.priorityMultiplier !== null && economics.priorityMultiplier !== 1) acc.priority++;
  if (economics.priorityLowerBound) acc.lowerBound++;
  if (economics.derivedRate) acc.derived++;
  if (economics.explicitFree) acc.free++;
}

function totals(acc: Accumulator, evidence: CacheEconomicsTotals["evidence"]): CacheEconomicsTotals {
  // Each displayed component is rounded once; net is their difference, so the
  // three values reconcile exactly at the declared precision.
  const readDiscountUsd = round6(acc.discount);
  const writePremiumUsd = round6(acc.premium);
  const netUsd = round6(readDiscountUsd - writePremiumUsd);
  return {
    totalRequests: acc.total,
    eligibleRequests: acc.eligible,
    excluded: acc.excluded,
    readTokens: acc.read,
    writeTokens: acc.write,
    readDiscountUsd,
    writePremiumUsd,
    netUsd,
    actualUsd: round6(acc.actual),
    baselineUsd: round6(acc.baseline),
    direction: acc.eligible === 0 ? "insufficient" : netUsd > 0 ? "benefit" : netUsd < 0 ? "cost" : "even",
    longContextRequests: acc.long,
    confirmedTierRequests: acc.confirmed,
    requestedTierOnlyRequests: acc.requestedOnly,
    priorityRequests: acc.priority,
    lowerBoundRequests: acc.lowerBound,
    derivedRateRequests: acc.derived,
    explicitFreeRequests: acc.free,
    firstTs: acc.first,
    lastTs: acc.last,
    evidence,
  };
}

const NOTES = [
  "Net = cache-read discount − cache-write premium, against the identical recorded input priced as uncached input by the same pricing engine, model price, context tier and service-tier record.",
  "Only rows with reported, logical usage and observed cache read/write counters support money comparisons; excluded rows contribute no dollars and are counted by reason.",
  "Costs are API list-price equivalents, not subscription bills or proof of realized savings. Lower-bound rows flag incomplete tier pricing on both prices; the net is not a guaranteed savings floor.",
  "Claude cache writes use the engine's single write rate; missing TTL splits can understate the premium for 1-hour writes. This comparison does not explain cache misses or reconstruct alternate request timing.",
  "The dashboard's gross cache savings is a different figure: cache-read discount at base list rate, before write premiums and tier rules.",
];

/**
 * Selected-scope and per-session net cache economics. `window` must be the window
 * that produced `filter.from/to`; sessions are `(source, conversationId)` and rows
 * without a conversation stay in the scope totals and the separate unnamed bucket.
 */
export function buildCacheEconomics(rows: RequestRow[], filter: RowFilter, window: AnalysisWindow, options: { limit?: number } = {}) {
  const scoped = filterRows(rows, filter);
  const scope = accumulator();
  const unnamed = accumulator();
  const sessions = new Map<string, { source: Source; conversationId: string; acc: Accumulator }>();
  for (const row of scoped) {
    add(scope, row);
    if (row.conversationId === null) {
      add(unnamed, row);
      continue;
    }
    const source = sourceOf(row);
    const key = sessionKey(source, row.conversationId);
    let session = sessions.get(key);
    if (!session) sessions.set(key, session = { source, conversationId: row.conversationId, acc: accumulator() });
    add(session.acc, row);
  }
  const evidence = (selection: EvidenceSelection) => evidenceFor(filter, window, selection, "cache");
  const limit = Math.max(0, Math.min(1000, Math.floor(options.limit ?? 100)));
  const listed: CacheEconomicsSession[] = [...sessions].map(([key, session]) => ({
    key, source: session.source, conversationId: session.conversationId,
    ...totals(session.acc, evidence({ kind: "session", source: session.source, conversationId: session.conversationId })),
  })).sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd) || a.source.localeCompare(b.source) || a.conversationId.localeCompare(b.conversationId));
  const coverage = projectCoverage(rows, filter);
  return {
    ok: true as const,
    analysis: "cache-economics" as const,
    version: 1 as const,
    scope: analysisScope(filter, window),
    ...(coverage ? { coverage } : {}),
    precisionDp: CACHE_PRECISION_DP,
    currency: "USD" as const,
    basis: "api-list-price-equivalent" as const,
    totals: totals(scope, evidence({ kind: "scope" })),
    sessions: listed.slice(0, limit),
    sessionCount: listed.length,
    sessionsTruncated: listed.length > limit,
    unnamed: totals(unnamed, evidence({ kind: "unnamed" })),
    notes: NOTES,
  };
}
