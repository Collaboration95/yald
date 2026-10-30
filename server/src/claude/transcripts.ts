import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CLAUDE_ARCHIVE, CLAUDE_PROJECTS } from "../env";
import { readTail, type TailCursor } from "../ingest/tail";

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Map one Claude Code `assistant` transcript line onto the ocx `usage.jsonl` entry shape,
 * so the existing `normalizeRow` + pricing engine handle it unchanged. Returns null for
 * lines that are not a metered model call.
 *
 * Not in transcripts, left empty: durationMs, firstOutputMs, effort, account, attempts.
 * `cwd` is kept so requests can be attributed to a project folder.
 */
export function toUsageEntry(line: Record<string, any>): Record<string, unknown> | null {
  const message = line?.message;
  const usage = message?.usage;
  if (line?.type !== "assistant" || !usage || !message.model || message.model === "<synthetic>") return null;
  const requestId = line.requestId ?? message.id;
  if (!requestId) return null;

  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  // ocx (OpenAI-style) inputTokens include cached tokens; Anthropic's input_tokens exclude them.
  const inputTokens = num(usage.input_tokens) + cacheRead + cacheWrite;
  const outputTokens = num(usage.output_tokens);
  return {
    requestId,
    timestamp: Date.parse(line.timestamp),
    provider: "anthropic",
    model: message.model,
    conversationId: line.sessionId,
    ...(typeof line.cwd === "string" && line.cwd ? { cwd: line.cwd } : {}),
    inboundProtocol: "claude-code",
    status: 200,
    usageStatus: "reported",
    // Cache counts come straight from the API response, not a proxy-side estimate.
    cacheProvenance: "observed",
    spend: { sends: 1, settled: 1, unresolved: 0 },
    usagePresence: {
      input: typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens) && usage.input_tokens >= 0,
      output: typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens) && usage.output_tokens >= 0,
      cacheRead: typeof usage.cache_read_input_tokens === "number" && Number.isFinite(usage.cache_read_input_tokens) && usage.cache_read_input_tokens >= 0,
      cacheWrite: typeof usage.cache_creation_input_tokens === "number" && Number.isFinite(usage.cache_creation_input_tokens) && usage.cache_creation_input_tokens >= 0,
    },
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheWrite,
      reasoningOutputTokens: num(usage.output_tokens_details?.thinking_tokens),
    },
    totalTokens: inputTokens + outputTokens,
    responseServiceTier: usage.service_tier,
    closeReason: message.stop_reason,
  };
}

/**
 * Claude Code splits one response into a line per content block, each repeating the usage,
 * and resumed sessions copy history into new files. Streaming usage is cumulative, so
 * retain the most complete snapshot per request, regardless of file traversal order.
 */
function retainEntry(byRequest: Map<string, Record<string, unknown>>, entry: Record<string, unknown>): boolean {
  const key = String(entry.requestId);
  let old = byRequest.get(key);
  let backfilled = false;
  if (old) {
    // Presence belongs to a usage snapshot. Only an identical snapshot can
    // recover flags erased by an older converter/archive.
    const oldUsage = old.usage as Record<string, unknown> | undefined;
    const nextUsage = entry.usage as Record<string, unknown> | undefined;
    const sameUsage = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]
      .every(key => oldUsage?.[key] === nextUsage?.[key]);
    if (!old.usagePresence && entry.usagePresence && sameUsage) {
      old = { ...old, usagePresence: entry.usagePresence };
      byRequest.set(key, old);
      backfilled = true;
    }
    if (!entry.usagePresence && old.usagePresence && sameUsage) entry = { ...entry, usagePresence: old.usagePresence };
    // Attribution is independent of streaming usage completeness. An incomplete
    // live copy can back-fill an old archive, and a later snapshot must keep it.
    if (!old.cwd && entry.cwd) {
      old = { ...old, cwd: entry.cwd };
      byRequest.set(key, old);
      backfilled = true;
    }
    if (!entry.cwd && old.cwd) entry = { ...entry, cwd: old.cwd };
    const tokens = num(entry.totalTokens);
    const oldTokens = num(old.totalTokens);
    if (tokens < oldTokens) return backfilled;
    if (tokens === oldTokens) {
      const timestamp = num(entry.timestamp);
      const oldTimestamp = num(old.timestamp);
      if (timestamp < oldTimestamp) return backfilled;
      // An equal copy wins only if it adds a stop reason.
      const addsCloseReason = !old.closeReason && entry.closeReason;
      if (timestamp === oldTimestamp && !addsCloseReason) return backfilled;
    }
  }
  byRequest.set(key, entry);
  return true;
}

