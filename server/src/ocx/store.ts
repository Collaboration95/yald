import { stat, readFile } from "node:fs/promises";
import { PATHS } from "../env";
import { loadPricing, priceEntry, pricingGeneration } from "./pricing";

export interface RequestRow {
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
  serviceTier: string | null;
  retried: boolean;
  /** True when the row had no top-level usage and tokens were summed from attempts. */
  usageFromAttempts: boolean;
  /** Reported metering status from the ledger. */
  usageStatus: string;
  /** Tokens across every physical attempt; > totalTokens means retries re-sent work. */
  attemptTokens: number;
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

function normalizeRow(entry: Record<string, any>): RequestRow {
  let usage = entry.usage ?? {};
  let usageFromAttempts = false;
  if (num(usage.inputTokens) === 0 && num(usage.outputTokens) === 0 && Array.isArray(entry.attempts)) {
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
    for (const attempt of entry.attempts) {
      const attemptUsage = attempt?.usage;
      if (!attemptUsage) continue;
      found = true;
      summed.inputTokens += num(attemptUsage.inputTokens);
      summed.outputTokens += num(attemptUsage.outputTokens);
      summed.cachedInputTokens += num(attemptUsage.cachedInputTokens);
      summed.cacheReadInputTokens += num(attemptUsage.cacheReadInputTokens);
      summed.cacheCreationInputTokens += num(attemptUsage.cacheCreationInputTokens);
      summed.cacheWriteInputTokens += num(attemptUsage.cacheWriteInputTokens);
      summed.reasoningOutputTokens += num(attemptUsage.reasoningOutputTokens);
      summed.totalTokens += num(attemptUsage.totalTokens);
    }
    if (found) {
      usage = summed;
      usageFromAttempts = true;
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

  const estimate = priceEntry({ ...entry, usage });
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

  return {
    id: String(entry.requestId),
    ts: num(entry.timestamp),
    provider: String(entry.provider ?? "unknown"),
    model: String(entry.model ?? "unknown"),
    requestedModel: str(entry.requestedModel),
    resolvedModel: str(entry.resolvedModel),
    effort: str(entry.effectiveEffort) ?? str(entry.requestedEffort),
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
    cost: estimate?.cost.total ?? 0,
    priced: estimate !== null,
    estimated: estimate?.estimated ?? false,
    rateIn: estimate?.price?.cost4.input ?? null,
    rateOut: estimate?.price?.cost4.output ?? null,
    rateCacheRead: estimate?.price?.cost4.cacheRead ?? null,
    rateCacheWrite: estimate?.price?.cost4.cacheWrite ?? null,
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

interface FileInfo {
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
    };
  } catch {
    return null;
  }
}

async function parseUsage(path: string): Promise<{ rows: RequestRow[]; lines: number; malformed: number }> {
  const text = await readFile(path, "utf8");
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

type Usage = Awaited<ReturnType<typeof parseUsage>>;
interface Snapshot<T> {
  readonly fingerprint: string;
  readonly value: T;
}

let usageSnapshot: (Snapshot<Usage> & { readonly generation: string | null }) | null = null;
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
  const initialFiles = await currentFiles();
  // Preserve the existing file-driven whole-dataset fast path. Pricing-only
  // changes still require force; generation guards component reuse on rebuild.
  if (!force && dataset && initialFiles.signature === signature) return dataset;

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

    let nextUsage = !force && usageSnapshot?.fingerprint === usageKey
      && generation !== null && usageSnapshot.generation === generation
      ? usageSnapshot
      : null;
    if (!nextUsage) {
      let usage: Usage;
      try {
        usage = files.usage ? await parseUsage(PATHS.usage) : { rows: [], lines: 0, malformed: 0 };
      } catch (error) {
        // Rotation/deletion can land after stat. Start a fresh composition rather
        // than assigning the observed fingerprint to missing or different bytes.
        if (disappearedDuringRead(error) && attempt < 2) continue;
        throw error;
      }
      usage.rows.sort((a, b) => a.ts - b.ts);
      nextUsage = { fingerprint: usageKey, generation, value: usage };
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
    const nextDataset: Dataset = {
      rows: usage.rows,
      quota: nextQuota.value,
      ledger: nextSpend.value,
      files: {
        usage: files.usage ? { path: PATHS.usage, bytes: files.usage.bytes, mtimeMs: files.usage.mtimeMs, lines: usage.lines } : null,
        spend: files.spend ? { path: PATHS.spendLedger, bytes: files.spend.bytes, mtimeMs: files.spend.mtimeMs } : null,
        quota: files.quota ? { path: PATHS.quotaCache, bytes: files.quota.bytes, mtimeMs: files.quota.mtimeMs } : null,
      },
      parse: { malformedLines: usage.malformed, durationMs: Math.round(performance.now() - startedAt) },
      builtAt: Date.now(),
      revision: `${usage.rows.length}:${files.signature}`,
    };
    // Publication is synchronous: callers see either the prior composition or
    // all three verified components together. Reused arrays are never re-sorted.
    usageSnapshot = nextUsage;
    spendSnapshot = nextSpend;
    quotaSnapshot = nextQuota;
    signature = files.signature;
    dataset = nextDataset;
    return nextDataset;
  }
  throw new Error("Usage, spend, quota, or pricing changed repeatedly during dataset rebuild; retry the request");
}

/** Returns the parsed dataset, rebuilding only when the ledgers changed on disk. */
export async function getDataset(options: { force?: boolean } = {}): Promise<Dataset> {
  if (inFlight) return inFlight;
  inFlight = build(options.force ?? false).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
