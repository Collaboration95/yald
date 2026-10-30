import { stat, readFile } from "node:fs/promises";
import { readClaudeEntries, transcriptBytesRead, type ClaudeEvent, type EntryDetail } from "../claude/transcripts";
import { mergeRolloutQuota, readRolloutQuotaSamples } from "../codex/quota";
import { readCodexSessionIndex, type CodexSession } from "../codex/sessions";
import { readTail, TailChangedError, type TailCursor, type TailFile, type TailRead } from "../ingest/tail";
import { SOURCE_CAPABILITIES, sourceOf, type Measurements } from "../report/source";
import { PATHS } from "../env";
import { loadPricing, priceWithCacheCounterfactual, pricingGeneration, type CacheEconomics } from "./pricing";

export interface RequestRow {
  measurements: Measurements;
  id: string;
  ts: number;
  provider: string;
  model: string;
  requestedModel: string | null;
  resolvedModel: string | null;
  effort: string | null;
  status: number;
  ok: boolean;
  durationMs: number;
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  priced: boolean;
  estimated: boolean;
  rateIn: number | null;
  rateOut: number | null;
  rateCacheRead: number | null;
  rateCacheWrite: number | null;
  conversationId: string | null;
  errorCode: string | null;
  closeReason: string | null;
  routeKind: string | null;
  account: string | null;
  protocol: string | null;
  attempts: number;
  sends: number;
  settled: number;
  unresolved: number;
  cacheProvenance: string | null;
  contextTier: "long" | null;
  /**
   * The engine's own cost per token class (input excludes cache), so the classes add up to `cost`
   * exactly, including long-context tier and priority rows. Null/absent: unpriced or incomplete.
   */
  costParts?: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  serviceTier: string | null;
  retried: boolean;
  /** True when the row had no top-level usage and tokens were summed from attempts. */
  usageFromAttempts: boolean;
  /** Reported metering status from the ledger. */
  usageStatus: string;
  /** Tokens across every physical attempt; > totalTokens means retries re-sent work. */
  attemptTokens: number;
  /** Working directory the request came from; null when it cannot be attributed. */
  cwd: string | null;
  /** True when a Codex rollout index was read and held no session for this row's conversationId. */
  rolloutMiss?: boolean;
  /** What this row's Codex rollout recorded. Absent: no rollout, or it recorded none of this. */
  codexSession?: { gitBranch: string | null; commitHash: string | null; parentThreadId: string | null; depth: number | null; agentRole: string | null };
  /**
   * The same recorded workload priced with and without its cache counters, under the
   * engine's own tier/service decisions (L04). Null/absent: unpriced or not computed.
   */
  cacheEconomics?: CacheEconomics | null;
  /** Structure a Claude transcript recorded for this request (#96). Null: not available, not "none". */
  details?: RequestDetails | null;
}

/** Each field is null when the transcript did not record it, so absence never reads as zero or as "main". */
export interface RequestDetails {
  /** From `isSidechain`. Null is unlabelled: never counted as main. */
  agent: "main" | "subagent" | null;
  agentId: string | null;
  agentType: string | null;
  spawnDepth: number | null;
  /** The tool_use that spawned this agent, from the agent's sidecar. */
  spawnToolUseId: string | null;
  attributionAgent: string | null;
  perTurnEffort: string | boolean | null;
  thinkingDurationMs: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  cacheMissReason: string | null;
  gitBranch: string | null;
  promptId: string | null;
  /** Requested tool calls by tool name. Null on lines from before #96. */
  toolCounts: Record<string, number> | null;
  /** The tool_use ids of this request, so a spawn can be linked to it. Ids only. */
  toolUseIds: string[] | null;
}

function requestDetails(detail: EntryDetail | undefined): RequestDetails | null {
  if (!detail) return null;
  const toolCounts: Record<string, number> = {};
  for (const name of Object.values(detail.tools ?? {})) toolCounts[name] = (toolCounts[name] ?? 0) + 1;
  return {
    agent: detail.isSidechain === undefined ? null : detail.isSidechain ? "subagent" : "main",
    agentId: detail.agentId ?? null, agentType: null, spawnDepth: null, spawnToolUseId: null,
    attributionAgent: detail.attributionAgent ?? null, perTurnEffort: detail.perTurnEffort ?? null,
    thinkingDurationMs: detail.thinkingDurationMs ?? null, cacheWrite5m: detail.cacheWrite5m ?? null, cacheWrite1h: detail.cacheWrite1h ?? null,
    cacheMissReason: detail.cacheMissReason ?? null, gitBranch: detail.gitBranch ?? null, promptId: detail.promptId ?? null,
    toolCounts, toolUseIds: Object.keys(detail.tools ?? {}),
  };
}

