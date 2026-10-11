import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { filterRows, projectCoverage } from "./analytics";
import type { RequestRow } from "./ocx/store";
import { expandProjectGlob, gitRoot, projectBreakdown, projectMatcher } from "./projects";

const home = process.env.HOME || homedir();

function row(id: string, cwd: string | null, totalTokens = 100): RequestRow {
  return { id, ts: 1_000, provider: "openai", model: "m", totalTokens, cost: 0.5, cwd } as RequestRow;
}

test("globs expand ~ and ignore trailing slashes", () => {
  expect(expandProjectGlob("~/work/app-a/")).toBe(`${home}/work/app-a`);
  expect(expandProjectGlob("~")).toBe(home);
  expect(expandProjectGlob("/")).toBe("/");
  expect(expandProjectGlob("/tmp/app-a-*//")).toBe("/tmp/app-a-*");
});

test("a cwd matches when it or any ancestor matches a glob", () => {
  const match = projectMatcher(["~/work/app-a"]);
  expect(match(`${home}/work/app-a`)).toBe(true);
  expect(match(`${home}/work/app-a/server`)).toBe(true);
  expect(match(`${home}/work/app-a-api`)).toBe(false);
  expect(match(`${home}/work`)).toBe(false);
  expect(match(null)).toBe(false);
  const prefix = projectMatcher(["~/work/app-a*"]);
  expect(prefix(`${home}/work/app-a-api/web`)).toBe(true);
  expect(prefix(`${home}/work/app-b`)).toBe(false);
});

test("temp-folder globs match Codex SDK runs under either macOS spelling", () => {
  const tmp = projectMatcher(["/tmp/app-a-*"]);
  expect(tmp("/tmp/app-a-123")).toBe(true);
  expect(tmp("/private/tmp/app-a-123/nested")).toBe(true);
  expect(tmp("/tmp/app-b-123")).toBe(false);
  const folders = projectMatcher(["/private/var/folders/**/T/app-a-*"]);
  expect(folders("/private/var/folders/yd/abc123/T/app-a-run")).toBe(true);
  expect(folders("/var/folders/yd/abc123/T/app-a-run/sub")).toBe(true);
  expect(folders("/var/folders/yd/abc123/T/other")).toBe(false);
});

test("project filters drop rows without a cwd and coverage counts them", () => {
  const rows = [row("a", `${home}/work/app-a/server`, 10), row("b", `${home}/work/app-b`, 20), row("x", null, 30), row("y", null, 40)];
  const filter = { projects: ["~/work/app-a"] };
  expect(filterRows(rows, filter).map(r => r.id)).toEqual(["a"]);
  expect(projectCoverage(rows, filter)).toEqual({ unattributedRows: 2, unattributedTokens: 70 });
  // Other filters still apply to the rows being counted.
  expect(projectCoverage(rows, { ...filter, search: "nothing-matches" })).toEqual({ unattributedRows: 0, unattributedTokens: 0 });
  expect(projectCoverage(rows, {})).toBeNull();
  expect(filterRows(rows, { projects: [] })).toHaveLength(4);
});

test("projects roll up to the nearest git root, including worktrees with a .git file", async () => {
  const base = await mkdtemp(join(tmpdir(), "yald-projects-"));
  await mkdir(join(base, "repo", ".git"), { recursive: true });
  await mkdir(join(base, "repo", "server", "src"), { recursive: true });
  await mkdir(join(base, "worktree"), { recursive: true });
  await writeFile(join(base, "worktree", ".git"), "gitdir: elsewhere\n");
  await mkdir(join(base, "plain"), { recursive: true });
  expect(gitRoot(join(base, "repo", "server", "src"))).toBe(join(base, "repo"));
  expect(gitRoot(join(base, "worktree"))).toBe(join(base, "worktree"));
  expect(gitRoot(join(base, "plain"))).toBeNull();

  const projects = projectBreakdown([
    row("1", join(base, "repo")), row("2", join(base, "repo", "server", "src"), 300),
    row("3", join(base, "plain"), 50), row("4", null, 1_000), row("5", "/gone/deleted-folder", 10),
  ]);
  expect(projects.map(p => p.project)).toEqual([join(base, "repo"), join(base, "plain"), "/gone/deleted-folder", "(unattributed)"]);
  expect(projects[0]).toMatchObject({ gitRoot: true, requests: 2, tokens: 400, cost: 1, folders: [join(base, "repo"), join(base, "repo", "server", "src")] });
  expect(projects[1]).toMatchObject({ gitRoot: false, requests: 1 });
  expect(projects[3]).toMatchObject({ requests: 1, tokens: 1_000, folders: [] });
  expect(projectBreakdown([]).map(p => p.project)).toEqual(["(unattributed)"]);
});

test("project rollups follow git roots created or removed after an earlier lookup", async () => {
  const base = await mkdtemp(join(tmpdir(), "yald-project-roots-"));
  const repo = join(base, "repo");
  const nested = join(repo, "nested");
  await mkdir(nested, { recursive: true });
  expect(gitRoot(nested)).toBeNull();
  await mkdir(join(repo, ".git"));
  expect(projectBreakdown([row("1", nested)])[0]!.project).toBe(repo);
  await writeFile(join(nested, ".git"), "gitdir: elsewhere\n");
  expect(projectBreakdown([row("1", nested)])[0]!.project).toBe(nested);
  await rm(join(nested, ".git"));
  await rm(join(repo, ".git"), { recursive: true });
  expect(projectBreakdown([row("1", nested)])[0]).toMatchObject({ project: nested, gitRoot: false });
  await rm(base, { recursive: true });
});
