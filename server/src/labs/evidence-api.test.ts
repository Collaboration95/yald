import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { EVIDENCE_FROM, EVIDENCE_TO, EVIDENCE_PARAMS, EVIDENCE_SESSION, materializeEvidenceFixture } from "../../../web/scripts/evidence-fixtures";
import type { EvidenceCaseResponse } from "./evidence";
import type { CaseIntent, CaseSelector } from "./evidence-intent";
import type { Dataset } from "../ocx/store";

// A separate process loads the real store/API only after all synthetic homes and prices exist.
const root = resolve(import.meta.dir, "../../..");
let fixture: Awaited<ReturnType<typeof materializeEvidenceFixture>>;
let child: ChildProcessWithoutNullStreams, lines: AsyncIterator<string>, stderr = "";
let dataset: Dataset;
let helpers: typeof import("./evidence");
let cache: typeof import("./cache");
let radar: typeof import("./projects");
let scope: typeof import("./scope");
let source: typeof import("../report/source");
async function command(input: object): Promise<any> {
  child.stdin.write(JSON.stringify(input) + "\n");
  const reply = await lines.next();
  if (reply.done) throw new Error(`evidence fixture exited: ${stderr}`);
  const value = JSON.parse(reply.value);
  if (value.error) throw new Error(value.error);
  return value.result;
}
async function request(path: string, etag?: string): Promise<{ status: number; etag: string; body: any }> {
  return (await command({ op: "api", paths: [path], etag }))[0];
}
function params(evidence: { href: string }, investigation: CaseIntent["investigation"], extra: Record<string, string> = {}) {
  const result = new URL(evidence.href, "http://localhost").searchParams;
  result.set("investigation", investigation);
  for (const [key, value] of Object.entries(extra)) result.set(key, value);
  return result;
}
const pathFor = (params: URLSearchParams) => `/api/labs/evidence?${params}`;
const evidence = async (query: URLSearchParams, etag?: string) => {
  const result = await request(pathFor(query), etag);
  expect(result.status).toBe(200);
  return result.body as EvidenceCaseResponse;
};
const ids = (rows: { source: string; id: string }[]) => rows.map(row => [row.source, row.id]);
const stripEvidence = <T extends { evidence: unknown }>({ evidence: _evidence, ...totals }: T) => totals;

beforeAll(async () => {
  fixture = await materializeEvidenceFixture();
  child = spawn(process.execPath, [join(root, "tests/helpers/store-probe.ts"), root], { cwd: root, stdio: "pipe",
    env: { ...process.env, ...fixture.env, HOME: fixture.home, YALD_TEST_NOW: String(EVIDENCE_TO + 60000), YALD_TEST_PRICING_GENERATION: "" } });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  expect(JSON.parse((await lines.next()).value!)).toEqual({ ready: true });
  dataset = (await command({ op: "get" })).dataset;
  [helpers, cache, radar, scope, source] = await Promise.all([
    import("./evidence"), import("./cache"), import("./projects"), import("./scope"), import("../report/source"),
  ]);
});
afterAll(async () => { child?.kill(); await fixture?.cleanup(); });