export interface QuotaSample {
  account: string;
  family: string;
  window: string;
  usedPercent: number;
  resetAtMs: number | null;
  observedAt: number;
  source: string;
}

export interface QuotaWindowSnapshot {
  account: string;
  window: string;
  usedPercent: number;
  resetAtMs: number | null;
  updatedAt: number;
}

export interface SpendEvent {
  kind: "reserve" | "dispatch" | "settle" | "lost" | "checkpoint" | string;
  at: number;
  sendId: string | null;
  tokens: number;
}

export interface Dataset {
  rows: RequestRow[];
  /** Claude Code records that are not requests, from transcripts and their archive. */
  claudeEvents?: ClaudeEvent[];
  quota: {
    windows: QuotaWindowSnapshot[];
    samples: QuotaSample[];
    updatedAt: number | null;
  };
  ledger: {
    events: SpendEvent[];
    byKind: Record<string, number>;
    settledTokens: number;
    updatedAt: number | null;
  };
  files: {
    usage: { path: string; bytes: number; mtimeMs: number; lines: number } | null;
    spend: { path: string; bytes: number; mtimeMs: number } | null;
    quota: { path: string; bytes: number; mtimeMs: number } | null;
  };
  parse: { malformedLines: number; durationMs: number };
  builtAt: number;
  revision: string;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The engine's per-class costs when they are finite, non-negative and add up to its total; otherwise null. */
function engineCostParts(cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | undefined): RequestRow["costParts"] {
  if (!cost) return null;
  const parts = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
  if (![...parts, cost.total].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;
  const sum = parts[0]! + parts[1]! + parts[2]! + parts[3]!;
  if (Math.abs(sum - cost.total) > 1e-9 * Math.max(1, cost.total)) return null;
  return { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite };
}

export function normalizeRow(entry: Record<string, any>): RequestRow {
  const present = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const presence = (usage: Record<string, any>) => ({
    input: present(usage.inputTokens), output: present(usage.outputTokens),
    cacheRead: present(usage.cacheReadInputTokens ?? usage.cachedInputTokens),
    cacheWrite: present(usage.cacheCreationInputTokens ?? usage.cacheWriteInputTokens),
  });
  let usage = entry.usage ?? {};
  let usagePresence = presence(usage);
  let usageFromAttempts = false;
  if (!usagePresence.input && !usagePresence.output && Array.isArray(entry.attempts)) {
    // A failed logical request often carries no top-level usage while its attempts do.
    // Summing them recovers the tokens actually burned upstream (retries, half-streams).
    const summed: Record<string, number> = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    };
    let found = false;
    let summedPresence = { input: true, output: true, cacheRead: true, cacheWrite: true };
    for (const attempt of entry.attempts) {
      const attemptUsage = attempt?.usage;
      if (!attemptUsage) continue;
      found = true;
      const fields = presence(attemptUsage);
      summedPresence = { input: summedPresence.input && fields.input, output: summedPresence.output && fields.output,
        cacheRead: summedPresence.cacheRead && fields.cacheRead, cacheWrite: summedPresence.cacheWrite && fields.cacheWrite };
      summed.inputTokens += num(attemptUsage.inputTokens);
      summed.outputTokens += num(attemptUsage.outputTokens);
      summed.cachedInputTokens += num(attemptUsage.cachedInputTokens);
      summed.cacheReadInputTokens += num(attemptUsage.cacheReadInputTokens ?? attemptUsage.cachedInputTokens);
      summed.cacheCreationInputTokens += num(attemptUsage.cacheCreationInputTokens ?? attemptUsage.cacheWriteInputTokens);
      summed.cacheWriteInputTokens += num(attemptUsage.cacheWriteInputTokens);
      summed.reasoningOutputTokens += num(attemptUsage.reasoningOutputTokens);
      summed.totalTokens += num(attemptUsage.totalTokens);
    }
    if (found) {
      usage = summed;
      usageFromAttempts = true;
      usagePresence = summedPresence;
    }
  }
  const inputTokens = num(usage.inputTokens);
  const outputTokens = num(usage.outputTokens);
  const cacheReadTokens = num(usage.cacheReadInputTokens ?? usage.cachedInputTokens);
  const cacheWriteTokens = num(usage.cacheCreationInputTokens ?? usage.cacheWriteInputTokens);
  const reasoningTokens = num(usage.reasoningOutputTokens);
  const storedTotal = typeof entry.totalTokens === "number" ? entry.totalTokens : undefined;
  const totalTokens = usage.inputTokens === undefined && usage.outputTokens === undefined
    ? num(storedTotal)
    : Math.max(storedTotal ?? 0, inputTokens + outputTokens);

  // Attempt-summed usage is not one priced request; it never gets a counterfactual.
  const { estimate, cache: cacheEconomics } = priceWithCacheCounterfactual({ ...entry, usage }, !usageFromAttempts);
  const routedKind = str(entry.routeDecision?.routeKind);
  const attempts = Array.isArray(entry.attempts) ? entry.attempts.length : 1;
  const spend = entry.spend ?? {};

  let attemptTokens = 0;
  if (Array.isArray(entry.attempts)) {
    for (const attempt of entry.attempts) {
      const attemptUsage = attempt?.usage;
      if (!attemptUsage) continue;
      attemptTokens += Math.max(
        num(attemptUsage.inputTokens) + num(attemptUsage.outputTokens),
        num(attemptUsage.totalTokens),
      );
    }
  }

  const capabilities = SOURCE_CAPABILITIES[sourceOf({ protocol: str(entry.inboundProtocol) })];
  // Transcript converters supply presence before their arithmetic supplies zero defaults.
  // Older archive entries without that evidence cannot prove input/cache presence.
  if (sourceOf({ protocol: str(entry.inboundProtocol) }) === "claude-code") {
    const saved = entry.usagePresence ?? {};
    usagePresence = { input: saved.input === true, output: saved.output === true,
      cacheRead: saved.cacheRead === true, cacheWrite: saved.cacheWrite === true };
  }
  const measurements: Measurements = {
    ...usagePresence,
    outcome: capabilities.outcomes && ((present(entry.status) && entry.status > 0) || !!str(entry.errorCode) || entry.closeReason === "client_closed"),
    duration: capabilities.timing && present(entry.durationMs),
    ttft: capabilities.timing && present(entry.firstOutputMs),
    retries: capabilities.retries && Array.isArray(entry.attempts),
    usage: usageFromAttempts ? "attempt-sum" : usagePresence.input || usagePresence.output ? "logical" : "missing",
  };
  return {
    measurements,
    id: String(entry.requestId),
    ts: num(entry.timestamp),
    provider: String(entry.provider ?? "unknown"),
    model: String(entry.model ?? "unknown"),
    requestedModel: str(entry.requestedModel),
    resolvedModel: str(entry.resolvedModel),
    effort: str(entry.effectiveEffort) ?? str(entry.requestedEffort) ?? str(entry.detail?.effort),
    status: num(entry.status),
    ok: num(entry.status) > 0 && num(entry.status) < 400,
    durationMs: num(entry.durationMs),
    ttftMs: finiteOrNull(entry.firstOutputMs),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    cost: estimate?.cost?.total ?? 0,
    costParts: engineCostParts(estimate?.cost),
    priced: estimate !== null,
    estimated: estimate?.estimated ?? false,
    rateIn: estimate?.price?.cost4?.input ?? null,
    rateOut: estimate?.price?.cost4?.output ?? null,
    rateCacheRead: estimate?.price?.cost4?.cacheRead ?? null,
    rateCacheWrite: estimate?.price?.cost4?.cacheWrite ?? null,
    conversationId: str(entry.conversationId),
    errorCode: str(entry.errorCode),
    closeReason: str(entry.closeReason),
    routeKind: routedKind,
    account: str(entry.accountLogLabel),
    protocol: str(entry.inboundProtocol),
    attempts,
    sends: num(spend.sends) || attempts,
    settled: num(spend.settled),
    unresolved: num(spend.unresolved),
    cacheProvenance: str(entry.cacheProvenance),
    contextTier: estimate?.contextTier ?? null,
    serviceTier: str(entry.responseServiceTier) ?? str(entry.requestedServiceTier) ?? str(entry.configuredServiceTier),
    retried: attempts > 1,
    usageFromAttempts,
    usageStatus: String(entry.usageStatus ?? "unknown"),
    attemptTokens: attemptTokens || totalTokens,
    cwd: str(entry.cwd),
    cacheEconomics,
    details: requestDetails(entry.detail),
  };
}

function normalizeQuota(raw: Record<string, any>): Dataset["quota"] {
  const windows: QuotaWindowSnapshot[] = [];
  const quotas = raw?.quotas ?? {};
  for (const [account, value] of Object.entries<Record<string, any>>(quotas)) {
    for (const window of ["weekly", "monthly", "daily", "fiveHour"]) {
      const percent = value?.[`${window}Percent`];
      if (typeof percent !== "number") continue;
      windows.push({
        account,
        window,
        usedPercent: percent,
        resetAtMs: typeof value?.[`${window}ResetAt`] === "number" ? value[`${window}ResetAt`] * 1000 : null,
        updatedAt: num(value.updatedAt),
      });
    }
  }

  const samples: QuotaSample[] = [];
  const accounts = raw?.history?.accounts ?? {};
  for (const [account, value] of Object.entries<Record<string, any>>(accounts)) {
    for (const sample of value?.samples ?? []) {
      for (const window of sample?.windows ?? []) {
        if (typeof window.usedPercent !== "number") continue;
        samples.push({
          account,
          family: String(window.family ?? "account"),
          window: String(window.window ?? "unknown"),
          usedPercent: window.usedPercent,
          resetAtMs: typeof window.resetAtMs === "number" ? window.resetAtMs : null,
          observedAt: num(sample.observedAt),
          source: String(sample.source ?? "unknown"),
        });
      }
    }
  }
  samples.sort((a, b) => a.observedAt - b.observedAt);
  windows.sort((a, b) => a.account.localeCompare(b.account) || a.window.localeCompare(b.window));
  return { windows, samples, updatedAt: windows.reduce((max, w) => Math.max(max, w.updatedAt), 0) || null };
}

function normalizeLedger(events: SpendEvent[]): Dataset["ledger"] {
  const byKind: Record<string, number> = {};
  let settledTokens = 0;
  let updatedAt = 0;
  for (const event of events) {
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    if (event.kind === "settle") settledTokens += event.tokens;
    if (event.at > updatedAt) updatedAt = event.at;
  }
  return { events, byKind, settledTokens, updatedAt: updatedAt || null };
}

interface FileInfo extends TailFile {
  bytes: number;
  mtimeMs: number;
  fingerprint: string;
}

async function fileInfo(path: string): Promise<FileInfo | null> {
  try {
    const info = await stat(path, { bigint: true });
    return {
      bytes: Number(info.size),
      mtimeMs: Number(info.mtimeNs / 1_000_000n) + Number(info.mtimeNs % 1_000_000n) / 1_000_000,
      fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
      dev: String(info.dev),
      ino: String(info.ino),
      size: Number(info.size),
    };
  } catch {
    return null;
  }
}

interface Usage { rows: RequestRow[]; lines: number; malformed: number }

const EMPTY_USAGE: Usage = { rows: [], lines: 0, malformed: 0 };

/** Rows of the non-empty lines of `text`, in file order; a line without a requestId or not JSON is malformed. */
function parseUsageLines(text: string): Usage {
  const rows: RequestRow[] = [];
  let malformed = 0;
  let lines = 0;
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    if (end > start) {
      lines++;
      try {
        const entry = JSON.parse(text.slice(start, end));
        if (entry && typeof entry === "object" && entry.requestId) rows.push(normalizeRow(entry));
        else malformed++;
      } catch {
        malformed++;
      }
    }
    start = end + 1;
  }
  return { rows, lines, malformed };
}

