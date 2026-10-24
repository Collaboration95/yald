import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createPlan, discoverTests } from "../scripts/test-suite.mjs";

const repository = resolve(import.meta.dir, ".."), node = Bun.which("node")!;
const owned: string[] = [];
afterAll(() => { for (const directory of owned) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "yald-runner-test-")); owned.push(directory);
  mkdirSync(join(directory, "scripts"));
  copyFileSync(join(repository, "scripts/test-suite.mjs"), join(directory, "scripts/test-suite.mjs"));
  copyFileSync(join(repository, "scripts/test-worker-preload.mjs"), join(directory, "scripts/test-worker-preload.mjs"));
  symlinkSync(process.execPath, join(directory, "scripts/bun"));
  return directory;
}
function write(directory: string, path: string, source = "") {
  mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), source);
}
function list(directory: string, args: string[] = [], workers = "999") {
  const result = spawnSync(node, ["scripts/test-suite.mjs", "--list", ...args], { cwd: directory, env: { ...process.env, YALD_TEST_WORKERS: workers }, encoding: "utf8" });
  expect(result.status).toBe(0); return JSON.parse(result.stdout);
}
function launch(directory: string, args: string[] = [], workers = "3") {
  const child = spawn(node, ["scripts/test-suite.mjs", ...args], { cwd: directory, env: { ...process.env, YALD_TEST_WORKERS: workers }, stdio: "pipe" });
  let output = "";
  child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
  const done = new Promise<{ code: number | null; signal: string | null; output: string }>(resolve => child.on("close", (code, signal) => resolve({ code, signal, output })));
  return { child, done };
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error("fixture did not become ready"); await Bun.sleep(10); }
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

test("discovery includes future tests once, excluding nested dependencies, generated trees and symlink aliases", () => {
  const directory = fixture();
  const files = ["tests/new.test.ts", "server/src/nested/new.spec.js", "web/src/future/widget_test.tsx", "web/scripts/new.test.tsx"];
  for (const path of [...files, "web/nested/node_modules/pkg/no.test.ts", "server/src/deep/dist/no.test.ts", "tests/deep/.git/no.test.js", "web/coverage/no.spec.ts", "web/vendor/pkg/no.test.ts", "web/deep/generated/no.test.ts", "server/deep/__generated__/no.test.ts"]) write(directory, path);
  const outside = fixture(); write(outside, "escape.test.ts");
  symlinkSync(outside, join(directory, "web/outside")); symlinkSync(join(directory, "tests"), join(directory, "web/alias"));
  symlinkSync(join(outside, "escape.test.ts"), join(directory, "tests/alias.test.ts"));
  const plan = list(directory), selected = plan.groups.flatMap((group: any) => group.files);
  expect(selected.sort()).toEqual(files.sort()); expect(new Set(selected).size).toBe(files.length);
});

test("full covers every repository test; fast retains the previous selection and discovers UI/format and future tests", () => {
  const files = discoverTests(repository), full = createPlan(files), fast = createPlan(files, { fast: true });
  const flatten = (plan: any): string[] => plan.groups.flatMap((group: any) => group.files);
  expect(flatten(full).sort()).toEqual(files); expect(new Set(flatten(full)).size).toBe(files.length);
  const legacy = files.filter((file: string) => file.startsWith("server/src/") || ["tests/relay-style.test.ts", "tests/demo.test.ts"].includes(file));
  for (const file of [...legacy, "tests/format.test.ts", ...files.filter((file: string) => file.startsWith("web/"))]) expect(flatten(fast)).toContain(file);
  expect(files.filter((file: string) => !flatten(fast).includes(file))).toEqual(["tests/qualify-package.test.ts", "tests/store-snapshots.test.ts"]);
  const directory = fixture();
  for (const file of ["tests/store-snapshots.test.ts", "tests/demo.test.ts", "web/src/future.test.tsx"]) write(directory, file);
  const planned = list(directory, ["--fast"]);
  expect(planned.groups.flatMap((group: any) => group.files)).toEqual(["tests/demo.test.ts", "web/src/future.test.tsx"]);
  expect(planned.workers).toBe(1); // An intentionally empty snapshot group is valid.
});

