// Spend spikes (#106): which local days were unusually expensive against the user's own recent loaded
// history, and what changed on them. "Unusual" is relative to loaded history; it is not a budget, an
// alarm or a judgement. Dollars are API list-price equivalents of PRICED rows at today's loaded prices,
// so a price change between days cannot create a spike. Unpriced rows add requests and tokens, never dollars.
import { bucketLabel, bucketStarts, classCost, filterRows, projectCoverage, type RowFilter } from "../analytics";
import type { RequestRow } from "../ocx/store";
import { createProjectIdentity, UNATTRIBUTED } from "../projects";
import { sourceOf } from "../report/source";
import type { Source } from "../report/types";
import { makeBucketer, nextBucketStart, windowLabel } from "../time/window";
import { analysisScope, evidenceFor, evidenceParams, type AnalysisWindow, type EvidenceSelection } from "./scope";

/** The detection and decomposition rule, echoed in every response and case. */
export const SPEND_RULE = {
  id: "trailing-median",
  baselineActiveDays: 14,
  minBaselineActiveDays: 7,
  spikeMultiple: 2.5,
  activeDay: "a local day with at least one priced request",
  baseline: "the median daily priced cost over the previous 14 active days",
  spike: "a complete day whose priced cost is above 2.5 times that median",
  insufficient: "fewer than 7 active baseline days, or a baseline median of $0: never reported as normal",
  decomposition: "the day's cost minus the mean daily cost over the same baseline days, with baseline days above 2.5 times their own median left out",
  order: ["project", "model", "tokenClass"],
} as const;

export type SpendDayState = "spike" | "normal" | "insufficient" | "partial" | "no-priced";
export type SpendCut = "project" | "model" | "tokenClass" | "session";
const CLASS_LABELS = { freshInput: "Fresh input", cacheRead: "Cache read", cacheWrite: "Cache write", output: "Output", adjustment: "Tier adjustment" } as const;
type ClassKey = keyof typeof CLASS_LABELS;
const CLASS_KEYS = Object.keys(CLASS_LABELS) as ClassKey[];
const TOP_GROUPS = 12;
const DRILL_PROJECTS = 8;
const DRILL_MODELS = 6;

interface DayAggregate {
  ts: number;
  next: number;
  rows: RequestRow[];
  requests: number;
  priced: number;
  cost: number;
  tokens: number;
}

/** Local-day aggregates of `rows`, ascending, using the memoized day bucketer. */
function aggregateDays(rows: readonly RequestRow[], tz: string): DayAggregate[] {
  const dayOf = makeBucketer("day", tz);
  const days = new Map<number, DayAggregate>();
  for (const row of rows) {
    const ts = dayOf(row.ts);
    let day = days.get(ts);
    if (!day) days.set(ts, day = { ts, next: nextBucketStart(ts, "day", tz), rows: [], requests: 0, priced: 0, cost: 0, tokens: 0 });
    day.rows.push(row);
    day.requests++;
    day.tokens += row.totalTokens;
    if (row.priced) {
      day.priced++;
      day.cost += row.cost;
    }
  }
  return [...days.values()].sort((a, b) => a.ts - b.ts);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The previous (at most 14) active days before `ts`. `active` is ascending. */
function baselineBefore(active: readonly DayAggregate[], ts: number): DayAggregate[] {
  let low = 0;
  let high = active.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (active[mid]!.ts < ts) low = mid + 1;
    else high = mid;
  }
  return active.slice(Math.max(0, low - SPEND_RULE.baselineActiveDays), low);
}

interface Judgement {
  state: SpendDayState;
  insufficientReason: "baseline-days" | "zero-baseline" | null;
  medianUsd: number | null;
  thresholdUsd: number | null;
  ratio: number | null;
}

function judge(day: DayAggregate | undefined, baseline: readonly DayAggregate[], complete: boolean): Judgement {
  const none = { insufficientReason: null, medianUsd: null, thresholdUsd: null, ratio: null };
  const medianUsd = baseline.length ? median(baseline.map(entry => entry.cost)) : null;
  const known = baseline.length >= SPEND_RULE.minBaselineActiveDays && medianUsd !== null && medianUsd > 0;
  const thresholdUsd = known ? SPEND_RULE.spikeMultiple * medianUsd! : null;
  const ratio = known && day && day.priced > 0 ? day.cost / medianUsd! : null;
  if (!complete) return { ...none, state: "partial", medianUsd, thresholdUsd, ratio };
  if (!day || day.priced === 0) return { ...none, state: "no-priced", medianUsd, thresholdUsd };
  if (!known) {
    return { state: "insufficient", insufficientReason: baseline.length < SPEND_RULE.minBaselineActiveDays ? "baseline-days" : "zero-baseline", medianUsd, thresholdUsd: null, ratio: null };
  }
  return { state: day.cost > thresholdUsd! ? "spike" : "normal", insufficientReason: null, medianUsd, thresholdUsd, ratio };
}

