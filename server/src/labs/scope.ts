import type { Outcome, RowFilter } from "../analytics";
import type { RequestRow } from "../ocx/store";
import { ALL_SOURCES, contextEligible, sourceOf } from "../report/source";
import type { Source } from "../report/types";
import { isoInZone } from "../time/window";

/** An analysis resolves a rolling range once, then carries these exact bounds to evidence. */
export interface AnalysisWindow {
  from: number;
  to: number;
  tz: string;
  label: string;
}

export interface AnalysisCohort {
  sources: Source[];
  projects: string[];
  providers: string[];
  models: string[];
  efforts: string[];
  statuses: Outcome[];
  routeKinds: string[];
  conversationId: string | null;
  search: string;
}

export type EvidenceSelection =
  | { kind: "scope" }
  | { kind: "project"; project: string }
  | { kind: "session"; source: Source; conversationId: string }
  | { kind: "unnamed"; source?: Source };

export type EvidenceEligibility = "all" | "cache" | "context";

export interface EvidenceSelector {
  version: 1;
  window: AnalysisWindow;
  cohort: AnalysisCohort;
  selection: EvidenceSelection;
  eligibility: EvidenceEligibility;
}

export function analysisScope(filter: RowFilter, window: AnalysisWindow) {
  const cohort: AnalysisCohort = {
    sources: [...(filter.sources?.length ? filter.sources : ALL_SOURCES)],
    projects: [...(filter.projects ?? [])],
    providers: [...(filter.providers ?? [])],
    models: [...(filter.models ?? [])],
    efforts: [...(filter.efforts ?? [])],
    statuses: [...(filter.statuses ?? [])],
    routeKinds: [...(filter.routeKinds ?? [])],
    conversationId: filter.conversationId ?? null,
    search: filter.search ?? "",
  };
  return {
    window: { from: window.from, to: window.to, tz: window.tz, label: window.label,
      fromIso: isoInZone(window.from, window.tz), toIso: isoInZone(window.to, window.tz), halfOpen: true as const },
    cohort,
  };
}

/** The URL contains the resolved window and every cohort dimension, never a moving range preset. */
export function evidenceParams(selector: EvidenceSelector): URLSearchParams {
  const { window, selection } = selector;
  const params = new URLSearchParams({
    selectorVersion: String(selector.version), from: String(window.from), to: String(window.to), tz: window.tz,
    kind: selection.kind, eligibility: selector.eligibility,
    // This is authoritative for a case file; dashboard controls may change the readable mirrors below.
    // Structured arrays preserve literal commas, and the embedded window stays pinned after range changes.
    selector: JSON.stringify(selector),
  });
  if (selection.kind === "project") params.set("projectKey", selection.project);
  if (selection.kind === "session") {
    params.set("sessionSource", selection.source);
    params.set("sessionId", selection.conversationId);
  }
  if (selection.kind === "unnamed" && selection.source) params.set("sessionSource", selection.source);
  return params;
}

export function evidenceFor(filter: RowFilter, window: AnalysisWindow, selection: EvidenceSelection = { kind: "scope" }, eligibility: EvidenceEligibility = "all") {
  const { cohort } = analysisScope(filter, window);
  const selector: EvidenceSelector = { version: 1, window: { from: window.from, to: window.to, tz: window.tz, label: window.label }, cohort, selection, eligibility };
  return { selector, href: `/labs/evidence?${evidenceParams(selector)}` };
}

/** Equal timestamps retain a deterministic source/id/order tie-break; inputs are never mutated. */
export function orderedRequests(rows: RequestRow[]): RequestRow[] {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return rows.map((row, index) => ({ row, index })).sort((a, b) =>
    a.row.ts - b.row.ts || compare(sourceOf(a.row), sourceOf(b.row)) || compare(a.row.id, b.row.id) || a.index - b.index,
  ).map(entry => entry.row);
}

export const sessionKey = (source: Source, conversationId: string): string => JSON.stringify([source, conversationId]);

/**
 * How many of the named sessions have a loaded request outside [from, to): the window clipped them, so only
 * their in-window part is analysed. `named` maps each source to the conversation ids of interest.
 */
export function countClippedSessions(named: ReadonlyMap<Source, ReadonlySet<string>>, datasetRows: readonly RequestRow[], from: number, to: number): number {
  const clipped = new Set<string>();
  for (const row of datasetRows) {
    if (!row.conversationId || (row.ts >= from && row.ts < to)) continue;
    const source = sourceOf(row);
    if (named.get(source)?.has(row.conversationId)) clipped.add(sessionKey(source, row.conversationId));
  }
  return clipped.size;
}

/** A session is ranked for growth when it has at least this many context-eligible requests. */
export const GROWTH_MIN_ELIGIBLE = 6;
/** Growth compares the median of this many first versus last eligible requests. */
export const GROWTH_SAMPLE = 3;

export interface SessionGrowth {
  eligibleRequests: number;
  ranked: boolean;
  baseline: number | null;
  latest: number | null;
  absoluteChange: number | null;
  ratio: number | null;
}

const medianOfThree = (rows: RequestRow[]): number => rows.map(row => row.inputTokens).sort((a, b) => a - b)[1]!;

/**
 * Context growth of one session: the median input of its first 3 eligible requests versus its
 * last 3, ranked only from 6 eligible requests. `ordered` must already be in `orderedRequests` order.
 * Context Replay and the Context page both read this, so they cannot drift.
 */
export function sessionGrowth(ordered: RequestRow[]): SessionGrowth {
  const eligible = ordered.filter(contextEligible);
  const ranked = eligible.length >= GROWTH_MIN_ELIGIBLE;
  const baseline = ranked ? medianOfThree(eligible.slice(0, GROWTH_SAMPLE)) : null;
  const latest = ranked ? medianOfThree(eligible.slice(-GROWTH_SAMPLE)) : null;
  return {
    eligibleRequests: eligible.length, ranked, baseline, latest,
    absoluteChange: baseline === null ? null : latest! - baseline,
    ratio: baseline !== null && baseline !== 0 ? latest! / baseline : null,
  };
}
