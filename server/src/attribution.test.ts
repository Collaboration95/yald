import { expect, test } from "bun:test";
import { filterRows, projectCoverage } from "./analytics";
import { attributionCoverage, summarizeReasons, unattributedReason } from "./attribution";
import type { RequestRow } from "./ocx/store";
import { projectBreakdown, projectMatcher, UNATTRIBUTED } from "./projects";
import { buildReport } from "./report/build";
import { renderReportHtml } from "./report/render";
import { buildReportSpec } from "./report/spec";

// Synthetic rows only: every folder and id below is invented.
const T0 = Date.parse("2026-10-11T00:00:00Z");
let n = 0;
function row(over: Partial<RequestRow>): RequestRow {
  return {
    measurements: { outcome: over.protocol !== "claude-code", duration: false, ttft: false, retries: false,
      input: true, output: true, cacheRead: true, cacheWrite: true, usage: "logical" },
    id: `r${++n}`, ts: T0 + n * 1_000, provider: "openai", model: "model-a", status: 200, ok: true,
    totalTokens: 100, inputTokens: 90, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    cost: 0.01, priced: true, estimated: false, protocol: "responses", conversationId: null, cwd: null, ...over,
  } as RequestRow;
}

const rows: RequestRow[] = [
  row({ model: "image-model", totalTokens: 0 }),                                   // opencodex, no conversation id
  row({ model: "image-model", totalTokens: 0 }),
  row({ model: "side-model", conversationId: "aaaa", rolloutMiss: true, totalTokens: 40 }), // id, no rollout
  row({ model: "side-model", conversationId: "bbbb", rolloutMiss: true, totalTokens: 60 }),
  row({ model: "claude-x", protocol: "claude-code", conversationId: "c1", totalTokens: 70 }), // transcript, no cwd
  row({ model: "side-model", conversationId: "dddd", totalTokens: 5 }),             // id but no rollout index was read
  row({ model: "model-a", conversationId: "eeee", cwd: "/work/app-a/server", totalTokens: 200 }),
  row({ model: "model-a", conversationId: "ffff", cwd: "/work/app-b", totalTokens: 300 }),
];

test("reasons are read off the row and never guessed", () => {
  expect(rows.map(unattributedReason)).toEqual(["noConversationId", "noConversationId", "noRollout", "noRollout", "other", "other", null, null]);
  // A Claude line without a cwd is never blamed on a rollout, even when the miss flag is set.
  expect(unattributedReason({ cwd: null, protocol: "claude-code", conversationId: "c", rolloutMiss: true })).toBe("other");
  // An id with no index consulted stays unknown.
  expect(unattributedReason({ cwd: null, protocol: "responses", conversationId: "c" })).toBe("other");
});

test("reason breakdown lists every reason and sums to the unattributed rows, tokens and models", () => {
  const reasons = summarizeReasons(rows);
  expect(reasons.map(r => [r.reason, r.rows, r.tokens])).toEqual([["noConversationId", 2, 0], ["noRollout", 2, 100], ["other", 2, 75]]);
  expect(reasons[0]!.models).toEqual([{ model: "image-model", rows: 2, tokens: 0 }]);
  expect(reasons[2]!.models.map(m => m.model)).toEqual(["claude-x", "side-model"]);
  expect(summarizeReasons([]).map(r => r.rows)).toEqual([0, 0, 0]);
});

test("project coverage reconciles kept, elsewhere and unknown rows for the same population", () => {
  const filter = { projects: ["/work/app-a"] };
  const coverage = projectCoverage(rows, filter)!;
  expect(coverage.unattributedRows).toBe(6);
  expect(coverage.unattributedTokens).toBe(175);
  const { matched, outsideProjects, unattributed } = coverage.attribution;
  expect(matched).toEqual({ rows: 1, tokens: 200 });
  expect(outsideProjects).toEqual({ rows: 1, tokens: 300 });
  expect(unattributed.rows).toBe(coverage.unattributedRows);
  expect(unattributed.reasons.reduce((a, r) => a + r.rows, 0)).toBe(unattributed.rows);
  expect(unattributed.reasons.reduce((a, r) => a + r.tokens, 0)).toBe(unattributed.tokens);
  expect(matched.rows + outsideProjects.rows + unattributed.rows).toBe(rows.length);
  expect(filterRows(rows, filter)).toHaveLength(matched.rows);
  // Other filters narrow the explained population too.
  expect(projectCoverage(rows, { ...filter, models: ["side-model"] })!.attribution.unattributed.rows).toBe(3);
  expect(projectCoverage(rows, { ...filter, sources: ["claude-code"] })!.attribution.unattributed.reasons.map(r => r.rows)).toEqual([0, 0, 1]);
  expect(attributionCoverage([], projectMatcher(["/x"])).unattributed.reasons).toHaveLength(3);
});

test("the (unattributed) project row carries the same reasons", () => {
  const unattributed = projectBreakdown(rows).find(p => p.project === UNATTRIBUTED)!;
  expect(unattributed.requests).toBe(6);
  expect(unattributed.reasons).toEqual(summarizeReasons(rows));
  expect(projectBreakdown(rows).filter(p => p.project !== UNATTRIBUTED).every(p => p.reasons === undefined)).toBe(true);
});

test("report JSON and coverage note agree, and old totals stay", () => {
  const window = { from: String(T0 - 1), to: String(T0 + 60_000), tz: "UTC", projects: ["/work/app-a"] };
  const dataset = { rows, quota: { windows: [], samples: [], updatedAt: null }, ledger: { events: [], byKind: {}, settledTokens: 0, updatedAt: null }, files: { usage: null, spend: null, quota: null } };
  const data = buildReport(dataset, buildReportSpec(window, { now: T0 + 120_000, first: T0 }), { now: T0 + 120_000, yaldVersion: "test", pricing: "ok", home: "/home/u" });
  const c = data.coverage;
  expect(c.unattributedRows).toBe(6);
  expect(c.unattributedTokens).toBe(175);
  expect(c.attribution!.matched.rows).toBe(data.kpis.requests);
  expect(c.attribution!.matched.tokens).toBe(data.kpis.tokens);
  const html = renderReportHtml(data).replace(/<script type="application\/json"[\s\S]*?<\/script>/, "");
  expect(html).toContain("6 requests in the window have no project folder and are excluded.");
  expect(html).toContain("2 of them (0 tokens) carry no conversation id");
  expect(html).toContain("image-model (2)");
  expect(html).toContain("2 of them (100 tokens) have a conversation id that matches no Codex session rollout");
  expect(html).toContain("side-model (2)");
  expect(html).toContain("2 of them (75 tokens) have no recorded folder and no further cause is known");
  expect(html).toContain("1 other request (300 tokens) ran in folders outside the selected projects");
  expect(html).not.toContain("estimated price");

  const unfiltered = buildReport(dataset, buildReportSpec({ ...window, projects: [] }, { now: T0 + 120_000, first: T0 }), { now: T0 + 120_000, yaldVersion: "test", pricing: "ok" });
  expect(unfiltered.coverage).toMatchObject({ unattributedRows: null, unattributedTokens: null, attribution: null });
});
