import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { RequestRow } from "../ocx/store";
import type { CacheEconomicsUnavailable, CostEstimateLike } from "../ocx/pricing";
import { ocxPackageDir } from "../env";
import type { CacheEconomicsResponse } from "../../../web/src/types";
import { buildCacheEconomics, CACHE_EXCLUSIONS, cacheEligibility, round6, type CacheEconomicsTotals } from "./cache";

// Pricing state is module-global, so every engine runs in its own child process.
// SYNTHETIC engine: it mirrors the opencodex structure (raw-input long-context test,
// per-field multipliers, response-confirmed priority) with made-up rates. It is a
// fixture, not a price claim, and never replaces the real tier formulas.
const ENGINE = `const RATES = {
  "synthetic/m": { input: 10, output: 40, cacheRead: 1, cacheWrite: 12.5, src: "jawcode", status: "verified" },
  "synthetic/derived": { input: 10, output: 40, cacheRead: 1, cacheWrite: 12.5, src: "jawcode", status: "verified-derived" },
  "synthetic/nowrite": { input: 10, output: 40, cacheRead: 1, cacheWrite: 0, src: "jawcode", status: "verified" },
  "synthetic/noinput": { input: 0, output: 40, cacheRead: 1, cacheWrite: 12.5, src: "jawcode", status: "verified" },
  "synthetic/free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, src: "user", status: "verified" },
  "synthetic/lowerbound": { input: 10, output: 40, cacheRead: 1, cacheWrite: 12.5, src: "jawcode", status: "verified" },
  "synthetic/billable-tier": { input: 10, output: 40, cacheRead: 1, cacheWrite: 12.5, src: "jawcode", status: "verified" },
  "synthetic/cache-only": { input: 10, output: 40, cacheRead: 1, cacheWrite: 12.5, src: "jawcode", status: "verified" },
  "synthetic/notokens": { input: 10, output: 40, cacheRead: 1, cacheWrite: 12.5, src: "jawcode", status: "verified" },
  "anthropic/synthetic-claude": { input: 10, output: 40, cacheRead: 1, cacheWrite: 12.5, src: "jawcode", status: "verified" },
};
const finite = v => typeof v === "number" && Number.isFinite(v) && v >= 0;
export function serviceTierContext(e) { return { responseServiceTier: e.responseServiceTier, requestedServiceTier: e.requestedServiceTier, configuredServiceTier: e.configuredServiceTier }; }
export function estimateRequestCost(input) {
  const u = input.usage; if (!u) return null;
  const write = u.cacheCreationInputTokens ?? 0;
  const read = u.cacheReadInputTokens ?? u.cachedInputTokens ?? 0;
  if (![u.inputTokens, u.outputTokens, read, write].every(finite) || read + write > u.inputTokens) return null;
  const r = RATES[input.provider + "/" + input.model]; if (!r) return null;
  if (input.model === "cache-only" && read + write === 0) return null;
  let c = { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite };
  let contextTier;
  // The real rule tests RAW input; "billable-tier" deliberately does not.
  const tierInput = input.model === "billable-tier" ? u.inputTokens - read - write : u.inputTokens;
  if (tierInput > 200000) { c = { input: c.input * 2, output: c.output * 1.5, cacheRead: c.cacheRead * 2, cacheWrite: c.cacheWrite * 2 }; contextTier = "long"; }
  let priorityMultiplier;
  if (input.serviceTier?.responseServiceTier === "priority") { priorityMultiplier = 2; c = { input: c.input * 2, output: c.output * 2, cacheRead: c.cacheRead * 2, cacheWrite: c.cacheWrite * 2 }; }
  const t = { input: u.inputTokens - read - write, output: u.outputTokens, cacheRead: read, cacheWrite: write };
  const cost = { input: c.input * t.input / 1e6, output: c.output * t.output / 1e6, cacheRead: c.cacheRead * t.cacheRead / 1e6, cacheWrite: c.cacheWrite * t.cacheWrite / 1e6, total: 0 };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return {
    ...(input.model === "notokens" ? {} : { tokens: t }),
    cost, estimated: r.status === "verified-derived",
    price: { provider: input.provider, modelId: input.model, cost4: { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite }, source: r.src, status: r.status },
    ...(contextTier ? { contextTier } : {}), ...(priorityMultiplier ? { priorityMultiplier } : {}),
    ...(input.model === "lowerbound" && priorityMultiplier ? { priorityLowerBound: true } : {}),
  };
}
`;
// Keep complete estimates; remove only the optional tier-provenance helper.
const NO_TIER_HELPER_ENGINE = ENGINE.replace(/^export function serviceTierContext\(e\).*\n/m, "");
// The pre-L04 engine shape used by older fixtures: no normalized tokens, no price source.
const LEGACY_ENGINE = `export function estimateRequestCost(input) {
  const u = input.usage ?? {};
  const read = u.cacheReadInputTokens ?? u.cachedInputTokens ?? 0, write = u.cacheCreationInputTokens ?? 0;
  const cost = { input: (u.inputTokens - read - write) * 10 / 1e6, output: u.outputTokens * 40 / 1e6, cacheRead: read / 1e6, cacheWrite: write * 12.5 / 1e6 };
  return { cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite }, estimated: false, price: { cost4: { input: 10, output: 40, cacheRead: 1, cacheWrite: 12.5 } } };
}
`;

