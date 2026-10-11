import { Hono } from "hono";
import { createHash } from "node:crypto";
import {
  breakdown,
  bucketLabel,
  bucketStart,
  bucketStarts,
  buildSeries,
  cacheTimeline,
  compositionSeries,
  cumulativeSeries,
  contextPressure,
  conversationTimeline,
  conversations,
  costComposition,
  filterRows,
  heatmap,
  heatmapDateBreakdown,
  latencyTimeline,
  outcome,
  percentile,
  projectCoverage,
  pickBucket,
  quotaView,
  reliability,
  round,
  sparkline,
  summarize,
  type Bucket,
  type Metric,
  type RowFilter,
} from "./analytics";
import { OCX_HOME, PATHS, TIME_ZONE } from "./env";
import { pricingStatus } from "./ocx/pricing";
import { getDataset, type Dataset, type RequestRow } from "./ocx/store";
import { projectBreakdown, projectMatcher } from "./projects";
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

function slowest(rows: RequestRow[], limit = 10): RequestRow[] {
  return [...rows].sort((a, b) => b.durationMs - a.durationMs).slice(0, limit);
}

function publicRow(row: RequestRow) {
  return {
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

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(","), ...rows.map(row => headers.map(header => escape(row[header])).join(","))].join("\n");
}

export const api = new Hono<{ Variables: { dataset: Dataset; now: number } }>();

api.onError((error, c) => {
  if (error instanceof WindowError || error instanceof ReportSpecError) {
    return c.json({ ok: false, error: { code: error.code, param: error.param, message: error.message } }, 400);
  }
  console.error(error);
  return c.text("Internal Server Error", 500);
});

