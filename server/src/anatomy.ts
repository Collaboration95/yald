// Session anatomy (#114): the shape of one session as chains. Structure and list-price cost only,
// no claim that a subagent was worth it. Chains and their request ticks are aggregated here, so a
// large session never ships every row to the chart. Unavailable is null, and an unmarked request
// forms its own `unlabelled` chain, never main.
import { agentKind, classCost, round, type AgentKind } from "./analytics";
import type { ClaudeEvent } from "./claude/transcripts";
import { orderedRequests } from "./labs/scope";
import type { RequestRow } from "./ocx/store";
import { contextEligible } from "./report/source";
import type { Source } from "./report/types";

/** Largest number of request ticks and context points sent per chain; the main chain keeps more. */
export const ANATOMY_POINTS = { ticks: 300, mainContext: 800, chainContext: 200 } as const;

const UNLABELLED_KEY = "unlabelled";
const chainIdOf = (row: RequestRow): string => (row.details?.agent ? row.details.agentId ?? "main" : UNLABELLED_KEY);
const share = (part: number, whole: number): number | null => (whole > 0 ? round(part / whole, 4) : null);

/** Evenly spaced items, first and last always kept. */
export function thin<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  return Array.from({ length: limit }, (_, index) => items[Math.round((index * (items.length - 1)) / (limit - 1))]!);
}

export interface AnatomyChain {
  key: string;
  kind: AgentKind;
  agentId: string | null;
  agentType: string | null;
  model: string | null;
  depth: number | null;
  /** The chain that spawned this one, where a recorded tool_use names it; null otherwise. */
  parent: string | null;
  spawn: { ts: number; requestId: string } | null;
  firstAt: number;
  lastAt: number;
  requests: number;
  tokens: number;
  /** Priced subtotal: a lower bound while `unpricedRequests` is above zero. */
  costUsd: number;
  unpricedRequests: number;
  /** Null when this is not a subagent, or its first request is outside the selection. */
  startupCostUsd: number | null;
  firstRequestMissing: boolean;
  ticks: number[];
  context: { ts: number; tokens: number }[];
  contextEligible: number;
}

export function sessionAnatomy(scoped: readonly RequestRow[], options: { source: Source; id: string; all: readonly RequestRow[]; events?: readonly ClaudeEvent[] }) {
  const { source, id, all } = options;
  const ordered = orderedRequests(scoped as RequestRow[]);
  const labelled = ordered.filter(row => row.details?.agent).length;
  const groups = new Map<string, RequestRow[]>();
  for (const row of ordered) {
    const key = chainIdOf(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  // Every loaded request of the session, so a spawn point outside the selection still links.
  const earliest = new Map<string, number>();
  const toolOwner = new Map<string, RequestRow>();
  for (const row of all) {
    const key = chainIdOf(row);
    if (row.ts < (earliest.get(key) ?? Number.POSITIVE_INFINITY)) earliest.set(key, row.ts);
    for (const toolId of row.details?.toolUseIds ?? []) toolOwner.set(toolId, row);
  }

  const chains: AnatomyChain[] = [...groups].map(([key, rows]) => {
    const first = rows[0]!;
    const kind = agentKind(first);
    const details = first.details;
    const owner = details?.spawnToolUseId ? toolOwner.get(details.spawnToolUseId) : undefined;
    const parent = owner ? chainIdOf(owner) : null;
    const firstRequestMissing = (earliest.get(key) ?? first.ts) < first.ts;
    const eligible = rows.filter(contextEligible);
    const priced = rows.filter(row => row.priced);
    const models = new Map<string, number>();
    for (const row of rows) models.set(row.model, (models.get(row.model) ?? 0) + 1);
    return {
      key, kind, agentId: details?.agentId ?? null, agentType: details?.agentType ?? null,
      model: [...models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null,
      depth: details?.spawnDepth ?? null, parent: parent !== key ? parent : null,
      spawn: owner ? { ts: owner.ts, requestId: owner.id } : null,
      firstAt: first.ts, lastAt: rows[rows.length - 1]!.ts,
      requests: rows.length, tokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
      costUsd: round(priced.reduce((sum, row) => sum + row.cost, 0), 4), unpricedRequests: rows.length - priced.length,
      startupCostUsd: kind === "subagent" && !firstRequestMissing && first.priced ? round(classCost(first).cacheWrite, 4) : null,
      firstRequestMissing,
      ticks: thin(rows, ANATOMY_POINTS.ticks).map(row => row.ts),
      context: thin(eligible, key === "main" || key === UNLABELLED_KEY ? ANATOMY_POINTS.mainContext : ANATOMY_POINTS.chainContext).map(row => ({ ts: row.ts, tokens: row.inputTokens })),
      contextEligible: eligible.length,
    };
  }).sort((a, b) => Number(b.key === "main") - Number(a.key === "main") || Number(a.key === UNLABELLED_KEY) - Number(b.key === UNLABELLED_KEY) || a.firstAt - b.firstAt);

  const total = { requests: ordered.length, tokens: chains.reduce((sum, chain) => sum + chain.tokens, 0), cost: chains.reduce((sum, chain) => sum + chain.costUsd, 0) };
  const subagents = chains.filter(chain => chain.kind === "subagent");
  const sum = (field: "requests" | "tokens" | "costUsd") => subagents.reduce((value, chain) => value + chain[field], 0);
  const events = (options.events ?? []).filter(event => event.kind === "compact" && event.sessionId === id) as Extract<ClaudeEvent, { kind: "compact" }>[];
  const startups = subagents.filter(chain => chain.startupCostUsd !== null);
  const depths = subagents.map(chain => chain.depth).filter((depth): depth is number => depth !== null);
  const eligible = chains.reduce((value, chain) => value + chain.contextEligible, 0);
  const priced = ordered.filter(row => row.priced).length;
  const splittable = source === "claude-code" && labelled > 0;
  return {
    /** False: one chain only, and `note` says why no split is drawn. */
    split: splittable,
    note: source !== "claude-code"
      ? "Codex subagent traffic often reuses the parent thread's id, so this thread cannot be split into chains."
      : labelled === 0 ? "Not labelled: these requests carry no agent markers, so they read as one chain." : null,
    chains,
    compactions: source === "claude-code" ? events.filter(event => event.ts >= (ordered[0]?.ts ?? 0) - 1 && event.ts <= (ordered[ordered.length - 1]?.ts ?? 0) + 1).sort((a, b) => a.ts - b.ts)
      .map(event => ({ ts: event.ts, chain: event.agentId ?? "main", trigger: event.trigger, preTokens: event.preTokens, postTokens: event.postTokens, durationMs: event.durationMs })) : [],
    stats: {
      chains: chains.length,
      subagents: subagents.length,
      maxDepth: depths.length ? Math.max(...depths) : null,
      subagentShare: splittable ? { requests: share(sum("requests"), total.requests), tokens: share(sum("tokens"), total.tokens), cost: share(sum("costUsd"), total.cost) } : null,
      startupCostUsd: startups.length ? round(startups.reduce((value, chain) => value + chain.startupCostUsd!, 0), 4) : null,
      startupsUnavailable: subagents.length - startups.length,
      coverage: { labelled: share(labelled, ordered.length), priced: share(priced, ordered.length), context: share(eligible, ordered.length) },
    },
  };
}

