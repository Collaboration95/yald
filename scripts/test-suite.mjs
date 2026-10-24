#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { closeSync, createReadStream, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set([".git", "node_modules", "vendor", "bower_components", "dist", "build", "generated", "__generated__", "coverage", "output", ".cache", ".next", ".turbo", ".yald", "__snapshots__"]);
const expensive = new Map([
  ["tests/store-snapshots.test.ts", "cold-parser snapshot integration"],
  ["tests/qualify-package.test.ts", "package/archive qualification integration"],
]);

export function discoverTests(directory) {
  const files = [];
  function visit(relative) {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      // Do not follow symlinks, even within the checkout: aliases duplicate tests.
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory() && !ignored.has(entry.name)) visit(path);
      else if (entry.isFile() && /[._](test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
    }
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ["server", "tests", "web"].includes(entry.name)) visit(entry.name);
  }
  return files.sort();
}

export function createPlan(files, { fast = false, serial = false, workers = "3", capacity = os.availableParallelism?.() ?? os.cpus().length } = {}) {
  if (!/^[1-9]\d*$/.test(String(workers))) throw new Error("YALD_TEST_WORKERS must be a positive integer");
  const groups = ["snapshots", "time", "remaining"].map(name => ({ name, files: [] }));
  const excluded = [];
  for (const file of [...new Set(files)].sort()) {
    if (fast && expensive.has(file)) { excluded.push({ file, reason: expensive.get(file) }); continue; }
    const group = file === "tests/store-snapshots.test.ts" ? 0
      : ["server/src/time/window.test.ts", "server/src/bucketing.test.ts"].includes(file) ? 1 : 2;
    groups[group].files.push(file);
  }
  const nonempty = groups.filter(group => group.files.length);
  if (!nonempty.length) throw new Error("No test files discovered");
  return { mode: fast ? "fast" : "full", workers: Math.min(serial ? 1 : Number(workers), 3, Math.max(1, capacity), nonempty.length), groups: nonempty, excluded };
}

// Each worker has its own process group. A detached demo server can leave that
// group, so also retain observed descendant identities until the worker settles.
// Check the start time again before signalling a previously observed PID.
function processTable() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8", timeout: 2000 })
    .trim().split("\n").filter(Boolean).map(line => {
      const [pid, parent, group, ...started] = line.trim().split(/\s+/);
      return { pid: Number(pid), parent: Number(parent), group: Number(group), started: started.join(" ") };
    });
}
const delay = ms => new Promise(done => setTimeout(done, ms));
function signal(pid, name) {
  try { process.kill(pid, name); return true; } catch (error) { if (error.code !== "ESRCH") throw error; return false; }
}

// Run inside Bun's completion/exit hooks while it is still the children's parent. A parent
// polling ps cannot discover a newly detached child after its worker has exited.
export function stopDescendantsSync() {
  const owned = new Map();
  function descendants() {
    const table = processTable(), ids = new Set([process.pid]);
    for (const row of table) if (owned.get(row.pid) === row.started) ids.add(row.pid);
    let added;
    do {
      added = false;
      for (const row of table) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); added = true; }
    } while (added);
    const children = table.filter(row => row.pid !== process.pid && ids.has(row.pid));
    for (const row of children) owned.set(row.pid, row.started);
    return children;
  }
  let children = descendants().filter(row => signal(row.pid, "SIGTERM"));
  if (!children.length) return;
  // Give children a short chance to handle TERM, then stop stubborn descendants.
  // The coordinator awaits Bun and verifies observed survivors after this exit.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  children = descendants();
  for (const row of children) signal(row.pid, "SIGKILL");
}

