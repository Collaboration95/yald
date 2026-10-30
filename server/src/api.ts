import { Hono } from "hono";
import { DEMO, requestNow } from "./demo/mode";
import { publicRow } from "./publicRow";
import { EvidenceIntentError, parseCaseIntent } from "./labs/evidence-intent";
import { buildEvidenceCase } from "./labs/evidence";
import { buildProjectRadar } from "./labs/projects";
import { buildSpendChanges } from "./labs/spend";
import { createHash } from "node:crypto";
import { opencodexVersion, yaldVersion } from "./versions";
import {
  breakdown,
  bucketer,
  bucketLabel,
  bucketStarts,
  buildSeries,
  cacheTimeline,
  compositionSeries,
  cumulativeSeries,
  contextPressure,
  conversationTimeline,
  allConversations,
  slowestRequests,
  conversations,
  costComposition,
  filterRows,
  heatmap,
  heatmapDateBreakdown,
  latencyTimeline,
  measurementCoverage,
  outcome,
  percentile,
  percentileOfSorted,
  projectCoverage,
  pickBucket,
  quotaView,
  reliability,
  round,
  sortedSample,
  sparkline,
  summarize,
  topN,
  type Bucket,
  type ConversationSort,
  type Metric,
  type RowFilter,
} from "./analytics";
import { ALL_SOURCES, parseSource, SOURCE_CAPABILITIES, sourceOf, throughputEligible } from "./report/source";
import { OCX_HOME, PATHS, TIME_ZONE } from "./env";
import { buildContextReplay } from "./labs/context";
import { claudeSessionTitles } from "./claude/transcripts";
import { contextBreakdown } from "./contextView";
import { spendStructure } from "./spendStructure";
import { buildCacheEconomics } from "./labs/cache";
import { pricingGeneration, pricingStatus } from "./ocx/pricing";
import { getDataset, type Dataset, type RequestRow } from "./ocx/store";
import { projectBreakdown, projectMatcher } from "./projects";
import { accountScope, EMPTY_QUOTA, lookupSession, scopeSummary } from "./dashboardScope";
import { buildReport } from "./report/build";
import { liveReportContext } from "./report/context";
import { renderReportHtml } from "./report/render";
import { buildReportSpec, readSources, ReportSpecError } from "./report/spec";
import { isoInZone, parsePhases, parseWindow, windowLabel, WindowError, type TimeWindow } from "./time/window";

const METRICS: Metric[] = ["tokens", "cost", "requests", "outputTokens", "inputTokens", "cacheReadTokens", "reasoningTokens"];

