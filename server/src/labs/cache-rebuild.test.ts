import { describe, expect, test } from "bun:test";
import type { ClaudeEvent } from "../claude/transcripts";
import type { RequestRow } from "../ocx/store";
import { buildCacheRebuilds, ledgerIndex, ledgerExclusion, LEDGER_MIN_CHAINS, WARM_MIN_REQUESTS } from "./cache-rebuild";
import { buildEvidenceCase } from "./evidence";
import { EvidenceIntentError, parseCaseIntent, type CaseIntent } from "./evidence-intent";

const from = Date.UTC(2026, 9, 1);
const to = Date.UTC(2026, 9, 3);
const window = { from, to, tz: "UTC", label: "Two days" };
const MIN = 60_000;
const rates = { input: 4, cacheRead: 0.2, cacheWrite: 5 };
let next = 0;
const row = (session: string, ts: number, overrides: Partial<RequestRow> & { agentId?: string; reason?: string; ttl5m?: number | null; ttl1h?: number | null; noRate?: boolean } = {}): RequestRow => {
  const { agentId, reason, ttl5m, ttl1h, noRate, ...rest } = overrides;
  const read = rest.cacheReadTokens ?? 0;
  const write = rest.cacheWriteTokens ?? 0;
  return {
    id: `r${next++}`, ts: from + ts, conversationId: session, protocol: "claude-code", provider: "anthropic", model: "m", totalTokens: read + write, inputTokens: read + write, outputTokens: 0,
    cost: 1, priced: true, cacheWriteTokens: write, cacheReadTokens: read, cwd: null, rateCacheWrite: 5, rateCacheRead: 0.2, cacheProvenance: "observed",
    costParts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1 }, measurements: { input: true, output: true, cacheRead: true, cacheWrite: true, usage: "logical", duration: true, ttft: false },
    cacheEconomics: noRate ? null : { available: true, contextTier: null, rates: { ...rates, cacheRead: read > 0 ? rates.cacheRead : null, cacheWrite: write > 0 ? rates.cacheWrite : null } },
    details: { agent: agentId ? "subagent" : "main", agentId: agentId ?? null, cacheMissReason: reason ?? null,
      cacheWrite5m: ttl5m === undefined ? (write ? write : 0) : ttl5m, cacheWrite1h: ttl1h === undefined ? 0 : ttl1h },
    ...rest,
  } as unknown as RequestRow;
};
const compact = (session: string, ts: number, agentId: string | null = null): ClaudeEvent => ({ key: `c${next++}`, sessionId: session, ts: from + ts, kind: "compact", agentId, trigger: "auto", preTokens: 1, postTokens: 1, durationMs: 1 });
const build = (rows: RequestRow[], events: ClaudeEvent[] = []) => buildCacheRebuilds(rows, { from, to }, window, events);
const ledger = (rows: RequestRow[], events: ClaudeEvent[] = []) => Object.fromEntries(build(rows, events).ledger.filter(entry => entry.requests).map(entry => [entry.class, entry]));

describe("chains", () => {
  test("an interleaved subagent's first read does not make the main agent look like it lost its cache", () => {
    const rows = [
      row("s", 0, { cacheWriteTokens: 1000 }), row("s", 1000, { agentId: "a", cacheWriteTokens: 500 }),
      row("s", 2000, { cacheReadTokens: 1000, cacheWriteTokens: 10 }), row("s", 3000, { agentId: "a", cacheReadTokens: 500, cacheWriteTokens: 20 }),
    ];
    const result = build(rows);
    expect(result.ledger.filter(entry => entry.requests).map(entry => [entry.class, entry.requests])).toEqual([["session-start", 1], ["subagent-start", 1]]);
    expect(result.totals.requests).toBe(0);
    expect(result.interleaving).toEqual({ bySession: 1, byChain: 0, disappeared: 1 });
    expect(result.coverage).toMatchObject({ eligibleChains: 2, totalChains: 2, clippedChains: 0 });
  });

  test("a first request is a start, and a window never turns a continuing request into one", () => {
    const rows = [row("s", -3 * MIN, { cacheWriteTokens: 1000 }), row("s", MIN, { cacheWriteTokens: 900, cacheReadTokens: 100, reason: "messages_changed" })];
    const result = build(rows);
    expect(result.ledger.find(entry => entry.class === "session-start")!.requests).toBe(0);
    expect(result.ledger.find(entry => entry.class === "reported")).toMatchObject({ requests: 1, rewrittenTokens: 900 });
    expect(result.coverage.clippedChains).toBe(1);
  });

  test("start rows report what they wrote and are not rebuilds", () => {
    const start = ledger([row("s", 0, { cacheWriteTokens: 1000 })])["session-start"]!;
    expect(start).toMatchObject({ writeTokens: 1000, writeCostUsd: 1, rewrittenTokens: null, premiumUsd: null, label: "first request" });
  });
});

