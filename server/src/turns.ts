// Agent turns and tools (#104): how agent work is shaped, from stop reasons, tool-use counts and
// human prompts. Claude Code only: opencodex close reasons have a different vocabulary. Names and
// counts, never tool input or output. Nothing here is a productivity measure: a deep turn is not
// good or bad, and no band is labelled ideal. A tool count is a requested call, not a successful one.
import { agentKind, bucketer, bucketLabel, bucketStarts, percentile, round, topN, type Bucket } from "./analytics";
import type { ClaudeEvent } from "./claude/transcripts";
import { orderedRequests, requestsBefore } from "./labs/scope";
import type { RequestRow } from "./ocx/store";
import { createProjectIdentity } from "./projects";
import { sourceOf } from "./report/source";

export const DEPTH_BINS = [
  { label: "1", min: 1, max: 1 }, { label: "2-4", min: 2, max: 4 }, { label: "5-9", min: 5, max: 9 },
  { label: "10-19", min: 10, max: 19 }, { label: "20+", min: 20, max: Number.POSITIVE_INFINITY },
] as const;

/** The one mapping from tool name to group; published in docs/metrics.md. Anything else is Other. */
export const TOOL_GROUPS: Record<string, readonly string[]> = {
  Bash: ["bash", "bashoutput", "killshell", "monitor"],
  Read: ["read", "notebookread"],
  "Edit/Write": ["edit", "write", "multiedit", "notebookedit"],
  Search: ["grep", "glob", "websearch", "webfetch", "toolsearch"],
  Agent: ["agent", "task", "sendmessage", "subagenthandback", "taskstop", "skill"],
};
export const TOOL_GROUP_NAMES = [...Object.keys(TOOL_GROUPS), "MCP", "Other"];
const GROUP_OF = new Map(Object.entries(TOOL_GROUPS).flatMap(([group, names]) => names.map(name => [name, group] as const)));

export function toolGroup(tool: string): string {
  return tool.startsWith("mcp__") ? "MCP" : GROUP_OF.get(tool.toLowerCase()) ?? "Other";
}

export const TOP_TOOL_ROWS = 10;
export const TOP_TOOLS = 15;
const NOT_RECORDED = "not recorded";

const hasTools = (row: RequestRow) => Object.keys(row.details?.toolCounts ?? {}).length > 0;
const share = (part: number, whole: number): number | null => (whole > 0 ? round(part / whole, 4) : null);
/** A step keeps its turn going if it asked for a tool. A missing stop reason with a tool call still did. */
const continues = (row: RequestRow) => row.closeReason === "tool_use" || (!row.closeReason && hasTools(row));

interface Turn { steps: RequestRow[]; end: string }

function buildChains(rows: RequestRow[]) {
  const chains = new Map<string, RequestRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.conversationId, row.details?.agentId ?? "main"]);
    const chain = chains.get(key);
    if (chain) chain.push(row);
    else chains.set(key, [row]);
  }
  return chains;
}

/** Runs of steps in one chain. A human prompt between two main-chain steps also ends a run: the turn was interrupted. */
function chainTurns(chain: RequestRow[], prompts: readonly number[] | undefined): Turn[] {
  const turns: Turn[] = [];
  let steps: RequestRow[] = [];
  const close = () => {
    if (!steps.length) return;
    const last = steps[steps.length - 1]!;
    turns.push({ steps, end: last.closeReason ?? NOT_RECORDED });
    steps = [];
  };
  chain.forEach((row, index) => {
    steps.push(row);
    const next = chain[index + 1];
    const interrupted = prompts !== undefined && next !== undefined && requestsBefore(prompts, next.ts) > requestsBefore(prompts, row.ts);
    if (!continues(row) || interrupted) close();
  });
  close();
  return turns;
}

interface Counted { requests: number; groups: Record<string, number>; steps: number }

function toolTable(entries: Map<string, Counted>, limit = TOP_TOOL_ROWS) {
  const sorted = topN(entries, Number.MAX_SAFE_INTEGER, (a, b) => b[1].requests - a[1].requests || a[0].localeCompare(b[0]));
  const row = ([key, value]: [string, Counted]) => ({ key, requests: value.requests, calls: Object.values(value.groups).reduce((sum, count) => sum + count, 0), groups: value.groups });
  const kept = sorted.slice(0, limit).map(row);
  const rest = sorted.slice(limit);
  if (!rest.length) return kept;
  const other: Counted = { requests: 0, steps: 0, groups: {} };
  for (const [, value] of rest) {
    other.requests += value.requests;
    for (const [group, count] of Object.entries(value.groups)) other.groups[group] = (other.groups[group] ?? 0) + count;
  }
  return [...kept, row(["Other", other])];
}

