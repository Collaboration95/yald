import { describe, expect, test } from "bun:test";
import type { ClaudeEvent } from "./claude/transcripts";
import type { RequestRow } from "./ocx/store";
import { TOOL_GROUP_NAMES, toolGroup, turnStructure } from "./turns";

const from = Date.UTC(2026, 9, 5);
const to = Date.UTC(2026, 9, 7);
let clock = 0;
const SECRET = "tool-input-secret";
const row = (stop: string | null, overrides: Partial<RequestRow> & { agent?: "main" | "subagent" | null; agentId?: string; tools?: Record<string, number> } = {}): RequestRow => {
  const { agent = "main", agentId, tools, ...rest } = overrides;
  return {
    id: `r${clock}`, ts: from + 1_000 * ++clock, conversationId: "s", protocol: "claude-code", provider: "anthropic", model: "m", cost: 1, priced: true, totalTokens: 10, cwd: null, closeReason: stop,
    details: agent === null ? null : { agent, agentId: agentId ?? null, toolCounts: tools ?? (stop === "tool_use" ? { Read: 1 } : {}) }, ...rest,
  } as RequestRow;
};
const prompt = (ts: number, sessionId = "s") => ({ key: `p${ts}`, kind: "prompt", sessionId, ts, promptId: null }) as ClaudeEvent;
const structure = (rows: RequestRow[], events: ClaudeEvent[] = [], extra: { datasetRows?: RequestRow[] } = {}) => turnStructure(rows, { bucket: "day", from, to, tz: "UTC", events, ...extra });

describe("turns", () => {
  test("tool_use continues a turn and the first other stop reason ends it", () => {
    const { turns } = structure([row("tool_use"), row("tool_use"), row("end_turn"), row("end_turn")]);
    expect(turns).toMatchObject({ total: 2, medianDepth: 2 });
    expect(turns.bins.find(bin => bin.label === "2-4")).toMatchObject({ turns: 1, steps: 3, turnShare: 0.5, costShare: 0.75 });
    expect(turns.ends).toEqual([{ name: "end_turn", count: 2 }]);
  });

  test("interleaved subagent steps do not break a main-chain turn", () => {
    const rows = [row("tool_use"), row("tool_use", { agent: "subagent", agentId: "a" }), row("tool_use"), row("end_turn", { agent: "subagent", agentId: "a" }), row("end_turn")];
    expect(structure(rows).turns).toMatchObject({ total: 2, bins: [{ turns: 0 }, { turns: 2 }, {}, {}, {}] });
  });

  test("a missing stop reason with a tool call continues, and without one ends as not recorded", () => {
    const { turns, coverage } = structure([row(null, { tools: { Bash: 1 } }), row(null), row("end_turn")]);
    expect(turns.total).toBe(2);
    expect(turns.ends).toContainEqual({ name: "not recorded", count: 1 });
    expect(coverage).toMatchObject({ steps: 3, stepsWithStopReason: 1, stopReasonShare: 0.3333 });
  });

  test("an interrupted turn ends at the next human prompt, under its recorded stop reason", () => {
    const first = row("tool_use");
    const second = row("tool_use");
    const { turns } = structure([first, second, row("end_turn")], [prompt(first.ts + 100)]);
    expect(turns.total).toBe(2);
    expect(turns.ends).toContainEqual({ name: "tool_use", count: 1 });
  });

  test("cost share counts priced steps only, next to the share of turns", () => {
    const { turns, coverage } = structure([row("end_turn"), row("end_turn", { priced: false, cost: 0 })]);
    expect(turns.bins[0]).toMatchObject({ turns: 2, turnShare: 1, costUsd: 1, costShare: 1 });
    expect(coverage).toMatchObject({ pricedSteps: 1, pricedShare: 0.5 });
  });

  test("a turn cut by the window is flagged", () => {
    const before = row("tool_use", { ts: from - 1_000 });
    const kept = row("end_turn");
    expect(structure([kept], [], { datasetRows: [before, kept] }).coverage.clippedTurns).toBe(1);
  });

  test("ocx rows stay out, counted, since their close reasons mean something else", () => {
    const { coverage } = structure([row("client_closed", { protocol: "responses" }), row("end_turn")]);
    expect(coverage).toMatchObject({ steps: 1, excludedRequests: 1 });
  });
});

describe("autonomy", () => {
  test("is main-chain steps over human prompts, overall and per session", () => {
    const rows = [row("tool_use"), row("end_turn"), row("tool_use", { agent: "subagent", agentId: "a" }), row("end_turn", { conversationId: "t" })];
    const { autonomy } = structure(rows, [prompt(from + 1), prompt(from + 2, "t")]);
    expect(autonomy).toMatchObject({ mainSteps: 3, humanPrompts: 2, overall: 1.5, sessions: 2, median: 1.5 });
    expect(autonomy!.weeks).toHaveLength(1);
  });

  test("is unavailable without prompt counts, never zero", () => {
    expect(structure([row("end_turn")]).autonomy).toBeNull();
  });
});

describe("without transcript structure", () => {
  test("turn depth is approximate from stop reasons, and autonomy and tools are unavailable", () => {
    const result = structure([row("tool_use", { agent: null }), row("end_turn", { agent: null })]);
    expect(result).toMatchObject({ approximate: true, autonomy: null, tools: null, turns: { total: 1 }, coverage: { structureShare: 0 } });
  });
});

describe("tools", () => {
  test("one mapping groups every name, case-insensitively, and MCP by prefix", () => {
    expect(["Bash", "bash", "Read", "Edit", "Grep", "Agent", "mcp__x__y", "Mystery"].map(toolGroup)).toEqual(["Bash", "Bash", "Read", "Edit/Write", "Search", "Agent", "MCP", "Other"]);
    expect(TOOL_GROUP_NAMES).toContain("Other");
  });

  test("steps with a tool overlap by design, and no cost is attributed to one", () => {
    const { tools } = structure([row("tool_use", { tools: { Read: 2, Bash: 1 } }), row("tool_use", { tools: { Read: 1 } }), row("end_turn")]);
    expect(tools!.top[0]).toMatchObject({ name: "Read", calls: 3, steps: 2, stepShare: 0.6667 });
    expect(tools!.stepsWithToolsShare).toBe(0.6667);
    expect(JSON.stringify(tools)).not.toMatch(/cost/i);
  });

  test("project and model tables stop at the top rows and roll the rest into Other", () => {
    const rows = Array.from({ length: 12 }, (_, index) => row("tool_use", { model: `m${index}` }));
    expect(structure(rows).tools!.byModel).toHaveLength(11);
    expect(structure(rows).tools!.byModel.at(-1)).toMatchObject({ key: "Other", requests: 2, calls: 2 });
  });

  test("no tool input or output text reaches the response", () => {
    const dirty = { ...row("tool_use"), errorCode: SECRET, requestedModel: SECRET } as RequestRow;
    expect(JSON.stringify(structure([dirty], [{ ...prompt(from + 1), promptId: SECRET } as ClaudeEvent]))).not.toContain(SECRET);
  });
});

test("stop reasons are shown as recorded, unknown values included", () => {
  expect(structure([row("end_turn"), row("refusal"), row("something_new")]).stops.map(stop => stop.name).sort()).toEqual(["end_turn", "refusal", "something_new"]);
});
