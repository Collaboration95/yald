import { outcome } from "./analytics";
import type { RequestRow } from "./ocx/store";
import { sourceOf } from "./report/source";

export function publicRow(row: RequestRow) {
  return {
    source: sourceOf(row),
    protocol: row.protocol,
    measurements: row.measurements,
    usageFromAttempts: row.usageFromAttempts,
    usageStatus: row.usageStatus,
    cacheProvenance: row.cacheProvenance,
    cacheWriteTokens: row.cacheWriteTokens,
    rateIn: row.rateIn,
    rateOut: row.rateOut,
    rateCacheRead: row.rateCacheRead,
    rateCacheWrite: row.rateCacheWrite,
    sends: row.sends,
    attemptTokens: row.attemptTokens,
    cwd: row.cwd,
    id: row.id,
    ts: row.ts,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    status: row.status,
    outcome: outcome(row),
    durationMs: row.durationMs,
    ttftMs: row.ttftMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
    cost: row.cost,
    priced: row.priced,
    conversationId: row.conversationId,
    errorCode: row.errorCode,
    closeReason: row.closeReason,
    routeKind: row.routeKind,
    attempts: row.attempts,
    account: row.account,
  };
}
