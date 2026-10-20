import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  expect(body.coverage).toMatchObject({ unattributedRows: 1, unattributedTokens: 22_400 });
  // Ancestor matching: the plain folder covers its server subfolder; a trailing slash is ignored.
  expect((await get(`/api/overview?${q("~/work/app-a/")}`)).summary.requests).toBe(51);
  expect((await get(`/api/overview?${q("~/work/app-b,~/work/app-a")}`)).summary.requests).toBe(53);
  // Every analytics route reports coverage under a project filter.
  for (const route of ["usage", "cost", "models", "performance", "reliability", "conversations", "timeseries", "filters"]) {
    const { coverage } = await get(`/api/${route}?${q("~/work/app-a*")}`);
    expect(coverage).toMatchObject({ unattributedRows: 1, unattributedTokens: 22_400 });
    // The one folderless row has a conversation id that matches no rollout in the fixture's Codex index.
    expect(coverage.attribution.unattributed.reasons.map((r: { reason: string; rows: number }) => [r.reason, r.rows])).toEqual([["noConversationId", 0], ["noRollout", 1], ["other", 0]]);
    expect(coverage.attribution.matched.rows + coverage.attribution.outsideProjects.rows + coverage.attribution.unattributed.rows).toBeGreaterThan(coverage.attribution.matched.rows);
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
  expect(scoped.coverage).toMatchObject({ unattributedRows: 1, unattributedTokens: 22_400 });
  expect(byProject["(unattributed)"].reasons).toEqual(scoped.projects.at(-1).reasons);
});

test("project and report ETags reflect git-root changes without ledger edits", async () => {
  const query = `from=${epoch - 30 * 86_400_000}&to=${epoch}`;
  const paths = [`/api/projects?${query}`, `/api/report?${query}`];
  const responses = async (etag?: string) => {
    child.stdin.write(JSON.stringify({ op: "api", paths, etag }) + "\n");
    const reply = JSON.parse((await lines.next()).value);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  };
  const before = await responses();
  const parentGit = join(home, "work", ".git");
  try {
    await mkdir(parentGit);
    const changed = await responses(before[0].etag);
    expect(changed[0].status).toBe(200);
    expect(changed[0].etag).not.toBe(before[0].etag);
    expect(changed[0].body.projects.some((row: { project: string }) => row.project === join(home, "work"))).toBe(true);
    const report = await responses(before[1].etag);
    expect(report[1].status).toBe(200);
    expect(report[1].etag).not.toBe(before[1].etag);
    expect(report[1].body.report.conversations.some((row: { project: string }) => row.project === "~/work")).toBe(true);
    expect((await responses(changed[0].etag))[0].status).toBe(304);
    expect((await responses(report[1].etag))[1].status).toBe(304);
  } finally {
    await rm(parentGit, { recursive: true, force: true });
  }
});
