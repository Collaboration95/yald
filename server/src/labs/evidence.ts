import { filterRows, measurementCoverage, projectCoverage, type RowFilter } from "../analytics";
import type { ClaudeEvent } from "../claude/transcripts";
import type { Dataset, RequestRow } from "../ocx/store";
import { createProjectIdentity } from "../projects";
import { publicRow } from "../publicRow";
import { contextEligible, sourceOf } from "../report/source";
import { buildCacheEconomics, cacheEligibility, round6 } from "./cache";
import { buildCacheRebuilds, ledgerExclusion, ledgerIndex } from "./cache-rebuild";
import { buildContextReplay, contextExclusionReason } from "./context";
import { matchesBranch } from "./branches";
import { buildProjectRadar } from "./projects";
import { analysisScope, evidenceFor, orderedRequests, sessionKey } from "./scope";
import { quotaCase } from "./quota";
import { SPEND_RULE, spendCaseObservation } from "./spend";
import { EvidenceIntentError, type CaseIntent, type CaseSelector } from "./evidence-intent";

export function caseFilter(selector: CaseSelector): RowFilter {
  return { ...selector.cohort, conversationId: selector.cohort.conversationId ?? undefined,
    from: selector.window.from, to: selector.window.to };
}

/** Exact group keys, protocol-qualified sessions, and actual null IDs. No conversation fallback. */
export function selectCaseRows(datasetRows: RequestRow[], selector: CaseSelector): RequestRow[] {
  const rows = filterRows(datasetRows, caseFilter(selector));
  const selection = selector.selection;
  const identity = createProjectIdentity();
  return orderedRequests(rows.filter(row => selection.kind === "scope"
    || (selection.kind === "project" && identity(row.cwd).project === selection.project)
    || (selection.kind === "session" && sourceOf(row) === selection.source && row.conversationId === selection.conversationId)
    || (selection.kind === "unnamed" && row.conversationId === null && (!selection.source || sourceOf(row) === selection.source))
    || (selection.kind === "chain" && sourceOf(row) === selection.source && row.conversationId === selection.conversationId && (row.details?.agentId ?? "main") === selection.agentId)
    || (selection.kind === "branch" && identity(row.cwd).project === selection.project && matchesBranch(row, selection))
    || (selection.kind === "account" && row.account === selection.account)));
}

function rowTotals(rows: RequestRow[], pricedCostUsd?: number) {
  return {
    requests: rows.length, tokens: rows.reduce((n, row) => n + row.totalTokens, 0),
    pricedRequests: rows.filter(row => row.priced).length,
    unpricedRequests: rows.filter(row => !row.priced).length,
    pricedCostUsd: pricedCostUsd ?? rows.reduce((n, row) => n + (row.priced ? row.cost : 0), 0),
    unattributedRequests: rows.filter(row => row.cwd === null).length,
  };
}
const money = (value: number | null) => value === null ? "unavailable" : `$${value.toFixed(6)}`;
const COST_NOTE = "Costs are API list-price equivalents, not subscription bills or proof of realized savings.";

