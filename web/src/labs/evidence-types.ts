import type { CaseIntent } from "../../../server/src/labs/evidence-intent";
import type { CacheEconomicsTotals, CacheRebuildCoverage, CacheRebuildTotals, LedgerRow, SpendDay, SpendDecomposition, SpendRule, ContextSession, MeasurementCoverage, ProjectCoverage, ProjectRadarResponse, RadarCohort, RadarPeriod, RadarWindow, RequestRow } from "../types";
import type { ContextCounts } from "./context-types";

type Finding = { state: "empty" | "insufficient" | "observed"; summary: string; notes: string[] };
export type CaseObservation =
  | (Finding & { investigation: "spend-changes"; rule: SpendRule; day: SpendDay;
    decomposition: SpendDecomposition | null; baselineDays: { date: string; pricedCostUsd: number; pricedRequests: number; requests: number }[] })
  | (Finding & { investigation: "project-radar"; current: RadarPeriod; prior: RadarPeriod;
    comparison: ProjectRadarResponse["comparison"]; history: ProjectRadarResponse["history"];
    project: { key: string; present: boolean; gitRoot: boolean } | null })
  | (Finding & { investigation: "cache-detective"; totals: Omit<CacheEconomicsTotals, "evidence">;
    precisionDp: 6; basis: "api-list-price-equivalent"; projectCoverage: ProjectCoverage | null;
    rebuild?: { ledger: Omit<LedgerRow, "evidence">[]; totals: CacheRebuildTotals; coverage: CacheRebuildCoverage; reasons: { reason: string; requests: number }[] } })
  | (Finding & { investigation: "context-replay"; coverage: ContextCounts & { totalRequests: number };
    growth: ContextSession["growth"] | null; history: ContextSession["history"] | null; compaction: ContextSession["compaction"] | null; projectCoverage: ProjectCoverage | null });

export interface EvidenceTotals {
  requests: number; tokens: number; pricedRequests: number; unpricedRequests: number;
  /** Cache: server round-once six-decimal subtotal; Radar/Context: unrounded priced-row sum. */
  pricedCostUsd: number; unattributedRequests: number;
}
export type EvidenceRow = Omit<RequestRow, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens" | "cost" | "durationMs"> & {
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null;
  cacheWriteTokens: number | null; reasoningTokens: number | null; cost: number | null; durationMs: number | null;
  ordinal: number; originalOrdinal: number; identity: string; project: { project: string; gitRoot: boolean };
  eligible: boolean; exclusionReason: string | null;
  rebuild?: {
    class: LedgerRow["class"]; label: LedgerRow["label"]; signals: LedgerRow["class"][]; reason: string | null; gapMs: number | null; agentId: string;
    rewrittenTokens: number; premiumUsd: number | null; borrowedRate: boolean;
    previous: { id: string; model: string; cacheReadTokens: number; cacheWriteTokens: number } | null;
  };
};
export interface EvidenceCaseResponse {
  ok: true; version: 1; intent: CaseIntent;
  scope: { window: RadarWindow & { fromIso: string; toIso: string; halfOpen: true }; cohort: RadarCohort };
  observation: CaseObservation;
  population: {
    original: EvidenceTotals; evidence: EvidenceTotals; eligibleRequests: number; excludedRequests: number;
    exclusions: { reason: string; requests: number }[]; measurements: MeasurementCoverage;
    projects: { project: string; gitRoot: boolean }[];
  };
  rows: EvidenceRow[];
  page: { offset: number; limit: number; returned: number; total: number; nextOffset: number | null };
}