const root = resolve(import.meta.dir, "../../..");
const owned: string[] = [];
const probes: ChildProcessWithoutNullStreams[] = [];
afterAll(async () => {
  for (const child of probes.splice(0)) child.kill();
  await Promise.all(owned.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const T = Date.parse("2026-10-01T00:00:00Z");
type Entry = Record<string, unknown>;
let seq = 0;
function entry(model: string, I: number, O: number, R: number, W: number, extra: Entry = {}): Entry {
  seq++;
  return {
    requestId: `r${seq}`, timestamp: T + seq * 1000, provider: "synthetic", model, inboundProtocol: "responses", conversationId: "c1",
    status: 200, durationMs: 1000, usageStatus: "reported", cacheProvenance: "observed",
    usage: { inputTokens: I, outputTokens: O, cacheReadInputTokens: R, cacheCreationInputTokens: W }, ...extra,
  };
}
const transcriptLine = (requestId: string, sessionId: string, u: Entry, serviceTier = "standard") => ({
  type: "assistant", requestId, sessionId, timestamp: new Date(T + 500).toISOString(), message: { model: "synthetic-claude", usage: { ...u, service_tier: serviceTier } },
});

async function engineDir(source: string, identity?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yald-l04-engine-")); owned.push(dir);
  await mkdir(join(dir, "src/usage"), { recursive: true });
  await writeFile(join(dir, "src/usage/cost.ts"), source);
  if (identity) await writeFile(join(dir, "src/usage/model-identity.ts"), identity);
  return dir;
}

/** Each probe has synthetic homes, even when it loads the installed cost module. */
async function runProbe<T>(pricing: string, body: string, input: unknown = {}): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "yald-l04-probe-")); owned.push(scratch);
  const script = join(scratch, "probe.ts");
  await writeFile(script, `const [root, file] = process.argv.slice(2);
const input = JSON.parse(await Bun.file(file).text());
const { loadPricing, priceEntry, priceWithCacheCounterfactual } = await import(root + "/server/src/ocx/pricing.ts");
const { normalizeRow } = await import(root + "/server/src/ocx/store.ts");
const { toUsageEntry } = await import(root + "/server/src/claude/transcripts.ts");
await loadPricing();
${body}
`);
  const file = join(scratch, "input.json");
  await writeFile(file, JSON.stringify(input));
  const home = join(scratch, "home");
  await mkdir(join(home, "codex"), { recursive: true });
  await mkdir(join(home, "claude"));
  const result = spawnSync(process.execPath, [script, root, file], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, OCX_HOME: home, CODEX_HOME: join(home, "codex"), CLAUDE_PROJECTS_DIR: join(home, "claude"), OCX_PACKAGE_DIR: pricing },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

/** normalizeRow over raw entries (or transcript lines) with an isolated engine. */
async function normalize(engine: string, entries: Entry[], transcripts: Entry[] = []): Promise<RequestRow[]> {
  return runProbe(await engineDir(engine), "console.log(JSON.stringify([...input.entries, ...input.transcripts.map(toUsageEntry)].map(normalizeRow)));", { entries, transcripts });
}

const economics = (row: RequestRow) => {
  const value = row.cacheEconomics;
  if (!value?.available) throw new Error(`no economics for ${row.id}: ${JSON.stringify(value)}`);
  return value;
};
const window = { from: T, to: T + 86_400_000, tz: "UTC", label: "fixture day" };

describe("engine counterfactual: identical workload, cache counters zeroed", () => {
  const cases = {
    positive: entry("m", 100000, 1000, 60000, 10000),
    negative: entry("m", 60000, 0, 2000, 50000),
    zero: entry("m", 30000, 0, 5000, 18000),
    observedZero: entry("m", 10000, 100, 0, 0),
    long: entry("m", 300000, 1000, 200000, 20000),
    atThreshold: entry("m", 200000, 0, 100000, 0),
    overThreshold: entry("m", 200001, 0, 100001, 0),
    requestedPriority: entry("m", 100000, 1000, 60000, 10000, { requestedServiceTier: "priority" }),
    confirmedPriority: entry("m", 100000, 1000, 60000, 10000, { responseServiceTier: "priority", requestedServiceTier: "priority" }),
    longPriority: entry("m", 300000, 1000, 200000, 20000, { responseServiceTier: "priority" }),
    legacyCached: entry("m", 100000, 1000, 0, 0, { usage: { inputTokens: 100000, outputTokens: 1000, cachedInputTokens: 60000, cacheCreationInputTokens: 10000 } }),
  };
  let rows: Record<keyof typeof cases, RequestRow>;
  beforeAll(async () => {
    const keys = Object.keys(cases) as (keyof typeof cases)[];
    const normalized = await normalize(ENGINE, keys.map(key => cases[key]));
    rows = Object.fromEntries(keys.map((key, index) => [key, normalized[index]!])) as typeof rows;
  });

  const expected: Record<string, [read: number, write: number, net: number, baseline: number, actual: number]> = {
    positive: [0.54, 0.025, 0.515, 1.04, 0.525],
    negative: [0.018, 0.125, -0.107, 0.6, 0.707],
    zero: [0.045, 0.045, 0, 0.3, 0.3],
    observedZero: [0, 0, 0, 0.104, 0.104],
    long: [3.6, 0.1, 3.5, 6.06, 2.56],
    atThreshold: [0.9, 0, 0.9, 2, 1.1],
    overThreshold: [1.800018, 0, 1.800018, 4.00002, 2.200002],
    requestedPriority: [0.54, 0.025, 0.515, 1.04, 0.525],
    confirmedPriority: [1.08, 0.05, 1.03, 2.08, 1.05],
    longPriority: [7.2, 0.2, 7, 12.12, 5.12],
    legacyCached: [0.54, 0.025, 0.515, 1.04, 0.525],
  };
  test.each(Object.keys(expected))("%s: discount − premium = net = baseline − actual at 6 dp", key => {
    const row = rows[key as keyof typeof cases];
    const value = economics(row);
    const [read, write, net, baseline, actual] = expected[key]!;
    expect(round6(value.readDiscountUsd)).toBe(read);
    expect(round6(value.writePremiumUsd)).toBe(write);
    expect(round6(round6(value.readDiscountUsd) - round6(value.writePremiumUsd))).toBe(net);
    expect(round6(value.baselineUsd)).toBe(baseline);
    expect(round6(value.actualUsd)).toBe(actual);
    // Identical workload: output cancels, so the engine totals reconcile with the decomposition.
    expect(Math.abs((value.baselineUsd - value.actualUsd) - (value.readDiscountUsd - value.writePremiumUsd))).toBeLessThan(1e-9);
    expect(value.actualUsd).toBe(row.cost);
    expect(value.inputTokens).toBe(row.inputTokens);
    expect(cacheEligibility(row)).toEqual({ eligible: true });
  });

  test("long context is decided on raw input for both sides, so effective rates (not base rate*) price the net", () => {
    const value = economics(rows.long);
    expect(rows.long.contextTier).toBe("long");
    expect(value.contextTier).toBe("long");
    expect(value.rates).toEqual({ input: 20, cacheRead: 2, cacheWrite: 25 });
    // The issue formula over the row's base list rates misses the tier and halves the answer.
    const r = rows.long;
    expect(round6((r.cacheReadTokens * (r.rateIn! - r.rateCacheRead!) - r.cacheWriteTokens * (r.rateCacheWrite! - r.rateIn!)) / 1e6)).toBe(1.75);
    expect(economics(rows.atThreshold).contextTier).toBeNull();
    expect(economics(rows.overThreshold).contextTier).toBe("long");
  });

  test("requested-only priority is not priced as priority; a response-confirmed tier is, on both sides", () => {
    expect(economics(rows.requestedPriority)).toMatchObject({ priorityMultiplier: null, serviceTier: { response: null, requested: "priority", configured: null } });
    expect(economics(rows.confirmedPriority)).toMatchObject({ priorityMultiplier: 2, serviceTier: { response: "priority", requested: "priority" }, rates: { input: 20 } });
    expect(economics(rows.longPriority)).toMatchObject({ priorityMultiplier: 2, contextTier: "long", rates: { input: 40 } });
  });

  test("observed zero is an eligible zero, with no baseline call needed", () => {
    expect(rows.observedZero.measurements).toMatchObject({ cacheRead: true, cacheWrite: true });
    expect(economics(rows.observedZero)).toMatchObject({ readTokens: 0, writeTokens: 0, readDiscountUsd: 0, writePremiumUsd: 0 });
  });
});

test("actual and baseline reuse one exact price-options/tier snapshot; zero-cache, attempts and priceEntry price only once", async () => {
  const instrumented = ENGINE.replace("export function serviceTierContext(e)", "function tierCore(e)")
    .replace("export function estimateRequestCost(input)", "function estimateCore(input)") + `
let optionsCalls = 0, tierCalls = 0, calls = [];
export function usageModelPriceOptions(e, fallback) {
  if (e !== fallback) throw new Error("changed pricing target");
  optionsCalls++;
  return { allowModelLevelFallback: false, priceSnapshot: { revision: optionsCalls } };
}
export function serviceTierContext(e) {
  tierCalls++;
  return e.tierOutcome?.confirmation === "confirmed"
    ? { responseServiceTier: "priority", tierOutcome: e.tierOutcome } : tierCore(e);
}
export function estimateRequestCost(input) { calls.push(input); return estimateCore(input); }
export function resetAudit() { optionsCalls = 0; tierCalls = 0; calls = []; }
export function audit() {
  return { optionsCalls, tierCalls, estimates: calls.length,
    sameOptions: calls.every(c => c.priceSnapshot === calls[0].priceSnapshot),
    sameTier: calls.every(c => c.serviceTier === calls[0].serviceTier),
    revisions: calls.map(c => c.priceSnapshot.revision),
    fallback: calls.map(c => c.allowModelLevelFallback),
    usage: calls.map(c => ({ input: c.usage.inputTokens, output: c.usage.outputTokens,
      read: c.usage.cacheReadInputTokens, write: c.usage.cacheCreationInputTokens,
      hasLegacyRead: Object.hasOwn(c.usage, "cachedInputTokens") })),
  };
}
`;
  const pricing = await engineDir(instrumented, 'export { usageModelPriceOptions } from "./cost";');
  const raw = entry("m", 300000, 1000, 200000, 20000, {
    responseServiceTier: "default", tierOutcome: { canonical: "priority", confirmation: "confirmed" },
    prompt: "synthetic-content-never-retained",
    usage: { inputTokens: 300000, outputTokens: 1000, cacheReadInputTokens: 200000, cachedInputTokens: 200000, cacheCreationInputTokens: 20000 },
  });
  const result = await runProbe<any>(pricing, `
const engine = await import(process.env.OCX_PACKAGE_DIR + "/src/usage/cost.ts");
const before = JSON.stringify(input);
const row = normalizeRow(input);
const pair = engine.audit();
engine.resetAudit();
normalizeRow({ ...input, usage: { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
const zero = engine.audit();
engine.resetAudit();
const attempt = normalizeRow({ ...input, usage: undefined, attempts: [{ usage: input.usage }] });
const attempts = engine.audit();
engine.resetAudit();
const direct = priceEntry(input);
console.log(JSON.stringify({ row, pair, zero, attempts, attemptCache: attempt.cacheEconomics,
  direct: engine.audit(), sameActual: JSON.stringify(direct) === JSON.stringify(priceWithCacheCounterfactual(input, false).estimate),
  unchanged: before === JSON.stringify(input) }));
`, raw);
  expect(result.pair).toEqual({ optionsCalls: 1, tierCalls: 1, estimates: 2, sameOptions: true, sameTier: true,
    revisions: [1, 1], fallback: [false, false], usage: [
      { input: 300000, output: 1000, read: 200000, write: 20000, hasLegacyRead: true },
      { input: 300000, output: 1000, read: 0, write: 0, hasLegacyRead: false },
    ] });
  expect(economics(result.row)).toMatchObject({ priorityMultiplier: 2, contextTier: "long",
    readDiscountUsd: 7.2, serviceTier: { response: "priority", requested: null, configured: null } });
  for (const audit of [result.zero, result.attempts, result.direct]) {
    expect(audit).toMatchObject({ optionsCalls: 1, tierCalls: 1, estimates: 1 });
  }
  expect(result.attemptCache).toBeNull();
  expect(result.unchanged).toBe(true);
  expect(result.sameActual).toBe(true);
  expect(JSON.stringify(result.row)).not.toContain("synthetic-content-never-retained");
  expect(JSON.stringify(result.row.cacheEconomics)).not.toContain("tierOutcome");
});

test("a missing tier helper excludes recorded provenance without changing actual pricing", async () => {
  const confirmedOutcome = { canonical: "priority", confirmation: "confirmed", responseTierAuthoritative: true };
  const recorded = [
    { responseServiceTier: "priority" },
    { requestedServiceTier: "priority" },
    { configuredServiceTier: "priority" },
    { responseServiceTier: "default" },
    { tierOutcome: confirmedOutcome },
    { responseServiceTier: "default", tierOutcome: confirmedOutcome },
  ];
  const raw = recorded.map(tier => entry("m", 100000, 1000, 60000, 10000, tier));
  raw.push(entry("m", 10000, 100, 0, 0, { responseServiceTier: "priority" }));
  const result = await runProbe<{ row: RequestRow; direct: CostEstimateLike; actualOnly: { estimate: CostEstimateLike; cache: null } }[]>(
    await engineDir(NO_TIER_HELPER_ENGINE), `console.log(JSON.stringify(input.map(raw => ({
      row: normalizeRow(raw), direct: priceEntry(raw), actualOnly: priceWithCacheCounterfactual(raw, false),
    }))));`, raw,
  );
  for (const { row, direct, actualOnly } of result) {
    expect(row.priced).toBe(true);
    expect(row.cost).toBe(direct.cost.total);
    expect(actualOnly).toEqual({ estimate: direct, cache: null });
    expect(row.cacheEconomics).toEqual({ available: false, reason: "tier-context-unavailable" });
    expect(cacheEligibility(row)).toEqual({ eligible: false, reason: "economics-unavailable" });
  }
  // Keep the existing actual estimate even though it cannot support a tier-faithful comparison.
  expect(round6(result[0]!.row.cost)).toBe(0.525);
  expect(result[0]!.direct.priorityMultiplier).toBeUndefined();
  expect(buildCacheEconomics(result.map(value => value.row), {}, window).totals).toMatchObject({
    totalRequests: raw.length, eligibleRequests: 0, excluded: { "economics-unavailable": raw.length },
    readTokens: 0, writeTokens: 0, readDiscountUsd: 0, writePremiumUsd: 0, netUsd: 0,
    actualUsd: 0, baselineUsd: 0, confirmedTierRequests: 0, priorityRequests: 0, direction: "insufficient",
  });
});

test("a missing tier helper still supports complete comparisons with no recorded tier provenance", async () => {
  const rows = await normalize(NO_TIER_HELPER_ENGINE, [
    entry("m", 100000, 1000, 60000, 10000),
    entry("m", 10000, 100, 0, 0, { responseServiceTier: null, requestedServiceTier: null, configuredServiceTier: null, tierOutcome: null }),
  ]);
  expect(economics(rows[0]!)).toMatchObject({ baselineUsd: 1.04,
    serviceTier: { response: null, requested: null, configured: null } });
  expect(round6(economics(rows[0]!).actualUsd)).toBe(0.525);
  expect(economics(rows[1]!)).toMatchObject({ readDiscountUsd: 0, writePremiumUsd: 0 });
  expect(round6(economics(rows[1]!).actualUsd)).toBe(0.104);
  expect(economics(rows[1]!).baselineUsd).toBe(economics(rows[1]!).actualUsd);
  for (const row of rows) expect(cacheEligibility(row)).toEqual({ eligible: true });
  expect(buildCacheEconomics(rows, {}, window).totals).toMatchObject({ eligibleRequests: 2, netUsd: 0.515 });
});

describe("incomplete or inconsistent engine results fail closed", () => {
  const cases: [string, string, CacheEconomicsUnavailable][] = [
    ["missing actual price source", 'delete value.price.source;', "engine-incomplete"],
    ["negative normalized tokens", 'value.tokens.cacheRead = -1;', "engine-incomplete"],
    ["non-finite priority multiplier", 'value.priorityMultiplier = Infinity;', "engine-incomplete"],
    ["overflowing effective rate", 'if (!baseline) { value.cost.cacheRead = 1e308; value.cost.total = 1e308; }', "engine-incomplete"],
    ["missing baseline cost class", 'if (baseline) delete value.cost.output;', "engine-incomplete"],
    ["non-finite baseline cost", 'if (baseline) value.cost.cacheWrite = Infinity;', "engine-incomplete"],
    ["missing baseline price status", 'if (baseline) delete value.price.status;', "engine-incomplete"],
    ["changed baseline token split", 'if (baseline) value.tokens.input++;', "baseline-mismatch"],
    ["charged baseline cache class", 'if (baseline) value.cost.cacheRead = 1;', "baseline-mismatch"],
    ["changed output cost", 'if (baseline) { value.cost.output += 1; value.cost.total += 1; }', "baseline-mismatch"],
    ["changed priority confirmation", 'if (baseline) value.priorityMultiplier = 2;', "tier-mismatch"],
    ["changed lower-bound flag", 'if (baseline) value.priorityLowerBound = true;', "tier-mismatch"],
    ["changed price provenance", 'if (baseline) value.price.source = "user";', "tier-mismatch"],
    ["changed effective input rate", 'if (baseline) { const delta = value.cost.input * 1e-8; value.cost.input += delta; value.cost.total += delta; }', "tier-mismatch"],
    ["baseline throws", 'if (baseline) throw new Error("synthetic baseline failure");', "baseline-unpriced"],
  ];
  test.each(cases)("%s", async (_name, mutation, reason) => {
    const broken = ENGINE.replace("export function estimateRequestCost(input)", "function estimateCore(input)") + `
export function estimateRequestCost(input) {
  const value = estimateCore(input);
  const baseline = input.usage.cacheReadInputTokens === 0;
  ${mutation}
  return value;
}
`;
    const [row] = await normalize(broken, [entry("m", 100000, 1000, 60000, 10000)]);
    expect(row!.priced).toBe(true);
    expect(row!.cacheEconomics).toEqual({ available: false, reason });
    expect(cacheEligibility(row!)).toEqual({ eligible: false, reason: "economics-unavailable" });
  });
});

describe("eligibility and coverage", () => {
  const named = {
    positive: entry("m", 100000, 1000, 60000, 10000),
    observedZero: entry("m", 10000, 100, 0, 0),
    synthesized: entry("m", 10000, 100, 0, 0, { cacheProvenance: "synthesized" }),
    unknownProvenance: entry("m", 10000, 100, 0, 0, { cacheProvenance: undefined }),
    unmeasured: entry("m", 10000, 100, 0, 0, { usage: { inputTokens: 10000, outputTokens: 100, cacheReadInputTokens: 0 } }),
    attemptSum: entry("m", 0, 0, 0, 0, { usage: undefined, attempts: [{ usage: { inputTokens: 100000, outputTokens: 1000, cacheReadInputTokens: 60000, cacheCreationInputTokens: 10000 } }] }),
    estimated: entry("m", 100000, 1000, 60000, 10000, { usageStatus: "estimated" }),
    unknownModel: entry("nope", 100000, 0, 60000, 10000),
    overCounted: entry("m", 1000, 0, 800, 800),
    zeroWriteRate: entry("nowrite", 100000, 0, 60000, 10000),
    zeroInputRate: entry("noinput", 100000, 0, 60000, 10000),
    free: entry("free", 100000, 0, 60000, 10000),
    derived: entry("derived", 100000, 1000, 60000, 10000),
    lowerBound: entry("lowerbound", 100000, 1000, 60000, 10000, { responseServiceTier: "priority" }),
    writeIgnored: entry("m", 100000, 0, 0, 0, { usage: { inputTokens: 100000, outputTokens: 0, cacheReadInputTokens: 60000, cacheWriteInputTokens: 10000 } }),
    tierShift: entry("billable-tier", 260000, 0, 100000, 0),
    baselineNull: entry("cache-only", 100000, 0, 60000, 10000),
    noTokens: entry("notokens", 100000, 0, 60000, 10000),
    unnamed: entry("m", 60000, 0, 2000, 50000, { conversationId: undefined }),
  };
  let rows: Record<keyof typeof named, RequestRow>;
  let all: RequestRow[];
  beforeAll(async () => {
    const keys = Object.keys(named) as (keyof typeof named)[];
    // Two sources share conversation "c1"; the transcript row reports its own tier string.
    const normalized = await normalize(ENGINE, keys.map(key => named[key]), [
      transcriptLine("claude-1", "c1", { input_tokens: 30000, output_tokens: 1000, cache_read_input_tokens: 60000, cache_creation_input_tokens: 10000 }),
    ]);
    rows = Object.fromEntries(keys.map((key, index) => [key, normalized[index]!])) as typeof rows;
    all = normalized;
  });
  const reason = (row: RequestRow) => { const verdict = cacheEligibility(row); return verdict.eligible ? "eligible" : verdict.reason; };

  test("each exclusion has its own reason; observed zero, explicit free, derived and lower-bound stay eligible", () => {
    expect(Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, reason(row)]))).toEqual({
      positive: "eligible", observedZero: "eligible", synthesized: "cache-synthesized", unknownProvenance: "cache-unknown",
      unmeasured: "cache-unmeasured", attemptSum: "attempt-sum", estimated: "usage-estimated", unknownModel: "unpriced",
      overCounted: "unpriced", zeroWriteRate: "rate-unavailable", zeroInputRate: "rate-unavailable", free: "eligible",
      derived: "eligible", lowerBound: "eligible", writeIgnored: "accounting-mismatch", tierShift: "economics-unavailable",
      baselineNull: "economics-unavailable", noTokens: "economics-unavailable", unnamed: "eligible",
    });
    expect(reason({ ...rows.positive, measurements: { ...rows.positive.measurements, input: false } })).toBe("input-missing");
    expect(rows.unknownModel).toMatchObject({ priced: false, cost: 0, cacheEconomics: null });
    expect(rows.attemptSum.cacheEconomics).toBeNull();
    expect(rows.tierShift.cacheEconomics).toEqual({ available: false, reason: "tier-mismatch" });
    expect(rows.baselineNull.cacheEconomics).toEqual({ available: false, reason: "baseline-unpriced" });
    expect(rows.noTokens.cacheEconomics).toEqual({ available: false, reason: "engine-incomplete" });
    // Missing (unpublished) versus explicit (user overlay) zero rates.
    expect(economics(rows.zeroWriteRate).zeroRate).toEqual({ input: false, cacheRead: false, cacheWrite: true });
    expect(economics(rows.zeroInputRate).zeroRate).toEqual({ input: true, cacheRead: false, cacheWrite: false });
    expect(economics(rows.free)).toMatchObject({ explicitFree: true, zeroRate: { input: false, cacheRead: false, cacheWrite: false }, readDiscountUsd: 0, writePremiumUsd: 0 });
    expect(economics(rows.derived)).toMatchObject({ derivedRate: true, rateStatus: "verified-derived" });
    expect(economics(rows.lowerBound)).toMatchObject({ priorityLowerBound: true, priorityMultiplier: 2 });
  });

  test("scope, sessions and unnamed rows partition the accounting; no fabricated conversation", () => {
    const result = buildCacheEconomics(all, { from: window.from, to: window.to }, window);
    const check = (totals: CacheEconomicsTotals) => {
      expect(totals.eligibleRequests + Object.values(totals.excluded).reduce((a, b) => a + b, 0)).toBe(totals.totalRequests);
      expect(Object.keys(totals.excluded).sort()).toEqual([...CACHE_EXCLUSIONS].sort());
      expect(totals.netUsd).toBe(round6(totals.readDiscountUsd - totals.writePremiumUsd));
    };
    check(result.totals);
    check(result.unnamed);
    result.sessions.forEach(check);

    expect(result.totals.totalRequests).toBe(all.length);
    expect(result.sessions.map(s => s.key)).toEqual([JSON.stringify(["ocx", "c1"]), JSON.stringify(["claude-code", "c1"])]);
    expect(result.sessionCount).toBe(2);
    const sum = (key: "totalRequests" | "eligibleRequests") => result.sessions.reduce((a, s) => a + s[key], 0) + result.unnamed[key];
    expect(sum("totalRequests")).toBe(result.totals.totalRequests);
    expect(sum("eligibleRequests")).toBe(result.totals.eligibleRequests);
    expect(result.unnamed).toMatchObject({ totalRequests: 1, eligibleRequests: 1, netUsd: -0.107, direction: "cost" });
    expect(result.unnamed.evidence.selector.selection).toEqual({ kind: "unnamed" });

    // ocx c1 eligible: positive 0.515 + observed zero 0 + free 0 + derived 0.515 + lower-bound 1.03.
    const ocx = result.sessions.find(s => s.source === "ocx")!;
    expect(ocx).toMatchObject({ eligibleRequests: 5, readDiscountUsd: 2.16, writePremiumUsd: 0.1, netUsd: 2.06, direction: "benefit",
      derivedRateRequests: 1, lowerBoundRequests: 1, priorityRequests: 1, explicitFreeRequests: 1, confirmedTierRequests: 1 });
    expect(ocx.excluded).toMatchObject({ "cache-synthesized": 1, "cache-unknown": 1, "cache-unmeasured": 1, "attempt-sum": 1, "usage-estimated": 1,
      unpriced: 2, "rate-unavailable": 2, "accounting-mismatch": 1, "economics-unavailable": 3 });
    const claude = result.sessions.find(s => s.source === "claude-code")!;
    expect(claude).toMatchObject({ conversationId: "c1", eligibleRequests: 1, netUsd: 0.515, confirmedTierRequests: 1 });
    expect(claude.evidence.selector.selection).toEqual({ kind: "session", source: "claude-code", conversationId: "c1" });
    expect(result.totals).toMatchObject({ eligibleRequests: 7, netUsd: round6(2.06 + 0.515 - 0.107) });
  });

  test("the response echoes the fixed window, cohort and cache evidence selectors", () => {
    const filter = { from: window.from, to: window.to, sources: ["ocx" as const], models: ["m"] };
    // Compile-time contract check: the server result must satisfy the consumer's response shape.
    const result: Omit<CacheEconomicsResponse, "window" | "pricing"> = buildCacheEconomics(all, filter, window, { limit: 0 });
    expect(result.scope.window).toMatchObject({ from: window.from, to: window.to, tz: "UTC", halfOpen: true });
    expect(result.scope.cohort).toMatchObject({ sources: ["ocx"], models: ["m"] });
    expect(result.totals.evidence.selector).toMatchObject({ version: 1, eligibility: "cache", selection: { kind: "scope" }, window });
    const params = new URLSearchParams(result.totals.evidence.href.split("?")[1]);
    expect(Object.fromEntries(params)).toMatchObject({ from: String(window.from), to: String(window.to), tz: "UTC", kind: "scope", eligibility: "cache" });
    expect(JSON.parse(params.get("selector")!)).toEqual(result.totals.evidence.selector);
    expect(result).toMatchObject({ precisionDp: 6, currency: "USD", sessions: [], sessionCount: 1, sessionsTruncated: true });
    // Excluded rows are counted but never contribute dollars.
    expect(buildCacheEconomics(all, { ...filter, models: ["nowrite"] }, window).totals).toMatchObject({ eligibleRequests: 0, netUsd: 0, direction: "insufficient", excluded: { "rate-unavailable": 1 } });
  });

  test("outcomes do not erase observed charged usage, and exclusions use first-match ordering", () => {
    for (const extra of [{ status: 502, ok: false }, { status: 499, ok: false, closeReason: "client_closed" },
      { measurements: { ...rows.positive.measurements, outcome: false } }]) {
      expect(cacheEligibility({ ...rows.positive, ...extra })).toEqual({ eligible: true });
    }
    expect(cacheEligibility({ ...rows.synthesized, priced: false })).toEqual({ eligible: false, reason: "unpriced" });
    expect(cacheEligibility({ ...rows.estimated, measurements: { ...rows.estimated.measurements, input: false } }))
      .toEqual({ eligible: false, reason: "usage-estimated" });
    expect(cacheEligibility({ ...rows.positive, inputTokens: rows.positive.inputTokens + 1 }))
      .toEqual({ eligible: false, reason: "accounting-mismatch" });
    expect(cacheEligibility({ ...rows.positive, cacheEconomics: undefined }))
      .toEqual({ eligible: false, reason: "economics-unavailable" });
  });
});

