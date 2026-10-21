import { filterRows, projectCoverage, type RowFilter } from "../analytics";
import type { RequestRow } from "../ocx/store";
import { contextEligible, sourceOf } from "../report/source";
import { analysisScope, evidenceFor, orderedRequests, sessionGrowth, sessionKey, type AnalysisWindow } from "./scope";

const EXCLUSION_REASONS = ["attempt-summed usage", "input accounting missing", "input accounting unavailable"] as const;
type ContextExclusion = typeof EXCLUSION_REASONS[number];

export function contextExclusionReason(row: RequestRow): ContextExclusion | null {
  if (contextEligible(row)) return null;
  if (row.usageFromAttempts || row.measurements.usage === "attempt-sum") return "attempt-summed usage";
  return row.measurements.input ? "input accounting unavailable" : "input accounting missing";
}

function coverage(rows: RequestRow[]) {
  const reasons = new Map<ContextExclusion, number>(EXCLUSION_REASONS.map(reason => [reason, 0]));
  let pricedRequests = 0;
  let attributedRequests = 0;
  let eligibleRequests = 0;
  for (const row of rows) {
    const reason = contextExclusionReason(row);
    if (reason === null) eligibleRequests++;
    else reasons.set(reason, reasons.get(reason)! + 1);
    if (row.priced) pricedRequests++;
    if (row.cwd !== null) attributedRequests++;
  }
  return {
    totalRequests: rows.length, eligibleRequests, excludedRequests: rows.length - eligibleRequests,
    exclusions: EXCLUSION_REASONS.map(reason => ({ reason, requests: reasons.get(reason)! })),
    pricedRequests, unpricedRequests: rows.length - pricedRequests,
    attributedRequests, unattributedRequests: rows.length - attributedRequests,
  };
}

function observation(row: RequestRow, ordinal: number) {
  const eligible = contextEligible(row);
  return {
    id: row.id, ordinal, ts: row.ts, source: sourceOf(row), protocol: row.protocol,
    provider: row.provider, model: row.model, requestedModel: row.requestedModel,
    resolvedModel: row.resolvedModel, effort: row.effort,
    inputTokens: eligible ? row.inputTokens : null,
    cacheReadTokens: row.measurements.cacheRead ? row.cacheReadTokens : null,
    cacheWriteTokens: row.measurements.cacheWrite ? row.cacheWriteTokens : null,
    outputTokens: row.measurements.output ? row.outputTokens : null,
    // Reasoning is already included in output; never add it to the request total.
    reasoningTokens: row.measurements.output ? row.reasoningTokens : null,
    totalTokens: eligible && row.measurements.output ? row.totalTokens : null,
    cost: row.priced ? row.cost : null, priced: row.priced, estimated: row.estimated,
    durationMs: row.measurements.duration ? row.durationMs : null,
    ttftMs: row.measurements.ttft ? row.ttftMs : null,
    measurements: { ...row.measurements }, usageFromAttempts: row.usageFromAttempts,
    usageStatus: row.usageStatus, cacheProvenance: row.cacheProvenance,
    eligible, exclusionReason: contextExclusionReason(row),
  };
}

/** Context observations, never reconstructed turns. Only loaded rows support history notes. */
export function buildContextReplay(datasetRows: RequestRow[], filter: RowFilter, window: AnalysisWindow) {
  const rows = filterRows(datasetRows, { ...filter, from: window.from, to: window.to });
  const groups = new Map<string, RequestRow[]>();
  for (const row of rows) {
    if (!row.conversationId) continue;
    const key = sessionKey(sourceOf(row), row.conversationId);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  // All-session counters disclose clipping by time and cohort without returning any
  // outside-window/cohort request detail. Source identity always remains part of the key.
  const histories = new Map([...groups.keys()].map(key => [key, {
    totalRequests: 0, beforeWindowRequests: 0, afterWindowRequests: 0, windowRequests: 0,
  }]));
  for (const row of datasetRows) {
    if (!row.conversationId) continue;
    const history = histories.get(sessionKey(sourceOf(row), row.conversationId));
    if (!history) continue;
    history.totalRequests++;
    if (row.ts < window.from) history.beforeWindowRequests++;
    else if (row.ts >= window.to) history.afterWindowRequests++;
    else history.windowRequests++;
  }

  const sessions = [...groups].map(([key, group]) => {
    const requests = orderedRequests(group);
    const first = requests[0]!;
    const source = sourceOf(first);
    const conversationId = first.conversationId!;
    const { ranked, baseline, latest, absoluteChange, ratio } = sessionGrowth(requests);
    const counts = histories.get(key)!;
    const rangeLimited = counts.beforeWindowRequests + counts.afterWindowRequests > 0;
    const outsideCohortRequests = counts.windowRequests - requests.length;
    return {
      key, source, conversationId, ...coverage(requests),
      totalRequests: counts.totalRequests, inWindowRequests: requests.length,
      truncated: rangeLimited || outsideCohortRequests > 0,
      history: {
        beforeWindowRequests: counts.beforeWindowRequests, afterWindowRequests: counts.afterWindowRequests,
        outsideCohortRequests, rangeLimited, cohortLimited: outsideCohortRequests > 0, loadedHistoryOnly: true as const,
      },
      growth: { ranked, baseline, latest, absoluteChange, ratio },
      requests: requests.map(observation),
      evidence: evidenceFor(filter, window, { kind: "session", source, conversationId }, "all"),
    };
  }).sort((a, b) => {
    if (a.growth.ranked !== b.growth.ranked) return a.growth.ranked ? -1 : 1;
    return (b.growth.absoluteChange ?? 0) - (a.growth.absoluteChange ?? 0)
      || a.source.localeCompare(b.source) || a.conversationId.localeCompare(b.conversationId);
  });
  const unnamedRequests = rows.filter(row => !row.conversationId).length;
  return {
    ...analysisScope(filter, window),
    coverage: {
      ...coverage(rows), unnamedRequests, projectCoverage: projectCoverage(datasetRows, { ...filter, from: window.from, to: window.to }),
      evidence: evidenceFor(filter, window, { kind: "scope" }, "all"),
    },
    sessions, unnamedRequests,
    limitations: [
      "Sequences contain requests, which may include concurrent or interleaved agents; they do not reconstruct turns.",
      "Input changes, model changes and costs are observations; they do not establish compaction, waste, quality or cause.",
      "History coverage describes loaded data only. Window and cohort filters can limit the sequence; outside requests are counted, not returned.",
      "Costs are API list-price equivalents, not subscription bills. Reasoning tokens are part of output and are not added again.",
    ],
  };
}