export function turnStructure(selection: readonly RequestRow[], options: { bucket: Bucket; from: number; to: number; tz: string; events?: readonly ClaudeEvent[]; datasetRows?: readonly RequestRow[] }) {
  const { bucket, from, to, tz } = options;
  const rows = orderedRequests(selection.filter(row => sourceOf(row) === "claude-code" && row.conversationId) as RequestRow[]);
  const excluded = selection.length - rows.length;
  const chains = buildChains(rows);
  const structured = rows.filter(row => row.details).length;
  const stopped = rows.filter(row => row.closeReason).length;

  // Human prompts by session, inside the window, for autonomy and to end interrupted turns.
  const prompts = new Map<string, number[]>();
  for (const event of options.events ?? []) {
    if (event.kind !== "prompt" || event.ts < from || event.ts >= to) continue;
    const list = prompts.get(event.sessionId);
    if (list) list.push(event.ts);
    else prompts.set(event.sessionId, [event.ts]);
  }
  for (const list of prompts.values()) list.sort((a, b) => a - b);

  const turns: Turn[] = [];
  for (const chain of chains.values()) {
    const first = chain[0]!;
    turns.push(...chainTurns(chain, agentKind(first) === "main" ? prompts.get(first.conversationId!) : undefined));
  }

  // A turn cut by the window: the chain's previous loaded step outside the selection was still asking for tools.
  const earlier = new Map<string, RequestRow>();
  for (const row of options.datasetRows ?? []) {
    if (sourceOf(row) !== "claude-code" || !row.conversationId || row.ts >= from) continue;
    const key = JSON.stringify([row.conversationId, row.details?.agentId ?? "main"]);
    const known = earlier.get(key);
    if (!known || row.ts > known.ts) earlier.set(key, row);
  }
  let clippedTurns = 0;
  for (const [key, chain] of chains) {
    const before = earlier.get(key);
    if (before && continues(before) && chain[0]!.ts >= from) clippedTurns++;
  }

  const bins = DEPTH_BINS.map(bin => ({ label: bin.label, turns: 0, costUsd: 0, steps: 0 }));
  const ends = new Map<string, number>();
  const depths: number[] = [];
  let pricedSteps = 0;
  let pricedCost = 0;
  for (const turn of turns) {
    const depth = turn.steps.length;
    depths.push(depth);
    const bin = bins[DEPTH_BINS.findIndex(entry => depth >= entry.min && depth <= entry.max)]!;
    bin.turns++;
    bin.steps += depth;
    ends.set(turn.end, (ends.get(turn.end) ?? 0) + 1);
    for (const step of turn.steps) {
      if (!step.priced) continue;
      bin.costUsd += step.cost;
      pricedSteps++;
      pricedCost += step.cost;
    }
  }

  // Autonomy: main-chain steps over human prompts, overall, per session and per week.
  const mainSteps = rows.filter(row => agentKind(row) === "main");
  const stepsBySession = new Map<string, number>();
  const weekly = new Map<number, { sessions: Map<string, { steps: number; prompts: number }> }>();
  const weekOf = bucketer("week", tz);
  const weekSlot = (ts: number, session: string) => {
    const key = weekOf(ts);
    let week = weekly.get(key);
    if (!week) weekly.set(key, week = { sessions: new Map() });
    let slot = week.sessions.get(session);
    if (!slot) week.sessions.set(session, slot = { steps: 0, prompts: 0 });
    return slot;
  };
  for (const row of mainSteps) {
    stepsBySession.set(row.conversationId!, (stepsBySession.get(row.conversationId!) ?? 0) + 1);
    weekSlot(row.ts, row.conversationId!).steps++;
  }
  let humanPrompts = 0;
  const ratios: number[] = [];
  for (const [session, steps] of stepsBySession) {
    const list = prompts.get(session);
    if (!list?.length) continue;
    humanPrompts += list.length;
    ratios.push(steps / list.length);
    for (const ts of list) weekSlot(ts, session).prompts++;
  }
  const weeks = [...weekly].sort((a, b) => a[0] - b[0]).map(([ts, week]) => {
    const values = [...week.sessions.values()].filter(slot => slot.prompts > 0).map(slot => slot.steps / slot.prompts);
    return { ts, label: bucketLabel(ts, "week", tz), sessions: values.length, median: percentile(values, 0.5), p90: percentile(values, 0.9) };
  });

  // Tools and stop reasons per bucket; counts of requested calls, grouped by one mapping.
  const buckets = new Map(bucketStarts(bucket, from, to, tz).map(ts => [ts, { groups: {} as Record<string, number>, stops: {} as Record<string, number>, steps: 0 }]));
  const bucketOf = bucketer(bucket, tz);
  const identity = createProjectIdentity();
  const byProject = new Map<string, Counted>();
  const byModel = new Map<string, Counted>();
  const toolTotals = new Map<string, { group: string; calls: number; steps: number }>();
  const groupTotals = new Map<string, number>();
  const stops = new Map<string, number>();
  const counted = (map: Map<string, Counted>, key: string) => {
    let entry = map.get(key);
    if (!entry) map.set(key, entry = { requests: 0, groups: {}, steps: 0 });
    return entry;
  };
  let stepsWithTools = 0;
  for (const row of rows) {
    const slot = buckets.get(bucketOf(row.ts));
    const stop = row.closeReason ?? NOT_RECORDED;
    stops.set(stop, (stops.get(stop) ?? 0) + 1);
    if (slot) {
      slot.steps++;
      slot.stops[stop] = (slot.stops[stop] ?? 0) + 1;
    }
    const project = counted(byProject, identity(row.cwd).project);
    const model = counted(byModel, row.model);
    project.requests++;
    model.requests++;
    const tools = Object.entries(row.details?.toolCounts ?? {});
    if (tools.length) stepsWithTools++;
    for (const [tool, count] of tools) {
      const group = toolGroup(tool);
      groupTotals.set(group, (groupTotals.get(group) ?? 0) + count);
      for (const target of [slot?.groups, project.groups, model.groups]) if (target) target[group] = (target[group] ?? 0) + count;
      const total = toolTotals.get(tool);
      if (total) {
        total.calls += count;
        total.steps++;
      } else toolTotals.set(tool, { group, calls: count, steps: 1 });
    }
  }

  const toolData = structured > 0;
  const depth20 = bins.at(-1)!;
  const shareOf = (values: Map<string, number>) => [...values].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
  return {
    /** True when no row carries #96 details: turns are approximate, and autonomy and tools unavailable. */
    approximate: rows.length > 0 && !toolData,
    coverage: {
      steps: rows.length, excludedRequests: excluded, stepsWithStopReason: stopped, stopReasonShare: share(stopped, rows.length),
      stepsWithStructure: structured, structureShare: share(structured, rows.length), pricedSteps, pricedShare: share(pricedSteps, rows.length), clippedTurns,
    },
    turns: {
      total: turns.length, medianDepth: percentile(depths, 0.5), p90Depth: percentile(depths, 0.9),
      bins: bins.map(bin => ({ label: bin.label, turns: bin.turns, steps: bin.steps, turnShare: share(bin.turns, turns.length), costUsd: round(bin.costUsd, 4), costShare: share(bin.costUsd, pricedCost) })),
      deep: { turnShare: share(depth20.turns, turns.length), costShare: share(depth20.costUsd, pricedCost) },
      ends: shareOf(ends),
    },
    autonomy: humanPrompts ? {
      mainSteps: mainSteps.length, humanPrompts, overall: round(mainSteps.length / humanPrompts, 2), sessions: ratios.length,
      median: percentile(ratios, 0.5), p90: percentile(ratios, 0.9), weeks,
    } : null,
    tools: toolData ? {
      groups: shareOf(groupTotals), stepsWithTools, stepsWithToolsShare: share(stepsWithTools, rows.length),
      top: topN(toolTotals, TOP_TOOLS, (a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0])).map(([name, total]) => ({ name, ...total, stepShare: share(total.steps, rows.length) })),
      byProject: toolTable(byProject), byModel: toolTable(byModel),
    } : null,
    overTime: [...buckets].sort((a, b) => a[0] - b[0]).map(([ts, slot]) => ({ ts, label: bucketLabel(ts, bucket, tz), steps: slot.steps, groups: slot.groups, stops: slot.stops })),
    stops: shareOf(stops),
  };
}
