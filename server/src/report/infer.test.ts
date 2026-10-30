import { describe, expect, test } from "bun:test";
import type { RequestRow } from "../ocx/store";
import { buildReport } from "./build";
import { inferFolders, inferredCoverage, SIDE_CALL_WINDOW_MS, type SessionSpan } from "./infer";
import { renderReportHtml } from "./render";
import { buildReportSpec } from "./spec";

const start = 1_791_000_000_000;
const row = (overrides: Partial<RequestRow>): RequestRow => ({
  id: `r${Math.random()}`, ts: start, cwd: null, protocol: "responses", conversationId: null, totalTokens: 100, model: "m", provider: "p",
  cost: 0, priced: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, durationMs: 0, ttftMs: null, rateIn: null, rateOut: null, rateCacheRead: null, rateCacheWrite: null, usageStatus: "reported", attempts: 1, attemptTokens: 0, retried: false, sends: 1, settled: 1, unresolved: 0,
  measurements: { usage: "missing", input: false, output: false, cacheRead: false, cacheWrite: false, outcome: false, duration: false, ttft: false, retries: false }, ...overrides,
} as RequestRow);
const span = (cwd: string, startedAt: number, lastActiveAt = startedAt + 3_600_000): SessionSpan => ({ cwd, startedAt, lastActiveAt });

describe("inferFolders", () => {
  test("a title call 1.6 s before a rollout takes that rollout's folder", () => {
    const call = row({ conversationId: "throwaway", rolloutMiss: true });
    const inferred = inferFolders([call], [span("/work/app", start + 1_600)]);
    expect(inferred.rows[0]!.cwd).toBe("/work/app");
    expect(inferred.basis.get(inferred.rows[0]!)).toBe("sideCall");
    expect(call.cwd).toBeNull();
  });

  test("the side-call window is closed at 5 s and only looks forward", () => {
    const call = row({ conversationId: "throwaway", rolloutMiss: true });
    expect(inferFolders([call], [span("/a", start + SIDE_CALL_WINDOW_MS)]).basis.size).toBe(1);
    expect(inferFolders([call], [span("/a", start + SIDE_CALL_WINDOW_MS + 1)]).basis.size).toBe(0);
    expect(inferFolders([call], [span("/a", start - 1)]).basis.size).toBe(0);
  });

  test("two rollouts starting after a side call leave it unattributed", () => {
    const call = row({ conversationId: "throwaway", rolloutMiss: true });
    expect(inferFolders([call], [span("/a", start + 1_000), span("/b", start + 2_000)]).rows[0]!.cwd).toBeNull();
  });

  test("an image row with no id inside one session takes its folder", () => {
    const image = row({ model: "image-model" });
    const inferred = inferFolders([image], [span("/work/app", start - 1_000), span("/work/old", start - 9_000, start - 5_000)]);
    expect(inferred.rows[0]!.cwd).toBe("/work/app");
    expect(inferred.basis.get(inferred.rows[0]!)).toBe("overlap");
  });

  test("a call overlapping two sessions stays unattributed", () => {
    const image = row({});
    expect(inferFolders([image], [span("/a", start - 1_000), span("/b", start - 2_000)]).rows[0]!.cwd).toBeNull();
  });

  test("recorded folders, Claude rows and an id with no recorded miss are never touched", () => {
    const rows = [row({ cwd: "/kept" }), row({ protocol: "claude-code" }), row({ conversationId: "unchecked" })];
    const inferred = inferFolders(rows, [span("/a", start - 1_000)]);
    expect(inferred.rows).toEqual(rows);
    expect(inferred.basis.size).toBe(0);
  });
});

test("inferred rows are counted separately, by basis, with those the filter kept", () => {
  const inferred = inferFolders([row({ conversationId: "t", rolloutMiss: true, totalTokens: 10 }), row({ ts: start + 60_000, totalTokens: 7 })], [span("/a", start + 1_000)]);
  expect(inferredCoverage(inferred, row => row.totalTokens === 10)).toEqual({
    rows: 2, tokens: 17, matchedRows: 1, sideCall: { rows: 1, tokens: 10 }, overlap: { rows: 1, tokens: 7 },
  });
});

describe("a project-filtered report", () => {
  const dataset = { rows: [
    row({ id: "kept", cwd: "/work/app", ts: start + 2_000, conversationId: "c", totalTokens: 50 }),
    row({ id: "title", conversationId: "t", rolloutMiss: true, ts: start + 1_000, totalTokens: 30 }),
  ], quota: { samples: [], windows: [], updatedAt: null }, ledger: { events: [], byKind: {}, settledTokens: 0, updatedAt: null }, files: { usage: null, spend: null, quota: null } } as never;
  const ctx = { now: start + 10_000, yaldVersion: "test", pricing: "ok" as const, home: "/home/x", projectOf: (cwd: string) => cwd, sessionSpans: [span("/work/app", start + 2_000)] };
  const spec = (infer?: boolean | string) => buildReportSpec({ from: String(start), to: String(start + 5_000), tz: "UTC", projects: "/work/app", infer }, { now: start + 10_000, first: start });

  test("counts an inferred row under its project and says so in JSON and HTML", () => {
    const report = buildReport(dataset, spec(), ctx);
    expect(report.kpis.requests).toBe(2);
    expect(report.coverage.unattributedRows).toBe(0);
    expect(report.coverage.inferred).toMatchObject({ rows: 1, tokens: 30, matchedRows: 1, sideCall: { rows: 1 } });
    expect(renderReportHtml(report)).toContain("by inference");
  });

  test("--no-infer keeps only recorded folders and adds no field", () => {
    const report = buildReport(dataset, spec(false), ctx);
    expect(report.kpis.requests).toBe(1);
    expect(report.coverage.unattributedRows).toBe(1);
    expect(report.coverage.attribution!.unattributed.reasons.find(reason => reason.reason === "noRollout")!.rows).toBe(1);
    expect("inferred" in report.coverage).toBe(false);
    expect(spec("0").infer).toBe(false);
  });
});