const byTime = (a: RequestRow, b: RequestRow) => a.ts - b.ts;

/**
 * Two arrays each sorted by time, merged into a new one in O(n). At equal times `first`'s rows
 * come first, each in its own order: exactly `first.concat(second)` stably sorted by time.
 */
function mergeByTime(first: RequestRow[], second: RequestRow[]): RequestRow[] {
  if (!second.length) return first;
  if (!first.length) return second;
  if (first[first.length - 1]!.ts <= second[0]!.ts) return first.concat(second);
  const merged: RequestRow[] = [];
  let i = 0;
  let j = 0;
  while (i < first.length && j < second.length) merged.push(second[j]!.ts < first[i]!.ts ? second[j++]! : first[i++]!);
  while (i < first.length) merged.push(first[i++]!);
  while (j < second.length) merged.push(second[j++]!);
  return merged;
}

/** What the usage file held at its last complete line: sorted rows and counts. */
interface UsageTail { readonly cursor: TailCursor; readonly committed: Usage }

/**
 * The usage file as the full parser would read it now. With `previous` (same file, same
 * pricing), only the bytes appended since its cursor are read and parsed; complete new lines
 * are merged into its sorted rows. An unterminated last line is parsed for this result, as the
 * full parser does, but never committed: the next read starts before it again. The published
 * arrays are new; `previous` is never modified.
 */