test("worker capacity is capped at CPUs and three, with a real serial override", async () => {
  const directory = fixture();
  // mkdir is an atomic overlap detector; each test holds it across an await.
  const body = `import {test} from 'bun:test'; import {mkdirSync,rmdirSync} from 'node:fs'; test('exclusive',async()=>{mkdirSync('lock'); await Bun.sleep(60); rmdirSync('lock');});`;
  const files = ["tests/store-snapshots.test.ts", "server/src/time/window.test.ts", "tests/new.test.ts"];
  for (const file of files) write(directory, file, body);
  for (const capacity of [1, 2, 32]) expect(createPlan(files, { workers: "999", capacity }).workers).toBe(Math.min(3, capacity));
  expect(list(directory).workers).toBe(Math.min(3, availableParallelism()));
  expect(list(directory, ["--serial"]).workers).toBe(1);
  for (const [args, workers] of [[ ["--serial"], "3" ], [[], "1"]] as const) {
    const result = await launch(directory, [...args], workers).done;
    expect(result.code).toBe(0); expect(result.output.match(/1 pass/g)).toHaveLength(3);
  }
  expect(createPlan(files, { workers: "2", capacity: 32 }).workers).toBe(2);
  const invalid = spawnSync(node, ["scripts/test-suite.mjs"], { cwd: directory, env: { ...process.env, YALD_TEST_WORKERS: "0" }, encoding: "utf8" });
  expect(invalid.status).not.toBe(0); expect(invalid.stderr).toContain("positive integer");
});

test("workers preserve the preload and inherited environment in separate module processes", async () => {
  const directory = fixture();
  write(directory, "bunfig.toml", '[test]\npreload = ["./preload.ts"]\n');
  write(directory, "preload.ts", "process.env.RUNNER_PRELOADED = 'yes';");
  const body = `import {test,expect} from 'bun:test'; test('isolated',()=>{expect(process.env.RUNNER_PRELOADED).toBe('yes');expect(process.env.YALD_TEST_WORKERS).toBe('3');expect(globalThis.alreadyVisited).toBeUndefined();globalThis.alreadyVisited=true;});`;
  for (const file of ["tests/store-snapshots.test.ts", "server/src/time/window.test.ts", "tests/new.test.ts"]) write(directory, file, body);
  const result = await launch(directory).done;
  expect(result.code).toBe(0); expect(result.output.match(/1 pass/g)).toHaveLength(3);
  expect(result.output.indexOf("snapshots: exit=0")).toBeLessThan(result.output.indexOf("time: exit=0"));
});

test("child failures, child signals and spawn errors cannot produce success", async () => {
  for (const body of ["import {test,expect} from 'bun:test'; test('failure',()=>expect(1).toBe(2));", "process.kill(process.pid,'SIGTERM');"]) {
    const directory = fixture(); write(directory, "tests/fail.test.ts", body);
    const result = await launch(directory).done;
    expect(result.code).not.toBe(0); expect(result.output).toContain("remaining: exit=");
  }
  const directory = fixture(); write(directory, "tests/new.test.ts"); rmSync(join(directory, "scripts/bun"));
  const result = await launch(directory).done;
  expect(result.code).not.toBe(0); expect(result.output).toContain("ENOENT");
});

test("an immediate failure after spawning a detached child leaves no orphan", async () => {
  const directory = fixture();
  write(directory, "tests/fail.test.ts", `import {test,expect} from 'bun:test'; import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
    test('fail immediately',()=>{const child=spawn(${JSON.stringify(node)},['-e',"setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
      writeFileSync('pid',String(child.pid));expect(1).toBe(2);});`);
  let pid: number | undefined;
  try {
    for (const args of [[], ["--fast"]]) {
      const result = await launch(directory, args).done; pid = Number(readFileSync(join(directory, "pid"), "utf8"));
      expect(result.code).not.toBe(0); expect(alive(pid)).toBe(false);
    }
  } finally { if (pid && alive(pid)) process.kill(pid, "SIGKILL"); }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} returns nonzero, waits for workers, and removes ordinary and detached stubborn descendants`, async () => {
    const directory = fixture();
    write(directory, "tests/hang.test.ts", `import {test} from 'bun:test'; import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
      test('hang',async()=>{
        const code="process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)";
        const children=[false,true].map(detached=>spawn(${JSON.stringify(node)},['-e',code],{detached,stdio:['ignore','pipe','ignore']}));
        await Promise.all(children.map(child=>new Promise(done=>child.stdout.once('data',done))));
        writeFileSync('pids.json',JSON.stringify([process.pid,...children.map(child=>child.pid)]));await new Promise(()=>{});
      },30000);`);
    const running = launch(directory), marker = join(directory, "pids.json");
    let pids: number[] = [];
    try {
      await until(() => existsSync(marker)); pids = JSON.parse(readFileSync(marker, "utf8"));
      running.child.kill(signal);
      const result = await running.done;
      expect(result.code).toBe(signal === "SIGINT" ? 130 : 143);
      for (const pid of pids) expect(alive(pid)).toBe(false);
    } finally {
      running.child.kill("SIGKILL");
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
      await running.done;
    }
  }, 10000);
}
