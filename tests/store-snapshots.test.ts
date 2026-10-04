import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Dataset } from "../server/src/ocx/store";

const root = resolve(import.meta.dir, "..");
// Explicit baseline overrides must exist. CI can instead use a cold, forced
// candidate parser; local PR2 verification uses the frozen PR1 checkout.
const frozenBaseline = "/private/tmp/yald-relay-pr1-baseline";
const baseline = process.env.YALD_SNAPSHOT_BASELINE ?? (existsSync(join(frozenBaseline, "server/src/ocx/store.ts")) ? frozenBaseline : root);
const realPricing = process.env.YALD_SNAPSHOT_REAL_PRICING ?? "/opt/homebrew/lib/node_modules/@bitkyc08/opencodex";
const helper = join(import.meta.dir, "helpers/store-probe.ts");
const epoch = 1_791_000_000_000;
const owned: string[] = [];
const children: Probe[] = [];
type View = { dataset: Dataset; ids: { dataset: number; rows: number; rowObjects: number[]; quota: number; ledger: number }; reads: Record<string, number> };

class Probe {
  child: ChildProcessWithoutNullStreams;
  lines: string[] = [];
  waiters: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
  stderr = "";
  constructor(checkout: string, home: string, pricing: string, syntheticGeneration = false) {
    this.child = spawn(process.execPath, [helper, checkout], { cwd: root, env: { ...process.env, OCX_HOME: home, CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), OCX_PACKAGE_DIR: pricing, YALD_TEST_PRICING_GENERATION: syntheticGeneration ? "synthetic" : "", TZ: "UTC", YALD_TZ: "UTC" }, stdio: "pipe" });
    createInterface({ input: this.child.stdout }).on("line", line => {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line); else this.lines.push(line);
    });
    this.child.stderr.on("data", chunk => { this.stderr += String(chunk); });
    this.child.on("exit", code => { for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(`probe exited ${code}: ${this.stderr}`)); });
    children.push(this);
  }
  async line(): Promise<any> {
    const line = this.lines.shift() ?? await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`probe response timeout: ${this.stderr}`)), 10_000);
      this.waiters.push({ resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
    return JSON.parse(line);
  }
  async ready() { expect(await this.line()).toEqual({ ready: true }); return this; }
  async ask(input: Record<string, unknown>): Promise<any> {
    this.child.stdin.write(JSON.stringify(input) + "\n");
    const reply = await this.line();
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  }
  stop() { this.child.kill(); }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(async probe => {
    const exited = new Promise<void>(resolve => { if (probe.child.exitCode !== null || probe.child.signalCode !== null) resolve(); else probe.child.once("exit", () => resolve()); });
    probe.stop(); await exited;
  }));
  await Promise.all(owned.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function entry(id: string, timestamp = epoch - 60_000, overrides: Record<string, unknown> = {}) {
  return { requestId: id, timestamp, provider: "test-provider", model: "priced", conversationId: "c1", effectiveEffort: "high", routeDecision: { routeKind: "native" }, status: 200, durationMs: 1000, firstOutputMs: 0, usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, cacheWriteInputTokens: 10, reasoningOutputTokens: 2 }, ...overrides };
}
function quota(percent: number) {
  return JSON.stringify({ quotas: { a: { weeklyPercent: percent, weeklyResetAt: (epoch + 7 * 86_400_000) / 1000, updatedAt: epoch } }, history: { accounts: { a: { samples: [
    { observedAt: epoch - 3_600_000, windows: [{ window: "weekly", family: "account", usedPercent: 10 }] },
    { observedAt: epoch - 30_000, windows: [{ window: "weekly", family: "account", usedPercent: percent }] },
  ] } } } });
}
async function touch(path: string, text: string) {
  await writeFile(path, text);
  // Deliberately distinct metadata: unrelated tests must not rely on fs clock resolution.
  const time = (await stat(path)).mtimeMs + 2_000;
  await utimes(path, time / 1000, time / 1000);
}
async function fixture(mode: "versioned" | "unknown" | "unavailable" | "untrusted-versioned" = "versioned") {
  const dir = await mkdtemp(join(tmpdir(), "yald-snapshot-test-")); owned.push(dir);
  const home = join(dir, "home"), pricing = join(dir, "pricing"), usageDir = join(pricing, "src/usage");
  await mkdir(home); await mkdir(usageDir, { recursive: true });
  // The synthetic version signal is only a store-unit dependency, NOT an
  // audited opencodex engine. Untrusted-versioned deliberately has the same API
  // without the helper mock, and must be rejected for reuse by the real adapter.
  const hasVersion = mode === "versioned" || mode === "untrusted-versioned";
  const control = hasVersion
    ? 'import { userCostOverlayVersion, setPriceEpoch } from "./user-cost-overlays";\nexport { setPriceEpoch };\nconst current = userCostOverlayVersion;'
    : 'let version = 0; export function setPriceEpoch(value) { version = value; } const current = () => version;';
  if (hasVersion) await writeFile(join(usageDir, "user-cost-overlays.ts"), 'let version = 0; export function userCostOverlayVersion() { return version; } export function setPriceEpoch(value) { version = value; }');
  await writeFile(join(usageDir, "cost.ts"), mode === "unavailable" ? 'throw new Error("test engine unavailable");' : `${control}
export function estimateRequestCost(input) {
  if (input.model === "unpriced") return null;
  const rate = 10 * (current() + 1);
  const u = input.usage ?? {};
  const fresh = Math.max(0, (u.inputTokens ?? 0) - (u.cacheReadInputTokens ?? u.cachedInputTokens ?? 0));
  const cost = { input: fresh * rate / 1e6, output: (u.outputTokens ?? 0) * rate * 2 / 1e6, cacheRead: (u.cacheReadInputTokens ?? u.cachedInputTokens ?? 0) * rate / 10 / 1e6, cacheWrite: (u.cacheCreationInputTokens ?? u.cacheWriteInputTokens ?? 0) * rate / 2 / 1e6 };
  return { cost: { ...cost, total: Object.values(cost).reduce((a,b) => a+b, 0) }, estimated: input.usageStatus !== "reported", price: { cost4: { input: rate, output: rate*2, cacheRead: rate/10, cacheWrite: rate/2 } }, ...((u.inputTokens ?? 0) > 200000 ? { contextTier: "long" } : {}) };
}
export function serviceTierContext(entry) { return entry.responseServiceTier ?? entry.requestedServiceTier; }
`);
  const text = [entry("later", epoch - 10_000), entry("tie-a"), entry("tie-b"), entry("unpriced", epoch - 120_000, { model: "unpriced", firstOutputMs: null }), entry("零-🙂", epoch - 60_000, { status: 502, errorCode: 'comma,"雪"', usage: {}, attempts: [ { usage: { inputTokens: 9, outputTokens: 2, cacheReadInputTokens: 1, cacheCreationInputTokens: 3, totalTokens: 11 } }, { usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 } } ], spend: { sends: 2, settled: 1, unresolved: 1 } }), entry("zero", epoch - 20_000, { usage: { inputTokens: 0, outputTokens: 0 }, firstOutputMs: 0 }), entry("long", epoch - 50_000, { usage: { inputTokens: 250001, outputTokens: 0 }, requestedServiceTier: "priority", usageStatus: "estimated" })].map(value => JSON.stringify(value)).join("\r\n") + "\r\n\n \n{broken}\n";
  await writeFile(join(home, "usage.jsonl"), text);
  await writeFile(join(home, "spend-ledger.jsonl"), [JSON.stringify({ kind: "settle", at: epoch - 60_000, send: "s1", tokens: 120 }), "bad", " ", JSON.stringify({ kind: "dispatch", at: epoch - 60_000, send: "s1", tokens: 0 })].join("\r\n"));
  await writeFile(join(home, "codex-quota-cache.json"), quota(20));
  const probe = await new Probe(root, home, pricing, mode === "versioned").ready();
  return { home, pricing, probe, text, usage: join(home, "usage.jsonl"), spend: join(home, "spend-ledger.jsonl"), quota: join(home, "codex-quota-cache.json") };
}