interface Part {
  key: string;
  label: string;
  day: number;
  /** Sum over the kept baseline days; the mean is this over their count. */
  base: number;
  ref?: Record<string, string>;
}

interface Group {
  key: string;
  label: string;
  dayCostUsd: number;
  baselineMeanUsd: number;
  changeUsd: number;
  /** No baseline cost on any kept day: newly present, never described as an existing group getting costlier. */
  isNew: boolean;
  evidence?: { selector: unknown; priorSelector: unknown; href: string };
}

interface Cut {
  groups: Group[];
  new: Group[];
  other: { groups: number; newGroups: number; dayCostUsd: number; baselineMeanUsd: number; changeUsd: number } | null;
}

function toGroup(part: Part, k: number): Group {
  const baselineMeanUsd = part.base / k;
  return { key: part.key, label: part.label, dayCostUsd: part.day, baselineMeanUsd, changeUsd: part.day - baselineMeanUsd, isNew: part.base === 0 && part.day > 0 };
}

/** Top groups by absolute change, new groups apart, the rest folded into one line: every part sums to the whole. */
function cut(parts: Part[], k: number, limit: number, refine?: (group: Group, part: Part) => Group): Cut {
  const all = parts.map(part => ({ part, group: toGroup(part, k) }));
  const byChange = (a: { group: Group }, b: { group: Group }) => Math.abs(b.group.changeUsd) - Math.abs(a.group.changeUsd) || a.group.key.localeCompare(b.group.key);
  const fresh = all.filter(entry => entry.group.isNew).sort((a, b) => b.group.dayCostUsd - a.group.dayCostUsd || a.group.key.localeCompare(b.group.key));
  const grown = all.filter(entry => !entry.group.isNew).sort(byChange);
  const keptNew = fresh.slice(0, limit);
  const keptGrown = grown.slice(0, limit);
  const rest = [...fresh.slice(limit), ...grown.slice(limit)];
  const finish = (entry: { group: Group; part: Part }) => (refine ? refine(entry.group, entry.part) : entry.group);
  return {
    groups: keptGrown.map(finish),
    new: keptNew.map(finish),
    other: rest.length ? {
      groups: rest.length, newGroups: rest.filter(entry => entry.group.isNew).length,
      dayCostUsd: rest.reduce((sum, entry) => sum + entry.group.dayCostUsd, 0),
      baselineMeanUsd: rest.reduce((sum, entry) => sum + entry.group.baselineMeanUsd, 0),
      changeUsd: rest.reduce((sum, entry) => sum + entry.group.changeUsd, 0),
    } : null,
  };
}

interface Cell {
  project: string;
  gitRoot: boolean;
  source: Source;
  provider: string;
  model: string;
  cls: ClassKey;
  day: number;
  base: number;
}

const modelKey = (source: Source, provider: string, model: string) => JSON.stringify([source, provider, model]);
const modelLabel = (source: Source, provider: string, model: string) => `${source === "claude-code" ? "Claude Code" : "Codex · opencodex"} · ${provider} · ${model}`;

export interface Decomposition {
  /** The stated drill-down order the UI prints: project, then model within the project, then token class within the model. */
  order: readonly string[];
  baselineDays: number;
  keptBaselineDays: number;
  /** Baseline days left out of the mean because they exceed 2.5 times the baseline median. */
  excludedBaselineDates: string[];
  dayCostUsd: number;
  baselineMedianUsd: number;
  baselineMeanUsd: number;
  changeUsd: number;
  unpriced: { dayRequests: number; dayTokens: number; baselineMeanRequests: number; baselineMeanTokens: number; requestChange: number; tokenChange: number };
  attribution: { dayRequests: number; attributedRequests: number; dayPricedCostUsd: number; attributedPricedCostUsd: number; baselineRequests: number; baselineAttributedRequests: number };
  cuts: Record<SpendCut, Cut>;
  drilldown: {
    order: readonly string[];
    projects: (Group & { models: (Group & { tokenClasses: Group[] })[]; otherModels: Cut["other"] })[];
    otherProjects: Cut["other"];
  };
}