test("Radar replays every real finding in both original periods with exact counts, price and token totals", async () => {
  const finding = (await request(`/api/labs/projects?${EVIDENCE_PARAMS}`)).body;
  for (const selected of [finding, ...finding.projects]) {
    const priorSelector = JSON.stringify(selected.prior.evidence.selector);
    const periods: EvidenceCaseResponse[] = [];
    for (const period of ["current", "prior"] as const) {
      const q = params(selected.current.evidence, "project-radar", { priorSelector, period, limit: "200" });
      const body = await evidence(q);
      periods.push(body);
      expect(body.intent.selector.window).toMatchObject({ from: EVIDENCE_FROM, to: EVIDENCE_TO });
      expect(body.intent.priorSelector!.window).toMatchObject({ from: EVIDENCE_FROM - 600000, to: EVIDENCE_FROM });
      expect(body.scope.window).toMatchObject(selected[period].evidence.selector.window);
      expect(body.observation.investigation).toBe("project-radar");
      if (body.observation.investigation !== "project-radar") throw new Error("wrong observation");
      expect(body.observation.current).toEqual(selected.current);
      expect(body.observation.prior).toEqual(selected.prior);
      expect(body.observation.comparison).toEqual(selected.comparison);
      expect(body.population.original).toMatchObject(selected[period].totals);
      expect(body.population.original.requests).toBe(selected[period].totals.requests);
      const selector = period === "prior" ? body.intent.priorSelector! : body.intent.selector;
      const expected = helpers.selectCaseRows(dataset.rows, selector);
      expect(ids(body.rows)).toEqual(ids(expected.slice(0, 200).map(row => ({ ...row, source: source.sourceOf(row) }))) );
      expect(body.population.evidence.tokens).toBe(expected.reduce((n, row) => n + row.totalTokens, 0));
      expect(body.population.evidence.pricedCostUsd).toBe(expected.reduce((n, row) => n + (row.priced ? row.cost : 0), 0));
    }
    expect(periods[0]!.observation).toEqual(periods[1]!.observation);
    expect(periods[0]!.intent.selector).toEqual(periods[1]!.intent.selector);
  }
  expect(finding.projects.some((p: any) => p.project === fixture.priorOnly && p.current.totals.requests === 0 && p.prior.totals.requests > 0)).toBe(true);
  expect(finding.projects.find((p: any) => p.project === fixture.zero).current.totals).toMatchObject({ pricedCostUsd: 0, pricedRequests: 1 });
  expect(finding.projects.find((p: any) => p.project === fixture.unpriced).current.totals.pricedRequests).toBe(0);
  expect(finding.projects.find((p: any) => p.project === "(unattributed)").current.totals.requests).toBe(1);
});

test("Cache scope, exact cross-source sessions and null-ID buckets replay the accepted predicate and builder", async () => {
  const finding = (await request(`/api/labs/cache?${EVIDENCE_PARAMS}&limit=500`)).body;
  for (const selected of [finding.totals, finding.unnamed, ...finding.sessions]) {
    const body = await evidence(params(selected.evidence, "cache-detective", { limit: "200" }));
    if (body.observation.investigation !== "cache-detective") throw new Error("wrong observation");
    expect(stripEvidence(selected)).toEqual(body.observation.totals);
    expect(body.population.original.requests).toBe(selected.totalRequests);
    expect(body.population.eligibleRequests).toBe(selected.eligibleRequests);
    expect(body.population.evidence.requests).toBe(selected.eligibleRequests);
    expect(body.population.excludedRequests).toBe(Object.values(selected.excluded).reduce((a: number, b) => a + Number(b), 0));
    const original = helpers.selectCaseRows(dataset.rows, body.intent.selector);
    const eligible = original.filter(row => cache.cacheEligibility(row).eligible);
    expect(body.population.original.tokens).toBe(original.reduce((sum, row) => sum + row.totalTokens, 0));
    expect(body.population.evidence.tokens).toBe(eligible.reduce((sum, row) => sum + row.totalTokens, 0));
    expect(body.population.evidence.pricedCostUsd).toBe(body.observation.totals.actualUsd);
    const selectedRows = new Set(original);
    expect(body.population.original.pricedCostUsd).toBe(cache.round6(dataset.rows.reduce((sum, row) =>
      sum + (selectedRows.has(row) && row.priced ? row.cost : 0), 0)));
    expect(ids(body.rows)).toEqual(ids(eligible.slice(0, 200).map(row => ({ ...row, source: source.sourceOf(row) }))));
    expect(body.rows.map(row => row.ordinal)).toEqual(eligible.slice(0, 200).map(row => original.indexOf(row)));
    expect(body.rows.every(row => row.eligible)).toBe(true);
    for (const row of body.rows) {
      expect(row.originalOrdinal).toBe(dataset.rows.findIndex(original => original.id === row.id && original.ts === row.ts && source.sourceOf(original) === row.source
        && original.inputTokens === row.inputTokens));
    }
  }
  expect(finding.sessions.filter((s: any) => s.conversationId === EVIDENCE_SESSION)).toHaveLength(2);
  expect(finding.totals.excluded).toMatchObject({ unpriced: 2, "cache-synthesized": 1, "cache-unknown": 1, "attempt-sum": 1,
    "input-missing": 1, "usage-estimated": 1, "cache-unmeasured": 1, "economics-unavailable": 1, "rate-unavailable": 2, "accounting-mismatch": 1 });
  expect(finding.totals.requestedTierOnlyRequests).toBeGreaterThan(0);
  expect(finding.totals.lowerBoundRequests).toBeGreaterThan(0);
  const zeroQ = new URLSearchParams(EVIDENCE_PARAMS); zeroQ.set("search", "l08-zero");
  const zero = (await request(`/api/labs/cache?${zeroQ}`)).body;
  expect((await evidence(params(zero.totals.evidence, "cache-detective"))).observation).toMatchObject({ state: "observed", totals: { netUsd: 0 } });
  for (const sourceId of ["ocx", "claude-code"] as const) {
    const selector: CaseSelector = { ...finding.unnamed.evidence.selector, selection: { kind: "unnamed", source: sourceId } };
    const q = params(finding.unnamed.evidence, "cache-detective"); q.set("selector", JSON.stringify(selector));
    const body = await evidence(q);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every(row => row.source === sourceId && row.conversationId === null)).toBe(true);
  }
});