function radarObservation(rows: RequestRow[], intent: CaseIntent) {
  const selector = intent.selector;
  const selection = selector.selection;
  // A branch reads as a project of just its rows, against the whole loaded history.
  const scoped = selection.kind === "branch" ? rows.filter(row => matchesBranch(row, selection)) : rows;
  const radar = buildProjectRadar(scoped, caseFilter(selector), selector.window, { historyRows: rows });
  const group = selection.kind === "project" || selection.kind === "branch" ? radar.projects.find(project => project.project === selection.project) : radar;
  // A disappeared group is empty, never the whole scope. Retain real dataset history limits.
  const empty = group ? null : buildProjectRadar([], caseFilter(selector), selector.window);
  const selected = group ?? empty!;
  // Even a vanished project keeps its exact selectors. Empty builder scope links
  // must not turn a later inspection into the whole cohort.
  const current = { ...selected.current, evidence: evidenceFor(caseFilter(selector), selector.window, selection, "all") };
  const originalPrior = intent.priorSelector!;
  const prior = { ...selected.prior, evidence: evidenceFor(caseFilter(originalPrior), originalPrior.window, selection, "all") };
  const state = current.totals.requests + prior.totals.requests === 0 ? "empty" as const
    : selected.comparison.requests.state === "insufficient" ? "insufficient" as const : "observed" as const;
  return {
    investigation: "project-radar" as const, state,
    summary: `Current: ${current.totals.requests} requests, ${current.totals.tokens} recorded tokens, ${money(current.totals.pricedRequests ? current.totals.pricedCostUsd : null)}. Prior: ${prior.totals.requests} requests, ${prior.totals.tokens} recorded tokens, ${money(prior.totals.pricedRequests ? prior.totals.pricedCostUsd : null)}.`,
    current, prior, comparison: selected.comparison, history: radar.history,
    project: selection.kind === "project" || selection.kind === "branch" ? { key: selection.project, present: Boolean(group),
      gitRoot: group && "gitRoot" in group ? group.gitRoot : false } : null,
    notes: [radar.history.note, "Both original periods use the currently loaded price engine. Unpriced requests contribute no dollars; priced zero remains zero.", COST_NOTE],
  };
}
function cacheObservation(datasetRows: RequestRow[], selectedRows: RequestRow[], selector: CaseSelector) {
  // The accepted builder owns the predicate, pricing-pair sums and round-once semantics.
  // Building the exact selected population avoids the session ranking's presentation limit.
  // Preserve the builder's original accumulation order; only the evidence list
  // needs timestamp/source/ID ordering. This also preserves rounding at ties.
  const selected = new Set(selectedRows);
  const data = buildCacheEconomics(datasetRows.filter(row => selected.has(row)), caseFilter(selector), selector.window, { limit: 1 });
  const selection = selector.selection;
  const group = selection.kind === "session"
    ? data.sessions.find(session => session.key === sessionKey(selection.source, selection.conversationId)) ?? data.totals
    : selection.kind === "unnamed" ? data.unnamed : data.totals;
  const { evidence: _evidence, ...totals } = group;
  const state = !totals.totalRequests ? "empty" as const : !totals.eligibleRequests ? "insufficient" as const : "observed" as const;
  return {
    investigation: "cache-detective" as const, state, totals,
    summary: totals.eligibleRequests
      ? `${totals.eligibleRequests} of ${totals.totalRequests} requests support this fixed-workload comparison: cache-read discount ${money(totals.readDiscountUsd)}, cache-write premium ${money(totals.writePremiumUsd)}, net ${money(totals.netUsd)} (${totals.direction}).`
      : `${totals.totalRequests} requests; no eligible cache accounting for a monetary comparison.`,
    precisionDp: data.precisionDp, basis: data.basis,
    projectCoverage: projectCoverage(datasetRows, caseFilter(selector)), notes: data.notes,
  };
}
function rebuildObservation(datasetRows: RequestRow[], selectedRows: RequestRow[], selector: CaseSelector, claudeEvents: readonly ClaudeEvent[]) {
  const economics = cacheObservation(datasetRows, selectedRows, selector);
  const { ledger, totals, coverage, reasons, notes } = buildCacheRebuilds(datasetRows, caseFilter(selector), selector.window, claudeEvents, selectedRows);
  const state = !selectedRows.length ? "empty" as const : !coverage.eligibleRequests ? "insufficient" as const : "observed" as const;
  return {
    ...economics, state, notes,
    rebuild: { ledger: ledger.map(({ evidence: _evidence, ...row }) => row), totals, coverage, reasons },
    summary: `${totals.requests} rebuilds in ${coverage.eligibleChains} chains: ${totals.reported} reported, ${totals.inferred} inferred, ${totals.noEvidence} with no evidence. Upper-bound premium ${money(totals.premiumUsd)}, ${totals.unpricedRequests} unpriced.`,
  };
}
function contextObservation(datasetRows: RequestRow[], selectedRows: RequestRow[], selector: CaseSelector, claudeEvents: readonly ClaudeEvent[]) {
  const filter = caseFilter(selector);
  const data = buildContextReplay(datasetRows, filter, selector.window, claudeEvents);
  const selection = selector.selection;
  const session = selection.kind === "session"
    ? data.sessions.find(session => session.key === sessionKey(selection.source, selection.conversationId)) : undefined;
  const counts = session ?? buildContextReplay(selectedRows, filter, selector.window).coverage;
  // Request arrays are served only through the bounded page, never duplicated in the observation.
  const { eligibleRequests, excludedRequests, exclusions, pricedRequests, unpricedRequests, attributedRequests, unattributedRequests } = counts;
  const totalRequests = selectedRows.length;
  const coverage = { totalRequests, eligibleRequests, excludedRequests, exclusions, pricedRequests, unpricedRequests, attributedRequests, unattributedRequests };
  const growth = session?.growth ?? null;
  const state = !totalRequests ? "empty" as const
    : !eligibleRequests || (selection.kind === "session" && !growth?.ranked) ? "insufficient" as const : "observed" as const;
  return {
    investigation: "context-replay" as const, state, coverage, growth, history: session?.history ?? null, compaction: session?.compaction ?? null,
    summary: growth?.ranked
      ? `${eligibleRequests} of ${totalRequests} requests have eligible submitted input. First-three median ${growth.baseline} tokens; last-three median ${growth.latest} tokens; change ${growth.absoluteChange} tokens.`
      : `${eligibleRequests} of ${totalRequests} requests have eligible submitted input. ${selection.kind === "session" ? "At least six eligible requests are needed for the first-three / last-three median comparison." : "Growth comparisons apply to individual source-qualified sessions."}`,
    projectCoverage: data.coverage.projectCoverage,
    notes: [...data.limitations, "Cache tokens are included in input. Missing and attempt-summed input remain unavailable for context comparisons; observed zero is valid."],
  };
}