// Narrow, declared exclusions: revision is implementation-specific; parse timing
// and build clock are diagnostics. Paths and file metadata are retained because
// both revisions read the same home. No normalized row fields are excluded.
function comparable(view: View) {
  const { builtAt: _builtAt, revision: _revision, parse, ...rest } = view.dataset;
  return { ...rest, parse: { malformedLines: parse.malformedLines } };
}
async function oracle(f: Awaited<ReturnType<typeof fixture>>, actual: View) {
  // New process on every observation, so the oracle cannot share store/pricing caches.
  const probe = await new Probe(baseline, f.home, f.pricing).ready();
  const expected = await probe.ask({ op: "get", force: true });
  expect(comparable(actual)).toEqual(comparable(expected));
  probe.stop();
}

test("quota/spend-only rebuilds reuse frozen usage rows and only replace the changed component", async () => {
  const f = await fixture();
  expect(await f.probe.ask({ op: "adapter" })).toMatchObject({ syntheticGeneration: true, generation: "synthetic-store-contract:0" });
  const first: View = await f.probe.ask({ op: "get", freeze: true });
  await oracle(f, first);
  expect(first.dataset.parse.malformedLines).toBe(2);
  expect(first.dataset.rows.map(row => row.id)).toEqual(["unpriced", "tie-a", "tie-b", "零-🙂", "long", "zero", "later"]);
  const unchanged: View = await f.probe.ask({ op: "get" });
  expect(unchanged.ids.dataset).toBe(first.ids.dataset);
  await touch(f.quota, quota(35));
  const next: View = await f.probe.ask({ op: "get", freeze: true });
  expect(next.ids.dataset).not.toBe(first.ids.dataset);
  expect(next.ids.rows).toBe(first.ids.rows);
  expect(next.ids.rowObjects).toEqual(first.ids.rowObjects);
  expect(next.ids.ledger).toBe(first.ids.ledger);
  expect(next.ids.quota).not.toBe(first.ids.quota);
  expect(next.reads["usage.jsonl"]).toBe(first.reads["usage.jsonl"]);
  expect(next.dataset.quota.windows[0]!.usedPercent).toBe(35);
  expect(next.dataset.revision).not.toBe(first.dataset.revision);
  await oracle(f, next);
  await touch(f.spend, JSON.stringify({ kind: "settle", at: epoch, tokens: 555, send: "new" }));
  const spend: View = await f.probe.ask({ op: "get", freeze: true });
  expect(spend.ids.rows).toBe(next.ids.rows);
  expect(spend.ids.rowObjects).toEqual(next.ids.rowObjects);
  expect(spend.ids.quota).toBe(next.ids.quota);
  expect(spend.ids.ledger).not.toBe(next.ids.ledger);
  expect(spend.reads["usage.jsonl"]).toBe(first.reads["usage.jsonl"]);
  expect(spend.dataset.ledger.settledTokens).toBe(555);
  await oracle(f, spend);
}, 30_000);