function listParam(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map(part => part.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function numberParam(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/** The window a query asks for: `from`/`to`/`last`/`range` read in `tz` (default: the server zone). Throws WindowError. */
function timeWindow(query: Record<string, string | undefined>, first: number, now: number): TimeWindow {
  return parseWindow({ from: query.from, to: query.to, last: query.last, range: query.range, tz: query.tz ?? TIME_ZONE }, { now, first, defaultRange: "30d" });
}

/** What every route reports as `window`, so a client can always show the window it got. */
function windowEcho(window: TimeWindow) {
  return {
    from: window.from,
    to: window.to,
    tz: window.tz,
    label: window.label,
    fromIso: isoInZone(window.from, window.tz),
    toIso: isoInZone(window.to, window.tz),
    halfOpen: true as const,
    input: window.input,
  };
}

/**
 * True when the window cannot move with the clock, so an unchanged dataset may answer
 * 304 while time passes. Only exact instants (epoch or calendar times, which start
 * with a digit) pin a window; now, today and -8h move with it.
 */
function clockFree(query: Record<string, string | undefined>): boolean {
  const value = (key: string) => query[key]?.trim() || undefined;
  const exact = (text: string | undefined) => text !== undefined && /^\d/.test(text);
  const [from, to] = [value("from"), value("to")];
  if (from !== undefined && !exact(from)) return false;
  if (exact(to)) return true;
  return exact(from) && (to === undefined ? value("last") !== undefined : to.startsWith("+"));
}

interface ParsedQuery {
  filter: RowFilter;
  range: string;
  bucket: Bucket;
  from: number;
  to: number;
  tz: string;
  window: ReturnType<typeof windowEcho>;
  metric: Metric;
  groupBy: string;
}

function parseQuery(query: Record<string, string | undefined>, dataset: Dataset, now: number): ParsedQuery {
  const first = dataset.rows[0]?.ts ?? now;
  const window = timeWindow(query, first, now);
  const bucketParam = query.bucket;
  const autoBucket: Bucket = window.input.range === "all" ? "day" : pickBucket(window.to - window.from);
  const bucket: Bucket = bucketParam === "hour" || bucketParam === "day" || bucketParam === "week" ? bucketParam : autoBucket;
  const metricParam = query.metric as Metric | undefined;
  const metric: Metric = metricParam && METRICS.includes(metricParam) ? metricParam : "tokens";
  const filter: RowFilter = {
    from: window.from,
    to: window.to,
    providers: listParam(query.providers),
    sources: readSources(query.sources),
    models: listParam(query.models),
    efforts: listParam(query.efforts),
    routeKinds: listParam(query.routeKinds),
    statuses: listParam(query.statuses) as RowFilter["statuses"],
    conversationId: query.conversationId,
    search: query.search,
    projects: listParam(query.projects),
    agents: listParam(query.agents) as RowFilter["agents"],
    agentTypes: listParam(query.agentTypes),
  };
  return {
    filter, range: query.range ?? "30d", bucket, from: window.from, to: window.to, tz: window.tz, window: windowEcho(window),
    metric, groupBy: query.groupBy ?? "model",
  };
}

/** The equally long window just before: [from - span, from). */
function previousWindow(filter: RowFilter, from: number, to: number): RowFilter {
  const span = Math.max(1, to - from);
  return { ...filter, from: from - span, to: from };
}

/** Any response filtered by project says how many otherwise-matching rows had no known folder. */
function coverageField(rows: RequestRow[], filter: RowFilter) {
  const coverage = projectCoverage(rows, filter);
  return coverage ? { coverage } : {};
}

function delta(current: number, prior: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return null;
  if (prior === 0) return current === 0 ? 0 : null;
  return round((current - prior) / prior, 4);
}

const newestFirst = (a: RequestRow, b: RequestRow) => b.ts - a.ts;

/** `Server-Timing` durations in milliseconds, and whether the body came from the memo; never data. */
function serverTiming(build: number, compute: number, memoHit = false): string {
  return `build;dur=${build.toFixed(1)}, compute;dur=${compute.toFixed(1)}${memoHit ? ', memo;desc="hit"' : ""}`;
}

/** Rolling windows end on a clock rounded down to this quantum (docs/api.md). */
export const CLOCK_QUANTUM_MS = 10_000;

function clockQuantum(): number {
  const configured = Number(process.env.YALD_CLOCK_QUANTUM_MS);
  return process.env.YALD_CLOCK_QUANTUM_MS?.trim() && Number.isSafeInteger(configured) && configured >= 1 ? configured : CLOCK_QUANTUM_MS;
}

/**
 * The time analytics windows are resolved against: the demo's fixed clock, else the wall
 * clock rounded down to the quantum. Requests within one quantum therefore share one window,
 * one body and one ETag, at the cost of `window.to` lagging the wall clock by under a quantum.
 */
function windowClock(): number {
  if (DEMO?.now != null) return DEMO.now;
  const quantum = clockQuantum();
  const wall = requestNow();
  return wall - (((wall % quantum) + quantum) % quantum);
}

/** The query as parsed: parameters sorted by name (repeats keep their order), so order does not split memo entries. */
function canonicalQuery(url: string): string {
  const params = [...new URL(url).searchParams];
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new URLSearchParams(params).toString();
}

/**
 * Routes whose body is not a function of (dataset, pricing, canonical query, clock): project
 * views, Labs findings and reports resolve git roots on disk, the report stamps its request
 * time, export bodies are too large to keep, refresh rebuilds, and session titles are always
 * answered `no-store`, which a memo hit would skip.
 */
const UNMEMOIZED = new Set(["/api/dataset/refresh", "/api/session-titles", "/api/report", "/api/projects", "/api/labs/projects", "/api/labs/spend", "/api/labs/evidence", "/api/export"]);

/**
 * Serialized response bodies for one dataset and pricing generation, bounded by entry count
 * and total size; the least recently used go first. A new dataset (any rebuild: append,
 * Refresh, price change) or pricing generation drops every entry.
 */
class ResponseMemo {
  private dataset: Dataset | null = null;
  private generation: string | null = null;
  private readonly entries = new Map<string, { body: string; type: string }>();
  private size = 0;

  constructor(private readonly maxEntries: number, private readonly maxSize: number) {}

  private own(dataset: Dataset): void {
    const generation = pricingGeneration();
    if (this.dataset === dataset && this.generation === generation) return;
    this.dataset = dataset;
    this.generation = generation;
    this.entries.clear();
    this.size = 0;
  }

  get(dataset: Dataset, key: string): { body: string; type: string } | undefined {
    this.own(dataset);
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(dataset: Dataset, key: string, body: string, type: string): void {
    // Computed from an older dataset than the current owner: not this memo's to keep.
    if (this.dataset !== dataset || this.generation !== pricingGeneration() || body.length > this.maxSize / 4) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.size -= previous.body.length;
    }
    this.entries.set(key, { body, type });
    this.size += body.length;
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.size <= this.maxSize) break;
      this.entries.delete(oldest);
      this.size -= entry.body.length;
    }
  }
}

/** 64 bodies or 32 M characters of JSON, whichever comes first. */
const responses = new ResponseMemo(64, 32_000_000);


function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(","), ...rows.map(row => headers.map(header => escape(row[header])).join(","))].join("\n");
}

export const api = new Hono<{ Variables: { dataset: Dataset; now: number } }>();

api.onError((error, c) => {
  if (error instanceof WindowError || error instanceof ReportSpecError || error instanceof EvidenceIntentError) {
    return c.json({ ok: false, error: { code: error.code, param: error.param, message: error.message } }, 400);
  }
  console.error(error);
  return c.text("Internal Server Error", 500);
});

