import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { CODEX_HOME } from "../env";

export interface CodexSession {
  cwd: string;
  sessionId: string;
  originator: string | null;
  startedAt: number | null;
}

/** Rollout files can exceed 30 MB; only the `session_meta` first line is read. */
const FIRST_LINE_CAP = 64 * 1024;
const READ_BATCH = 64;

/** opencodex derives a conversationId as the first 32 hex chars of sha256(<Codex session id>). */
export function conversationKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

interface RolloutMeta extends CodexSession {
  /** Root thread id for subagent rollouts (`session_id`); equals sessionId for roots. */
  rootId: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Fields of a `session_meta` line. Newer rollouts wrap them in `payload`. */
export function parseSessionMeta(line: string): RolloutMeta | null {
  let meta: Record<string, any> | undefined;
  try {
    const parsed = JSON.parse(line);
    meta = parsed?.type === "session_meta" ? parsed.payload : parsed;
  } catch {
    // A first line longer than the cap: the ids and cwd precede the long instructions.
    const field = (name: string) => line.match(new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
    const decode = (value: string | undefined) => {
      try { return value === undefined ? undefined : JSON.parse(`"${value}"`); } catch { return undefined; }
    };
    meta = { id: decode(field("id")), session_id: decode(field("session_id")), cwd: decode(field("cwd")), originator: decode(field("originator")), timestamp: decode(field("timestamp")) };
  }
  const sessionId = str(meta?.id);
  const cwd = str(meta?.cwd);
  if (!sessionId || !cwd) return null;
  const startedAt = typeof meta?.timestamp === "string" ? Date.parse(meta.timestamp) : NaN;
  return {
    cwd,
    sessionId,
    originator: str(meta?.originator),
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    rootId: str(meta?.session_id),
  };
}

async function readFirstLine(path: string): Promise<string | null> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(FIRST_LINE_CAP);
    const { bytesRead } = await handle.read(buffer, 0, FIRST_LINE_CAP, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    return bytesRead ? buffer.toString("utf8", 0, end === -1 ? bytesRead : end) : null;
  } finally {
    await handle.close();
  }
}

async function listRollouts(codexHome: string): Promise<string[]> {
  const files: string[] = [];
  // sessions/YYYY/MM/DD/rollout-*.jsonl, and archived_sessions/rollout-*.jsonl once Codex archives them.
  for (const sub of ["sessions", "archived_sessions"]) {
    const dir = join(codexHome, sub);
    try {
      for (const name of await readdir(dir, { recursive: true })) {
        const base = name.slice(name.lastIndexOf("/") + 1);
        if (base.startsWith("rollout-") && base.endsWith(".jsonl")) files.push(join(dir, name));
      }
    } catch {
      // No Codex install, or nothing archived yet.
    }
  }
  return files.sort();
}

interface HomeCache {
  files: Map<string, { signature: string; meta: RolloutMeta | null }>;
  index: Map<string, CodexSession>;
}

/** Per Codex home: parsed first lines by rollout path, and the last index built from them. */
const homes = new Map<string, HomeCache>();
const EMPTY: Map<string, CodexSession> = new Map();

function sameMeta(a: RolloutMeta | null | undefined, b: RolloutMeta | null): boolean {
  return a?.sessionId === b?.sessionId && a?.cwd === b?.cwd && a?.rootId === b?.rootId
    && a?.originator === b?.originator && a?.startedAt === b?.startedAt;
}

function buildIndex(metas: Iterable<RolloutMeta | null>): Map<string, CodexSession> {
  const index = new Map<string, CodexSession>();
  const fallback: RolloutMeta[] = [];
  for (const meta of metas) {
    if (!meta) continue;
    const key = conversationKey(meta.sessionId);
    // A copied rollout (resume, fork) can repeat an id; the first, sorted by path, wins.
    if (!index.has(key)) index.set(key, { cwd: meta.cwd, sessionId: meta.sessionId, originator: meta.originator, startedAt: meta.startedAt });
    if (meta.rootId && meta.rootId !== meta.sessionId) fallback.push(meta);
  }
  // Subagent traffic usually carries the root thread's id. When the root rollout is gone,
  // a surviving subagent rollout still names the root and its folder.
  for (const meta of fallback) {
    const key = conversationKey(meta.rootId!);
    if (!index.has(key)) index.set(key, { cwd: meta.cwd, sessionId: meta.rootId!, originator: meta.originator, startedAt: meta.startedAt });
  }
  return index;
}

/**
 * Codex sessions keyed by opencodex conversationId, from the first line of every rollout.
 * Unchanged files (path, size, mtime) are not re-read, and the same Map comes back until
 * a session is added, removed or changed, so callers can compare by identity.
 */
export async function readCodexSessionIndex(codexHome = CODEX_HOME): Promise<Map<string, CodexSession>> {
  const paths = await listRollouts(codexHome);
  const cache = homes.get(codexHome);
  if (!paths.length) {
    homes.delete(codexHome);
    return EMPTY;
  }
  const files: HomeCache["files"] = new Map();
  const stale: { path: string; signature: string }[] = [];
  await Promise.all(paths.map(async path => {
    const info = await stat(path).catch(() => null);
    if (!info) return;
    const signature = `${info.size}:${Math.round(info.mtimeMs)}`;
    const cached = cache?.files.get(path);
    if (cached?.signature === signature) files.set(path, cached);
    else stale.push({ path, signature });
  }));
  let changed = !cache;
  // Bounded, so a cold start over thousands of rollouts cannot run out of file descriptors.
  for (let start = 0; start < stale.length; start += READ_BATCH) {
    await Promise.all(stale.slice(start, start + READ_BATCH).map(async ({ path, signature }) => {
      let line: string | null;
      try {
        line = await readFirstLine(path);
      } catch {
        // Vanished or unreadable: leave it uncached so the next refresh retries it.
        return;
      }
      const meta = line ? parseSessionMeta(line) : null;
      files.set(path, { signature, meta });
      // Live rollouts are appended to constantly; their first line, and so the index, stays put.
      if (!sameMeta(cache?.files.get(path)?.meta, meta)) changed = true;
    }));
  }
  if (cache && !changed) for (const path of cache.files.keys()) if (!files.has(path)) changed = true;
  if (cache && !changed) {
    cache.files = files;
    return cache.index;
  }
  // Rebuild in path order so duplicate ids resolve the same way on every refresh.
  const index = buildIndex(paths.flatMap(path => files.has(path) ? [files.get(path)!.meta] : []));
  homes.set(codexHome, { files, index });
  return index;
}
