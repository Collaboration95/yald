import { describe, expect, test } from "bun:test";
import type { RequestRow } from "../ocx/store";
import type { ContextReplayResponse } from "../../../web/src/labs/context-types";
import { buildContextReplay } from "./context";
import { evidenceParams, requestsBefore, sessionKey, type AnalysisWindow } from "./scope";

const start = Date.parse("2026-10-10T00:00:00Z");
const window: AnalysisWindow = { from: start, to: start + 1000, tz: "Asia/Singapore", label: "synthetic window" };
function row(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: "request", ts: start, provider: "anthropic", model: "synthetic-model", requestedModel: "requested",
    resolvedModel: "resolved", effort: "high", status: 200, ok: true, durationMs: 100, ttftMs: 10,
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10, reasoningTokens: 2,
    totalTokens: 120, cost: 0.01, priced: true, estimated: false, rateIn: 1, rateOut: 2,
    rateCacheRead: 0.1, rateCacheWrite: 0.2, conversationId: "same-id", errorCode: null, closeReason: null,
    routeKind: "native", account: null, protocol: "messages", attempts: 1, sends: 1, settled: 1, unresolved: 0,
    cacheProvenance: "observed", contextTier: null, serviceTier: "default", retried: false,
    usageFromAttempts: false, usageStatus: "reported", attemptTokens: 120, cwd: "/synthetic/project",
    measurements: { outcome: true, duration: true, ttft: true, retries: true, input: true, output: true, cacheRead: true, cacheWrite: true, usage: "logical" },
    ...overrides,
  };
}
function sequence(values: number[], overrides: Partial<RequestRow> = {}) {
  return values.map((inputTokens, i) => row({ id: `r${i}`, ts: start + i * 10, inputTokens, ...overrides }));
}
const replay = (rows: RequestRow[]) => buildContextReplay(rows, {}, window);
const missing = (extra: Partial<RequestRow> = {}) => row({
  id: "missing", inputTokens: 0, outputTokens: 0, totalTokens: 0, priced: false, usageStatus: "unreported", ok: false, status: 502,
  measurements: { ...row().measurements, input: false, output: false, cacheRead: false, cacheWrite: false, usage: "missing" }, ...extra,
});

test("equal conversation IDs cannot collide across protocols, even with the same provider", () => {
  const result = replay([
    ...sequence([10, 100, 20, 100, 900, 200]),
    ...sequence([10, 20, 30, 40, 50, 60], { protocol: "claude-code" }),
  ]);
  expect(result.sessions).toHaveLength(2);
  expect(result.sessions.map(s => s.source)).toEqual(["ocx", "claude-code"]);
  expect(result.sessions[0]).toMatchObject({ key: sessionKey("ocx", "same-id"), inWindowRequests: 6, totalRequests: 6, eligibleRequests: 6,
    growth: { ranked: true, baseline: 20, latest: 200, absoluteChange: 180, ratio: 10 } });
  expect(result.sessions[1]?.growth).toEqual({ ranked: true, baseline: 20, latest: 50, absoluteChange: 30, ratio: 2.5 });
  for (const session of result.sessions) {
    expect(session.evidence.selector.selection).toEqual({ kind: "session", source: session.source, conversationId: "same-id" });
    expect(session.evidence.selector.eligibility).toBe("all");
  }
});

test("equal timestamps sort by id, duplicate ids retain stable ordinal, and input remains untouched", () => {
  const rows = [row({ id: "z", inputTokens: 99 }), row({ id: "a", inputTokens: 2 }), row({ id: "a", inputTokens: 3 }), row({ id: "b", inputTokens: 4 })];
  const snapshot = JSON.stringify(rows);
  for (const r of rows) { Object.freeze(r.measurements); Object.freeze(r); }
  Object.freeze(rows);
  const result = replay(rows);
  expect(result.sessions[0]?.requests.map(r => [r.id, r.inputTokens, r.ordinal])).toEqual([["a", 2, 0], ["a", 3, 1], ["b", 4, 2], ["z", 99, 3]]);
  expect(JSON.stringify(rows)).toBe(snapshot);
  const ties = [row({ conversationId: "z" }), row({ conversationId: "a" }), row({ protocol: "claude-code" })];
  expect(replay(ties).sessions.map(s => s.key)).toEqual([sessionKey("claude-code", "same-id"), sessionKey("ocx", "a"), sessionKey("ocx", "z")]);
});