async function readUsage(path: string, file: FileInfo, previous: UsageTail | null): Promise<{ usage: Usage; tail: UsageTail; read: TailRead }> {
  const read = await readTail(path, file, previous?.cursor ?? null);
  const base = read.reset || !previous ? EMPTY_USAGE : previous.committed;
  const added = parseUsageLines(read.complete);
  // Stable: rows with equal times keep file order, and older lines precede newer ones.
  const committed: Usage = {
    rows: mergeByTime(base.rows, added.rows.sort(byTime)),
    lines: base.lines + added.lines,
    malformed: base.malformed + added.malformed,
  };
  const partial = parseUsageLines(read.partial);
  const usage = partial.lines ? {
    rows: mergeByTime(committed.rows, partial.rows),
    lines: committed.lines + partial.lines,
    malformed: committed.malformed + partial.malformed,
  } : committed;
  return { usage, tail: { cursor: read.cursor, committed }, read };
}

async function parseLedger(path: string): Promise<SpendEvent[]> {
  const text = await readFile(path, "utf8");
  const events: SpendEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      events.push({
        kind: String(entry.kind ?? "unknown"),
        at: num(entry.at),
        sendId: str(entry.send),
        tokens: num(entry.tokens),
      });
    } catch {
      // Ledger rows are append-only; a torn tail line is not worth failing the load.
    }
  }
  return events;
}

