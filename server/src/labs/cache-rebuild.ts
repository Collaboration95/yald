// Cache write bill and rebuild ledger (#107): where Anthropic cache write volume comes from, and how
// much of it wrote again what the previous request in the same chain had cached. Causes are labelled
// reported or inferred. Dollars are upper bounds at effective rates and are never added to Cache
// Detective's write premium, which compares writes with uncached input.
import { classCost, filterRows, round, type RowFilter } from "../analytics";
import type { ClaudeEvent } from "../claude/transcripts";
import type { RequestRow } from "../ocx/store";
import { sourceOf } from "../report/source";
import type { Source } from "../report/types";
import { spendStructure } from "../spendStructure";
import { round6 } from "./cache";
import { compactionIndex } from "./context";
import { REBUILD_CAUSES, type LedgerClass, type RebuildCause } from "./evidence-intent";
import { chainKey, evidenceFor, orderedRequests, requestsBefore, sessionKey, type AnalysisWindow, type EvidenceSelection } from "./scope";

export const LEDGER_EXCLUSIONS = ["cache-unmeasured", "no-session", "no-agent-marker"] as const;
export type LedgerExclusion = typeof LEDGER_EXCLUSIONS[number];
export type LedgerLabel = "first request" | "reported" | "inferred" | "no evidence";

/** A cache entry's lifetime by the split of the write that made it (#96). */
const TTL_5M_MS = 5 * 60_000;
const TTL_1H_MS = 60 * 60_000;
/** Fewer eligible chains than this is a list of requests, not a finding. */
export const LEDGER_MIN_CHAINS = 20;
/** A gap bucket with fewer requests shows its count but no rate. */
export const WARM_MIN_REQUESTS = 20;
const TOP_CHAINS = 8;
const MINUTE = 60_000;
const GAP_BUCKETS = [
  { label: "Under 1m", below: MINUTE }, { label: "1-5m", below: 5 * MINUTE }, { label: "5-15m", below: 15 * MINUTE },
  { label: "15-60m", below: 60 * MINUTE }, { label: "Over 60m", below: Infinity },
];

/** First match wins. Null is in the ledger; a row outside Anthropic is "not-applicable", never a zero. */
export function ledgerExclusion(row: RequestRow): LedgerExclusion | "not-applicable" | null {
  if (row.provider !== "anthropic") return "not-applicable";
  if (!row.measurements.cacheRead || !row.measurements.cacheWrite || row.cacheProvenance !== "observed") return "cache-unmeasured";
  if (row.conversationId === null) return "no-session";
  return row.details?.agent ? null : "no-agent-marker";
}

export interface LedgerEntry {
  chain: string;
  agentId: string;
  /** Null for a continuing request that is neither a start nor a rebuild. */
  class: LedgerClass | null;
  label: LedgerLabel | null;
  /** Every cause that matched, in rule order. The class is the first of them. */
  signals: RebuildCause[];
  /** The raw `cache_miss_reason`, kept verbatim. */
  reason: string | null;
  gapMs: number | null;
  rewrittenTokens: number;
  /** Null when no effective rate is known: unpriced, never zero. */
  premiumUsd: number | null;
  borrowedRate: boolean;
  previous: RequestRow | null;
}

const LABELS: Record<RebuildCause, LedgerLabel> = {
  reported: "reported", compaction: "inferred", "model-switch": "inferred", "idle-gap": "inferred", "no-evidence": "no evidence",
};

/** What the previous request had cached and this one wrote again. The rest of the write is new content. */
const rewritten = (row: RequestRow, previous: RequestRow): number =>
  Math.min(row.cacheWriteTokens, Math.max(0, previous.cacheReadTokens + previous.cacheWriteTokens - row.cacheReadTokens));

const rateKey = (row: RequestRow) => JSON.stringify([row.model, row.cacheEconomics?.available ? row.cacheEconomics.contextTier : null]);

