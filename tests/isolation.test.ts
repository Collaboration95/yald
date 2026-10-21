import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

// Both checks run in a child process: importing env.ts here would pin its paths
// for every later test file that shares this process.
const root = resolve(import.meta.dir, "..");
const realDirs = [join(homedir(), ".opencodex"), join(homedir(), ".claude"), join(homedir(), ".codex")];
const inside = (dir: string, parent: string) => !relative(resolve(parent), resolve(dir)).startsWith("..");
const printPaths = "const env = await import('./server/src/env.ts'); console.log(JSON.stringify([env.OCX_HOME, env.CLAUDE_ARCHIVE, env.CLAUDE_PROJECTS, env.CODEX_HOME, ...Object.values(env.PATHS)]))";

test("the test run never points at the real data directories", () => {
  const result = spawnSync(process.execPath, ["-e", printPaths], { cwd: root, env: process.env, encoding: "utf8" });
  expect(result.status).toBe(0);
  const dirs = JSON.parse(result.stdout) as string[];
  expect(dirs.length).toBeGreaterThan(4);
  for (const dir of dirs) {
    for (const real of realDirs) expect(inside(dir, real)).toBe(false);
  }
});

test("server code refuses to load under bun test without isolated data directories", () => {
  const env = { ...process.env, NODE_ENV: "test" };
  delete env.OCX_HOME;
  const result = spawnSync(process.execPath, ["-e", printPaths], { cwd: root, env, encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("refusing to use the real data directories");
});
