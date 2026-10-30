import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CLAUDE_ARCHIVE, CLAUDE_EVENT_ARCHIVE, CLAUDE_PROJECTS } from "../env";
import { readTail, type TailCursor } from "../ingest/tail";

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Map one Claude Code `assistant` transcript line onto the ocx `usage.jsonl` entry shape,
 * so the existing `normalizeRow` + pricing engine handle it unchanged. Returns null for
 * lines that are not a metered model call.
 *
 * Not in transcripts, left empty: durationMs, firstOutputMs, account, attempts.
 * `cwd` is kept so requests can be attributed to a project folder. `detail` holds the
 * structural fields of #96: names, ids and counts, never message or tool text.
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
    detail: toDetail(line),
  };
}

/** What one transcript line says about its request. `v` marks a line read by this parser; a field it lacks stays absent. */
export interface EntryDetail {
  v: 1;
  isSidechain?: boolean;
  agentId?: string;
  attributionAgent?: string;
  effort?: string;
  perTurnEffort?: string | boolean;
  thinkingDurationMs?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheMissReason?: string;
  gitBranch?: string;
  promptId?: string;
  /** Tool name by tool_use id. Ids deduplicate the same block across repeated lines. */
  tools?: Record<string, string>;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

function toDetail(line: Record<string, any>): EntryDetail {
  const message = line.message;
  const creation = message?.usage?.cache_creation;
  const tools: Record<string, string> = {};
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === "tool_use" && text(block.id) && text(block.name)) tools[block.id] = block.name;
  }
  const detail: EntryDetail = { v: 1 };
  const keep = <K extends keyof EntryDetail>(key: K, value: EntryDetail[K] | undefined) => { if (value !== undefined) detail[key] = value; };
  if (typeof line.isSidechain === "boolean") detail.isSidechain = line.isSidechain;
  keep("agentId", text(line.agentId));
  keep("attributionAgent", text(line.attributionAgent));
  keep("effort", text(line.effort));
  keep("perTurnEffort", typeof line.perTurnEffort === "boolean" ? line.perTurnEffort : text(line.perTurnEffort));
  keep("thinkingDurationMs", count(line.thinkingDurationMs));
  keep("cacheWrite5m", count(creation?.ephemeral_5m_input_tokens));
  keep("cacheWrite1h", count(creation?.ephemeral_1h_input_tokens));
  keep("cacheMissReason", text(message?.diagnostics?.cache_miss_reason));
  keep("gitBranch", text(line.gitBranch));
  keep("promptId", text(line.promptId));
  if (Object.keys(tools).length) detail.tools = tools;
  return detail;
}

/** Both copies' fields, the newer winning; `old` itself (same identity) when `next` adds nothing. */
function mergeDetail(old: EntryDetail | undefined, next: EntryDetail | undefined): EntryDetail | undefined {
  if (!old || !next) return old ?? next;
  const adds = (Object.keys(next) as (keyof EntryDetail)[]).some(key => key !== "tools" && old[key] === undefined)
    || Object.keys(next.tools ?? {}).some(id => old.tools?.[id] === undefined);
  if (!adds) return old;
  const tools = { ...old.tools, ...next.tools };
  return { ...old, ...next, ...(Object.keys(tools).length ? { tools } : {}) };
}

/** A transcript record that is not a request: facts and counts only, no text. `key` is unique per record. */
export type ClaudeEvent = { key: string; sessionId: string; ts: number } & (
  | { kind: "compact"; agentId: string | null; trigger: string | null; preTokens: number | null; postTokens: number | null; durationMs: number | null }
  | { kind: "api-error"; retryAttempt: number | null; maxRetries: number | null; status: number | null; code: string | null }
  | { kind: "turn"; durationMs: number | null; messageCount: number | null }
  | { kind: "prompt"; promptId: string | null }
  | { kind: "pr"; prNumber: number; prRepository: string }
  | { kind: "agent"; agentId: string; agentType: string | null; spawnDepth: number | null; model: string | null; effort: string | null; toolUseId: string | null }
  /** The session was read with event capture, so "no compaction recorded" means something. */
  | { kind: "captured" }
);

const orNull = <T>(value: T | undefined): T | null => value ?? null;