/**
 * What changed on a day: every cut sums exactly to `dayCostUsd - baselineMeanUsd`. Baseline days above
 * 2.5 times their own median (earlier spike days) are left out, so they do not mask the change.
 * `ref` hooks let the caller attach fixed-case links to contributors.
 */
export function decompose(dayRows: readonly RequestRow[], baseline: readonly DayAggregate[], tz: string, link?: (cut: SpendCut, ref: Record<string, string>) => Group["evidence"]): Decomposition {
  const baselineMedianUsd = median(baseline.map(entry => entry.cost));
  const cutoff = SPEND_RULE.spikeMultiple * baselineMedianUsd;
  const kept = baseline.filter(entry => entry.cost <= cutoff);
  const k = kept.length;
  const identity = createProjectIdentity();
  const cells = new Map<string, Cell>();
  const sessions = new Map<string, Part>();
  const unpriced = { dayRequests: 0, dayTokens: 0, baseRequests: 0, baseTokens: 0 };
  const attribution = { dayRequests: 0, attributed: 0, dayCost: 0, attributedCost: 0, baseRequests: 0, baseAttributed: 0 };
  let dayCost = 0;
  let baseSum = 0;

  const add = (row: RequestRow, isDay: boolean): void => {
    const source = sourceOf(row);
    if (isDay) {
      attribution.dayRequests++;
      if (row.cwd !== null) attribution.attributed++;
    } else {
      attribution.baseRequests++;
      if (row.cwd !== null) attribution.baseAttributed++;
    }
    if (!row.priced) {
      if (isDay) {
        unpriced.dayRequests++;
        unpriced.dayTokens += row.totalTokens;
      } else {
        unpriced.baseRequests++;
        unpriced.baseTokens += row.totalTokens;
      }
      return;
    }
    if (isDay) {
      dayCost += row.cost;
      attribution.dayCost += row.cost;
      if (row.cwd !== null) attribution.attributedCost += row.cost;
    } else baseSum += row.cost;
    const { project, gitRoot } = identity(row.cwd);
    const parts = classCost(row);
    for (const cls of CLASS_KEYS) {
      const amount = parts[cls];
      if (amount === 0) continue;
      const key = JSON.stringify([project, source, row.provider, row.model, cls]);
      let cell = cells.get(key);
      if (!cell) cells.set(key, cell = { project, gitRoot, source, provider: row.provider, model: row.model, cls, day: 0, base: 0 });
      if (isDay) cell.day += amount;
      else cell.base += amount;
    }
    const sessionKey = row.conversationId === null ? JSON.stringify(["unnamed"]) : JSON.stringify([source, row.conversationId]);
    let session = sessions.get(sessionKey);
    if (!session) {
      session = { key: sessionKey, label: row.conversationId === null ? "Unnamed requests (no session id)" : `${source === "claude-code" ? "Claude Code" : "Codex · opencodex"} · ${row.conversationId}`, day: 0, base: 0,
        ref: row.conversationId === null ? undefined : { source, conversationId: row.conversationId } };
      sessions.set(sessionKey, session);
    }
    if (isDay) session.day += row.cost;
    else session.base += row.cost;
  };
  for (const row of dayRows) add(row, true);
  for (const day of kept) for (const row of day.rows) add(row, false);

  const grouped = (keyOf: (cell: Cell) => { key: string; label: string; ref?: Record<string, string> }, filter: (cell: Cell) => boolean = () => true): Part[] => {
    const parts = new Map<string, Part>();
    for (const cell of cells.values()) {
      if (!filter(cell)) continue;
      const { key, label, ref } = keyOf(cell);
      let part = parts.get(key);
      if (!part) parts.set(key, part = { key, label, day: 0, base: 0, ref });
      part.day += cell.day;
      part.base += cell.base;
    }
    return [...parts.values()];
  };
  const projectKey = (cell: Cell) => ({ key: cell.project, label: cell.project === UNATTRIBUTED ? "Unattributed (no working folder)" : cell.project, ref: { project: cell.project } });
  const modelPart = (cell: Cell) => ({ key: modelKey(cell.source, cell.provider, cell.model), label: modelLabel(cell.source, cell.provider, cell.model), ref: { source: cell.source, provider: cell.provider, model: cell.model } });
  const classPart = (cell: Cell) => ({ key: cell.cls, label: CLASS_LABELS[cell.cls] });
  const withLink = (kind: SpendCut) => (group: Group, part: Part): Group => {
    const evidence = part.ref && link ? link(kind, part.ref) : undefined;
    return evidence ? { ...group, evidence } : group;
  };
  const baselineMeanUsd = baseSum / k;

  const projectParts = grouped(projectKey);
  const projectCut = cut(projectParts, k, TOP_GROUPS, withLink("project"));
  const drillProjects = [...projectParts].sort((a, b) => Math.abs(toGroup(b, k).changeUsd) - Math.abs(toGroup(a, k).changeUsd) || a.key.localeCompare(b.key));
  const shown = drillProjects.slice(0, DRILL_PROJECTS);
  const drilldown = {
    order: SPEND_RULE.order,
    projects: shown.map(project => {
      const models = cut(grouped(modelPart, cell => cell.project === project.key), k, DRILL_MODELS, withLink("model"));
      const group = toGroup(project, k);
      const classesOf = (modelGroup: Group) => {
        const parts = grouped(classPart, cell => cell.project === project.key && modelKey(cell.source, cell.provider, cell.model) === modelGroup.key);
        return parts.map(part => toGroup(part, k)).sort((a, b) => CLASS_KEYS.indexOf(a.key as ClassKey) - CLASS_KEYS.indexOf(b.key as ClassKey));
      };
      return {
        ...(project.ref && link ? { ...group, evidence: link("project", project.ref) } : group),
        models: [...models.groups, ...models.new].map(modelGroup => ({ ...modelGroup, tokenClasses: classesOf(modelGroup) })),
        otherModels: models.other,
      };
    }),
    otherProjects: drillProjects.length > shown.length ? {
      groups: drillProjects.length - shown.length, newGroups: drillProjects.slice(shown.length).filter(part => toGroup(part, k).isNew).length,
      dayCostUsd: drillProjects.slice(shown.length).reduce((sum, part) => sum + part.day, 0),
      baselineMeanUsd: drillProjects.slice(shown.length).reduce((sum, part) => sum + part.base / k, 0),
      changeUsd: drillProjects.slice(shown.length).reduce((sum, part) => sum + toGroup(part, k).changeUsd, 0),
    } : null,
  };

  return {
    order: SPEND_RULE.order,
    baselineDays: baseline.length,
    keptBaselineDays: k,
    excludedBaselineDates: baseline.filter(entry => entry.cost > cutoff).map(entry => bucketLabel(entry.ts, "day", tz)),
    dayCostUsd: dayCost,
    baselineMedianUsd,
    baselineMeanUsd,
    changeUsd: dayCost - baselineMeanUsd,
    unpriced: {
      dayRequests: unpriced.dayRequests, dayTokens: unpriced.dayTokens,
      baselineMeanRequests: unpriced.baseRequests / k, baselineMeanTokens: unpriced.baseTokens / k,
      requestChange: unpriced.dayRequests - unpriced.baseRequests / k, tokenChange: unpriced.dayTokens - unpriced.baseTokens / k,
    },
    attribution: {
      dayRequests: attribution.dayRequests, attributedRequests: attribution.attributed, dayPricedCostUsd: attribution.dayCost,
      attributedPricedCostUsd: attribution.attributedCost, baselineRequests: attribution.baseRequests, baselineAttributedRequests: attribution.baseAttributed,
    },
    cuts: {
      project: projectCut,
      model: cut(grouped(modelPart), k, TOP_GROUPS, withLink("model")),
      tokenClass: cut(grouped(classPart), k, TOP_GROUPS),
      session: cut([...sessions.values()], k, TOP_GROUPS, withLink("session")),
    },
    drilldown,
  };
}