api.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/dataset/refresh") {
    await next();
    return;
  }
  const dataset = await getDataset();
  const now = Date.now();
  c.set("dataset", dataset);
  c.set("now", now);
  const pointInTime = c.req.path === "/api/health" || c.req.path === "/api/meta"
    || c.req.path.startsWith("/api/conversations/");
  // An unchanged ledger does not mean an unchanged rolling time window.
  const clockKey = pointInTime || clockFree(c.req.query()) ? "" : now;
  const etag = `W/"${createHash("sha256").update(`${dataset.revision}:${c.req.url}:${clockKey}`).digest("hex").slice(0, 24)}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "no-cache");
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  await next();
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

api.get("/api/meta", async c => {
  const dataset = c.get("dataset");
  const providers = new Set<string>();
  const models = new Set<string>();
  const efforts = new Set<string>();
  const routeKinds = new Set<string>();
  let tokens = 0;
  let cost = 0;
  for (const row of dataset.rows) {
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
  return c.json({
    ok: true,
    ocxHome: OCX_HOME,
    timeZone: TIME_ZONE,
    pricing: pricingStatus(),
    files: dataset.files,
    parse: dataset.parse,
    builtAt: dataset.builtAt,
    revision: dataset.revision,
    firstRequestAt: dataset.rows[0]?.ts ?? null,
    lastRequestAt: dataset.rows[dataset.rows.length - 1]?.ts ?? null,
    totals: { requests: dataset.rows.length, tokens, cost: round(cost, 2) },
    providers: [...providers].sort(),
    models: [...models].sort(),
    modelsByProvider: Object.fromEntries([...modelsByProvider.entries()].map(([key, value]) => [key, value.sort()])),
    efforts: [...efforts].sort(),
    routeKinds: [...routeKinds].sort(),
    conversations: new Set(dataset.rows.map(row => row.conversationId).filter(Boolean)).size,
    ledger: { byKind: dataset.ledger.byKind, settledTokens: dataset.ledger.settledTokens, updatedAt: dataset.ledger.updatedAt },
    quota: { windows: dataset.quota.windows, updatedAt: dataset.quota.updatedAt },
    paths: PATHS,
  });
});

api.get("/api/overview", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  const priorRows = filterRows(dataset.rows, previousWindow(query.filter, query.from, query.to));
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
    quota: quotaView(dataset, { from: query.from, to: query.to }),
    recent: [...rows].sort((a, b) => b.ts - a.ts).slice(0, 25).map(publicRow),
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
    series: buildSeries(rows, { bucket: query.bucket, metric: "cost", groupBy: query.groupBy, from: query.from, to: query.to, tz: query.tz, limit: 8 }),
    cumulative: cumulativeSeries(rows, query.bucket, query.from, query.to, "cost", query.tz),
    cache: cacheTimeline(rows, query.bucket, query.from, query.to, query.tz),
    byModel: breakdown(rows, row => row.model),
    byProvider: breakdown(rows, row => row.provider),
    byEffort: breakdown(rows, row => row.effort ?? "unknown"),
    topConversations: conversations(rows, 50).sort((a, b) => b.cost - a.cost).slice(0, 10),
    daily: cumulativeSeries(rows, "day", query.from, query.to, "cost", query.tz),
  });
});

api.get("/api/performance", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  const timeline = latencyTimeline(rows, query.bucket, query.from, query.to, query.tz);
  const durations = rows.filter(row => row.durationMs > 0).map(row => row.durationMs);
  const ttfts = rows.filter(row => row.ttftMs !== null).map(row => row.ttftMs as number);
  const throughputs = rows.filter(row => row.outputTokens > 0 && row.durationMs > 0).map(row => row.outputTokens / (row.durationMs / 1000));
  const byModel = breakdown(rows, row => row.model);

  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: { ...query.window, bucket: query.bucket },
    timeline,
    histogram: {
      duration: histogram(durations, [0, 1000, 2500, 5000, 10000, 20000, 40000, 80000, Number.POSITIVE_INFINITY], ["<1s", "1-2.5s", "2.5-5s", "5-10s", "10-20s", "20-40s", "40-80s", "80s+"]),
      ttft: histogram(ttfts, [0, 500, 1000, 2000, 4000, 8000, 16000, Number.POSITIVE_INFINITY], ["<0.5s", "0.5-1s", "1-2s", "2-4s", "4-8s", "8-16s", "16s+"]),
      throughput: histogram(throughputs, [0, 5, 10, 20, 40, 80, 160, Number.POSITIVE_INFINITY], ["<5", "5-10", "10-20", "20-40", "40-80", "80-160", "160+"]),
    },
    percentiles: {
      duration: { p50: percentile(durations, 0.5), p90: percentile(durations, 0.9), p95: percentile(durations, 0.95), p99: percentile(durations, 0.99) },
      ttft: { p50: percentile(ttfts, 0.5), p90: percentile(ttfts, 0.9), p95: percentile(ttfts, 0.95), p99: percentile(ttfts, 0.99), coverage: rows.length ? round(ttfts.length / rows.length, 4) : 0 },
      throughput: { p50: percentile(throughputs, 0.5), p10: percentile(throughputs, 0.1), mean: throughputs.length ? round(throughputs.reduce((a, b) => a + b, 0) / throughputs.length, 2) : null },
    },
    byModel,
    ttftVsOutput: rows
      .filter(row => row.ttftMs !== null && row.outputTokens > 0)
      .slice(-2000)
      .map(row => ({ ttftMs: row.ttftMs, outputTokens: row.outputTokens, model: row.model, ts: row.ts })),
    slowest: slowest(rows, 15).map(publicRow),
    context: contextPressure(rows),
  });
});

api.get("/api/reliability", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  const rows = filterRows(dataset.rows, query.filter);
  const report = reliability(rows, query.tz);
  const summary = summarize(rows);
  const failureRows = rows.filter(row => outcome(row) !== "ok").slice(-500);
  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: query.window,
    ...report,
    recentFailures: [...failureRows].sort((a, b) => b.ts - a.ts).slice(0, 40).map(publicRow),
    waste: summary.waste,
    metering: summary.metering,
    retryOverhead: summary.retryOverhead,
  });
});

api.get("/api/quota", async c => {
  const dataset = c.get("dataset");
  const samples = dataset.quota.samples;
  const window = timeWindow(c.req.query(), samples[0]?.observedAt ?? c.get("now"), c.get("now"));
  return c.json({
    ok: true,
    range: c.req.query("range") ?? "30d",
    ...quotaView(dataset, { from: window.from, to: window.to }),
    window: windowEcho(window),
  });
});

api.get("/api/ledger", async c => {
  const dataset = c.get("dataset");
  const events = dataset.ledger.events;
  const window = timeWindow(c.req.query(), events[0]?.at ?? c.get("now"), c.get("now"));
  const { from, to, tz } = window;
  const bucket: Bucket = to - from <= 48 * 3_600_000 ? "hour" : "day";

  const buckets = new Map<number, { ts: number; label: string; settled: number; sends: number; tokens: number }>();
  for (const ts of bucketStarts(bucket, from, to, tz)) {
    buckets.set(ts, { ts, label: bucketLabel(ts, bucket, tz), settled: 0, sends: 0, tokens: 0 });
  }
  const sendTokens = new Map<string, number>();
  for (const event of events) {
    if (event.at < from || event.at >= to) continue;
    const key = bucketStart(event.at, bucket, tz);
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
    byKind: dataset.ledger.byKind,
    settledTokens: dataset.ledger.settledTokens,
    updatedAt: dataset.ledger.updatedAt,
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
  const list = conversations(rows, limit);
  const sort = c.req.query("sort") ?? "tokens";
  const sorted = [...list].sort((a, b) => {
    switch (sort) {
      case "cost": return b.cost - a.cost;
      case "requests": return b.requests - a.requests;
      case "recent": return b.endedAt - a.endedAt;
      case "errors": return b.errors - a.errors;
      default: return b.tokens - a.tokens;
    }
  });
  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: query.window,
    conversations: sorted,
    totals: {
      conversations: sorted.length,
      requests: rows.filter(row => row.conversationId).length,
      unattributed: rows.filter(row => !row.conversationId).length,
      medianRequests: percentile(sorted.map(row => row.requests), 0.5),
      medianTokens: percentile(sorted.map(row => row.tokens), 0.5),
    },
  });
});

api.get("/api/conversations/:id", async c => {
  const dataset = c.get("dataset");
  const id = c.req.param("id");
  const timeline = conversationTimeline(dataset.rows, id);
  if (timeline.points.length === 0) return c.json({ ok: false, error: "conversation not found" }, 404);
  return c.json({
    ok: true,
    ...timeline,
    requests: dataset.rows.filter(row => row.conversationId === id).sort((a, b) => a.ts - b.ts).map(publicRow),
  });
});

api.get("/api/projects", async c => {
  const dataset = c.get("dataset");
  const query = parseQuery(c.req.query(), dataset, c.get("now"));
  // Unattributed rows stay listed under a project filter, matching `coverage`.
  const inProject = query.filter.projects?.length ? projectMatcher(query.filter.projects) : null;
  const rows = filterRows(dataset.rows, { ...query.filter, projects: undefined })
    .filter(row => !inProject || row.cwd === null || inProject(row.cwd));
  return c.json({
    ok: true,
    ...coverageField(dataset.rows, query.filter),
    window: { ...query.window, range: query.range },
    projects: projectBreakdown(rows),
  });
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
  const now = c.get("now");
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
  if (["1", "true"].includes(query.download?.trim().toLowerCase() ?? "")) {
    c.header("Content-Disposition", `attachment; filename="yald-report-${fileStamp(spec.window.from, spec.window.tz)}.${format}"`);
  }
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
