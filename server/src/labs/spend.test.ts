import { expect, test } from "bun:test";
import type { RequestRow } from "../ocx/store";
import { buildEvidenceCase } from "./evidence";
import { EvidenceIntentError, parseCaseIntent } from "./evidence-intent";
import { buildSpendChanges, SPEND_RULE, spendCaseObservation, type SpendChangesResponse } from "./spend";

const DAY = 86_400_000;
const start = Date.parse("2026-09-01T00:00:00Z");
const noon = (day: number) => start + day * DAY + 12 * 3_600_000;

function row(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: "r", ts: start, provider: "anthropic", model: "m", requestedModel: null, resolvedModel: null, effort: null,
    status: 200, ok: true, durationMs: 100, ttftMs: 10, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 1100, cost: 1, priced: true, estimated: false, rateIn: 3, rateOut: 15, rateCacheRead: 0.3,
    rateCacheWrite: 3.75, conversationId: "s", errorCode: null, closeReason: null, routeKind: null, account: null, protocol: "messages",
    attempts: 1, sends: 1, settled: 1, unresolved: 0, cacheProvenance: "observed", contextTier: null, serviceTier: null,
    retried: false, usageFromAttempts: false, usageStatus: "reported", attemptTokens: 1100, cwd: "/synthetic/app",
    measurements: { outcome: true, duration: true, ttft: true, retries: true, input: true, output: true, cacheRead: true, cacheWrite: true, usage: "logical" },
    ...overrides,
  };
}
/** One priced request per day at noon UTC, with the cost the callback gives. */
const series = (days: number, cost: (day: number) => number, extra: (day: number) => Partial<RequestRow> = () => ({})) =>
  Array.from({ length: days }, (_, day) => row({ id: `d${day}`, ts: noon(day), cost: cost(day), conversationId: `c${day}`, ...extra(day) }));
const window = (days: number, tz = "UTC") => ({ from: start, to: start + days * DAY, tz, label: "synthetic" });
const build = (rows: RequestRow[], days: number, options: { tz?: string; now?: number; day?: string | null; filter?: object; windowFrom?: number } = {}): SpendChangesResponse => {
  const w = { ...window(days, options.tz), ...(options.windowFrom !== undefined ? { from: options.windowFrom } : {}) };
  const result = buildSpendChanges(rows, options.filter ?? {}, w, options.now ?? w.to + DAY, options.day);
  if ("error" in result) throw new Error("unexpected day error");
  return result;
};

test("the rule is echoed with its parameters", () => {
  expect(SPEND_RULE).toMatchObject({ id: "trailing-median", baselineActiveDays: 14, minBaselineActiveDays: 7, spikeMultiple: 2.5, order: ["project", "model", "tokenClass"] });
});

test("a planted spike on a steadily trending series is flagged, where a z-score rule flags nothing", () => {
  const trend = (day: number) => 10 * 1.12 ** day;
  const rows = series(40, day => (day === 30 ? 3 * trend(day) : trend(day)));
  const costs = rows.map(entry => entry.cost);
  const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
  const sd = Math.sqrt(costs.reduce((a, b) => a + (b - mean) ** 2, 0) / costs.length);
  expect(costs.filter(cost => (cost - mean) / sd > 3)).toEqual([]);
  const result = build(rows, 40);
  const spikes = result.days.filter(day => day.state === "spike");
  expect(spikes.map(day => day.date)).toEqual(["2026-10-01"]);
  expect(result.coverage).toMatchObject({ spikeDays: 1, windowDays: 40 });
  expect(spikes[0]!.baseline).toMatchObject({ activeDays: 14, firstDate: "2026-09-17", lastDate: "2026-09-30", pricedRequests: 14, totalRequests: 14 });
  expect(spikes[0]!.baseline.ratio).toBeGreaterThan(SPEND_RULE.spikeMultiple);
  expect(result.selected!.day.date).toBe("2026-10-01");
});