test("missing input and attempt sums are gaps, genuine zero is eligible, and every exclusion is counted", () => {
  const zero = row({ id: "zero", inputTokens: 0 });
  const summed = row({ id: "sum", inputTokens: 200, usageFromAttempts: true,
    measurements: { ...row().measurements, usage: "attempt-sum" } });
  const markerOnly = row({ id: "sum-marker", measurements: { ...row().measurements, usage: "attempt-sum" } });
  const unavailable = row({ id: "unavailable", measurements: { ...row().measurements, usage: "missing" } });
  const absentWithOutput = row({ id: "absent", usageStatus: "reported", measurements: { ...row().measurements, input: false } });
  const unnamed = missing({ conversationId: null, id: "unnamed" });
  const result = replay([zero, summed, markerOnly, unavailable, absentWithOutput, unnamed]);
  expect(result.coverage).toMatchObject({ totalRequests: 6, eligibleRequests: 1, excludedRequests: 5, unnamedRequests: 1,
    exclusions: [{ reason: "attempt-summed usage", requests: 2 }, { reason: "input accounting missing", requests: 2 }, { reason: "input accounting unavailable", requests: 1 }] });
  const points = result.sessions[0]!.requests;
  expect(points.find(p => p.id === "zero")).toMatchObject({ inputTokens: 0, eligible: true, exclusionReason: null });
  expect(points.filter(p => p.id !== "zero").every(p => p.inputTokens === null && !p.eligible)).toBe(true);
  expect(points.find(p => p.id === "sum")).toMatchObject({ outputTokens: 20, totalTokens: null, measurements: { usage: "attempt-sum" }, exclusionReason: "attempt-summed usage" });
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0]?.inWindowRequests).toBe(5);
  const noUnnamed = result.sessions.reduce((n, s) => n + s.excludedRequests, 0);
  expect(noUnnamed + 1).toBe(result.coverage.excludedRequests);
});

test("inserting an unmetered failure never creates a drop or changes ranking", () => {
  const good = sequence([10, 20, 30, 40, 50, 60]);
  const baseline = replay(good).sessions[0]!.growth;
  for (const ts of [start, start + 15, start + 999]) {
    const result = replay([...good, missing({ ts })]);
    expect(result.sessions[0]!.growth).toEqual(baseline);
    expect(result.sessions[0]!.requests.find(p => p.id === "missing")).toMatchObject({ inputTokens: null, eligible: false, cost: null });
    expect(result.sessions[0]).toMatchObject({ inWindowRequests: 7, eligibleRequests: 6, excludedRequests: 1 });
  }
  const insufficient = replay([...sequence([10, 20, 30, 40, 50]), missing()]).sessions[0]!;
  expect(insufficient.growth).toEqual({ ranked: false, baseline: null, latest: null, absoluteChange: null, ratio: null });
});

test("ranking ties use stable source/session ordering and middle requests never replace endpoint medians", () => {
  const rows = [
    ...sequence([10, 20, 30, 999999, 40, 50, 60], { conversationId: "z" }),
    ...sequence([10, 20, 30, 40, 50, 60], { conversationId: "a" }),
    ...sequence([10, 20, 30, 40, 50, 60], { protocol: "claude-code" }),
  ];
  const result = replay(rows);
  expect(result.sessions.map(s => s.key)).toEqual([sessionKey("claude-code", "same-id"), sessionKey("ocx", "a"), sessionKey("ocx", "z")]);
  expect(result.sessions.every(s => s.growth.absoluteChange === 30)).toBe(true);
});

