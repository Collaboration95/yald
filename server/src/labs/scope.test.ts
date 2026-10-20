import { expect, test } from "bun:test";
import type { RowFilter } from "../analytics";
import type { RequestRow } from "../ocx/store";
import { analysisScope, evidenceFor, evidenceParams, orderedRequests, sessionKey } from "./scope";

const window = { from: 1_791_000_000_000, to: 1_791_086_400_000, tz: "Asia/Singapore", label: "fixed" };

test("scope evidence serializes fixed bounds, every cohort dimension, exact project and eligibility", () => {
  const filter: RowFilter = {
    from: 0, to: 1, sources: ["ocx", "claude-code"], projects: ["/fixture/A & B*", "/fixture/other"],
    providers: ["anthropic"], models: ["m-one", "m-two"], efforts: ["high"], statuses: ["unobserved", "error"],
    routeKinds: ["native"], conversationId: "c/1+2", search: "fixture & clue+",
  };
  const evidence = evidenceFor(filter, window, { kind: "project", project: "/fixture/A & B/nested" });
  const params = new URL(evidence.href, "http://fixture").searchParams;
  expect(params.toString()).toBe(evidenceParams(evidence.selector).toString());
  expect(Object.fromEntries(params)).toEqual({
    from: String(window.from), to: String(window.to), tz: window.tz, kind: "project", eligibility: "all",
    sources: "ocx,claude-code", projects: "/fixture/A & B*,/fixture/other", providers: "anthropic", models: "m-one,m-two",
    efforts: "high", statuses: "unobserved,error", routeKinds: "native", conversationId: "c/1+2", search: "fixture & clue+",
    projectKey: "/fixture/A & B/nested",
  });
  expect(params.has("range")).toBe(false);
  expect(evidence.selector.window).toEqual(window);
  expect(analysisScope(filter, window).window).toMatchObject({ halfOpen: true, fromIso: "2026-10-03T12:00:00+08:00" });
  const rollingWindow = { ...window, input: { range: "30d" }, range: "30d" };
  expect(analysisScope(filter, rollingWindow).window).not.toHaveProperty("input");
  expect(analysisScope(filter, rollingWindow).window).not.toHaveProperty("range");
  // Scope values are snapshots, independent of later UI filter mutations.
  filter.sources!.push("ocx");
  expect(evidence.selector.cohort.sources).toEqual(["ocx", "claude-code"]);
});

test("source-qualified session/unnamed selectors and default scope serialize without fabricated ids", () => {
  const session = evidenceFor({}, window, { kind: "session", source: "claude-code", conversationId: "collision" }, "context");
  expect(new URL(session.href, "http://fixture").searchParams.get("sessionSource")).toBe("claude-code");
  expect(new URL(session.href, "http://fixture").searchParams.get("sessionId")).toBe("collision");
  expect(session.selector.eligibility).toBe("context");
  const unnamed = new URL(evidenceFor({}, window, { kind: "unnamed", source: "ocx" }, "cache").href, "http://fixture").searchParams;
  expect(unnamed.get("kind")).toBe("unnamed");
  expect(unnamed.has("sessionId")).toBe(false);
  expect(unnamed.get("sessionSource")).toBe("ocx");
  expect(evidenceFor({}, window).selector.cohort.sources).toEqual(["claude-code", "ocx"]);
  expect(sessionKey("claude-code", "collision")).not.toBe(sessionKey("ocx", "collision"));
});

test("request order is timestamp, source, id, stable duplicate ordinal and never mutates inputs", () => {
  const row = (id: string, ts: number, protocol: string | null, ordinal: number) => ({ id, ts, protocol, ordinal }) as unknown as RequestRow;
  const later = row("a", 2, null, 0), ocxZ = row("z", 1, null, 0), duplicate1 = row("a", 1, null, 1);
  const claude = row("z", 1, "claude-code", 0), duplicate2 = row("a", 1, null, 2);
  const input = Object.freeze([later, ocxZ, duplicate1, claude, duplicate2]);
  expect(orderedRequests(input as unknown as RequestRow[])).toEqual([claude, duplicate1, duplicate2, ocxZ, later]);
  expect(input).toEqual([later, ocxZ, duplicate1, claude, duplicate2]);
  const ids = ["ä", "a", "z", "A", "😀"];
  expect(orderedRequests(ids.map(id => row(id, 1, null, 0))).map(r => r.id)).toEqual([...ids].sort());
});
