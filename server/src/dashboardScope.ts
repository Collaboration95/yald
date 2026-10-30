// Scope helpers for the dashboard toolbar (#56): what a source/project selection means
// for views that are not built from request rows, and a small summary of the selection.
import { filterRows, projectCoverage, type RowFilter } from "./analytics";
import type { Dataset, RequestRow } from "./ocx/store";
import { ALL_SOURCES, sourceOf } from "./report/source";
import { readSources } from "./report/spec";
import type { Source } from "./report/types";

/** Filters a quota sample or a ledger event cannot be joined to: they carry no folder, model or outcome. */
const UNJOINABLE = ["projects", "providers", "models", "efforts", "statuses", "routeKinds", "agents", "agentTypes", "search", "conversationId"] as const;

/** Quota and the send ledger are opencodex account observations; only `ocx` has them (SOURCE_CAPABILITIES). */
const ACCOUNT_SOURCE: Source = "ocx";

export interface AccountScope {
  kind: "account";
  source: Source;
  /** False when the selection excludes every source that records this observation. */
  available: boolean;
  /** The selected sources (both when the request named none). */
  requestedSources: Source[];
  /** Active filters that this account-wide observation does not honour, by URL parameter name. */
  ignored: string[];
  note: string;
}

const present = (value: string | undefined) => (value ?? "").split(",").some(part => part.trim() !== "");

/**
 * How a source/project selection applies to quota and the send ledger. They are account-wide:
 * never narrowed to a project, model or request cohort, and absent for a Claude-Code-only selection.
 * An unreadable `sources` throws ReportSpecError (HTTP 400), like every request route.
 */
export function accountScope(query: Record<string, string | undefined>): AccountScope {
  const requestedSources = readSources(query.sources);
  const available = requestedSources.includes(ACCOUNT_SOURCE);
  const ignored = UNJOINABLE.filter(key => key === "search" || key === "conversationId" ? Boolean(query[key]?.trim()) : present(query[key]));
  return {
    kind: "account",
    source: ACCOUNT_SOURCE,
    available,
    requestedSources,
    ignored,
    note: available
      ? "Account-wide opencodex observation. It is not joined to requests, so source, project and request filters do not narrow it and it is never one project's own usage."
      : "Quota and the send ledger are opencodex account observations. Claude Code transcripts record neither, so nothing is shown for a Claude Code only selection.",
  };
}

export const EMPTY_QUOTA: Dataset["quota"] = { windows: [], samples: [], updatedAt: null };

export interface Tally { requests: number; tokens: number }

function tally(rows: RequestRow[]): Tally {
  return { requests: rows.length, tokens: rows.reduce((sum, row) => sum + row.totalTokens, 0) };
}

/** How many requests the full selection keeps, out of the window's, and each source's share of the rest. */
export function scopeSummary(rows: RequestRow[], filter: RowFilter) {
  // Source choices are counted under every other filter, so they stay comparable while one is picked.
  const otherSources = filterRows(rows, { ...filter, sources: undefined });
  const coverage = projectCoverage(rows, filter);
  // Model choices follow the same rule: counted in the window under every other filter, most used first.
  const modelCounts = new Map<string, number>();
  for (const row of filterRows(rows, { ...filter, models: undefined })) modelCounts.set(row.model, (modelCounts.get(row.model) ?? 0) + 1);
  return {
    matched: tally(filterRows(rows, filter)),
    windowTotal: tally(filterRows(rows, { from: filter.from, to: filter.to })),
    sources: ALL_SOURCES.map(source => ({ source, ...tally(otherSources.filter(row => sourceOf(row) === source)) })),
    models: [...modelCounts.entries()].map(([model, requests]) => ({ model, requests })).sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model)),
    ...(coverage ? { coverage } : {}),
  };
}

export type SessionLookup =
  | { status: "missing" }
  | { status: "ambiguous"; sources: Source[] }
  | { status: "found"; source: Source; all: RequestRow[]; inWindow: RequestRow[]; scoped: RequestRow[] };

/**
 * One session's requests under a scope. A conversation id is only unique within a source, so an id
 * that exists in several is resolved by `sessionSource`, else by the source filter, else refused.
 * `filter.conversationId` is ignored: the id being looked up is the selection.
 */
export function lookupSession(rows: RequestRow[], id: string, filter: RowFilter, sessionSource?: Source): SessionLookup {
  const candidates = rows.filter(row => row.conversationId === id && (!sessionSource || sourceOf(row) === sessionSource));
  if (candidates.length === 0) return { status: "missing" };
  const present = new Set(candidates.map(sourceOf));
  const chosen = sessionSource ? [sessionSource] : ALL_SOURCES.filter(source => present.has(source) && (!filter.sources?.length || filter.sources.includes(source)));
  if (chosen.length > 1) return { status: "ambiguous", sources: chosen };
  // A source filter that excludes the only source holding this id leaves that source selected: the scope then reports an empty cohort.
  const source = chosen[0] ?? ALL_SOURCES.find(candidate => present.has(candidate))!;
  const all = candidates.filter(row => sourceOf(row) === source);
  const scope = { ...filter, conversationId: undefined };
  return {
    status: "found",
    source,
    all,
    inWindow: filterRows(all, { from: filter.from, to: filter.to }),
    scoped: filterRows(all, scope),
  };
}
