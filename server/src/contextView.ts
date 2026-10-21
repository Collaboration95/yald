// The Context page (#102): context length per model, over time, by band, and what long
// contexts coincide with. Context length of a request is `inputTokens`, which already
// includes cache reads and writes. Only `contextEligible` rows count; excluded rows are
// counted as coverage, never as zero. These are associations, never causes.
import {
  bucketer, bucketLabel, bucketStarts, outcome, percentileOfSorted, round, sortedSample, type Bucket,
} from "./analytics";
import { orderedRequests, sessionGrowth } from "./labs/scope";
import type { RequestRow } from "./ocx/store";
import { ALL_SOURCES, contextEligible, sourceOf } from "./report/source";
import type { Source } from "./report/types";

/** Fixed, published band edges (input tokens): they do not move with the selection. */
export const CONTEXT_BANDS = [
  { id: "lt50k", label: "Under 50k", min: 0, max: 50_000 },
  { id: "50-150k", label: "50-150k", min: 50_000, max: 150_000 },
  { id: "150-300k", label: "150-300k", min: 150_000, max: 300_000 },
  { id: "300k+", label: "300k+", min: 300_000, max: Infinity },
] as const;

/** Thresholds for "at or above" shares. */
export const CONTEXT_THRESHOLDS = [50_000, 150_000, 300_000] as const;

/** Minimum eligible requests before a statistic is shown; below it the value is null ("too few requests"). */
export const CONTEXT_MIN_N = { box: 10, p90: 10, p99: 100, band: 10 } as const;

/** Models listed individually in the box chart and the model-by-band grid; the rest fold into Other. */
export const CONTEXT_TOP_MODELS = 12;
const TABLE_MODELS = 30;

/** Upper edges of the growth-ratio histogram (latest / baseline). */
const RATIO_EDGES = [0, 0.5, 0.9, 1.1, 2, 5, 10, Infinity];
const RATIO_LABELS = ["under 0.5x", "0.5-0.9x", "0.9-1.1x", "1.1-2x", "2-5x", "5-10x", "10x+"];

export interface ContextSpread {
  n: number;
  mean: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}

export interface ContextModelRow extends ContextSpread {
  /** Null on the folded "Other" row. */
  source: Source | null;
  /** Null on the folded "Other" row. */
  model: string | null;
  totalRequests: number;
  pricedRequests: number;
  /** Eligible requests per band, in `CONTEXT_BANDS` order. */
  bandCounts: number[];
  /** `bandCounts` over `n`; row-normalised so a small model is readable. Empty when n is 0. */
  bandShares: number[];
}

export interface ContextThresholdRow {
  /** Input tokens, or null for the pricing engine's own long-context tier. */
  at: number | null;
  label: string;
  requests: number;
  requestShare: number | null;
  /** Priced requests among `requests`; cost and its share are null when this is 0. */
  pricedRequests: number;
  cost: number | null;
  costShare: number | null;
}

export interface ContextTaxRow {
  id: string;
  label: string;
  min: number;
  max: number | null;
  requests: number;
  requestShare: number | null;
  cost: number | null;
  costShare: number | null;
  pricedRequests: number;
  costPerPricedRequest: number | null;
  /** Median time to first token; ocx rows only. Null with n 0 means "not recorded", with n > 0 "too few". */
  ttftP50: number | null;
  ttftMeasured: number;
  cancelRate: number | null;
  outcomesObserved: number;
  cancelled: number;
  belowMinimum: boolean;
  topModels: { source: Source; model: string; share: number }[];
}

export interface ContextBreakdown {
  bands: { id: string; label: string; min: number; max: number | null }[];
  minimums: typeof CONTEXT_MIN_N;
  coverage: {
    totalRequests: number;
    eligibleRequests: number;
    excludedRequests: number;
    pricedEligibleRequests: number;
    unpricedEligibleRequests: number;
    unnamedRequests: number;
  };
  sources: { source: Source; totalRequests: number; eligibleRequests: number; ttftMeasured: number; outcomesObserved: number }[];
  overall: ContextSpread;
  bySource: (ContextSpread & { source: Source })[];
  models: ContextModelRow[];
  modelsOmitted: number;
  box: ContextModelRow[];
  modelBands: ContextModelRow[];
  thresholds: ContextThresholdRow[];
  tax: ContextTaxRow[];
  timeline: {
    bucket: Bucket;
    buckets: { ts: number; label: string }[];
    series: { source: Source; n: number[]; p50: (number | null)[]; p90: (number | null)[] }[];
  };
  growth: {
    sessions: number;
    ranked: number;
    unranked: number;
    /** Ranked sessions whose baseline input is 0, so no ratio exists. */
    noRatio: number;
    /** Ranked sessions with requests outside the window (loaded history only). */
    clippedRanked: number;
    medianRatio: number | null;
    histogram: { name: string; value: number }[];
    minEligible: number;
  };
}

