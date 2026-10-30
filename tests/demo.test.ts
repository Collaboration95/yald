import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runDemo, parseDemoArgs } from "../scripts/demo.mjs";
import { generateDemo } from "../scripts/demo/generate.mjs";

const sourceRoot = resolve(import.meta.dir, ".."), runtime = process.execPath;
const guardPath = join(sourceRoot, "tests/helpers/demo-guard.mjs");
let root: string;
const node = Bun.which("node")!;
const fixed = Date.parse("2026-10-20T12:00:00Z");
const owned = new Set<string>();
afterAll(async () => { for (const dir of owned) await rm(dir, { recursive: true, force: true }); });
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "yald-o02-test-")); owned.add(dir); return dir; };
// Exercise unchanged runtime files in a private package layout. A tiny shell is
// enough for server/API/lifecycle tests; real UI assets are checked after build
// by smoke and installed-package verification. Never write to source web/dist.
async function packageFixture(withWebAssets = true) {
  const directory = await temp();
  for (const name of ["server", "scripts"]) await mkdir(join(directory, name));
  for (const path of ["package.json", "server/src", "scripts/yald.mjs", "scripts/demo.mjs", "scripts/demo"]) {
    await cp(join(sourceRoot, path), join(directory, path), { recursive: true });
  }
  await symlink(join(sourceRoot, "node_modules"), join(directory, "node_modules"), "dir");
  if (withWebAssets) {
    await mkdir(join(directory, "web/dist"), { recursive: true });
    await writeFile(join(directory, "web/dist/index.html"), "<!doctype html><html><head><title>Demo server test fixture</title></head><body></body></html>");
  }
  return directory;
}
beforeAll(async () => { root = await packageFixture(); });
const delay = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: () => string, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await delay(); }
  throw new Error(message());
}
async function port() {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const n = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return n;
}
async function get(base: string, path: string) {
  const response = await fetch(base + path);
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}
function start(options: object, injections: any = {}) {
  const signals = new EventEmitter(), logs: string[] = [], errors: string[] = [];
  let child: ReturnType<typeof spawn>;
  const promise = runDemo({ now: fixed, open: false, ...options }, { root, runtime, signals,
    log: (value: string) => logs.push(value), error: (value: string) => errors.push(value),
    ...injections, spawnServer: (...args: Parameters<typeof spawn>) => { child = (injections.spawnServer ?? spawn)(...args); return child; } });
  return { promise, signals, logs, errors, child: () => child,
    async ready() { await until(() => logs.some(line => line.startsWith("Demo ready:")), () => errors.join("\n") || "not ready"); },
    async stop() { signals.emit("SIGINT"); return promise; },
    directory() { return logs.join("\n").match(/Demo data: (.+)/)?.[1]; } };
}
const apiEvidence = (evidence: any, investigation: string, extra: Record<string, string> = {}) => {
  const q = new URL(evidence.href, "http://example.invalid").searchParams;
  q.set("investigation", investigation);
  for (const [key, value] of Object.entries(extra)) q.set(key, value);
  return `/api/labs/evidence?${q}`;
};

