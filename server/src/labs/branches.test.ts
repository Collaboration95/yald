import { describe, expect, test } from "bun:test";
import type { ClaudeEvent } from "../claude/transcripts";
import type { RequestRow } from "../ocx/store";
import { publicRow } from "../publicRow";
import { branchBreakdown, branchOf, matchesBranch, pullRequestsBySession } from "./branches";
import { buildEvidenceCase } from "./evidence";
import { EvidenceIntentError, parseCaseIntent } from "./evidence-intent";
import { buildProjectRadar } from "./projects";

const DAY = 86_400_000;
const from = Date.UTC(2026, 9, 10);
const to = from + 2 * DAY;
const window = { from, to, tz: "UTC", label: "Two days" };
const dir = "/tmp/yald-branch-fixture/app";
let next = 0;
const measurements = { input: true, output: true, cacheRead: true, cacheWrite: true, usage: "logical", duration: true, ttft: true };
const claude = (branch: string | null, session = "s1", overrides: Partial<RequestRow> = {}): RequestRow => ({
  id: `b${next++}`, ts: from + next * 1000, protocol: "claude-code", provider: "anthropic", model: "m", conversationId: session, cwd: dir, totalTokens: 10, inputTokens: 5, outputTokens: 5,
  cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1, priced: true, measurements, details: { agent: "main", gitBranch: branch }, ...overrides,
} as unknown as RequestRow);
const codex = (session: { gitBranch: string | null; commitHash: string | null } | null, overrides: Partial<RequestRow> = {}): RequestRow => claude(null, "c1", {
  protocol: "responses", provider: "openai", details: null, codexSession: session === null ? undefined : { ...session, parentThreadId: null, depth: null, agentRole: null }, ...overrides,
} as Partial<RequestRow>);
const pr = (sessionId: string, prNumber: number, prRepository = "owner/repo"): ClaudeEvent => ({ key: `p${next++}`, sessionId, ts: from, kind: "pr", prNumber, prRepository });
const breakdown = (rows: RequestRow[], events: ClaudeEvent[] = []) => branchBreakdown(rows, "UTC", pullRequestsBySession(events));
const find = (result: ReturnType<typeof breakdown>, name: string | null, state = "named") => result.rows.find(row => row.state === state && row.name === name);

describe("what a row's branch is", () => {
  test("Claude is per request, and a recorded HEAD is detached", () => {
    expect(branchOf(claude("feature"))).toEqual({ state: "named", name: "feature", basis: "request time" });
    expect(branchOf(claude("HEAD"))).toMatchObject({ state: "detached", basis: "request time" });
    expect(branchOf(claude(null))).toEqual({ state: "unrecorded", name: null, basis: null });
  });

  test("Codex is at session start; a commit with no branch is detached, and nothing else is inferred", () => {
    expect(branchOf(codex({ gitBranch: "feature", commitHash: "abc" }))).toEqual({ state: "named", name: "feature", basis: "session start" });
    expect(branchOf(codex({ gitBranch: null, commitHash: "abc" }))).toMatchObject({ state: "detached", basis: "session start" });
    expect(branchOf(codex({ gitBranch: null, commitHash: null })).state).toBe("unrecorded");
    expect(branchOf(codex(null)).state).toBe("unrecorded");
  });

  test("a branch literally named unrecorded is not the bucket", () => {
    const row = claude("unrecorded");
    expect(matchesBranch(row, { state: "named", branch: "unrecorded" })).toBe(true);
    expect(matchesBranch(row, { state: "unrecorded" })).toBe(false);
  });
});

describe("the breakdown", () => {
  test("a session that changes branch splits by request and counts once on each", () => {
    const result = breakdown([claude("a"), claude("a"), claude("b")]);
    expect(find(result, "a")).toMatchObject({ requests: 2, sessions: 1 });
    expect(find(result, "b")).toMatchObject({ requests: 1, sessions: 1 });
  });

  test("a Codex session stays on the branch it started on, and shows that basis", () => {
    const result = breakdown([codex({ gitBranch: "start", commitHash: "x" }), codex({ gitBranch: "start", commitHash: "x" })]);
    expect(find(result, "start")).toMatchObject({ requests: 2, bases: ["session start"], sources: [{ source: "ocx", requests: 2 }] });
  });

  test("buckets are pinned, main first and the unrecorded last, and sum to the whole", () => {
    const rows = [claude(null), claude("HEAD"), claude("main"), claude("feature", "s2", { cost: 9 }), codex({ gitBranch: null, commitHash: null }), claude("master")];
    const result = breakdown(rows);
    expect(result.rows.map(row => row.name ?? row.state)).toEqual(["main", "master", "feature", "detached", "unrecorded"]);
    expect(result.rows.reduce((sum, row) => sum + row.requests, 0)).toBe(rows.length);
    expect(result.rows.reduce((sum, row) => sum + row.pricedCostUsd, 0)).toBe(14);
    expect(result.requests).toEqual({ total: 6, recorded: 4, onMain: 2, detached: 1, unrecorded: 2 });
    expect(result.coverage).toEqual([{ source: "claude-code", requests: 5, recorded: 4 }, { source: "ocx", requests: 1, recorded: 0 }]);
  });

  test("a repository's Main is on main, and the sentence agrees with the table", () => {
    const result = breakdown([claude("feature"), claude("Main")]);
    expect(result.rows[0]!.name).toBe("Main");
    expect(result.requests.onMain).toBe(1);
  });

  test("a session with many PRs sends a few and keeps the exact count", () => {
    const links = Array.from({ length: 12 }, (_, index) => pr("s1", index));
    expect(find(breakdown([claude("a")], links), "a")).toMatchObject({ prCount: 12 });
    expect(find(breakdown([claude("a")], links), "a")!.prs).toHaveLength(8);
  });

  test("an unpriced row adds requests and never dollars", () => {
    expect(find(breakdown([claude("a"), claude("a", "s1", { priced: false, cost: 0 })]), "a")).toMatchObject({ requests: 2, pricedRequests: 1, unpricedRequests: 1, pricedCostUsd: 1 });
  });

  test("a branch lists its sessions' PRs, and a PR can sit on two branches", () => {
    const result = breakdown([claude("a", "s1"), claude("b", "s1"), claude("c", "s2")], [pr("s1", 7), pr("s1", 8), pr("s2", 7, "owner/other")]);
    expect(find(result, "a")!.prs).toEqual(["owner/repo#7", "owner/repo#8"]);
    expect(find(result, "b")!.prs).toEqual(["owner/repo#7", "owner/repo#8"]);
    expect(find(result, "c")!.prs).toEqual(["owner/other#7"]);
  });

  test("span and active days use the window's time zone, and only the costliest carry day detail", () => {
    const rows = [claude("a", "s", { ts: from + 1000 }), claude("a", "s", { ts: from + DAY + 1000 })];
    expect(find(breakdown(rows), "a")).toMatchObject({ activeDays: 2, firstTs: from + 1000, lastTs: from + DAY + 1000 });
    const many = Array.from({ length: 14 }, (_, index) => claude(`b${index}`, "s", { cost: index }));
    expect(breakdown(many).rows.filter(row => row.days).length).toBe(12);
  });
});

