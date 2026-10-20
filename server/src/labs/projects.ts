import { bucketLabel, filterRows, measurementCoverage, projectCoverage, type RowFilter } from "../analytics";
import { summarizeReasons } from "../attribution";
import type { RequestRow } from "../ocx/store";
import { createProjectIdentity, UNATTRIBUTED } from "../projects";
import { sourceOf } from "../report/source";
import type { Source } from "../report/types";
import { nextBucketStart, windowLabel, zonedBucketStart } from "../time/window";
import { analysisScope, evidenceFor, orderedRequests, type AnalysisWindow, type EvidenceSelection } from "./scope";

export interface RadarTotals {
  requests: number;
  tokens: number;
  /** USD, priced rows only, unrounded. Consult pricedRequests before interpreting zero. */
  pricedCostUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
}

function totals(rows: RequestRow[]): RadarTotals {
  const result: RadarTotals = { requests: rows.length, tokens: 0, pricedCostUsd: 0, pricedRequests: 0, unpricedRequests: 0 };
  for (const row of rows) {
    result.tokens += row.totalTokens;
    if (row.priced) {
      result.pricedRequests++;
      result.pricedCostUsd += row.cost;
    } else result.unpricedRequests++;
  }
  return result;
}

const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const rankMix = (a: RadarTotals, b: RadarTotals) => b.requests - a.requests || b.tokens - a.tokens;

function period(rows: RequestRow[], filter: RowFilter, window: AnalysisWindow, selection: EvidenceSelection, exclusions: ReturnType<typeof projectCoverage> = null) {
  const days = new Map<number, RequestRow[]>();
  const sources = new Map<Source, RequestRow[]>();
  const models = new Map<string, { source: Source; provider: string; model: string; rows: RequestRow[] }>();
  for (const row of rows) {
    const ts = zonedBucketStart(row.ts, "day", window.tz);
    const day = days.get(ts) ?? [];
    day.push(row); days.set(ts, day);
    const source = sourceOf(row);
    const sourceRows = sources.get(source) ?? [];
    sourceRows.push(row); sources.set(source, sourceRows);
    const key = JSON.stringify([source, row.provider, row.model]);
    const model = models.get(key) ?? { source, provider: row.provider, model: row.model, rows: [] };
    model.rows.push(row); models.set(key, model);
  }
  const sum = totals(rows);
  return {
    totals: sum,
    coverage: {
      totalRequests: rows.length,
      eligibleRequests: rows.length,
      pricing: { eligibleRequests: sum.pricedRequests, totalRequests: rows.length },
      attribution: { eligibleRequests: rows.filter(row => row.cwd !== null).length, totalRequests: rows.length },
      measurements: measurementCoverage(rows),
      unattributedReasons: summarizeReasons(rows),
      // These excluded rows are context for the scope, never added to its strict totals.
      projectExclusions: exclusions,
    },
    daily: [...days].sort(([a], [b]) => a - b).map(([ts, day]) => ({
      ts, date: bucketLabel(ts, "day", window.tz), from: Math.max(ts, window.from),
      to: Math.min(nextBucketStart(ts, "day", window.tz), window.to), ...totals(day),
    })),
    activeDays: days.size,
    sources: [...sources].map(([source, rows]) => ({ source, ...totals(rows) }))
      .sort((a, b) => rankMix(a, b) || compareText(a.source, b.source)),
    models: [...models.values()].map(({ rows, ...identity }) => ({ ...identity, ...totals(rows) }))
      .sort((a, b) => rankMix(a, b) || compareText(a.source, b.source) || compareText(a.provider, b.provider) || compareText(a.model, b.model)),
    evidence: evidenceFor(filter, window, selection, "all"),
  };
}

type RadarPeriod = ReturnType<typeof period>;
export interface RadarChange {
  state: "compared" | "new" | "insufficient";
  absoluteChange: number | null;
  /** Fraction, e.g. -0.5 means 50% lower. */
  relativeChange: number | null;
}

function change(current: number, prior: number, available: boolean): RadarChange {
  if (!available) return { state: "insufficient", absoluteChange: null, relativeChange: null };
  return {
    state: prior > 0 ? "compared" : current > 0 ? "new" : "insufficient",
    absoluteChange: current - prior,
    relativeChange: prior > 0 ? (current - prior) / prior : null,
  };
}

