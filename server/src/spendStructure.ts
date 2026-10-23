// Spend structure (#103): how concentrated spend is across sessions, how the blended price per
// million tokens moves with the price-tier mix, and what each token class costs per source.
// Every dollar figure is an API list-price equivalent over PRICED rows only; unpriced rows are
// counted and disclosed, never treated as $0, and every token denominator uses the same priced rows.
import { bucketer, bucketLabel, bucketStarts, classCost, round, type Bucket } from "./analytics";
import { countClippedSessions } from "./labs/scope";
import type { RequestRow } from "./ocx/store";
import { ALL_SOURCES, sourceOf } from "./report/source";
import type { Source } from "./report/types";

/**
 * Price tiers: fixed bands of a row's list input rate in USD per million tokens (`rateIn`), a label on
 * list price and nothing else. Constants, not fitted to any dataset; published in docs/metrics.md.
 */
export const PRICE_TIERS = [
  { id: "economy", label: "Economy", minRateIn: 0, maxRateIn: 1 },
  { id: "standard", label: "Standard", minRateIn: 1, maxRateIn: 5 },
  { id: "premium", label: "Premium", minRateIn: 5, maxRateIn: null },
] as const;
export type TierId = typeof PRICE_TIERS[number]["id"];

/** The tier of a list input rate, or null when the row has no input rate. */
export function tierOf(rateIn: number | null): TierId | null {
  if (rateIn === null || !Number.isFinite(rateIn) || rateIn < 0) return null;
  for (const tier of PRICE_TIERS) if (tier.maxRateIn === null || rateIn < tier.maxRateIn) return tier.id;
  return null;
}

/** Minimum number of priced sessions before a concentration figure is shown; below it the value is null. */
export const CONCENTRATION_MIN = { top1pct: 100, top5pct: 20, top10Sessions: 10, gini: 10 } as const;

const CURVE_POINTS = 90;

type CostClass = "freshInput" | "cacheRead" | "cacheWrite" | "output";

interface ClassTotals {
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Of which, inside output: the output cost in proportion to reasoning tokens (an attribution, not a measurement). */
  reasoning: number;
  /** Tier or priority cost the class split could not place; 0 when rows carry the engine's split. */
  adjustment: number;
}

const zeroTotals = (): ClassTotals => ({ freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, adjustment: 0 });
const totalOf = (t: ClassTotals): number => t.freshInput + t.cacheRead + t.cacheWrite + t.output + t.adjustment;

function roundTotals(t: ClassTotals): ClassTotals {
  return {
    freshInput: round(t.freshInput, 6), cacheRead: round(t.cacheRead, 6), cacheWrite: round(t.cacheWrite, 6),
    output: round(t.output, 6), reasoning: round(t.reasoning, 6), adjustment: round(t.adjustment, 6),
  };
}

interface TokenClasses { freshInput: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }
const zeroTokens = (): TokenClasses => ({ freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });

interface TierBucket { requests: number; tokens: number; cost: number }
interface BucketAccumulator {
  requests: number;
  pricedRequests: number;
  pricedTokens: number;
  cost: number;
  tiers: Record<TierId, TierBucket>;
}
const emptyBucket = (): BucketAccumulator => ({
  requests: 0, pricedRequests: 0, pricedTokens: 0, cost: 0,
  tiers: { economy: { requests: 0, tokens: 0, cost: 0 }, standard: { requests: 0, tokens: 0, cost: 0 }, premium: { requests: 0, tokens: 0, cost: 0 } },
});

interface SourceAccumulator {
  pricedRequests: number;
  tokens: TokenClasses;
  cost: ClassTotals;
  buckets: Map<number, ClassTotals>;
}

interface SessionAccumulator { cost: number; requests: number; priced: number }

const blended = (cost: number, tokens: number): number | null => (tokens > 0 ? round((cost / tokens) * 1e6, 4) : null);
const share = (part: number, whole: number): number | null => (whole > 0 ? round(part / whole, 4) : null);