/** Retains the usage entries of `text`'s lines into `byRequest`, in line order. */
function collectInto(byRequest: Map<string, Record<string, unknown>>, text: string): void {
  for (const raw of text.split("\n")) {
    if (!raw.includes('"assistant"')) continue;
    try {
      const entry = toUsageEntry(JSON.parse(raw));
      if (entry) retainEntry(byRequest, entry);
    } catch {
      // Live sessions can leave a torn tail line.
    }
  }
}

const TITLE_LIMIT = 120;
/** Later kinds outrank earlier ones: a title the user set beats a generated one. */
const TITLE_KINDS = [["summary", "summary"], ["ai-title", "aiTitle"], ["custom-title", "customTitle"]] as const;

interface SessionTitle { rank: number; title: string }

/**
 * Titles Claude Code recorded, by session. Local display only: they stay in this process, are
 * never written to the archive and never join a usage entry, so a deleted transcript takes its
 * title with it. `summary` lines carry no session id, so they belong to the file's session.
 */
function collectTitles(titles: Map<string, SessionTitle>, text: string, path: string): void {
  for (const raw of text.split("\n")) {
    if (!TITLE_KINDS.some(([kind]) => raw.includes(`"${kind}"`))) continue;
    try {
      const line = JSON.parse(raw);
      const rank = TITLE_KINDS.findIndex(([kind]) => kind === line?.type);
      const value = rank === -1 ? null : line[TITLE_KINDS[rank]![1]];
      if (typeof value !== "string" || !value.trim()) continue;
      const session = typeof line.sessionId === "string" && line.sessionId ? line.sessionId : basename(path, ".jsonl");
      if ((titles.get(session)?.rank ?? -1) <= rank) titles.set(session, { rank, title: value.trim().slice(0, TITLE_LIMIT) });
    } catch {
      // Live sessions can leave a torn tail line.
    }
  }
}

export function collectEntries(texts: string[]): Record<string, unknown>[] {
  const byRequest = new Map<string, Record<string, unknown>>();
  for (const text of texts) collectInto(byRequest, text);
  return [...byRequest.values()];
}

/**
 * Per transcript: its entries, reused until the file's size or mtime changes, and what its
 * complete lines held (`committed`) up to `cursor`, so an append is read and retained from
 * there. An unterminated last line is retained into the entries but not into `committed`.
 */
const fileCache = new Map<string, {
  signature: string;
  entries: Record<string, unknown>[];
  cursor: TailCursor;
  committed: ReadonlyMap<string, Record<string, unknown>>;
  titles: ReadonlyMap<string, SessionTitle>;
}>();

/** Recorded session titles from the transcripts still on disk, by session id. */
export function claudeSessionTitles(): Map<string, string> {
  const best = new Map<string, SessionTitle>();
  for (const { titles } of fileCache.values()) {
    for (const [session, title] of titles) if ((best.get(session)?.rank ?? -1) <= title.rank) best.set(session, title);
  }
  return new Map([...best].map(([session, { title }]) => [session, title]));
}

let transcriptBytes = 0;
/** Transcript bytes read since the process started; for diagnostics and tests. */
export const transcriptBytesRead = (): number => transcriptBytes;

interface ArchiveInfo { signature: string; bytes: number; identity: string }

async function archiveInfo(path: string): Promise<ArchiveInfo | null> {
  const info = await stat(path, { bigint: true }).catch(() => null);
  return info ? {
    signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
    bytes: Number(info.size),
    identity: `${info.dev}:${info.ino}`,
  } : null;
}

/** Archived entries by requestId, reused until the archive changes on disk. */
let archive: { path: string; info: ArchiveInfo | null; byRequest: Map<string, Record<string, unknown>> } | null = null;

async function loadArchive(path: string): Promise<Map<string, Record<string, unknown>>> {
  const info = await archiveInfo(path);
  if (archive?.path === path && archive.info?.signature === info?.signature) return archive.byRequest;
  const byRequest = new Map<string, Record<string, unknown>>();
  // Old archives can contain zeroed resumed copies after the complete response.
  for (const raw of (await readFile(path, "utf8").catch(() => "")).split("\n")) {
    try {
      const entry = JSON.parse(raw);
      retainEntry(byRequest, entry);
    } catch {
      // Blank or torn line.
    }
  }
  archive = { path, info, byRequest };
  return byRequest;
}

type ClaudeEntries = { entries: Record<string, unknown>[]; signature: string };

/** The last merged result. Identical inputs (file list, every file and archive signature) return it as is. */
let lastEntries: ClaudeEntries | null = null;