function comparison(current: RadarPeriod, prior: RadarPeriod, hasBaselineHistory: boolean) {
  const c = current.totals, p = prior.totals;
  const priceAvailable = hasBaselineHistory && (c.requests === 0 || c.pricedRequests > 0)
    && (p.requests === 0 || p.pricedRequests > 0) && c.pricedRequests + p.pricedRequests > 0;
  return {
    requests: change(c.requests, p.requests, hasBaselineHistory),
    tokens: change(c.tokens, p.tokens, hasBaselineHistory),
    pricedCostUsd: change(c.pricedCostUsd, p.pricedCostUsd, priceAvailable),
  };
}

/** Project Radar consumes normalized, already-priced rows. Both periods use today's loaded engine. */
export function buildProjectRadar(rows: RequestRow[], filter: RowFilter, window: AnalysisWindow) {
  const span = window.to - window.from;
  const priorWindow: AnalysisWindow = {
    from: window.from - span, to: window.from, tz: window.tz,
    label: windowLabel(window.from - span, window.from, window.tz),
  };
  // The resolved window is authoritative even if the caller's filter contains stale bounds.
  const currentFilter = { ...filter, from: window.from, to: window.to };
  const priorFilter = { ...filter, from: priorWindow.from, to: priorWindow.to };
  const currentRows = orderedRequests(filterRows(rows, currentFilter));
  const priorRows = orderedRequests(filterRows(rows, priorFilter));
  let firstLoadedAt: number | null = null;
  for (const row of rows) firstLoadedAt = Math.min(firstLoadedAt ?? row.ts, row.ts);
  const historyFor = (w: AnalysisWindow) => ({
    startsBeforeLoadedHistory: firstLoadedAt === null || w.from < firstLoadedAt,
    hasLoadedHistory: span > 0 && firstLoadedAt !== null && firstLoadedAt < w.to,
  });
  const history = {
    basis: "earliest-loaded-request" as const, firstLoadedAt, completeness: "unknown" as const,
    current: historyFor(window), prior: historyFor(priorWindow),
    note: "Earliest loaded request is a history limit, not proof of uninterrupted collection or retention. New means newly observed in these windows, not project creation.",
  };
  const current = period(currentRows, currentFilter, window, { kind: "scope" }, projectCoverage(rows, currentFilter));
  const prior = period(priorRows, priorFilter, priorWindow, { kind: "scope" }, projectCoverage(rows, priorFilter));
  const identity = createProjectIdentity();
  const groups = new Map<string, { project: string; gitRoot: boolean; folders: Set<string>; current: RequestRow[]; prior: RequestRow[] }>();
  groups.set(UNATTRIBUTED, { project: UNATTRIBUTED, gitRoot: false, folders: new Set(), current: [], prior: [] });
  for (const [name, periodRows] of [["current", currentRows], ["prior", priorRows]] as const) {
    for (const row of periodRows) {
      const { project, gitRoot } = identity(row.cwd);
      const group = groups.get(project) ?? { project, gitRoot, folders: new Set<string>(), current: [], prior: [] };
      if (row.cwd !== null) group.folders.add(row.cwd);
      group[name].push(row);
      groups.set(project, group);
    }
  }
  const projects = [...groups.values()].map(group => {
    const selection = { kind: "project" as const, project: group.project };
    const current = period(group.current, currentFilter, window, selection);
    const prior = period(group.prior, priorFilter, priorWindow, selection);
    return {
      project: group.project, gitRoot: group.gitRoot, folders: [...group.folders].sort(compareText),
      current, prior, comparison: comparison(current, prior, history.prior.hasLoadedHistory),
    };
  }).sort((a, b) => Number(a.project === UNATTRIBUTED) - Number(b.project === UNATTRIBUTED)
    || b.current.totals.pricedCostUsd - a.current.totals.pricedCostUsd || b.current.totals.tokens - a.current.totals.tokens
    || compareText(a.project, b.project));
  const scope = analysisScope(currentFilter, window);
  return {
    ok: true as const, ...scope, priorWindow: analysisScope(priorFilter, priorWindow).window,
    pricingBasis: "currently-loaded-api-list-price-equivalents" as const,
    history, current, prior, comparison: comparison(current, prior, history.prior.hasLoadedHistory), projects,
  };
}

export type ProjectRadarResponse = ReturnType<typeof buildProjectRadar>;
