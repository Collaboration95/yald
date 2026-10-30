// Subagents (#101): how much of Claude Code's usage ran in subagents, how sessions fan out, and what
// each subagent's first request cost. Describes structure and list-price equivalents only: a share
// is not waste, and a request counts once, under its own agent kind. An unlabelled row is its own
// slice and never main. Codex is reported apart: its root threads can hold subagent traffic.
import { agentKind, bucketer, bucketLabel, bucketStarts, classCost, percentile, round, type AgentKind, type Bucket } from "./analytics";
import { chainKey, sessionKey } from "./labs/scope";
import type { RequestRow } from "./ocx/store";
import { createProjectIdentity, UNATTRIBUTED } from "./projects";
import { sourceOf } from "./report/source";

export const FAN_OUT_BINS = [
  { label: "0", min: 0, max: 0 }, { label: "1", min: 1, max: 1 }, { label: "2-3", min: 2, max: 3 },
  { label: "4-7", min: 4, max: 7 }, { label: "8-15", min: 8, max: 15 }, { label: "16+", min: 16, max: Number.POSITIVE_INFINITY },
] as const;

/** Largest number of per-spawn scatter points in one response; the rest are counted, as `ttftVsOutput` is capped. */
export const SCATTER_CAP = 2_000;
export const TOP_ROWS = 10;
export const SHORT_SPAWN_REQUESTS = 2;
const KINDS: AgentKind[] = ["main", "subagent", "unlabelled"];

interface Tally { requests: number; tokens: number; inputTokens: number; costUsd: number; pricedRequests: number }
const zero = (): Tally => ({ requests: 0, tokens: 0, inputTokens: 0, costUsd: 0, pricedRequests: 0 });

function add(tally: Tally, row: RequestRow): void {
  tally.requests++;
  tally.tokens += row.totalTokens;
  tally.inputTokens += row.inputTokens;
  if (row.priced) {
    tally.costUsd += row.cost;
    tally.pricedRequests++;
  }
}

const rounded = (tally: Tally): Tally => ({ ...tally, costUsd: round(tally.costUsd, 4) });
const share = (part: number, whole: number): number | null => (whole > 0 ? round(part / whole, 4) : null);

export interface KindSplit { main: Tally; subagent: Tally; unlabelled: Tally }
const zeroSplit = (): KindSplit => ({ main: zero(), subagent: zero(), unlabelled: zero() });
const roundedSplit = (split: KindSplit): KindSplit => ({ main: rounded(split.main), subagent: rounded(split.subagent), unlabelled: rounded(split.unlabelled) });

function kindShares(split: KindSplit) {
  const total = KINDS.reduce((sum, kind) => { const t = split[kind]; return { requests: sum.requests + t.requests, tokens: sum.tokens + t.tokens, inputTokens: sum.inputTokens + t.inputTokens, costUsd: sum.costUsd + t.costUsd }; }, { requests: 0, tokens: 0, inputTokens: 0, costUsd: 0 });
  return KINDS.map(kind => {
    const tally = split[kind];
    return {
      kind, ...rounded(tally),
      requestShare: share(tally.requests, total.requests), tokenShare: share(tally.tokens, total.tokens),
      inputShare: share(tally.inputTokens, total.inputTokens), costShare: share(tally.costUsd, total.costUsd),
      /** Priced requests of this kind over its requests. Cost shares cover priced rows only. */
      pricedShare: share(tally.pricedRequests, tally.requests),
    };
  });
}

interface Spawn { agentId: string; agentType: string; depth: number | null; rows: RequestRow[]; first: RequestRow }

function topRows<T extends { key: string; split: KindSplit }>(groups: Map<string, T>, limit = TOP_ROWS) {
  const total = (entry: T) => KINDS.reduce((sum, kind) => sum + entry.split[kind].costUsd, 0);
  const sorted = [...groups.values()].sort((a, b) => total(b) - total(a) || a.key.localeCompare(b.key));
  const other = zeroSplit();
  for (const entry of sorted.slice(limit)) {
    for (const kind of KINDS) {
      for (const field of ["requests", "tokens", "inputTokens", "costUsd", "pricedRequests"] as const) other[kind][field] += entry.split[kind][field];
    }
  }
  const rows = sorted.slice(0, limit).map(entry => ({ key: entry.key, split: roundedSplit(entry.split) }));
  return sorted.length > limit ? [...rows, { key: "Other", split: roundedSplit(other) }] : rows;
}

/**
 * The first request of each spawn in the selection is only its true first request if the dataset
 * has nothing earlier for that chain: a window or filter can cut it off, and then it is unavailable.
 */