export async function runPlan(plan, directory = root) {
  if (process.platform === "win32") throw new Error("The test runner requires POSIX process groups (macOS/Linux); use scripts/bun test on Windows");
  processTable(); // Fail before spawning workers if the required ps is unavailable.
  const logs = mkdtempSync(join(os.tmpdir(), "yald-test-suite-"));
  const active = new Set(), results = [];
  let next = 0, stopped = 0, cleanupError;
  function observe() {
    const table = processTable();
    for (const worker of active) {
      const owned = new Set(table.filter(row => worker.owned.get(row.pid) === row.started).map(row => row.pid));
      if (!worker.closed && worker.child.pid) owned.add(worker.child.pid);
      let added;
      do {
        added = false;
        for (const row of table) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); added = true; }
      } while (added);
      for (const row of table) if (owned.has(row.pid)) worker.owned.set(row.pid, row.started);
    }
    return table;
  }
  function terminate(worker, name, table) {
    // The group remains owned until cleanup completes, including after exit.
    if (worker.child.pid) signal(-worker.child.pid, name);
    for (const row of table) {
      if (worker.owned.get(row.pid) === row.started) signal(row.pid, name);
    }
  }
  function stop(code) {
    if (stopped) return;
    stopped = code;
    let table = [];
    try { table = observe(); } catch (error) { cleanupError = error; }
    for (const worker of active) {
      try { terminate(worker, "SIGTERM", table); } catch (error) { cleanupError = error; }
    }
  }
  const onInt = () => stop(130), onTerm = () => stop(143), onHup = () => stop(129);
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm); process.on("SIGHUP", onHup);
  const observer = setInterval(() => {
    try { observe(); } catch (error) { cleanupError = error; stop(1); }
  }, 100);

  async function run(group, index) {
    const file = join(logs, `${index}.log`);
    const started = performance.now();
    let worker, completion, fd;
    try {
      fd = openSync(file, "w");
      // Bun --bail skips afterAll, including the worker's descendant cleanup.
      const child = spawn(join(directory, "scripts/bun"), ["test", "--preload", "./scripts/test-worker-preload.mjs", ...group.files.map(path => `./${path}`)], {
        cwd: directory, env: process.env, detached: true, stdio: ["ignore", fd, fd],
      });
      worker = { child, owned: new Map(), closed: false };
      active.add(worker);
      completion = new Promise(done => {
        child.on("error", error => { worker.error = error; stop(1); });
        child.on("close", (code, sig) => { worker.closed = true; done({ code, signal: sig }); });
      });
      // On abort, escalate even when a worker ignores SIGTERM. Always await close.
      let terminationAt;
      while (!worker.closed) {
        if (stopped) {
          terminationAt ??= performance.now();
          if (performance.now() - terminationAt > 1000) terminate(worker, "SIGKILL", observe());
        }
        await delay(25);
      }
      const result = await completion;
      if (result.code !== 0 || result.signal || worker.error) stop(1);
      // Reap surviving descendants before releasing this capacity slot. This also
      // covers children that closed their stdio or started a separate session.
      let table = observe();
      const survivors = () => table.filter(row => worker.owned.get(row.pid) === row.started);
      terminate(worker, "SIGTERM", table);
      const deadline = performance.now() + 1000;
      while (survivors().length && performance.now() < deadline) { await delay(25); table = observe(); }
      if (survivors().length) {
        terminate(worker, "SIGKILL", table);
        const killDeadline = performance.now() + 2000;
        do { await delay(25); table = observe(); } while (survivors().length && performance.now() < killDeadline);
        if (survivors().length) throw new Error(`Could not stop descendants of ${group.name}`);
      }
      results[index] = { ...result, error: worker.error?.message, seconds: (performance.now() - started) / 1000, file };
    } catch (error) {
      stop(1);
      // Even a coordinator/observation error must not release a live worker.
      if (worker && !worker.closed) {
        await delay(1000);
        if (!worker.closed) signal(-worker.child.pid, "SIGKILL");
        await completion;
      }
      results[index] = { code: 1, error: error.message, file: fd === undefined ? undefined : file };
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (worker) active.delete(worker);
    }
  }

  console.log(`[test-suite] ${plan.mode}: ${plan.groups.reduce((sum, group) => sum + group.files.length, 0)} files, ${plan.workers} worker(s)`);
  for (const group of plan.groups) console.log(`[test-suite] ${group.name}: ${group.files.length} files`);
  if (plan.excluded.length) console.log(`[test-suite] excluded: ${plan.excluded.map(item => item.file).join(", ")}`);
  try {
    await Promise.all(Array.from({ length: plan.workers }, async () => {
      while (!stopped && next < plan.groups.length) { const index = next++; await run(plan.groups[index], index); }
    }));
    // Print whole worker logs in plan order, never interleave concurrent output.
    for (let i = 0; i < plan.groups.length; i++) {
      const result = results[i];
      console.log(`\n[test-suite] ${plan.groups[i].name}: ${result ? `exit=${result.code} signal=${result.signal ?? "none"}${result.seconds ? ` ${result.seconds.toFixed(2)}s` : ""}` : "not started"}`);
      if (result) {
        for await (const chunk of result.file ? createReadStream(result.file) : []) {
          if (!process.stdout.write(chunk)) await new Promise(done => process.stdout.once("drain", done));
        }
        if (result.error) console.error(result.error);
      }
    }
    if (cleanupError) { console.error(cleanupError.message); stopped ||= 1; }
    return stopped || (results.length === plan.groups.length && results.every(result => result.code === 0 && !result.signal && !result.error) ? 0 : 1);
  } finally {
    clearInterval(observer);
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); process.off("SIGHUP", onHup);
    rmSync(logs, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = new Set(process.argv.slice(2));
    for (const arg of args) if (!["--fast", "--serial", "--list"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const plan = createPlan(discoverTests(root), { fast: args.has("--fast"), serial: args.has("--serial"), workers: process.env.YALD_TEST_WORKERS ?? "3" });
    if (args.has("--list")) console.log(JSON.stringify(plan, null, 2));
    else process.exitCode = await runPlan(plan);
  } catch (error) { console.error(`[test-suite] ${error.message}`); process.exitCode = 1; }
}