test("Context all eligibility retains excluded, short and unnamed requests with server medians and history", async () => {
  const query = new URLSearchParams(EVIDENCE_PARAMS); query.set("search", "l07-"); query.set("efforts", "high");
  const finding = (await request(`/api/labs/context?${query}`)).body;
  const full = await evidence(params(finding.coverage.evidence, "context-replay"));
  expect(full.population.original.requests).toBe(finding.coverage.totalRequests);
  expect(full.population.evidence.requests).toBe(finding.coverage.totalRequests);
  expect(full.population.eligibleRequests).toBe(finding.coverage.eligibleRequests);
  for (const session of finding.sessions) {
    const body = await evidence(params(session.evidence, "context-replay"));
    if (body.observation.investigation !== "context-replay") throw new Error("wrong observation");
    expect(body.observation.growth).toEqual(session.growth);
    expect(body.observation.history).toEqual(session.history);
    expect(body.population.original.requests).toBe(session.inWindowRequests);
    expect(body.population.eligibleRequests).toBe(session.eligibleRequests);
    expect(body.rows.map(row => [row.source, row.id, row.ordinal, row.inputTokens, row.cost, row.durationMs])).toEqual(
      session.requests.map((row: any) => [row.source, row.id, row.ordinal, row.inputTokens, row.cost, row.durationMs]));
    expect(body.rows.filter(row => !row.eligible).length).toBe(session.excludedRequests);
    expect(body.rows.every(row => row.source === session.source && row.conversationId === session.conversationId)).toBe(true);
  }
  const unnamed = params(finding.coverage.evidence, "context-replay");
  const selector = JSON.parse(unnamed.get("selector")!); selector.selection = { kind: "unnamed" };
  unnamed.set("selector", JSON.stringify(selector));
  const body = await evidence(unnamed);
  expect(body.rows.every(row => row.conversationId === null)).toBe(true);
  expect(body.observation).toMatchObject({ investigation: "context-replay", growth: null, history: null });
  const missing = full.rows.find(row => row.id === "l07-missing")!;
  const attempts = full.rows.find(row => row.id === "l07-attempt-sum")!;
  const zero = full.rows.find(row => row.id === "l07-zero")!;
  expect(missing.inputTokens).toBeNull(); expect(attempts.inputTokens).toBeNull();
  expect(attempts.cacheReadTokens).toBe(500); expect(attempts.usageFromAttempts).toBe(true);
  expect(zero).toMatchObject({ inputTokens: 0, cost: 0, durationMs: 0, ttftMs: 0, eligible: true });
  expect(full.rows.find(row => row.id === "l07-unpriced")!.cost).toBeNull();
});

test("pagination preserves all identities, equal-time duplicates, ordinals and totals independently of page", async () => {
  const finding = (await request(`/api/labs/cache?${EVIDENCE_PARAMS}`)).body;
  const q = params(finding.totals.evidence, "cache-detective", { limit: "17" });
  const first = await evidence(q); const allRows = [...first.rows];
  for (let offset = first.page.nextOffset; offset !== null;) {
    q.set("offset", String(offset));
    const next = await evidence(q);
    expect(next.population).toEqual(first.population);
    expect(next.observation).toEqual(first.observation);
    allRows.push(...next.rows); offset = next.page.nextOffset;
  }
  expect(allRows).toHaveLength(first.population.evidence.requests);
  expect(new Set(allRows.map(row => row.identity)).size).toBe(allRows.length);
  const original = helpers.selectCaseRows(dataset.rows, first.intent.selector);
  const expected = original.filter(row => cache.cacheEligibility(row).eligible);
  expect(ids(allRows)).toEqual(ids(expected.map(row => ({ ...row, source: source.sourceOf(row) }))));
  expect(allRows.filter(row => row.id === "l08-duplicate").map(row => [row.source, row.inputTokens])).toEqual([
    ["claude-code", 100000], ["ocx", 100000], ["ocx", 200000],
  ]);
  expect(allRows.map(row => row.ordinal)).toEqual(expected.map(row => original.indexOf(row)));
  q.set("offset", "99999"); const beyond = await evidence(q);
  expect(beyond.rows).toEqual([]); expect(beyond.population).toEqual(first.population);
  q.delete("offset"); q.delete("limit"); expect((await evidence(q)).page.limit).toBe(100);
});