/** The event one transcript line records, or null. Prompt text is looked at only to classify, never kept. */
export function toEvent(line: Record<string, any>): ClaudeEvent | null {
  const sessionId = text(line?.sessionId);
  const ts = Date.parse(line?.timestamp);
  if (!sessionId || !Number.isFinite(ts)) return null;
  const base = { sessionId, ts };
  const key = (kind: string) => `${kind}:${sessionId}:${text(line.uuid) ?? ts}`;
  if (line.type === "system" && line.subtype === "compact_boundary") {
    const meta = line.compactMetadata ?? {};
    return { ...base, key: key("compact"), kind: "compact", agentId: orNull(text(line.agentId)), trigger: orNull(text(meta.trigger)),
      preTokens: orNull(count(meta.preTokens)), postTokens: orNull(count(meta.postTokens)), durationMs: orNull(count(meta.durationMs)) };
  }
  if (line.type === "system" && line.subtype === "api_error") {
    return { ...base, key: key("api-error"), kind: "api-error", retryAttempt: orNull(count(line.retryAttempt)), maxRetries: orNull(count(line.maxRetries)),
      status: orNull(count(line.error?.status)), code: orNull(text(line.apiError)) };
  }
  if (line.type === "system" && line.subtype === "turn_duration") {
    return { ...base, key: key("turn"), kind: "turn", durationMs: orNull(count(line.durationMs)), messageCount: orNull(count(line.messageCount)) };
  }
  if (line.type === "assistant" && text(line.apiError)) {
    return { ...base, key: key("api-error"), kind: "api-error", retryAttempt: null, maxRetries: null, status: null, code: text(line.apiError)! };
  }
  if (line.type === "pr-link" && count(line.prNumber) !== undefined && text(line.prRepository)) {
    return { ...base, key: `pr:${sessionId}:${line.prRepository}#${line.prNumber}`, kind: "pr", prNumber: line.prNumber, prRepository: line.prRepository };
  }
  const content = line.message?.content;
  const toolResult = Array.isArray(content) && content.some(block => block?.type === "tool_result");
  if (line.type === "user" && !toolResult && !line.isMeta && !line.isSidechain && !line.isCompactSummary && !line.isVisibleInTranscriptOnly) {
    return { ...base, key: key("prompt"), kind: "prompt", promptId: orNull(text(line.promptId)) };
  }
  return null;
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
    // Structure is independent of usage completeness, like cwd below: every copy of a
    // request (one line per content block) contributes, and a later snapshot keeps it all.
    const detail = mergeDetail(old.detail as EntryDetail | undefined, entry.detail as EntryDetail | undefined);
    if (detail !== old.detail) {
      old = { ...old, detail };
      byRequest.set(key, old);
      backfilled = true;
    }
    if (entry.detail !== detail) entry = { ...entry, detail };
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

/**
 * Retains the usage entries of `content`'s lines into `byRequest` and their events into `events`,
 * in line order. A quote inside a string is escaped in JSON, so these substrings only match real
 * keys and values, and a tool-result line (usually the largest kind) is skipped without parsing;
 * `"tool_use"` keeps any assistant line that also mentions one.
 */
function collectInto(byRequest: Map<string, Record<string, unknown>>, content: string, events?: Map<string, ClaudeEvent>): void {
  for (const raw of content.split("\n")) {
    // First, because the marker sits near the start of the very lines that are costly to scan.
    if (raw.includes('"tool_use_id"') && !raw.includes('"tool_use"')) continue;
    const assistant = raw.includes('"assistant"');
    if (!assistant && !raw.includes('"system"') && !raw.includes('"pr-link"') && !raw.includes('"user"')) continue;
    try {
      const line = JSON.parse(raw);
      const entry = assistant ? toUsageEntry(line) : null;
      if (entry) retainEntry(byRequest, entry);
      const event = events ? toEvent(line) : null;
      if (event) events?.set(event.key, event);
      const session = entry ? String(entry.conversationId ?? "") : event?.sessionId;
      if (session && !events?.has(`captured:${session}`)) events?.set(`captured:${session}`, { key: `captured:${session}`, kind: "captured", sessionId: session, ts: 0 });
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
  events: ReadonlyMap<string, ClaudeEvent>;
}>();

/** Agent records by sidecar path, reused until the file changes. */
const metaCache = new Map<string, { signature: string; event: ClaudeEvent | null }>();

/** `<session>/subagents/agent-<id>.meta.json`: named fields only, so a task description in the file is never kept. */
export function toAgentEvent(path: string, content: string): ClaudeEvent | null {
  const match = path.match(/([^/\\]+)[/\\]subagents[/\\]agent-([^/\\]+)\.meta\.json$/);
  if (!match) return null;
  const [, sessionId, agentId] = match as unknown as [string, string, string];
  try {
    const meta = JSON.parse(content);
    return { key: `agent:${sessionId}:${agentId}`, kind: "agent", sessionId, ts: 0, agentId, agentType: orNull(text(meta?.agentType)), spawnDepth: orNull(count(meta?.spawnDepth)),
      model: orNull(text(meta?.model)), effort: orNull(text(meta?.effort)), toolUseId: orNull(text(meta?.toolUseId)) };
  } catch {
    return null;
  }
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

/** Archived events by key, reused until the file changes. */
let eventArchive: { path: string; info: ArchiveInfo | null; byKey: Map<string, ClaudeEvent> } | null = null;

async function loadEventArchive(path: string): Promise<Map<string, ClaudeEvent>> {
  const info = await archiveInfo(path);
  if (eventArchive?.path === path && eventArchive.info?.signature === info?.signature) return eventArchive.byKey;
  const byKey = new Map<string, ClaudeEvent>();
  for (const raw of (await readFile(path, "utf8").catch(() => "")).split("\n")) {
    try {
      const event = JSON.parse(raw) as ClaudeEvent;
      if (event?.key) byKey.set(event.key, event);
    } catch {
      // Blank or torn line.
    }
  }
  eventArchive = { path, info, byKey };
  return byKey;
}

type ClaudeEntries = { entries: Record<string, unknown>[]; events: ClaudeEvent[]; signature: string };

/** The last merged result. Identical inputs (file list, every file and archive signature) return it as is. */
let lastEntries: ClaudeEntries | null = null;

/** Every input of the merge: the archive's and each transcript's file signature. */
function inputSignature(archivePath: string, files: string[], signatures: Map<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify([archivePath, archive?.info?.signature ?? null, eventArchive?.info?.signature ?? null, files.map(path => [path, signatures.get(path) ?? null])]))
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
export async function readClaudeEntries(dir = CLAUDE_PROJECTS, archivePath = CLAUDE_ARCHIVE, options: { full?: boolean; eventArchivePath?: string } = {}): Promise<ClaudeEntries> {
  const eventArchivePath = options.eventArchivePath ?? (archivePath === CLAUDE_ARCHIVE ? CLAUDE_EVENT_ARCHIVE : `${archivePath}.events`);
  let files: string[] = [];
  let metas: string[] = [];
  try {
    const listed = await readdir(dir, { recursive: true });
    files = listed.filter(f => f.endsWith(".jsonl")).map(f => join(dir, f)).sort();
    metas = listed.filter(f => f.endsWith(".meta.json")).map(f => join(dir, f)).sort();
  } catch {
    // No transcripts left; the archive still counts.
  }
  const signatures = new Map<string, string>();
  const agentEvents = await Promise.all(metas.map(async path => {
    const info = await stat(path, { bigint: true }).catch(() => null);
    if (!info) return null;
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    signatures.set(path, signature);
    const cached = metaCache.get(path);
    if (cached?.signature === signature) return cached.event;
    const event = toAgentEvent(path, await readFile(path, "utf8").catch(() => ""));
    metaCache.set(path, { signature, event });
    return event;
  }));
  for (const path of metaCache.keys()) if (!metas.includes(path)) metaCache.delete(path);
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
    const events = new Map<string, ClaudeEvent>(read.reset || !cached ? [] : cached.events);
    collectInto(committed, read.complete, events);
    let byRequest = committed;
    if (read.partial) {
      byRequest = new Map(committed);
      collectInto(byRequest, read.partial);
    }
    const entries = [...byRequest.values()];
    fileCache.set(path, { signature, entries, cursor: read.cursor, committed, events });
    return entries;
  }));
  // Files that disappeared drop out of the cache.
  const listed = new Set(files);
  for (const path of fileCache.keys()) if (!listed.has(path)) fileCache.delete(path);

  // Cached transcripts also back-fill when a different archive is opened. Entries
  // archived before cwd was kept are re-appended once with the cwd from their live transcript.
  let archived = await loadArchive(archivePath);
  let archivedEvents = await loadEventArchive(eventArchivePath);
  // Same transcripts, same bytes, same archives: the merge below would rebuild the same result.
  if (lastEntries && lastEntries.signature === inputSignature(archivePath, files.concat(metas), signatures)) return lastEntries;
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

  // Events outlive their transcripts too, in their own file: an older yald reading the usage
  // archive never meets a line without a requestId.
  const fresh: ClaudeEvent[] = [];
  const seen = new Set<string>();
  const add = (event: ClaudeEvent | null) => {
    if (!event || archivedEvents.has(event.key) || seen.has(event.key)) return;
    seen.add(event.key);
    fresh.push(event);
  };
  agentEvents.forEach(add);
  for (const path of files) for (const event of fileCache.get(path)?.events.values() ?? []) add(event);
  if (fresh.length) {
    try {
      await mkdir(dirname(eventArchivePath), { recursive: true });
      const content = fresh.map(event => JSON.stringify(event) + "\n").join("");
      const before = eventArchive!.info;
      await appendFile(eventArchivePath, content);
      const after = await archiveInfo(eventArchivePath);
      // Our own append keeps the parsed map; anything else on disk is loaded before it is trusted.
      if (after && after.bytes === (before?.bytes ?? 0) + Buffer.byteLength(content) && (!before || before.identity === after.identity)) {
        for (const event of fresh) archivedEvents.set(event.key, event);
        eventArchive!.info = after;
      } else archivedEvents = await loadEventArchive(eventArchivePath);
    } catch {
      fileCache.clear();
      metaCache.clear();
      writeFailed = true;
    }
  }

  // Resumed copies can have zeroed usage. Apply the same selection to live and archived entries.
  const byRequest = new Map(archived);
  for (const entry of perFile.flat()) retainEntry(byRequest, entry);
  const events = new Map(archivedEvents);
  for (const event of fresh) events.set(event.key, event);
  const result = { entries: [...byRequest.values()], events: [...events.values()], signature: inputSignature(archivePath, files.concat(metas), signatures) };
  // A failed archive write is retried by the next call, so it must not short-circuit.
  lastEntries = writeFailed ? null : result;
  return result;
}