function dayRecord(day: DayAggregate | undefined, ts: number, next: number, tz: string, window: AnalysisWindow, judgement: Judgement, baseline: readonly DayAggregate[], now: number) {
  const edge = ts < window.from || next > window.to;
  return {
    ts, date: bucketLabel(ts, "day", tz), dayStart: ts, dayEnd: next, from: Math.max(ts, window.from), to: Math.min(next, window.to),
    hours: (next - ts) / 3_600_000,
    requests: day?.requests ?? 0, pricedRequests: day?.priced ?? 0, unpricedRequests: (day?.requests ?? 0) - (day?.priced ?? 0), tokens: day?.tokens ?? 0,
    pricedCostUsd: day && day.priced > 0 ? day.cost : null,
    state: judgement.state,
    partialReason: judgement.state === "partial" ? (next > now ? "in-progress" as const : "window-edge" as const) : null,
    edge,
    insufficientReason: judgement.insufficientReason,
    baseline: {
      activeDays: baseline.length,
      medianUsd: judgement.medianUsd, thresholdUsd: judgement.thresholdUsd, ratio: judgement.ratio,
      firstDate: baseline.length ? bucketLabel(baseline[0]!.ts, "day", tz) : null,
      lastDate: baseline.length ? bucketLabel(baseline.at(-1)!.ts, "day", tz) : null,
      pricedRequests: baseline.reduce((sum, entry) => sum + entry.priced, 0),
      totalRequests: baseline.reduce((sum, entry) => sum + entry.requests, 0),
    },
  };
}