/**
 * The engine reports no read rate for a row that read nothing, and those are the fullest rebuilds. Such a row
 * uses the effective rate of an earlier request in its chain with the same model and context tier: the same
 * engine figure, never the base rate. Without one the row is unpriced.
 */
function premiumOf(row: RequestRow, tokens: number, readRates: ReadonlyMap<string, number>): { premiumUsd: number | null; borrowedRate: boolean } {
  if (tokens === 0) return { premiumUsd: 0, borrowedRate: false };
  const rates = row.cacheEconomics?.available ? row.cacheEconomics.rates : null;
  const read = rates?.cacheRead ?? (rates ? readRates.get(rateKey(row)) ?? null : null);
  if (!rates || rates.cacheWrite === null || read === null) return { premiumUsd: null, borrowedRate: false };
  return { premiumUsd: (tokens * (rates.cacheWrite - read)) / 1e6, borrowedRate: rates.cacheRead === null };
}

function ttlOf(row: RequestRow): number | null {
  const fiveMinute = row.details?.cacheWrite5m ?? null;
  const oneHour = row.details?.cacheWrite1h ?? null;
  if (fiveMinute === null && oneHour === null) return null;
  return (oneHour ?? 0) > 0 ? TTL_1H_MS : TTL_5M_MS;
}

function classify(row: RequestRow, previous: RequestRow, signals: { compacted: boolean; ttlMs: number | null }): RebuildCause[] {
  const gap = row.ts - previous.ts;
  const matched: RebuildCause[] = [];
  if (row.details?.cacheMissReason) matched.push("reported");
  if (signals.compacted) matched.push("compaction");
  if (row.model !== previous.model) matched.push("model-switch");
  if (signals.ttlMs !== null && gap > signals.ttlMs) matched.push("idle-gap");
  return matched.length ? matched : ["no-evidence"];
}

function buildIndex(datasetRows: readonly RequestRow[], events: readonly ClaudeEvent[]) {
  const chains = new Map<string, { source: Source; conversationId: string; agentId: string; rows: RequestRow[] }>();
  const sessions = new Map<string, RequestRow[]>();
  for (const row of datasetRows) {
    if (ledgerExclusion(row) !== null) continue;
    const source = sourceOf(row);
    const conversationId = row.conversationId!;
    const key = chainKey(source, conversationId, row.details!.agentId);
    let chain = chains.get(key);
    if (!chain) chains.set(key, chain = { source, conversationId, agentId: row.details!.agentId ?? "main", rows: [] });
    chain.rows.push(row);
    const session = sessionKey(source, conversationId);
    const list = sessions.get(session);
    if (list) list.push(row);
    else sessions.set(session, [row]);
  }
  const compactions = compactionIndex(events).bySession;
  const entries = new Map<RequestRow, LedgerEntry>();
  for (const [key, chain] of chains) {
    const ordered = orderedRequests(chain.rows);
    const timestamps = ordered.map(row => row.ts);
    const compacted = new Set((chain.source === "claude-code" ? compactions.get(chain.conversationId) ?? [] : [])
      .filter(event => (event.agentId ?? "main") === chain.agentId).map(event => requestsBefore(timestamps, event.ts)));
    let ttlMs: number | null = null;
    const readRates = new Map<string, number>();
    ordered.forEach((row, index) => {
      const previous = ordered[index - 1] ?? null;
      const base = { chain: key, agentId: chain.agentId, reason: null, signals: [], gapMs: null, rewrittenTokens: 0, premiumUsd: 0, borrowedRate: false, previous };
      if (!previous) entries.set(row, { ...base, class: row.details!.agent === "subagent" ? "subagent-start" : "session-start", label: "first request" });
      else if (row.cacheWriteTokens > row.cacheReadTokens) {
        const signals = classify(row, previous, { compacted: compacted.has(index), ttlMs });
        const tokens = rewritten(row, previous);
        entries.set(row, { ...base, class: signals[0]!, label: LABELS[signals[0]!], signals, reason: row.details?.cacheMissReason ?? null,
          gapMs: row.ts - previous.ts, rewrittenTokens: tokens, ...premiumOf(row, tokens, readRates) });
      } else entries.set(row, { ...base, class: null, label: null, gapMs: row.ts - previous.ts });
      // A read-only request refreshes the entry and says nothing new about its lifetime.
      if (row.cacheWriteTokens > 0) ttlMs = ttlOf(row);
      const readRate = row.cacheEconomics?.available ? row.cacheEconomics.rates.cacheRead : null;
      if (readRate !== null) readRates.set(rateKey(row), readRate);
    });
  }
  // The same rule over a whole session, where a subagent's small first read follows the main agent's large one.
  const sessionBusts = new Set<RequestRow>();
  for (const rows of sessions.values()) {
    orderedRequests(rows).forEach((row, index, ordered) => {
      if (index && row.cacheWriteTokens > row.cacheReadTokens && rewritten(row, ordered[index - 1]!) > 0) sessionBusts.add(row);
    });
  }
  return { chains, entries, sessionBusts };
}