test("zero baselines have no ratio; zero change and observed decreases remain signed observations", () => {
  const growth = (values: number[]) => replay(sequence(values)).sessions[0]!.growth;
  expect(growth([0, 0, 0, 20, 30, 40])).toEqual({ ranked: true, baseline: 0, latest: 30, absoluteChange: 30, ratio: null });
  expect(growth([0, 0, 0, 0, 0, 0])).toEqual({ ranked: true, baseline: 0, latest: 0, absoluteChange: 0, ratio: null });
  expect(growth([100, 200, 300, 10, 20, 30])).toEqual({ ranked: true, baseline: 200, latest: 20, absoluteChange: -180, ratio: 0.1 });
  const result = replay([...sequence([100, 200, 300, 10, 20, 30]), row({ conversationId: "short" })]);
  expect(result.sessions.map(s => s.growth.ranked)).toEqual([true, false]);
});

test("range/cohort truncation uses all-session counts with no outside request detail or source collision", () => {
  const result = buildContextReplay([
    ...sequence([10, 20, 30, 40, 50, 60]),
    row({ id: "before-secret", ts: start - 1, model: "secret-model", inputTokens: 777 }),
    row({ id: "after-secret", ts: window.to }),
    row({ id: "filtered-secret", model: "excluded-model" }),
    row({ id: "other-source", protocol: "claude-code", ts: start - 1 }),
  ], { models: ["synthetic-model"] }, window);
  expect(result.sessions[0]).toMatchObject({ totalRequests: 9, inWindowRequests: 6, truncated: true,
    history: { beforeWindowRequests: 1, afterWindowRequests: 1, outsideCohortRequests: 1, rangeLimited: true, cohortLimited: true, loadedHistoryOnly: true } });
  expect(result.sessions[0]?.growth).toEqual(replay(sequence([10, 20, 30, 40, 50, 60])).sessions[0]!.growth);
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(result.sessions[0]?.requests.every(p => p.ts >= window.from && p.ts < window.to)).toBe(true);
  expect(replay(sequence([1, 2])).sessions[0]).toMatchObject({ truncated: false, history: { rangeLimited: false, cohortLimited: false, loadedHistoryOnly: true } });
});

test("scope filters use every cohort dimension and account for attribution gaps", () => {
  const filter = { sources: ["ocx" as const], projects: ["/synthetic/project"], providers: ["anthropic"], models: ["synthetic-model"], efforts: ["high"],
    statuses: ["ok" as const], routeKinds: ["native"], conversationId: "same-id", search: "request", from: start - 100, to: start + 1 };
  const result = buildContextReplay([row(), row({ provider: "elsewhere" }), row({ protocol: "claude-code" }), row({ cwd: null }), row({ ts: window.to })], filter, window);
  expect(result.coverage).toMatchObject({ totalRequests: 1, eligibleRequests: 1, attributedRequests: 1, projectCoverage: { unattributedRows: 1 } });
  expect(result.cohort.sources).toEqual(["ocx"]);
  expect(result.window).toMatchObject(window);
  expect(result.sessions[0]?.requests).toHaveLength(1);
});

test("fixed evidence fully preserves scope; unnamed rows reconcile without fabricated sessions", () => {
  const filter = { sources: ["ocx" as const], projects: ["/synthetic/project"], providers: ["anthropic"], models: ["synthetic-model"], efforts: ["high"],
    statuses: ["ok" as const], routeKinds: ["native"], conversationId: "same-id", search: "request" };
  const result = buildContextReplay([row()], filter, window);
  const evidence = result.sessions[0]!.evidence;
  expect(evidence.selector.cohort).toEqual(filter);
  const params = evidenceParams(evidence.selector);
  expect(params.get("from")).toBe(String(window.from));
  expect(params.get("to")).toBe(String(window.to));
  expect(params.get("tz")).toBe(window.tz);
  expect(params.get("sessionSource")).toBe("ocx");
  expect(params.get("sessionId")).toBe("same-id");
  expect(params.get("eligibility")).toBe("all");
  expect(params.has("range")).toBe(false);
  const restored = JSON.parse(params.get("selector")!);
  expect(restored).toEqual(evidence.selector);
  expect(Object.keys(restored.cohort).sort()).toEqual(["sources", "projects", "providers", "models", "efforts", "statuses", "routeKinds", "conversationId", "search"].sort());
  expect(evidence.href).toBe(`/labs/evidence?${params}`);
  const unnamed = replay([missing({ conversationId: null }), row({ conversationId: null })]);
  expect(unnamed.coverage).toMatchObject({ totalRequests: 2, eligibleRequests: 1, excludedRequests: 1, unnamedRequests: 2, evidence: { selector: { selection: { kind: "scope" }, eligibility: "all" } } });
  expect(unnamed.sessions).toEqual([]);
});