test("publicRow carries the branch from either source", () => {
  expect(publicRow(claude("a")).gitBranch).toBe("a");
  expect(publicRow(codex({ gitBranch: "b", commitHash: null })).gitBranch).toBe("b");
  expect(publicRow(codex(null)).gitBranch).toBeNull();
});

describe("radar and its fixed case", () => {
  const rows = [
    claude("feature", "s1"), claude("feature", "s1"), claude("HEAD", "s2"), claude(null, "s3"), claude("unrecorded", "s4"),
    claude("feature", "s5", { ts: from - DAY }), claude("old", "s6", { ts: from - 2 * 3_600_000 }),
  ];
  const radar = () => buildProjectRadar(rows, { from, to }, window, { events: [pr("s1", 7)] });
  const project = () => radar().projects.find(entry => entry.current.totals.requests > 0)!;
  const pair = (selection: object) => {
    const { current, prior } = project();
    return new URLSearchParams({ investigation: "project-radar", selector: JSON.stringify({ ...current.evidence.selector, selection }), priorSelector: JSON.stringify({ ...prior.evidence.selector, selection }), period: "current" });
  };
  const branch = (state: string, name?: string) => ({ kind: "branch", project: project().project, state, ...(name === undefined ? {} : { branch: name }) });

  test("both periods carry branches, and reconcile to the project", () => {
    const { current, prior } = project();
    expect(current.branches.rows.reduce((sum, row) => sum + row.requests, 0)).toBe(current.totals.requests);
    expect(prior.branches.rows.map(row => row.name).sort()).toEqual(["feature", "old"]);
    expect(current.branches.rows.find(row => row.name === "feature")!.prs).toEqual(["owner/repo#7"]);
    expect(project().comparison.requests.state).toBe("compared");
  });

  test("a named branch lists its rows for the chosen period, and the pair moves together", () => {
    const body = buildEvidenceCase(rows, parseCaseIntent(pair(branch("named", "feature"))));
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]!.gitBranch).toBe("feature");
    if (body.observation.investigation !== "project-radar") throw new Error("wrong observation");
    expect(body.observation.current.totals.requests).toBe(2);
    expect(body.observation.prior.totals.requests).toBe(1);
    const q = pair(branch("named", "feature")); q.set("period", "prior");
    expect(buildEvidenceCase(rows, parseCaseIntent(q)).rows).toHaveLength(1);
  });

  test("the detached and unrecorded states are explicit, and a branch named unrecorded stays apart", () => {
    expect(buildEvidenceCase(rows, parseCaseIntent(pair(branch("detached")))).rows.map(row => row.conversationId)).toEqual(["s2"]);
    expect(buildEvidenceCase(rows, parseCaseIntent(pair(branch("unrecorded")))).rows.map(row => row.conversationId)).toEqual(["s3"]);
    expect(buildEvidenceCase(rows, parseCaseIntent(pair(branch("named", "unrecorded")))).rows.map(row => row.conversationId)).toEqual(["s4"]);
  });

  test("invalid selectors are refused", () => {
    for (const selection of [branch("named"), branch("detached", "x"), branch("nope"), { kind: "branch", state: "detached" }, branch("named", "")]) {
      expect(() => parseCaseIntent(pair(selection))).toThrow(EvidenceIntentError);
    }
    const mismatched = pair(branch("named", "a"));
    mismatched.set("priorSelector", JSON.stringify({ ...project().prior.evidence.selector, selection: branch("named", "b") }));
    expect(() => parseCaseIntent(mismatched)).toThrow(EvidenceIntentError);
    const other = new URLSearchParams({ investigation: "context-replay", selector: JSON.stringify({ ...project().current.evidence.selector, selection: branch("detached") }) });
    expect(() => parseCaseIntent(other)).toThrow(EvidenceIntentError);
  });
});
