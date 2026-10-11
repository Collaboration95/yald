import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RequestRow } from "./ocx/store";

/** Label for rows whose working directory is unknown. */
export const UNATTRIBUTED = "(unattributed)";

function home(): string {
  return process.env.HOME || homedir();
}

/** `~` and `~/x` expand to the home directory; trailing slashes are ignored. */
export function expandProjectGlob(glob: string): string {
  let path = glob.trim();
  if (path === "~" || path.startsWith("~/")) path = home() + path.slice(1);
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

/** macOS reports temp folders as /private/var/... or /var/... (and /tmp) depending on the caller. */
function aliases(path: string): string[] {
  const match = /^(\/private)?\/(tmp|var)(\/|$)/.exec(path);
  if (!match) return [path];
  return [path, match[1] ? path.slice("/private".length) : `/private${path}`];
}

/**
 * A predicate that is true when `cwd`, or any directory above it, matches one of `globs`.
 * So `~/work/app-a` covers `~/work/app-a/server`, and `/tmp/app-a-*` covers a Codex SDK
 * run in `/private/tmp/app-a-123`. Results are memoized per cwd; null never matches.
 */
export function projectMatcher(globs: string[]): (cwd: string | null) => boolean {
  const patterns = globs.map(expandProjectGlob).filter(Boolean).map(glob => new Bun.Glob(glob));
  const memo = new Map<string, boolean>();
  return cwd => {
    if (cwd === null) return false;
    let hit = memo.get(cwd);
    if (hit === undefined) {
      hit = false;
      for (const path of aliases(cwd)) {
        for (let dir = path; !hit; dir = dirname(dir)) {
          hit = patterns.some(pattern => pattern.match(dir));
          if (dir === dirname(dir)) break;
        }
      }
      memo.set(cwd, hit);
    }
    return hit;
  };
}

/** Nearest enclosing git root per directory, looked up on disk once per process. */
const gitRoots = new Map<string, string | null>();

export function gitRoot(dir: string): string | null {
  const cached = gitRoots.get(dir);
  if (cached !== undefined) return cached;
  // A `.git` file (worktrees, submodules) counts as well as a directory.
  const parent = dirname(dir);
  const root = existsSync(join(dir, ".git")) ? dir : parent === dir ? null : gitRoot(parent);
  gitRoots.set(dir, root);
  return root;
}

export interface ProjectRow {
  /** Git root, the working directory itself when there is none, or `(unattributed)`. */
  project: string;
  gitRoot: boolean;
  /** Distinct working directories rolled up into this project. */
  folders: string[];
  requests: number;
  tokens: number;
  cost: number;
  firstSeen: number | null;
  lastSeen: number | null;
}

/** Requests, tokens and cost per project, largest first, then an `(unattributed)` row (always present). */
export function projectBreakdown(rows: RequestRow[]): ProjectRow[] {
  const byProject = new Map<string, ProjectRow & { folderSet: Set<string> }>();
  byProject.set(UNATTRIBUTED, { project: UNATTRIBUTED, gitRoot: false, folders: [], folderSet: new Set(), requests: 0, tokens: 0, cost: 0, firstSeen: null, lastSeen: null });
  for (const row of rows) {
    const root = row.cwd === null ? null : gitRoot(row.cwd);
    const project = row.cwd === null ? UNATTRIBUTED : root ?? row.cwd;
    let entry = byProject.get(project);
    if (!entry) {
      entry = { project, gitRoot: root !== null, folders: [], folderSet: new Set(), requests: 0, tokens: 0, cost: 0, firstSeen: row.ts, lastSeen: row.ts };
      byProject.set(project, entry);
    }
    if (row.cwd !== null) entry.folderSet.add(row.cwd);
    entry.requests++;
    entry.tokens += row.totalTokens;
    entry.cost += row.cost;
    entry.firstSeen = Math.min(entry.firstSeen ?? row.ts, row.ts);
    entry.lastSeen = Math.max(entry.lastSeen ?? row.ts, row.ts);
  }
  return [...byProject.values()]
    .map(({ folderSet, ...entry }) => ({ ...entry, folders: [...folderSet].sort(), cost: Math.round(entry.cost * 10_000) / 10_000 }))
    .sort((a, b) => Number(a.project === UNATTRIBUTED) - Number(b.project === UNATTRIBUTED) || b.tokens - a.tokens);
}