test("usage lifecycle reparses appends, same-size rewrites, truncation, rotation, deletion and recreation", async () => {
  const f = await fixture();
  let previous: View = await f.probe.ask({ op: "get", freeze: true });
  async function check(ids?: string[]) {
    const view: View = await f.probe.ask({ op: "get", freeze: true });
    expect(view.ids.rows).not.toBe(previous.ids.rows);
    expect(view.ids.quota).toBe(previous.ids.quota);
    expect(view.ids.ledger).toBe(previous.ids.ledger);
    if (ids) expect(view.dataset.rows.map(row => row.id)).toEqual(ids);
    await oracle(f, view); previous = view; return view;
  }
  await appendFile(f.usage, JSON.stringify(entry("early", epoch - 150_000)) + "\n");
  await check();
  const initial = await readFile(f.usage, "utf8");
  const rewritten = initial.replace('"inputTokens":100', '"inputTokens":900');
  expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(initial));
  await touch(f.usage, rewritten); await check();
  await touch(f.usage, JSON.stringify(entry("short"))); await check(["short"]);
  // Replacement has identical bytes and mtime but different identity/ctime.
  const priorStat = await stat(f.usage);
  const replacement = join(f.home, "replacement");
  await writeFile(replacement, JSON.stringify(entry("other")));
  expect((await stat(replacement)).size).toBe(priorStat.size);
  await utimes(replacement, priorStat.atime, priorStat.mtime);
  await rename(replacement, f.usage); await check(["other"]);
  await rm(f.usage); const removed = await check([]);
  expect(removed.dataset.files.usage).toBeNull();
  expect(removed.dataset.parse.malformedLines).toBe(0);
  await touch(f.usage, JSON.stringify(entry("again"))); await check(["again"]);
}, 30_000);

test("valid final JSON, torn tail completion, blanks, malformed lines, unicode, CRLF and stable duplicate/tie order match full parser", async () => {
  const f = await fixture();
  const complete = JSON.stringify(entry("尾🙂", epoch - 120_000));
  await touch(f.usage, JSON.stringify(entry("tie-a")) + "\r\n\n \n{broken}\n" + complete.slice(0, -4));
  const torn: View = await f.probe.ask({ op: "get", freeze: true });
  expect(torn.dataset.rows).toHaveLength(1);
  expect(torn.dataset.parse.malformedLines).toBe(3);
  expect(torn.dataset.files.usage!.lines).toBe(4);
  await oracle(f, torn);
  await appendFile(f.usage, complete.slice(-4));
  const completed: View = await f.probe.ask({ op: "get" });
  expect(completed.dataset.rows.map(row => row.id)).toEqual(["尾🙂", "tie-a"]);
  expect(completed.dataset.parse.malformedLines).toBe(2);
  await oracle(f, completed);
  await appendFile(f.usage, "\n" + JSON.stringify(entry("tie-a")) + "\n" + JSON.stringify(entry("tie-b")));
  const duplicate: View = await f.probe.ask({ op: "get" });
  expect(duplicate.dataset.rows.map(row => row.id)).toEqual(["尾🙂", "tie-a", "tie-a", "tie-b"]);
  await oracle(f, duplicate);
}, 30_000);