type EvidenceLink = NonNullable<Group["evidence"]>;

function caseLinker(filter: RowFilter, dayWindow: AnalysisWindow, baselineWindow: AnalysisWindow) {
  const href = (patch: Partial<RowFilter>, selection: EvidenceSelection): EvidenceLink => {
    const merged = { ...filter, ...patch };
    const current = evidenceFor(merged, dayWindow, selection, "all");
    const prior = evidenceFor(merged, baselineWindow, selection, "all");
    const params = new URLSearchParams(evidenceParams(current.selector));
    params.set("investigation", "spend-changes");
    params.set("priorSelector", JSON.stringify(prior.selector));
    params.set("period", "current");
    return { selector: current.selector, priorSelector: prior.selector, href: `/labs/evidence?${params}` };
  };
  return {
    day: () => href({}, { kind: "scope" }),
    contributor: (cutKind: SpendCut, ref: Record<string, string>): EvidenceLink | undefined => {
      if (cutKind === "project" && ref.project) return href({}, { kind: "project", project: ref.project });
      if (cutKind === "session" && ref.source && ref.conversationId) return href({}, { kind: "session", source: ref.source as Source, conversationId: ref.conversationId });
      if (cutKind === "model" && ref.source && ref.model) return href({ sources: [ref.source as Source], providers: [ref.provider!], models: [ref.model] }, { kind: "scope" });
      return undefined;
    },
  };
}

/**
 * Spike days in the window, each with its trailing baseline. `filter` is the toolbar cohort; its own
 * time bounds are ignored: the window is `window`, and baselines read loaded history before it.
 * `selectedDay` (a local date `YYYY-MM-DD`) picks which spike to decompose; by default the costliest one.
 */