test("too few baseline days are insufficient, never normal; partial and clipped days are never flagged", () => {
  const rows = series(12, day => (day === 3 ? 500 : 10));
  const result = build(rows, 12, { now: noon(11) });
  const states = result.days.map(day => day.state);
  // Days 0-6 have fewer than 7 active baseline days, even the planted spike on day 3.
  expect(states.slice(0, 7)).toEqual(Array(7).fill("insufficient"));
  expect(result.days[3]!.insufficientReason).toBe("baseline-days");
  expect(states.slice(7, 11)).toEqual(Array(4).fill("normal"));
  // The day containing "now" is in progress.
  expect(result.days[11]).toMatchObject({ state: "partial", partialReason: "in-progress" });
  // A window that starts mid-day clips its first day.
  const clipped = build(rows, 12, { windowFrom: noon(0), now: start + 20 * DAY });
  expect(clipped.days[0]).toMatchObject({ state: "partial", partialReason: "window-edge" });
  // Inactive days are not zero: a gap is neither normal nor a spike.
  const gappy = build(series(20, () => 10).filter(entry => entry.id !== "d15"), 20);
  expect(gappy.days[15]).toMatchObject({ state: "no-priced", pricedCostUsd: null, requests: 0 });
  expect(gappy.days[16]!.baseline.activeDays).toBe(14);
});

test("a zero-cost baseline cannot produce a spike", () => {
  const result = build(series(12, day => (day === 10 ? 5 : 0)), 12);
  expect(result.days[10]).toMatchObject({ state: "insufficient", insufficientReason: "zero-baseline" });
});

test("every cut sums exactly to the day's change; new groups are labelled and unpriced change is separate", () => {
  const base = (day: number): Partial<RequestRow> => ({ model: "old-model", cwd: day % 2 ? "/synthetic/app" : "/synthetic/lib", cost: 10 });
  const rows = series(20, () => 10, base);
  // Spike day 18: the old model grows, a new model and a new project appear, some requests are unpriced.
  const spikeTs = noon(18);
  rows.push(
    row({ id: "grow", ts: spikeTs + 1, model: "old-model", cost: 40, cwd: "/synthetic/app", conversationId: "big" }),
    row({ id: "new-model", ts: spikeTs + 2, model: "brand-new", cost: 30, cwd: "/synthetic/newproj", conversationId: "big" }),
    row({ id: "unpriced", ts: spikeTs + 3, model: "unpriced-model", priced: false, cost: 0, totalTokens: 9000, cwd: null, conversationId: null }),
    row({ id: "adjusted", ts: spikeTs + 4, model: "old-model", cost: 12, cwd: "/synthetic/app", conversationId: "tiered" }),
  );
  rows.sort((a, b) => a.ts - b.ts);
  const result = build(rows, 20, { day: "2026-09-19" });
  const selected = result.selected!;
  expect(selected.day.state).toBe("spike");
  const d = selected.decomposition!;
  expect(d.order).toEqual(["project", "model", "tokenClass"]);
  expect(d.dayCostUsd).toBeCloseTo(10 + 40 + 30 + 12, 9);
  expect(d.baselineMeanUsd).toBeCloseTo(10, 9);
  expect(d.changeUsd).toBeCloseTo(92 - 10, 9);
  for (const kind of ["project", "model", "tokenClass", "session"] as const) {
    const part = d.cuts[kind];
    const parts = [...part.groups, ...part.new];
    const sum = parts.reduce((total, group) => total + group.changeUsd, 0) + (part.other?.changeUsd ?? 0);
    expect(sum, kind).toBeCloseTo(d.changeUsd, 9);
    expect(parts.reduce((t, g) => t + g.dayCostUsd, 0) + (part.other?.dayCostUsd ?? 0), kind).toBeCloseTo(d.dayCostUsd, 9);
  }
  // New groups are apart from groups that grew, and their whole cost is change.
  expect(d.cuts.model.new.map(group => group.label)).toEqual([expect.stringContaining("brand-new")]);
  expect(d.cuts.model.new[0]).toMatchObject({ isNew: true, baselineMeanUsd: 0, changeUsd: 30, dayCostUsd: 30 });
  expect(d.cuts.model.groups.every(group => !group.isNew)).toBe(true);
  expect(d.cuts.project.new.map(group => group.key)).toEqual(["/synthetic/newproj"]);
  expect(d.cuts.session.new.map(group => group.label).join(" ")).toContain("big");
  // The row without the engine split (its cost is far above table rates) puts nothing in a class it cannot place; its tier uplift is its own line.
  expect(d.cuts.tokenClass.groups.concat(d.cuts.tokenClass.new).map(group => group.label)).toContain("Tier adjustment");
  // Unpriced rows add requests and tokens, never dollars, and are shown beside the waterfall.
  expect(d.unpriced).toMatchObject({ dayRequests: 1, dayTokens: 9000, baselineMeanRequests: 0, tokenChange: 9000 });
  expect(d.attribution).toMatchObject({ dayRequests: 5, attributedRequests: 4 });
  // The drill-down goes project, then model, then token class, and each level adds up to its parent.
  const app = d.drilldown.projects.find(project => project.key === "/synthetic/app")!;
  expect(app.models.reduce((t, m) => t + m.changeUsd, 0) + (app.otherModels?.changeUsd ?? 0)).toBeCloseTo(app.changeUsd, 9);
  const oldModel = app.models.find(model => model.label.includes("old-model"))!;
  expect(oldModel.tokenClasses.reduce((t, c) => t + c.changeUsd, 0)).toBeCloseTo(oldModel.changeUsd, 9);
});