function earliestByChain(rows: readonly RequestRow[]): Map<string, number> {
  const earliest = new Map<string, number>();
  for (const row of rows) {
    if (!row.details?.agentId || !row.conversationId) continue;
    const key = chainKey(sourceOf(row), row.conversationId, row.details.agentId);
    const known = earliest.get(key);
    if (known === undefined || row.ts < known) earliest.set(key, row.ts);
  }
  return earliest;
}

export function subagentBreakdown(rows: readonly RequestRow[], options: {
  bucket: Bucket; from: number; to: number; tz: string;
  /** Every loaded row: tells a spawn's real first request from a clipped one. */
  datasetRows?: readonly RequestRow[];
  /** The selection without its agent filter: fan-out counts spawns per session, so Main only cannot empty it. */
  sessionRows?: readonly RequestRow[];
}) {
  const { bucket, from, to, tz } = options;
  const claude = rows.filter(row => sourceOf(row) === "claude-code");
  const codex = rows.filter(row => sourceOf(row) !== "claude-code");

  const split = zeroSplit();
  const bucketOf = bucketer(bucket, tz);
  const buckets = new Map<number, KindSplit>(bucketStarts(bucket, from, to, tz).map(ts => [ts, zeroSplit()]));
  const identity = createProjectIdentity();
  const byProject = new Map<string, { key: string; split: KindSplit }>();
  const byModel = new Map<string, { key: string; split: KindSplit }>();
  const byDepth = new Map<string, Tally>();
  const spawns = new Map<string, Spawn>();
  const group = (map: Map<string, { key: string; split: KindSplit }>, key: string) => {
    let entry = map.get(key);
    if (!entry) map.set(key, entry = { key, split: zeroSplit() });
    return entry.split;
  };

  for (const row of claude) {
    const kind = agentKind(row);
    add(split[kind], row);
    const slot = buckets.get(bucketOf(row.ts));
    if (slot) add(slot[kind], row);
    add(group(byProject, identity(row.cwd).project)[kind], row);
    add(group(byModel, row.model)[kind], row);
    if (kind !== "subagent") continue;
    const depth = row.details?.spawnDepth ?? null;
    const depthKey = depth === null ? "not recorded" : String(depth);
    let tally = byDepth.get(depthKey);
    if (!tally) byDepth.set(depthKey, tally = zero());
    add(tally, row);
    const agentId = row.details?.agentId;
    if (!agentId || !row.conversationId) continue;
    const key = chainKey("claude-code", row.conversationId, agentId);
    const spawn = spawns.get(key);
    if (!spawn) spawns.set(key, { agentId, agentType: row.details?.agentType ?? "unknown", depth, rows: [row], first: row });
    else {
      spawn.rows.push(row);
      if (row.ts < spawn.first.ts) spawn.first = row;
    }
  }

  const earliest = earliestByChain(options.datasetRows ?? rows);
  const available = [...spawns.entries()].filter(([key, spawn]) => (earliest.get(key) ?? spawn.first.ts) === spawn.first.ts).map(([, spawn]) => spawn);
  const startupCost = (spawn: Spawn) => (spawn.first.priced ? classCost(spawn.first).cacheWrite : null);
  const spawnCost = (spawn: Spawn) => spawn.rows.reduce((sum, row) => sum + (row.priced ? row.cost : 0), 0);
  const priced = available.filter(spawn => startupCost(spawn) !== null);

  const types = new Map<string, { type: string; requests: number; tokens: number; costUsd: number; startupCostUsd: number; spawns: Spawn[]; models: Map<string, number> }>();
  for (const spawn of spawns.values()) {
    let entry = types.get(spawn.agentType);
    if (!entry) types.set(spawn.agentType, entry = { type: spawn.agentType, requests: 0, tokens: 0, costUsd: 0, startupCostUsd: 0, spawns: [], models: new Map() });
    entry.spawns.push(spawn);
    entry.requests += spawn.rows.length;
    entry.costUsd += spawnCost(spawn);
    for (const row of spawn.rows) {
      entry.tokens += row.totalTokens;
      entry.models.set(row.model, (entry.models.get(row.model) ?? 0) + 1);
    }
  }
  for (const spawn of available) {
    const entry = types.get(spawn.agentType)!;
    entry.startupCostUsd += startupCost(spawn) ?? 0;
  }
  const subagentCost = split.subagent.costUsd;

  // Fan-out: a session counts only if a row of it is labelled, so "0" means a session with no recorded subagent.
  const perSession = new Map<string, { labelled: boolean; agents: Set<string> }>();
  let unlabelledSessions = 0;
  for (const row of (options.sessionRows ?? rows)) {
    if (sourceOf(row) !== "claude-code" || !row.conversationId) continue;
    const key = sessionKey("claude-code", row.conversationId);
    let session = perSession.get(key);
    if (!session) perSession.set(key, session = { labelled: false, agents: new Set() });
    if (row.details?.agent) session.labelled = true;
    if (row.details?.agentId) session.agents.add(row.details.agentId);
  }
  const counts: number[] = [];
  for (const session of perSession.values()) {
    if (session.labelled) counts.push(session.agents.size);
    else unlabelledSessions++;
  }

  const cost = (row: RequestRow) => (row.priced ? row.cost : 0);
  const codexRoot = zero();
  const codexSub = zero();
  const subThreads = new Set<string>();
  let codexTokens = 0;
  for (const row of codex) {
    codexTokens += row.totalTokens;
    if (row.codexSession?.parentThreadId) {
      add(codexSub, row);
      if (row.conversationId) subThreads.add(row.conversationId);
    } else add(codexRoot, row);
  }

  const shares = kindShares(split);
  const labelled = split.main.requests + split.subagent.requests;
  const scatterSpawns = priced.filter(spawn => spawnCost(spawn) > 0).sort((a, b) => b.first.ts - a.first.ts);
  return {
    claude: {
      requests: claude.length,
      labelledRequests: labelled,
      /** Null with no Claude rows; 0 means every Claude row lacks a marker, and no split is shown. */
      labelledShare: share(labelled, claude.length),
      shares,
      overTime: [...buckets].sort((a, b) => a[0] - b[0]).map(([ts, slot]) => {
        const total = KINDS.reduce((sum, kind) => sum + slot[kind].requests, 0);
        return { ts, label: bucketLabel(ts, bucket, tz), split: roundedSplit(slot), labelledShare: share(slot.main.requests + slot.subagent.requests, total) };
      }),
      fanOut: {
        sessions: counts.length, unlabelledSessions,
        withSubagents: counts.filter(value => value > 0).length,
        withSubagentsShare: share(counts.filter(value => value > 0).length, counts.length),
        median: percentile(counts, 0.5), p90: percentile(counts, 0.9), max: counts.length ? Math.max(...counts) : null,
        bins: FAN_OUT_BINS.map(bin => ({ label: bin.label, sessions: counts.filter(value => value >= bin.min && value <= bin.max).length })),
      },
      byType: [...types.values()].sort((a, b) => b.costUsd - a.costUsd || a.type.localeCompare(b.type)).map(entry => ({
        type: entry.type, spawns: entry.spawns.length, requests: entry.requests, tokens: entry.tokens, costUsd: round(entry.costUsd, 4),
        costShare: share(entry.costUsd, subagentCost), medianRequestsPerSpawn: percentile(entry.spawns.map(spawn => spawn.rows.length), 0.5),
        model: [...entry.models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null, startupCostUsd: round(entry.startupCostUsd, 4),
      })),
      byDepth: [...byDepth].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true })).map(([depth, tally]) => ({
        depth, ...rounded(tally), requestShare: share(tally.requests, split.subagent.requests), costShare: share(tally.costUsd, subagentCost),
      })),
      startup: {
        spawns: spawns.size,
        /** Spawns whose first request is outside the selection, so their start-up figure cannot be read. */
        unavailableSpawns: spawns.size - available.length,
        unpricedSpawns: available.length - priced.length,
        cacheWriteTokens: available.reduce((sum, spawn) => sum + spawn.first.cacheWriteTokens, 0),
        costUsd: round(priced.reduce((sum, spawn) => sum + startupCost(spawn)!, 0), 4),
        medianCostUsd: percentile(priced.map(spawn => startupCost(spawn)!), 0.5),
        shortSpawnShare: share(available.filter(spawn => spawn.rows.length <= SHORT_SPAWN_REQUESTS).length, available.length),
        points: scatterSpawns.slice(0, SCATTER_CAP).map(spawn => ({ requests: spawn.rows.length, costShare: round(startupCost(spawn)! / spawnCost(spawn), 4) })),
        pointsOmitted: Math.max(0, scatterSpawns.length - SCATTER_CAP),
      },
      byProject: topRows(byProject).map(entry => ({ ...entry, unattributed: entry.key === UNATTRIBUTED })),
      byModel: topRows(byModel),
    },
    codex: {
      requests: codex.length, tokens: codexTokens, costUsd: round(codex.reduce((sum, row) => sum + cost(row), 0), 4),
      rootThread: rounded(codexRoot),
      subagentThread: { ...rounded(codexSub), threads: subThreads.size },
    },
  };
}