describe("rewritten tokens and premium", () => {
  test("rewritten is what the previous request had cached; the rest of the write is new content", () => {
    const rows = [row("s", 0, { cacheWriteTokens: 300, cacheReadTokens: 100 }), row("s", MIN, { cacheWriteTokens: 500, cacheReadTokens: 50 })];
    const entry = ledger(rows)["no-evidence"]!;
    expect(entry.rewrittenTokens).toBe(350);
    expect(entry.premiumUsd).toBeCloseTo((350 * 4.8) / 1e6, 6);
  });

  test("a row with no rates is unpriced, never zero", () => {
    const rows = [row("s", 0, { cacheWriteTokens: 300, cacheReadTokens: 100 }), row("s", MIN, { cacheWriteTokens: 500, cacheReadTokens: 50, noRate: true })];
    const result = build(rows);
    expect(result.ledger.find(entry => entry.class === "no-evidence")).toMatchObject({ premiumUsd: null, pricedRequests: 0, unpricedRequests: 1 });
    expect(result.totals).toMatchObject({ unpricedRequests: 1, premiumUsd: 0 });
  });

  test("a row that read nothing uses the chain's effective read rate for its model, and base rates never", () => {
    const rows = [row("s", 0, { cacheWriteTokens: 100, cacheReadTokens: 100 }), row("s", MIN, { cacheWriteTokens: 200 })];
    const result = build(rows);
    expect(result.totals).toMatchObject({ unpricedRequests: 0, borrowedRateRequests: 1 });
    expect(result.totals.premiumUsd).toBeCloseTo((200 * 4.8) / 1e6, 6);
    const other = [row("s", 0, { cacheWriteTokens: 100, cacheReadTokens: 100 }), row("s", MIN, { cacheWriteTokens: 200, model: "n" })];
    expect(build(other).totals).toMatchObject({ unpricedRequests: 1, borrowedRateRequests: 0 });
  });
});

