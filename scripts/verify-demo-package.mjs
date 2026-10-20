#!/usr/bin/env node
// Development verifier: run against an already-installed tarball outside checkout.
// Not shipped. All runtime imports below point into the installed package.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { release, tmpdir, version } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [cliArg, tarballArg, receiptArg, guardArg, manifestArg] = process.argv.slice(2);
if (!guardArg) throw new Error("Usage: node scripts/verify-demo-package.mjs INSTALLED_CLI TARBALL RECEIPT_JSON tests/helpers/demo-guard.mjs [MANIFEST_JSON]");
const cli = await realpath(cliArg), root = dirname(dirname(cli)), tarball = resolve(tarballArg), out = resolve(receiptArg), guard = resolve(guardArg);
const artifact = await mkdtemp(join(tmpdir(), "yald-installed-demo-")), sentinel = join(artifact, "caller with spaces");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const require = createRequire(join(root, "package.json")), bunDir = dirname(require.resolve("bun/package.json"));
const runtime = [join(bunDir, "bin/bun.exe"), join(bunDir, "bin/bun")].find(path => existsSync(path));
assert.ok(runtime);
const manifest = manifestArg ? JSON.parse(await readFile(manifestArg, "utf8")) : null;
const receipt = { status: "failed", source: manifest?.source ?? null, artifactName: manifest?.artifactName ?? null,
  producer: manifest?.producer ?? null, package: { path: tarball, version: pkg.version, bytes: (await stat(tarball)).size, sha256: sha(await readFile(tarball)),
    installedRoot: root, node: process.version, bun: spawnSync(runtime, ["--version"], { encoding: "utf8" }).stdout.trim(),
    npm: spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout.trim(), platform: process.platform, arch: process.arch,
    osRelease: release(), osVersion: version() }, modes: [], assets: [], sentinels: {}, audit: {}, cleanup: false };
