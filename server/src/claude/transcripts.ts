import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_PROJECTS } from "../env";

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Map one Claude Code `assistant` transcript line onto the ocx `usage.jsonl` entry shape,
 * so the existing `normalizeRow` + pricing engine handle it unchanged. Returns null for
 * lines that are not a metered model call.
 *
 * Not in transcripts, left empty: durationMs, firstOutputMs, effort, account, attempts.
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
    inboundProtocol: "claude-code",
    status: 200,
    usageStatus: "reported",
    // Cache counts come straight from the API response, not a proxy-side estimate.
    cacheProvenance: "observed",
    spend: { sends: 1, settled: 1, unresolved: 0 },
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
 * and resumed sessions copy history into new files. Keep one entry per requestId (the last seen).
 */
export function collectEntries(texts: string[]): Record<string, unknown>[] {
  const byRequest = new Map<string, Record<string, unknown>>();
  for (const text of texts) {
    for (const raw of text.split("\n")) {
      if (!raw.includes('"assistant"')) continue;
      try {
        const entry = toUsageEntry(JSON.parse(raw));
        if (entry) byRequest.set(String(entry.requestId), entry);
      } catch {
        // Live sessions can leave a torn tail line.
      }
    }
  }
  return [...byRequest.values()];
}

/** Parsed entries per transcript, reused until the file's size or mtime changes. */
const fileCache = new Map<string, { signature: string; entries: Record<string, unknown>[] }>();

/**
 * Usage entries from every transcript under `dir` (subagents live in `<session>/subagents/`).
 * `signature` changes whenever any transcript is added, removed, or appended to.
 */
export async function readClaudeEntries(dir = CLAUDE_PROJECTS): Promise<{ entries: Record<string, unknown>[]; signature: string }> {
  let files: string[];
  try {
    files = (await readdir(dir, { recursive: true })).filter(f => f.endsWith(".jsonl")).map(f => join(dir, f));
  } catch {
    return { entries: [], signature: "-" };
  }
  let bytes = 0;
  let newest = 0;
  const perFile = await Promise.all(files.map(async path => {
    const info = await stat(path).catch(() => null);
    if (!info) return [];
    bytes += info.size;
    newest = Math.max(newest, info.mtimeMs);
    const signature = `${info.size}:${Math.round(info.mtimeMs)}`;
    const cached = fileCache.get(path);
    if (cached?.signature === signature) return cached.entries;
    // ponytail: a changed file is re-parsed whole; read from the last byte offset if a live session gets huge.
    const entries = collectEntries([await readFile(path, "utf8")]);
    fileCache.set(path, { signature, entries });
    return entries;
  }));
  // Files that disappeared drop out of the cache.
  for (const path of fileCache.keys()) if (!files.includes(path)) fileCache.delete(path);

  // Re-dedupe across files: resumed sessions copy requests into the new transcript.
  const byRequest = new Map<string, Record<string, unknown>>();
  for (const entry of perFile.flat()) byRequest.set(String(entry.requestId), entry);
  return { entries: [...byRequest.values()], signature: `${files.length}:${bytes}:${Math.round(newest)}` };
}