describe("causes", () => {
  const pair = (second: Parameters<typeof row>[2], gap = MIN, first: Parameters<typeof row>[2] = {}) => [row("s", 0, { cacheWriteTokens: 1000, ...first }), row("s", gap, { cacheWriteTokens: 900, ...second })];
  const classOf = (rows: RequestRow[], events: ClaudeEvent[] = []) => ledgerIndex(rows, events).entries.get(rows[1]!)!;

  test("a reported reason keeps its raw value and is labelled reported", () => {
    const rows = pair({ reason: "tools_changed" }, 6 * MIN);
    expect(classOf(rows)).toMatchObject({ class: "reported", label: "reported", reason: "tools_changed", signals: ["reported", "idle-gap"] });
    expect(build(rows).reasons).toEqual([{ reason: "tools_changed", requests: 1 }]);
  });

  test("a compaction between the two requests is inferred, in the chain it was recorded in", () => {
    const rows = pair({});
    expect(classOf(rows, [compact("s", 30_000)])).toMatchObject({ class: "compaction", label: "inferred" });
    expect(classOf([...rows], [compact("s", 30_000, "other")]).class).toBe("no-evidence");
    expect(classOf([...rows], [compact("other", 30_000)]).class).toBe("no-evidence");
  });

  test("an event at the request's own time falls before it, as in Context Replay", () => {
    expect(classOf(pair({}), [compact("s", MIN)]).class).toBe("compaction");
    expect(classOf(pair({}), [compact("s", 0)]).class).toBe("no-evidence");
  });

  test("a model switch is inferred", () => {
    expect(classOf(pair({ model: "n" }))).toMatchObject({ class: "model-switch", label: "inferred" });
  });

  test("the idle gap uses the TTL of the previous write", () => {
    expect(classOf(pair({}, 5 * MIN)).class).toBe("no-evidence");
    expect(classOf(pair({}, 5 * MIN + 1))).toMatchObject({ class: "idle-gap", label: "inferred", gapMs: 5 * MIN + 1 });
    const oneHour = { ttl5m: 0, ttl1h: 1000 };
    expect(classOf(pair({}, 30 * MIN, oneHour)).class).toBe("no-evidence");
    expect(classOf(pair({}, 60 * MIN + 1, oneHour)).class).toBe("idle-gap");
  });

  test("a read-only request keeps the lifetime of the write before it", () => {
    const rows = [row("s", 0, { cacheWriteTokens: 100, ttl5m: 0, ttl1h: 100 }), row("s", MIN, { cacheReadTokens: 100 }), row("s", 31 * MIN, { cacheWriteTokens: 900 })];
    expect(ledgerIndex(rows, []).entries.get(rows[2]!)!.class).toBe("no-evidence");
  });

  test("without the split the idle gap is not asserted and the warm rate still works", () => {
    const rows = pair({}, 2 * 60 * MIN, { ttl5m: null, ttl1h: null });
    expect(classOf(rows).class).toBe("no-evidence");
    expect(build(rows).writeBill!.ttl.unsplitTokens).toBe(1000);
    const warm = Array.from({ length: WARM_MIN_REQUESTS }, (_, index) => row("w", index * MIN * 2, { cacheReadTokens: 10, cacheWriteTokens: 1, ttl5m: null, ttl1h: null }));
    expect(build(warm).warmByGap.find(bucket => bucket.label === "1-5m")).toMatchObject({ requests: WARM_MIN_REQUESTS - 1, warmShare: null });
    const enough = [...warm, row("w", WARM_MIN_REQUESTS * MIN * 2, { cacheReadTokens: 10, cacheWriteTokens: 1, ttl5m: null, ttl1h: null })];
    expect(build(enough).warmByGap.find(bucket => bucket.label === "1-5m")).toMatchObject({ requests: WARM_MIN_REQUESTS, warmShare: 1 });
  });
});

describe("population", () => {
  test("OpenAI-style rows are not applicable, never zero", () => {
    const codex = row("c", 0, { provider: "openai", protocol: "openai-responses" } as Partial<RequestRow>);
    expect(ledgerExclusion(codex)).toBe("not-applicable");
    const result = build([codex]);
    expect(result).toMatchObject({ state: "not-applicable", notApplicableRequests: 1, writeBill: null });
    expect(result.coverage.totalRequests).toBe(0);
  });

  test("rows without an agent marker are excluded with a number, and unmeasured cache is not a zero", () => {
    const unmarked = row("old", 0, { cacheWriteTokens: 5, details: null } as Partial<RequestRow>);
    const unmeasured = row("x", 0, { measurements: { cacheRead: false, cacheWrite: true } } as unknown as Partial<RequestRow>);
    const result = build([unmarked, unmeasured, row("s", 0, { conversationId: null })]);
    expect(result.coverage).toMatchObject({ totalRequests: 3, eligibleRequests: 0, eligibleChains: 0, totalChains: 1,
      excluded: { "no-agent-marker": 1, "cache-unmeasured": 1, "no-session": 1 } });
    expect(result.state).toBe("insufficient");
  });

  test("a ledger needs enough chains to be a finding", () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => row(`s${index}`, 0, { cacheWriteTokens: 10 }));
    expect(build(rows(LEDGER_MIN_CHAINS - 1)).state).toBe("insufficient");
    expect(build(rows(LEDGER_MIN_CHAINS)).state).toBe("observed");
  });

  test("the write bill shares tokens and cost by class and splits write tokens by lifetime", () => {
    const rows = [row("s", 0, { cacheWriteTokens: 100, cacheReadTokens: 300, ttl5m: 60, ttl1h: 40 })];
    const bill = build(rows).writeBill!;
    expect(bill.ttl).toEqual({ fiveMinuteTokens: 60, oneHourTokens: 40, unsplitTokens: 0 });
    expect(bill.tokenShare).toMatchObject({ cacheRead: 0.75, cacheWrite: 0.25 });
    expect(bill.costShare).toMatchObject({ cacheWrite: 1 });
  });

  test("no wording calls a chosen compaction or switch waste, and the premium is kept apart", () => {
    const text = build([]).notes.join(" ").toLowerCase();
    for (const word of ["waste", "avoidable", "savings"]) expect(text).not.toContain(word);
    expect(text).toContain("do not add them");
  });
});