test("cache case uses builder round-once values rather than summed rounded request prices", async () => {
  const query = new URLSearchParams(EVIDENCE_PARAMS); query.set("search", "l08-round");
  const finding = (await request(`/api/labs/cache?${query}`)).body;
  const body = await evidence(params(finding.totals.evidence, "cache-detective", { limit: "1" }));
  expect(body.observation).toMatchObject({ totals: { totalRequests: 2, eligibleRequests: 2,
    readDiscountUsd: 0, writePremiumUsd: 0.000005, netUsd: -0.000005, direction: "cost" } });
  expect(body.population.original.requests).toBe(2);
  expect(finding.totals.actualUsd).toBe(0.082005);
  expect(body.population.original.pricedCostUsd).toBe(0.082005);
  expect(body.population.evidence.pricedCostUsd).toBe(0.082005);
  expect(cache.round6(body.rows[0]!.cost!) * 2).toBe(0.082006);
  expect(body.page).toMatchObject({ total: 2, returned: 1, nextOffset: 1 });
});

test("single half-micro Cache actual and both full-population subtotals reconcile before pagination", async () => {
  const query = new URLSearchParams(EVIDENCE_PARAMS); query.set("search", "l08-round-first");
  const finding = (await request(`/api/labs/cache?${query}`)).body;
  const trusted = cache.buildCacheEconomics(dataset.rows, helpers.caseFilter(finding.totals.evidence.selector), finding.scope.window);
  expect(finding.totals).toEqual(trusted.totals);
  expect(trusted.totals).toMatchObject({ totalRequests: 1, eligibleRequests: 1, actualUsd: 0.041003,
    readDiscountUsd: 0, writePremiumUsd: 0.000003, netUsd: -0.000003 });
  const q = params(finding.totals.evidence, "cache-detective", { limit: "1" });
  const first = await evidence(q);
  expect(first.rows.map(row => [row.source, row.id, row.cost])).toEqual([["ocx", "l08-round-first", 0.0410025]]);
  expect(first.population.original).toMatchObject({ requests: 1, pricedRequests: 1, pricedCostUsd: 0.041003 });
  expect(first.population.evidence).toEqual(first.population.original);
  expect(first.population).toMatchObject({ eligibleRequests: 1, excludedRequests: 0, exclusions: [] });
  expect(first.observation).toMatchObject({ totals: stripEvidence(trusted.totals) });
  for (const offset of [1, 200]) {
    q.set("offset", String(offset));
    const beyond = await evidence(q);
    expect(beyond.rows).toEqual([]);
    expect(beyond.population).toEqual(first.population);
    expect(beyond.observation).toEqual(first.observation);
  }
});

test("Cache original money includes priced exclusions while eligible zero and missing price remain distinct", async () => {
  const finding = (await request(`/api/labs/cache?${EVIDENCE_PARAMS}`)).body;
  const full = await evidence(params(finding.totals.evidence, "cache-detective"));
  expect(full.population.original.requests).toBeGreaterThan(full.population.evidence.requests);
  expect(full.population.original.pricedCostUsd).toBeGreaterThan(full.population.evidence.pricedCostUsd);
  for (const [search, pricedRequests, state] of [["l08-zero", 2, "observed"], ["l08-unpriced", 0, "insufficient"]] as const) {
    const query = new URLSearchParams(EVIDENCE_PARAMS); query.set("search", search);
    const selected = (await request(`/api/labs/cache?${query}`)).body;
    const body = await evidence(params(selected.totals.evidence, "cache-detective"));
    expect(body.observation.state).toBe(state);
    expect(body.population.original).toMatchObject({ pricedRequests, pricedCostUsd: 0 });
    expect(body.population.evidence.pricedCostUsd).toBe(0);
    expect(Object.is(body.population.original.pricedCostUsd, -0)).toBe(false);
    expect(Object.is(body.population.evidence.pricedCostUsd, -0)).toBe(false);
    expect(body.population.evidence.requests).toBe(pricedRequests);
  }
});