test("round once after accumulation, reconcile at six decimals, and distinguish empty from observed even", async () => {
  const rows = await normalize(ENGINE, [entry("m", 13, 1, 1, 1), entry("m", 13, 1, 0, 1),
    entry("nowrite", 10000, 0, 1000, 0), entry("noinput", 10000, 100, 0, 0)]);
  const result = buildCacheEconomics(rows.slice(0, 2), {}, window);
  // Two unrounded 0.0000025 write premiums sum to 0.000005, not 0.000006.
  expect(result.totals).toMatchObject({ readDiscountUsd: 0.000009, writePremiumUsd: 0.000005,
    netUsd: 0.000004, actualUsd: 0.000336, baselineUsd: 0.00034, eligibleRequests: 2 });
  expect(result.totals.netUsd).toBe(round6(result.totals.baselineUsd - result.totals.actualUsd));
  expect(cacheEligibility(rows[2]!)).toEqual({ eligible: true }); // Unused zero write rate is irrelevant.
  expect(cacheEligibility(rows[3]!)).toEqual({ eligible: true }); // No-cache workload needs no hypothetical input rate.
  expect(buildCacheEconomics([rows[3]!], {}, window).totals.direction).toBe("even");
  expect(buildCacheEconomics([], {}, window).totals).toMatchObject({ totalRequests: 0, eligibleRequests: 0,
    direction: "insufficient", firstTs: null, lastTs: null, actualUsd: 0, baselineUsd: 0 });
  expect(round6(0.0000005)).toBe(0.000001);
  expect(round6(-0.0000005)).toBe(-0.000001);
  expect(round6(0.0410025)).toBe(0.041003);
  expect(round6(-0.0410025)).toBe(-0.041003);
  expect(round6(0)).toBe(0);
  expect(Object.is(round6(-0.0000001), -0)).toBe(false);
});