test("details preserve model/cache/output observations, unavailable timing and price, without reasoning double count", () => {
  const result = replay([row(), row({ id: "unpriced", model: "changed-model", priced: false, cost: 0, durationMs: 0, ttftMs: null,
    measurements: { ...row().measurements, duration: false, ttft: false, cacheRead: false, cacheWrite: false } }), row({ id: "free", cost: 0 })]);
  expect(result.sessions[0]!.requests.find(p => p.id === "request")).toMatchObject({ inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 10,
    outputTokens: 20, reasoningTokens: 2, totalTokens: 120, cost: 0.01, model: "synthetic-model", provider: "anthropic", requestedModel: "requested", resolvedModel: "resolved", durationMs: 100, ttftMs: 10 });
  expect(result.sessions[0]!.requests.find(p => p.id === "unpriced")).toMatchObject({ cost: null, durationMs: null, ttftMs: null, cacheReadTokens: null, cacheWriteTokens: null, model: "changed-model" });
  expect(result.sessions[0]!.requests.find(p => p.id === "free")?.cost).toBe(0);
  expect(result.coverage).toMatchObject({ pricedRequests: 2, unpricedRequests: 1 });
  expect(replay([row({ durationMs: 0, ttftMs: 0 })]).sessions[0]?.requests[0]).toMatchObject({ durationMs: 0, ttftMs: 0 });
});

test("empty and fully excluded scopes are serializable and satisfy the frontend response contract", () => {
  for (const rows of [[], [missing()], sequence([0, 0, 0, 10, 20, 30])]) {
    const response: ContextReplayResponse = { ok: true, ...replay(rows) };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    expect(response.coverage.eligibleRequests + response.coverage.excludedRequests).toBe(rows.length);
    expect(response.sessions.reduce((n, s) => n + s.inWindowRequests, 0) + response.unnamedRequests).toBe(rows.length);
  }
});

test("a session with agent markers lists its chains, main first, each with its own growth", () => {
  const base = { protocol: "claude-code", conversationId: "chains", provider: "anthropic", model: "m", totalTokens: 10, outputTokens: 0, measurements: { usage: "logical", input: true, output: true, cacheRead: true, cacheWrite: true } };
  const rows = [
    ...[1, 2, 3, 4, 5, 6].map(index => ({ ...base, id: `m${index}`, ts: index * 2, inputTokens: index * 100, details: { agent: "main", agentId: null, agentType: null } })),
    ...[1, 2].map(index => ({ ...base, id: `s${index}`, ts: index * 2 + 1, inputTokens: 5, details: { agent: "subagent", agentId: "a1", agentType: "Explore" } })),
  ] as never[];
  const { sessions } = buildContextReplay(rows, {}, { from: 0, to: 100, tz: "UTC", label: "t" });
  expect(sessions[0]!.chains!.map(chain => [chain.key, chain.requests, chain.growth.ranked])).toEqual([["main", 6, true], ["a1", 2, false]]);
  expect(sessions[0]!.requests.find(request => request.id === "s1")).toMatchObject({ chain: "a1" });
});

test("a session with no markers has no chains to pick", () => {
  const rows = [{ id: "r", ts: 1, protocol: "responses", conversationId: "x", provider: "p", model: "m", inputTokens: 1, outputTokens: 0, totalTokens: 1, measurements: { usage: "logical", input: true, output: true, cacheRead: true, cacheWrite: true } }] as never[];
  expect(buildContextReplay(rows, {}, { from: 0, to: 100, tz: "UTC", label: "t" }).sessions[0]!.chains).toBeNull();
});

