// The case intent is shared by the API and browser. No store, environment or collector imports.
import { nextBucketStart, parseWindow, zonedBucketStart } from "../time/window";

// Structural counterpart of scope.ts's EvidenceSelector. Keep the browser
// validator independent of analytics and its server-only Bun project matcher.
type Source = "ocx" | "claude-code";
export const REBUILD_CAUSES = ["reported", "compaction", "model-switch", "idle-gap", "no-evidence"] as const;
export type RebuildCause = typeof REBUILD_CAUSES[number];
export const LEDGER_CLASSES = ["session-start", "subagent-start", ...REBUILD_CAUSES] as const;
export type LedgerClass = typeof LEDGER_CLASSES[number];
export interface CaseSelector {
  version: 1;
  window: { from: number; to: number; tz: string; label: string };
  cohort: {
    sources: Source[]; projects: string[]; providers: string[]; models: string[];
    efforts: string[]; statuses: ("ok" | "error" | "cancelled" | "unobserved")[];
    routeKinds: string[]; conversationId: string | null; search: string;
  };
  selection: { kind: "scope" } | { kind: "project"; project: string }
    | { kind: "session"; source: Source; conversationId: string } | { kind: "unnamed"; source?: Source }
    | { kind: "chain"; source: Source; conversationId: string; agentId: string };
  eligibility: "all" | "cache" | "context" | "rebuild";
  /** One ledger row. Only with rebuild eligibility; absent means every rebuild class, no starts. */
  cause?: LedgerClass;
}
export interface CaseIntent {
  investigation: "project-radar" | "cache-detective" | "context-replay" | "spend-changes";
  selector: CaseSelector;
  priorSelector?: CaseSelector;
  period: "current" | "prior";
  offset: number;
  limit: number;
}

