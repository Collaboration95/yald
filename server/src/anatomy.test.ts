import { describe, expect, test } from "bun:test";
import { ANATOMY_POINTS, sessionAnatomy, thin } from "./anatomy";
import type { ClaudeEvent } from "./claude/transcripts";
import type { RequestRow } from "./ocx/store";

const measured = { usage: "logical", input: true, output: true, cacheRead: true, cacheWrite: true, outcome: false, duration: false, ttft: false, retries: false };
let next = 0;
type Extra = Partial<RequestRow> & { agent?: "main" | "subagent" | null; agentId?: string; agentType?: string; depth?: number; spawn?: string; tools?: string[] };
const row = ({ agent = "main", agentId, agentType, depth, spawn, tools, ...rest }: Extra = {}): RequestRow => ({
  id: `r${next}`, ts: 1_000 + 10 * next++, conversationId: "s", protocol: "claude-code", provider: "anthropic", model: "m", totalTokens: 100, inputTokens: 90, outputTokens: 10, cost: 2, priced: true,
  cacheWriteTokens: 0, cacheReadTokens: 0, usageFromAttempts: false, measurements: measured, costParts: { input: 1, output: 0.5, cacheRead: 0, cacheWrite: 0.5 },
  details: agent === null ? null : { agent, agentId: agentId ?? null, agentType: agentType ?? null, spawnDepth: depth ?? null, spawnToolUseId: spawn ?? null, toolUseIds: tools ?? [] },
  ...rest,
} as unknown as RequestRow);
const anatomy = (rows: RequestRow[], extra: { all?: RequestRow[]; events?: ClaudeEvent[]; source?: "claude-code" | "ocx" } = {}) =>
  sessionAnatomy(rows, { source: extra.source ?? "claude-code", id: "s", all: extra.all ?? rows, events: extra.events });
const sub = (id: string, spawn: string, depth = 1, extra: Extra = {}) => row({ agent: "subagent", agentId: id, agentType: "Explore", depth, spawn, ...extra });

describe("chains", () => {
  test("nested subagents link through recorded tool ids, and totals reconcile with the session", () => {
    const rows = [row({ tools: ["t1"] }), sub("a", "t1", 1, { tools: ["t2"] }), sub("a", "t1"), sub("b", "t2", 2), row()];
    const result = anatomy(rows);
    expect(result.chains.map(chain => [chain.key, chain.parent, chain.requests])).toEqual([["main", null, 2], ["a", "main", 2], ["b", "a", 1]]);
    expect(result.chains[1]!.spawn).toEqual({ ts: rows[0]!.ts, requestId: rows[0]!.id });
    expect(result.chains.reduce((sum, chain) => sum + chain.requests, 0)).toBe(rows.length);
    expect(result.chains.reduce((sum, chain) => sum + chain.costUsd, 0)).toBe(10);
    expect(result.stats).toMatchObject({ chains: 3, subagents: 2, maxDepth: 2, startupCostUsd: 1, subagentShare: { requests: 0.6, cost: 0.6 } });
  });

  test("a spawn link appears only where the tool id is recorded", () => {
    const [chain] = anatomy([sub("a", "t-nowhere")]).chains;
    expect(chain).toMatchObject({ parent: null, spawn: null });
    expect(anatomy([row({ agent: "subagent", agentId: "b" })]).chains[0]).toMatchObject({ parent: null, spawn: null });
  });

  test("a spawn outside the selection still links through every loaded request", () => {
    const owner = row({ tools: ["t1"] });
    expect(anatomy([sub("a", "t1")], { all: [owner, sub("a", "t1")] }).chains[0]).toMatchObject({ parent: "main", spawn: { requestId: owner.id } });
  });

  test("a missing first request leaves the start-up figure unavailable, not zero", () => {
    const earlier = sub("a", "t");
    const kept = sub("a", "t");
    const result = anatomy([kept], { all: [earlier, kept] });
    expect(result.chains[0]).toMatchObject({ firstRequestMissing: true, startupCostUsd: null });
    expect(result.stats).toMatchObject({ startupCostUsd: null, startupsUnavailable: 1 });
  });

  test("unpriced rows are left out of a chain's subtotal and counted", () => {
    const result = anatomy([row(), row({ priced: false, cost: 0 })]);
    expect(result.chains[0]).toMatchObject({ costUsd: 2, unpricedRequests: 1 });
    expect(result.stats.coverage).toMatchObject({ labelled: 1, priced: 0.5 });
  });

  test("an unmarked request in a labelled session is its own chain, never main", () => {
    const result = anatomy([row(), row({ agent: null })]);
    expect(result.chains.map(chain => [chain.key, chain.kind])).toEqual([["main", "main"], ["unlabelled", "unlabelled"]]);
    expect(result.stats.coverage.labelled).toBe(0.5);
  });
});

describe("sessions that cannot be split", () => {
  test("an unlabelled Claude session is one chain with a note", () => {
    const result = anatomy([row({ agent: null }), row({ agent: null })]);
    expect(result).toMatchObject({ split: false, chains: [{ key: "unlabelled", requests: 2 }], stats: { subagentShare: null, startupCostUsd: null, coverage: { labelled: 0 } } });
    expect(result.note).toContain("Not labelled");
  });

  test("a Codex session says the split is not available", () => {
    const result = anatomy([row({ agent: null, protocol: "responses" })], { source: "ocx" });
    expect(result.split).toBe(false);
    expect(result.note).toContain("cannot be split");
  });
});

test("compactions keep their chain and their recorded counts, and stay null when missing", () => {
  const rows = [row(), row(), row()];
  const event = (ts: number, agentId: string | null, trigger: string | null): ClaudeEvent => ({ key: `c${ts}`, sessionId: "s", ts, kind: "compact", agentId, trigger, preTokens: trigger ? 900 : null, postTokens: trigger ? 100 : null, durationMs: null });
  const events = [event(rows[1]!.ts + 1, null, "auto"), event(rows[2]!.ts - 1, "a", null), { ...event(rows[1]!.ts, null, "manual"), sessionId: "other" }];
  expect(anatomy(rows, { events }).compactions).toEqual([
    { ts: rows[1]!.ts + 1, chain: "main", trigger: "auto", preTokens: 900, postTokens: 100, durationMs: null },
    { ts: rows[2]!.ts - 1, chain: "a", trigger: null, preTokens: null, postTokens: null, durationMs: null },
  ]);
});

test("large sessions send capped ticks and context points, first and last kept", () => {
  const rows = Array.from({ length: 2_000 }, () => row());
  const [chain] = anatomy(rows).chains;
  expect(chain!.ticks).toHaveLength(ANATOMY_POINTS.ticks);
  expect(chain!.context).toHaveLength(ANATOMY_POINTS.mainContext);
  expect(chain!.requests).toBe(2_000);
  expect(chain!.ticks[0]).toBe(rows[0]!.ts);
  expect(chain!.ticks.at(-1)).toBe(rows.at(-1)!.ts);
  expect(thin([1, 2, 3], 5)).toEqual([1, 2, 3]);
});

test("no request text reaches the response", () => {
  const text = "secret-prompt-text";
  const result = JSON.stringify(anatomy([{ ...row(), errorCode: text } as RequestRow]));
  expect(result).not.toContain(text);
});
