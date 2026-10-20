import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ProjectRadarResponse } from "../../../web/src/types";

// Only synthetic homes reach the real store/API, isolated from runtime env/module caches.
const root = resolve(import.meta.dir, "../../..");
const now = 1_791_000_000_000, day = 86_400_000, from = now - 2 * day;
let home: string, repo: string, nested: string;
let child: ChildProcessWithoutNullStreams;
let lines: AsyncIterator<string>;
let stderr = "";
async function command(input: object): Promise<any> {
  child.stdin.write(JSON.stringify(input) + "\n");
  const reply = await lines.next();
  if (reply.done) throw new Error(`fixture probe exited: ${stderr}`);
  const value = JSON.parse(reply.value);
  if (value.error) throw new Error(value.error);
  return value.result;
}
async function request(query: string, etag?: string) {
  const [result] = await command({ op: "api", paths: [`/api/labs/projects?${query}`], etag });
  return result as { status: number; etag: string; body: ProjectRadarResponse };
}
const query = () => new URLSearchParams({ from: String(from), to: String(now), tz: "Asia/Singapore" });

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "yald-l02-api-"));
  repo = join(home, "repo"); nested = join(repo, "server");
  const pricing = join(home, "pricing");
  await mkdir(nested, { recursive: true });
  await mkdir(join(repo, ".git"));
  await mkdir(join(home, "codex"));
  await mkdir(join(pricing, "src/usage"), { recursive: true });
  await writeFile(join(pricing, "src/usage/cost.ts"), `
let epoch = 1;
export function setPriceEpoch(value) { epoch = value; }
export function estimateRequestCost(input) {
  if (input.model === "unpriced") return null;
  const rate = 10 * epoch;
  const total = ((input.usage?.inputTokens ?? 0) + (input.usage?.outputTokens ?? 0)) * rate / 1e6;
  return {cost:{input:total,output:0,cacheRead:0,cacheWrite:0,total},estimated:false,price:{cost4:{input:rate,output:rate,cacheRead:0,cacheWrite:0}}};
}
`);
  const entry = (id: string, timestamp: number, cwd: string | null, tokens: number, extras = {}) => ({
    requestId: id, timestamp, cwd, conversationId: "fixture-collision", provider: "fixture-provider", model: "priced",
    status: 200, effectiveEffort: "high", routeDecision: { routeKind: "native" },
    usageStatus: "reported", usage: { inputTokens: tokens, outputTokens: 0 }, ...extras,
  });
  await writeFile(join(home, "usage.jsonl"), [
    entry("old", from - 2 * day - 1, repo, 1),
    entry("prior", from - day, repo, 1_000),
    entry("current", from, nested, 500),
    entry("price-gap", from + 1, nested, 100, { model: "unpriced" }),
    entry("unattributed", from + 2, null, 300),
    entry("claude", from + 3, nested, 100, { inboundProtocol: "claude-code", usagePresence: { input: true, output: true } }),
    entry("elsewhere", from + 4, join(home, "elsewhere"), 200),
    entry("at-to", now, nested, 50_000),
  ].map(e => JSON.stringify(e)).join("\n") + "\n");
  child = spawn(process.execPath, [join(root, "tests/helpers/store-probe.ts"), root], {
    cwd: root, stdio: "pipe", env: { ...process.env, HOME: home, OCX_HOME: home, CODEX_HOME: join(home, "codex"),
      CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), OCX_PACKAGE_DIR: pricing, TZ: "UTC", YALD_TZ: "UTC", YALD_TEST_PRICING_GENERATION: "", YALD_TEST_NOW: String(now) },
  });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  expect(JSON.parse((await lines.next()).value!)).toEqual({ ready: true });
});
afterAll(async () => { child?.kill(); if (home) await rm(home, { recursive: true, force: true }); });

test("real API parses common filters, discloses F03 exclusions and keeps current/prior exact scopes", async () => {
  const q = query();
  Object.entries({ sources: "codex", projects: repo, providers: "fixture-provider", models: "priced", efforts: "high", statuses: "ok", routeKinds: "native", conversationId: "fixture-collision", search: "fixture" }).forEach(([key, value]) => q.set(key, value));
  const { status, body } = await request(q.toString());
  expect(status).toBe(200);
  expect(body.current.totals).toMatchObject({ requests: 1, tokens: 500, pricedRequests: 1, unpricedRequests: 0 });
  expect(body.prior.totals).toMatchObject({ requests: 1, tokens: 1000 });
  expect(body.current.totals.pricedCostUsd).toBeCloseTo(0.005, 10);
  expect(body.prior.totals.pricedCostUsd).toBeCloseTo(0.01, 10);
  expect(body.current.coverage.projectExclusions).toMatchObject({ unattributedRows: 1, unattributedTokens: 300, attribution: { matched: { rows: 1 }, outsideProjects: { rows: 1 } } });
  expect(body.projects.find(g => g.project === "(unattributed)")!.current.totals.requests).toBe(0);
  expect(body.cohort).toEqual({ sources: ["ocx"], projects: [repo], providers: ["fixture-provider"], models: ["priced"], efforts: ["high"], statuses: ["ok"], routeKinds: ["native"], conversationId: "fixture-collision", search: "fixture" });
  expect(body.priorWindow).toMatchObject({ from: from - 2 * day, to: from, tz: "Asia/Singapore", halfOpen: true });
  expect(body.current.evidence.selector.cohort).toEqual(body.prior.evidence.selector.cohort);
  expect(body.current.evidence.selector.window).toMatchObject({ from, to: now });
  expect(body.projects.find(g => g.project === repo)!.current.evidence.selector.selection).toEqual({ kind: "project", project: repo });
  expect(body.comparison.tokens.relativeChange).toBe(-0.5);
});

test("API validates shared time and source parameters before conditional responses", async () => {
  for (const query of ["from=bad&to=now", "range=7d&tz=not-a-zone", "range=7d&sources=bogus", `from=${now}&to=${from}`]) {
    expect((await request(query, 'W/"arbitrary"')).status).toBe(400);
  }
});

test("pinned Radar ETags respond to changes in exact git-root grouping without ledger changes", async () => {
  const q = query().toString();
  const first = await request(q);
  expect(first.status).toBe(200);
  expect((await request(q, first.etag)).status).toBe(304);
  await rm(join(repo, ".git"), { recursive: true });
  try {
    const changed = await request(q, first.etag);
    expect(changed.status).toBe(200);
    expect(changed.etag).not.toBe(first.etag);
    expect(changed.body.projects.find(g => g.project === nested)!.current.totals.requests).toBe(3);
  } finally { await mkdir(join(repo, ".git")); }
});

test("both comparison windows use the same currently loaded prices when synthetic pricing changes", async () => {
  const before = (await request(query().toString())).body;
  await command({ op: "price", epoch: 2 });
  // Existing store policy: price-only changes enter the dataset on an explicit refresh.
  await command({ op: "get", force: true });
  const after = (await request(query().toString())).body;
  expect(after.pricingBasis).toBe("currently-loaded-api-list-price-equivalents");
  expect(after.current.totals.pricedCostUsd).toBeCloseTo(before.current.totals.pricedCostUsd * 2, 10);
  expect(after.prior.totals.pricedCostUsd).toBeCloseTo(before.prior.totals.pricedCostUsd * 2, 10);
  expect(after.comparison.pricedCostUsd.relativeChange).toBe(before.comparison.pricedCostUsd.relativeChange);
  expect(after.current.totals.unpricedRequests).toBe(1);
  expect(after.current.coverage.measurements.outcomes).toMatchObject({ eligibleRequests: 4, totalRequests: 5 });
});
