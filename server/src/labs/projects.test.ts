import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRadarResponse as PublicResponse, RadarTotals } from "../../../web/src/types";
import { filterRows, type RowFilter } from "../analytics";
import type { RequestRow } from "../ocx/store";
import { createProjectIdentity, projectBreakdown, UNATTRIBUTED } from "../projects";
import { sourceOf } from "../report/source";
import { parseWindow } from "../time/window";
import { buildProjectRadar } from "./projects";
import type { EvidenceSelector } from "./scope";

const day = 86_400_000;
const from = Date.parse("2026-10-11T09:00:00+08:00");
const window = parseWindow({ from: String(from), to: String(from + 2 * day), tz: "Asia/Singapore" }, { now: from + 2 * day, first: from - 2 * day });
function row(id: string, ts: number, cwd: string | null, tokens: number, cost: number, extras: Partial<RequestRow> = {}): RequestRow {
  return {
    id, ts, cwd, totalTokens: tokens, cost, priced: true, estimated: false,
    provider: "anthropic", model: "shared-model", protocol: null, conversationId: "collision", effort: "high", routeKind: "native",
    measurements: { input: true, output: true, cacheRead: true, cacheWrite: true, usage: "logical", outcome: true, duration: true, ttft: true, retries: true },
    inputTokens: tokens, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    durationMs: 100, ttftMs: 1, status: 200, ok: true, requestedModel: null, resolvedModel: null,
    rateIn: 1, rateOut: 1, rateCacheRead: 1, rateCacheWrite: 1, errorCode: null, closeReason: null,
    account: null, attempts: 1, sends: 1, settled: 1, unresolved: 0, cacheProvenance: "observed", contextTier: null,
    serviceTier: null, retried: false, usageFromAttempts: false, usageStatus: "reported", attemptTokens: tokens, ...extras,
  };
}
let base: string, repo: string, submodule: string, newProject: string, priorOnly: string, gap: string;
let rows: RequestRow[];
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "yald-l02-radar-"));
  repo = join(base, "repo"); submodule = join(repo, "submodule"); newProject = join(base, "new");
  priorOnly = join(base, "prior-only"); gap = join(base, "removed-folder");
  await mkdir(join(repo, "server", "src"), { recursive: true });
  await mkdir(join(repo, ".git"));
  await mkdir(join(submodule, "nested"), { recursive: true });
  await writeFile(join(submodule, ".git"), "gitdir: synthetic-only\n");
  rows = [
    row("too-old", from - 2 * day - 1, repo, 999_999, 999),
    row("prior-start", from - 2 * day, join(repo, "server"), 100, 1),
    row("prior-end", from - 1, repo, 100, 1),
    row("prior-only", from - day, priorOnly, 50, 0.5),
    row("current-start", from, join(repo, "server", "src"), 200, 0.5),
    row("new-ocx", from + day, newProject, 400, 4),
    row("new-claude", from + day + 1, newProject, 100, 1, {
      protocol: "claude-code", measurements: { input: true, output: true, cacheRead: false, cacheWrite: false, usage: "logical", outcome: false, duration: false, ttft: false, retries: false }, cacheProvenance: "synthesized",
    }),
    row("unknown-folder", from + 1, null, 300, 99, { priced: false, conversationId: null }),
    row("no-rollout", from + 3_600_000, null, 100, 1, { rolloutMiss: true }),
    row("price-gap", from + 2 * 3_600_000, gap, 150, 99, { priced: false }),
    row("nested-git", from + 3 * 3_600_000, join(submodule, "nested"), 70, 0.7),
    row("at-to", window.to, repo, 999_999, 999),
  ];
});
afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });

function expectedTotals(rows: RequestRow[]): RadarTotals {
  return { requests: rows.length, tokens: rows.reduce((sum, r) => sum + r.totalTokens, 0),
    pricedCostUsd: rows.filter(r => r.priced).reduce((sum, r) => sum + r.cost, 0),
    pricedRequests: rows.filter(r => r.priced).length, unpricedRequests: rows.filter(r => !r.priced).length };
}
function replay(selector: EvidenceSelector) {
  const c = selector.cohort;
  let selected = filterRows(rows, { ...c, conversationId: c.conversationId ?? undefined, from: selector.window.from, to: selector.window.to });
  if (selector.selection.kind === "project") {
    const identity = createProjectIdentity(), project = selector.selection.project;
    selected = selected.filter(r => identity(r.cwd).project === project);
  }
  return selected;
}
function assertReconciles(body: PublicResponse) {
  for (const name of ["current", "prior"] as const) {
    const period = body[name];
    const groupTotals = body.projects.map(g => g[name].totals);
    for (const metric of ["requests", "tokens", "pricedCostUsd", "pricedRequests", "unpricedRequests"] as const) {
      expect(groupTotals.reduce((sum, group) => sum + group[metric], 0)).toBeCloseTo(period.totals[metric], 10);
      for (const mix of [period.daily, period.sources, period.models]) {
        expect(mix.reduce((sum, entry) => sum + entry[metric], 0)).toBeCloseTo(period.totals[metric], 10);
      }
    }
    expect(period.totals).toEqual(expectedTotals(replay(period.evidence.selector)));
    expect(period.coverage.eligibleRequests).toBe(period.totals.requests);
    expect(period.evidence.selector.eligibility).toBe("all");
    for (const group of body.projects) {
      const groupPeriod = group[name];
      expect(groupPeriod.totals).toEqual(expectedTotals(replay(groupPeriod.evidence.selector)));
      const params = new URL(groupPeriod.evidence.href, "http://fixture").searchParams;
      expect(params.get("projectKey")).toBe(group.project);
      expect(params.get("from")).toBe(String(groupPeriod.evidence.selector.window.from));
      expect(params.get("to")).toBe(String(groupPeriod.evidence.selector.window.to));
      expect(groupPeriod.evidence.selector.eligibility).toBe("all");
      for (const metric of ["requests", "tokens", "pricedCostUsd"] as const) {
        expect(groupPeriod.daily.reduce((sum, d) => sum + d[metric], 0)).toBeCloseTo(groupPeriod.totals[metric], 10);
      }
    }
  }
}

test("named and unattributed groups reconcile strict scope, daily/source/model mix and exact evidence in both windows", () => {
  // Structural assignment typechecks the browser's public response contract against the implementation.
  const body: PublicResponse = buildProjectRadar(rows, {}, window);
  assertReconciles(body);
  expect(body.current.totals).toEqual({ requests: 7, tokens: 1320, pricedCostUsd: 7.2, pricedRequests: 5, unpricedRequests: 2 });
  expect(body.prior.totals).toEqual({ requests: 3, tokens: 250, pricedCostUsd: 2.5, pricedRequests: 3, unpricedRequests: 0 });
  expect(body.projects.map(g => g.project)).toEqual([newProject, submodule, repo, gap, priorOnly, UNATTRIBUTED]);
  const decreasing = body.projects.find(g => g.project === repo)!;
  expect(decreasing).toMatchObject({ gitRoot: true, folders: [repo, join(repo, "server"), join(repo, "server", "src")] });
  expect(decreasing.comparison.requests).toEqual({ state: "compared", absoluteChange: -1, relativeChange: -0.5 });
  expect(decreasing.comparison.pricedCostUsd.relativeChange).toBe(-0.75);
  expect(body.projects.find(g => g.project === newProject)!.comparison.requests).toEqual({ state: "new", absoluteChange: 2, relativeChange: null });
  expect(body.projects.find(g => g.project === priorOnly)!.comparison.requests).toEqual({ state: "compared", absoluteChange: -1, relativeChange: -1 });
  expect(body.projects.find(g => g.project === gap)!).toMatchObject({ gitRoot: false, comparison: { pricedCostUsd: { state: "insufficient", absoluteChange: null, relativeChange: null } } });
  const attribution = body.current.coverage.attribution;
  expect(attribution).toEqual({ totalRequests: 7, eligibleRequests: 5 });
  expect(body.current.coverage.pricing).toEqual({ totalRequests: 7, eligibleRequests: 5 });
  expect(body.current.coverage.unattributedReasons.map(r => [r.reason, r.rows])).toEqual([["noConversationId", 1], ["noRollout", 1], ["other", 0]]);
  expect(body.current.coverage.measurements).toMatchObject({ cache: { totalRequests: 7, eligibleRequests: 6 }, outcomes: { totalRequests: 7, eligibleRequests: 6 } });
  expect(body.current.models.filter(m => m.model === "shared-model").map(m => m.source).sort()).toEqual(["claude-code", "ocx"]);
  const legacy = projectBreakdown(filterRows(rows, { from, to: window.to }));
  expect(legacy.find(g => g.project === repo)!.requests).toBe(decreasing.current.totals.requests);
});