test("earlier spike days are left out of the decomposition baseline, not of the detection median", () => {
  const rows = series(20, day => (day === 10 ? 100 : 10));
  rows.push(row({ id: "spike", ts: noon(18) + 1, cost: 60, conversationId: "x" }));
  const result = build(rows.sort((a, b) => a.ts - b.ts), 20, { day: "2026-09-19" });
  const d = result.selected!.decomposition!;
  expect(d.baselineMedianUsd).toBe(10);
  expect(d.excludedBaselineDates).toEqual(["2026-09-11"]);
  expect(d.keptBaselineDays).toBe(d.baselineDays - 1);
  expect(d.baselineMeanUsd).toBe(10);
});

test("a 25-hour and a 23-hour local day are compared as they are and labelled", () => {
  const tz = "America/New_York";
  const long = Date.parse("2026-11-01T04:00:00Z"); // midnight EDT on the 25-hour day
  const short = Date.parse("2026-03-08T05:00:00Z"); // midnight EST on the 23-hour day
  for (const [first, label, hours] of [[long - 20 * DAY, "2026-11-01", 25], [short - 20 * DAY, "2026-03-08", 23]] as const) {
    const rows = Array.from({ length: 22 }, (_, i) => row({ id: `n${i}`, ts: first + i * DAY + 3_600_000 * 15, cost: 10, conversationId: `c${i}` }));
    const result = buildSpendChanges(rows, {}, { from: first, to: first + 22 * DAY, tz, label: "w" }, first + 40 * DAY);
    if ("error" in result) throw new Error("unexpected");
    const day = result.days.find(entry => entry.date === label)!;
    expect(day.hours).toBe(hours);
    expect(day.state).toBe("normal");
  }
});