test("Cache subtotals preserve dataset accumulation order while evidence rows retain timestamp order", () => {
  const template = dataset.rows.find(row => row.id === "l08-round-first")!;
  const economics = template.cacheEconomics;
  if (!economics?.available) throw new Error("fixture requires exact cache prices");
  // Synthetic resolved prices: reversing their sum crosses the six-decimal tie.
  const rows = [0.01, 0.02, 0.0000025].map((cost, index) => ({ ...template,
    id: `l08-order-${index}`, ts: EVIDENCE_FROM + (3 - index) * 1000, cost,
    inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    cacheEconomics: { ...economics, inputTokens: 0, readTokens: 0, writeTokens: 0,
      actualUsd: cost, baselineUsd: cost, readDiscountUsd: 0, writePremiumUsd: 0 },
  }));
  const filter = { from: EVIDENCE_FROM, to: EVIDENCE_TO };
  const window = { ...filter, tz: "Asia/Singapore", label: "Synthetic accumulation order" };
  const trusted = cache.buildCacheEconomics(rows, filter, window);
  expect(trusted.totals.actualUsd).toBe(0.030002);
  expect(cache.buildCacheEconomics([...rows].reverse(), filter, window).totals.actualUsd).toBe(0.030003);
  const body = helpers.buildEvidenceCase(rows, { investigation: "cache-detective", selector: trusted.totals.evidence.selector,
    period: "current", offset: 0, limit: 1 });
  expect(body.rows.map(row => row.id)).toEqual(["l08-order-2"]);
  expect(body.population.original.pricedCostUsd).toBe(0.030002);
  expect(body.population.evidence.pricedCostUsd).toBe(0.030002);
  expect(body.observation).toMatchObject({ totals: { actualUsd: 0.030002 } });
});

test("Radar and Context retain unrounded reported costs at the Cache half-micro tie", async () => {
  const query = new URLSearchParams(EVIDENCE_PARAMS); query.set("search", "l08-round-first");
  const radar = (await request(`/api/labs/projects?${query}`)).body;
  const context = (await request(`/api/labs/context?${query}`)).body;
  for (const q of [
    params(radar.current.evidence, "project-radar", { priorSelector: JSON.stringify(radar.prior.evidence.selector) }),
    params(context.coverage.evidence, "context-replay"),
  ]) {
    const body = await evidence(q);
    expect(body.population.original).toMatchObject({ requests: 1, pricedCostUsd: 0.0410025 });
    expect(body.population.evidence).toEqual(body.population.original);
    expect(body.rows[0]!.cost).toBe(0.0410025);
  }
});