function spread(values: number[]): ContextSpread {
  const n = values.length;
  const sorted = sortedSample(values);
  const at = (p: number, min: number) => n >= min ? percentileOfSorted(sorted, p) : null;
  let sum = 0;
  for (const value of values) sum += value;
  return {
    n,
    mean: n ? Math.round(sum / n) : null,
    p10: at(0.1, CONTEXT_MIN_N.box),
    p25: at(0.25, CONTEXT_MIN_N.box),
    p50: at(0.5, 1),
    p75: at(0.75, CONTEXT_MIN_N.box),
    p90: at(0.9, CONTEXT_MIN_N.p90),
    p99: at(0.99, CONTEXT_MIN_N.p99),
    max: n ? sorted[n - 1]! : null,
  };
}

function bandIndex(input: number): number {
  for (let i = CONTEXT_BANDS.length - 1; i >= 0; i--) if (input >= CONTEXT_BANDS[i]!.min) return i;
  return 0;
}

const share = (part: number, whole: number): number | null => whole > 0 ? round(part / whole, 4) : null;

interface ModelAccumulator {
  source: Source | null;
  model: string | null;
  values: number[];
  total: number;
  priced: number;
  bandCounts: number[];
}

const accumulator = (source: Source | null, model: string | null): ModelAccumulator => ({
  source, model, values: [], total: 0, priced: 0, bandCounts: CONTEXT_BANDS.map(() => 0),
});

function modelRow(entry: ModelAccumulator): ContextModelRow {
  const n = entry.values.length;
  return {
    source: entry.source, model: entry.model, ...spread(entry.values), totalRequests: entry.total, pricedRequests: entry.priced,
    bandCounts: entry.bandCounts, bandShares: n ? entry.bandCounts.map(count => round(count / n, 4)) : [],
  };
}

interface BandAccumulator {
  n: number;
  cost: number;
  priced: number;
  ttfts: number[];
  observed: number;
  cancelled: number;
  models: Map<string, { source: Source; model: string; n: number }>;
}

/**
 * Context-length analytics over already-filtered `rows`. `datasetRows` is the whole dataset and is
 * read only to flag sessions the window clips (loaded history only). Buckets come from the
 * memoized bucketer, never a per-row zone lookup.
 */
