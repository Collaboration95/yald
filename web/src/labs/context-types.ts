import type { Measurements, Source } from "../types";

export interface ContextWindow {
  from: number;
  to: number;
  tz: string;
  label: string;
  fromIso: string;
  toIso: string;
  halfOpen: true;
}

export interface ContextCohort {
  sources: Source[];
  projects: string[];
  providers: string[];
  models: string[];
  efforts: string[];
  statuses: ("ok" | "error" | "cancelled" | "unobserved")[];
  routeKinds: string[];
  conversationId: string | null;
  search: string;
}

export interface ContextEvidence {
  href: string;
  selector: {
    version: 1;
    window: Pick<ContextWindow, "from" | "to" | "tz" | "label">;
    cohort: ContextCohort;
    selection: { kind: "scope" } | { kind: "session"; source: Source; conversationId: string }
      | { kind: "project"; project: string } | { kind: "unnamed"; source?: Source };
    /** Context Replay emits "all" so excluded observations remain inspectable. */
    eligibility: "all" | "cache" | "context";
  };
}

export type ContextExclusion = "attempt-summed usage" | "input accounting missing" | "input accounting unavailable";
export interface ContextCounts {
  eligibleRequests: number;
  excludedRequests: number;
  exclusions: { reason: ContextExclusion; requests: number }[];
  pricedRequests: number;
  unpricedRequests: number;
  attributedRequests: number;
  unattributedRequests: number;
}

export interface ContextObservation {
  id: string;
  /** Zero-based within the selected session, disambiguating duplicate IDs. */
  ordinal: number;
  ts: number;
  source: Source;
  protocol: string | null;
  /** The session chain this request belongs to; absent without an agent marker. */
  chain?: string;
  provider: string;
  model: string;
  requestedModel: string | null;
  resolvedModel: string | null;
  effort: string | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  /** A subset of output, never added to totalTokens. */
  reasoningTokens: number | null;
  totalTokens: number | null;
  /** API list-price equivalent USD, null when unpriced. */
  cost: number | null;
  priced: boolean;
  estimated: boolean;
  durationMs: number | null;
  ttftMs: number | null;
  measurements: Measurements;
  usageFromAttempts: boolean;
  usageStatus: string;
  cacheProvenance: string | null;
  eligible: boolean;
  exclusionReason: ContextExclusion | null;
}

export interface ContextChain {
  /** The `agentId`, or the agent kind for requests without one. */
  key: string;
  agent: "main" | "subagent" | "unlabelled";
  agentType: string | null;
  requests: number;
  growth: { ranked: boolean; baseline: number | null; latest: number | null; ratio: number | null };
}

export interface ContextSession extends ContextCounts {
  key: string;
  source: Source;
  conversationId: string;
  /** All loaded rows with this exact source/session, before time/cohort filters. */
  totalRequests: number;
  /** Denominator for all ContextCounts fields and growth in this session. */
  inWindowRequests: number;
  truncated: boolean;
  history: {
    beforeWindowRequests: number;
    afterWindowRequests: number;
    outsideCohortRequests: number;
    rangeLimited: boolean;
    cohortLimited: boolean;
    loadedHistoryOnly: true;
  };
  growth: {
    ranked: boolean;
    baseline: number | null;
    latest: number | null;
    absoluteChange: number | null;
    /** Latest median / baseline median; null for zero baseline or <6 eligible. */
    ratio: number | null;
  };
  /** The session's agents, main first; null when no request carries a marker. */
  chains: ContextChain[] | null;
  requests: ContextObservation[];
  evidence: ContextEvidence;
}

export interface ContextReplayResponse {
  ok: true;
  window: ContextWindow;
  cohort: ContextCohort;
  coverage: ContextCounts & {
    totalRequests: number;
    unnamedRequests: number;
    projectCoverage: {
      unattributedRows: number;
      unattributedTokens: number;
      attribution: {
        matched: { rows: number; tokens: number };
        outsideProjects: { rows: number; tokens: number };
        unattributed: {
          rows: number;
          tokens: number;
          reasons: {
            reason: "noConversationId" | "noRollout" | "other";
            rows: number;
            tokens: number;
            models: { model: string; rows: number; tokens: number }[];
          }[];
        };
      };
    } | null;
    evidence: ContextEvidence;
  };
  sessions: ContextSession[];
  unnamedRequests: number;
  limitations: string[];
}