/** Gini coefficient of non-negative amounts sorted ascending; null for fewer than two or a zero total. */
export function gini(ascending: ArrayLike<number>): number | null {
  const n = ascending.length;
  let total = 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    total += ascending[i]!;
    weighted += (i + 1) * ascending[i]!;
  }
  if (n < 2 || total <= 0) return null;
  return round((2 * weighted) / (n * total) - (n + 1) / n, 4);
}

export interface SpendStructure {
  /** Priced requests over total, and the tokens on each side of that line. */
  pricing: { totalRequests: number; pricedRequests: number; unpricedRequests: number; pricedTokens: number; unpricedTokens: number; cost: number };
  concentration: {
    /** Sessions with at least one priced request: the population of every figure below. */
    sessions: number;
    /** Sessions whose cost is a lower bound because some of their requests are unpriced. */
    partlyPricedSessions: number;
    /** Sessions with requests but no priced request; outside the curve. */
    unpricedSessions: number;
    /** Sessions with loaded requests outside the window; only their in-window part counts. */
    clippedSessions: number;
    /** Requests with no conversation id, outside the curve. */
    noSessionId: { requests: number; pricedRequests: number; cost: number | null };
    totalCost: number | null;
    minimums: typeof CONCENTRATION_MIN;
    top1pct: { sessions: number; cost: number; share: number } | null;
    top5pct: { sessions: number; cost: number; share: number } | null;
    top10Sessions: { sessions: number; cost: number; share: number } | null;
    gini: number | null;
    /** Sessions ranked by cost: x is the cumulative share of sessions, y the cumulative share of cost. */
    curve: { x: number; y: number }[];
  };
  tiers: {
    definitions: { id: TierId; label: string; minRateIn: number; maxRateIn: number | null }[];
    /** Models seen in each tier (priced requests), largest first. */
    models: Record<TierId, { model: string; requests: number }[]>;
    unclassifiedRequests: number;
  };
  series: {
    bucket: Bucket;
    buckets: {
      ts: number;
      label: string;
      requests: number;
      pricedRequests: number;
      pricedTokens: number;
      cost: number | null;
      /** Priced cost over priced tokens per million; null without priced tokens. */
      blendedPer1M: number | null;
      tiers: Record<TierId, { requests: number; tokens: number; blendedPer1M: number | null; requestShare: number | null; tokenShare: number | null }>;
    }[];
  };
  classMix: {
    source: Source;
    pricedRequests: number;
    tokens: TokenClasses;
    cost: ClassTotals;
    totalCost: number;
    /** Each class's share of priced tokens and of priced cost; reasoning is within output. */
    tokenShare: Record<CostClass, number | null>;
    costShare: Record<CostClass | "adjustment", number | null>;
    buckets: { ts: number; label: string; cost: ClassTotals; total: number; share: Record<CostClass | "adjustment", number | null> }[];
  }[];
}