export function contextBreakdown(
  rows: readonly RequestRow[],
  options: { bucket: Bucket; from: number; to: number; tz: string; datasetRows?: readonly RequestRow[] },
): ContextBreakdown {
  const { bucket, from, to, tz } = options;
  const bucketOf = bucketer(bucket, tz);

  const overall: number[] = [];
  const perSource = new Map<Source, { values: number[]; total: number; ttft: number; observed: number }>(
    ALL_SOURCES.map(source => [source, { values: [], total: 0, ttft: 0, observed: 0 }]),
  );
  const perModel = new Map<string, ModelAccumulator>();
  const timeline = new Map<number, Map<Source, number[]>>();
  const bands: BandAccumulator[] = CONTEXT_BANDS.map(() => ({ n: 0, cost: 0, priced: 0, ttfts: [], observed: 0, cancelled: 0, models: new Map() }));
  const above = CONTEXT_THRESHOLDS.map(() => ({ n: 0, priced: 0, cost: 0 }));
  const longTier = { n: 0, priced: 0, cost: 0 };
  let eligibleCost = 0;
  let pricedEligible = 0;
  let unnamed = 0;
  const sessions = new Map<Source, Map<string, RequestRow[]>>();

  for (const row of rows) {
    const source = sourceOf(row);
    const sourceStats = perSource.get(source)!;
    sourceStats.total++;
    if (!row.conversationId) unnamed++;
    else {
      let bySession = sessions.get(source);
      if (!bySession) sessions.set(source, bySession = new Map());
      const list = bySession.get(row.conversationId);
      if (list) list.push(row);
      else bySession.set(row.conversationId, [row]);
    }
    const key = `${source}\u0000${row.model}`;
    let model = perModel.get(key);
    if (!model) perModel.set(key, model = accumulator(source, row.model));
    model.total++;
    if (!contextEligible(row)) continue;

    const input = row.inputTokens;
    const index = bandIndex(input);
    overall.push(input);
    sourceStats.values.push(input);
    model.values.push(input);
    model.bandCounts[index]!++;
    if (row.priced) {
      model.priced++;
      pricedEligible++;
      eligibleCost += row.cost;
    }

    const start = bucketOf(row.ts);
    let byBucket = timeline.get(start);
    if (!byBucket) timeline.set(start, byBucket = new Map());
    const bucketValues = byBucket.get(source);
    if (bucketValues) bucketValues.push(input);
    else byBucket.set(source, [input]);

    const band = bands[index]!;
    band.n++;
    const slot = band.models.get(key);
    if (slot) slot.n++;
    else band.models.set(key, { source, model: row.model, n: 1 });
    if (row.priced) {
      band.priced++;
      band.cost += row.cost;
    }
    if (row.measurements.ttft && row.ttftMs !== null) {
      band.ttfts.push(row.ttftMs);
      sourceStats.ttft++;
    }
    if (outcome(row) !== "unobserved") {
      band.observed++;
      sourceStats.observed++;
      if (outcome(row) === "cancelled") band.cancelled++;
    }
    CONTEXT_THRESHOLDS.forEach((threshold, i) => {
      if (input < threshold) return;
      above[i]!.n++;
      if (row.priced) {
        above[i]!.priced++;
        above[i]!.cost += row.cost;
      }
    });
    if (row.contextTier === "long") {
      longTier.n++;
      if (row.priced) {
        longTier.priced++;
        longTier.cost += row.cost;
      }
    }
  }

  const eligible = overall.length;
  const ranked = [...perModel.values()].filter(entry => entry.values.length > 0)
    .sort((a, b) => b.values.length - a.values.length || (a.source ?? "").localeCompare(b.source ?? "") || (a.model ?? "").localeCompare(b.model ?? ""));
  const top = ranked.slice(0, CONTEXT_TOP_MODELS);
  const rest = ranked.slice(CONTEXT_TOP_MODELS);
  const folded = (): ContextModelRow[] => {
    if (rest.length === 0) return [];
    const other = accumulator(null, null);
    for (const entry of rest) {
      for (const value of entry.values) other.values.push(value);
      other.total += entry.total;
      other.priced += entry.priced;
      entry.bandCounts.forEach((count, i) => { other.bandCounts[i]! += count; });
    }
    return [modelRow(other)];
  };
  const topRows = top.map(modelRow);

  const taxRows: ContextTaxRow[] = CONTEXT_BANDS.map((definition, i) => {
    const band = bands[i]!;
    const ttft = sortedSample(band.ttfts);
    const topModels = [...band.models.values()].sort((a, b) => b.n - a.n || a.model.localeCompare(b.model)).slice(0, 3)
      .map(entry => ({ source: entry.source, model: entry.model, share: round(entry.n / band.n, 4) }));
    return {
      id: definition.id, label: definition.label, min: definition.min, max: Number.isFinite(definition.max) ? definition.max : null,
      requests: band.n, requestShare: share(band.n, eligible),
      cost: band.priced ? round(band.cost, 4) : null, costShare: band.priced && eligibleCost > 0 ? share(band.cost, eligibleCost) : null,
      pricedRequests: band.priced,
      costPerPricedRequest: band.priced >= CONTEXT_MIN_N.band ? round(band.cost / band.priced, 4) : null,
      ttftP50: band.ttfts.length >= CONTEXT_MIN_N.band ? percentileOfSorted(ttft, 0.5) : null,
      ttftMeasured: band.ttfts.length,
      cancelRate: band.observed >= CONTEXT_MIN_N.band ? round(band.cancelled / band.observed, 4) : null,
      outcomesObserved: band.observed, cancelled: band.cancelled,
      belowMinimum: band.n < CONTEXT_MIN_N.band,
      topModels,
    };
  });

  // Over time: p50 and p90 per bucket and source; an empty bucket is null, never 0.
  const starts = new Set(bucketStarts(bucket, from, to, tz));
  for (const ts of timeline.keys()) starts.add(ts);
  const ordered = [...starts].sort((a, b) => a - b);
  const timelineSeries = ALL_SOURCES.filter(source => perSource.get(source)!.values.length > 0).map(source => {
    const n: number[] = [];
    const p50: (number | null)[] = [];
    const p90: (number | null)[] = [];
    for (const ts of ordered) {
      const values = timeline.get(ts)?.get(source);
      const sorted = sortedSample(values ?? []);
      n.push(sorted.length);
      p50.push(percentileOfSorted(sorted, 0.5));
      p90.push(sorted.length >= CONTEXT_MIN_N.p90 ? percentileOfSorted(sorted, 0.9) : null);
    }
    return { source, n, p50, p90 };
  });

  // Session growth, through the helper Context Replay uses.
  const ratios: number[] = [];
  const rankedIds = new Map<Source, Set<string>>();
  let sessionCount = 0;
  let rankedCount = 0;
  let noRatio = 0;
  for (const [source, bySession] of sessions) {
    for (const [id, list] of bySession) {
      sessionCount++;
      if (list.length < 6) continue;
      const growth = sessionGrowth(orderedRequests(list));
      if (!growth.ranked) continue;
      rankedCount++;
      let ids = rankedIds.get(source);
      if (!ids) rankedIds.set(source, ids = new Set());
      ids.add(id);
      if (growth.ratio === null) noRatio++;
      else ratios.push(growth.ratio);
    }
  }
  const clipped = new Set<string>();
  if (options.datasetRows && rankedCount > 0) {
    for (const row of options.datasetRows) {
      if (!row.conversationId || (row.ts >= from && row.ts < to)) continue;
      const source = sourceOf(row);
      if (rankedIds.get(source)?.has(row.conversationId)) clipped.add(JSON.stringify([source, row.conversationId]));
    }
  }
  const histogram = RATIO_LABELS.map(name => ({ name, value: 0 }));
  for (const ratio of ratios) {
    const i = RATIO_EDGES.findIndex((edge, index) => ratio >= edge && ratio < RATIO_EDGES[index + 1]!);
    if (i >= 0) histogram[i]!.value++;
  }

  return {
    bands: CONTEXT_BANDS.map(band => ({ id: band.id, label: band.label, min: band.min, max: Number.isFinite(band.max) ? band.max : null })),
    minimums: CONTEXT_MIN_N,
    coverage: {
      totalRequests: rows.length, eligibleRequests: eligible, excludedRequests: rows.length - eligible,
      pricedEligibleRequests: pricedEligible, unpricedEligibleRequests: eligible - pricedEligible, unnamedRequests: unnamed,
    },
    sources: ALL_SOURCES.map(source => {
      const stats = perSource.get(source)!;
      return { source, totalRequests: stats.total, eligibleRequests: stats.values.length, ttftMeasured: stats.ttft, outcomesObserved: stats.observed };
    }).filter(entry => entry.totalRequests > 0),
    overall: spread(overall),
    bySource: ALL_SOURCES.filter(source => perSource.get(source)!.values.length > 0).map(source => ({ source, ...spread(perSource.get(source)!.values) })),
    models: ranked.slice(0, TABLE_MODELS).map(modelRow),
    modelsOmitted: Math.max(0, ranked.length - TABLE_MODELS),
    box: topRows,
    modelBands: [...topRows, ...folded()],
    thresholds: [
      ...CONTEXT_THRESHOLDS.map((threshold, i) => ({
        at: threshold, label: `${threshold / 1000}k or more`, requests: above[i]!.n,
        requestShare: share(above[i]!.n, eligible), pricedRequests: above[i]!.priced,
        cost: above[i]!.priced ? round(above[i]!.cost, 4) : null, costShare: above[i]!.priced ? share(above[i]!.cost, eligibleCost) : null,
      })),
      {
        at: null, label: "Engine long-context tier", requests: longTier.n, requestShare: share(longTier.n, eligible),
        pricedRequests: longTier.priced, cost: longTier.priced ? round(longTier.cost, 4) : null,
        costShare: longTier.priced ? share(longTier.cost, eligibleCost) : null,
      },
    ],
    tax: taxRows,
    timeline: {
      bucket, buckets: ordered.map(ts => ({ ts, label: bucketLabel(ts, bucket, tz) })), series: timelineSeries,
    },
    growth: {
      sessions: sessionCount, ranked: rankedCount, unranked: sessionCount - rankedCount, noRatio, clippedRanked: clipped.size,
      medianRatio: ratios.length ? round(percentileOfSorted(sortedSample(ratios), 0.5)!, 3) : null,
      histogram, minEligible: 6,
    },
  };
}
