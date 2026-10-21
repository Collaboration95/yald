// buildReport (#36): the only place report numbers are computed. The HTML renderer
// (#37), the CLI (#38) and GET /api/report (#39) all consume its output.
//
// Pure: no I/O, no Date.now(), no process timezone. Everything that needs the outside
// world comes in through `ctx`: the clock (`now`), the pricing engine's state, the home
// directory and a project resolver (the git root lookup reads the disk, so callers
// pass `gitRoot` from projects.ts rather than this module calling it).
import {
  breakdown, bucketStarts, conversations as conversationRows, costComposition, filterRows,
  projectCoverage, quotaView, round, summarize, type RowFilter,
} from "../analytics";
import type { Dataset, RequestRow } from "../ocx/store";
import { formatInZone, isoInZone, makeBucketer, type Instant } from "../time/window";
import { ALL_SOURCES, sourceOf } from "./source";
import type { ReportData, ReportSpec, Source, Totals } from "./types";

/** What buildReport reads from a Dataset; a whole Dataset fits. */
export type ReportDataset = Pick<Dataset, "rows" | "quota" | "ledger" | "files">;

export interface ReportContext {
  /** meta.generatedAt; also dates quota projections. Never read from the clock here. */
  now: Instant;
  yaldVersion: string;
  /**
   * Pricing engine state, i.e. `pricingStatus().available ? "ok" : "unavailable"`.
   * Default: "unavailable" when the dataset has rows and none is priced, else "ok".
   */
  pricing?: "ok" | "unavailable";
  /**
   * Home directory. Expands `~` in project globs and is shown as `~` in redacted
   * paths. Without it, globs fall back to $HOME and redaction shortens
   * /Users/<name> and /home/<name>.
   */
  home?: string;
  /** Project of a working directory, e.g. `cwd => gitRoot(cwd) ?? cwd`. Default: the directory itself. */
  projectOf?: (cwd: string) => string;
  /** Claude Code transcripts folder, named in coverage.sourcesRead. */
  claudeProjectsDir?: string;
}

export const OUTSIDE_PHASES = "(outside phases)";
export const TOTAL_ROW = "Total";

const HOUR = 3_600_000;
const MICRO = 1_000_000;

/**
 * Consistency checks run unless NODE_ENV is "production": development, tests, the
 * sample script and `bun run` without NODE_ENV all assert; a production server
 * (NODE_ENV=production) skips the extra pass.
 */
function assertionsOn(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Exact running totals. Cost is summed in integer micro-dollars so phases add up to the total exactly. */
interface Acc {
  requests: number; tokens: number;
  freshInput: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number;
  costMicros: number;
}

const ACC_KEYS = ["requests", "tokens", "freshInput", "cacheRead", "cacheWrite", "output", "reasoning", "costMicros"] as const;

const freshInput = (row: RequestRow) => Math.max(0, row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens);
const micros = (row: RequestRow) => row.priced ? Math.round(row.cost * MICRO) : 0;

function accumulate(rows: RequestRow[]): Acc {
  const acc: Acc = { requests: 0, tokens: 0, freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costMicros: 0 };
  for (const row of rows) {
    acc.requests++;
    acc.tokens += row.totalTokens;
    acc.freshInput += freshInput(row);
    acc.cacheRead += row.cacheReadTokens;
    acc.cacheWrite += row.cacheWriteTokens;
    acc.output += row.outputTokens;
    acc.reasoning += row.reasoningTokens;
    acc.costMicros += micros(row);
  }
  return acc;
}

function sumAcc(parts: Acc[]): Acc {
  const sum = accumulate([]);
  for (const part of parts) for (const key of ACC_KEYS) sum[key] += part[key];
  return sum;
}

function assertSame(label: string, actual: Acc, expected: Acc): void {
  for (const key of ACC_KEYS) {
    if (actual[key] !== expected[key]) {
      throw new Error(`buildReport consistency: ${label} ${key} is ${actual[key]}, expected ${expected[key]}`);
    }
  }
}

function toTotals(acc: Acc, priced: boolean): Totals {
  return {
    requests: acc.requests, tokens: acc.tokens,
    freshInput: acc.freshInput, cacheRead: acc.cacheRead, cacheWrite: acc.cacheWrite, output: acc.output, reasoning: acc.reasoning,
    costUsd: priced ? acc.costMicros / MICRO : null,
  };
}

function distinctConversations(rows: RequestRow[]): number {
  return new Set(rows.flatMap(row => (row.conversationId ? [JSON.stringify([sourceOf(row), row.conversationId])] : []))).size;
}

/** Most tokens, then name; null without rows. */
function topModel(rows: RequestRow[]): string | null {
  const tokens = new Map<string, number>();
  for (const row of rows) tokens.set(row.model, (tokens.get(row.model) ?? 0) + row.totalTokens);
  return [...tokens.entries()].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))[0]?.[0] ?? null;
}

