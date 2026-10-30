import { agentKind, filterRows, percentile, projectCoverage, type RowFilter } from "../analytics";
import type { ClaudeEvent } from "../claude/transcripts";
import type { RequestRow } from "../ocx/store";
import { contextEligible, sourceOf } from "../report/source";
import { analysisScope, evidenceFor, orderedRequests, requestsBefore, sessionGrowth, sessionKey, type AnalysisWindow } from "./scope";

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
    ...(row.details?.agent ? { chain: chainOf(row) } : {}),
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

const chainOf = (row: RequestRow): string => row.details?.agentId ?? agentKind(row);

/** One entry per agent within a session, main first, so a reader can follow one sequence. Null with no markers at all. */
function sessionChains(requests: RequestRow[]) {
  if (!requests.some(row => row.details?.agent)) return null;
  const chains = new Map<string, RequestRow[]>();
  for (const row of requests) {
    const key = chainOf(row);
    const chain = chains.get(key);
    if (chain) chain.push(row);
    else chains.set(key, [row]);
  }
  return [...chains].map(([key, list]) => {
    const { ranked, baseline, latest, ratio } = sessionGrowth(list);
    return { key, agent: agentKind(list[0]!), agentType: list[0]!.details?.agentType ?? null, requests: list.length, growth: { ranked, baseline, latest, ratio } };
  }).sort((a, b) => Number(b.agent === "main") - Number(a.agent === "main") || b.requests - a.requests || a.key.localeCompare(b.key));
}

/** Below this many recorded events in a scope, the auto/manual counts stand without a ratio. */
export const COMPACTION_RATIO_MIN = 10;

type CompactEvent = Extract<ClaudeEvent, { kind: "compact" }>;

/** Compaction records and event capture per Claude session id. Non-Claude sessions have neither. */
export function compactionIndex(events: readonly ClaudeEvent[]) {
  const bySession = new Map<string, CompactEvent[]>();
  const captured = new Set<string>();
  for (const event of events) {
    if (event.kind === "captured") captured.add(event.sessionId);
    if (event.kind !== "compact") continue;
    captured.add(event.sessionId);
    const list = bySession.get(event.sessionId);
    if (list) list.push(event);
    else bySession.set(event.sessionId, [event]);
  }
  return { bySession, captured };
}

/**
 * What the transcript recorded, placed on the session's own sequence. `none recorded` needs event
 * capture: without it the state is `unavailable`, and neither is ever read as "no compaction".
 * Events outside the window are counted, not returned. Nothing here looks at input sizes.
 */
function sessionCompaction(requests: RequestRow[], source: string, conversationId: string, index: ReturnType<typeof compactionIndex>, window: AnalysisWindow, clipped: boolean) {
  const all = source === "claude-code" ? index.bySession.get(conversationId) ?? [] : [];
  const inWindow = all.filter(event => event.ts >= window.from && event.ts < window.to).sort((a, b) => a.ts - b.ts);
  const state = all.length ? "recorded" as const : source === "claude-code" && index.captured.has(conversationId) ? "none recorded" as const : "unavailable" as const;
  const timestamps = requests.map(row => row.ts);
  let previous = 0;
  const events = inWindow.map(event => {
    const position = requestsBefore(timestamps, event.ts);
    const since = position - previous;
    previous = position;
    return { ts: event.ts, chain: event.agentId, trigger: event.trigger, preTokens: event.preTokens, postTokens: event.postTokens, durationMs: event.durationMs, position, requestsSincePrevious: since };
  });
  const count = (match: (trigger: string | null) => boolean) => inWindow.filter(event => match(event.trigger)).length;
  // An event outside the window, or a clipped sequence, means the first one in view may not be the first.
  const firstKnown = events.length > 0 && !clipped && inWindow.length === all.length;
  return {
    state, events, outsideWindowEvents: all.length - inWindow.length,
    requestsUntilFirst: firstKnown ? events[0]!.position : null,
    requestsUntilFirstUnavailable: firstKnown || !events.length ? null : "the sequence starts before the window",
    auto: count(trigger => trigger === "auto"), manual: count(trigger => trigger === "manual"), other: count(trigger => trigger !== "auto" && trigger !== "manual"),
  };
}

function compactionScope(sessions: { compaction: ReturnType<typeof sessionCompaction> }[]) {
  const sum = (field: "auto" | "manual" | "other") => sessions.reduce((total, session) => total + session.compaction[field], 0);
  const states = (state: string) => sessions.filter(session => session.compaction.state === state).length;
  const firsts = sessions.flatMap(session => (session.compaction.requestsUntilFirst === null ? [] : [session.compaction.requestsUntilFirst]));
  const [auto, manual, other] = [sum("auto"), sum("manual"), sum("other")];
  const events = auto + manual + other;
  return {
    recordedSessions: states("recorded"), noneRecordedSessions: states("none recorded"), unavailableSessions: states("unavailable"),
    events, auto, manual, other,
    /** Auto over manual, only from COMPACTION_RATIO_MIN events and with a manual event to divide by. */
    autoPerManual: events >= COMPACTION_RATIO_MIN && manual > 0 ? auto / manual : null,
    medianRequestsUntilFirst: percentile(firsts, 0.5), requestsUntilFirstSessions: firsts.length,
  };
}

/** Context observations, never reconstructed turns. Only loaded rows support history notes. */
export function buildContextReplay(datasetRows: RequestRow[], filter: RowFilter, window: AnalysisWindow, claudeEvents: readonly ClaudeEvent[] = []) {
  const compactions = compactionIndex(claudeEvents);
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
      chains: sessionChains(requests),
      compaction: sessionCompaction(requests, source, conversationId, compactions, window, counts.beforeWindowRequests > 0 || outsideCohortRequests > 0),
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
      compaction: compactionScope(sessions),
    },
    sessions, unnamedRequests,
    limitations: [
      "Sequences contain requests, not turns. A session's requests interleave its agents: where Claude Code recorded markers the chart shows one chain at a time, and without markers, including all Codex threads, one sequence can still mix agents.",
      "A recorded event shows that Claude Code compacted at that time. An input drop with no recorded event establishes nothing. No recorded compaction is not no compaction, and model changes and costs near an event are not its causes.",
      "Pre and post tokens are Claude Code's own counts, not API usage counters. An event with no agent id cannot be split by agent.",
      "History coverage describes loaded data only. Window and cohort filters can limit the sequence; outside requests are counted, not returned.",
      "Costs are API list-price equivalents, not subscription bills. Reasoning tokens are part of output and are not added again.",
    ],
  };
}