let dataset: Dataset | null = null;
let inFlight: Promise<Dataset> | null = null;
let signature = "";
let mergedRows: { usage: Usage; claude: string; codex: CodexIndex; rows: RequestRow[] } | null = null;

type CodexIndex = Map<string, CodexSession>;
/** The index Map is replaced only when a session changes; a counter turns that into a signature. */
let codexIndex: CodexIndex | null = null;
let codexGeneration = 0;

function codexSignature(index: CodexIndex): string {
  if (index !== codexIndex) {
    codexIndex = index;
    codexGeneration++;
  }
  return `codex:${codexGeneration}`;
}

/** Branch and spawn facts for a row, only where the rollout recorded them, so absence stays unavailable. */
function sessionFields(session: CodexSession): Pick<RequestRow, "codexSession"> | object {
  if (!session.git && !session.subagent) return {};
  return { codexSession: {
    gitBranch: session.git?.branch ?? null, commitHash: session.git?.commitHash ?? null,
    parentThreadId: session.subagent?.parentThreadId ?? null, depth: session.subagent?.depth ?? null, agentRole: session.subagent?.agentRole ?? null,
  } };
}

/** Attributed copies per source row, for one index: an append re-attributes only its new rows. */
let attributions: { index: CodexIndex; copies: WeakMap<RequestRow, RequestRow> } | null = null;

/**
 * opencodex rows carry no cwd; their conversationId is the hashed Codex session id, so the
 * rollout index supplies one. Rows are copied (published rows may be frozen): matched ones get
 * the folder, unmatched ones with an id are marked `rolloutMiss`. The array is reused untouched
 * when ~/.codex has no sessions, so no miss is claimed without an index to miss in. A row's copy
 * is reused while the index is the same Map.
 */
