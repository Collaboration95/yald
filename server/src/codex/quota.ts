// Quota samples from Codex rollouts (#97): `token_count` records carry `rate_limits`. They are
// account observations, never attributed to a project or request. Whole rollouts are read, so
// this runs beside the dashboard rather than in front of it, and each file is read once:
// a plain rollout from its last complete line, a compressed one until it changes.
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createZstdDecompress } from "node:zlib";
import { CODEX_HOME } from "../env";
import { readTail, type TailCursor } from "../ingest/tail";
import type { QuotaSample, QuotaWindowSnapshot } from "../ocx/store";
import { listRollouts, type Rollout } from "./sessions";

/** The rollouts name no account. One label keeps them apart from opencodex's own accounts. */
export const ROLLOUT_ACCOUNT = "codex-rollouts";
const SCAN_BATCH = 8;

const WINDOW_NAMES: Record<number, string> = { 300: "fiveHour", 1_440: "daily", 10_080: "weekly", 43_200: "monthly" };

/** Older rollouts record a window a minute short, such as 299 or 10079. */
function windowName(minutes: number): string {
  const nominal = Object.keys(WINDOW_NAMES).map(Number).find(known => Math.abs(known - minutes) <= 1);
  return nominal === undefined ? `${minutes}m` : WINDOW_NAMES[nominal]!;
}

function sampleOf(slot: Record<string, any> | undefined, observedAt: number): QuotaSample | null {
  if (typeof slot?.used_percent !== "number" || !Number.isFinite(slot.used_percent)) return null;
  const minutes = typeof slot.window_minutes === "number" ? slot.window_minutes : null;
  return {
    account: ROLLOUT_ACCOUNT, family: "account", window: minutes === null ? "unknown" : windowName(minutes),
    usedPercent: slot.used_percent,
    resetAtMs: typeof slot.resets_at === "number" ? slot.resets_at * 1000 : null,
    observedAt, source: "rollout",
  };
}

/** The samples of one rollout line. `rate_limits` holds a slot per window; which is weekly varies, so both are read. */
export function parseRateLimits(raw: string): QuotaSample[] {
  if (!raw.includes('"token_count"') || !raw.includes('"rate_limits"')) return [];
  try {
    const line = JSON.parse(raw);
    const limits = (line?.payload ?? line?.msg ?? line)?.rate_limits;
    const observedAt = Date.parse(line?.timestamp);
    if (!limits || !Number.isFinite(observedAt)) return [];
    return [sampleOf(limits.primary, observedAt), sampleOf(limits.secondary, observedAt)].filter(sample => sample !== null);
  } catch {
    return [];
  }
}

function collect(samples: QuotaSample[], text: string): void {
  for (const raw of text.split("\n")) samples.push(...parseRateLimits(raw));
}

/** A compressed rollout, line by line. A missing or invalid frame ends it with what was read. */
async function readCompressed(path: string): Promise<QuotaSample[]> {
  const samples: QuotaSample[] = [];
  let tail = "";
  const stream = createReadStream(path).pipe(createZstdDecompress());
  try {
    for await (const chunk of stream) {
      const text = tail + String(chunk);
      const end = text.lastIndexOf("\n");
      if (end === -1) { tail = text; continue; }
      collect(samples, text.slice(0, end));
      tail = text.slice(end + 1);
    }
    collect(samples, tail);
  } catch {
    // Unreadable data is a gap, not an error.
  }
  return samples;
}

interface FileScan { signature: string; samples: QuotaSample[]; cursor: TailCursor | null }

const scans = new Map<string, Map<string, FileScan>>();
const results = new Map<string, QuotaSample[]>();
const NONE: QuotaSample[] = [];

/** Every rate-limit sample in `codexHome`'s rollouts, deduplicated by (window, reset, time), oldest first. The same array comes back until one changes. */
export async function readRolloutQuotaSamples(codexHome = CODEX_HOME): Promise<QuotaSample[]> {
  const rollouts = await listRollouts(codexHome);
  const known = scans.get(codexHome) ?? new Map<string, FileScan>();
  const next = new Map<string, FileScan>();
  let changed = rollouts.length !== known.size;
  const scanOne = async ({ path, compressed }: Rollout) => {
    const info = await stat(path, { bigint: true }).catch(() => null);
    if (!info) return;
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    const cached = known.get(path);
    if (cached?.signature === signature) {
      next.set(path, cached);
      return;
    }
    changed = true;
    if (compressed) {
      next.set(path, { signature, samples: await readCompressed(path), cursor: null });
      return;
    }
    try {
      const read = await readTail(path, { dev: String(info.dev), ino: String(info.ino), size: Number(info.size) }, cached?.cursor ?? null);
      const samples = read.reset || !cached ? [] : [...cached.samples];
      collect(samples, read.complete);
      next.set(path, { signature, samples, cursor: read.cursor });
    } catch {
      // Vanished mid-scan: the next scan decides.
    }
  };
  for (let start = 0; start < rollouts.length; start += SCAN_BATCH) await Promise.all(rollouts.slice(start, start + SCAN_BATCH).map(scanOne));
  scans.set(codexHome, next);
  if (!changed && results.has(codexHome)) return results.get(codexHome)!;
  const unique = new Map<string, QuotaSample>();
  for (const { samples } of next.values()) for (const sample of samples) unique.set(`${sample.window}|${sample.resetAtMs}|${sample.observedAt}`, sample);
  const merged = unique.size ? [...unique.values()].sort((a, b) => a.observedAt - b.observedAt) : NONE;
  results.set(codexHome, merged);
  return merged;
}

/** Keeps the first and last sample of each unchanged run per window. Every token_count repeats the reading, so the chart and burn stay the same. */
export function collapseRuns(samples: QuotaSample[]): QuotaSample[] {
  const kept: QuotaSample[] = [];
  const runs = new Map<string, { used: number; reset: number | null; last: number | null }>();
  for (const sample of samples) {
    const run = runs.get(sample.window);
    if (run?.used !== sample.usedPercent || run.reset !== sample.resetAtMs) {
      kept.push(sample);
      runs.set(sample.window, { used: sample.usedPercent, reset: sample.resetAtMs, last: null });
    } else if (run.last === null) {
      kept.push(sample);
      run.last = kept.length - 1;
    } else {
      kept[run.last] = sample;
    }
  }
  return kept;
}

/** opencodex's quota with rollout samples added, and a latest reading for each window it does not report itself, while that reading's window is still open. */
export function mergeRolloutQuota<Q extends { windows: QuotaWindowSnapshot[]; samples: QuotaSample[]; updatedAt: number | null }>(quota: Q, samples: QuotaSample[], now = Date.now()): Q {
  if (!samples.length) return quota;
  const latest = new Map<string, QuotaSample>();
  for (const sample of samples) latest.set(sample.window, sample);
  const windows = [...quota.windows];
  for (const sample of latest.values()) {
    if (sample.resetAtMs !== null && sample.resetAtMs > now && !quota.windows.some(window => window.window === sample.window)) {
      windows.push({ account: ROLLOUT_ACCOUNT, window: sample.window, usedPercent: sample.usedPercent, resetAtMs: sample.resetAtMs, updatedAt: sample.observedAt });
    }
  }
  windows.sort((a, b) => a.account.localeCompare(b.account) || a.window.localeCompare(b.window));
  return {
    ...quota, windows,
    samples: [...quota.samples, ...collapseRuns(samples)].sort((a, b) => a.observedAt - b.observedAt),
    updatedAt: Math.max(quota.updatedAt ?? 0, ...windows.map(window => window.updatedAt)) || null,
  };
}