describe("fixed case", () => {
  const rows = [
    row("s", 0, { cacheWriteTokens: 1000 }), row("s", 1000, { agentId: "a", cacheWriteTokens: 500 }),
    row("s", MIN, { cacheWriteTokens: 900, cacheReadTokens: 100, reason: "messages_changed" }), row("s", 10 * MIN, { cacheWriteTokens: 800 }),
    row("s", 11 * MIN, { agentId: "a", cacheWriteTokens: 400, cacheReadTokens: 100, model: "n" }),
  ];
  const evidence = (selector: unknown, extra: Record<string, string> = {}) => parseCaseIntent(new URLSearchParams({ investigation: "cache-detective", selector: JSON.stringify(selector), ...extra }));
  const selector = (overrides: object = {}) => ({ ...build(rows).evidence.selector, ...overrides });
  const run = (intent: CaseIntent) => buildEvidenceCase(rows, intent);

  test("lists rebuilds with class, label, gap and previous request, and pages without moving", () => {
    const first = run(evidence(selector(), { limit: "1" }));
    expect(first.page).toMatchObject({ total: 3, nextOffset: 1 });
    expect(first.rows[0]!.rebuild).toMatchObject({ class: "reported", label: "reported", reason: "messages_changed", gapMs: MIN,
      previous: { id: rows[0]!.id, model: "m", cacheReadTokens: 0, cacheWriteTokens: 1000 } });
    const second = run(evidence(selector(), { limit: "1", offset: "1" }));
    expect(second.rows[0]!.rebuild).toMatchObject({ class: "idle-gap", label: "inferred" });
    expect(run(evidence(selector())).observation).toMatchObject({ state: "observed", rebuild: { totals: { requests: 3, reported: 1 } } });
  });

  test("a cause selects one ledger row, including the starts", () => {
    expect(run(evidence(selector({ cause: "subagent-start" }))).rows.map(entry => entry.id)).toEqual([rows[1]!.id]);
    expect(run(evidence(selector({ cause: "model-switch" }))).rows.map(entry => entry.id)).toEqual([rows[4]!.id]);
    expect(run(evidence(selector({ cause: "compaction" }))).page.total).toBe(0);
  });

  test("a chain selection keeps one agent inside a session", () => {
    const chain = build(rows).topChains.find(entry => entry.agentId === "a")!;
    expect(chain.evidence.selector.selection).toEqual({ kind: "chain", source: "claude-code", conversationId: "s", agentId: "a" });
    expect(run(evidence(chain.evidence.selector)).rows.map(entry => entry.id)).toEqual([rows[4]!.id]);
    expect(run(evidence(selector({ selection: { kind: "chain", source: "claude-code", conversationId: "s", agentId: "main" } }))).page.total).toBe(2);
  });

  test("invalid selectors are refused", () => {
    const bad: unknown[] = [
      selector({ cause: "bogus" }), selector({ eligibility: "cache", cause: "reported" }),
      selector({ eligibility: "cache", selection: { kind: "chain", source: "claude-code", conversationId: "s", agentId: "a" } }),
      selector({ selection: { kind: "chain", source: "claude-code", conversationId: "s" } }),
      selector({ selection: { kind: "chain", source: "nope", conversationId: "s", agentId: "a" } }),
      selector({ selection: { kind: "project", project: "p" } }),
    ];
    for (const value of bad) expect(() => evidence(value)).toThrow(EvidenceIntentError);
    expect(() => parseCaseIntent(new URLSearchParams({ investigation: "context-replay", selector: JSON.stringify(selector()) }))).toThrow(EvidenceIntentError);
  });
});