function attributeCodexRows(rows: RequestRow[], index: CodexIndex): RequestRow[] {
  if (!index.size) return rows;
  if (attributions?.index !== index) attributions = { index, copies: new WeakMap() };
  const copies = attributions.copies;
  let attributed: RequestRow[] | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.cwd !== null || row.protocol === "claude-code" || !row.conversationId) continue;
    let copy = copies.get(row);
    if (!copy) {
      const session = index.get(row.conversationId);
      copy = session ? { ...row, cwd: session.cwd, ...sessionFields(session) } : { ...row, rolloutMiss: true };
      copies.set(row, copy);
    }
    attributed ??= rows.slice();
    attributed[i] = copy;
  }
  return attributed ?? rows;
}

/** Normalized rows per Claude entry object, for one pricing generation: unchanged entries keep identity. */
let claudeRows: { generation: string; rows: WeakMap<object, RequestRow> } | null = null;

/**
 * Claude entries as rows, stably sorted by time. readClaudeEntries keeps the identity of every
 * entry it did not replace, so only new or changed entries are normalized (and priced) again.
 * With no known pricing generation nothing is reused.
 */
function claudeRowsByTime(entries: Record<string, unknown>[], generation: string | null): RequestRow[] {
  if (generation === null) return entries.map(normalizeRow).sort(byTime);
  if (claudeRows?.generation !== generation) claudeRows = { generation, rows: new WeakMap() };
  const known = claudeRows.rows;
  return entries.map(entry => {
    let row = known.get(entry);
    if (!row) {
      row = normalizeRow(entry);
      known.set(entry, row);
    }
    return row;
  }).sort(byTime);
}

/** Rate-limit samples from rollouts. The scan reads whole files, so it runs beside builds and never holds one up. */
let rolloutSamples: QuotaSample[] = [];
let rolloutGeneration = 0;
let rolloutScan: Promise<void> | null = null;

function scanRollouts(): void {
  rolloutScan ??= readRolloutQuotaSamples().then(samples => {
    // Nothing found changes nothing: a revision must not move because a scan ran.
    if (samples === rolloutSamples || (!samples.length && !rolloutSamples.length)) return;
    rolloutSamples = samples;
    rolloutGeneration++;
  }).catch(() => {
    // A failed scan leaves the last samples; the next build tries again.
  }).finally(() => {
    rolloutScan = null;
  });
}

/** Resolves when the running scan has finished; for tests and benchmarks. */
export const rolloutScanSettled = (): Promise<void> => rolloutScan ?? Promise.resolve();

let mergedQuota: { base: Dataset["quota"]; samples: QuotaSample[]; value: Dataset["quota"] } | null = null;

function quotaWithRollouts(base: Dataset["quota"]): Dataset["quota"] {
  if (mergedQuota?.base !== base || mergedQuota.samples !== rolloutSamples) mergedQuota = { base, samples: rolloutSamples, value: mergeRolloutQuota(base, rolloutSamples) };
  return mergedQuota.value;
}

/** Copies with agent type and depth per source row, for one set of agent records. */
let agentCopies: { key: string; copies: WeakMap<RequestRow, RequestRow> } | null = null;

/** A subagent's type and depth live in its sidecar, not on its lines; they join by (session, agent). */
function withAgentRecords(rows: RequestRow[], events: readonly ClaudeEvent[]): RequestRow[] {
  const agents = new Map<string, Extract<ClaudeEvent, { kind: "agent" }>>();
  for (const event of events) if (event.kind === "agent") agents.set(`${event.sessionId}\0${event.agentId}`, event);
  if (!agents.size) return rows;
  const key = [...agents.keys()].join("\n");
  if (agentCopies?.key !== key) agentCopies = { key, copies: new WeakMap() };
  const copies = agentCopies.copies;
  return rows.map(row => {
    const agent = row.details?.agentId ? agents.get(`${row.conversationId}\0${row.details.agentId}`) : undefined;
    if (!agent) return row;
    let copy = copies.get(row);
    if (!copy) {
      copy = { ...row, details: { ...row.details!, agentType: agent.agentType, spawnDepth: agent.spawnDepth, spawnToolUseId: agent.toolUseId } };
      copies.set(row, copy);
    }
    return copy;
  });
}

interface Snapshot<T> {
  readonly fingerprint: string;
  readonly value: T;
}

let usageSnapshot: (Snapshot<Usage> & { readonly generation: string | null; readonly tail: UsageTail | null }) | null = null;

