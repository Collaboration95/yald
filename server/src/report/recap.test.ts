import { describe, expect, test } from "bun:test";
import type { RequestRow } from "../ocx/store";
import { buildReport } from "./build";
import { parseCliArgs } from "./cli";
import { renderReportHtml } from "./render";
import { buildReportSpec } from "./spec";

const start = 1_791_000_000_000;
const row = (id: string, conversationId: string, overrides: Partial<RequestRow> = {}): RequestRow => ({
  id, ts: start + 1_000, conversationId, cwd: "/home/x/secret-project", protocol: "responses", provider: "p", model: "m", ok: true, status: 200, closeReason: null, errorCode: null,
  totalTokens: 100, cost: 1, priced: true, inputTokens: 90, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, durationMs: 0, ttftMs: null,
  rateIn: null, rateOut: null, rateCacheRead: null, rateCacheWrite: null, usageStatus: "reported", attempts: 1, attemptTokens: 0, retried: false, sends: 1, settled: 1, unresolved: 0,
  measurements: { usage: "logical", input: true, output: true, cacheRead: true, cacheWrite: true, outcome: true, duration: false, ttft: false, retries: false }, ...overrides,
} as RequestRow);
const dataset = { rows: ["aaaaaaaa-long-session-id", "b", "c", "d", "e", "f"].map((id, index) => row(`r${index}`, id)),
  quota: { samples: [], windows: [], updatedAt: null }, ledger: { events: [], byKind: {}, settledTokens: 0, updatedAt: null }, files: { usage: null, spend: null, quota: null } } as never;
const ctx = { now: start + 10_000, yaldVersion: "test", pricing: "ok" as const, home: "/home/x", projectOf: (cwd: string) => cwd };
const report = (input: Record<string, unknown>) => buildReport(dataset, buildReportSpec({ from: String(start), to: String(start + 5_000), tz: "UTC", ...input }, { now: start + 10_000, first: start }), ctx);

describe("the recap", () => {
  test("is off by default, leaving the payload without the block", () => {
    expect("workingStyle" in report({})).toBe(false);
    expect("workingStyle" in report({ recap: "0" })).toBe(false);
    expect(parseCliArgs([]).spec.recap).toBe(false);
    expect(parseCliArgs(["--recap"]).spec.recap).toBe(true);
  });

  test("gives the same notes to JSON and HTML, and keeps the schema version", () => {
    const data = report({ recap: "1" });
    expect(data.schemaVersion).toBe(1);
    expect(data.workingStyle).toMatchObject({ activeDays: 1, topModel: "m" });
    const html = renderReportHtml(data);
    for (const note of data.workingStyle!.notes) expect(html).toContain(note.text);
    expect(html).toContain("not fixed evidence");
  });

  test("redacts the session id with the report and carries no paths", () => {
    const redacted = JSON.stringify(report({ recap: "1" }).workingStyle);
    expect(redacted).toContain("aaaaaaaa");
    expect(redacted).not.toContain("aaaaaaaa-long");
    expect(redacted).not.toContain("secret-project");
    expect(JSON.stringify(report({ recap: "1", redact: false }).workingStyle)).toContain("aaaaaaaa-long");
  });
});