if (manifest) {
  assert.equal(receipt.package.sha256, manifest.package.sha256);
  assert.equal(receipt.package.version, manifest.package.version);
  assert.equal(receipt.package.bytes, manifest.package.bytes);
}
const delay = () => new Promise(resolve => setTimeout(resolve, 20));
async function wait(check, describe, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await delay(); }
  throw new Error(describe());
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function json(base, path) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, path);
  return response.json();
}
function evidencePath(evidence, investigation, extra = {}) {
  const params = new URL(evidence.href, "http://synthetic.invalid").searchParams;
  params.set("investigation", investigation);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return `/api/labs/evidence?${params}`;
}
async function checkApis(base, mode) {
  const meta = await json(base, "/api/meta"), overview = await json(base, "/api/overview");
  assert.equal(meta.demo.synthetic, true);
  assert.equal(meta.demo.clock, mode);
  assert.equal(meta.totals.requests, 83);
  assert.deepEqual(meta.sources, ["claude-code", "ocx"]);
  assert.match(meta.pricing.detail, /illustrative/);
  assert.ok(meta.pricing.modulePath.startsWith(dirname(meta.ocxHome)));
  assert.equal(overview.summary.requests, 42);
  assert.equal(overview.prior.requests, 40);
  assert.equal(overview.summary.unobserved, 7);
  assert.equal(overview.window.to - overview.window.from, 30 * 86400000);
  const radar = await json(base, "/api/labs/projects"), cache = await json(base, "/api/labs/cache"), context = await json(base, "/api/labs/context");
  assert.equal(radar.priorWindow.to, radar.window.from);
  assert.ok(radar.projects.some(p => p.current.totals.requests === 0 && p.prior.totals.requests === 4));
  const current = await json(base, evidencePath(radar.current.evidence, "project-radar", { priorSelector: JSON.stringify(radar.prior.evidence.selector) }));
  const prior = await json(base, evidencePath(radar.current.evidence, "project-radar", { priorSelector: JSON.stringify(radar.prior.evidence.selector), period: "prior" }));
  assert.equal(current.population.evidence.tokens, 451600);
  assert.equal(prior.population.evidence.tokens, 672000);
  assert.equal(cache.totals.netUsd, -0.03514);
  assert.equal(cache.totals.actualUsd, 0.83474);
  assert.equal(cache.totals.eligibleRequests, 37);
  assert.equal(cache.sessions.find(s => s.conversationId === "synthetic-write-premium").netUsd, -0.14);
  assert.ok(cache.sessions.some(s => s.direction === "benefit" && s.netUsd > 0));
  assert.equal(cache.sessions.find(s => s.conversationId === "synthetic-no-cache").netUsd, 0);
  assert.equal(cache.sessions.find(s => s.conversationId === "synthetic-zero-price").actualUsd, 0);
  const cacheEvidence = await json(base, evidencePath(cache.totals.evidence, "cache-detective"));
  assert.equal(cacheEvidence.population.evidence.pricedCostUsd, cache.totals.actualUsd);
  assert.equal(cacheEvidence.population.original.requests, 42);
  assert.equal(cacheEvidence.rows.length, 37);
  const selected = context.sessions.find(s => s.excludedRequests === 2);
  assert.deepEqual(selected.growth, { ranked: true, baseline: 2000, latest: 7000, absoluteChange: 5000, ratio: 3.5 });
  assert.equal(selected.eligibleRequests, 7);
  const contextEvidence = await json(base, evidencePath(selected.evidence, "context-replay"));
  assert.equal(contextEvidence.rows.length, 9);
  assert.equal(contextEvidence.population.excludedRequests, 2);
  assert.ok(contextEvidence.rows.every(row => row.source === "ocx"));
  assert.ok(contextEvidence.rows.some(row => row.inputTokens === 0));
  assert.equal(contextEvidence.rows.filter(row => row.inputTokens === null).length, 2);
  assert.equal(contextEvidence.rows.find(row => row.id === "demo-orbit-0").rateIn, 2);
  const collision = context.sessions.find(s => s.source === "claude-code" && s.conversationId === selected.conversationId);
  assert.equal(collision.growth.absoluteChange, -5000);
  assert.match(JSON.stringify(await json(base, "/api/quota")), /synthetic-demo-account/);
  const html = await (await fetch(base)).text();
  assert.match(html, /id="yald-demo"/);
  assert.ok(!html.includes("fonts.googleapis"));
  for (const route of ["/index.html", "/labs/project-radar", "/labs/cache-detective", "/labs/context-replay", "/labs/evidence"]) {
    assert.match(await (await fetch(base + route)).text(), /id="yald-demo"/, route);
  }
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]);
  assert.ok(assets.some(path => path.endsWith(".js")) && assets.some(path => path.endsWith(".css")));
  for (const path of [...assets, "/favicon.svg", "/favicon.ico", "/apple-touch-icon.png", "/yaldi/mark-small.svg",
    "/yaldi/mark-small-dark.svg", "/yaldi/state-demo.svg", "/yaldi/state-demo-dark.svg", "/yaldi/state-clue-found.svg", "/yaldi/state-clue-found-dark.svg"]) {
    const response = await fetch(base + path), bytes = await response.arrayBuffer();
    assert.equal(response.status, 200, path);
    assert.ok(bytes.byteLength > 100, path);
    assert.ok(!response.headers.get("content-type").includes("text/html"), `Asset returned the SPA shell: ${path}`);
    const entry = `web/dist${path}`, packed = spawnSync("tar", ["-xOzf", tarball, `package/${entry}`], { maxBuffer: 32 * 1024 * 1024 });
    assert.equal(packed.status, 0, `Tarball asset: ${path}`);
    const digest = sha(Buffer.from(bytes));
    assert.equal(digest, sha(packed.stdout), `Served asset differs from candidate tarball: ${path}`);
    if (manifest) assert.equal(digest, manifest.files.find(file => file.path === entry)?.sha256, `Manifest asset: ${path}`);
    receipt.assets.push({ mode, path, bytes: bytes.byteLength, sha256: digest, type: response.headers.get("content-type") });
  }
  return { mode, sampleAt: meta.demo.sampleAt, now: meta.demo.now, window: overview.window,
    counts: { all: 83, current: 42, prior: 40, cacheEligible: 37, contextEligible: 40 },
    cacheActualUsd: cache.totals.actualUsd, contextGrowth: selected.growth,
    evidence: { radarCurrent: current.page.total, radarPrior: prior.page.total, cache: cacheEvidence.page.total, context: contextEvidence.page.total } };
}