api.use("/api/*", async (c, next) => {
  const started = performance.now();
  if (c.req.path === "/api/dataset/refresh") {
    // The forced rebuild is the whole of this route's work.
    await next();
    c.header("Server-Timing", serverTiming(performance.now() - started, 0));
    return;
  }
  const dataset = await getDataset();
  const built = performance.now();
  const timing = (memoHit = false) => serverTiming(built - started, performance.now() - built, memoHit);
  const now = windowClock();
  c.set("dataset", dataset);
  c.set("now", now);
  // A conversation detail without window parameters is all-history, so only its dataset revision matters.
  const unwindowed = !["from", "to", "last", "range"].some(key => c.req.query(key)?.trim());
  const pointInTime = c.req.path === "/api/health" || c.req.path === "/api/meta"
    || (c.req.path.startsWith("/api/conversations/") && unwindowed);
  // An unchanged ledger does not mean an unchanged rolling time window. Prices can change
  // without a new revision (a forced rebuild re-prices the same rows), so they are keyed too.
  const clockKey = pointInTime || clockFree(c.req.query()) ? "" : now;
  const etag = `W/"${createHash("sha256").update(`${dataset.revision}:${pricingGeneration()}:${c.req.url}:${clockKey}`).digest("hex").slice(0, 24)}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "no-cache");
  // Project views and reports contain derived roots, which can change without
  // a ledger revision. These routes hash the resolved payload after validation.
  if (c.req.path !== "/api/report" && c.req.path !== "/api/projects" && c.req.path !== "/api/labs/projects" && c.req.path !== "/api/labs/spend" && c.req.path !== "/api/labs/evidence" && c.req.header("if-none-match") === etag) {
    c.header("Server-Timing", timing());
    return c.body(null, 304);
  }
  // The memo key holds everything a memoized body depends on besides the dataset and pricing it
  // is bound to. The clock is always part of it: even a pinned window can read it (range=all on an empty dataset).
  const memoKey = UNMEMOIZED.has(c.req.path) ? null : `${c.req.path}?${canonicalQuery(c.req.url)}|${now}`;
  const hit = memoKey ? responses.get(dataset, memoKey) : undefined;
  if (hit) {
    c.header("Content-Type", hit.type);
    c.header("Server-Timing", timing(true));
    return c.body(hit.body, 200);
  }
  await next();
  const type = c.res.headers.get("content-type") ?? "";
  if (memoKey && c.res.status === 200 && type.startsWith("application/json")) responses.set(dataset, memoKey, await c.res.clone().text(), type);
  c.header("Server-Timing", timing());
});

api.get("/api/health", async c => {
  const dataset = c.get("dataset");
  return c.json({
    ok: true,
    revision: dataset.revision,
    rows: dataset.rows.length,
    builtAt: dataset.builtAt,
    parseMs: dataset.parse.durationMs,
    malformedLines: dataset.parse.malformedLines,
    pricing: pricingStatus(),
  });
});

/** The /api/meta payload walks every row; it is built once per dataset and pricing generation. */
const metaPayloads = new WeakMap<Dataset, { generation: string | null; payload: Record<string, unknown> }>();

api.get("/api/meta", async c => {
  const dataset = c.get("dataset");
  const generation = pricingGeneration();
  const known = metaPayloads.get(dataset);
  if (known?.generation === generation) return c.json(known.payload);
  const payload = metaPayload(dataset);
  metaPayloads.set(dataset, { generation, payload });
  return c.json(payload);
});

function metaPayload(dataset: Dataset): Record<string, unknown> {
  const providers = new Set<string>();
  const models = new Set<string>();
  const efforts = new Set<string>();
  const routeKinds = new Set<string>();
  let tokens = 0;
  let cost = 0;
  const modelRequests = new Map<string, number>();
  for (const row of dataset.rows) {
    modelRequests.set(row.model, (modelRequests.get(row.model) ?? 0) + 1);
    providers.add(row.provider);
    models.add(row.model);
    efforts.add(row.effort ?? "unknown");
    routeKinds.add(row.routeKind ?? "unrouted");
    tokens += row.totalTokens;
    cost += row.cost;
  }
  const modelsByProvider = new Map<string, string[]>();
  for (const row of dataset.rows) {
    const list = modelsByProvider.get(row.provider) ?? [];
    if (!list.includes(row.model)) list.push(row.model);
    modelsByProvider.set(row.provider, list);
  }
  return {
    ok: true,
    ocxHome: OCX_HOME,
    ...(DEMO ? { demo: DEMO } : {}),
    timeZone: TIME_ZONE,
    pricing: pricingStatus(),
    versions: { yald: yaldVersion(), opencodex: opencodexVersion(pricingStatus().packageDir) },
    files: dataset.files,
    parse: dataset.parse,
    builtAt: dataset.builtAt,
    revision: dataset.revision,
    firstRequestAt: dataset.rows[0]?.ts ?? null,
    lastRequestAt: dataset.rows[dataset.rows.length - 1]?.ts ?? null,
    totals: { requests: dataset.rows.length, tokens, cost: round(cost, 2) },
    sources: ALL_SOURCES.filter(source => dataset.rows.some(row => sourceOf(row) === source)),
    sourceCapabilities: SOURCE_CAPABILITIES,
    providers: [...providers].sort(),
    models: [...models].sort(),
    // Most used first: charts colour the models people actually see before the long tail.
    modelsByUse: [...modelRequests.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model]) => model),
    modelsByProvider: Object.fromEntries([...modelsByProvider.entries()].map(([key, value]) => [key, value.sort()])),
    efforts: [...efforts].sort(),
    routeKinds: [...routeKinds].sort(),
    conversations: new Set(dataset.rows.filter(row => row.conversationId).map(row => JSON.stringify([sourceOf(row), row.conversationId]))).size,
    ledger: { byKind: dataset.ledger.byKind, settledTokens: dataset.ledger.settledTokens, updatedAt: dataset.ledger.updatedAt },
    quota: { windows: dataset.quota.windows, updatedAt: dataset.quota.updatedAt },
    paths: PATHS,
  };
}

api.get("/api/labs/evidence", c => {
  const intent = parseCaseIntent(new URL(c.req.url).searchParams);
  const payload = buildEvidenceCase(c.get("dataset").rows, intent);
  // Derived roots can change without a ledger revision. Validate and resolve before any 304.
  const etag = `W/"${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24)}"`;
  c.header("ETag", etag);
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  return c.json(payload);
});

api.get("/api/labs/context", c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  return c.json({ ok: true, ...buildContextReplay(dataset.rows, query.filter, query.window) });
});

api.get("/api/overview", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  const priorRows = filterRows(dataset.rows, previousWindow(query.filter, query.from, query.to));
  const quotaScope = accountScope(c.req.query());
  const summary = summarize(rows);
  const prior = summarize(priorRows);
  const composition = costComposition(rows);

  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: { ...query.window, bucket: query.bucket, range: query.range, requests: rows.length },
    summary,
    prior,
    deltas: {
      requests: delta(summary.requests, prior.requests),
      tokens: delta(summary.tokens.total, prior.tokens.total),
      cost: delta(summary.cost, prior.cost),
      successRate: summary.successRate !== null && prior.successRate !== null ? round(summary.successRate - prior.successRate, 4) : null,
      latencyP50: summary.latency.p50 !== null && prior.latency.p50 !== null ? delta(summary.latency.p50, prior.latency.p50) : null,
      ttftP50: summary.ttft.p50 !== null && prior.ttft.p50 !== null ? delta(summary.ttft.p50, prior.ttft.p50) : null,
      cacheHitRate: summary.cache.hitRate !== null && prior.cache.hitRate !== null ? round(summary.cache.hitRate - prior.cache.hitRate, 4) : null,
    },
    sparkline: {
      tokens: sparkline(rows, query.from, query.to, "tokens", 32),
      cost: sparkline(rows, query.from, query.to, "cost", 32),
      requests: sparkline(rows, query.from, query.to, "requests", 32),
    },
    series: buildSeries(rows, { bucket: query.bucket, metric: query.metric, groupBy: query.groupBy, from: query.from, to: query.to, tz: query.tz, limit: 6 }),
    composition,
    topModels: breakdown(rows, row => row.model).slice(0, 6),
    topProviders: breakdown(rows, row => row.provider),
    topEfforts: breakdown(rows, row => row.effort ?? "unknown"),
    topConversations: conversations(rows, 8),
    heatmap: heatmap(rows, "tokens", query.tz),
    context: contextPressure(rows),
    // Quota is an opencodex account observation: never narrowed by, or attributed to, the selection.
    // Projections are dated at the request clock, like the window, so one quantum gives one body.
    quota: quotaView(quotaScope.available ? dataset : { quota: EMPTY_QUOTA }, { from: query.from, to: query.to }, c.get("now")),
    quotaScope,
    recent: topN(rows, 25, newestFirst).map(publicRow),
  });
});

api.get("/api/timeseries", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: { ...query.window, bucket: query.bucket },
    series: buildSeries(rows, {
      bucket: query.bucket,
      metric: query.metric,
      groupBy: query.groupBy,
      from: query.from,
      to: query.to,
      tz: query.tz,
      limit: numberParam(c.req.query("limit")) ?? 8,
    }),
  });
});

api.get("/api/models", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  const models = breakdown(rows, row => row.model);
  const providers = breakdown(rows, row => row.provider);
  const efforts = breakdown(rows, row => row.effort ?? "unknown");
  const scatter = models.map(model => ({
    model: model.key,
    requests: model.requests,
    tokens: model.tokens,
    cost: model.cost,
    costPer1kTokens: model.costPer1kTokens,
    costPer1MTokens: model.costPer1MTokens,
    ttftP50: model.ttftP50,
    p50DurationMs: model.p50DurationMs,
    outputTokensPerSecond: model.outputTokensPerSecond,
    successRate: model.successRate,
  }));
  const effortMatrix = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const effort = row.effort ?? "unknown";
    const entry = effortMatrix.get(effort) ?? {};
    entry[row.model] = (entry[row.model] ?? 0) + row.totalTokens;
    effortMatrix.set(effort, entry);
  }
  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: query.window,
    models,
    providers,
    efforts,
    scatter,
    effortMatrix: [...effortMatrix.entries()].map(([effort, values]) => ({ effort, values })),
  });
});

api.get("/api/usage", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  const composition = compositionSeries(rows, query.bucket, query.from, query.to, query.tz);
  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: { ...query.window, bucket: query.bucket },
    summary: summarize(rows),
    composition,
    cache: cacheTimeline(rows, query.bucket, query.from, query.to, query.tz),
    series: buildSeries(rows, { bucket: query.bucket, metric: query.metric, groupBy: query.groupBy, from: query.from, to: query.to, tz: query.tz, limit: 8 }),
    heatmap: heatmap(rows, query.metric, query.tz),
    context: contextPressure(rows),
    byModel: breakdown(rows, row => row.model),
    byProvider: breakdown(rows, row => row.provider),
    byEffort: breakdown(rows, row => row.effort ?? "unknown"),
    byRoute: breakdown(rows, row => row.routeKind ?? "unrouted"),
  });
});

api.get("/api/usage/heatmap-dates", async c => {
  const dataset = c.get("dataset");
  const params = c.req.query();
  const weekday = numberParam(params.weekday);
  const hour = numberParam(params.hour);
  if (weekday === undefined || !Number.isInteger(weekday) || weekday < 0 || weekday > 6
    || hour === undefined || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    return c.json({ ok: false, error: "weekday must be 0–6 and hour must be 0–23" }, 400);
  }
  const query = parseQuery(params, dataset, c.get("now"));
  const metric = params.metric === "requests" ? "requests" : "tokens";
  const breakdown = heatmapDateBreakdown(filterRows(dataset.rows, query.filter), {
    weekday, hour, metric, timeZone: query.tz,
    limit: numberParam(params.limit), offset: numberParam(params.offset),
  });
  return c.json({ ok: true, ...coverageField(dataset.rows, query.filter), window: { ...query.window, range: query.range, timeZone: query.tz }, ...breakdown });
});

api.get("/api/cost", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: { ...query.window, bucket: query.bucket },
    summary: summarize(rows),
    composition: costComposition(rows),
    /** Tokens of priced requests: the denominator for a blended price (unpriced tokens carry no dollars). */
    pricedTokens: rows.reduce((sum, row) => (row.priced ? sum + row.totalTokens : sum), 0),
    series: buildSeries(rows, { bucket: query.bucket, metric: "cost", groupBy: query.groupBy, from: query.from, to: query.to, tz: query.tz, limit: 8 }),
    cumulative: cumulativeSeries(rows, query.bucket, query.from, query.to, "cost", query.tz),
    cache: cacheTimeline(rows, query.bucket, query.from, query.to, query.tz),
    byModel: breakdown(rows, row => row.model),
    byProvider: breakdown(rows, row => row.provider),
    byEffort: breakdown(rows, row => row.effort ?? "unknown"),
    topConversations: conversations(rows, 10, "cost"),
    daily: cumulativeSeries(rows, "day", query.from, query.to, "cost", query.tz),
  });
});

/**
 * Spend structure (#103): session concentration, blended price by price tier over time, and the
 * token-class cost mix per source. A separate route so /api/cost stays fast; priced rows only.
 */
api.get("/api/cost/structure", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: { ...query.window, bucket: query.bucket },
    ...spendStructure(rows, { bucket: query.bucket, from: query.from, to: query.to, tz: query.tz, datasetRows: dataset.rows }),
  });
});

api.get("/api/performance", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  const timeline = latencyTimeline(rows, query.bucket, query.from, query.to, query.tz);
  const durations = rows.filter(row => row.measurements.duration).map(row => row.durationMs);
  const ttfts = rows.filter(row => row.measurements.ttft).map(row => row.ttftMs as number);
  const throughputs = rows.filter(throughputEligible).map(row => row.outputTokens / (row.durationMs / 1000));
  const [durationSample, ttftSample, throughputSample] = [sortedSample(durations), sortedSample(ttfts), sortedSample(throughputs)];
  const byModel = breakdown(rows, row => row.model);

  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: { ...query.window, bucket: query.bucket },
    timeline,
    measurementCoverage: measurementCoverage(rows),
    histogram: {
      duration: histogram(durations, [0, 1000, 2500, 5000, 10000, 20000, 40000, 80000, Number.POSITIVE_INFINITY], ["<1s", "1-2.5s", "2.5-5s", "5-10s", "10-20s", "20-40s", "40-80s", "80s+"]),
      ttft: histogram(ttfts, [0, 500, 1000, 2000, 4000, 8000, 16000, Number.POSITIVE_INFINITY], ["<0.5s", "0.5-1s", "1-2s", "2-4s", "4-8s", "8-16s", "16s+"]),
      throughput: histogram(throughputs, [0, 5, 10, 20, 40, 80, 160, Number.POSITIVE_INFINITY], ["<5", "5-10", "10-20", "20-40", "40-80", "80-160", "160+"]),
    },
    percentiles: {
      duration: { p50: percentileOfSorted(durationSample, 0.5), p90: percentileOfSorted(durationSample, 0.9), p95: percentileOfSorted(durationSample, 0.95), p99: percentileOfSorted(durationSample, 0.99) },
      ttft: { p50: percentileOfSorted(ttftSample, 0.5), p90: percentileOfSorted(ttftSample, 0.9), p95: percentileOfSorted(ttftSample, 0.95), p99: percentileOfSorted(ttftSample, 0.99), coverage: rows.length ? round(ttfts.length / rows.length, 4) : 0 },
      throughput: { p50: percentileOfSorted(throughputSample, 0.5), p10: percentileOfSorted(throughputSample, 0.1), mean: throughputs.length ? round(throughputs.reduce((a, b) => a + b, 0) / throughputs.length, 2) : null },
    },
    byModel,
    ttftVsOutput: rows
      .filter(row => row.measurements.ttft && row.measurements.output && row.outputTokens > 0)
      .slice(-2000)
      .map(row => ({ ttftMs: row.ttftMs, outputTokens: row.outputTokens, model: row.model, ts: row.ts })),
    slowest: slowestRequests(rows, 15).map(publicRow),
    context: contextPressure(rows),
  });
});

/** The Context page (#102): context length per model, over time, by band, and what long contexts coincide with. */
api.get("/api/context", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: { ...query.window, bucket: query.bucket },
    ...contextBreakdown(rows, { bucket: query.bucket, from: query.from, to: query.to, tz: query.tz, datasetRows: dataset.rows }),
    histogram: contextPressure(rows),
  });
});

api.get("/api/reliability", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  const report = reliability(rows, query.tz);
  const summary = summarize(rows);
  const failureRows = rows.filter(row => outcome(row) === "error" || outcome(row) === "cancelled").slice(-500);
  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: query.window,
    ...report,
    successRate: summary.successRate,
    measurementCoverage: summary.measurementCoverage,
    recentFailures: topN(failureRows, 40, newestFirst).map(publicRow),
    waste: summary.waste,
    metering: summary.metering,
    retryOverhead: summary.retryOverhead,
  });
});

api.get("/api/quota", async c => {
  const dataset = c.get("dataset");
  const samples = dataset.quota.samples;
  const window = timeWindow(c.req.query(), samples[0]?.observedAt ?? c.get("now"), c.get("now"));
  const scope = accountScope(c.req.query());
  return c.json({
    ok: true,
    range: c.req.query("range") ?? "30d",
    ...quotaView(scope.available ? dataset : { quota: EMPTY_QUOTA }, { from: window.from, to: window.to }, c.get("now")),
    scope,
    window: windowEcho(window),
  });
});

api.get("/api/ledger", async c => {
  const dataset = c.get("dataset");
  const scope = accountScope(c.req.query());
  const events = scope.available ? dataset.ledger.events : [];
  const window = timeWindow(c.req.query(), events[0]?.at ?? c.get("now"), c.get("now"));
  const { from, to, tz } = window;
  const bucket: Bucket = to - from <= 48 * 3_600_000 ? "hour" : "day";

  const buckets = new Map<number, { ts: number; label: string; settled: number; sends: number; tokens: number }>();
  for (const ts of bucketStarts(bucket, from, to, tz)) {
    buckets.set(ts, { ts, label: bucketLabel(ts, bucket, tz), settled: 0, sends: 0, tokens: 0 });
  }
  const sendTokens = new Map<string, number>();
  const bucketOf = bucketer(bucket, tz);
  for (const event of events) {
    if (event.at < from || event.at >= to) continue;
    const key = bucketOf(event.at);
    const entry = buckets.get(key);
    if (!entry) continue;
    if (event.kind === "settle") {
      entry.settled += 1;
      entry.tokens += event.tokens;
      if (event.sendId) sendTokens.set(event.sendId, (sendTokens.get(event.sendId) ?? 0) + event.tokens);
    }
    if (event.kind === "dispatch" || event.kind === "reserve") entry.sends += 1;
  }
  const sorted = [...sendTokens.values()].sort((a, b) => b - a);
  return c.json({
    ok: true,
    window: { ...windowEcho(window), bucket },
    scope,
    byKind: scope.available ? dataset.ledger.byKind : {},
    settledTokens: scope.available ? dataset.ledger.settledTokens : 0,
    updatedAt: scope.available ? dataset.ledger.updatedAt : null,
    buckets: [...buckets.values()].sort((a, b) => a.ts - b.ts),
    distinctSends: sendTokens.size,
    largestSend: sorted[0] ?? 0,
    medianSend: percentile(sorted, 0.5),
  });
});

api.get("/api/conversations", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  const limit = numberParam(c.req.query("limit")) ?? 100;
  const requested = c.req.query("sort");
  const sort: ConversationSort = requested === "cost" || requested === "requests" || requested === "recent" || requested === "errors" ? requested : "tokens";
  // Ranked across every session, then cut: a costly low-token session is never lost to the cut.
  const every = allConversations(rows, sort);
  const sorted = every.slice(0, limit);
  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: query.window,
    conversations: sorted,
    totals: {
      // Every session in the selection, not just the page of them returned above.
      conversations: every.length,
      requests: rows.filter(row => row.conversationId).length,
      unattributed: rows.filter(row => !row.conversationId).length,
      medianRequests: percentile(every.map(row => row.requests), 0.5),
      medianTokens: percentile(every.map(row => row.tokens), 0.5),
    },
  });
});

/**
 * One session under the dashboard scope. Window parameters apply only when given (a bare call is
 * all-history, as before), and the same source/project/model/... filters as the list apply. `sessionSource`
 * names the session's source when an id exists in both; `scope` reports what the selection left out.
 */
api.get("/api/conversations/:id", async c => {
  const dataset = c.get("dataset");
  const id = c.req.param("id");
  const params = c.req.query();
  const query = parseQuery(params, dataset, c.get("now"));
  const windowed = ["from", "to", "last", "range"].some(key => params[key]?.trim());
  const filter: RowFilter = { ...query.filter, conversationId: undefined, ...(windowed ? {} : { from: undefined, to: undefined }) };
  const sessionSource = params.sessionSource?.trim() ? parseSource(params.sessionSource) : undefined;
  if (sessionSource === null) {
    throw new ReportSpecError("invalid_source", "sessionSource", `Unknown source "${params.sessionSource}". Use claude-code (or claude) and ocx (or codex).`);
  }
  const lookup = lookupSession(dataset.rows, id, filter, sessionSource ?? undefined);
  if (lookup.status === "missing") return c.json({ ok: false, error: "conversation not found" }, 404);
  if (lookup.status === "ambiguous") {
    return c.json({ ok: false, error: { code: "ambiguous_session", param: "sessionSource", message: `Conversation id "${id}" exists in ${lookup.sources.join(" and ")}. Add sessionSource=<source>.`, sources: lookup.sources } }, 409);
  }
  const timeline = conversationTimeline(lookup.scoped, id);
  const applied = ["sources", "projects", "providers", "models", "efforts", "statuses", "routeKinds", "search"].filter(key => params[key]?.split(",").some(part => part.trim()));
  return c.json({
    ok: true,
    ...timeline,
    source: lookup.source,
    ...coverageField(lookup.all, filter),
    scope: {
      window: windowed ? query.window : null,
      filtersApplied: applied,
      matched: lookup.scoped.length,
      sessionTotal: lookup.all.length,
      // Requests of this session the selection left out, by cause: outside the window, or failing another filter.
      excluded: { window: lookup.all.length - lookup.inWindow.length, filters: lookup.inWindow.length - lookup.scoped.length },
    },
    requests: [...lookup.scoped].sort((a, b) => a.ts - b.ts).map(publicRow),
  });
});

/**
 * Titles Claude Code recorded for its sessions, for local display. A route of its own so they never
 * enter the conversation list: that payload is saved in the browser, exported and fed to reports.
 */
api.get("/api/session-titles", c => {
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true, titles: Object.fromEntries(claudeSessionTitles()) });
});

api.get("/api/labs/projects", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const payload = buildProjectRadar(dataset.rows, query.filter, query.window);
  const etag = `W/"${createHash("sha256").update(c.req.url).update(JSON.stringify(payload)).digest("hex").slice(0, 24)}"`;
  c.header("ETag", etag);
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  return c.json(payload);
});

/**
 * Spend spikes (#106): unusually expensive local days against the trailing baseline, and what changed on one
 * of them. Project folders resolve git roots on disk, so the body is hashed after validation like Radar's.
 */
api.get("/api/labs/spend", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const day = c.req.query("day")?.trim() || null;
  if (day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new ReportSpecError("invalid_day", "day", `Could not read "${day}" as a local date. Use YYYY-MM-DD in the window's time zone.`);
  }
  const payload = buildSpendChanges(dataset.rows, query.filter, query.window, c.get("now"), day);
  if ("error" in payload) {
    throw new ReportSpecError("invalid_day", "day", `The day ${day} is not in the selected window. Pick a local date inside it.`);
  }
  const etag = `W/"${createHash("sha256").update(c.req.url).update(JSON.stringify(payload)).digest("hex").slice(0, 24)}"`;
  c.header("ETag", etag);
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  return c.json(payload);
});