/** Every input of the merge: the archive's and each transcript's file signature. */
function inputSignature(archivePath: string, files: string[], signatures: Map<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify([archivePath, archive?.info?.signature ?? null, files.map(path => [path, signatures.get(path) ?? null])]))
    .digest("hex");
}

/**
 * Usage entries from every transcript under `dir` (subagents live in `<session>/subagents/`),
 * plus every entry ever archived. Claude Code deletes old transcripts, so new or changed
 * entries are appended to `archivePath` and keep counting after their transcript is gone.
 * `signature` changes whenever any transcript is added, removed, or appended to. When no
 * input changed, the previous result (the same `entries` array) comes back without a merge pass.
 * A transcript that grew is read from its last complete line, unless `full` (Refresh) asks
 * for whole files or it was replaced, shrunk or rewritten before that line (ingest/tail.ts).
 */
export async function readClaudeEntries(dir = CLAUDE_PROJECTS, archivePath = CLAUDE_ARCHIVE, options: { full?: boolean } = {}): Promise<ClaudeEntries> {
  let files: string[] = [];
  try {
    files = (await readdir(dir, { recursive: true })).filter(f => f.endsWith(".jsonl")).map(f => join(dir, f)).sort();
  } catch {
    // No transcripts left; the archive still counts.
  }
  const signatures = new Map<string, string>();
  const perFile = await Promise.all(files.map(async path => {
    const info = await stat(path, { bigint: true }).catch(() => null);
    if (!info) return [];
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    signatures.set(path, signature);
    const cached = fileCache.get(path);
    if (cached?.signature === signature) return cached.entries;
    const read = await readTail(path, { dev: String(info.dev), ino: String(info.ino), size: Number(info.size) }, options.full ? null : cached?.cursor ?? null);
    transcriptBytes += read.bytesRead;
    // retainEntry can replace an earlier snapshot of a request, so appended lines are retained
    // into a copy of what the complete lines held, in order, exactly as a whole-file pass would.
    const committed = new Map<string, Record<string, unknown>>(read.reset || !cached ? [] : cached.committed);
    collectInto(committed, read.complete);
    const titles = new Map<string, SessionTitle>(read.reset || !cached ? [] : cached.titles);
    collectTitles(titles, read.complete, path);
    let byRequest = committed;
    if (read.partial) {
      byRequest = new Map(committed);
      collectInto(byRequest, read.partial);
    }
    const entries = [...byRequest.values()];
    fileCache.set(path, { signature, entries, cursor: read.cursor, committed, titles });
    return entries;
  }));
  // Files that disappeared drop out of the cache.
  const listed = new Set(files);
  for (const path of fileCache.keys()) if (!listed.has(path)) fileCache.delete(path);

  // Cached transcripts also back-fill when a different archive is opened. Entries
  // archived before cwd was kept are re-appended once with the cwd from their live transcript.
  let archived = await loadArchive(archivePath);
  // Same transcripts, same bytes, same archive: the merge below would rebuild the same result.
  if (lastEntries && lastEntries.signature === inputSignature(archivePath, files, signatures)) return lastEntries;
  const candidates = new Map(archived);
  for (const entries of perFile) for (const entry of entries) retainEntry(candidates, entry);
  const changed = [...candidates.values()].filter(entry => entry !== archived.get(String(entry.requestId)));
  let writeFailed = false;
  if (changed.length) {
    try {
      await mkdir(dirname(archivePath), { recursive: true });
      const text = changed.map(entry => JSON.stringify(entry) + "\n").join("");
      const before = archive!.info;
      await appendFile(archivePath, text);
      for (const entry of changed) archived.set(String(entry.requestId), entry);
      const after = await archiveInfo(archivePath);
      // Preserve entry identity after our own append. A concurrent append or
      // replacement must instead be loaded before its fingerprint is published.
      if (after && after.bytes === (before?.bytes ?? 0) + Buffer.byteLength(text)
        && (!before || before.identity === after.identity)) archive!.info = after;
      else archived = await loadArchive(archivePath);
    } catch {
      // Forget parses so the next refresh retries the write.
      fileCache.clear();
      writeFailed = true;
    }
  }

  // Resumed copies can have zeroed usage. Apply the same selection to live and archived entries.
  const byRequest = new Map(archived);
  for (const entry of perFile.flat()) retainEntry(byRequest, entry);
  const result = { entries: [...byRequest.values()], signature: inputSignature(archivePath, files, signatures) };
  // A failed archive write is retried by the next call, so it must not short-circuit.
  lastEntries = writeFailed ? null : result;
  return result;
}