describe("recorded compactions", () => {
  const window = { from: 1_000, to: 2_000, tz: "UTC", label: "t" };
  const measured = { usage: "logical", input: true, output: true, cacheRead: true, cacheWrite: true };
  const row = (id: string, ts: number, overrides: Record<string, unknown> = {}) => ({ id, ts, protocol: "claude-code", conversationId: "c", provider: "anthropic", model: "m", totalTokens: 10, inputTokens: 10, outputTokens: 0, measurements: measured, ...overrides }) as never;
  const rows = (...times: number[]) => times.map((ts, index) => row(`r${index}`, ts));
  const compact = (ts: number, trigger: string | null = "auto", extra: Record<string, unknown> = {}) => ({ key: `c${ts}`, kind: "compact", sessionId: "c", ts, agentId: null, trigger, preTokens: 900, postTokens: 100, durationMs: 5, ...extra }) as never;
  const captured = { key: "captured:c", kind: "captured", sessionId: "c", ts: 0 } as never;
  const session = (data: never[], events: never[]) => buildContextReplay(data, {}, window, events).sessions[0]!.compaction;

  test("a session with events reads recorded, each between the same two requests as the ledger rule", () => {
    const result = session(rows(1_100, 1_200, 1_300, 1_400), [captured, compact(1_250), compact(1_350, "manual"), compact(1_360, "weird")]);
    expect(result).toMatchObject({ state: "recorded", auto: 1, manual: 1, other: 1, requestsUntilFirst: 2, requestsUntilFirstUnavailable: null });
    expect(result.events.map(event => [event.position, event.requestsSincePrevious])).toEqual([[2, 2], [3, 1], [3, 0]]);
    expect(requestsBefore([1, 2, 2, 3], 2)).toBe(1);
  });

  test("a captured session without events reads none recorded, and never infers one from an input drop", () => {
    const dropped = [row("a", 1_100, { inputTokens: 500_000 }), row("b", 1_200, { inputTokens: 10 })];
    expect(session(dropped, [captured])).toMatchObject({ state: "none recorded", events: [], requestsUntilFirst: null });
  });

  test("a session archived before event capture is unavailable, and Codex is never captured", () => {
    expect(session(rows(1_100), [])).toMatchObject({ state: "unavailable", events: [] });
    expect(session([row("a", 1_100, { protocol: "responses" })], [captured, compact(1_150)])).toMatchObject({ state: "unavailable", events: [] });
  });

  test("events survive the transcript: the archive alone gives the state and the counts", () => {
    expect(session(rows(1_100, 1_300), [compact(1_200)])).toMatchObject({ state: "recorded", requestsUntilFirst: 1 });
  });

  test("a clipped sequence keeps its events but not requests until first", () => {
    const result = session([...rows(1_100, 1_300), row("before", 500)], [compact(1_200)]);
    expect(result).toMatchObject({ requestsUntilFirst: null, requestsUntilFirstUnavailable: "the sequence starts before the window", auto: 1 });
  });

  test("an event outside the window is counted, not returned, and makes the first one unknown", () => {
    const result = session(rows(1_100, 1_300), [compact(900), compact(1_200)]);
    expect(result).toMatchObject({ outsideWindowEvents: 1, requestsUntilFirst: null });
    expect(result.events.map(event => event.ts)).toEqual([1_200]);
  });

  test("missing recorded fields stay null, and a chain keeps its agent", () => {
    const [event] = session(rows(1_100, 1_300), [compact(1_200, null, { preTokens: null, postTokens: null, durationMs: null, agentId: "a1" })]).events;
    expect(event).toMatchObject({ trigger: null, preTokens: null, postTokens: null, durationMs: null, chain: "a1" });
  });

  test("the scope counts sessions per state, and a ratio needs enough events", () => {
    const events = Array.from({ length: 9 }, (_, index) => compact(1_101 + index));
    const data = (extra: never[]) => buildContextReplay(rows(1_100, 1_300), {}, window, [...events, ...extra]).coverage.compaction;
    expect(data([])).toMatchObject({ recordedSessions: 1, events: 9, auto: 9, autoPerManual: null, medianRequestsUntilFirst: 1, requestsUntilFirstSessions: 1 });
    expect(data([compact(1_250, "manual")]).autoPerManual).toBe(9);
  });

  test("the limitations hold the new position and no finding infers a compaction", () => {
    const { limitations } = buildContextReplay(rows(1_100), {}, window, []);
    expect(limitations.join(" ")).toContain("An input drop with no recorded event establishes nothing");
    expect(limitations.join(" ")).toContain("No recorded compaction is not no compaction");
  });
});