test("forced unchanged rebuild replaces all components; metadata-collision escape hatch rereads bytes", async () => {
  const f = await fixture();
  const before: View = await f.probe.ask({ op: "get", freeze: true });
  const forced: View = await f.probe.ask({ op: "get", force: true });
  for (const key of ["dataset", "rows", "ledger", "quota"] as const) expect(forced.ids[key]).not.toBe(before.ids[key]);
  expect(forced.dataset.rows).toEqual(before.dataset.rows);
  expect(forced.reads["usage.jsonl"]).toBe(before.reads["usage.jsonl"]! + 1);
  const info = await stat(f.usage);
  await writeFile(f.usage, f.text.replace('"inputTokens":100', '"inputTokens":999'));
  await utimes(f.usage, info.atime, info.mtime);
  const rebuilt: View = await f.probe.ask({ op: "get", force: true });
  expect(rebuilt.dataset.rows.find(row => row.id === "later")!.inputTokens).toBe(999);
  await oracle(f, rebuilt);
}, 30_000);

test("unknown pricing hook conservatively reprices on component rebuild and force", async () => {
  const f = await fixture("unknown");
  const before: View = await f.probe.ask({ op: "get" });
  await f.probe.ask({ op: "price", epoch: 1 });
  await touch(f.quota, quota(45));
  const changed: View = await f.probe.ask({ op: "get" });
  expect(changed.ids.rows).not.toBe(before.ids.rows);
  expect(changed.dataset.rows.find(row => row.priced)!.rateIn).toBe(20);
  const fresh = await new Probe(baseline, f.home, f.pricing).ready();
  await fresh.ask({ op: "price", epoch: 1 });
  expect(comparable(changed)).toEqual(comparable(await fresh.ask({ op: "get", force: true })));
  await f.probe.ask({ op: "price", epoch: 2 });
  const forced: View = await f.probe.ask({ op: "get", force: true });
  expect(forced.dataset.rows.find(row => row.priced)!.rateIn).toBe(30);
  expect(forced.dataset.rows.find(row => !row.priced)!.rateIn).toBeNull();
}, 30_000);

test("version exports on an unaudited lookalike do not authorize usage snapshot reuse", async () => {
  const f = await fixture("untrusted-versioned");
  expect(await f.probe.ask({ op: "adapter" })).toMatchObject({ syntheticGeneration: false, generation: null, status: { available: true } });
  const before: View = await f.probe.ask({ op: "get" });
  await touch(f.quota, quota(47));
  const rebuilt: View = await f.probe.ask({ op: "get" });
  expect(rebuilt.ids.rows).not.toBe(before.ids.rows);
  expect(rebuilt.reads["usage.jsonl"]).toBe(before.reads["usage.jsonl"]! + 1);
  await oracle(f, rebuilt);
  await f.probe.ask({ op: "price", epoch: 1 });
  await touch(f.spend, JSON.stringify({ kind: "settle", at: epoch, tokens: 13 }));
  const repriced: View = await f.probe.ask({ op: "get" });
  expect(repriced.dataset.rows.find(row => row.priced)!.rateIn).toBe(20);
  const fresh = await new Probe(baseline, f.home, f.pricing).ready();
  await fresh.ask({ op: "price", epoch: 1 });
  expect(comparable(repriced)).toEqual(comparable(await fresh.ask({ op: "get", force: true })));
}, 30_000);

test("known pricing generation change invalidates normalized usage even with unchanged usage bytes", async () => {
  const f = await fixture();
  const before: View = await f.probe.ask({ op: "get", freeze: true });
  await f.probe.ask({ op: "price", epoch: 1 });
  await touch(f.spend, JSON.stringify({ kind: "settle", at: epoch, tokens: 111 }));
  const after: View = await f.probe.ask({ op: "get" });
  expect(after.ids.rows).not.toBe(before.ids.rows);
  expect(after.dataset.rows.find(row => row.priced)!.rateIn).toBe(20);
  const fresh = await new Probe(baseline, f.home, f.pricing).ready();
  await fresh.ask({ op: "price", epoch: 1 });
  expect(comparable(after)).toEqual(comparable(await fresh.ask({ op: "get", force: true })));
  await f.probe.ask({ op: "price", epoch: 2 });
  const forced: View = await f.probe.ask({ op: "get", force: true });
  expect(forced.dataset.rows.find(row => row.priced)!.rateIn).toBe(30);
}, 30_000);