test("unavailable engine and missing tier support stay excluded through the real API in isolated processes", async () => {
  for (const mode of ["unavailable", "no-tier-helper"] as const) {
    const isolated = await materializeEvidenceFixture();
    let probe: ChildProcessWithoutNullStreams | undefined;
    try {
      const enginePath = join(isolated.pricing, "src/usage/cost.ts");
      const engine = await readFile(enginePath, "utf8");
      await writeFile(enginePath, mode === "unavailable" ? "export {};\n"
        : engine.replace(/export function serviceTierContext\(entry\) \{[\s\S]*?\n\}/, ""));
      probe = spawn(process.execPath, [join(root, "tests/helpers/store-probe.ts"), root], { cwd: root, stdio: "pipe",
        env: { ...process.env, ...isolated.env, YALD_TEST_NOW: String(EVIDENCE_TO + 60000), YALD_TEST_PRICING_GENERATION: "" } });
      const output = createInterface({ input: probe.stdout })[Symbol.asyncIterator]();
      let errors = ""; probe.stderr.on("data", chunk => { errors += String(chunk); });
      expect(JSON.parse((await output.next()).value!)).toEqual({ ready: true });
      const get = async (path: string) => {
        probe!.stdin.write(JSON.stringify({ op: "api", paths: [path] }) + "\n");
        const line = await output.next();
        if (line.done) throw new Error(errors);
        const reply = JSON.parse(line.value); if (reply.error) throw new Error(reply.error);
        expect(reply.result[0].status).toBe(200);
        return reply.result[0].body;
      };
      const query = new URLSearchParams(EVIDENCE_PARAMS); query.set("search", "l08-lowerbound");
      const finding = await get(`/api/labs/cache?${query}`);
      const body = await get(pathFor(params(finding.totals.evidence, "cache-detective")));
      expect(body.observation).toMatchObject({ state: "insufficient", totals: stripEvidence(finding.totals) });
      expect(body.observation.totals.excluded[mode === "unavailable" ? "unpriced" : "economics-unavailable"]).toBe(1);
      expect(body.population.original).toMatchObject({ requests: 1, pricedRequests: mode === "unavailable" ? 0 : 1 });
      expect(body.population.evidence.requests).toBe(0); expect(body.rows).toEqual([]);
      expect(body.observation.summary).not.toContain("$0.000000");
      if (mode === "no-tier-helper") {
        query.set("search", "l08-current-first");
        const noTier = await get(`/api/labs/cache?${query}`);
        const supported = await get(pathFor(params(noTier.totals.evidence, "cache-detective")));
        expect(supported.population.evidence.requests).toBe(1);
        expect(supported.rows[0].id).toBe("l08-current-first");
      }
    } finally { probe?.kill(); await isolated.cleanup(); }
  }
});

test("fixed windows include the start and exclude the end, never leaking boundary sentinels", async () => {
  const finding = (await request(`/api/labs/projects?${EVIDENCE_PARAMS}`)).body;
  const q = params(finding.current.evidence, "project-radar", { priorSelector: JSON.stringify(finding.prior.evidence.selector), limit: "200" });
  const current = await evidence(q);
  expect(current.rows.some(row => row.id === "l08-current-first")).toBe(true);
  expect(current.rows.some(row => ["l08-prior-last", "l08-at-to", "l08-before-prior"].includes(row.id))).toBe(false);
  q.set("period", "prior"); const prior = await evidence(q);
  expect(prior.rows.some(row => row.id === "l08-prior-first")).toBe(true);
  expect(prior.rows.some(row => row.id === "l08-prior-last")).toBe(true);
  expect(prior.rows.some(row => ["l08-current-first", "l08-at-to", "l08-before-prior"].includes(row.id))).toBe(false);
});

test("JSON cohort arrays preserve literal commas and brace globs with every accepted filter predicate", async () => {
  const window = { from: EVIDENCE_FROM, to: EVIDENCE_TO, tz: "Asia/Singapore", label: "untrusted display prose" };
  const filter = { from: window.from, to: window.to, sources: ["ocx" as const], projects: [join(fixture.home, "work", "{app,other}")],
    models: ["l08,model"], providers: ["synthetic"], efforts: ["high"], statuses: ["ok" as const], routeKinds: ["native"], conversationId: EVIDENCE_SESSION, search: "l08-" };
  const selected = scope.evidenceFor(filter, window, { kind: "session", source: "ocx", conversationId: EVIDENCE_SESSION }, "cache");
  const body = await evidence(params(selected, "cache-detective"));
  expect(body.rows.map(row => row.id)).toEqual(["l08-comma"]);
  expect(body.intent.selector.cohort).toEqual(selected.selector.cohort);
  expect(body.scope.window.label).not.toBe(window.label);
  const trusted = cache.buildCacheEconomics(dataset.rows, filter, window).sessions.find(s => s.conversationId === EVIDENCE_SESSION)!;
  expect(body.observation).toMatchObject({ totals: stripEvidence(trusted) });
});

test("toolbar mirrors cannot move case intent or paired original boundaries; valid unchanged payload returns304", async () => {
  const finding = (await request(`/api/labs/projects?${EVIDENCE_PARAMS}`)).body;
  const q = params(finding.current.evidence, "project-radar", { priorSelector: JSON.stringify(finding.prior.evidence.selector), period: "prior" });
  const first = await request(pathFor(q)); expect(first.status).toBe(200);
  expect((await request(pathFor(q), first.etag)).status).toBe(304);
  for (const [key, value] of Object.entries({ from: "broken", to: "now", tz: "not-a-zone", kind: "session", sessionId: "other", range: "7d", models: "unrelated" })) q.set(key, value);
  const changed = await request(pathFor(q));
  expect(changed.body).toEqual(first.body); expect(changed.etag).toBe(first.etag);
});

