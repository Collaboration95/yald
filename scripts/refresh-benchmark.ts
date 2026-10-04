/** Fresh-process, balanced HTTP comparison using identical synthetic ledgers. */
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { cpus, release, totalmem, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { materializeFixtureHome } from "../web/scripts/fixtureHome";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith("--") || !process.argv[i + 1]) throw new Error("Expected --option value");
  args.set(process.argv[i]!.slice(2), process.argv[i + 1]!);
}
const baseline = resolve(args.get("baseline") ?? "/private/tmp/yald-relay-pr1-baseline");
const candidate = resolve(args.get("candidate") ?? join(import.meta.dir, ".."));
const out = resolve(args.get("out") ?? "docs/benchmarks/relay-refresh/batch-1");
const pairs = Number(args.get("pairs") ?? 50);
const rowCount = Number(args.get("rows") ?? 66_000);
const epoch = Date.parse(args.get("epoch") ?? "2026-10-02T10:00:00Z");
const tz = args.get("tz") ?? "Asia/Singapore";
const pricingPackage = resolve(args.get("pricing-package") ?? "/opt/homebrew/lib/node_modules/@bitkyc08/opencodex");
const timeoutMs = Number(args.get("timeout-ms") ?? 30_000);
const scenarios = (args.get("scenarios") ?? "quota-health,quota-overview,spend-health,unchanged-overview,usage-append-health,forced-refresh").split(",");
const allowed = new Set(["quota-health", "quota-overview", "spend-health", "unchanged-overview", "usage-append-health", "forced-refresh"]);
if (scenarios.some(s => !allowed.has(s)) || !Number.isInteger(pairs) || pairs < 1 || !Number.isInteger(rowCount) || rowCount < 98 || !Number.isFinite(epoch)) throw new Error("Invalid experiment options");
const overviewPath = `/api/overview?from=${epoch - 30 * 86_400_000}&to=${epoch}&bucket=day&metric=tokens&groupBy=model`;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const jsonHash = (value: unknown) => hash(JSON.stringify(value));
const files = ["usage.jsonl", "spend-ledger.jsonl", "codex-quota-cache.json"];
const git = (root: string, ...args: string[]) => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
async function source(root: string) {
  const code = ["server/src/ocx/store.ts", "server/src/ocx/pricing.ts", "server/src/api.ts", "server/src/analytics.ts", "bun.lock"];
  const hashes = Object.fromEntries(await Promise.all(code.map(async file => [file, hash(await readFile(join(root, file)))])));
  const assets = (await readdir(join(root, "web/dist/assets"))).sort();
  const buildHashes = Object.fromEntries(await Promise.all(assets.map(async file => [file, hash(await readFile(join(root, "web/dist/assets", file)))])));
  return { root, commit: git(root, "rev-parse", "HEAD"), diffHash: hash(git(root, "diff", "HEAD", "--", "server")), hashes, buildHashes };
}
async function timedFetch(base: string, path: string, etag?: string) {
  const start = performance.now();
  try {
    const response = await fetch(base + path, { headers: etag ? { "if-none-match": etag } : {}, signal: AbortSignal.timeout(timeoutMs) });
    const bytes = await response.arrayBuffer();
    const ms = performance.now() - start;
    return { status: response.status, etag: response.headers.get("etag"), ms, body: bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : null };
  } catch (error) {
    throw Object.assign(new Error(String(error)), { requestElapsedMs: performance.now() - start });
  }
}
async function server(root: string, home: string) {
  const child = spawn(process.execPath, [join(import.meta.dir, "refresh-benchmark-server.ts")], {
    cwd: root,
    env: { ...process.env, YALD_BENCH_ROOT: root, YALD_BENCH_EPOCH: String(epoch), OCX_HOME: home, CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), OCX_PACKAGE_DIR: pricingPackage, TZ: tz, YALD_TZ: tz, YALD_HOST: "127.0.0.1", YALD_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const lines = createInterface({ input: child.stdout });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const ready = new Promise<{ port: number; pid: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server readiness timeout: ${stderr}`)), timeoutMs);
    lines.on("line", line => {
      if (line.startsWith("YALD_BENCH_READY ")) { clearTimeout(timer); resolve(JSON.parse(line.slice(17))); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited; clearTimeout(timer); lines.close();
  };
  try { const address = await ready; return { ...address, base: `http://127.0.0.1:${address.port}`, stop }; }
  catch (error) { await stop(); throw error; }
}

await mkdir(out, { recursive: true });
// Never replace an earlier run, including a failed one.
try { await writeFile(join(out, "samples.jsonl"), "", { flag: "wx" }); } catch { throw new Error("Output already contains a run; choose a new --out"); }
const scratch = await mkdtemp(join(tmpdir(), "yald-refresh-bench-"));
let master: string | undefined;
const samples: Record<string, any>[] = [];
const manifest: Record<string, any> = { startedAt: new Date().toISOString(), pairs, rowCount, scenarios, epoch, tz, timeoutMs, ordering: "alternating AB/BA pairs; serial processes", materialityTarget: "quota Overview p50 at least 20% and 10ms lower, confirmed in a second batch", cachePolicy: "fresh app/process per sample; warm OS file cache; uninstrumented HTTP; startup, priming, copy/mutation and correctness checks excluded", timing: "loopback HTTP request through complete body consumption; JSON parsing excluded; no browser/reload timing", hardware: { platform: process.platform, arch: process.arch, os: release(), cpus: cpus().map(c => c.model), memoryBytes: totalmem() }, runtime: { bun: Bun.version, executable: process.execPath }, background: "owned preview idle; no concurrent benchmark/build/test process", excludedWarmups: "server boot plus one Overview and one health request before each mutation", correctness: "complete Overview payload SHA256 equality within every A/B pair; expected status, ETag transition, quota, row and malformed counts; isolated full-parser tests cover every normalized row" };
try {
  manifest.harness = Object.fromEntries(await Promise.all(["refresh-benchmark.ts", "refresh-benchmark-server.ts"].map(async file => [file, hash(await readFile(join(import.meta.dir, file)))])));
  manifest.sources = { baseline: await source(baseline), candidate: await source(candidate) };
  if (jsonHash(manifest.sources.baseline.buildHashes) !== jsonHash(manifest.sources.candidate.buildHashes)) throw new Error("Frontend builds differ");
  const originalNow = Date.now;
  try { Date.now = () => epoch; master = await materializeFixtureHome(); } finally { Date.now = originalNow; }
  const templates = (await readFile(join(master, "usage.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const large = Array.from({ length: rowCount }, (_, index) => JSON.stringify({ ...templates[index % templates.length], requestId: `benchmark-${index}` })).join("\n") + "\n";
  await writeFile(join(master, "usage.jsonl"), large);
  const fixture = Object.fromEntries(await Promise.all(files.map(async file => { const bytes = await readFile(join(master!, file)); return [file, { bytes: bytes.length, sha256: hash(bytes) }]; })));
  manifest.fixture = fixture;
  const ledgerTokens = (await readFile(join(master, files[1]!), "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(event => event.kind === "settle").reduce((sum, event) => sum + event.tokens, 0);
  const pricingFiles = ["package.json", "src/usage/cost.ts", "src/usage/user-cost-overlays.ts", "src/usage/model-identity.ts"];
  manifest.pricing = { root: pricingPackage, version: JSON.parse(await readFile(join(pricingPackage, "package.json"), "utf8")).version, hashes: Object.fromEntries(await Promise.all(pricingFiles.map(async file => [file, hash(await readFile(join(pricingPackage, file)))]))) };
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const home = join(scratch, "home"); await mkdir(home);
  async function trial(revision: string, root: string, scenario: string, pair: number, order: number) {
    const record: Record<string, any> = { revision, scenario, pair, order, expectedRows: rowCount + (scenario === "usage-append-health" ? 1 : 0), attemptedAt: new Date().toISOString(), error: null };
    let app: Awaited<ReturnType<typeof server>> | undefined;
    const attemptStart = performance.now();
    try {
      for (const file of files) {
        await copyFile(join(master!, file), join(home, file), constants.COPYFILE_FICLONE);
        await utimes(join(home, file), epoch / 1000, epoch / 1000);
      }
      app = await server(root, home); record.pid = app.pid;
      const primed = await timedFetch(app.base, overviewPath);
      const initial = await timedFetch(app.base, "/api/health");
      if (primed.status !== 200 || initial.body.rows !== rowCount || initial.body.malformedLines !== 0 || !initial.body.pricing.available) throw new Error("Invalid priming response or unavailable real pricing");
      record.initialEtag = primed.etag;
      record.pricing = initial.body.pricing;
      if (scenario.startsWith("quota-")) {
        const path = join(home, files[2]!);
        const quota = JSON.parse(await readFile(path, "utf8"));
        quota.quotas.__main__.weeklyPercent = 82;
        quota.mainPolicyQuota.quota.weeklyPercent = 82;
        quota.history.accounts["chatgpt-fixture"].samples.push({ observedAt: epoch, source: "response-header", windows: [{ family: "account", window: "weekly", usedPercent: 82, resetAtMs: epoch + 3 * 86_400_000 }] });
        await writeFile(path, JSON.stringify(quota, null, 2)); await utimes(path, epoch / 1000 + 2, epoch / 1000 + 2);
      } else if (scenario === "spend-health") {
        await appendFile(join(home, files[1]!), JSON.stringify({ kind: "settle", send: "benchmark-new-send", at: epoch, tokens: 123 }) + "\n");
      } else if (scenario === "usage-append-health") {
        await appendFile(join(home, files[0]!), JSON.stringify({ ...templates[0], requestId: "benchmark-appended", timestamp: epoch - 1000 }) + "\n");
      }
      record.path = scenario === "forced-refresh" ? "/api/dataset/refresh" : scenario.endsWith("overview") ? overviewPath : "/api/health";
      const result = await timedFetch(app.base, record.path, scenario.endsWith("overview") ? primed.etag! : undefined);
      Object.assign(record, { ms: result.ms, status: result.status, etag: result.etag });
      const expectedStatus = scenario === "unchanged-overview" ? 304 : 200;
      if (result.status !== expectedStatus) throw new Error(`Unexpected HTTP ${result.status}; expected ${expectedStatus}`);
      const overview = result.status === 200 && scenario === "quota-overview" ? result : await timedFetch(app.base, overviewPath);
      const health = record.path === "/api/health" ? result : await timedFetch(app.base, "/api/health");
      record.parseMs = health.body.parseMs;
      record.rows = health.body.rows;
      record.malformedLines = health.body.malformedLines;
      record.correctnessHash = jsonHash(overview.body);
      if (health.body.rows !== record.expectedRows || health.body.malformedLines !== 0) throw new Error("Wrong rows/malformed count");
      if (overview.body.window.requests !== record.expectedRows || overview.body.summary.requests !== record.expectedRows) throw new Error("Overview omitted requests");
      if (scenario.startsWith("quota-") && overview.body.quota.windows.find((window: any) => window.account === "__main__" && window.window === "weekly")?.usedPercent !== 82) throw new Error("Quota stayed stale");
      if (!["unchanged-overview", "forced-refresh"].includes(scenario) && primed.etag === overview.etag) throw new Error("Mutation failed to invalidate ETag");
      if (scenario === "spend-health") {
        const meta = await timedFetch(app.base, "/api/meta");
        if (meta.body.ledger.settledTokens !== ledgerTokens + 123) throw new Error("Spend stayed stale");
      }
      record.correct = true;
    } catch (error) { record.error = String(error); record.correct = false; record.attemptElapsedMs = performance.now() - attemptStart; if (error && typeof error === "object" && "requestElapsedMs" in error) record.requestElapsedMs = error.requestElapsedMs; }
    finally { await app?.stop(); samples.push(record); await appendFile(join(out, "samples.jsonl"), JSON.stringify(record) + "\n"); }
    if (record.error) throw new Error(record.error);
    return record;
  }
  for (const scenario of scenarios) {
    for (let pair = 0; pair < pairs; pair++) {
      const order = pair % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"];
      const observed = [];
      for (let index = 0; index < order.length; index++) { const revision = order[index]!; observed.push(await trial(revision, revision === "baseline" ? baseline : candidate, scenario, pair, index)); }
      if (observed[0]!.correctnessHash !== observed[1]!.correctnessHash) {
        await appendFile(join(out, "samples.jsonl"), JSON.stringify({ scenario, pair, error: "A/B complete Overview payload mismatch", hashes: observed.map(r => r.correctnessHash) }) + "\n");
        throw new Error("A/B payload mismatch");
      }
      if ((pair + 1) % 10 === 0 || pair + 1 === pairs) console.log(`${scenario}: ${pair + 1}/${pairs} pairs; both payloads identical`);
    }
  }
  const percentile = (values: number[], p: number) => values.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)]!;
  const summary = Object.fromEntries(scenarios.map(scenario => {
    const observations = samples.filter(s => s.scenario === scenario);
    const stats = Object.fromEntries(["baseline", "candidate"].map(revision => { const records = observations.filter(s => s.revision === revision); const values = records.filter(s => !s.error).map(s => s.ms); return [revision, { attempted: records.length, successful: values.length, errors: records.filter(s => s.error).length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), minMs: Math.min(...values), maxMs: Math.max(...values) }]; }));
    const differences = Array.from({ length: pairs }, (_, pair) => { const group = observations.filter(s => s.pair === pair); return group.find(s => s.revision === "baseline")!.ms - group.find(s => s.revision === "candidate")!.ms; });
    return [scenario, { ...stats, pairedMedianDifferenceMs: percentile(differences, .5), p50ReductionPercent: 100 * (stats.baseline.p50Ms - stats.candidate.p50Ms) / stats.baseline.p50Ms }];
  }));
  await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  const finalSources = { baseline: await source(baseline), candidate: await source(candidate) };
  if (jsonHash(finalSources) !== jsonHash(manifest.sources)) throw new Error("Source or build changed during measurement; results are invalid");
  console.log(JSON.stringify(summary, null, 2));
  manifest.completed = true;
} catch (error) { manifest.completed = false; manifest.error = String(error); throw error; }
finally {
  manifest.finishedAt = new Date().toISOString();
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await rm(scratch, { recursive: true, force: true });
  if (master) await rm(master, { recursive: true, force: true });
}