test("project filters keep excluded unattributed rows outside strict totals, disclosing F03 reasons separately", () => {
  const body = buildProjectRadar(rows, { projects: [repo], sources: ["ocx"] }, window);
  assertReconciles(body);
  expect(body.current.totals.requests).toBe(2);
  expect(body.projects.map(g => g.project)).toEqual([submodule, repo, UNATTRIBUTED]);
  expect(body.projects.at(-1)!.current.totals.requests).toBe(0);
  expect(body.current.coverage.attribution).toEqual({ totalRequests: 2, eligibleRequests: 2 });
  expect(body.current.coverage.projectExclusions).toMatchObject({ unattributedRows: 2, unattributedTokens: 400,
    attribution: { matched: { rows: 2, tokens: 270 }, outsideProjects: { rows: 2, tokens: 550 } } });
  expect(body.prior.coverage.projectExclusions).toMatchObject({ unattributedRows: 0, attribution: { matched: { rows: 2 }, outsideProjects: { rows: 1 } } });
  const empty = buildProjectRadar(rows, { projects: [join(base, "no-match")] }, window);
  expect(empty.current.totals.requests).toBe(0);
  expect(empty.current.coverage.projectExclusions!.unattributedRows).toBe(2);
  assertReconciles(empty);
});

test("every non-time filter is preserved across equal-length periods and evidence", () => {
  const filters: RowFilter[] = [
    { sources: ["ocx"] }, { sources: ["claude-code"] }, { providers: ["other"] }, { models: ["missing"] },
    { efforts: ["low"] }, { statuses: ["unobserved"] }, { routeKinds: ["fallback"] }, { conversationId: "missing" },
    { search: "prior-" }, { projects: [repo] },
    { sources: ["ocx"], providers: ["anthropic"], models: ["shared-model"], efforts: ["high"], statuses: ["ok"], routeKinds: ["native"], conversationId: "collision", search: "shared" },
  ];
  for (const filter of filters) {
    const body = buildProjectRadar(rows, { ...filter, from: 0, to: 1 }, window);
    assertReconciles(body);
    expect(body.current.totals).toEqual(expectedTotals(filterRows(rows, { ...filter, from, to: window.to })));
    expect(body.prior.totals).toEqual(expectedTotals(filterRows(rows, { ...filter, from: from - 2 * day, to: from })));
    expect(body.current.evidence.selector.cohort).toEqual(body.prior.evidence.selector.cohort);
    expect(body.priorWindow.to - body.priorWindow.from).toBe(body.window.to - body.window.from);
    expect(body.priorWindow.tz).toBe(window.tz);
  }
});