const sentinelFiles = [".opencodex/usage.jsonl", ".opencodex/yald-claude-usage.jsonl", ".opencodex/config.json", ".env",
  ".claude/projects/sentinel/session.jsonl", ".codex/sessions/rollout-sentinel.jsonl", "global-pricing/src/usage/cost.ts",
  ".bun/install/global/node_modules/@bitkyc08/opencodex/src/usage/cost.ts"];
const snapshot = async () => Promise.all(sentinelFiles.map(async file => {
  const path = join(sentinel, file), info = await stat(path);
  return { file, sha256: sha(await readFile(path)), size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}));
try {
  for (const file of sentinelFiles) {
    await mkdir(dirname(join(sentinel, file)), { recursive: true });
    await writeFile(join(sentinel, file), file.includes("cost.ts") ? `throw new Error("SYNTHETIC GLOBAL ENGINE MUST NOT LOAD");` : JSON.stringify({ requestId: "synthetic-sentinel", timestamp: Date.now(),
      inboundProtocol: "claude-code", model: "demo-orbit", usage: { inputTokens: 999999, outputTokens: 99 } }) + "\n");
  }
  await writeFile(join(sentinel, ".env"), `OCX_HOME=${join(sentinel, ".opencodex")}\nOCX_PACKAGE_DIR=${join(sentinel, "global-pricing")}\n`);
  const bin = join(artifact, "fake-openers"), openRecord = join(artifact, "opened.txt");
  await mkdir(bin);
  for (const command of ["open", "xdg-open"]) {
    await writeFile(join(bin, command), '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$YALD_FAKE_OPEN_RECORD"\n');
    await chmod(join(bin, command), 0o755);
  }
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: sentinel, USERPROFILE: sentinel,
    OCX_HOME: join(sentinel, ".opencodex"), CODEX_HOME: join(sentinel, ".codex"), CLAUDE_PROJECTS_DIR: join(sentinel, ".claude/projects"),
    OCX_PACKAGE_DIR: join(sentinel, "global-pricing"), YALD_FAKE_OPEN_RECORD: openRecord, YALD_TZ: "Asia/Singapore", YALD_PORT: "1" };
  receipt.sentinels.before = await snapshot();
  for (const args of [["--version"], ["--help"], ["demo", "--help"], ["report", "--help"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: sentinel, env, encoding: "utf8" });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    if (args[0] === "--version") assert.equal(result.stdout.trim(), pkg.version);
  }
  for (const mode of ["fixed", "wall"]) {
    const port = await freePort(), base = `http://127.0.0.1:${port}`, started = Date.now();
    const args = [cli, "demo", "--open", "--port", String(port), ...(mode === "fixed" ? ["--now", "2026-10-20T12:00:00Z"] : [])];
    const child = spawn(process.execPath, args, { cwd: sentinel, env, stdio: "pipe" });
    let output = "", errors = "";
    child.stdout.on("data", chunk => output += String(chunk)); child.stderr.on("data", chunk => errors += String(chunk));
    const closed = new Promise(resolve => child.once("close", resolve));
    try {
      await wait(() => output.includes("Demo ready:"), () => `Installed demo not ready: ${output} ${errors}`);
      await wait(async () => existsSync(openRecord) && (await readFile(openRecord, "utf8")).includes(base), () => "fake opener was not called");
      const result = await checkApis(base, mode);
      if (mode === "wall") {
        assert.ok(result.sampleAt >= started && result.sampleAt <= Date.now());
        assert.equal(result.now, null);
        assert.ok(result.window.to >= result.sampleAt && result.window.to <= Date.now());
        assert.ok((await json(base, "/api/window")).window.to > result.window.to);
      } else assert.equal(result.window.to, Date.parse("2026-10-20T12:00:00Z"));
      receipt.modes.push({ ...result, command: `node ${cli} ${args.slice(1).join(" ")}`, fakeOpener: base });
    } finally { child.kill("SIGINT"); assert.equal(await closed, 130); }
    const directory = output.match(/Demo data: (.+)/)?.[1];
    assert.ok(directory && !existsSync(directory));
    await assert.rejects(fetch(`${base}/api/health`));
  }

  const emptyRoot = join(artifact, "normal-empty"), emptyPort = await freePort();
  const inputs = { HOME: emptyRoot, USERPROFILE: emptyRoot, XDG_CONFIG_HOME: join(emptyRoot, "config"),
    OCX_HOME: join(emptyRoot, "ocx"), CLAUDE_PROJECTS_DIR: join(emptyRoot, "claude-projects"), CODEX_HOME: join(emptyRoot, "codex"),
    OCX_PACKAGE_DIR: join(emptyRoot, "unavailable-pricing") };
  for (const directory of Object.values(inputs)) await mkdir(directory, { recursive: true });
  // A discoverable package with no estimator keeps normal discovery from using a
  // developer's global engine. It contains no prices or pricing implementation.
  await mkdir(join(inputs.OCX_PACKAGE_DIR, "src/usage"), { recursive: true });
  await writeFile(join(inputs.OCX_PACKAGE_DIR, "src/usage/cost.ts"), "export {}; // No pricing engine installed.\n");
  const normalEnv = { ...env, ...inputs, YALD_PORT: String(emptyPort), YALD_HOST: "127.0.0.1" };
  const normal = spawn(process.execPath, [cli], { cwd: emptyRoot, env: normalEnv, detached: true, stdio: "pipe" });
  let normalOutput = "";
  normal.stdout.on("data", chunk => normalOutput += String(chunk)); normal.stderr.on("data", chunk => normalOutput += String(chunk));
  const normalClosed = new Promise(resolve => normal.once("close", resolve));
  try {
    await wait(async () => { try { return (await fetch(`http://127.0.0.1:${emptyPort}/api/health`)).ok; } catch { return false; } }, () => normalOutput);
    const meta = await json(`http://127.0.0.1:${emptyPort}`, "/api/meta");
    assert.equal(meta.totals.requests, 0);
    assert.equal(meta.demo, undefined);
    assert.equal(meta.ocxHome, inputs.OCX_HOME);
    assert.equal(meta.pricing.available, false);
    assert.equal(meta.pricing.modulePath, null);
    assert.match(meta.pricing.detail, /no usable cost module/);
    const base = `http://127.0.0.1:${emptyPort}`;
    assert.equal((await json(base, "/api/overview")).summary.requests, 0);
    const radar = await json(base, "/api/labs/projects");
    assert.equal(radar.current.totals.requests, 0);
    assert.equal(radar.prior.totals.requests, 0);
    assert.equal(radar.projects.length, 1);
    assert.equal(radar.projects[0].project, "(unattributed)");
    assert.equal(radar.projects[0].current.totals.requests, 0);
    assert.equal(radar.projects[0].prior.totals.requests, 0);
    assert.equal((await json(base, "/api/labs/cache")).totals.eligibleRequests, 0);
    assert.equal((await json(base, "/api/labs/context")).sessions.length, 0);
    assert.ok(!(await (await fetch(`http://127.0.0.1:${emptyPort}`)).text()).includes('id="yald-demo"'));
    const report = spawnSync(process.execPath, [cli, "report", "--last", "1h", "--dry-run"], { cwd: emptyRoot, env: normalEnv, encoding: "utf8" });
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /\(no phases\).*0\s+0\s+0/);
    assert.match(report.stdout, /Nothing written \(--dry-run\)/);
    receipt.normal = { emptyRequests: 0, demoMarker: false, explicitHomes: true, pricing: meta.pricing,
      unavailableEngine: "explicit package contains no estimator or rates; prevents global discovery", emptyInvestigations: 3, reportDryRun: "0 rows; nothing written" };
  } finally { process.kill(-normal.pid, "SIGTERM"); await normalClosed; }
  await assert.rejects(fetch(`http://127.0.0.1:${emptyPort}/api/health`));

  const { runDemo } = await import(pathToFileURL(join(root, "scripts/demo.mjs")).href);
  const auditFile = join(artifact, "audit.txt"), signals = new EventEmitter(), port = await freePort(), logs = [], errors = [];
  const done = runDemo({ port, now: Date.parse("2026-10-20T12:00:00Z"), open: false }, { root, runtime, signals,
    log: value => logs.push(value), error: value => errors.push(value), spawnServer: (rt, args, opts) => spawn(rt,
      [args[0], `--preload=${guard}`, ...args.slice(1)], { ...opts, env: { ...opts.env,
        YALD_TEST_DEMO_GUARD: JSON.stringify({ forbidden: sentinel, receipt: auditFile, packageRoot: root }) } }) });
  try {
    await wait(() => logs.some(line => line.startsWith("Demo ready:")), () => errors.join("\n"));
    assert.equal((await json(`http://127.0.0.1:${port}`, "/api/meta")).totals.requests, 83);
    await json(`http://127.0.0.1:${port}`, "/api/labs/projects");
  } finally { signals.emit("SIGINT"); assert.equal(await done, 130); }
  const audit = await readFile(auditFile, "utf8");
  assert.match(audit, /guard active/);
  assert.ok(!/forbidden path|subprocess |network fetch|development import/.test(audit));
  const modules = audit.split("\n").filter(line => line.startsWith("module ")).map(line => line.slice(7));
  const dependencyRoot = dirname(root), demoRoot = logs.join("\n").match(/Demo data: (.+)/)?.[1];
  const normalized = path => path.replace(/^\/private(?=\/(?:tmp|var)\/)/, "");
  const within = (path, directory) => normalized(path).startsWith(`${normalized(directory)}/`);
  for (const path of modules) assert.ok(within(path, dependencyRoot) || within(path, demoRoot)
    || within(path, artifact), `Unexpected runtime import: ${path}`);
  assert.ok(!modules.some(path => /yald-o02-work|\/web\/scripts\//.test(path)));
  receipt.audit = { guard: "active; no forbidden source reads, subprocesses or network fetches", modules };
  // This verifier owns the installation. Restore its real built assets even if
  // the negative control fails; source test shells must never satisfy this check.
  const webDist = join(root, "web/dist"), heldAssets = join(artifact, "built-web-dist");
  await rename(webDist, heldAssets);
  try {
    const port = await freePort(), openedBefore = await readFile(openRecord, "utf8");
    const missing = spawnSync(process.execPath, [cli, "demo", "--open", "--port", String(port)], {
      cwd: sentinel, env, encoding: "utf8", timeout: 15000,
    });
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /Demo web assets are missing\. Reinstall the built Yald package\./);
    assert.doesNotMatch(missing.stdout, /Demo ready:/);
    const directory = missing.stdout.match(/Demo data: (.+)/)?.[1];
    assert.ok(directory && !existsSync(directory));
    assert.equal(await readFile(openRecord, "utf8"), openedBefore);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
    receipt.missingAssets = { exitCode: 1, ready: false, opened: false, dataRemoved: true, listenerStopped: true };
  } finally { await rename(heldAssets, webDist); }
  receipt.sentinels.after = await snapshot();
  assert.deepEqual(receipt.sentinels.after, receipt.sentinels.before);
  receipt.sentinels.unreadAndUnchanged = true;
  receipt.cleanup = true;
  receipt.status = "passed";
} catch (error) {
  receipt.error = String(error.stack ?? error);
  throw error;
} finally {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(receipt, null, 2) + "\n");
  await rm(artifact, { recursive: true, force: true });
}
console.log(`Installed demo: fixed + wall clock, real --open with fake executable, exact API evidence, static assets, missing-assets failure, isolated homes and cleanup PASS\nReceipt: ${out}`);