export function spendStructure(
  rows: readonly RequestRow[],
  options: { bucket: Bucket; from: number; to: number; tz: string; datasetRows?: readonly RequestRow[] },
): SpendStructure {
  const { bucket, from, to, tz } = options;
  const bucketOf = bucketer(bucket, tz);
  const buckets = new Map<number, BucketAccumulator>();
  for (const ts of bucketStarts(bucket, from, to, tz)) buckets.set(ts, emptyBucket());
  const tierModels: Record<TierId, Map<string, number>> = { economy: new Map(), standard: new Map(), premium: new Map() };
  const sessions = new Map<Source, Map<string, SessionAccumulator>>();
  const noSession = { requests: 0, priced: 0, cost: 0 };
  const sources = new Map<Source, SourceAccumulator>(ALL_SOURCES.map(source => [source, { pricedRequests: 0, tokens: zeroTokens(), cost: zeroTotals(), buckets: new Map() }]));
  let pricedRequests = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  let cost = 0;
  let unclassified = 0;

  for (const row of rows) {
    const start = bucketOf(row.ts);
    let slot = buckets.get(start);
    if (!slot) buckets.set(start, slot = emptyBucket());
    slot.requests++;
    const source = sourceOf(row);

    if (row.conversationId) {
      let bySession = sessions.get(source);
      if (!bySession) sessions.set(source, bySession = new Map());
      let session = bySession.get(row.conversationId);
      if (!session) bySession.set(row.conversationId, session = { cost: 0, requests: 0, priced: 0 });
      session.requests++;
      if (row.priced) {
        session.priced++;
        session.cost += row.cost;
      }
    } else {
      noSession.requests++;
      if (row.priced) {
        noSession.priced++;
        noSession.cost += row.cost;
      }
    }

    if (!row.priced) {
      unpricedTokens += row.totalTokens;
      continue;
    }
    pricedRequests++;
    pricedTokens += row.totalTokens;
    cost += row.cost;
    slot.pricedRequests++;
    slot.pricedTokens += row.totalTokens;
    slot.cost += row.cost;

    const tier = tierOf(row.rateIn);
    if (tier) {
      const entry = slot.tiers[tier];
      entry.requests++;
      entry.tokens += row.totalTokens;
      entry.cost += row.cost;
      tierModels[tier].set(row.model, (tierModels[tier].get(row.model) ?? 0) + 1);
    } else unclassified++;

    const stats = sources.get(source)!;
    stats.pricedRequests++;
    const parts = classCost(row);
    const reasoning = row.outputTokens > 0 ? parts.output * Math.min(1, row.reasoningTokens / row.outputTokens) : 0;
    const fresh = Math.max(0, row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens);
    stats.tokens.freshInput += fresh;
    stats.tokens.cacheRead += row.cacheReadTokens;
    stats.tokens.cacheWrite += row.cacheWriteTokens;
    stats.tokens.output += row.outputTokens;
    stats.tokens.reasoning += row.reasoningTokens;
    let bucketCost = stats.buckets.get(start);
    if (!bucketCost) stats.buckets.set(start, bucketCost = zeroTotals());
    for (const target of [stats.cost, bucketCost]) {
      target.freshInput += parts.freshInput;
      target.cacheRead += parts.cacheRead;
      target.cacheWrite += parts.cacheWrite;
      target.output += parts.output;
      target.reasoning += reasoning;
      target.adjustment += parts.adjustment;
    }
  }

  // Concentration: every session with a priced request, ranked by its priced cost.
  const costs: number[] = [];
  let partlyPriced = 0;
  let unpricedSessions = 0;
  const ranked = new Map<Source, Set<string>>();
  for (const [source, bySession] of sessions) {
    for (const [id, session] of bySession) {
      if (session.priced === 0) {
        unpricedSessions++;
        continue;
      }
      if (session.priced < session.requests) partlyPriced++;
      costs.push(session.cost);
      let ids = ranked.get(source);
      if (!ids) ranked.set(source, ids = new Set());
      ids.add(id);
    }
  }
  const ascending = Float64Array.from(costs).sort();
  const n = ascending.length;
  let sessionCost = 0;
  for (let i = 0; i < n; i++) sessionCost += ascending[i]!;
  const topShare = (count: number, minimum: number) => {
    if (n < minimum || sessionCost <= 0) return null;
    const k = Math.min(n, count);
    let sum = 0;
    for (let i = 0; i < k; i++) sum += ascending[n - 1 - i]!;
    return { sessions: k, cost: round(sum, 4), share: round(sum / sessionCost, 4) };
  };
  const curve: { x: number; y: number }[] = [];
  if (n > 0 && sessionCost > 0) {
    const picks = new Set<number>();
    for (let k = 1; k <= Math.min(n, 10); k++) picks.add(k);
    for (let j = 0; j < CURVE_POINTS; j++) picks.add(Math.max(1, Math.round(n ** (j / (CURVE_POINTS - 1)))));
    picks.add(n);
    let cumulative = 0;
    let at = 0;
    for (const k of [...picks].sort((a, b) => a - b)) {
      while (at < k) cumulative += ascending[n - 1 - at++]!;
      curve.push({ x: round(k / n, 5), y: round(cumulative / sessionCost, 4) });
    }
  }
  const clippedSessions = options.datasetRows ? countClippedSessions(ranked, options.datasetRows, from, to) : 0;

  const orderedBuckets = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const tierIds = PRICE_TIERS.map(tier => tier.id);
  const mix = ALL_SOURCES.filter(source => sources.get(source)!.pricedRequests > 0).map(source => {
    const stats = sources.get(source)!;
    const totalCost = totalOf(stats.cost);
    const priceTokens = stats.tokens.freshInput + stats.tokens.cacheRead + stats.tokens.cacheWrite + stats.tokens.output;
    const shares = (t: ClassTotals, whole: number) => ({
      freshInput: share(t.freshInput, whole), cacheRead: share(t.cacheRead, whole), cacheWrite: share(t.cacheWrite, whole),
      output: share(t.output, whole), adjustment: share(t.adjustment, whole),
    });
    return {
      source, pricedRequests: stats.pricedRequests, tokens: stats.tokens, cost: roundTotals(stats.cost), totalCost: round(totalCost, 6),
      tokenShare: {
        freshInput: share(stats.tokens.freshInput, priceTokens), cacheRead: share(stats.tokens.cacheRead, priceTokens),
        cacheWrite: share(stats.tokens.cacheWrite, priceTokens), output: share(stats.tokens.output, priceTokens),
      },
      costShare: shares(stats.cost, totalCost),
      buckets: orderedBuckets.map(([ts]) => {
        const t = stats.buckets.get(ts) ?? zeroTotals();
        const total = totalOf(t);
        return { ts, label: bucketLabel(ts, bucket, tz), cost: roundTotals(t), total: round(total, 6), share: shares(t, total) };
      }),
    };
  });

  return {
    pricing: {
      totalRequests: rows.length, pricedRequests, unpricedRequests: rows.length - pricedRequests, pricedTokens, unpricedTokens,
      cost: round(cost, 4),
    },
    concentration: {
      sessions: n, partlyPricedSessions: partlyPriced, unpricedSessions, clippedSessions,
      noSessionId: { requests: noSession.requests, pricedRequests: noSession.priced, cost: noSession.priced ? round(noSession.cost, 4) : null },
      totalCost: n ? round(sessionCost, 4) : null,
      minimums: CONCENTRATION_MIN,
      top1pct: topShare(Math.ceil(n * 0.01), CONCENTRATION_MIN.top1pct),
      top5pct: topShare(Math.ceil(n * 0.05), CONCENTRATION_MIN.top5pct),
      top10Sessions: topShare(10, CONCENTRATION_MIN.top10Sessions),
      gini: n >= CONCENTRATION_MIN.gini ? gini(ascending) : null,
      curve,
    },
    tiers: {
      definitions: PRICE_TIERS.map(tier => ({ id: tier.id, label: tier.label, minRateIn: tier.minRateIn, maxRateIn: tier.maxRateIn })),
      models: Object.fromEntries(tierIds.map(id => [id, [...tierModels[id]].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12)
        .map(([model, requests]) => ({ model, requests }))])) as SpendStructure["tiers"]["models"],
      unclassifiedRequests: unclassified,
    },
    series: {
      bucket,
      buckets: orderedBuckets.map(([ts, slot]) => {
        const classified = tierIds.reduce((sum, id) => sum + slot.tiers[id].requests, 0);
        const classifiedTokens = tierIds.reduce((sum, id) => sum + slot.tiers[id].tokens, 0);
        return {
          ts, label: bucketLabel(ts, bucket, tz), requests: slot.requests, pricedRequests: slot.pricedRequests, pricedTokens: slot.pricedTokens,
          cost: slot.pricedRequests ? round(slot.cost, 6) : null, blendedPer1M: blended(slot.cost, slot.pricedTokens),
          tiers: Object.fromEntries(tierIds.map(id => {
            const t = slot.tiers[id];
            return [id, { requests: t.requests, tokens: t.tokens, blendedPer1M: blended(t.cost, t.tokens), requestShare: share(t.requests, classified), tokenShare: share(t.tokens, classifiedTokens) }];
          })) as SpendStructure["series"]["buckets"][number]["tiers"],
        };
      }),
    },
    classMix: mix,
  };
}