test("daily occupied buckets respect local midnight and clipped half-open edges", () => {
  const midnight = Date.parse("2026-10-12T00:00:00+08:00");
  const sample = [row("first", from, repo, 1, 0), row("before-midnight", midnight - 1, repo, 1, 0),
    row("midnight", midnight, repo, 1, 0), row("end-minus-one", window.to - 1, repo, 1, 0), row("excluded", window.to, repo, 99, 1)];
  const body = buildProjectRadar(sample, {}, window);
  expect(body.current.activeDays).toBe(3);
  expect(body.current.daily.map(d => [d.date, d.requests, d.from, d.to])).toEqual([
    ["2026-10-11", 2, from, midnight], ["2026-10-12", 1, midnight, midnight + day], ["2026-10-13", 1, midnight + day, window.to],
  ]);
  expect(body.current.daily[0]!.ts).toBe(Date.parse("2026-10-11T00:00:00+08:00"));
  expect(body.current.totals.requests).toBe(4);
});

test("DST periods have identical elapsed lengths while daily buckets follow timezone", () => {
  const w = parseWindow({ from: "2026-03-08", to: "2026-03-10", tz: "America/New_York" }, { now: 0, first: 0 });
  const sample = [row("old", w.from - 2 * day, null, 1, 1), row("spring", w.from, null, 1, 1), row("next", Date.parse("2026-03-09T00:00:00-04:00"), null, 1, 1)];
  const body = buildProjectRadar(sample, {}, w);
  expect(w.to - w.from).toBe(47 * 3_600_000);
  expect(body.priorWindow.to - body.priorWindow.from).toBe(47 * 3_600_000);
  expect(body.current.daily.map(d => d.to - d.from)).toEqual([23 * 3_600_000, 24 * 3_600_000]);
});

test("no/missing/partial history, free zeros and all-unpriced populations never invent ratios", () => {
  const empty = buildProjectRadar([], {}, window);
  expect(empty.projects).toHaveLength(1);
  expect(empty.current.activeDays).toBe(0);
  expect(empty.history).toMatchObject({ firstLoadedAt: null, completeness: "unknown", prior: { startsBeforeLoadedHistory: true, hasLoadedHistory: false } });
  expect(empty.comparison.requests.state).toBe("insufficient");
  const onlyCurrent = buildProjectRadar([row("new", from, repo, 1, 1)], {}, window);
  expect(onlyCurrent.comparison.requests).toEqual({ state: "insufficient", absoluteChange: null, relativeChange: null });
  const partial = buildProjectRadar([row("partial", from - 1, repo, 10, 1), row("current", from, repo, 5, 0.5)], {}, window);
  expect(partial.history.prior).toEqual({ startsBeforeLoadedHistory: true, hasLoadedHistory: true });
  expect(partial.comparison.tokens.relativeChange).toBe(-0.5);
  const free = buildProjectRadar([row("free-before", from - 1, repo, 0, 0), row("positive", from, repo, 10, 1)], {}, window);
  expect(free.comparison.pricedCostUsd).toEqual({ state: "new", absoluteChange: 1, relativeChange: null });
  const unpriced = buildProjectRadar([row("gap-before", from - 1, repo, 0, 99, { priced: false }), row("gap", from, repo, 1, 99, { priced: false })], {}, window);
  expect(unpriced.comparison.pricedCostUsd).toEqual({ state: "insufficient", absoluteChange: null, relativeChange: null });
  expect(unpriced.current.totals).toMatchObject({ pricedCostUsd: 0, pricedRequests: 0, unpricedRequests: 1 });
  expect(JSON.stringify([empty, onlyCurrent, partial, free, unpriced])).not.toMatch(/Infinity|NaN/);
});

test("unchanged input ordering gives stable ranked output without mutating rows", () => {
  const before = JSON.stringify(rows);
  const a = buildProjectRadar(rows, {}, window), b = buildProjectRadar([...rows].reverse(), {}, window);
  expect(a).toEqual(b);
  expect(JSON.stringify(rows)).toBe(before);
  expect(sourceOf(rows.find(r => r.id === "new-ocx")!)).toBe("ocx");
});