/** The selection in numbers, for the toolbar: what it keeps, what the window holds, and what a project filter had to drop. */
api.get("/api/scope", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  return c.json({ ok: true, window: query.window, ...scopeSummary(dataset.rows, query.filter), account: accountScope(c.req.query()) });
});

// L04: net cache economics over the resolved window and cohort (docs/api.md).
api.get("/api/labs/cache", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const pricing = pricingStatus();
  return c.json({
    window: query.window,
    pricing: { available: pricing.available, detail: pricing.detail },
    ...buildCacheEconomics(dataset.rows, query.filter, query.window, { limit: numberParam(c.req.query("limit")) }),
  });
});

api.get("/api/projects", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  // Unattributed rows stay listed under a project filter, matching `coverage`.
  const inProject = query.filter.projects?.length ? projectMatcher(query.filter.projects) : null;
  const rows = filterRows(dataset.rows, { ...query.filter, projects: undefined })
    .filter(row => !inProject || row.cwd === null || inProject(row.cwd));
  const payload = {
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: { ...query.window, range: query.range },
    projects: projectBreakdown(rows),
  };
  const etag = `W/"${createHash("sha256").update(c.req.url).update(JSON.stringify(payload)).digest("hex").slice(0, 24)}"`;
  c.header("ETag", etag);
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  return c.json(payload);
});

