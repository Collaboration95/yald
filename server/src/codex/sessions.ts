import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createZstdDecompress } from "node:zlib";
import { CODEX_HOME } from "../env";

export interface CodexSession {
  cwd: string;
  sessionId: string;
  originator: string | null;
  startedAt: number | null;
  /** Null when the rollout records no `git` block: unavailable, not "no repository". */
  git: { branch: string | null; commitHash: string | null } | null;
  /** Set when this rollout is itself a spawned thread. */
  subagent: { parentThreadId: string | null; depth: number | null; agentRole: string | null } | null;
}

/** Rollout files can exceed 30 MB; only the `session_meta` first line is read, compressed or not. */
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
    const field = (name: string) => line.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
    const decode = (value: string | undefined) => {
      try { return value === undefined ? undefined : JSON.parse(`"${value}"`); } catch { return undefined; }
    };
    meta = { id: decode(field("id")), session_id: decode(field("session_id")), cwd: decode(field("cwd")), originator: decode(field("originator")), timestamp: decode(field("timestamp")) };
    const branch = decode(field("branch"));
    if (branch) meta.git = { branch, commit_hash: decode(field("commit_hash")) };
    const parent = decode(field("parent_thread_id"));
    if (parent) meta.source = { subagent: { thread_spawn: { parent_thread_id: parent, agent_role: decode(field("agent_role")), depth: Number(line.match(/"depth"\s*:\s*(\d+)/)?.[1] ?? Number.NaN) } } };
  }
  const sessionId = str(meta?.id);
  const cwd = str(meta?.cwd);
  if (!sessionId || !cwd) return null;
  const startedAt = typeof meta?.timestamp === "string" ? Date.parse(meta.timestamp) : NaN;
  const spawn = meta?.source?.subagent?.thread_spawn;
  return {
    cwd,
    sessionId,
    originator: str(meta?.originator),
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    rootId: str(meta?.session_id),
    // repository_url is left out on purpose: a remote URL can carry credentials.
    git: meta?.git ? { branch: str(meta.git.branch), commitHash: str(meta.git.commit_hash) } : null,
    subagent: spawn ? { parentThreadId: str(spawn.parent_thread_id), depth: Number.isFinite(spawn.depth) ? spawn.depth : null, agentRole: str(spawn.agent_role) } : null,
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

/** The first line of a compressed rollout, decoding no further than it. Bad data rejects, and is a miss for the caller. */
async function readCompressedFirstLine(path: string): Promise<string | null> {
  const input = createReadStream(path);
  const stream = input.pipe(createZstdDecompress());
  input.on("error", error => stream.destroy(error));
  let head = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      head = Buffer.concat([head, chunk as Buffer]);
      const end = head.indexOf(10);
      if (end !== -1 || head.length >= FIRST_LINE_CAP) return head.toString("utf8", 0, end === -1 ? FIRST_LINE_CAP : Math.min(end, FIRST_LINE_CAP));
    }
    return head.length ? head.toString("utf8") : null;
  } finally {
    input.destroy();
    stream.destroy();
  }
}

export interface Rollout { path: string; compressed: boolean }

export async function listRollouts(codexHome: string): Promise<Rollout[]> {
  const files: string[] = [];
  // sessions/YYYY/MM/DD/rollout-*.jsonl, and archived_sessions/rollout-*.jsonl once Codex archives them.
  for (const sub of ["sessions", "archived_sessions"]) {
    const dir = join(codexHome, sub);
    try {
      for (const name of await readdir(dir, { recursive: true })) {
        const base = name.slice(name.lastIndexOf("/") + 1);
        if (base.startsWith("rollout-") && (base.endsWith(".jsonl") || base.endsWith(".jsonl.zst"))) files.push(join(dir, name));
      }
    } catch {
      // No Codex install, or nothing archived yet.
    }
  }
  return files.sort().map(path => ({ path, compressed: path.endsWith(".zst") }));
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
    && a?.originator === b?.originator && a?.startedAt === b?.startedAt
    && JSON.stringify([a?.git, a?.subagent]) === JSON.stringify([b?.git, b?.subagent]);
}

function buildIndex(metas: Iterable<RolloutMeta | null>): Map<string, CodexSession> {
  const index = new Map<string, CodexSession>();
  const fallback: RolloutMeta[] = [];
  for (const meta of metas) {
    if (!meta) continue;
    const key = conversationKey(meta.sessionId);
    // A copied rollout (resume, fork) can repeat an id; the first, sorted by path, wins.
    if (!index.has(key)) index.set(key, { cwd: meta.cwd, sessionId: meta.sessionId, originator: meta.originator, startedAt: meta.startedAt, git: meta.git, subagent: meta.subagent });
    if (meta.rootId && meta.rootId !== meta.sessionId) fallback.push(meta);
  }
  // Subagent traffic usually carries the root thread's id. When the root rollout is gone,
  // a surviving subagent rollout still names the root and its folder.
  for (const meta of fallback) {
    const key = conversationKey(meta.rootId!);
    // The root's own branch and spawn are unknown here: this subagent's must not stand in for them.
    if (!index.has(key)) index.set(key, { cwd: meta.cwd, sessionId: meta.rootId!, originator: meta.originator, startedAt: meta.startedAt, git: null, subagent: null });
  }
  return index;
}

/**
 * Codex sessions keyed by opencodex conversationId, from the first line of every rollout.
 * Unchanged files (path, size, mtime) are not re-read, and the same Map comes back until
 * a session is added, removed or changed, so callers can compare by identity.
 */
export async function readCodexSessionIndex(codexHome = CODEX_HOME): Promise<Map<string, CodexSession>> {
  const rollouts = await listRollouts(codexHome);
  const paths = rollouts.map(rollout => rollout.path);
  const cache = homes.get(codexHome);
  if (!paths.length) {
    homes.delete(codexHome);
    return EMPTY;
  }
  const files: HomeCache["files"] = new Map();
  const stale: { path: string; signature: string }[] = [];
  await Promise.all(paths.map(async path => {
    const info = await stat(path, { bigint: true }).catch(() => null);
    if (!info) return;
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
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
        line = await (path.endsWith(".zst") ? readCompressedFirstLine(path) : readFirstLine(path));
      } catch {
        // A bad frame is the same as an unusable first line: a rollout miss, remembered until it changes.
        if (path.endsWith(".zst")) line = null;
        // Vanished or unreadable: leave it uncached so the next refresh retries it.
        else return;
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