function bySource<T>(make: () => T): Record<Source, T> {
  return { "claude-code": make(), ocx: make() };
}

/** Code-unit order: locale-independent, so the same input sorts the same everywhere. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function expandHome(glob: string, home: string | undefined): string {
  const trimmed = glob.trim();
  if (home && (trimmed === "~" || trimmed.startsWith("~/"))) return home + trimmed.slice(1);
  return trimmed;
}

/** `~`-relative path; without a known home, the first two segments of /Users/<name> or /home/<name>. */
export function tildify(path: string, home?: string): string {
  const base = home?.replace(/\/+$/, "");
  if (base && (path === base || path.startsWith(`${base}/`))) return `~${path.slice(base.length)}`;
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

function timelineLabel(ts: Instant, bucket: "hour" | "day", tz: string, multiDay: boolean): string {
  const long = formatInZone(ts, tz); // "Sun 11 Oct 2026, 09:00 GMT+8"
  if (bucket === "day") return long.split(",")[0]!.replace(/ \d{4}$/, "");
  const clock = isoInZone(ts, tz).slice(11, 16);
  return multiDay ? `${long.slice(0, 3)} ${clock}` : clock;
}

export function buildReport(dataset: ReportDataset, spec: ReportSpec, ctx: ReportContext): ReportData {
  const { window } = spec;
  const { from, to, tz } = window;
  const redact = spec.redact;
  const show = (path: string) => (redact ? tildify(path, ctx.home) : path);
  const pricing = ctx.pricing ?? (dataset.rows.length > 0 && !dataset.rows.some(row => row.priced) ? "unavailable" : "ok");
  const priced = pricing === "ok";
  const sources = ALL_SOURCES.filter(source => spec.sources.length === 0 || spec.sources.includes(source));

  // Rows: half-open window, then sources, then projects. Coverage counts the
  // in-window, in-source rows the project filter dropped for lack of a folder.
  const sourced = filterRows(dataset.rows, { from, to }).filter(row => sources.includes(sourceOf(row)));
  const projectFilter: RowFilter = { projects: spec.projects.length ? spec.projects.map(glob => expandHome(glob, ctx.home)) : undefined };
  const rows = projectFilter.projects ? filterRows(sourced, projectFilter) : sourced;
  const projectCounts = projectCoverage(sourced, projectFilter);

  const summary = summarize(rows);
  const total = accumulate(rows);
  const ocxRows = rows.filter(row => sourceOf(row) === "ocx");
  const hourOf = makeBucketer("hour", tz);
  const activeHours = new Set(rows.map(row => hourOf(row.ts))).size;

  const kpis: ReportData["kpis"] = {
    requests: summary.requests,
    tokens: summary.tokens.total,
    freshInput: total.freshInput,
    cacheRead: summary.tokens.cacheRead,
    cacheWrite: summary.tokens.cacheWrite,
    output: summary.tokens.output,
    reasoning: summary.tokens.reasoning,
    costUsd: priced ? total.costMicros / MICRO : null,
    conversations: distinctConversations(rows),
    activeHours,
    cacheHitRate: summary.cache.hitRate,
    cacheSavingsUsd: summary.cache.savingsUsd,
    successRate: ocxRows.length ? summarize(ocxRows).successRate : null,
  };

  // Phases: one row each (sorted by start), then the rest of the window, then the window.
  const phaseRow = (name: string, phaseFrom: Instant, phaseTo: Instant, list: RequestRow[], acc: Acc): ReportData["phases"][number] => {
    const tokensBySource = bySource(() => 0);
    for (const row of list) tokensBySource[sourceOf(row)] += row.totalTokens;
    return { name, from: phaseFrom, to: phaseTo, ...toTotals(acc, priced), conversations: distinctConversations(list), topModel: topModel(list), tokensBySource };
  };
  const phases: ReportData["phases"] = [];
  if (spec.phases.length) {
    const ordered = [...spec.phases].sort((a, b) => a.from - b.from);
    const inside = new Set<RequestRow>();
    const parts: Acc[] = [];
    for (const phase of ordered) {
      const list = rows.filter(row => row.ts >= phase.from && row.ts < phase.to);
      for (const row of list) inside.add(row);
      const acc = accumulate(list);
      parts.push(acc);
      phases.push(phaseRow(phase.name, phase.from, phase.to, list, acc));
    }
    const outside = rows.filter(row => !inside.has(row));
    const outsideAcc = accumulate(outside);
    parts.push(outsideAcc);
    phases.push(phaseRow(OUTSIDE_PHASES, from, to, outside, outsideAcc));
    phases.push(phaseRow(TOTAL_ROW, from, to, rows, total));
    if (assertionsOn()) assertSame("phases + (outside phases) vs Total", sumAcc(parts), total);
  }

  if (assertionsOn()) {
    const fromSummary = { ...total, requests: summary.requests, tokens: summary.tokens.total, cacheRead: summary.tokens.cacheRead, cacheWrite: summary.tokens.cacheWrite, output: summary.tokens.output, reasoning: summary.tokens.reasoning };
    assertSame("Total vs kpis", total, fromSummary);
  }

  if (assertionsOn() && projectCounts) {
    const { matched, unattributed } = projectCounts.attribution;
    assertSame("project coverage kept rows vs Total", { ...accumulate([]), requests: matched.rows, tokens: matched.tokens }, { ...accumulate([]), requests: total.requests, tokens: total.tokens });
    if (unattributed.rows !== unattributed.reasons.reduce((n, r) => n + r.rows, 0)) throw new Error("buildReport consistency: unattributed reasons do not add up to unattributed rows");
  }

  // Timeline: hourly up to 48 hours, daily beyond, every bucket present.
  const bucket = to - from <= 48 * HOUR ? "hour" : "day";
  const multiDay = to - from > 24 * HOUR;
  const points = new Map<Instant, ReportData["timeline"]["points"][number]>();
  for (const ts of bucketStarts(bucket, from, to, tz)) {
    points.set(ts, { ts, label: timelineLabel(ts, bucket, tz, multiDay), bySource: bySource(() => ({ tokens: 0, requests: 0 })) });
  }
  const bucketOf = makeBucketer(bucket, tz);
  for (const row of rows) {
    const point = points.get(bucketOf(row.ts));
    if (!point) continue; // unreachable: every in-window row has a bucket
    const slot = point.bySource[sourceOf(row)];
    slot.tokens += row.totalTokens;
    slot.requests++;
  }

  // Composition classes are disjoint, so they stack to the total: reasoning is
  // reported inside output tokens, and taken out of `output` here.
  const composition: ReportData["composition"] = {
    freshInput: total.freshInput, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite,
    output: Math.max(0, total.output - total.reasoning), reasoning: total.reasoning,
  };

  const dollars = costComposition(rows);
  const cache: ReportData["cache"] = {
    hitRate: summary.cache.hitRate,
    savingsUsd: summary.cache.savingsUsd,
    costByClass: { freshInput: dollars.freshInput, cacheRead: dollars.cacheRead, cacheWrite: dollars.cacheWrite, output: dollars.output },
  };

  // Models: one row per source, provider and model, by tokens then name.
  const SEP = "\u0000";
  const modelKey = (row: RequestRow) => [sourceOf(row), row.provider, row.model].join(SEP);
  const modelCosts = new Map<string, number>();
  for (const row of rows) {
    const key = modelKey(row);
    modelCosts.set(key, (modelCosts.get(key) ?? 0) + micros(row));
  }
  const models: ReportData["models"] = breakdown(rows, modelKey)
    .map(entry => {
      const [source, provider, model] = entry.key.split(SEP) as [Source, string, string];
      const cost = modelCosts.get(entry.key)! / MICRO;
      const hasPrice = priced && entry.unpricedRequests < entry.requests;
      return {
        model, provider, source,
        requests: entry.requests, tokens: entry.tokens,
        share: kpis.tokens > 0 ? round(entry.tokens / kpis.tokens, 4) : 0,
        output: entry.outputTokens,
        costUsd: hasPrice ? cost : null,
        usdPerMTok: hasPrice && entry.tokens > 0 ? round(cost / entry.tokens * MICRO, 2) : null,
        cacheHitRate: entry.cacheHitRate,
        ttftP50Ms: entry.ttftP50 === null ? null : Math.round(entry.ttftP50),
      };
    })
    .sort((a, b) => b.tokens - a.tokens || compare(a.model, b.model) || compare(a.source, b.source) || compare(a.provider, b.provider));

  // Conversation IDs are local to each source: an identical id in the two
  // ledgers must not merge tokens, projects or costs into a single source.
  const projectOf = ctx.projectOf ?? ((cwd: string) => cwd);
  const conversations: ReportData["conversations"] = sources.flatMap(source => {
    const list = rows.filter(row => sourceOf(row) === source);
    const cwdOf = new Map<string, string>();
    const costs = new Map<string, number>();
    const pricedIds = new Set<string>();
    for (const row of list) {
      const id = row.conversationId;
      if (!id) continue;
      if (row.cwd !== null && !cwdOf.has(id)) cwdOf.set(id, row.cwd);
      costs.set(id, (costs.get(id) ?? 0) + micros(row));
      if (row.priced) pricedIds.add(id);
    }
    return conversationRows(list, Number.MAX_SAFE_INTEGER).map(entry => {
      const cwd = cwdOf.get(entry.id);
      return {
        id: entry.id,
        source,
        models: entry.models,
        requests: entry.requests,
        tokens: entry.tokens,
        costUsd: priced && pricedIds.has(entry.id) ? costs.get(entry.id)! / MICRO : null,
        from: entry.startedAt,
        to: entry.endedAt,
        project: cwd === undefined ? null : show(projectOf(cwd)),
      };
    });
  })
    .sort((a, b) => b.tokens - a.tokens || compare(a.id, b.id) || compare(a.source, b.source))
    .slice(0, Math.max(0, spec.top))
    .map(entry => ({ ...entry, id: redact ? entry.id.slice(0, 8) : entry.id }));

  // Quota: opencodex accounts only; fewer than two samples in the window stays "insufficient".
  const quota: ReportData["quota"] = { windows: [], claudeCode: "unavailable" };
  if (sources.includes("ocx")) {
    // quotaView includes a pre-window baseline for dashboard charts. A report
    // measures the requested window only; that baseline must not affect burn.
    const view = quotaView({ quota: {
      ...dataset.quota,
      samples: dataset.quota.samples.filter(sample => sample.observedAt >= from && sample.observedAt < to)
        .sort((a, b) => a.observedAt - b.observedAt),
    } }, { from, to }, ctx.now);
    const accounts = [...new Set(view.burn.map(entry => entry.account))].sort(compare);
    quota.windows = [...view.burn]
      .sort((a, b) => compare(a.account, b.account) || compare(a.window, b.window))
      .map(entry => {
        const measured = entry.status === "measured";
        const points = view.series.find(series => series.account === entry.account && series.window === entry.window)?.points ?? [];
        return {
          account: redact ? `account ${accounts.indexOf(entry.account) + 1}` : entry.account,
          window: entry.window,
          status: entry.status,
          samples: entry.sampleCount,
          usedPctStart: measured ? points[0]!.usedPercent : null,
          usedPctEnd: measured ? points[points.length - 1]!.usedPercent : null,
          burnPctPerDay: measured ? entry.percentPerDay : null,
        };
      });
  }

  // Coverage.
  const sourcesRead: string[] = [];
  if (sources.includes("claude-code")) sourcesRead.push(`Claude Code transcripts${ctx.claudeProjectsDir ? ` (${show(ctx.claudeProjectsDir)})` : ""}`);
  if (sources.includes("ocx")) {
    if (dataset.files.usage) sourcesRead.push(`opencodex request ledger (${show(dataset.files.usage.path)})`);
    if (dataset.files.spend) sourcesRead.push(`opencodex spend ledger (${show(dataset.files.spend.path)})`);
    if (dataset.files.quota) sourcesRead.push(`opencodex quota cache (${show(dataset.files.quota.path)})`);
  }
  const unpricedByModel = new Map<string, number>();
  for (const row of rows) if (!row.priced) unpricedByModel.set(row.model, (unpricedByModel.get(row.model) ?? 0) + 1);
  let ledgerStart: number | null = null;
  for (const event of dataset.ledger.events) if (ledgerStart === null || event.at < ledgerStart) ledgerStart = event.at;

  return {
    schemaVersion: 1,
    meta: {
      title: spec.title?.trim() || `yald report · ${window.label}`,
      generatedAt: ctx.now,
      yaldVersion: ctx.yaldVersion,
      tz,
      window: { from, to, label: window.label },
      filters: { sources, projects: redact ? spec.projects.map(glob => tildify(glob, ctx.home)) : [...spec.projects] },
    },
    kpis,
    phases,
    timeline: { bucket, points: [...points.values()].sort((a, b) => a.ts - b.ts) },
    composition,
    models,
    cache,
    conversations,
    quota,
    coverage: {
      sourcesRead,
      unpriced: [...unpricedByModel.entries()].map(([model, requests]) => ({ model, requests })).sort((a, b) => b.requests - a.requests || compare(a.model, b.model)),
      estimatedCostShare: summary.estimatedCostShare,
      rowsWithoutConversation: rows.filter(row => !row.conversationId).length,
      ledgerStartsAt: sources.includes("ocx") && ledgerStart !== null && ledgerStart > from ? ledgerStart : null,
      pricing,
      unattributedRows: projectCounts ? projectCounts.unattributedRows : null,
      unattributedTokens: projectCounts ? projectCounts.unattributedTokens : null,
      attribution: projectCounts ? projectCounts.attribution : null,
    },
  };
}