api.get("/api/export", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  const requested = c.req.query("dataset");
  const datasetName = requested === "models" || requested === "conversations" ? requested : "requests";
  let payload: Record<string, unknown>[];
  if (datasetName === "models") {
    payload = breakdown(rows, row => row.model) as unknown as Record<string, unknown>[];
  } else if (datasetName === "conversations") {
    payload = conversations(rows, 1000) as unknown as Record<string, unknown>[];
  } else {
    payload = rows.map(publicRow);
  }
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", `attachment; filename="yald-${datasetName}-${fileStamp(query.from, query.tz)}--${fileStamp(query.to, query.tz)}.csv"`);
  return c.body(toCsv(payload));
});

api.get("/api/filters", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, { ...query.filter, providers: undefined, models: undefined, efforts: undefined, statuses: undefined, routeKinds: undefined });
  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: query.window,
    providers: [...new Set(rows.map(row => row.provider))].sort(),
    models: [...new Set(rows.map(row => row.model))].sort(),
    efforts: [...new Set(rows.map(row => row.effort ?? "unknown"))].sort(),
    routeKinds: [...new Set(rows.map(row => row.routeKind ?? "unrouted"))].sort(),
  });
});

/** Resolves `from`/`to`/`last`/`range`/`tz` and repeated `phase=name=start..end` without aggregating any data. */
api.get("/api/window", async c => {
  const window = timeWindow(c.req.query(), c.get("dataset").rows[0]?.ts ?? c.get("now"), c.get("now"));
  const phases = parsePhases(c.req.queries("phase") ?? [], window);
  return c.json({
    ok: true,
    window: windowEcho(window),
    phases: phases.map(phase => ({
      ...phase, label: windowLabel(phase.from, phase.to, window.tz), fromIso: isoInZone(phase.from, window.tz), toIso: isoInZone(phase.to, window.tz),
    })),
  });
});