test("the fixed case reproduces the finding from the two windows alone, independent of toolbar filters and paging", () => {
  const rows = series(30, () => 10, day => ({ conversationId: `c${day}` }));
  rows.push(...Array.from({ length: 4 }, (_, i) => row({ id: `big${i}`, ts: noon(25) + 1 + i, cost: 20, model: "other", conversationId: "big", cwd: "/synthetic/lib" })));
  rows.sort((a, b) => a.ts - b.ts);
  const live = build(rows, 30);
  const selected = live.selected!;
  expect(selected.day.date).toBe("2026-09-26");
  expect(selected.decomposition).not.toBeNull();
  const href = selected.evidence!.href;
  const params = new URL(href, "http://yald.invalid").searchParams;
  expect(params.get("investigation")).toBe("spend-changes");
  const intent = parseCaseIntent(params);
  const dayWindow = intent.selector.window;
  expect(dayWindow.to - dayWindow.from).toBe(DAY);
  expect(intent.priorSelector!.window.to).toBe(dayWindow.from);
  const evidence = buildEvidenceCase(rows, intent);
  const observation = evidence.observation as ReturnType<typeof spendCaseObservation> & { investigation: string; state: string; rule: unknown };
  expect(observation.investigation).toBe("spend-changes");
  expect(observation.state).toBe("observed");
  expect(observation.rule).toEqual(SPEND_RULE);
  expect(observation.day).toEqual(selected.day);
  expect(observation.decomposition!.changeUsd).toBe(selected.decomposition!.changeUsd);
  // Contributor links belong to the live finding; every number must match.
  const bare = (value: unknown) => JSON.parse(JSON.stringify(value, (key, entry) => (key === "evidence" ? undefined : entry)));
  expect(bare(observation.decomposition)).toEqual(bare(selected.decomposition));
  // The request list is the day's rows; the baseline window lists its own on request.
  expect(evidence.page.total).toBe(5);
  const page2 = buildEvidenceCase(rows, parseCaseIntent(new URLSearchParams({ ...Object.fromEntries(params), offset: "2", limit: "2" })));
  expect(page2.rows).toHaveLength(2);
  expect(page2.observation).toEqual(evidence.observation);
  const prior = buildEvidenceCase(rows, parseCaseIntent(new URLSearchParams({ ...Object.fromEntries(params), period: "prior" })));
  expect(prior.page.total).toBe(14);
  // A project contributor link narrows the selection and keeps the same baseline pairing.
  const lib = selected.decomposition!.cuts.project.groups.concat(selected.decomposition!.cuts.project.new).find(group => group.key === "/synthetic/lib")!;
  const libCase = buildEvidenceCase(rows, parseCaseIntent(new URL(lib.evidence!.href, "http://yald.invalid").searchParams));
  expect(libCase.page.total).toBe(4);
  // A model contributor narrows the cohort instead of adding a selection kind.
  const other = selected.decomposition!.cuts.model.new.concat(selected.decomposition!.cuts.model.groups).find(group => group.label.includes("other"))!;
  const otherIntent = parseCaseIntent(new URL(other.evidence!.href, "http://yald.invalid").searchParams);
  expect(otherIntent.selector.selection).toEqual({ kind: "scope" });
  expect(otherIntent.selector.cohort.models).toEqual(["other"]);
});

test("invalid spend case selectors are rejected like the other cases", () => {
  const rows = series(20, () => 10);
  rows.push(row({ id: "big", ts: noon(18) + 1, cost: 100 }));
  const live = build(rows.sort((a, b) => a.ts - b.ts), 20);
  const params = new URL(live.selected!.evidence!.href, "http://yald.invalid").searchParams;
  const mutate = (patch: (selector: any, prior: any) => void) => {
    const next = new URLSearchParams(params);
    const selector = JSON.parse(next.get("selector")!), prior = JSON.parse(next.get("priorSelector")!);
    patch(selector, prior);
    next.set("selector", JSON.stringify(selector));
    next.set("priorSelector", JSON.stringify(prior));
    return next;
  };
  expect(() => parseCaseIntent(params)).not.toThrow();
  // A window that is not exactly one local day.
  expect(() => parseCaseIntent(mutate(selector => { selector.window.to += 3_600_000; }))).toThrow(EvidenceIntentError);
  // A baseline that does not end where the day starts.
  expect(() => parseCaseIntent(mutate((_, prior) => { prior.window.to -= 1000; }))).toThrow(EvidenceIntentError);
  // A different cohort on the baseline.
  expect(() => parseCaseIntent(mutate((_, prior) => { prior.cohort.models = ["x"]; }))).toThrow(EvidenceIntentError);
  // A missing pair, and an unsupported selection.
  const missing = new URLSearchParams(params);
  missing.delete("priorSelector");
  expect(() => parseCaseIntent(missing)).toThrow(EvidenceIntentError);
  expect(() => parseCaseIntent(mutate((selector, prior) => { selector.selection = prior.selection = { kind: "unnamed" }; }))).toThrow(EvidenceIntentError);
  // Radar's equal-length pairing is untouched: an equal-length pair still works for it and is refused here.
});
