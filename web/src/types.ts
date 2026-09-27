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
}

export interface RequestRow {
  id: string;
  ts: number;
  provider: string;
  model: string;
  effort: string | null;
  status: number;
  outcome: "ok" | "error" | "cancelled";
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
  total: number;
  cacheSavingsUsd: number;
  unpricedRequests: number;
  unmeteredRequests: number;
}

export interface ConversationRow {
  id: string;
  requests: number;
  tokens: number;
  cost: number;
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

export interface QuotaResponse extends QuotaView {
  ok: boolean;
  range: string;
}

export interface MetaResponse {
  ok: boolean;
  ocxHome: string;
  timeZone: string;
  pricing: { available: boolean; modulePath: string | null; packageDir: string | null; detail: string };
  files: Record<string, { path: string; bytes: number; mtimeMs: number; lines?: number } | null>;
  parse: { malformedLines: number; durationMs: number };
  builtAt: number;
  revision: string;
  firstRequestAt: number | null;
  lastRequestAt: number | null;
  totals: { requests: number; tokens: number; cost: number };
  providers: string[];
  models: string[];
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
  context: { buckets: { name: string; value: number }[]; maxInput: number; p50Input: number | null; p95Input: number | null };
  quota: QuotaView;
  recent: RequestRow[];
}

export interface PerformanceResponse {
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
  context: { buckets: { name: string; value: number }[]; maxInput: number; p50Input: number | null; p95Input: number | null };
}

export interface ReliabilityResponse {
  ok: boolean;
  window: { from: number; to: number };
  outcomes: { name: string; value: number }[];
  statuses: { name: string; value: number }[];
  errors: { name: string; value: number; models: number; lastSeen: number; tokens: number; cost: number }[];
  errorTimeline: { ts: number; label: string; ok: number; error: number; cancelled: number }[];
  attempts: { name: string; value: number }[];
  failureByModel: { name: string; failures: number; requests: number; rate: number }[];
  recentFailures: RequestRow[];
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

export interface ConversationDetailResponse {
  ok: boolean;
  id: string;
  points: { ts: number; tokens: number; cumulative: number; model: string; outcome: string; cost: number; durationMs: number; ttftMs: number | null; contextTokens: number }[];
  summary: Summary;
  models: { name: string; value: number }[];
  requests: RequestRow[];
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
  context: { buckets: { name: string; value: number }[]; maxInput: number; p50Input: number | null; p95Input: number | null };
  byModel: BreakdownRow[];
  byProvider: BreakdownRow[];
  byEffort: BreakdownRow[];
  byRoute: BreakdownRow[];
}

export interface CostResponse {
  ok: boolean;
  window: { from: number; to: number; bucket: "hour" | "day" | "week" };
  summary: Summary;
  composition: CostComposition;
  series: Series;
  cumulative: CumulativePoint[];
  cache: CachePoint[];
  byModel: BreakdownRow[];
  byProvider: BreakdownRow[];
  byEffort: BreakdownRow[];
  topConversations: ConversationRow[];
  daily: CumulativePoint[];
}