const installedPricing = ocxPackageDir();
test.skipIf(!installedPricing)("installed engine: synthetic workloads preserve raw-input tiers, tier outcomes and price identities", async () => {
  const entries = [
    entry("gpt-5.6-sol", 272000, 1000, 200000, 20000, { provider: "openai-apikey" }),
    entry("gpt-5.6-sol", 272001, 1000, 200000, 20000, { provider: "openai-apikey" }),
    entry("gpt-5.6-sol", 300000, 1000, 200000, 20000, { provider: "openai-apikey", responseServiceTier: "priority" }),
    entry("claude-opus-5-5", 100000, 1000, 60000, 10000, { provider: "anthropic", requestedServiceTier: "priority" }),
    entry("claude-opus-5-5", 100000, 1000, 60000, 10000, { provider: "anthropic", responseServiceTier: "priority" }),
    entry("grok-4.6", 300000, 1000, 200000, 20000, { provider: "xai", responseServiceTier: "priority" }),
    entry("claude-opus-5-5", 100000, 1000, 60000, 10000, { provider: "anthropic", responseServiceTier: "default",
      tierOutcome: { canonical: "priority", confirmation: "confirmed", responseTierAuthoritative: true } }),
  ];
  const rows = await runProbe<RequestRow[]>(installedPricing!, "console.log(JSON.stringify(input.map(normalizeRow)));", entries);
  for (const row of rows) {
    const value = economics(row);
    expect(value.inputTokens).toBe(row.inputTokens);
    expect(value.actualUsd).toBe(row.cost);
    expect(value.readDiscountUsd - value.writePremiumUsd).toBeCloseTo(value.baselineUsd - value.actualUsd, 10);
    expect(value.rates.input).not.toBeNull();
    expect(round6((value.readTokens * (value.rates.input! - value.rates.cacheRead!)
      - value.writeTokens * (value.rates.cacheWrite! - value.rates.input!)) / 1e6))
      .toBe(round6(value.baselineUsd - value.actualUsd));
  }
  expect(economics(rows[0]!).contextTier).toBeNull();
  expect(economics(rows[1]!).contextTier).toBe("long");
  expect(economics(rows[2]!)).toMatchObject({ contextTier: "long", priorityMultiplier: 2 });
  expect(economics(rows[3]!).priorityMultiplier).toBeNull();
  expect(economics(rows[4]!).priorityMultiplier).toBe(2);
  expect(economics(rows[5]!).priorityLowerBound).toBe(true);
  expect(cacheEligibility(rows[5]!)).toEqual({ eligible: false, reason: "rate-unavailable" }); // Unpublished write rate.
  expect(economics(rows[6]!)).toMatchObject({ priorityMultiplier: 2, serviceTier: { response: "priority" } });
});

