import type { Outcome, RowFilter } from "../analytics";
import type { RequestRow } from "../ocx/store";
import { ALL_SOURCES, sourceOf } from "../report/source";
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
