export type Source = "claude-code" | "ocx";
export interface Measurements {
  outcome: boolean;
  duration: boolean;
  ttft: boolean;
  retries: boolean;
  input: boolean;
  output: boolean;
  cacheRead: boolean;
  cacheWrite: boolean;
  usage: "logical" | "attempt-sum" | "missing";
}

export interface MeasurementSample { eligibleRequests: number; totalRequests: number }
export interface MeasurementCoverage {
  totalRequests: number;
  outcomes: MeasurementSample;
  duration: MeasurementSample;
  ttft: MeasurementSample;
  throughput: MeasurementSample;
  retries: MeasurementSample;
  input: MeasurementSample;
  context: MeasurementSample;
  cache: MeasurementSample;
  pricing: MeasurementSample;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface Summary {
  requests: number;
  ok: number;
  errors: number;
  cancelled: number;
  unobserved: number;
  measurementCoverage: MeasurementCoverage;
  successRate: number | null;
  tokens: TokenTotals;
  cost: number;
  pricedRequests: number;
  unpricedRequests: number;
  estimatedCostShare: number;
  latency: { p50: number | null; p95: number | null; p99: number | null; mean: number | null };
  ttft: { p50: number | null; p95: number | null; coverage: number };
  throughput: { p50: number | null; mean: number | null };
  cache: {
    readTokens: number;
    writeTokens: number;
    observedRequests: number;
    synthesizedRequests: number;
    unknownRequests: number;
    hitRate: number | null;
    savingsUsd: number;
  };
  waste: { failedRequests: number; failedTokens: number; failedCostUsd: number; cancelledTokens: number; cancelledCostUsd: number };
  metering: { reported: number; estimated: number; unreported: number; unsupported: number; other: number; coverage: number };
  retryOverhead: { tokens: number; requests: number };
  retries: { retriedRequests: number; sends: number; settledSends: number; unresolvedSends: number };
  firstRequestAt: number | null;
  lastRequestAt: number | null;
}

export interface SeriesBucket {
  ts: number;
  label: string;
  total: number;
  groups: Record<string, number>;
  requests: number;
}

export interface Series {
  bucket: "hour" | "day" | "week";
  metric: string;
  groupBy: string;
  groups: { name: string; total: number }[];
  buckets: SeriesBucket[];
}

export interface BreakdownRow {
  key: string;
  /** Tokens of priced requests only; the denominator of the blended prices. */
  pricedTokens: number;
  requests: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  cost: number;
  share: number;
  costShare: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  ttftP50: number | null;
  successRate: number | null;
  cacheHitRate: number | null;
  outputTokensPerSecond: number | null;
  costPer1kTokens: number | null;
  costPer1MTokens: number | null;
  firstSeen: number;
  lastSeen: number;
  unpricedRequests: number;
  pricedRequests: number;
  measurementCoverage: MeasurementCoverage;
}

export interface RequestRow {
  source: Source;
  protocol: string | null;
  measurements: Measurements;
  usageFromAttempts: boolean;
  usageStatus: string;
  cacheProvenance: string | null;
  cacheWriteTokens: number;
  rateIn: number | null;
  rateOut: number | null;
  rateCacheRead: number | null;
  rateCacheWrite: number | null;
  sends: number;
  attemptTokens: number;
  cwd: string | null;
  id: string;
  ts: number;
  provider: string;
  model: string;
  effort: string | null;
  status: number;
  outcome: "ok" | "error" | "cancelled" | "unobserved";
  durationMs: number;
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  priced: boolean;
  conversationId: string | null;
  errorCode: string | null;
  closeReason: string | null;
  routeKind: string | null;
  attempts: number;
  account: string | null;
}

export interface CostComposition {
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Tier or priority cost not placed in a class; 0 when rows carry the engine's own split. */
  adjustment: number;
  total: number;
  cacheSavingsUsd: number;
  unpricedRequests: number;
  unmeteredRequests: number;
}

export interface ConversationRow {
  id: string;
  /** Conversation ids are unique only within a source. */
  source: Source;
  requests: number;
  tokens: number;
  cost: number;
  pricedRequests: number;
  unpricedRequests: number;
  models: string[];
  providers: string[];
  startedAt: number;
  endedAt: number;
  spanMs: number;
  errors: number;
  cacheReadTokens: number;
  outputTokens: number;
  avgDurationMs: number;
  intensity: number;
  /** Where the session last ran, or null when it cannot be attributed. */
  project: string | null;
}

export interface QuotaWindowSnapshot {
  account: string;
  window: string;
  usedPercent: number;
  resetAtMs: number | null;
  updatedAt: number;
}

export interface QuotaView {
  windows: QuotaWindowSnapshot[];
  series: {
    account: string;
    window: string;
    points: { ts: number; usedPercent: number }[];
    baselineIncluded: boolean;
    sampleCount: number;
  }[];
  burn: {
    account: string;
    window: string;
    percentPerDay: number;
    projectedExhaustionAt: number | null;
    resetAtMs: number | null;
    usedPercent: number;
    willExhaustBeforeReset: boolean;
    status: "measured" | "insufficient";
    sampleCount: number;
  }[];
  updatedAt: number | null;
  window: { from: number | null; to: number | null };
  observed: { samples: number; first: number | null; last: number | null };
}

/** How a source/project selection applies to quota and the send ledger, which are opencodex account observations. */
export interface AccountScope {
  kind: "account";
  source: Source;
  available: boolean;
  requestedSources: Source[];
  /** Active filters (URL parameter names) this account-wide observation does not honour. */
  ignored: string[];
  note: string;
}

export interface QuotaResponse extends QuotaView {
  ok: boolean;
  range: string;
  scope: AccountScope;
  window: QuotaView["window"] & { label: string };
}

export interface MetaResponse {
  sources: Source[];
  sourceCapabilities: Record<Source, { outcomes: boolean; retries: boolean; timing: boolean; quota: boolean; cache: boolean; effort: boolean; agents: boolean }>;
  ok: boolean;
  ocxHome: string;
  timeZone: string;
  pricing: { available: boolean; modulePath: string | null; packageDir: string | null; detail: string };
  versions: { yald: string | null; opencodex: string | null };
  files: Record<string, { path: string; bytes: number; mtimeMs: number; lines?: number } | null>;
  parse: { malformedLines: number; durationMs: number };
  builtAt: number;
  revision: string;
  firstRequestAt: number | null;
  lastRequestAt: number | null;
  totals: { requests: number; tokens: number; cost: number };
  providers: string[];
  models: string[];
  /** Models most used first. */
  modelsByUse: string[];
  modelsByProvider: Record<string, string[]>;
  efforts: string[];
  routeKinds: string[];
  conversations: number;
  ledger: { byKind: Record<string, number>; settledTokens: number; updatedAt: number | null };
  quota: { windows: QuotaWindowSnapshot[]; updatedAt: number | null };
}

export interface OverviewResponse {
  ok: boolean;
  window: { from: number; to: number; bucket: "hour" | "day" | "week"; range: string; requests: number };
  summary: Summary;
  prior: Summary;
  deltas: Record<string, number | null>;
  sparkline: { tokens: number[]; cost: number[]; requests: number[] };
  series: Series;
  composition: CostComposition;
  topModels: BreakdownRow[];
  topProviders: BreakdownRow[];
  topEfforts: BreakdownRow[];
  topConversations: ConversationRow[];
  heatmap: { cells: { weekday: number; hour: number; value: number; requests: number }[]; max: number };
  context: { buckets: { name: string; value: number }[]; maxInput: number; p50Input: number | null; p95Input: number | null; eligibleRequests: number; totalRequests: number };
  quota: QuotaView;
  quotaScope: AccountScope;
  recent: RequestRow[];
}

export interface PerformanceResponse {
  measurementCoverage: MeasurementCoverage;
  ok: boolean;
  window: { from: number; to: number; bucket: "hour" | "day" | "week" };
  timeline: {
    bucket: string;
    points: {
      ts: number;
      label: string;
      requests: number;
      p50: number | null;
      p90: number | null;
      p95: number | null;
      ttftP50: number | null;
      ttftP95: number | null;
      throughputP50: number | null;
    }[];
  };
  histogram: {
    duration: { name: string; value: number }[];
    ttft: { name: string; value: number }[];
    throughput: { name: string; value: number }[];
  };
  percentiles: {
    duration: { p50: number | null; p90: number | null; p95: number | null; p99: number | null };
    ttft: { p50: number | null; p90: number | null; p95: number | null; p99: number | null; coverage: number };
    throughput: { p50: number | null; p10: number | null; mean: number | null };
  };
  byModel: BreakdownRow[];
  ttftVsOutput: { ttftMs: number; outputTokens: number; model: string; ts: number }[];
  slowest: RequestRow[];
  context: { buckets: { name: string; value: number }[]; maxInput: number; p50Input: number | null; p95Input: number | null; eligibleRequests: number; totalRequests: number };
}

export interface OutageEpisode {
  start: number;
  end: number;
  durationMs: number | null;
  size: number;
  share: number;
  statuses: { name: string; value: number; class: string }[];
  errorCodes: { name: string; value: number }[];
  dominantClass: string;
  providers: string[];
  models: string[];
  successesInside: number;
  clippedStart: boolean;
  ongoing: boolean;
  usage: { reportedRows: number; failedRows: number; tokens: number | null; costUsd: number | null };
}

export interface EpisodePersistence {
  afterError: { errors: number; total: number; rate: number | null };
  base: { errors: number; total: number; rate: number | null };
}

export interface OutageEpisodes {
  gapMs: number;
  episodes: OutageEpisode[];
  concentration: { episodes: number; errors: number; share: number }[];
  marks: { p50: number | null; p75: number | null };
  persistence: EpisodePersistence & { byProvider: (EpisodePersistence & { provider: string })[] };
  classMix: { name: string; value: number }[];
  coverage: { totalRequests: number; observedRequests: number; unobservedRequests: number; errors: number; cancelled: number };
}

export interface ReliabilityResponse {
  measurementCoverage: MeasurementCoverage;
  successRate: number | null;
  ok: boolean;
  window: { from: number; to: number };
  outcomes: { name: string; value: number }[];
  statuses: { name: string; value: number }[];
  errors: { name: string; value: number; models: number; lastSeen: number; tokens: number; cost: number }[];
  errorTimeline: { ts: number; label: string; ok: number; error: number; cancelled: number; unobserved: number }[];
  attempts: { name: string; value: number }[];
  failureByModel: { name: string; failures: number; requests: number; rate: number }[];
  recentFailures: RequestRow[];
  episodes: OutageEpisodes;
  waste: Summary["waste"];
  metering: Summary["metering"];
  retryOverhead: Summary["retryOverhead"];
}

export interface ModelsResponse {
  ok: boolean;
  window: { from: number; to: number };
  models: BreakdownRow[];
  providers: BreakdownRow[];
  efforts: BreakdownRow[];
  scatter: {
    model: string;
    requests: number;
    tokens: number;
    cost: number;
    costPer1kTokens: number | null;
    costPer1MTokens: number | null;
    ttftP50: number | null;
    p50DurationMs: number | null;
    outputTokensPerSecond: number | null;
    successRate: number | null;
  }[];
  effortMatrix: { effort: string; values: Record<string, number> }[];
}

export interface LedgerResponse {
  ok: boolean;
  scope: AccountScope;
  window: { from: number; to: number; bucket: string };
  byKind: Record<string, number>;
  settledTokens: number;
  updatedAt: number | null;
  buckets: { ts: number; label: string; settled: number; sends: number; tokens: number }[];
  distinctSends: number;
  largestSend: number;
  medianSend: number | null;
}

export interface ConversationsResponse {
  ok: boolean;
  window: { from: number; to: number };
  conversations: ConversationRow[];
  totals: { conversations: number; requests: number; unattributed: number; medianRequests: number | null; medianTokens: number | null };
}

/** Requests the project filter had to drop because their folder is unknown (the server's `coverage`). */
export interface ProjectCoverage {
  unattributedRows: number;
  unattributedTokens: number;
  attribution: {
    matched: { rows: number; tokens: number };
    outsideProjects: { rows: number; tokens: number };
    unattributed: { rows: number; tokens: number; reasons: { reason: "noConversationId" | "noRollout" | "other"; rows: number; tokens: number; models: { model: string; rows: number; tokens: number }[] }[] };
  };
}

export interface ProjectChoice {
  project: string;
  gitRoot: boolean;
  folders: string[];
  requests: number;
  tokens: number;
  cost: number;
  firstSeen: number | null;
  lastSeen: number | null;
}

export interface ProjectsResponse {
  ok: boolean;
  coverage?: ProjectCoverage;
  projects: ProjectChoice[];
}

export interface ScopeResponse {
  ok: boolean;
  window: { from: number; to: number; label: string };
  matched: { requests: number; tokens: number };
  windowTotal: { requests: number; tokens: number };
  sources: { source: Source; requests: number; tokens: number }[];
  /** Models with requests in the window under the other filters, most used first. */
  models: { model: string; requests: number }[];
  coverage?: ProjectCoverage;
  account: AccountScope;
}

export interface ConversationDetailResponse {
  ok: boolean;
  id: string;
  source: Source;
  coverage?: ProjectCoverage;
  scope: {
    window: { label: string } | null;
    filtersApplied: string[];
    matched: number;
    sessionTotal: number;
    excluded: { window: number; filters: number };
  };
  points: { ts: number; tokens: number; cumulative: number; model: string; outcome: string; cost: number; durationMs: number; ttftMs: number | null; contextTokens: number; contextEligible: boolean }[];
  summary: Summary;
  models: { name: string; value: number }[];
  requests: RequestRow[];
  anatomy: SessionAnatomy;
}

export interface AnatomyChain {
  key: string;
  kind: AgentKind;
  agentId: string | null;
  agentType: string | null;
  model: string | null;
  depth: number | null;
  parent: string | null;
  spawn: { ts: number; requestId: string } | null;
  firstAt: number;
  lastAt: number;
  requests: number;
  tokens: number;
  costUsd: number;
  unpricedRequests: number;
  startupCostUsd: number | null;
  firstRequestMissing: boolean;
  ticks: number[];
  context: { ts: number; tokens: number }[];
  contextEligible: number;
}

export interface AnatomyCompaction { ts: number; chain: string; trigger: string | null; preTokens: number | null; postTokens: number | null; durationMs: number | null }

export interface SessionAnatomy {
  split: boolean;
  note: string | null;
  chains: AnatomyChain[];
  compactions: AnatomyCompaction[];
  stats: {
    chains: number;
    subagents: number;
    maxDepth: number | null;
    subagentShare: { requests: number | null; tokens: number | null; cost: number | null } | null;
    startupCostUsd: number | null;
    startupsUnavailable: number;
    coverage: { labelled: number | null; priced: number | null; context: number | null };
  };
}

export interface CompositionPoint {
  ts: number;
  label: string;
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  requests: number;
}

export interface CachePoint {
  eligibleRequests: number;
  totalRequests: number;
  ts: number;
  label: string;
  hitRate: number | null;
  savingsUsd: number;
  cacheRead: number;
  input: number;
}

export interface CumulativePoint {
  ts: number;
  label: string;
  value: number;
  cumulative: number;
  requests: number;
}

export interface UsageResponse {
  ok: boolean;
  window: { from: number; to: number; bucket: "hour" | "day" | "week" };
  summary: Summary;
  composition: CompositionPoint[];
  cache: CachePoint[];
  series: Series;
  heatmap: { cells: { weekday: number; hour: number; value: number; requests: number }[]; max: number };
  context: { buckets: { name: string; value: number }[]; maxInput: number; p50Input: number | null; p95Input: number | null; eligibleRequests: number; totalRequests: number };
  byModel: BreakdownRow[];
  byProvider: BreakdownRow[];
  byEffort: BreakdownRow[];
  byRoute: BreakdownRow[];
}

export interface UsageHeatmapDatesResponse {
  ok: boolean;
  window: { from: number; to: number; range: string; timeZone: string };
  weekday: number;
  hour: number;
  metric: "tokens" | "requests";
  total: number;
  dates: { date: string; value: number; requests: number }[];
  totalDates: number;
  hasMore: boolean;
  limit: number;
  offset: number;
}

export interface CostResponse {
  ok: boolean;
  window: { from: number; to: number; bucket: "hour" | "day" | "week" };
  summary: Summary;
  composition: CostComposition;
  /** Tokens of priced requests: the denominator of a blended price. */
  pricedTokens: number;
  series: Series;
  cumulative: CumulativePoint[];
  cache: CachePoint[];
  byModel: BreakdownRow[];
  byProvider: BreakdownRow[];
  byEffort: BreakdownRow[];
  topConversations: ConversationRow[];
  daily: CumulativePoint[];
}

/** Project Radar (L02). Fixed windows and server-resolved group identities also scope evidence. */
export interface RadarWindow {
  from: number;
  to: number;
  tz: string;
  label: string;
}
export interface RadarCohort {
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
export interface RadarEvidence {
  selector: {
    version: 1;
    window: RadarWindow;
    cohort: RadarCohort;
    selection: { kind: "scope" } | { kind: "project"; project: string }
      | { kind: "session"; source: Source; conversationId: string } | { kind: "unnamed"; source?: Source };
    eligibility: "all" | "cache" | "context";
  };
  href: string;
}
export interface RadarTotals {
  requests: number;
  tokens: number;
  /** USD, unrounded priced-row sum. Zero without priced requests is unavailable. */
  pricedCostUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
}
export interface RadarReason {
  reason: "noConversationId" | "noRollout" | "other";
  rows: number;
  tokens: number;
  models: { model: string; rows: number; tokens: number }[];
}
export interface RadarPeriod {
  totals: RadarTotals;
  coverage: {
    totalRequests: number;
    eligibleRequests: number;
    pricing: MeasurementSample;
    attribution: MeasurementSample;
    measurements: MeasurementCoverage;
    unattributedReasons: RadarReason[];
    /** Scope-level F03 exclusions only; null in exact project periods. Outside strict totals. */
    projectExclusions: {
      unattributedRows: number;
      unattributedTokens: number;
      attribution: {
        matched: { rows: number; tokens: number };
        outsideProjects: { rows: number; tokens: number };
        unattributed: { rows: number; tokens: number; reasons: RadarReason[] };
      };
    } | null;
  };
  daily: (RadarTotals & { ts: number; date: string; from: number; to: number })[];
  activeDays: number;
  sources: (RadarTotals & { source: Source })[];
  models: (RadarTotals & { source: Source; provider: string; model: string })[];
  evidence: RadarEvidence;
}
export interface RadarChange {
  state: "compared" | "new" | "insufficient";
  absoluteChange: number | null;
  /** Fraction; -0.5 = 50% lower. Never infinite. */
  relativeChange: number | null;
}
export interface RadarComparison {
  requests: RadarChange;
  tokens: RadarChange;
  pricedCostUsd: RadarChange;
}
export interface ProjectRadarResponse {
  ok: true;
  window: RadarWindow & { fromIso: string; toIso: string; halfOpen: true };
  priorWindow: RadarWindow & { fromIso: string; toIso: string; halfOpen: true };
  cohort: RadarCohort;
  pricingBasis: "currently-loaded-api-list-price-equivalents";
  history: {
    basis: "earliest-loaded-request";
    firstLoadedAt: number | null;
    completeness: "unknown";
    current: { startsBeforeLoadedHistory: boolean; hasLoadedHistory: boolean };
    prior: { startsBeforeLoadedHistory: boolean; hasLoadedHistory: boolean };
    note: string;
  };
  current: RadarPeriod;
  prior: RadarPeriod;
  comparison: RadarComparison;
  projects: {
    project: string;
    gitRoot: boolean;
    folders: string[];
    current: RadarPeriod;
    prior: RadarPeriod;
    comparison: RadarComparison;
  }[];
}

export type { ContextChain, ContextReplayResponse, ContextSession, ContextObservation, ContextEvidence, ContextExclusion } from "./labs/context-types";

/** Resolved bounds carried by Labs findings and their evidence intents (epoch milliseconds). */
export interface AnalysisWindow {
  from: number;
  to: number;
  tz: string;
  label: string;
}

export interface WindowEcho extends AnalysisWindow {
  fromIso: string;
  toIso: string;
  halfOpen: true;
  input: { from?: string; to?: string; last?: string; range?: string };
}

export interface AnalysisCohort {
  sources: Source[];
  projects: string[];
  providers: string[];
  models: string[];
  efforts: string[];
  statuses: RequestRow["outcome"][];
  routeKinds: string[];
  conversationId: string | null;
  search: string;
}

export type EvidenceSelection =
  | { kind: "scope" }
  | { kind: "project"; project: string }
  | { kind: "session"; source: Source; conversationId: string }
  | { kind: "unnamed"; source?: Source };

export interface EvidenceSelector {
  version: 1;
  window: AnalysisWindow;
  cohort: AnalysisCohort;
  selection: EvidenceSelection;
  eligibility: "all" | "cache" | "context";
}

export type CacheExclusion =
  | "unpriced" | "attempt-sum" | "usage-estimated" | "input-missing" | "cache-unmeasured"
  | "cache-synthesized" | "cache-unknown" | "economics-unavailable" | "accounting-mismatch" | "rate-unavailable";

/** Money and token fields include eligible rows only; request counts include all selected rows. */
export interface CacheEconomicsTotals {
  totalRequests: number;
  eligibleRequests: number;
  excluded: Record<CacheExclusion, number>;
  readTokens: number;
  writeTokens: number;
  /** USD rounded to six decimals; net = round6(readDiscountUsd - writePremiumUsd). */
  readDiscountUsd: number;
  writePremiumUsd: number;
  netUsd: number;
  actualUsd: number;
  baselineUsd: number;
  direction: "benefit" | "cost" | "even" | "insufficient";
  longContextRequests: number;
  confirmedTierRequests: number;
  requestedTierOnlyRequests: number;
  priorityRequests: number;
  lowerBoundRequests: number;
  derivedRateRequests: number;
  explicitFreeRequests: number;
  /** First/last selected row, including excluded rows; null for an empty group. */
  firstTs: number | null;
  lastTs: number | null;
  evidence: { selector: EvidenceSelector; href: string };
}

export interface CacheEconomicsSession extends CacheEconomicsTotals {
  /** JSON.stringify([source, conversationId]); never an id for an unnamed row. */
  key: string;
  source: Source;
  conversationId: string;
}

export interface CacheEconomicsResponse {
  ok: true;
  analysis: "cache-economics";
  version: 1;
  window: WindowEcho;
  scope: { window: Omit<WindowEcho, "input">; cohort: AnalysisCohort };
  coverage?: ProjectCoverage;
  precisionDp: 6;
  currency: "USD";
  basis: "api-list-price-equivalent";
  /** Engine availability; eligibleRequests still determines whether a comparison is supported. */
  pricing: { available: boolean; detail: string };
  totals: CacheEconomicsTotals;
  /** Sorted by absolute net descending, then source and conversationId. */
  sessions: CacheEconomicsSession[];
  sessionCount: number;
  sessionsTruncated: boolean;
  unnamed: CacheEconomicsTotals;
  notes: string[];
}

export interface ContextSpread {
  n: number;
  mean: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}

export interface ContextModelRow extends ContextSpread {
  /** Null on the folded "Other" row. */
  source: Source | null;
  model: string | null;
  totalRequests: number;
  pricedRequests: number;
  bandCounts: number[];
  bandShares: number[];
}

export interface ContextThresholdRow {
  at: number | null;
  label: string;
  requests: number;
  requestShare: number | null;
  pricedRequests: number;
  cost: number | null;
  costShare: number | null;
}

export interface ContextTaxRow {
  id: string;
  label: string;
  min: number;
  max: number | null;
  requests: number;
  requestShare: number | null;
  cost: number | null;
  costShare: number | null;
  pricedRequests: number;
  costPerPricedRequest: number | null;
  ttftP50: number | null;
  ttftMeasured: number;
  cancelRate: number | null;
  outcomesObserved: number;
  cancelled: number;
  belowMinimum: boolean;
  topModels: { source: Source; model: string; share: number }[];
}

export interface ContextResponse {
  ok: boolean;
  window: { from: number; to: number; bucket: "hour" | "day" | "week"; label: string };
  coverage?: ProjectCoverage;
  bands: { id: string; label: string; min: number; max: number | null }[];
  minimums: { box: number; p90: number; p99: number; band: number };
  eligibility: {
    totalRequests: number;
    eligibleRequests: number;
    excludedRequests: number;
    pricedEligibleRequests: number;
    unpricedEligibleRequests: number;
    unnamedRequests: number;
  };
  overall: ContextSpread;
  bySource: (ContextSpread & { source: Source })[];
  models: ContextModelRow[];
  modelsOmitted: number;
  box: ContextModelRow[];
  modelBands: ContextModelRow[];
  thresholds: ContextThresholdRow[];
  tax: ContextTaxRow[];
  sources: { source: Source; totalRequests: number; eligibleRequests: number; ttftMeasured: number; outcomesObserved: number }[];
  timeline: {
    bucket: "hour" | "day" | "week";
    buckets: { ts: number; label: string }[];
    series: { source: Source; n: number[]; p50: (number | null)[]; p90: (number | null)[] }[];
  };
  growth: {
    sessions: number;
    ranked: number;
    unranked: number;
    noRatio: number;
    clippedRanked: number;
    medianRatio: number | null;
    histogram: { name: string; value: number }[];
    minEligible: number;
  };
  histogram: { buckets: { name: string; value: number }[]; maxInput: number; p50Input: number | null; p95Input: number | null; eligibleRequests: number; totalRequests: number };
}

export type PriceTierId = "economy" | "standard" | "premium";
export type CostClassId = "freshInput" | "cacheRead" | "cacheWrite" | "output";
export interface ClassCostTotals {
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Of which, inside output: an attribution in proportion to reasoning tokens. */
  reasoning: number;
  adjustment: number;
}
export interface SpendShare { sessions: number; cost: number; share: number }

export interface SpendStructureResponse {
  ok: boolean;
  window: { from: number; to: number; bucket: "hour" | "day" | "week"; label: string };
  coverage?: ProjectCoverage;
  pricing: { totalRequests: number; pricedRequests: number; unpricedRequests: number; pricedTokens: number; unpricedTokens: number; cost: number };
  concentration: {
    sessions: number;
    partlyPricedSessions: number;
    unpricedSessions: number;
    clippedSessions: number;
    noSessionId: { requests: number; pricedRequests: number; cost: number | null };
    totalCost: number | null;
    minimums: { top1pct: number; top5pct: number; top10Sessions: number; gini: number };
    top1pct: SpendShare | null;
    top5pct: SpendShare | null;
    top10Sessions: SpendShare | null;
    gini: number | null;
    curve: { x: number; y: number }[];
  };
  tiers: {
    definitions: { id: PriceTierId; label: string; minRateIn: number; maxRateIn: number | null }[];
    models: Record<PriceTierId, { model: string; requests: number }[]>;
    unclassifiedRequests: number;
  };
  series: {
    bucket: "hour" | "day" | "week";
    buckets: {
      ts: number;
      label: string;
      requests: number;
      pricedRequests: number;
      pricedTokens: number;
      cost: number | null;
      blendedPer1M: number | null;
      tiers: Record<PriceTierId, { requests: number; tokens: number; blendedPer1M: number | null; requestShare: number | null; tokenShare: number | null }>;
    }[];
  };
  classMix: {
    source: Source;
    pricedRequests: number;
    tokens: { freshInput: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number };
    cost: ClassCostTotals;
    totalCost: number;
    tokenShare: Record<CostClassId, number | null>;
    costShare: Record<CostClassId | "adjustment", number | null>;
    buckets: { ts: number; label: string; cost: ClassCostTotals; total: number; share: Record<CostClassId | "adjustment", number | null> }[];
  }[];
}

/** Spend spikes (#106). Mirrors server/src/labs/spend.ts; the browser only renders what the server computed. */
export type SpendDayState = "spike" | "normal" | "insufficient" | "partial" | "no-priced";
export type SpendCut = "project" | "model" | "tokenClass" | "session";
export interface SpendRule {
  id: string; baselineActiveDays: number; minBaselineActiveDays: number; spikeMultiple: number;
  activeDay: string; baseline: string; spike: string; insufficient: string; decomposition: string; order: readonly string[];
}
export interface SpendDay {
  ts: number; date: string; dayStart: number; dayEnd: number; from: number; to: number; hours: number;
  requests: number; pricedRequests: number; unpricedRequests: number; tokens: number; pricedCostUsd: number | null;
  state: SpendDayState; partialReason: "in-progress" | "window-edge" | null; edge: boolean; insufficientReason: "baseline-days" | "zero-baseline" | null;
  baseline: { activeDays: number; medianUsd: number | null; thresholdUsd: number | null; ratio: number | null; firstDate: string | null; lastDate: string | null; pricedRequests: number; totalRequests: number };
}
export interface SpendGroup {
  key: string; label: string; dayCostUsd: number; baselineMeanUsd: number; changeUsd: number; isNew: boolean;
  evidence?: { selector: unknown; priorSelector: unknown; href: string };
}
export interface SpendOther { groups: number; newGroups: number; dayCostUsd: number; baselineMeanUsd: number; changeUsd: number }
export interface SpendCutData { groups: SpendGroup[]; new: SpendGroup[]; other: SpendOther | null }
export interface SpendDecomposition {
  order: readonly string[]; baselineDays: number; keptBaselineDays: number; excludedBaselineDates: string[];
  dayCostUsd: number; baselineMedianUsd: number; baselineMeanUsd: number; changeUsd: number;
  unpriced: { dayRequests: number; dayTokens: number; baselineMeanRequests: number; baselineMeanTokens: number; requestChange: number; tokenChange: number };
  attribution: { dayRequests: number; attributedRequests: number; dayPricedCostUsd: number; attributedPricedCostUsd: number; baselineRequests: number; baselineAttributedRequests: number };
  cuts: Record<SpendCut, SpendCutData>;
  drilldown: {
    order: readonly string[];
    projects: (SpendGroup & { models: (SpendGroup & { tokenClasses: SpendGroup[] })[]; otherModels: SpendOther | null })[];
    otherProjects: SpendOther | null;
  };
}
export interface SpendChangesResponse {
  ok: true; analysis: "spend-changes"; version: 1;
  window: RadarWindow & { fromIso: string; toIso: string; halfOpen: true };
  cohort: RadarCohort;
  rule: SpendRule;
  pricingBasis: "currently-loaded-api-list-price-equivalents";
  history: { basis: "earliest-loaded-request"; firstLoadedAt: number | null; completeness: "unknown"; note: string };
  coverage: {
    windowDays: number; activeDays: number; spikeDays: number; normalDays: number; insufficientDays: number; partialDays: number;
    totalRequests: number; pricedRequests: number; unpricedRequests: number; pricedCostUsd: number | null; spikeCostUsd: number | null; spikeCostShare: number | null;
    attributedRequests: number; projectCoverage: unknown;
  };
  days: SpendDay[];
  selected: null | {
    day: SpendDay; decomposition: SpendDecomposition | null;
    baselineDays: { date: string; pricedCostUsd: number; pricedRequests: number; requests: number }[];
    evidence: { selector: unknown; priorSelector: unknown; href: string } | null; limitations: string[];
  };
}

export interface ArchetypeRow {
  name: "poke" | "quick" | "deep" | "marathon";
  sessions: number;
  requests: number;
  costUsd: number;
  sessionShare: number | null;
  requestShare: number | null;
  costShare: number | null;
  medianRequests: number | null;
  medianSpanMs: number | null;
  unpricedRequests: number;
  clippedSessions: number;
}

export interface WorkingStyleResponse {
  ok: boolean;
  archetypes: ArchetypeRow[];
  totals: { sessions: number; requests: number; requestsWithoutSession: number; costUsd: number; unpricedRequests: number };
  concurrency: {
    binMinutes: number;
    days: { date: string; peak: number }[];
    medianPeak: number | null;
    p90Peak: number | null;
    maxPeak: number;
    busiestDay: string | null;
    busiestSeries: { ts: number; sessions: number }[];
    peakHistogram: { peak: number; days: number }[];
  };
  activity: { days: { date: string; requests: number }[]; activeDays: number; windowDays: number; longestStreak: number; currentStreak: number };
  hours: { hour: number; requests: number }[];
  night: { requests: number; share: number | null };
}

export interface AgentTally { requests: number; tokens: number; inputTokens: number; costUsd: number; pricedRequests: number }
export type AgentKind = "main" | "subagent" | "unlabelled";
export type AgentSplit = Record<AgentKind, AgentTally>;

export interface SubagentsResponse {
  ok: boolean;
  window: { bucket: string };
  claude: {
    requests: number;
    labelledRequests: number;
    labelledShare: number | null;
    shares: (AgentTally & { kind: AgentKind; requestShare: number | null; tokenShare: number | null; inputShare: number | null; costShare: number | null; pricedShare: number | null })[];
    overTime: { ts: number; label: string; split: AgentSplit; labelledShare: number | null }[];
    fanOut: { sessions: number; unlabelledSessions: number; withSubagents: number; withSubagentsShare: number | null; median: number | null; p90: number | null; max: number | null; bins: { label: string; sessions: number }[]; topSessions: { id: string; source: "claude-code"; project: string | null; subagents: number }[] };
    byType: { type: string; spawns: number; requests: number; tokens: number; costUsd: number; costShare: number | null; medianRequestsPerSpawn: number | null; model: string | null; startupCostUsd: number }[];
    byDepth: (AgentTally & { depth: string; requestShare: number | null; costShare: number | null })[];
    startup: { spawns: number; unavailableSpawns: number; unpricedSpawns: number; cacheWriteTokens: number; costUsd: number; medianCostUsd: number | null; shortSpawnShare: number | null; points: { requests: number; costShare: number }[]; pointsOmitted: number };
    byProject: { key: string; split: AgentSplit; unattributed: boolean }[];
    byModel: { key: string; split: AgentSplit }[];
  };
  codex: { requests: number; tokens: number; costUsd: number; rootThread: AgentTally; subagentThread: AgentTally & { threads: number } };
}

export interface RecapNote { text: string; n: number; identifying?: boolean; money?: boolean }

export interface RecapResponse {
  ok: boolean;
  report: { meta: { window: { label: string } }; kpis: { requests: number }; workingStyle?: { notes: RecapNote[] } };
}