describe("GET /api/labs/cache", () => {
  async function serve(engine: string, entries: Entry[], transcripts: Entry[] = []) {
    const pricing = await engineDir(engine);
    const home = join(pricing, "home"), claude = join(home, "claude");
    await mkdir(join(claude, "project"), { recursive: true }); await mkdir(join(home, "codex"));
    await writeFile(join(home, "usage.jsonl"), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
    if (transcripts.length) await writeFile(join(claude, "project", "session.jsonl"), transcripts.map(e => JSON.stringify(e)).join("\n") + "\n");
    const child = spawn(process.execPath, [join(root, "tests/helpers/store-probe.ts"), root], {
      cwd: root, stdio: "pipe",
      env: { ...process.env, OCX_HOME: home, CODEX_HOME: join(home, "codex"), CLAUDE_PROJECTS_DIR: claude, OCX_PACKAGE_DIR: pricing, YALD_TEST_PRICING_GENERATION: "", YALD_TEST_NOW: String(T + 86_400_000), TZ: "UTC", YALD_TZ: "UTC" },
    });
    probes.push(child);
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const next = async () => { const line = await lines.next(); if (line.done) throw new Error(`probe exited: ${stderr}`); return JSON.parse(line.value); };
    expect(await next()).toEqual({ ready: true });
    return async (path: string) => {
      child.stdin.write(JSON.stringify({ op: "api", paths: [path] }) + "\n");
      const reply = await next();
      if (reply.error) throw new Error(reply.error);
      return reply.result[0] as { status: number; body: any };
    };
  }
  const from = T, to = T + 86_400_000;

  test("returns scoped totals, source-qualified sessions, the unnamed bucket and pricing state", async () => {
    const request = await serve(ENGINE, [entry("m", 100000, 1000, 60000, 10000), entry("m", 60000, 0, 2000, 50000, { conversationId: undefined }), entry("m", 10000, 100, 0, 0, { cacheProvenance: "synthesized" })],
      [transcriptLine("claude-api", "c1", { input_tokens: 30000, output_tokens: 1000, cache_read_input_tokens: 60000, cache_creation_input_tokens: 10000 })]);
    const { status, body } = await request(`/api/labs/cache?from=${from}&to=${to}&tz=UTC`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true, analysis: "cache-economics", version: 1, precisionDp: 6, pricing: { available: true },
      window: { from, to, tz: "UTC", halfOpen: true },
      totals: { totalRequests: 4, eligibleRequests: 3, netUsd: round6(0.515 + 0.515 - 0.107), excluded: { "cache-synthesized": 1 } },
      unnamed: { totalRequests: 1, netUsd: -0.107 },
      sessionCount: 2,
    });
    expect(body.sessions.map((s: { key: string }) => s.key).sort()).toEqual([JSON.stringify(["claude-code", "c1"]), JSON.stringify(["ocx", "c1"])]);
    expect(body.totals.evidence.href).toContain("eligibility=cache");
    const scoped = await request(`/api/labs/cache?from=${from}&to=${to}&tz=UTC&sources=claude-code`);
    expect(scoped.body.totals).toMatchObject({ totalRequests: 1, eligibleRequests: 1, netUsd: 0.515 });
    expect(scoped.body.scope.cohort.sources).toEqual(["claude-code"]);
    expect((await request(`/api/labs/cache?from=nope`)).status).toBe(400);
  });

  test("an engine without normalized tokens or price provenance is unavailable, never priced from base rates", async () => {
    const request = await serve(LEGACY_ENGINE, [entry("m", 100000, 1000, 60000, 10000)]);
    const { body } = await request(`/api/labs/cache?from=${from}&to=${to}&tz=UTC`);
    expect(body.totals).toMatchObject({ totalRequests: 1, eligibleRequests: 0, netUsd: 0, direction: "insufficient", excluded: { "economics-unavailable": 1 } });
  });

  test("complete estimates without the tier helper cannot price recorded priority cache economics", async () => {
    const request = await serve(NO_TIER_HELPER_ENGINE, [entry("m", 100000, 1000, 60000, 10000, { responseServiceTier: "priority" })]);
    const { status, body } = await request(`/api/labs/cache?from=${from}&to=${to}&tz=UTC`);
    expect(status).toBe(200);
    expect(body.pricing.available).toBe(true);
    for (const totals of [body.totals, body.sessions[0]]) expect(totals).toMatchObject({
      totalRequests: 1, eligibleRequests: 0, netUsd: 0, actualUsd: 0, baselineUsd: 0,
      direction: "insufficient", excluded: { "economics-unavailable": 1 },
    });
  });

  test("window bounds, every cohort filter, project coverage and evidence stay aligned; session limits leave totals intact", async () => {
    const common = { effectiveEffort: "high", routeDecision: { routeKind: "native" }, requestId: "cohort-match", timestamp: from, cwd: "/synthetic/l04/app/server" };
    const request = await serve(ENGINE, [
      entry("m", 100000, 1000, 60000, 10000, common),
      entry("m", 100000, 1000, 60000, 10000, { ...common, cwd: "/synthetic/l04/other" }),
      entry("m", 100000, 1000, 60000, 10000, { ...common, cwd: undefined }),
      entry("m", 100000, 1000, 60000, 10000, { ...common, timestamp: to }),
      entry("m", 100000, 1000, 60000, 10000, { ...common, effectiveEffort: "low" }),
      entry("m", 100000, 1000, 60000, 10000, { ...common, routeDecision: { routeKind: "explicit-provider" } }),
      entry("m", 100000, 1000, 60000, 10000, { ...common, status: 502 }),
      entry("m", 100000, 1000, 60000, 10000, { ...common, conversationId: "other" }),
      entry("m", 100000, 1000, 60000, 10000, { ...common, requestId: "not-matching-search" }),
    ]);
    const params = new URLSearchParams({ from: String(from), to: String(to), tz: "Asia/Singapore", sources: "ocx", projects: "/synthetic/l04/app",
      providers: "synthetic", models: "m", efforts: "high", routeKinds: "native", statuses: "ok", conversationId: "c1", search: "cohort-match", limit: "0" });
    const { body } = await request(`/api/labs/cache?${params}`);
    expect(body.totals).toMatchObject({ totalRequests: 1, eligibleRequests: 1, netUsd: 0.515, firstTs: from, lastTs: from });
    expect(body.coverage.attribution).toMatchObject({ matched: { rows: 1 }, outsideProjects: { rows: 1 }, unattributed: { rows: 1 } });
    expect(body.scope.cohort).toEqual({ sources: ["ocx"], projects: ["/synthetic/l04/app"], providers: ["synthetic"], models: ["m"],
      efforts: ["high"], routeKinds: ["native"], statuses: ["ok"], conversationId: "c1", search: "cohort-match" });
    expect(body.totals.evidence.selector.cohort).toEqual(body.scope.cohort);
    const href = new URL(body.totals.evidence.href, "http://fixture.invalid");
    expect(JSON.parse(href.searchParams.get("selector")!)).toEqual(body.totals.evidence.selector);
    expect(Object.fromEntries(href.searchParams)).toMatchObject({ from: String(from), to: String(to), tz: "Asia/Singapore" });
    expect(href.searchParams.get("eligibility")).toBe("cache");
    expect(href.searchParams.has("range")).toBe(false);
    expect(body).toMatchObject({ sessions: [], sessionCount: 1, sessionsTruncated: true });
    params.set("limit", "1.9");
    const limited = await request(`/api/labs/cache?${params}`);
    expect(limited.body.sessions).toHaveLength(1);
    expect(limited.body.totals).toEqual(body.totals);
    expect(limited.body.sessions[0].evidence.selector.selection).toEqual({ kind: "session", source: "ocx", conversationId: "c1" });
    params.set("sources", "invalid");
    expect((await request(`/api/labs/cache?${params}`)).status).toBe(400);
    params.set("sources", "ocx");
    params.set("models", "absent");
    expect((await request(`/api/labs/cache?${params}`)).body.totals).toMatchObject({ totalRequests: 0, eligibleRequests: 0, direction: "insufficient" });
  });
});