const indexes = new WeakMap<object, { events: readonly ClaudeEvent[]; index: ReturnType<typeof buildIndex> }>();

/** Chains are whole-history: a window never turns a continuing request into a first one. Cached per dataset. */
export function ledgerIndex(datasetRows: readonly RequestRow[], events: readonly ClaudeEvent[]) {
  const cached = indexes.get(datasetRows);
  if (cached?.events === events) return cached.index;
  const index = buildIndex(datasetRows, events);
  indexes.set(datasetRows, { events, index });
  return index;
}

const emptyLedger = () => ({ requests: 0, writeTokens: 0, writeCostUsd: 0, rewrittenTokens: 0, premiumUsd: 0, unpricedRequests: 0, borrowedRateRequests: 0 });

function writeBill(rows: RequestRow[], window: AnalysisWindow) {
  const mix = spendStructure(rows, { bucket: "week", from: window.from, to: window.to, tz: window.tz }).classMix;
  if (!mix.length) return null;
  const sum = (read: (entry: typeof mix[number]) => number) => mix.reduce((total, entry) => total + read(entry), 0);
  const tokens = {
    freshInput: sum(entry => entry.tokens.freshInput), cacheRead: sum(entry => entry.tokens.cacheRead),
    cacheWrite: sum(entry => entry.tokens.cacheWrite), output: sum(entry => entry.tokens.output),
  };
  const cost = {
    freshInput: sum(entry => entry.cost.freshInput), cacheRead: sum(entry => entry.cost.cacheRead),
    cacheWrite: sum(entry => entry.cost.cacheWrite), output: sum(entry => entry.cost.output),
  };
  const totalTokens = tokens.freshInput + tokens.cacheRead + tokens.cacheWrite + tokens.output;
  const totalCost = sum(entry => entry.totalCost);
  const shares = (values: typeof tokens, whole: number) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, whole > 0 ? round(value / whole, 4) : null])) as Record<keyof typeof tokens, number | null>;
  return { pricedRequests: sum(entry => entry.pricedRequests), tokens, cost: { ...cost, cacheWrite: round6(cost.cacheWrite) }, totalCostUsd: round6(totalCost), tokenShare: shares(tokens, totalTokens), costShare: shares(cost, totalCost) };
}

const NOTES = [
  "A rebuild is a request after the first in its chain that wrote more cache than it read. That is a threshold on counters: it does not prove that a cache entry existed and expired.",
  "Reported causes come from the API's cache_miss_reason, which appears on some lines only. Every other cause is inferred from the request sequence, and a request with no recorded reason has not been shown to hit its cache.",
  "The premium is rewritten tokens times write rate minus read rate at the row's effective rates: an upper bound that assumes the earlier prefix could have been reused. It is a different figure from the write premium above, which compares writes with uncached input. Do not add them.",
  "A row that read no cache has no effective read rate of its own. It uses the rate of an earlier request in its chain with the same model and context tier; without one its premium is unpriced, not zero.",
  "Dollars use the engine's single write rate, so 1-hour writes are understated. Costs are API list-price equivalents, not bills.",
];