test("invalid registry version is unknown safety, not permission to reuse priced rows", async () => {
  const f = await fixture();
  const before: View = await f.probe.ask({ op: "get" });
  await f.probe.ask({ op: "price", epoch: -1 });
  await touch(f.quota, quota(46));
  const changed: View = await f.probe.ask({ op: "get" });
  expect(changed.ids.rows).not.toBe(before.ids.rows);
  expect(changed.dataset.rows.find(row => row.priced)!.rateIn).toBe(0);
  const fresh = await new Probe(baseline, f.home, f.pricing).ready();
  await fresh.ask({ op: "price", epoch: -1 });
  expect(comparable(changed)).toEqual(comparable(await fresh.ask({ op: "get", force: true })));
}, 30_000);

test("pricing-only changes retain the documented file-driven fast path and existing force ETag limitation", async () => {
  const f = await fixture();
  const before: View = await f.probe.ask({ op: "get" });
  const path = `/api/overview?from=${epoch - 3_600_000}&to=${epoch}`;
  const original = (await f.probe.ask({ op: "api", paths: [path] }))[0];
  await f.probe.ask({ op: "price", epoch: 1 });
  const unchanged: View = await f.probe.ask({ op: "get" });
  expect(unchanged.ids.dataset).toBe(before.ids.dataset);
  const forced: View = await f.probe.ask({ op: "get", force: true });
  expect(forced.dataset.rows.find(row => row.priced)!.rateIn).toBe(20);
  const fresh = await new Probe(baseline, f.home, f.pricing).ready();
  await fresh.ask({ op: "price", epoch: 1 });
  expect(comparable(forced)).toEqual(comparable(await fresh.ask({ op: "get", force: true })));
  const updated = (await f.probe.ask({ op: "api", paths: [path] }))[0];
  expect(updated.body.summary.cost).toBeGreaterThan(original.body.summary.cost);
  // Explicitly expose the pre-existing issue: file signatures did not change,
  // so price-only force rebuilds still share an ETag. This test is not a claim
  // that the limitation is correct or fixed by per-file reuse.
  expect(updated.etag).toBe(original.etag);
  expect((await f.probe.ask({ op: "api", paths: [path], etag: original.etag }))[0].status).toBe(304);
}, 30_000);

test("unavailable pricing preserves unpriced/null conventions through quota rebuild", async () => {
  const f = await fixture("unavailable");
  await f.probe.ask({ op: "get" });
  await touch(f.quota, quota(55));
  const result: View = await f.probe.ask({ op: "get" });
  expect(result.dataset.rows.every(row => !row.priced && row.cost === 0 && row.rateIn === null)).toBe(true);
  await oracle(f, result);
}, 30_000);

test.skipIf(!existsSync(join(realPricing, "src/usage/cost.ts")))("installed opencodex rates, long context, service tier and attempt recovery match a cold full parser", async () => {
  const f = await fixture();
  f.pricing = realPricing;
  f.probe = await new Probe(root, f.home, realPricing).ready();
  const adapter = await f.probe.ask({ op: "adapter" });
  expect(adapter.syntheticGeneration).toBe(false);
  expect(typeof adapter.generation).toBe("string");
  await touch(f.usage, [
    entry("real-priced", epoch - 60_000, { provider: "openai", model: "gpt-4o" }),
    entry("real-long", epoch - 50_000, { provider: "openai", model: "gpt-5.6-sol", usage: { inputTokens: 300001, outputTokens: 12, cacheReadInputTokens: 2000, cacheCreationInputTokens: 300 }, responseServiceTier: "priority", usageStatus: "estimated" }),
    entry("real-retry", epoch - 40_000, { provider: "openai", model: "gpt-4o", usage: {}, attempts: [{ usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 } }, { usage: { inputTokens: 10, outputTokens: 2 } }] }),
    entry("real-unpriced", epoch - 30_000, { provider: "unknown-test-provider", model: "nonexistent-test-model" }),
  ].map(value => JSON.stringify(value)).join("\n"));
  const before: View = await f.probe.ask({ op: "get", freeze: true });
  expect(before.dataset.rows[0]!.priced).toBe(true);
  expect(before.dataset.rows[1]!.contextTier).toBe("long");
  expect(before.dataset.rows[1]!.serviceTier).toBe("priority");
  expect(before.dataset.rows[2]!.usageFromAttempts).toBe(true);
  expect(before.dataset.rows[3]!.priced).toBe(false);
  await oracle(f, before);
  await touch(f.quota, quota(58));
  const reused: View = await f.probe.ask({ op: "get" });
  expect(reused.ids.rows).toBe(before.ids.rows);
  expect(reused.dataset.rows).toEqual(before.dataset.rows);
  await oracle(f, reused);
  const config = { providers: { openai: { modelCosts: { "gpt-4o": { input: 42, output: 84, cacheRead: 4.2, cacheWrite: 21 } } } } };
  const overlay = await f.probe.ask({ op: "overlay", config });
  expect(overlay.after).toBeGreaterThan(overlay.before);
  await touch(f.quota, quota(59));
  const repriced: View = await f.probe.ask({ op: "get" });
  expect(repriced.ids.rows).not.toBe(reused.ids.rows);
  expect(repriced.dataset.rows[0]!.rateIn).toBe(42);
  expect(repriced.dataset.rows[0]!.cost).toBeGreaterThan(reused.dataset.rows[0]!.cost);
  const fresh = await new Probe(baseline, f.home, realPricing).ready();
  await fresh.ask({ op: "overlay", config });
  expect(comparable(repriced)).toEqual(comparable(await fresh.ask({ op: "get", force: true })));
}, 30_000);