/** How the last build read its sources; for tests and diagnostics. */
export interface IngestReport {
  usage: { mode: "reused" | "append" | "full" | "none"; bytesRead: number };
  transcripts: { bytesRead: number };
}
let lastIngest: IngestReport = { usage: { mode: "none", bytesRead: 0 }, transcripts: { bytesRead: 0 } };
export const ingestReport = (): IngestReport => lastIngest;
let spendSnapshot: Snapshot<Dataset["ledger"]> | null = null;
let quotaSnapshot: Snapshot<Dataset["quota"]> | null = null;

function fingerprint(info: FileInfo | null): string {
  return info?.fingerprint ?? "-";
}

function disappearedDuringRead(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function currentFiles() {
  const [usage, spend, quota] = await Promise.all([
    fileInfo(PATHS.usage),
    fileInfo(PATHS.spendLedger),
    fileInfo(PATHS.quotaCache),
  ]);
  return { usage, spend, quota, signature: [usage, spend, quota].map(fingerprint).join("|") };
}

async function build(force: boolean): Promise<Dataset> {
  // Refresh re-reads changed transcripts whole rather than from their last line.
  const transcriptBytesBefore = transcriptBytesRead();
  const [initialFiles, claude, codex] = await Promise.all([currentFiles(), readClaudeEntries(undefined, undefined, { full: force }), readCodexSessionIndex()]);
  const transcriptIngest = { bytesRead: transcriptBytesRead() - transcriptBytesBefore };
  scanRollouts();
  const codexKey = `${codexSignature(codex)}|rollouts:${rolloutGeneration}`;
  // Preserve the existing file-driven whole-dataset fast path. Pricing-only
  // changes still require force; generation guards component reuse on rebuild.
  if (!force && dataset && `${initialFiles.signature}|${claude.signature}|${codexKey}` === signature) return dataset;

  await loadPricing();
  const startedAt = performance.now();
  // Retry the entire composition if any source changes while it is being read.
  // Failed attempts never replace the last published dataset or snapshots.
  for (let attempt = 0; attempt < 3; attempt++) {
    const files = await currentFiles();
    const generation = pricingGeneration();
    const usageKey = fingerprint(files.usage);
    const spendKey = fingerprint(files.spend);
    const quotaKey = fingerprint(files.quota);

    // Rows are priced when normalized: only rows from the same known pricing generation are reused.
    const samePricing = !force && generation !== null && usageSnapshot?.generation === generation;
    let nextUsage = samePricing && usageSnapshot?.fingerprint === usageKey ? usageSnapshot : null;
    let usageIngest: IngestReport["usage"] = { mode: "reused", bytesRead: 0 };
    if (!nextUsage) {
      let usage: Usage = EMPTY_USAGE;
      let tail: UsageTail | null = null;
      try {
        if (files.usage) {
          // Same file and pricing: read only what was appended since the last complete line.
          const result = await readUsage(PATHS.usage, files.usage, samePricing ? usageSnapshot?.tail ?? null : null);
          ({ usage, tail } = result);
          usageIngest = { mode: result.read.reset ? "full" : "append", bytesRead: result.read.bytesRead };
        } else {
          usageIngest = { mode: "full", bytesRead: 0 };
        }
      } catch (error) {
        // Rotation/deletion can land after stat. Start a fresh composition rather
        // than assigning the observed fingerprint to missing or different bytes.
        if ((disappearedDuringRead(error) || error instanceof TailChangedError) && attempt < 2) continue;
        throw error;
      }
      nextUsage = { fingerprint: usageKey, generation, value: usage, tail };
    }

    let nextSpend = !force && spendSnapshot?.fingerprint === spendKey ? spendSnapshot : null;
    if (!nextSpend) {
      let events: SpendEvent[];
      try {
        events = files.spend ? await parseLedger(PATHS.spendLedger) : [];
      } catch (error) {
        if (disappearedDuringRead(error) && attempt < 2) continue;
        throw error;
      }
      nextSpend = { fingerprint: spendKey, value: normalizeLedger(events) };
    }

    let nextQuota = !force && quotaSnapshot?.fingerprint === quotaKey ? quotaSnapshot : null;
    if (!nextQuota) {
      let quota: Dataset["quota"] = { windows: [], samples: [], updatedAt: null };
      if (files.quota) {
        try {
          quota = normalizeQuota(JSON.parse(await readFile(PATHS.quotaCache, "utf8")));
        } catch (error) {
          if (disappearedDuringRead(error)) {
            if (attempt < 2) continue;
            throw error;
          }
          // A corrupt quota cache must not take the whole dashboard down.
        }
      }
      nextQuota = { fingerprint: quotaKey, value: quota };
    }

    const after = await currentFiles();
    if (after.signature !== files.signature || pricingGeneration() !== generation) continue;

    const usage = nextUsage.value;
    // Claude Code subscription traffic bypasses ocx; its transcripts normalize to the same rows.
    // Memoized so quota/spend-only rebuilds keep reusing one rows array, like the usage snapshot.
    let nextMerged = mergedRows;
    if (force || nextMerged?.usage !== usage || nextMerged.claude !== claude.signature || nextMerged.codex !== codex) {
      if (force) {
        // Refresh recomputes every derived row.
        attributions = null;
        claudeRows = null;
        agentCopies = null;
      }
      // Both sources are sorted by time, so one O(n) merge gives the order of concatenating
      // them and stably re-sorting: opencodex rows first at equal times, each source in its own
      // order. Labs evidence identities use these positions. Nothing published is modified.
      const rows = mergeByTime(attributeCodexRows(usage.rows, codex), withAgentRecords(claudeRowsByTime(claude.entries, generation), claude.events));
      nextMerged = { usage, claude: claude.signature, codex, rows };
    }
    const rows = nextMerged.rows;
    const nextSignature = `${files.signature}|${claude.signature}|${codexKey}`;
    const nextDataset: Dataset = {
      rows,
      claudeEvents: claude.events,
      quota: quotaWithRollouts(nextQuota.value),
      ledger: nextSpend.value,
      files: {
        usage: files.usage ? { path: PATHS.usage, bytes: files.usage.bytes, mtimeMs: files.usage.mtimeMs, lines: usage.lines } : null,
        spend: files.spend ? { path: PATHS.spendLedger, bytes: files.spend.bytes, mtimeMs: files.spend.mtimeMs } : null,
        quota: files.quota ? { path: PATHS.quotaCache, bytes: files.quota.bytes, mtimeMs: files.quota.mtimeMs } : null,
      },
      parse: { malformedLines: usage.malformed, durationMs: Math.round(performance.now() - startedAt) },
      builtAt: Date.now(),
      revision: `${rows.length}:${nextSignature}`,
    };
    // Publication is synchronous: callers see either the prior composition or
    // all three verified components together. Reused arrays are never re-sorted.
    usageSnapshot = nextUsage;
    spendSnapshot = nextSpend;
    quotaSnapshot = nextQuota;
    mergedRows = nextMerged;
    signature = nextSignature;
    lastIngest = { usage: usageIngest, transcripts: transcriptIngest };
    dataset = nextDataset;
    return nextDataset;
  }
  throw new Error("Usage, spend, quota, or pricing changed repeatedly during dataset rebuild; retry the request");
}

/** Default minimum time between two checks of the sources on disk. */
const FRESHNESS_INTERVAL_MS = 1_000;
let checkedAt = Number.NEGATIVE_INFINITY;

/**
 * How long a published dataset is served without looking at the disk again: YALD_FRESHNESS_MS
 * (read per call, so tests that append and read back at once can set 0), else one second.
 */
function freshnessIntervalMs(): number {
  const configured = Number(process.env.YALD_FRESHNESS_MS);
  return process.env.YALD_FRESHNESS_MS?.trim() && Number.isFinite(configured) && configured >= 0 ? configured : FRESHNESS_INTERVAL_MS;
}

/**
 * Returns the parsed dataset, rebuilding only when the ledgers changed on disk. The disk
 * is checked (readdir and stat of every source) at most once per freshness interval;
 * `force` (Refresh) always rebuilds.
 */
export async function getDataset(options: { force?: boolean } = {}): Promise<Dataset> {
  if (inFlight) return inFlight;
  if (!options.force && dataset && performance.now() - checkedAt < freshnessIntervalMs()) return dataset;
  inFlight = build(options.force ?? false).then(result => {
    checkedAt = performance.now();
    return result;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
