import { describe, expect, test } from "bun:test";
import { filterRows, groupKey } from "./analytics";
import { chainKey } from "./labs/scope";
import type { RequestRow } from "./ocx/store";
import { subagentBreakdown } from "./subagents";

const from = Date.UTC(2026, 9, 1);
const to = Date.UTC(2026, 9, 3);
const day = 86_400_000;
let next = 0;
const row = (session: string, agent: "main" | "subagent" | null, overrides: Partial<RequestRow> & { agentId?: string; agentType?: string; depth?: number } = {}): RequestRow => {
  const { agentId, agentType, depth, ...rest } = overrides;
  return {
    id: `r${next++}`, ts: from + next * 1000, conversationId: session, protocol: "claude-code", provider: "anthropic", model: "m", totalTokens: 100, inputTokens: 90, outputTokens: 10,
    cost: 1, priced: true, cacheWriteTokens: 0, cacheReadTokens: 0, cwd: null, rateCacheWrite: 10, costParts: { input: 0.5, output: 0.25, cacheRead: 0, cacheWrite: 0.25 },
    details: agent === null ? null : { agent, agentId: agentId ?? null, agentType: agentType ?? null, spawnDepth: depth ?? null },
    ...rest,
  } as RequestRow;
};
const breakdown = (rows: RequestRow[], extra: Partial<Parameters<typeof subagentBreakdown>[1]> = {}) => subagentBreakdown(rows, { bucket: "day", from, to, tz: "UTC", datasetRows: rows, ...extra });

describe("shares", () => {
  test("a request counts once, and unlabelled is its own slice, never main", () => {
    const { claude } = breakdown([row("a", "main"), row("a", "main"), row("a", "subagent", { agentId: "x" }), row("old", null)]);
    expect(claude.shares.map(entry => [entry.kind, entry.requests, entry.requestShare])).toEqual([["main", 2, 0.5], ["subagent", 1, 0.25], ["unlabelled", 1, 0.25]]);
    expect(claude).toMatchObject({ requests: 4, labelledRequests: 3, labelledShare: 0.75 });
  });

  test("with no markers there is no split to read: labelled is 0, and nothing is called main", () => {
    const { claude } = breakdown([row("old", null), row("old", null)]);
    expect(claude.labelledShare).toBe(0);
    expect(claude.shares.find(entry => entry.kind === "main")).toMatchObject({ requests: 0, requestShare: 0 });
    expect(claude.shares.find(entry => entry.kind === "unlabelled")).toMatchObject({ requests: 2, requestShare: 1 });
    expect(claude.fanOut).toMatchObject({ sessions: 0, unlabelledSessions: 1, median: null, withSubagentsShare: null });
  });

  test("an unpriced row is left out of cost, with its coverage, not counted as zero dollars", () => {
    const { claude } = breakdown([row("a", "subagent", { agentId: "x" }), row("a", "subagent", { agentId: "x", priced: false, cost: 0 })]);
    expect(claude.shares.find(entry => entry.kind === "subagent")).toMatchObject({ requests: 2, pricedRequests: 1, pricedShare: 0.5, costUsd: 1 });
  });
});

test("fan-out counts distinct agents per labelled session and survives a main-only selection", () => {
  const rows = [row("none", "main"), row("one", "main"), row("one", "subagent", { agentId: "x" }), row("one", "subagent", { agentId: "x" }),
    ...["a", "b", "c"].map(agentId => row("three", "subagent", { agentId }))];
  const all = breakdown(rows).claude.fanOut;
  expect(all.bins.filter(bin => bin.sessions).map(bin => [bin.label, bin.sessions])).toEqual([["0", 1], ["1", 1], ["2-3", 1]]);
  expect(all).toMatchObject({ sessions: 3, withSubagents: 2, median: 1, max: 3 });
  const main = rows.filter(entry => entry.details?.agent === "main");
  expect(breakdown(main, { sessionRows: rows, datasetRows: rows }).claude.fanOut).toMatchObject({ sessions: 3, withSubagents: 2 });
});