test("demo help/invalid args exit before runtime/data; normal and report help still work", async () => {
  const cases = [
    [["demo", "--help"], 0, "--now ISO"], [["--help"], 0, "yald demo"], [["report", "--help"], 0, "yald report [window]"],
    [["demo", "--port", "0"], 2, "1 to 65535"], [["demo", "--port", "65536"], 2, "1 to 65535"],
    [["demo", "--port"], 2, "requires a value"], [["demo", "--now", "2026-10-20"], 2, "ISO timestamp"],
    [["demo", "--ocx-home", "/synthetic"], 2, "Unknown demo argument"], [["demo", "--open", "--open"], 2, "Duplicate"],
  ] as const;
  // Bound subprocess fan-out even when the outer suite runner has other workers.
  for (let offset = 0; offset < cases.length; offset += 3) {
    const batch = await Promise.all(cases.slice(offset, offset + 3).map(async ([args, code, text]) => {
      const child = Bun.spawn([node, join(root, "scripts/yald.mjs"), ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, actualCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { args, code, text, actualCode, output: stdout + stderr };
    }));
    // Reap every child before asserting, including when one argument case fails.
    for (const { args, code, text, actualCode, output } of batch) {
      expect(actualCode, args.join(" ")).toBe(code);
      expect(output, args.join(" ")).toContain(text);
      expect(output, args.join(" ")).not.toContain("Demo data:");
    }
  }
  expect(parseDemoArgs(["--now", "2026-10-20T20:00:00+08:00"]).now).toBe(fixed);
});

test("real demo APIs reconcile current/prior, cache +/-/0/unknown, context gaps/zero/collisions and exact evidence", async () => {
  const n = await port(), base = `http://127.0.0.1:${n}`, demo = start({ port: n });
  try {
    await demo.ready();
    const shell = await (await fetch(base + "/labs/project-radar")).text();
    expect(shell).toContain("Demo server test fixture");
    expect(shell).toContain('id="yald-demo"');
    const meta = await get(base, "/api/meta"), overview = await get(base, "/api/overview");
    expect(meta.demo).toMatchObject({ synthetic: true, clock: "fixed", now: fixed, sampleAt: fixed });
    expect(meta.sources).toEqual(["claude-code", "ocx"]);
    expect(meta.totals.requests).toBe(83);
    expect(meta.pricing.detail).toContain("illustrative");
    expect(overview.window).toMatchObject({ from: fixed - 30 * 86400000, to: fixed, requests: 42 });
    expect(overview.prior.requests).toBe(40);
    expect(overview.summary.unobserved).toBe(7); // Claude does not claim measured success.
    const radar = await get(base, "/api/labs/projects");
    expect(radar.priorWindow.to).toBe(radar.window.from);
    expect(radar.projects.find((p: any) => p.project.endsWith("synthetic-orbit")).folders.some((p: string) => p.endsWith("/server"))).toBe(true);
    expect(radar.projects.some((p: any) => p.current.totals.requests === 0 && p.prior.totals.requests > 0)).toBe(true);
    for (const period of ["current", "prior"]) {
      const ev = await get(base, apiEvidence(radar.current.evidence, "project-radar", { priorSelector: JSON.stringify(radar.prior.evidence.selector), period }));
      expect(ev.population.evidence.requests).toBe(radar[period].totals.requests);
      expect(ev.population.evidence.tokens).toBe(radar[period].totals.tokens);
      expect(ev.observation.comparison).toEqual(radar.comparison);
    }
    const cache = await get(base, "/api/labs/cache");
    expect(cache.totals).toMatchObject({ totalRequests: 42, eligibleRequests: 37, netUsd: -0.03514, actualUsd: 0.83474 });
    expect(cache.sessions.find((s: any) => s.conversationId === "synthetic-write-premium")).toMatchObject({ netUsd: -0.14, direction: "cost" });
    expect(cache.sessions.some((s: any) => s.netUsd > 0 && s.direction === "benefit")).toBe(true);
    expect(cache.sessions.find((s: any) => s.conversationId === "synthetic-no-cache")).toMatchObject({ netUsd: 0, direction: "even" });
    expect(cache.sessions.find((s: any) => s.conversationId === "synthetic-zero-price")).toMatchObject({ actualUsd: 0, eligibleRequests: 7, explicitFreeRequests: 7 });
    expect(cache.totals.excluded).toMatchObject({ unpriced: 1, "cache-unknown": 1, "cache-unmeasured": 1, "input-missing": 1, "attempt-sum": 1 });
    const ce = await get(base, apiEvidence(cache.totals.evidence, "cache-detective"));
    expect(ce.population.evidence.pricedCostUsd).toBe(cache.totals.actualUsd);
    expect(ce.rows).toHaveLength(37);
    expect(ce.population.original.requests).toBe(42);
    const context = await get(base, "/api/labs/context");
    const growing = context.sessions.find((s: any) => s.excludedRequests === 2);
    expect(growing.growth).toMatchObject({ ranked: true, baseline: 2000, latest: 7000, absoluteChange: 5000 });
    expect(growing.eligibleRequests).toBe(7);
    expect(growing.requests.some((r: any) => r.inputTokens === 0)).toBe(true);
    expect(growing.requests.filter((r: any) => r.inputTokens === null)).toHaveLength(2);
    const collision = context.sessions.find((s: any) => s.source === "claude-code" && s.conversationId === growing.conversationId);
    expect(collision.growth).toMatchObject({ ranked: true, baseline: 7000, latest: 2000, absoluteChange: -5000 });
    const xe = await get(base, apiEvidence(growing.evidence, "context-replay"));
    expect(xe.rows).toHaveLength(9);
    expect(xe.rows.every((r: any) => r.source === "ocx")).toBe(true);
    expect(xe.population.excludedRequests).toBe(2);
    expect(xe.rows.find((r: any) => r.id === "demo-orbit-0")).toMatchObject({ inputTokens: 1000, rateIn: 2, rateCacheRead: 0.2 });
    const quota = await get(base, "/api/quota");
    expect(JSON.stringify(quota)).toContain("synthetic-demo-account");
    await get(base, "/api/dataset/refresh");
  } finally { expect(await demo.stop()).toBe(130); }
  expect(existsSync(demo.directory()!)).toBe(false);
  expect(demo.signals.listenerCount("SIGINT")).toBe(0);
  expect(demo.child().exitCode).toBe(0);
}, 20000);

test("demo without web assets fails before readiness and cleans only its data", async () => {
  const missingRoot = await packageFixture(false), n = await port();
  let opens = 0, stderr = "";
  const demo = start({ port: n, open: true }, { root: missingRoot, openUrl: () => { opens++; },
    spawnServer: (rt: string, args: string[], opts: any) => {
      const child = spawn(rt, args, { ...opts, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      child.stderr!.on("data", chunk => stderr += String(chunk));
      return child;
    } });
  try {
    expect(await demo.promise).toBe(1);
    expect(stderr).toContain("Demo web assets are missing. Reinstall the built Yald package.");
    expect(demo.errors.join(" ")).toContain("before ready");
    expect(demo.logs.some(line => line.startsWith("Demo ready:"))).toBe(false);
    expect(opens).toBe(0);
    expect(existsSync(demo.directory()!)).toBe(false);
    expect(existsSync(missingRoot)).toBe(true);
    await expect(fetch(`http://127.0.0.1:${n}/api/health`)).rejects.toThrow();
  } finally { await demo.stop(); }
}, 15000);

test("default sample anchor is fresh wall time and API windows follow the wall clock to the quantum", async () => {
  const n = await port(), started = Date.now(), demo = start({ port: n, now: null });
  try {
    await demo.ready();
    const base = `http://127.0.0.1:${n}`, meta = await get(base, "/api/meta"), first = await get(base, "/api/window");
    expect(meta.demo.clock).toBe("wall");
    expect(meta.demo.now).toBeNull();
    expect(meta.demo.sampleAt).toBeGreaterThanOrEqual(started);
    expect(meta.demo.sampleAt).toBeLessThanOrEqual(Date.now());
    expect(meta.lastRequestAt).toBe(meta.demo.sampleAt - 60000);
    await delay(30);
    const asked = Date.now();
    const second = await get(base, "/api/window");
    // A wall-clock demo is not pinned: rolling windows end on the wall clock rounded down to
    // the 10 s quantum (docs/api.md), so they never run ahead of it and lag it by under 10 s.
    expect(second.window.to).toBeGreaterThanOrEqual(first.window.to);
    expect(second.window.to % 10_000).toBe(0);
    expect(second.window.to).toBeLessThanOrEqual(Date.now());
    expect(asked - second.window.to).toBeLessThan(10_000);
  } finally { await demo.stop(); }
}, 15000);

test("occupied health listener cannot satisfy owned readiness or trigger opener; only own data is removed", async () => {
  let requests = 0, opens = 0;
  const other = httpServer((_req, res) => { requests++; res.end('{"ok":true}'); });
  await new Promise<void>(resolve => other.listen(0, "127.0.0.1", resolve));
  const n = (other.address() as { port: number }).port;
  const demo = start({ port: n, open: true }, { openUrl: () => { opens++; } });
  try {
    expect(await demo.promise).toBe(1);
    expect(opens).toBe(0);
    expect(requests).toBe(0); // no health-probe race with the existing server
    expect(demo.errors.join(" ")).toContain("before ready");
    expect(existsSync(demo.directory()!)).toBe(false);
    expect((await fetch(`http://127.0.0.1:${n}/api/health`)).ok).toBe(true);
  } finally { await new Promise<void>(resolve => other.close(() => resolve())); }
}, 15000);

test("injected opener sees exact owned ready API; opener failure prints manual URL; shutdown waits for child", async () => {
  const n = await port();
  let opens = 0;
  const demo = start({ port: n, open: true }, { openUrl: async (url: string) => {
    expect((await get(url, "/api/meta")).demo.synthetic).toBe(true);
    opens++; throw new Error("synthetic unavailable opener");
  } });
  try {
    await demo.ready();
    await until(() => demo.errors.length > 0, () => "no opener failure");
    expect(opens).toBe(1);
    expect(demo.errors[0]).toContain(`Open http://127.0.0.1:${n} manually`);
    expect(existsSync(demo.directory()!)).toBe(true);
  } finally { await demo.stop(); }
  expect(existsSync(demo.directory()!)).toBe(false);
  await expect(fetch(`http://127.0.0.1:${n}/api/health`)).rejects.toThrow();
}, 15000);

test("interrupt while generating or before ready, startup timeout and forged ready messages never open", async () => {
  const early = start({ port: await port(), open: true }, { openUrl: () => { throw new Error("must not open"); } });
  expect(await early.stop()).toBe(130);
  expect(early.logs).toHaveLength(0);
  const fixture = await temp(), slow = join(fixture, "slow.mjs");
  await writeFile(slow, `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100)); process.send({type:'yald-demo-ready',token:'forged',port:123}); setInterval(()=>{},1000);`);
  for (const timeout of [false, true]) {
    let opens = 0;
    const demo = start({ port: await port(), open: true }, { startupMs: timeout ? 250 : 10000,
      openUrl: () => { opens++; }, spawnServer: (_runtime: string, _args: string[], opts: object) => spawn(node, [slow], opts) });
    try {
      await until(() => !!demo.child(), () => "child not spawned");
      if (!timeout) await demo.stop();
      expect(await demo.promise).toBe(timeout ? 1 : 130);
      expect(opens).toBe(0);
      expect(demo.logs.some(line => line.startsWith("Demo ready:"))).toBe(false);
      expect(existsSync(demo.directory()!)).toBe(false);
      expect(demo.child().exitCode !== null || demo.child().signalCode !== null).toBe(true);
    } finally { await demo.stop(); }
  }
}, 15000);

test("contaminated caller homes/.env/config/global pricing and retained Claude archive are unread and unchanged", async () => {
  const sentinel = await temp(), receipt = join(await temp(), "reads.txt");
  const files = [".opencodex/usage.jsonl", ".opencodex/yald-claude-usage.jsonl", ".opencodex/config.json",
    ".claude/projects/sentinel/session.jsonl", ".codex/sessions/rollout-sentinel.jsonl", ".env",
    "global-pricing/src/usage/cost.ts", ".bun/install/global/node_modules/@bitkyc08/opencodex/src/usage/cost.ts"];
  for (const file of files) {
    await mkdir(join(sentinel, file, ".."), { recursive: true });
    await writeFile(join(sentinel, file), file.includes("cost.ts") ? `throw new Error("SENTINEL GLOBAL ENGINE IMPORTED");` : JSON.stringify({ syntheticSentinel: file }));
  }
  await writeFile(join(sentinel, ".opencodex/yald-claude-usage.jsonl"), JSON.stringify({ requestId: "synthetic-sentinel-retained-claude",
    timestamp: fixed - 60000, inboundProtocol: "claude-code", provider: "synthetic-sentinel", model: "demo-orbit",
    conversationId: "synthetic-sentinel", usage: { inputTokens: 900000, outputTokens: 200 },
    usagePresence: { input: true, output: true, cacheRead: false, cacheWrite: false } }) + "\n");
  await writeFile(join(sentinel, ".env"), `OCX_HOME=${join(sentinel, ".opencodex")}\nOCX_PACKAGE_DIR=${join(sentinel, "global-pricing")}\n`);
  const snapshot = async () => Promise.all(files.map(async file => { const path = join(sentinel, file), s = await stat(path);
    return { file, hash: createHash("sha256").update(await readFile(path)).digest("hex"), mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, size: s.size }; }));
  const before = await snapshot(), n = await port();
  const contaminated = { HOME: sentinel, USERPROFILE: sentinel, OCX_HOME: join(sentinel, ".opencodex"),
    CODEX_HOME: join(sentinel, ".codex"), CLAUDE_PROJECTS_DIR: join(sentinel, ".claude/projects"),
    OCX_PACKAGE_DIR: join(sentinel, "global-pricing"), NODE_OPTIONS: "--require=/sentinel-invalid", BUN_OPTIONS: "--preload=/sentinel-invalid" };
  const old = Object.fromEntries(Object.keys(contaminated).map(key => [key, process.env[key]]));
  const callerCwd = process.cwd();
  process.chdir(sentinel);
  Object.assign(process.env, contaminated);
  const guard = JSON.stringify({ forbidden: sentinel, receipt, packageRoot: root });
  const demo = start({ port: n }, { spawnServer: (rt: string, args: string[], opts: any) => {
    expect(opts.env.HOME).not.toBe(sentinel);
    expect(opts.env.OCX_HOME).not.toBe(contaminated.OCX_HOME);
    expect(opts.env.NODE_OPTIONS).toBeUndefined();
    return spawn(rt, [args[0], `--preload=${guardPath}`, ...args.slice(1)], {
      ...opts, env: { ...opts.env, YALD_TEST_DEMO_GUARD: guard },
    });
  } });
  try {
    await demo.ready();
    const meta = await get(`http://127.0.0.1:${n}`, "/api/meta");
    expect(meta.totals.requests).toBe(83);
    expect(meta.ocxHome.startsWith(demo.directory())).toBe(true);
    expect(existsSync(join(meta.ocxHome, "yald-claude-usage.jsonl"))).toBe(true);
    await get(`http://127.0.0.1:${n}`, "/api/labs/projects");
    expect(await readFile(receipt, "utf8")).not.toContain("forbidden path");
    expect(await readFile(receipt, "utf8")).toContain("guard active");
  } finally {
    await demo.stop();
    process.chdir(callerCwd);
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  expect(await snapshot()).toEqual(before);
  // Prove the guard catches the actual retained-archive path even with empty transcripts.
  const empty = await temp();
  const control = Bun.spawn([runtime, "--no-env-file", `--preload=${guardPath}`, "-e",
    `await import(${JSON.stringify(join(root, "server/src/claude/transcripts.ts"))}).then(m=>m.readClaudeEntries())`], {
    cwd: empty, env: { HOME: empty, OCX_HOME: contaminated.OCX_HOME, CLAUDE_PROJECTS_DIR: empty,
      CODEX_HOME: empty, YALD_TEST_DEMO_GUARD: guard }, stdout: "pipe", stderr: "pipe" });
  expect(await control.exited).toBe(99);
  expect(await new Response(control.stderr).text()).toContain("yald-claude-usage.jsonl");
  // Missing explicit pricing must stop before global probes, even with a usable
  // decoy global package and npm present. Removing the guard from env.ts fails this.
  const discovery = Bun.spawn([runtime, "--no-env-file", `--preload=${guardPath}`, "-e",
    `const m=await import(${JSON.stringify(join(root, "server/src/env.ts"))}); if(m.ocxPackageDir()!==null)process.exit(98);`], {
    cwd: empty, env: { HOME: sentinel, OCX_HOME: empty, CLAUDE_PROJECTS_DIR: empty, CODEX_HOME: empty,
      YALD_DEMO: "1", OCX_PACKAGE_DIR: join(empty, "missing-explicit"), YALD_TEST_DEMO_GUARD: guard }, stdout: "pipe", stderr: "pipe" });
  expect(await discovery.exited).toBe(0);
  expect(await new Response(discovery.stderr).text()).toBe("");
  expect(await snapshot()).toEqual(before);
}, 20000);

test("real Node CLI handles SIGINT during startup and SIGTERM after ready without orphan listeners", async () => {
  for (const afterReady of [false, true]) {
    const n = await port(), cwd = await temp();
    const child = spawn(node, [join(root, "scripts/yald.mjs"), "demo", "--port", String(n)], { cwd, stdio: "pipe" });
    let output = "", errors = "", sent = false;
    const closed = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
    child.stderr.on("data", chunk => errors += String(chunk));
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (!sent && output.includes(afterReady ? "Demo ready:" : "Demo data:")) {
        sent = true; child.kill(afterReady ? "SIGTERM" : "SIGINT");
      }
    });
    try {
      await until(() => sent, () => errors || output);
      expect(await closed).toBe(130);
      const directory = output.match(/Demo data: (.+)/)?.[1];
      expect(directory).toBeDefined();
      expect(existsSync(directory!)).toBe(false);
      expect(existsSync(cwd)).toBe(true);
      if (!afterReady) expect(output).not.toContain("Demo ready:");
      await expect(fetch(`http://127.0.0.1:${n}/api/health`)).rejects.toThrow();
    } finally { if (child.exitCode === null) child.kill("SIGTERM"); await closed; }
  }
}, 15000);

test("spawn error and forced termination clean only owned paths", async () => {
  const failing = start({ port: await port() }, { runtime: "/synthetic-missing-runtime" });
  expect(await failing.promise).toBe(1);
  expect(failing.errors.join(" ")).toContain("Could not start demo");
  expect(existsSync(failing.directory()!)).toBe(false);
  const folder = await temp(), slow = join(folder, "ignore.mjs");
  await writeFile(slow, `process.on('SIGTERM',()=>{}); process.send({alive:true}); setInterval(()=>{},1000);`);
  const forced = start({ port: await port() }, { shutdownMs: 60,
    spawnServer: (_rt: string, _args: string[], opts: object) => spawn(node, [slow], opts) });
  try {
    await until(() => !!forced.child(), () => "no child");
    await new Promise(resolve => forced.child().once("message", resolve));
    expect(await forced.stop()).toBe(130);
    expect(forced.child().signalCode).toBe("SIGKILL");
    expect(existsSync(forced.directory()!)).toBe(false);
    expect(existsSync(slow)).toBe(true);
  } finally { await forced.stop(); }
}, 15000);

test("normal installed-style dashboard and report keep explicit empty source behavior", async () => {
  const folder = await temp(), inputs = await generateDemo(folder, fixed), n = await port();
  for (const name of ["usage.jsonl", "spend-ledger.jsonl", "codex-quota-cache.json"]) await rm(join(inputs.OCX_HOME, name));
  await rm(inputs.CLAUDE_PROJECTS_DIR, { recursive: true });
  await mkdir(inputs.CLAUDE_PROJECTS_DIR);
  const env = { ...inputs, PATH: process.env.PATH, YALD_TZ: "UTC", TZ: "UTC", YALD_HOST: "127.0.0.1", YALD_PORT: String(n) };
  const child = spawn(node, [join(root, "scripts/yald.mjs")], { env, detached: true, stdio: "pipe" });
  let errors = "";
  child.stdout.resume(); child.stderr.on("data", chunk => errors += String(chunk));
  const closed = new Promise(resolve => child.once("close", resolve));
  try {
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${n}/api/health`)).ok; } catch { return false; } }, () => errors);
    const meta = await get(`http://127.0.0.1:${n}`, "/api/meta");
    expect(meta.totals.requests).toBe(0);
    expect(meta.demo).toBeUndefined();
    expect(meta.ocxHome).toBe(inputs.OCX_HOME);
    const report = Bun.spawn([node, join(root, "scripts/yald.mjs"), "report", "--last", "1h", "--dry-run"], { env, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(report.stdout).text();
    expect(await report.exited).toBe(0);
    expect(output).toContain("claude-code  ocx  total");
    expect(output).toMatch(/\(no phases\).*0\s+0\s+0/);
    expect(output).toContain("Nothing written (--dry-run)");
  } finally { process.kill(-child.pid!, "SIGTERM"); await closed; }
  await expect(fetch(`http://127.0.0.1:${n}/api/health`)).rejects.toThrow();
  expect(existsSync(inputs.OCX_HOME)).toBe(true);
}, 15000);