test("coalesced readers and a force joining an active rebuild publish one complete snapshot", async () => {
  const f = await fixture();
  const before: View = await f.probe.ask({ op: "get", freeze: true });
  await appendFile(f.usage, JSON.stringify(entry("joined")));
  expect(await f.probe.ask({ op: "begin" })).toEqual({ entered: true });
  for (const force of [false, true, false]) expect(await f.probe.ask({ op: "join", force })).toMatchObject({ previousUnchanged: true });
  const result = await f.probe.ask({ op: "finish" });
  expect(result.statuses).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
  expect(result.sameDataset).toBe(true);
  expect(result.previousUnchanged).toBe(true);
  expect(result.dataset.rows).toHaveLength(before.dataset.rows.length + 1);
  expect(result.reads["usage.jsonl"]).toBe(before.reads["usage.jsonl"]! + 1);
  await oracle(f, result);
}, 30_000);

test("failed concurrent rebuild rejects all callers, preserves prior values and retries without stale cache publication", async () => {
  const f = await fixture();
  const before: View = await f.probe.ask({ op: "get", freeze: true });
  await appendFile(f.usage, JSON.stringify(entry("recover")));
  await touch(f.quota, quota(65));
  await f.probe.ask({ op: "begin", fail: true });
  await f.probe.ask({ op: "join", force: true });
  const failed = await f.probe.ask({ op: "finish" });
  expect(failed.statuses).toEqual(["rejected", "rejected"]);
  expect(failed.errors.every((error: string) => error.includes("injected read failure"))).toBe(true);
  expect(failed.previousUnchanged).toBe(true);
  expect(failed.ids.dataset).toBe(before.ids.dataset);
  const recovered: View = await f.probe.ask({ op: "concurrent", count: 16 });
  expect((recovered as View & { sameDataset: boolean }).sameDataset).toBe(true);
  expect(recovered.dataset.rows).toHaveLength(before.dataset.rows.length + 1);
  expect(recovered.dataset.quota.windows[0]!.usedPercent).toBe(65);
  await oracle(f, recovered);
}, 30_000);

test("spend read failure after successful usage parsing cannot publish a partial component snapshot", async () => {
  const f = await fixture();
  const before: View = await f.probe.ask({ op: "get", freeze: true });
  await appendFile(f.usage, JSON.stringify(entry("parsed-before-failure")));
  await touch(f.spend, JSON.stringify({ kind: "settle", at: epoch, tokens: 777 }));
  await f.probe.ask({ op: "begin", file: "spend-ledger.jsonl", fail: true });
  await f.probe.ask({ op: "join" });
  const failed = await f.probe.ask({ op: "finish" });
  expect(failed.statuses).toEqual(["rejected", "rejected"]);
  expect(failed.previousUnchanged).toBe(true);
  expect(failed.ids).toEqual(before.ids);
  expect(failed.reads["usage.jsonl"]).toBe(before.reads["usage.jsonl"]! + 1);
  const recovered: View = await f.probe.ask({ op: "get" });
  expect(recovered.reads["usage.jsonl"]).toBe(failed.reads["usage.jsonl"] + 1);
  expect(recovered.dataset.rows).toHaveLength(before.dataset.rows.length + 1);
  expect(recovered.dataset.ledger.settledTokens).toBe(777);
  await oracle(f, recovered);
}, 30_000);

test("real usage read error recovers after the failing path is replaced", async () => {
  const f = await fixture();
  const before: View = await f.probe.ask({ op: "get", freeze: true });
  await rm(f.usage); await mkdir(f.usage);
  await expect(f.probe.ask({ op: "get" })).rejects.toThrow();
  await rm(f.usage, { recursive: true });
  await touch(f.usage, JSON.stringify(entry("restored")));
  const result: View = await f.probe.ask({ op: "get" });
  expect(result.ids.dataset).not.toBe(before.ids.dataset);
  expect(result.dataset.rows.map(row => row.id)).toEqual(["restored"]);
  await oracle(f, result);
}, 30_000);