test("strict selector shapes, enums, identities, bounds, sizes, versions and pagination fail400 before any304", async () => {
  const finding = (await request(`/api/labs/cache?${EVIDENCE_PARAMS}`)).body;
  const q = params(finding.totals.evidence, "cache-detective");
  const first = await request(pathFor(q));
  const invalid: URLSearchParams[] = [];
  const mutate = (update: (s: any) => void) => { const p = new URLSearchParams(q); const s = JSON.parse(p.get("selector")!); update(s); p.set("selector", JSON.stringify(s)); invalid.push(p); };
  for (const value of [null, [], false, 3]) mutate(s => { s.cohort = value; });
  for (const value of [0, 2, "1", null]) mutate(s => { s.version = value; });
  for (const value of [null, "all", {}, [], ["unknown"], [""], [null]]) mutate(s => { s.cohort.sources = value; });
  for (const key of ["projects", "models", "providers", "efforts", "routeKinds", "statuses"]) {
    for (const value of [null, "x", [1], [""], Array(65).fill("x")]) mutate(s => { s.cohort[key] = value; });
  }
  for (const value of ["success", "unknown"]) mutate(s => { s.cohort.statuses = [value]; });
  for (const value of ["", [], 3, false]) mutate(s => { s.cohort.conversationId = value; });
  for (const value of [null, 0, {}, "x".repeat(1025)]) mutate(s => { s.cohort.search = value; });
  for (const value of [null, "all", 1, "context"]) mutate(s => { s.eligibility = value; });
  for (const value of [null, [], { kind: "session", source: "ocx", conversationId: "" }, { kind: "session", conversationId: "x" },
    { kind: "session", source: "unknown", conversationId: "x" }, { kind: "unnamed", source: "" }, { kind: "scope", source: "ocx" }, { kind: "bogus" }, { kind: "project", project: "" }]) mutate(s => { s.selection = value; });
  for (const value of [null, "0", 1.5, 1e100]) mutate(s => { s.window.from = value; });
  mutate(s => { s.window.from = s.window.to; }); mutate(s => { s.window.from = s.window.to + 1; });
  mutate(s => { s.window.tz = "not-a-zone"; }); mutate(s => { s.window.label = {}; });
  mutate(s => { delete s.cohort.models; }); mutate(s => { s.extra = "unsupported"; });
  for (const [key, values] of Object.entries({ investigation: ["", "bogus"], selector: ["{}", "null", "[]", "{bad", "x".repeat(24577)],
    selectorVersion: ["2", ""], offset: ["-1", "1.1", "NaN", "Infinity", "1e2", "", "9007199254740992"], limit: ["0", "201", "-1", "1.5", "", "Infinity"], period: ["prior", "unknown"] })) {
    for (const value of values) { const p = new URLSearchParams(q); p.set(key, value); invalid.push(p); }
  }
  for (const key of ["investigation", "selector", "limit"]) { const p = new URLSearchParams(q); if (!p.has(key)) p.set(key, "1"); p.append(key, p.get(key)!); invalid.push(p); }
  for (const p of invalid) {
    const path = pathFor(p);
    // This is the middleware's exact former pre-validation hash for this fixed URL.
    const premature = `W/"${createHash("sha256").update(`${dataset.revision}:http://localhost${path}:`).digest("hex").slice(0, 24)}"`;
    for (const etag of [first.etag, premature]) {
      const response = await request(path, etag);
      expect(response.status, path).toBe(400);
      expect(response.body).toMatchObject({ ok: false, error: { code: "invalid_evidence" } });
      expect(typeof response.body.error.message).toBe("string");
    }
  }
});

test("Radar rejects a rebased, mismatched or unequal paired window instead of inventing another baseline", async () => {
  const finding = (await request(`/api/labs/projects?${EVIDENCE_PARAMS}`)).body;
  const q = params(finding.current.evidence, "project-radar", { priorSelector: JSON.stringify(finding.prior.evidence.selector) });
  for (const change of [(s: any) => { s.window.to--; }, (s: any) => { s.window.from--; s.window.to--; },
    (s: any) => { s.cohort.models = ["other"]; }, (s: any) => { s.selection = { kind: "project", project: fixture.app }; },
    (s: any) => { s.eligibility = "cache"; }, (s: any) => { s.window.tz = "UTC"; }]) {
    const p = new URLSearchParams(q); const s = JSON.parse(p.get("priorSelector")!); change(s); p.set("priorSelector", JSON.stringify(s));
    expect((await request(pathFor(p), 'W/"cached"')).status).toBe(400);
  }
  q.delete("priorSelector"); expect((await request(pathFor(q))).status).toBe(400);
});