export function buildSpendChanges(datasetRows: readonly RequestRow[], filter: RowFilter, window: AnalysisWindow, now: number, selectedDay?: string | null) {
  const cohort: RowFilter = { ...filter, from: undefined, to: undefined };
  const rows = filterRows(datasetRows as RequestRow[], cohort);
  const tz = window.tz;
  const days = aggregateDays(rows, tz);
  const active = days.filter(day => day.priced > 0);
  const byTs = new Map(days.map(day => [day.ts, day]));
  const firstLoadedAt = datasetRows.length ? datasetRows.reduce((min, row) => Math.min(min, row.ts), Infinity) : null;

  const records = bucketStarts("day", window.from, window.to, tz).map(ts => {
    const next = nextBucketStart(ts, "day", tz);
    const day = byTs.get(ts);
    const baseline = baselineBefore(active, ts);
    const complete = ts >= window.from && next <= window.to && next <= now;
    return { record: dayRecord(day, ts, next, tz, window, judge(day, baseline, complete), baseline, now), day, baseline };
  });
  const spikes = records.filter(entry => entry.record.state === "spike");
  const chosen = selectedDay
    ? records.find(entry => entry.record.date === selectedDay)
    : [...spikes].sort((a, b) => b.record.pricedCostUsd! - a.record.pricedCostUsd!)[0];
  if (selectedDay && !chosen) return { error: "day" as const };

  let selected = null;
  if (chosen) {
    const { record, day, baseline } = chosen;
    const eligible = record.state === "spike" && day && baseline.length;
    const dayWindow: AnalysisWindow = { from: record.dayStart, to: record.dayEnd, tz, label: windowLabel(record.dayStart, record.dayEnd, tz) };
    const baselineWindow: AnalysisWindow | null = baseline.length ? { from: baseline[0]!.ts, to: record.dayStart, tz, label: windowLabel(baseline[0]!.ts, record.dayStart, tz) } : null;
    const linker = baselineWindow ? caseLinker(cohort, dayWindow, baselineWindow) : null;
    selected = {
      day: record,
      decomposition: eligible ? decompose(day!.rows, baseline, tz, linker ? linker.contributor : undefined) : null,
      baselineDays: baseline.map(entry => ({
        date: bucketLabel(entry.ts, "day", tz), pricedCostUsd: entry.cost, pricedRequests: entry.priced, requests: entry.requests,
      })),
      evidence: eligible && linker ? linker.day() : null,
      limitations: eligible ? [] : [record.state === "spike" ? "No baseline days." : `This day is ${record.state}, so it is not decomposed.`],
    };
  }

  const windowRows = filterRows(datasetRows as RequestRow[], { ...cohort, from: window.from, to: window.to });
  const pricedWindow = windowRows.filter(row => row.priced);
  const totalCost = pricedWindow.reduce((sum, row) => sum + row.cost, 0);
  const spikeCost = spikes.reduce((sum, entry) => sum + entry.record.pricedCostUsd!, 0);
  return {
    ok: true as const,
    analysis: "spend-changes" as const,
    version: 1 as const,
    ...analysisScope(cohort, window),
    rule: SPEND_RULE,
    pricingBasis: "currently-loaded-api-list-price-equivalents" as const,
    history: {
      basis: "earliest-loaded-request" as const, firstLoadedAt: firstLoadedAt === null || !Number.isFinite(firstLoadedAt) ? null : firstLoadedAt, completeness: "unknown" as const,
      note: "Earliest loaded request is a history limit, not proof of uninterrupted collection. Days before it are insufficient, never normal.",
    },
    coverage: {
      windowDays: records.length,
      activeDays: records.filter(entry => entry.record.pricedRequests > 0).length,
      spikeDays: spikes.length,
      normalDays: records.filter(entry => entry.record.state === "normal").length,
      insufficientDays: records.filter(entry => entry.record.state === "insufficient").length,
      partialDays: records.filter(entry => entry.record.state === "partial").length,
      totalRequests: windowRows.length,
      pricedRequests: pricedWindow.length,
      unpricedRequests: windowRows.length - pricedWindow.length,
      pricedCostUsd: pricedWindow.length ? totalCost : null,
      spikeCostUsd: spikes.length ? spikeCost : null,
      spikeCostShare: spikes.length && totalCost > 0 ? spikeCost / totalCost : null,
      attributedRequests: windowRows.filter(row => row.cwd !== null).length,
      projectCoverage: projectCoverage(datasetRows as RequestRow[], { ...cohort, from: window.from, to: window.to }),
    },
    days: records.map(entry => entry.record),
    selected,
  };
}

export type SpendChangesResponse = Exclude<ReturnType<typeof buildSpendChanges>, { error: "day" }>;

/**
 * The fixed case for one spike day: detection and decomposition recomputed from exactly the rows
 * of the day's window and of the baseline window just before it (same cohort and selection).
 */
export function spendCaseObservation(dayRows: readonly RequestRow[], baselineRows: readonly RequestRow[], dayWindow: AnalysisWindow) {
  const tz = dayWindow.tz;
  const baselineDays = aggregateDays(baselineRows, tz).filter(day => day.priced > 0);
  const baseline = baselineDays.slice(-SPEND_RULE.baselineActiveDays);
  const [day] = aggregateDays(dayRows, tz).filter(entry => entry.ts === dayWindow.from);
  const judgement = judge(day, baseline, true);
  // A selection narrower than the whole cohort may be unremarkable on its own; its change is still decomposed.
  const decomposition = (judgement.state === "spike" || judgement.state === "normal") && day ? decompose(day.rows, baseline, tz) : null;
  return { day: dayRecord(day, dayWindow.from, dayWindow.to, tz, dayWindow, judgement, baseline, Infinity), decomposition, baselineDays: baseline.map(entry => ({ date: bucketLabel(entry.ts, "day", tz), pricedCostUsd: entry.cost, pricedRequests: entry.priced, requests: entry.requests })) };
}