test("usage, spend and quota disappearing between stat and read retry into complete empty components", async () => {
  for (const component of ["usage", "spend", "quota"] as const) {
    const f = await fixture();
    const before: View = await f.probe.ask({ op: "get", freeze: true });
    const path = f[component];
    const text = await readFile(path, "utf8");
    // Force ensures the barrier is reached even though the source bytes match.
    await f.probe.ask({ op: "begin", force: true, file: path.split("/").at(-1) });
    await rm(path);
    await f.probe.ask({ op: "join", force: true });
    const result = await f.probe.ask({ op: "finish" });
    expect(result.statuses).toEqual(["fulfilled", "fulfilled"]);
    expect(result.sameDataset).toBe(true);
    expect(result.previousUnchanged).toBe(true);
    expect(result.dataset.files[component]).toBeNull();
    if (component === "usage") expect(result.dataset.rows).toEqual([]);
    if (component === "spend") expect(result.dataset.ledger.events).toEqual([]);
    if (component === "quota") expect(result.dataset.quota.windows).toEqual([]);
    expect(result.ids.dataset).not.toBe(before.ids.dataset);
    await oracle(f, result);
    await touch(path, text);
    const restored: View = await f.probe.ask({ op: "get" });
    expect(restored.dataset.rows).toEqual(before.dataset.rows);
    expect(restored.dataset.quota).toEqual(before.dataset.quota);
    expect(restored.dataset.ledger).toEqual(before.dataset.ledger);
    await oracle(f, restored);
  }
}, 30_000);

test("usage/spend EACCES errors reject after one read and recover after the fault is cleared", async () => {
  for (const component of ["usage", "spend"] as const) {
    const f = await fixture();
    const before: View = await f.probe.ask({ op: "get", freeze: true });
    const file = f[component].split("/").at(-1)!;
    await f.probe.ask({ op: "fault", file, code: "EACCES", count: 5 });
    await expect(f.probe.ask({ op: "get", force: true })).rejects.toThrow("injected EACCES read failure");
    const failed: View = await f.probe.ask({ op: "last" });
    expect(failed.ids).toEqual(before.ids);
    expect(failed.reads[file]).toBe(before.reads[file]! + 1);
    await f.probe.ask({ op: "fault", file, code: "EACCES", count: 0 });
    const restored: View = await f.probe.ask({ op: "get", force: true });
    await oracle(f, restored);
  }
}, 30_000);

test("repeated ENOENT/ENOTDIR read races are bounded to three attempts and recover without publishing failed snapshots", async () => {
  for (const code of ["ENOENT", "ENOTDIR"]) {
    for (const component of ["usage", "spend", "quota"] as const) {
      const f = await fixture();
      const before: View = await f.probe.ask({ op: "get", freeze: true });
      const file = f[component].split("/").at(-1)!;
      await f.probe.ask({ op: "fault", file, code, count: 3 });
      await expect(f.probe.ask({ op: "get", force: true })).rejects.toThrow(`injected ${code} read failure`);
      const failed: View = await f.probe.ask({ op: "last" });
      expect(failed.ids).toEqual(before.ids);
      expect(failed.dataset).toEqual(before.dataset);
      expect(failed.reads[file]).toBe(before.reads[file]! + 3);
      const recovered: View = await f.probe.ask({ op: "get", force: true });
      expect(recovered.ids.dataset).not.toBe(before.ids.dataset);
      await oracle(f, recovered);
    }
  }
}, 30_000);

test("file changes during a held read cannot poison the next unchanged poll with stale bytes", async () => {
  const f = await fixture();
  await f.probe.ask({ op: "get", freeze: true });
  await touch(f.usage, JSON.stringify(entry("racing-a")));
  await f.probe.ask({ op: "begin" });
  await touch(f.usage, JSON.stringify(entry("racing-b")) + "\n" + JSON.stringify(entry("racing-c")));
  await f.probe.ask({ op: "join" });
  const completed = await f.probe.ask({ op: "finish" });
  expect(completed.previousUnchanged).toBe(true);
  if (completed.statuses.every((status: string) => status === "fulfilled")) await oracle(f, completed);
  // A bounded retry or rejection is acceptable; stale caching after that is not.
  const after: View = await f.probe.ask({ op: "get" });
  expect(after.dataset.rows.map(row => row.id)).toEqual(["racing-b", "racing-c"]);
  await oracle(f, after);
}, 30_000);

