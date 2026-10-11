// Turns what a person asks for (CLI flags in #38, query parameters in #39) into a
// ReportSpec, so both read reports the same way. Pure, like the time module.
import { isoInZone, parsePhases, parseWindow, windowLabel, type Instant, type Phase, type TimeWindow } from "../time/window";
import { ALL_SOURCES, parseSource } from "./source";
import type { ReportSpec, Source } from "./types";

export const DEFAULT_TOP = 10;
export const MAX_TOP = 100;
/** The window when neither a window nor phases are given. */
export const DEFAULT_REPORT_RANGE = "24h";

export type ReportSpecErrorCode = "invalid_source" | "invalid_top";

/**
 * A report input that is not about time. Same shape as WindowError (`code`,
 * `param`, `message`), so a caller can answer both with
 * `{ ok: false, error: { code, param, message } }` and HTTP 400.
 */
export class ReportSpecError extends Error {
  code: ReportSpecErrorCode;
  param: string;
  constructor(code: ReportSpecErrorCode, param: string, message: string) {
    super(message);
    this.name = "ReportSpecError";
    this.code = code;
    this.param = param;
  }
}

export interface ReportSpecInput {
  from?: string; to?: string; last?: string; range?: string; tz?: string;
  /** `name=start..end` each; see parsePhases. */
  phases?: string[];
  /** Source names or aliases (`claude`, `codex`); a string may be comma-separated. Default both. */
  sources?: string[] | string;
  /** Folder globs; a string is comma-separated (like the HTTP `projects` parameter), an array is taken as is. */
  projects?: string[] | string;
  /** Conversations to list: default 10, at most 100. */
  top?: number | string;
  /** Default true. Strings "false", "0", "no" and "off" turn it off. */
  redact?: boolean | string;
  title?: string;
}

function list(value: string[] | string | undefined): string[] {
  if (value === undefined) return [];
  const parts = typeof value === "string" ? value.split(",") : value;
  return parts.map(part => part.trim()).filter(Boolean);
}

export function readSources(value: string[] | string | undefined): Source[] {
  const picked = new Set<Source>();
  for (const name of list(value)) {
    const source = parseSource(name);
    if (!source) {
      throw new ReportSpecError("invalid_source", "sources", `Unknown source "${name}". Use claude-code (or claude) and ocx (or codex).`);
    }
    picked.add(source);
  }
  return picked.size ? ALL_SOURCES.filter(source => picked.has(source)) : [...ALL_SOURCES];
}

function readTop(value: number | string | undefined): number {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) return DEFAULT_TOP;
  const top = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(top) || top < 1) {
    throw new ReportSpecError("invalid_top", "top", `top must be a whole number from 1 to ${MAX_TOP}, not "${value}".`);
  }
  return Math.min(top, MAX_TOP);
}

function readRedact(value: boolean | string | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined) return true;
  return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

/**
 * Resolves a report request. The window comes from from/to/last/range/tz (parseWindow).
 * With phases but no window, the window runs from the first phase's start to the last
 * phase's end; with neither, it is the last 24 hours (`ctx.defaultRange`). Throws
 * WindowError (from the time module) for window and phase problems, ReportSpecError
 * for the rest.
 */
export function buildReportSpec(input: ReportSpecInput, ctx: { now: Instant; first: Instant; defaultRange?: string }): ReportSpec {
  const phaseSpecs = input.phases ?? [];
  const windowGiven = [input.from, input.to, input.last, input.range].some(value => value !== undefined);
  let window: TimeWindow;
  let phases: Phase[];
  if (!windowGiven && phaseSpecs.length) {
    // Read the phases against everything up to now (relative bounds count from now),
    // then shrink the window to exactly the span they cover.
    const everything = { ...parseWindow({ range: "all", tz: input.tz }, { now: ctx.now, first: 0 }), label: "everything up to now" };
    phases = parsePhases(phaseSpecs, everything);
    const [from, to] = [phases[0]!.from, phases[phases.length - 1]!.to];
    window = { from, to, tz: everything.tz, label: windowLabel(from, to, everything.tz), input: { from: isoInZone(from, everything.tz), to: isoInZone(to, everything.tz) } };
  } else {
    window = parseWindow(
      { from: input.from, to: input.to, last: input.last, range: input.range, tz: input.tz },
      { now: ctx.now, first: ctx.first, defaultRange: ctx.defaultRange ?? DEFAULT_REPORT_RANGE },
    );
    phases = parsePhases(phaseSpecs, window);
  }
  const title = input.title?.trim();
  return {
    window,
    phases,
    sources: readSources(input.sources),
    projects: list(input.projects),
    top: readTop(input.top),
    redact: readRedact(input.redact),
    ...(title ? { title } : {}),
  };
}