/**
 * The spend case recomputes detection and decomposition from exactly the rows of the day's window and the
 * baseline window just before it, under the same cohort and selection, so it reproduces the finding.
 */
function spendObservation(datasetRows: RequestRow[], intent: CaseIntent) {
  const day = selectCaseRows(datasetRows, intent.selector);
  const baseline = selectCaseRows(datasetRows, intent.priorSelector!);
  const result = spendCaseObservation(day, baseline, intent.selector.window);
  const { day: record, decomposition } = result;
  const state = !day.length && !baseline.length ? "empty" as const
    : record.state === "insufficient" || record.state === "no-priced" ? "insufficient" as const : "observed" as const;
  const usd = (value: number | null) => money(value);
  const ratio = record.baseline.ratio === null ? "unavailable" : `${record.baseline.ratio.toFixed(2)}x`;
  const text = record.state === "no-priced" ? `No priced request on ${record.date}; ${record.requests} requests, ${record.tokens} recorded tokens.`
    : record.state === "insufficient" ? `${record.date}: ${record.baseline.activeDays} active baseline days; the rule needs ${SPEND_RULE.minBaselineActiveDays} and a median above $0, so this day is insufficient, not normal.`
    : `${record.date}: ${usd(record.pricedCostUsd)} priced, ${ratio} the median ${usd(record.baseline.medianUsd)} of the previous ${record.baseline.activeDays} active days (${record.state === "spike" ? "above" : "not above"} the ${SPEND_RULE.spikeMultiple}x threshold ${usd(record.baseline.thresholdUsd)}). ${record.pricedRequests} of ${record.requests} requests that day had a price.`;
  return {
    investigation: "spend-changes" as const, state, summary: text, rule: SPEND_RULE,
    day: record, decomposition, baselineDays: result.baselineDays,
    notes: [
      "Unusual means unusual against your own loaded recent history. It is not wasteful, wrong or over budget.",
      "Dollars are API list-price equivalents under today's loaded prices, priced requests only. Unpriced requests add requests and tokens, never dollars.",
      "A share says where recorded dollars landed; it does not establish a cause or a change in behaviour. Loaded history is not necessarily history that happened.",
      COST_NOTE,
    ],
  };
}