test("missing, corrupt and restored quota/spend components preserve baseline behavior", async () => {
  const f = await fixture();
  await f.probe.ask({ op: "get" });
  for (const mutation of [async () => touch(f.quota, "{torn"), async () => rm(f.quota), async () => touch(f.quota, quota(75)), async () => rm(f.spend), async () => touch(f.spend, 'bad\n \n' + JSON.stringify({ kind: "settle", at: epoch, tokens: 12 }))]) {
    await mutation(); const result: View = await f.probe.ask({ op: "get" }); await oracle(f, result);
  }
}, 30_000);

const query = `from=${epoch - 3_600_000}&to=${epoch}&bucket=hour&metric=cost&groupBy=provider`;
const selected = new Date(epoch - 60_000);
const heatmapQuery = `from=${epoch - 8 * 86_400_000}&to=${epoch}&weekday=${(selected.getUTCDay() + 6) % 7}&hour=${selected.getUTCHours()}&metric=tokens&limit=1`;
const paths = [
  "/api/health", "/api/meta", ...["overview", "usage", "cost", "performance", "reliability", "models", "quota", "conversations", "timeseries", "ledger", "filters"].map(route => `/api/${route}?${query}`),
  "/api/conversations/c1", "/api/conversations/missing", `/api/usage/heatmap-dates?${heatmapQuery}&offset=0`, `/api/usage/heatmap-dates?${heatmapQuery}&offset=1`,
  `/api/quota?from=${epoch - 60_000}&to=${epoch}`,
  `/api/overview?${query}&models=unpriced&search=unpriced&statuses=ok`, `/api/usage?${query}&providers=test-provider&efforts=high&routeKinds=native`,
  `/api/conversations?${query}&sort=recent&limit=1`, ...["requests", "models", "conversations"].map(dataset => `/api/export?${query}&dataset=${dataset}`),
];
function apiComparable(responses: any[]) {
  return responses.map(({ etag: _etag, ...response }) => {
    if (response.path === "/api/health") {
      const { builtAt: _builtAt, parseMs: _parseMs, revision: _revision, ...body } = response.body;
      return { ...response, body };
    }
    if (response.path === "/api/meta") {
      const { builtAt: _builtAt, parse, revision: _revision, ...body } = response.body;
      return { ...response, body: { ...body, parse: { malformedLines: parse.malformedLines } } };
    }
    return response;
  });
}

test("all tab/detail API payloads, heatmap pagination, filters and CSV match baseline before/after reuse; ETags invalidate quota/spend/usage", async () => {
  const f = await fixture();
  await appendFile(f.usage, JSON.stringify(entry("last-week", epoch - 7 * 86_400_000 - 60_000)) + "\n");
  await f.probe.ask({ op: "get", freeze: true });
  async function compare() {
    const original = await new Probe(baseline, f.home, f.pricing).ready();
    const actual = await f.probe.ask({ op: "api", paths });
    const expected = await original.ask({ op: "api", paths });
    expect(apiComparable(actual)).toEqual(apiComparable(expected));
    const heatmap = actual.filter((response: any) => response.path.startsWith("/api/usage/heatmap-dates"));
    expect(heatmap[0].body.totalDates).toBe(2);
    expect(heatmap[0].body.dates).toHaveLength(1);
    expect(heatmap[0].body.hasMore).toBe(true);
    expect(heatmap[1].body.dates).toHaveLength(1);
    expect(heatmap[1].body.hasMore).toBe(false);
    expect(heatmap[1].body.dates[0].date).not.toBe(heatmap[0].body.dates[0].date);
    expect(actual.find((response: any) => response.path === `/api/quota?from=${epoch - 60_000}&to=${epoch}`).body.series[0].baselineIncluded).toBe(true);
    const csv = actual.find((response: any) => response.path === `/api/export?${query}&dataset=requests`);
    expect(csv.type).toContain("text/csv");
    expect(csv.body).toContain("零-🙂");
    expect(csv.body).toContain('"comma,""雪"""');
    original.stop();
    return actual.find((response: any) => response.path === `/api/overview?${query}`);
  }
  let overview = await compare();
  for (const mutation of [async () => touch(f.quota, quota(85)), async () => touch(f.spend, JSON.stringify({ kind: "settle", at: epoch, tokens: 999 })), async () => appendFile(f.usage, JSON.stringify(entry("api-append")))]) {
    expect((await f.probe.ask({ op: "api", paths: [overview.path], etag: overview.etag }))[0]).toMatchObject({ status: 304, body: "" });
    await mutation();
    const changed = (await f.probe.ask({ op: "api", paths: [overview.path], etag: overview.etag }))[0];
    expect(changed.status).toBe(200);
    expect(changed.etag).not.toBe(overview.etag);
    overview = await compare();
  }
}, 60_000);