describe("agent type, depth and first requests", () => {
  const start = (id: string, ts: number, overrides: Partial<RequestRow> = {}) => row("s", "subagent", { agentId: id, agentType: "Explore", depth: 1, ts, ...overrides });

  test("the first request's cache write comes from the engine's split, and the short spawn share counts", () => {
    const rows = [start("a", from + 2_000), start("a", from + 1_000, { cacheWriteTokens: 5_000, costParts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.75 }, cost: 0.75 }), start("a", from + 3_000), start("b", from + 4_000)];
    const { startup, byType, byDepth } = breakdown(rows).claude;
    expect(startup).toMatchObject({ spawns: 2, unavailableSpawns: 0, cacheWriteTokens: 5_000, costUsd: 1, shortSpawnShare: 0.5 });
    expect(startup.points).toContainEqual({ requests: 3, costShare: 0.2727 });
    expect(byType[0]).toMatchObject({ type: "Explore", spawns: 2, requests: 4, medianRequestsPerSpawn: 2, startupCostUsd: 1 });
    expect(byDepth).toEqual([expect.objectContaining({ depth: "1", requests: 4, requestShare: 1 })]);
  });

  test("a spawn whose first request is outside the selection is unavailable, not a zero", () => {
    const earlier = start("a", from - day);
    const kept = start("a", from + 1_000);
    expect(breakdown([kept], { datasetRows: [earlier, kept] }).claude.startup).toMatchObject({ spawns: 1, unavailableSpawns: 1, costUsd: 0, medianCostUsd: null, points: [] });
  });

  test("an unpriced first request is unpriced, not a free start", () => {
    expect(breakdown([start("a", from + 1, { priced: false, cost: 0 })]).claude.startup).toMatchObject({ unpricedSpawns: 1, costUsd: 0, medianCostUsd: null });
  });

  test("a depth that was not recorded is not derived", () => {
    expect(breakdown([row("s", "subagent", { agentId: "a" })]).claude.byDepth[0]).toMatchObject({ depth: "not recorded" });
  });

  test("scatter points are capped and the rest counted", () => {
    const rows = Array.from({ length: 2_005 }, (_, index) => start(`a${index}`, from + index));
    const { startup } = breakdown(rows).claude;
    expect(startup.points).toHaveLength(2_000);
    expect(startup.pointsOmitted).toBe(5);
  });
});

test("project and model tables keep the top rows and roll the rest into Other", () => {
  const rows = Array.from({ length: 12 }, (_, index) => row("s", "main", { model: `m${index}`, cost: index + 1 }));
  const { byModel } = breakdown(rows).claude;
  expect(byModel).toHaveLength(11);
  expect(byModel[0]).toMatchObject({ key: "m11" });
  expect(byModel.at(-1)).toMatchObject({ key: "Other", split: { main: { requests: 2 } } });
});

test("over time buckets each kind and reports coverage per bucket", () => {
  const { overTime } = breakdown([row("a", "main", { ts: from + 1 }), row("old", null, { ts: from + 2 }), row("a", "subagent", { agentId: "x", ts: from + day + 1 })]).claude;
  expect(overTime.map(point => point.labelledShare)).toEqual([0.5, 1]);
  expect(overTime[0]!.split).toMatchObject({ main: { requests: 1 }, unlabelled: { requests: 1 } });
});

describe("Codex", () => {
  const codex = (id: string, parent: string | null) => row(id, null, { protocol: "responses", provider: "openai", codexSession: { gitBranch: null, commitHash: null, parentThreadId: parent, depth: parent ? 1 : null, agentRole: null } });

  test("is never main: root threads may hold subagents, and only a named parent marks a subagent thread", () => {
    const { claude, codex: result } = breakdown([codex("root", null), codex("root", null), codex("child", "root")]);
    expect(claude.requests).toBe(0);
    expect(result).toMatchObject({ requests: 3, rootThread: { requests: 2 }, subagentThread: { requests: 1, threads: 1 } });
    expect(JSON.stringify(result)).not.toContain('"main"');
  });

  test("a named parent reads as subagent in the filter and the group; a root thread stays unlabelled", () => {
    const rows = [codex("root", null), codex("child", "root")];
    expect(groupKey(rows[0]!, "agent")).toBe("unlabelled");
    expect(groupKey(rows[1]!, "agent")).toBe("subagent");
    expect(filterRows(rows, { agents: ["main"] })).toHaveLength(0);
    expect(filterRows(rows, { agents: ["subagent"] })).toHaveLength(1);
  });
});

test("a chain key separates agents and keeps the source", () => {
  expect(chainKey("claude-code", "s", null)).toBe(chainKey("claude-code", "s", "main"));
  expect(chainKey("claude-code", "s", "a")).not.toBe(chainKey("ocx", "s", "a"));
});