function quotaObservation(data: ReturnType<typeof quotaCase>, intent: CaseIntent) {
  const usable = data.intervals.filter(interval => !interval.exclusion).length;
  const page = data.intervals.slice(intent.offset, intent.offset + intent.limit).map(({ firstRequest: _first, lastRequest: _last, ...interval }, index) => ({ ...interval, index: intent.offset + index }));
  const total = data.intervals.length;
  return {
    investigation: "quota-pace" as const, state: !data.present ? "empty" as const : total ? "observed" as const : "insufficient" as const, joined: data.joined, samples: data.samples, sources: data.sources,
    intervals: page, intervalPage: { offset: intent.offset, limit: intent.limit, returned: page.length, total, nextOffset: intent.offset + page.length < total ? intent.offset + page.length : null },
    summary: `${data.samples} samples and ${total} intervals in this window; ${usable} with a positive change.${data.joined ? "" : " These samples are not joined to requests, so request figures are unavailable."}`,
    notes: ["Quota is an account observation, never split by project, model or session.", "Used percent here is what each sample reported, including stale values from parallel sessions.", "Source filters other than ocx do not apply."],
  };
}

/** Bounded public metadata plus full-population metrics from the accepted investigation builders. */
export function buildEvidenceCase(datasetRows: RequestRow[], intent: CaseIntent, claudeEvents: readonly ClaudeEvent[] = [], quota?: { quota: Dataset["quota"]; now: number }) {
  const selectedSelector = intent.period === "prior" ? intent.priorSelector! : intent.selector;
  const selected = selectCaseRows(datasetRows, selectedSelector);
  const selection = selectedSelector.selection;
  const quotaData = selection.kind === "account" ? quotaCase(quota?.quota ?? { windows: [], samples: [], updatedAt: null }, datasetRows, selection, selectedSelector.window.to, quota?.now ?? Date.now()) : null;
  const expanded = quotaData && intent.interval !== undefined ? quotaData.intervals[intent.interval] : undefined;
  if (quotaData && intent.interval !== undefined && !expanded) throw new EvidenceIntentError("interval", "This interval is not in the window. Open the finding again.");
  const expandedRows = expanded ? new Set(quotaData!.requestRows.slice(expanded.firstRequest, expanded.lastRequest)) : null;
  const rebuild = selectedSelector.eligibility === "rebuild" ? ledgerIndex(datasetRows, claudeEvents).entries : null;
  const inLedger = (row: RequestRow) => {
    const entry = rebuild!.get(row);
    return Boolean(entry?.class) && (selectedSelector.cause ? entry!.class === selectedSelector.cause : Boolean(entry!.previous));
  };
  const eligible = (row: RequestRow) => rebuild ? ledgerExclusion(row) === null
    : intent.investigation === "cache-detective" ? cacheEligibility(row).eligible
    : intent.investigation === "context-replay" ? contextEligible(row) : true;
  const selectedEvidence = selected.filter(row => quotaData ? Boolean(expandedRows?.has(row)) : rebuild ? inLedger(row)
    : selectedSelector.eligibility === "cache" ? cacheEligibility(row).eligible
    : selectedSelector.eligibility === "context" ? contextEligible(row) : true);
  const exclusions = new Map<string, number>();
  for (const row of selected) {
    const cache = cacheEligibility(row);
    const reason = rebuild ? ledgerExclusion(row)
      : intent.investigation === "cache-detective" ? cache.eligible ? null : cache.reason
      : intent.investigation === "context-replay" ? contextExclusionReason(row) : null;
    if (reason) exclusions.set(reason, (exclusions.get(reason) ?? 0) + 1);
  }
  const ordinals = new Map(selected.map((row, ordinal) => [row, ordinal]));
  const originalOrdinals = new Map(datasetRows.map((row, ordinal) => [row, ordinal]));
  const identity = createProjectIdentity();
  const observation = quotaData ? quotaObservation(quotaData, intent)
    : intent.investigation === "project-radar" ? radarObservation(datasetRows, intent)
    : intent.investigation === "spend-changes" ? spendObservation(datasetRows, intent)
    : rebuild ? rebuildObservation(datasetRows, selected, selectedSelector, claudeEvents)
    : intent.investigation === "cache-detective" ? cacheObservation(datasetRows, selected, selectedSelector)
    : contextObservation(datasetRows, selected, selectedSelector, claudeEvents);
  // Cache evidence reuses the builder's exact pricing-pair sum, already rounded
  // once. The original subtotal also includes priced exclusions: sum their raw
  // row costs in dataset order, then apply the same server rounding rule once.
  // Radar/Context retain their unrounded reported-cost semantics.
  const originalCost = observation.investigation === "cache-detective"
    ? round6(datasetRows.reduce((sum, row) => sum + (ordinals.has(row) && row.priced ? row.cost : 0), 0)) : undefined;
  const population = {
    original: rowTotals(selected, originalCost),
    evidence: rowTotals(selectedEvidence, observation.investigation === "cache-detective" && !rebuild ? observation.totals.actualUsd : undefined),
    eligibleRequests: selected.filter(eligible).length,
    excludedRequests: selected.filter(row => !eligible(row)).length,
    exclusions: [...exclusions].map(([reason, requests]) => ({ reason, requests })),
    measurements: measurementCoverage(selected),
    // Keep all group identities in the hash even when this page is empty or beyond the last row.
    projects: [...new Map(selected.map(row => { const project = identity(row.cwd); return [JSON.stringify(project), project]; })).values()],
  };
  const rebuildFields = (row: RequestRow) => {
    const entry = rebuild?.get(row);
    if (!entry) return {};
    const { previous } = entry;
    return { rebuild: { class: entry.class!, label: entry.label!, signals: entry.signals, reason: entry.reason, gapMs: entry.gapMs, agentId: entry.agentId,
      rewrittenTokens: entry.rewrittenTokens, premiumUsd: entry.premiumUsd === null ? null : round6(entry.premiumUsd), borrowedRate: entry.borrowedRate,
      previous: previous ? { id: previous.id, model: previous.model, cacheReadTokens: previous.cacheReadTokens, cacheWriteTokens: previous.cacheWriteTokens } : null } };
  };
  // Without an expanded interval the offset pages the intervals, in the observation.
  const rowOffset = quotaData && !expanded ? 0 : intent.offset;
  const rows = selectedEvidence.slice(rowOffset, rowOffset + intent.limit).map(row => {
    const originalOrdinal = originalOrdinals.get(row)!;
    return {
      ...publicRow(row), ordinal: ordinals.get(row)!, originalOrdinal,
      identity: JSON.stringify([sourceOf(row), row.id, row.ts, originalOrdinal]), project: identity(row.cwd),
      inputTokens: contextEligible(row) ? row.inputTokens : null,
      outputTokens: row.measurements.output ? row.outputTokens : null,
      cacheReadTokens: row.measurements.cacheRead ? row.cacheReadTokens : null,
      cacheWriteTokens: row.measurements.cacheWrite ? row.cacheWriteTokens : null,
      reasoningTokens: row.measurements.output ? row.reasoningTokens : null,
      cost: row.priced ? row.cost : null,
      durationMs: row.measurements.duration ? row.durationMs : null, ttftMs: row.measurements.ttft ? row.ttftMs : null,
      eligible: eligible(row), exclusionReason: intent.investigation === "context-replay" ? contextExclusionReason(row) : null,
      ...rebuildFields(row),
    };
  });
  return {
    ok: true as const, version: 1 as const, intent, scope: analysisScope(caseFilter(selectedSelector), selectedSelector.window),
    population, observation, rows,
    page: { offset: rowOffset, limit: intent.limit, returned: rows.length, total: selectedEvidence.length,
      nextOffset: rowOffset + rows.length < selectedEvidence.length ? rowOffset + rows.length : null },
  };
}

export type EvidenceCaseResponse = ReturnType<typeof buildEvidenceCase>;
