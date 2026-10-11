import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { materializeFixtureHome } from "../web/scripts/fixtureHome";

// Same frozen clock as the probe, so the fixture's relative timestamps line up.
const epoch = 1_791_000_000_000;
const root = resolve(import.meta.dir, "..");
let home = "";
let pricing = "";
let child: ChildProcessWithoutNullStreams;
let lines: AsyncIterator<string>;

beforeAll(async () => {
  const now = Date.now;
  try { Date.now = () => epoch; home = await materializeFixtureHome(); } finally { Date.now = now; }
  pricing = await mkdtemp(join(tmpdir(), "yald-projects-pricing-"));
  // HOME is the fixture root, so `~/work/app-a*` means the fixture's own folders.
  child = spawn(process.execPath, [join(import.meta.dir, "helpers/store-probe.ts"), root], {
    cwd: root,
    env: { ...process.env, HOME: home, OCX_HOME: home, CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), CODEX_HOME: join(home, "codex"), OCX_PACKAGE_DIR: pricing, TZ: "UTC", YALD_TZ: "UTC" },
    stdio: "pipe",
  });
  lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  expect(JSON.parse((await lines.next()).value)).toEqual({ ready: true });
});

afterAll(async () => {
  child?.kill();
  await Promise.all([home, pricing].filter(Boolean).map(path => rm(path, { recursive: true, force: true })));
});

async function get(path: string): Promise<any> {
  child.stdin.write(JSON.stringify({ op: "api", paths: [path] }) + "\n");
  const reply = JSON.parse((await lines.next()).value);
  if (reply.error) throw new Error(reply.error);
  expect(reply.result[0].status).toBe(200);
  return reply.result[0].body;
}

const q = (projects: string) => `range=all&projects=${encodeURIComponent(projects)}`;

test("fixture rows are attributed: Claude by transcript cwd, Codex by hashed session id", async () => {
  const all = await get("/api/overview?range=all");
  expect(all.summary.requests).toBe(103);
  expect(all).not.toHaveProperty("coverage");
});

test("projects=~/work/app-a* keeps only app A's Claude and Codex rows and counts the unmatched opencodex row", async () => {
  const body = await get(`/api/overview?${q("~/work/app-a*")}`);
  // 49 Codex rows (root session, subagent traffic included) + 2 Claude rows from app-a/server.
  expect(body.summary.requests).toBe(51);
  expect(body.topProviders.map((row: { key: string }) => row.key).sort()).toEqual(["anthropic", "deepseek", "openai"]);
  expect(body.coverage).toEqual({ unattributedRows: 1, unattributedTokens: 22_400 });
  // Ancestor matching: the plain folder covers its server subfolder; a trailing slash is ignored.
  expect((await get(`/api/overview?${q("~/work/app-a/")}`)).summary.requests).toBe(51);
  expect((await get(`/api/overview?${q("~/work/app-b,~/work/app-a")}`)).summary.requests).toBe(53);
  // Every analytics route reports coverage under a project filter.
  for (const route of ["usage", "cost", "models", "performance", "reliability", "conversations", "timeseries", "filters"]) {
    expect((await get(`/api/${route}?${q("~/work/app-a*")}`)).coverage).toEqual({ unattributedRows: 1, unattributedTokens: 22_400 });
  }
});

test("temp-folder globs match the Codex SDK run however macOS spells the path", async () => {
  for (const glob of ["/private/var/folders/**/T/app-a-*", "/var/folders/**/T/app-a-*"]) {
    const body = await get(`/api/overview?${q(glob)}`);
    expect(body.summary.requests).toBe(49);
    expect(body.coverage.unattributedRows).toBe(1);
  }
});

test("GET /api/projects rolls subfolders up to the git root and lists (unattributed)", async () => {
  const body = await get("/api/projects?range=all");
  const byProject = Object.fromEntries(body.projects.map((row: { project: string }) => [row.project, row]));
  expect(Object.keys(byProject).sort()).toEqual([
    "(unattributed)", "/private/var/folders/yd/fixture/T/app-a-sdk-run", join(home, "work", "app-a"), join(home, "work", "app-b"),
  ].sort());
  expect(byProject[join(home, "work", "app-a")]).toMatchObject({ gitRoot: true, requests: 51, folders: [join(home, "work", "app-a"), join(home, "work", "app-a", "server")] });
  expect(byProject[join(home, "work", "app-b")]).toMatchObject({ gitRoot: false, requests: 2 });
  expect(byProject["(unattributed)"]).toMatchObject({ requests: 1, tokens: 22_400 });
  expect(body.projects.at(-1).project).toBe("(unattributed)");
  expect(body.projects.reduce((sum: number, row: { requests: number }) => sum + row.requests, 0)).toBe(103);
  const scoped = await get(`/api/projects?${q("~/work/app-a*")}`);
  expect(scoped.projects.map((row: { project: string }) => row.project)).toEqual([join(home, "work", "app-a"), "(unattributed)"]);
  expect(scoped.coverage).toEqual({ unattributedRows: 1, unattributedTokens: 22_400 });
});