test("root identity changes invalidate resolved evidence ETags without any ledger revision, including later pages", async () => {
  const finding = (await request(`/api/labs/projects?${EVIDENCE_PARAMS}`)).body;
  const selected = finding.projects.find((p: any) => p.project === fixture.app);
  const q = params(selected.current.evidence, "project-radar", { priorSelector: JSON.stringify(selected.prior.evidence.selector) });
  const first = await request(pathFor(q));
  await mkdir(join(fixture.nested, ".git"));
  try {
    const changed = await request(pathFor(q), first.etag);
    expect(changed.status).toBe(200); expect(changed.etag).not.toBe(first.etag);
    expect(changed.body.population.original.requests).toBe(0);
    expect(changed.body.rows).toEqual([]);
    expect(changed.body.observation.project.present).toBe(false);
    expect(changed.body.observation.current.evidence.selector.selection).toEqual({ kind: "project", project: fixture.app });
    expect(changed.body.observation.prior.evidence.selector.selection).toEqual({ kind: "project", project: fixture.app });
    expect((await command({ op: "get" })).dataset.revision).toBe(dataset.revision);
    const scopeQ = params(finding.current.evidence, "project-radar", { priorSelector: JSON.stringify(finding.prior.evidence.selector), offset: "99999" });
    const nested = await request(pathFor(scopeQ));
    await rm(join(fixture.nested, ".git"), { recursive: true });
    const restored = await request(pathFor(scopeQ), nested.etag);
    expect(restored.status).toBe(200); expect(restored.etag).not.toBe(nested.etag);
    expect(restored.body.population.original.requests).toBe(nested.body.population.original.requests);
  } finally { await rm(join(fixture.nested, ".git"), { recursive: true, force: true }); }
});

test("empty, wholly excluded and insufficient-history cases stay descriptive and never use another population", async () => {
  const filter = { from: EVIDENCE_FROM, to: EVIDENCE_TO, sources: ["ocx" as const], search: "no-synthetic-match" };
  const window = { from: EVIDENCE_FROM, to: EVIDENCE_TO, tz: "UTC", label: "ignored" };
  const empty = await evidence(params(scope.evidenceFor(filter, window, { kind: "scope" }, "cache"), "cache-detective"));
  expect(empty.observation.state).toBe("empty"); expect(empty.rows).toEqual([]);
  const excluded = await evidence(params(scope.evidenceFor({ ...filter, search: "l08-unpriced" }, window, { kind: "scope" }, "cache"), "cache-detective"));
  expect(excluded.observation.state).toBe("insufficient"); expect(excluded.rows).toEqual([]);
  expect(excluded.population.original.requests).toBe(2);
  const earliest = dataset.rows[0]!.ts;
  const early = radar.buildProjectRadar(dataset.rows, {}, { ...window, from: earliest, to: earliest + 1 });
  const insufficient = await evidence(params(early.current.evidence, "project-radar", { priorSelector: JSON.stringify(early.prior.evidence.selector) }));
  expect(insufficient.observation).toMatchObject({ state: "insufficient", comparison: { requests: { state: "insufficient", relativeChange: null } } });
  const context = await evidence(params(scope.evidenceFor({ ...filter, search: "l08-input-missing" }, window), "context-replay"));
  expect(context.observation.state).toBe("insufficient"); expect(context.rows).toHaveLength(1);
  expect(context.rows[0]!.inputTokens).toBeNull();
});

test("evidence rows contain bounded public metadata and no prompt or response content", async () => {
  const finding = (await request(`/api/labs/cache?${EVIDENCE_PARAMS}`)).body;
  const body = await evidence(params(finding.totals.evidence, "cache-detective", { limit: "200" }));
  expect(body.rows.length).toBe(200);
  for (const row of body.rows) expect(Object.keys(row).some(key => /prompt|messages|response|body|content/i.test(key))).toBe(false);
  expect(body.observation.notes.join(" ")).toContain("API list-price equivalents");
});
