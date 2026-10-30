// Which reader a request came from (#31, "Shared definitions → Source"). Keyed on
// the protocol the row was read with, never on `provider`: Anthropic traffic routed
// through opencodex is `ocx`, not `claude-code`.
import type { RequestRow } from "../ocx/store";
import type { Source } from "./types";

/** Both sources, in the order every report lists them. */
export const ALL_SOURCES: readonly Source[] = ["claude-code", "ocx"];

/** `"claude-code"` for rows read from Claude Code transcripts, otherwise `"ocx"`. */
export function sourceOf(row: Pick<RequestRow, "protocol">): Source {
  return row.protocol === "claude-code" ? "claude-code" : "ocx";
}

const ALIASES: Record<string, Source> = { "claude-code": "claude-code", claude: "claude-code", ocx: "ocx", codex: "ocx" };

/** A source name or CLI alias (`claude`, `codex`), case-insensitive; null when unknown. */
export function parseSource(name: string): Source | null {
  return ALIASES[name.trim().toLowerCase()] ?? null;
}

/** Source support is independent of whether an individual row has a measurement. */
export const SOURCE_CAPABILITIES = {
  "claude-code": { outcomes: false, retries: false, timing: false, quota: false, cache: true, effort: true, agents: true },
  ocx: { outcomes: true, retries: true, timing: true, quota: true, cache: true, effort: true, agents: false },
} as const;

export interface Measurements {
  outcome: boolean;
  duration: boolean;
  ttft: boolean;
  retries: boolean;
  input: boolean;
  output: boolean;
  cacheRead: boolean;
  cacheWrite: boolean;
  usage: "logical" | "attempt-sum" | "missing";
}

export function cacheEligible(row: RequestRow): boolean {
  return row.cacheProvenance === "observed" && row.measurements.input && row.measurements.cacheRead;
}

export function contextEligible(row: RequestRow): boolean {
  return row.measurements.input && row.measurements.usage === "logical" && !row.usageFromAttempts;
}

export function throughputEligible(row: RequestRow): boolean {
  return row.measurements.duration && row.durationMs > 0 && row.measurements.output && row.outputTokens > 0;
}