/** Served with format=html: the embedded JSON is data, nothing may run or load. */
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'";

/**
 * The report for a window (#39): the same buildReportSpec, buildReport and live
 * context as `yald report`, so the JSON matches the CLI's apart from meta.generatedAt,
 * which is this request's time. The ETag middleware above keys on the dataset
 * revision and URL (plus the clock for windows that move), never on generatedAt.
 */
api.get("/api/report", async c => {
  const dataset = c.get("dataset");
  // Not memoized and stamped with its request time, like `yald report`: the exact clock, not the quantized one.
  const now = requestNow();
  const query = c.req.query();
  const format = query.format?.trim() || "json";
  if (format !== "json" && format !== "html") {
    return c.json({ ok: false, error: { code: "invalid_format", param: "format", message: `Unknown format "${query.format}". Use json or html.` } }, 400);
  }
  const joined = (key: string) => c.req.queries(key)?.join(",");
  const spec = buildReportSpec({
    from: query.from, to: query.to, last: query.last, range: query.range, tz: query.tz,
    phases: c.req.queries("phase") ?? [],
    sources: joined("sources"), projects: joined("projects"),
    top: query.top, redact: query.redact, title: query.title,
  }, { now, first: dataset.rows[0]?.ts ?? now });
  const report = buildReport(dataset, spec, liveReportContext(now));
  const stable = { ...report, meta: { ...report.meta, generatedAt: 0 } };
  const etag = `W/"${createHash("sha256").update(c.req.url).update(JSON.stringify(stable)).digest("hex").slice(0, 24)}"`;
  c.header("ETag", etag);
  if (["1", "true"].includes(query.download?.trim().toLowerCase() ?? "")) {
    c.header("Content-Disposition", `attachment; filename="yald-report-${fileStamp(spec.window.from, spec.window.tz)}.${format}"`);
  }
  if (format === "html") c.header("Content-Security-Policy", REPORT_CSP);
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  if (format === "json") return c.json({ ok: true, report });
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Content-Security-Policy", REPORT_CSP);
  return c.body(renderReportHtml(report));
});

/** "2026-10-11T0900+0800": the local time and offset, safe in a file name. */
function fileStamp(ts: number, tz: string): string {
  return isoInZone(ts, tz).replace(/^(.{10}T)(\d{2}):(\d{2}).*([+-]\d{2}):(\d{2})$/, "$1$2$3$4$5");
}

function histogram(values: number[], edges: number[], labels: string[]): { name: string; value: number }[] {
  const counts = Array.from({ length: labels.length }, () => 0);
  for (const value of values) {
    for (let i = 0; i < labels.length; i++) {
      if (value >= edges[i]! && value < edges[i + 1]!) {
        counts[i] += 1;
        break;
      }
    }
  }
  return labels.map((name, index) => ({ name, value: counts[index]! }));
}