export class EvidenceIntentError extends Error {
  readonly code = "invalid_evidence";
  constructor(readonly param: string, message: string) { super(message); this.name = "EvidenceIntentError"; }
}
function fail(param: string, message: string): never { throw new EvidenceIntentError(param, message); }
function object(value: unknown, param: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(param, `The case link needs a valid ${param}.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) fail(param, `The case link contains an unsupported ${param} field.`);
  return record;
}
function text(value: unknown, param: string, empty = false, max = 1024): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    fail(param, `The case link needs a ${empty ? "valid" : "nonempty"} ${param} (at most ${max} characters).`);
  }
  return value;
}
function enumeration<T extends string>(value: unknown, options: readonly T[], param: string): T {
  if (typeof value !== "string" || !options.includes(value as T)) fail(param, `The case link has an unsupported ${param}.`);
  return value as T;
}
function list(value: unknown, param: string): string[] {
  if (!Array.isArray(value) || value.length > 64) fail(param, `The case link needs a ${param} list of at most 64 items.`);
  return value.map(item => text(item, param));
}
const sources = ["ocx", "claude-code"] as const;
function decode(raw: string | null, param: string): CaseSelector {
  if (raw === null || raw.length > 24_576) fail(param, `The case link needs a complete ${param} of at most 24576 characters. Open the finding again.`);
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { fail(param, `The case link has an unreadable ${param}. Open the finding again.`); }
  const value = object(decoded, param, ["version", "window", "cohort", "selection", "eligibility", "cause"]);
  if (value.version !== 1) fail(param, "This case link uses an unsupported selector version. Open the finding again.");
  const w = object(value.window, `${param}.window`, ["from", "to", "tz", "label"]);
  for (const key of ["from", "to"] as const) {
    if (typeof w[key] !== "number" || !Number.isSafeInteger(w[key]) || Math.abs(w[key] as number) > 8_640_000_000_000_000) {
      fail(param, "The case window needs finite epoch milliseconds.");
    }
  }
  const tz = text(w.tz, `${param}.window.tz`, false, 128);
  // Validate the legacy label's shape, but always derive trusted display text from the bounds.
  text(w.label, `${param}.window.label`, true, 512);
  let parsed;
  try {
    parsed = parseWindow({ from: new Date(w.from as number).toISOString(), to: new Date(w.to as number).toISOString(), tz }, { now: 0, first: 0 });
  } catch { fail(param, "The case window needs ordered, supported times and a valid time zone."); }
  const window = { from: parsed.from, to: parsed.to, tz: parsed.tz, label: parsed.label };
  const c = object(value.cohort, `${param}.cohort`, ["sources", "projects", "providers", "models", "efforts", "statuses", "routeKinds", "conversationId", "search"]);
  const sourceList = list(c.sources, "sources").map(item => enumeration(item, sources, "source"));
  // Empty source identities must never trigger filterRows' all-source default.
  if (!sourceList.length) fail(param, "The case link needs at least one explicit source.");
  const cohort: CaseSelector["cohort"] = {
    sources: sourceList, projects: list(c.projects, "projects"), providers: list(c.providers, "providers"),
    models: list(c.models, "models"), efforts: list(c.efforts, "efforts"),
    statuses: list(c.statuses, "statuses").map(item => enumeration(item, ["ok", "error", "cancelled", "unobserved"] as const, "outcome")),
    routeKinds: list(c.routeKinds, "routeKinds"),
    conversationId: c.conversationId === null ? null : text(c.conversationId, "conversationId"),
    search: text(c.search, "search", true),
  };
  const s = object(value.selection, `${param}.selection`, ["kind", "project", "source", "conversationId", "agentId"]);
  const kind = enumeration(s.kind, ["scope", "project", "session", "unnamed", "chain"] as const, "selection");
  const allowed = kind === "scope" ? ["kind"] : kind === "project" ? ["kind", "project"]
    : kind === "session" ? ["kind", "source", "conversationId"]
    : kind === "chain" ? ["kind", "source", "conversationId", "agentId"] : ["kind", "source"];
  object(s, "selection", allowed);
  const selection: CaseSelector["selection"] = kind === "scope" ? { kind }
    : kind === "project" ? { kind, project: text(s.project, "project") }
    : kind === "session" ? { kind, source: enumeration(s.source, sources, "session source"), conversationId: text(s.conversationId, "session ID") }
    : kind === "chain" ? { kind, source: enumeration(s.source, sources, "chain source"), conversationId: text(s.conversationId, "session ID"), agentId: text(s.agentId, "agent ID") }
    : { kind, ...(s.source === undefined ? {} : { source: enumeration(s.source, sources, "unnamed source") }) };
  const eligibility = enumeration(value.eligibility, ["all", "cache", "context", "rebuild"] as const, "eligibility");
  if (value.cause !== undefined && eligibility !== "rebuild") fail("cause", "Only rebuild evidence can select a cause. Open the finding again.");
  if (selection.kind === "chain" && eligibility !== "rebuild") fail("selection", "Only rebuild evidence can select a chain. Open the finding again.");
  return { version: 1, window, cohort, selection, eligibility, ...(value.cause === undefined ? {} : { cause: enumeration(value.cause, LEDGER_CLASSES, "cause") }) };
}
export const CASE_QUERY_KEYS = ["investigation", "selector", "priorSelector", "period", "offset", "limit", "selectorVersion"] as const;

/** Read only authoritative case fields. Global toolbar fields and readable mirrors cannot move a case. */
export function parseCaseIntent(params: URLSearchParams): CaseIntent {
  for (const key of CASE_QUERY_KEYS) if (params.getAll(key).length > 1) fail(key, `The case link repeats ${key}. Open the finding again.`);
  if (params.has("selectorVersion") && params.get("selectorVersion") !== "1") fail("selectorVersion", "This case link uses an unsupported selector version.");
  const investigation = enumeration(params.get("investigation"), ["project-radar", "cache-detective", "context-replay", "spend-changes"] as const, "investigation");
  const selector = decode(params.get("selector"), "selector");
  const eligibilities: CaseSelector["eligibility"][] = investigation === "cache-detective" ? ["cache", "rebuild"] : ["all"];
  if (!eligibilities.includes(selector.eligibility)) fail("eligibility", `This investigation requires ${eligibilities[0]} evidence eligibility. Open the finding again.`);
  const allowedSelections = investigation === "project-radar" ? ["scope", "project"]
    : investigation === "spend-changes" ? ["scope", "project", "session"]
    : investigation === "cache-detective" ? ["scope", "session", "unnamed", "chain"] : ["scope", "session", "unnamed"];
  if (!allowedSelections.includes(selector.selection.kind)) {
    fail("selection", "This selection is unsupported for the investigation. Open the finding again.");
  }
  const period = enumeration(params.get("period") ?? "current", ["current", "prior"] as const, "period");
  let priorSelector: CaseSelector | undefined;
  if (investigation === "project-radar") {
    priorSelector = decode(params.get("priorSelector"), "priorSelector");
    const a = selector.window, b = priorSelector.window;
    if (priorSelector.eligibility !== "all" || JSON.stringify(selector.cohort) !== JSON.stringify(priorSelector.cohort)
      || JSON.stringify(selector.selection) !== JSON.stringify(priorSelector.selection)
      || a.tz !== b.tz || b.to !== a.from || a.to - a.from !== b.to - b.from) {
      fail("priorSelector", "The case needs the original equal-length, immediately preceding window with the same cohort and selection. Open the finding again.");
    }
  } else if (investigation === "spend-changes") {
    priorSelector = decode(params.get("priorSelector"), "priorSelector");
    const a = selector.window, b = priorSelector.window;
    // One local day against the baseline window that ends exactly where it starts: not equal-length like Radar's pair.
    const oneDay = zonedBucketStart(a.from, "day", a.tz) === a.from && nextBucketStart(a.from, "day", a.tz) === a.to;
    if (priorSelector.eligibility !== "all" || JSON.stringify(selector.cohort) !== JSON.stringify(priorSelector.cohort)
      || JSON.stringify(selector.selection) !== JSON.stringify(priorSelector.selection)
      || a.tz !== b.tz || b.to !== a.from || !(b.from < b.to) || !oneDay) {
      fail("priorSelector", "The case needs one local day and the baseline window ending exactly where that day starts, with the same cohort and selection. Open the finding again.");
    }
  } else if (params.has("priorSelector") || period !== "current") fail("period", "Only Project Radar and Spend spikes support paired periods.");
  const integer = (key: string, fallback: number, max: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^\d{1,16}$/.test(raw)) fail(key, `The case ${key} must be a nonnegative whole number.`);
    const result = Number(raw);
    if (!Number.isSafeInteger(result) || result > max || (key === "limit" && result === 0)) fail(key, `The case ${key} is outside its supported range${key === "limit" ? " (1–200)" : ""}.`);
    return result;
  };
  return { investigation, selector, ...(priorSelector ? { priorSelector } : {}), period,
    offset: integer("offset", 0, Number.MAX_SAFE_INTEGER), limit: integer("limit", 100, 200) };
}

/** Complete validated intent + page; excludes mutable toolbar mirrors and arbitrary display prose. */
export function caseQuery(intent: CaseIntent): string {
  const params = new URLSearchParams({ investigation: intent.investigation, selector: JSON.stringify(intent.selector),
    period: intent.period, offset: String(intent.offset), limit: String(intent.limit) });
  if (intent.priorSelector) params.set("priorSelector", JSON.stringify(intent.priorSelector));
  return params.toString();
}
