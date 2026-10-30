// Report contract, frozen in the epic (#31, "Contracts → Report"). Changes go
// through that issue so buildReport (#36), the renderer (#37), the CLI (#38)
// and the endpoint (#39) stay compatible.

import type { AttributionCoverage } from "../attribution";
import type { InferredCoverage } from "./infer";
import type { Instant, Phase, TimeWindow } from "../time/window";

export type Source = "claude-code" | "ocx";

export interface ReportSpec {
  window: TimeWindow;
  phases: Phase[];               // [] = no phase table
  sources: Source[];             // default both
  projects: string[];            // globs; [] = no project filter
  top: number;                   // default 10
  redact: boolean;               // default true
  infer?: boolean;               // default true; false keeps recorded folders only (#47)
  title?: string;
}

export interface Totals {
  requests: number; tokens: number;
  freshInput: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number;
  costUsd: number | null;
}

export interface ReportData {
  schemaVersion: 1;
  meta: {
    title: string; generatedAt: Instant; yaldVersion: string; tz: string;
    window: { from: Instant; to: Instant; label: string };
    filters: { sources: Source[]; projects: string[] };
  };
  kpis: Totals & {
    conversations: number; activeHours: number;
    cacheHitRate: number | null; cacheSavingsUsd: number;
    successRate: number | null;  // ocx rows only; Claude rows are always 200
  };
  phases: Array<Totals & {
    name: string; from: Instant; to: Instant;   // last two rows: "(outside phases)" and "Total"
    conversations: number; topModel: string | null;
    tokensBySource: Record<Source, number>;
  }>;
  timeline: {
    bucket: "hour" | "day";
    points: Array<{ ts: Instant; label: string; bySource: Record<Source, { tokens: number; requests: number }> }>;
  };
  composition: { freshInput: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number };
  models: Array<{
    model: string; provider: string; source: Source;
    requests: number; tokens: number; share: number; output: number;
    costUsd: number | null; usdPerMTok: number | null; cacheHitRate: number | null; ttftP50Ms: number | null;
  }>;
  cache: { hitRate: number | null; savingsUsd: number; costByClass: { freshInput: number; cacheRead: number; cacheWrite: number; output: number } };
  conversations: Array<{
    id: string; source: Source; models: string[];
    requests: number; tokens: number; costUsd: number | null;
    from: Instant; to: Instant; project: string | null;
  }>;
  quota: {
    windows: Array<{ account: string; window: string; status: "measured" | "insufficient"; samples: number;
                     usedPctStart: number | null; usedPctEnd: number | null; burnPctPerDay: number | null }>;
    claudeCode: "unavailable";
  };
  coverage: {
    sourcesRead: string[];
    unpriced: Array<{ model: string; requests: number }>;
    estimatedCostShare: number;
    rowsWithoutConversation: number;
    ledgerStartsAt: Instant | null;          // set when the spend ledger begins after window.from
    pricing: "ok" | "unavailable";
    unattributedRows: number | null;         // null when no project filter was applied
    unattributedTokens: number | null;       // same population as unattributedRows
    /** Additive (#55): kept / elsewhere / no-folder split, with reasons and models for the last. Null without a project filter. */
    attribution: AttributionCoverage | null;
    /** Additive (#47): present only when a project-filtered report inferred at least one folder. */
    inferred?: InferredCoverage;
  };
}