/**
 * The write bill and ledger for `selected`, by default the rows `filter` matches. `datasetRows` supplies whole
 * chains and is the array whose identity caches them. Rows outside Anthropic are counted, never zeroed.
 */
export function buildCacheRebuilds(datasetRows: readonly RequestRow[], filter: RowFilter, window: AnalysisWindow, events: readonly ClaudeEvent[], selected: readonly RequestRow[] = filterRows(datasetRows as RequestRow[], filter)) {
  const index = ledgerIndex(datasetRows, events);
  const anthropic = selected.filter(row => row.provider === "anthropic");
  const excluded = Object.fromEntries(LEDGER_EXCLUSIONS.map(reason => [reason, 0])) as Record<LedgerExclusion, number>;
  const unmarked = new Set<string>();
  const ledger = new Map<LedgerClass, ReturnType<typeof emptyLedger>>();
  const seen = new Set<string>();
  const started = new Set<string>();
  const reasons = new Map<string, number>();
  const chains = new Map<string, ReturnType<typeof emptyLedger>>();
  const gaps = GAP_BUCKETS.map(() => ({ requests: 0, warm: 0 }));
  let eligible = 0, sessionBusts = 0, chainBusts = 0, disappeared = 0, fiveMinute = 0, oneHour = 0, unsplit = 0;
  for (const row of anthropic) {
    const fiveMinuteTokens = row.details?.cacheWrite5m ?? null;
    const oneHourTokens = row.details?.cacheWrite1h ?? null;
    if (fiveMinuteTokens === null && oneHourTokens === null) unsplit += row.cacheWriteTokens;
    else { fiveMinute += fiveMinuteTokens ?? 0; oneHour += oneHourTokens ?? 0; }
    const reason = ledgerExclusion(row);
    if (reason) {
      excluded[reason as LedgerExclusion]++;
      if (reason === "no-agent-marker") unmarked.add(sessionKey(sourceOf(row), row.conversationId!));
      continue;
    }
    eligible++;
    const entry = index.entries.get(row)!;
    seen.add(entry.chain);
    if (entry.previous === null) started.add(entry.chain);
    else if (row.cacheReadTokens + row.cacheWriteTokens > 0) {
      const bucket = gaps[GAP_BUCKETS.findIndex(gap => entry.gapMs! < gap.below)]!;
      bucket.requests++;
      if (row.cacheReadTokens >= row.cacheWriteTokens) bucket.warm++;
    }
    const inSession = index.sessionBusts.has(row);
    const inChain = entry.rewrittenTokens > 0;
    if (inSession) sessionBusts++;
    if (inChain) chainBusts++;
    if (inSession && !inChain) disappeared++;
    if (!entry.class) continue;
    if (entry.reason) reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
    const targets = [ledger.get(entry.class) ?? emptyLedger()];
    ledger.set(entry.class, targets[0]!);
    if (entry.previous) {
      const chain = chains.get(entry.chain) ?? emptyLedger();
      chains.set(entry.chain, chain);
      targets.push(chain);
    }
    for (const target of targets) {
      target.requests++;
      target.writeTokens += row.cacheWriteTokens;
      if (row.priced) target.writeCostUsd += classCost(row).cacheWrite;
      target.rewrittenTokens += entry.rewrittenTokens;
      if (entry.premiumUsd === null) target.unpricedRequests++;
      else target.premiumUsd += entry.premiumUsd;
      if (entry.borrowedRate) target.borrowedRateRequests++;
    }
  }
  const evidence = (selection: EvidenceSelection, cause?: LedgerClass) => evidenceFor(filter, window, selection, "rebuild", cause);
  const scopeSelection: EvidenceSelection = { kind: "scope" };
  const rows = (["session-start", "subagent-start", ...REBUILD_CAUSES] as LedgerClass[]).map(id => {
    const value = ledger.get(id) ?? emptyLedger();
    const start = id === "session-start" || id === "subagent-start";
    const priced = value.requests - value.unpricedRequests;
    return {
      class: id, label: start ? "first request" as const : LABELS[id as RebuildCause], requests: value.requests, writeTokens: value.writeTokens, writeCostUsd: round6(value.writeCostUsd),
      rewrittenTokens: start ? null : value.rewrittenTokens, premiumUsd: start || (value.requests && !priced) ? null : round6(value.premiumUsd),
      pricedRequests: start ? null : priced, unpricedRequests: start ? 0 : value.unpricedRequests, borrowedRateRequests: value.borrowedRateRequests, evidence: evidence(scopeSelection, id),
    };
  });
  const rebuildRows = rows.filter(row => row.label !== "first request");
  const count = (cause: RebuildCause) => rows.find(row => row.class === cause)!.requests;
  const rebuilds = rebuildRows.reduce((sum, row) => sum + row.requests, 0);
  const premiumUsd = round6(rebuildRows.reduce((sum, row) => sum + (row.premiumUsd ?? 0), 0));
  const topChains = [...chains].sort((a, b) => b[1].premiumUsd - a[1].premiumUsd || b[1].rewrittenTokens - a[1].rewrittenTokens || a[0].localeCompare(b[0])).slice(0, TOP_CHAINS).map(([key, value]) => {
    const chain = index.chains.get(key)!;
    return { key, source: chain.source, conversationId: chain.conversationId, agentId: chain.agentId, requests: value.requests, rewrittenTokens: value.rewrittenTokens,
      premiumUsd: round6(value.premiumUsd), unpricedRequests: value.unpricedRequests,
      evidence: evidence({ kind: "chain", source: chain.source, conversationId: chain.conversationId, agentId: chain.agentId }) };
  });
  const state = !anthropic.length ? "not-applicable" as const : seen.size >= LEDGER_MIN_CHAINS ? "observed" as const : "insufficient" as const;
  return {
    state, minChains: LEDGER_MIN_CHAINS,
    /** Non-Anthropic rows have no write premium: not applicable, not zero. */
    notApplicableRequests: selected.length - anthropic.length,
    coverage: {
      totalRequests: anthropic.length, eligibleRequests: eligible, excluded,
      eligibleChains: seen.size, totalChains: seen.size + unmarked.size, clippedChains: seen.size - started.size,
    },
    writeBill: anthropic.length ? { ...writeBill(anthropic, window), ttl: { fiveMinuteTokens: fiveMinute, oneHourTokens: oneHour, unsplitTokens: unsplit } } : null,
    ledger: rows,
    totals: {
      requests: rebuilds, reported: count("reported"), inferred: count("compaction") + count("model-switch") + count("idle-gap"), noEvidence: count("no-evidence"),
      afterCompaction: count("compaction"), atModelSwitch: count("model-switch"), afterIdleGap: count("idle-gap"),
      rewrittenTokens: rebuildRows.reduce((sum, row) => sum + (row.rewrittenTokens ?? 0), 0), premiumUsd,
      unpricedRequests: rebuildRows.reduce((sum, row) => sum + row.unpricedRequests, 0),
      borrowedRateRequests: rebuildRows.reduce((sum, row) => sum + row.borrowedRateRequests, 0),
    },
    reasons: [...reasons].map(([reason, requests]) => ({ reason, requests })).sort((a, b) => b.requests - a.requests || a.reason.localeCompare(b.reason)),
    warmByGap: GAP_BUCKETS.map((gap, position) => ({
      label: gap.label, requests: gaps[position]!.requests,
      warmShare: gaps[position]!.requests >= WARM_MIN_REQUESTS ? round(gaps[position]!.warm / gaps[position]!.requests, 4) : null,
    })),
    warmMinRequests: WARM_MIN_REQUESTS,
    interleaving: { bySession: sessionBusts, byChain: chainBusts, disappeared },
    topChains,
    evidence: evidence(scopeSelection),
    notes: NOTES,
  };
}

export type CacheRebuilds = ReturnType<typeof buildCacheRebuilds>;
