// Project Radar below the project (#111): which branches and PRs a project's recorded usage went to.
// A branch is a label at request time, not an identity over a project's life. Branch cost is where usage
// was recorded, not the value of the work. PR figures overlap, so they are never summed or split.
import { bucketLabel, round } from "../analytics";
import type { ClaudeEvent } from "../claude/transcripts";
import type { RequestRow } from "../ocx/store";
import { sourceOf } from "../report/source";
import type { Source } from "../report/types";
import { makeBucketer } from "../time/window";

export type BranchState = "named" | "detached" | "unrecorded";
export type BranchBasis = "request time" | "session start";
export interface RowBranch { state: BranchState; name: string | null; basis: BranchBasis | null }

const UNRECORDED: RowBranch = { state: "unrecorded", name: null, basis: null };
/** A branch's day-by-day detail is sent for the lanes of the span chart only. */
const SPAN_LANES = 12;
/** A long session can link dozens of PRs, and every branch it touched lists them. The count stays exact. */
const PR_LIMIT = 8;
/** Below this share of requests with a branch, the project's branch view is not a finding. */
export const BRANCH_MIN_RECORDED_SHARE = 0.5;

/** A recorded `HEAD`, or a Codex git record with a commit and no branch, is detached. Nothing else is inferred. */
export function branchOf(row: RequestRow): RowBranch {
  if (sourceOf(row) === "claude-code") {
    const name = row.details?.gitBranch ?? null;
    if (name === null) return UNRECORDED;
    return name === "HEAD" ? { state: "detached", name: null, basis: "request time" } : { state: "named", name, basis: "request time" };
  }
  const session = row.codexSession;
  if (!session) return UNRECORDED;
  if (session.gitBranch === "HEAD" || (session.gitBranch === null && session.commitHash)) return { state: "detached", name: null, basis: "session start" };
  return session.gitBranch === null ? UNRECORDED : { state: "named", name: session.gitBranch, basis: "session start" };
}

export const matchesBranch = (row: RequestRow, selection: { state: BranchState; branch?: string }): boolean => {
  const branch = branchOf(row);
  return branch.state === selection.state && (selection.state !== "named" || branch.name === selection.branch);
};

/** PR links per Claude session, as `owner/repo#N`. Other sources record none. */
export function pullRequestsBySession(events: readonly ClaudeEvent[]): Map<string, Set<string>> {
  const links = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind !== "pr") continue;
    const list = links.get(event.sessionId) ?? new Set<string>();
    list.add(`${event.prRepository}#${event.prNumber}`);
    links.set(event.sessionId, list);
  }
  return links;
}

interface Group {
  state: BranchState; name: string | null;
  bases: Set<BranchBasis>; sources: Map<Source, number>; sessions: Set<string>; prs: Set<string>; days: Map<number, number>;
  requests: number; tokens: number; pricedRequests: number; unpricedRequests: number; pricedCostUsd: number; firstTs: number; lastTs: number;
}

/** Real repositories also spell it `Main`. */
const isMain = (name: string | null) => name !== null && /^(main|master)$/i.test(name);
const groupOrder = (group: { state: BranchState; name: string | null }) => group.state === "unrecorded" ? 3 : group.state === "detached" ? 2 : isMain(group.name) ? 0 : 1;

/** Every row lands in exactly one group, so the groups sum to the project's totals. */
export function branchBreakdown(rows: readonly RequestRow[], tz: string, prs: ReadonlyMap<string, ReadonlySet<string>>, options: { days?: boolean } = {}) {
  const groups = new Map<string, Group>();
  const dayOf = makeBucketer("day", tz);
  const coverage = new Map<Source, { source: Source; requests: number; recorded: number }>();
  for (const row of rows) {
    const branch = branchOf(row);
    const source = sourceOf(row);
    const key = JSON.stringify([branch.state, branch.name]);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { state: branch.state, name: branch.name, bases: new Set(), sources: new Map(), sessions: new Set(), prs: new Set(), days: new Map(),
      requests: 0, tokens: 0, pricedRequests: 0, unpricedRequests: 0, pricedCostUsd: 0, firstTs: row.ts, lastTs: row.ts });
    if (branch.basis) group.bases.add(branch.basis);
    group.sources.set(source, (group.sources.get(source) ?? 0) + 1);
    if (row.conversationId !== null) {
      group.sessions.add(JSON.stringify([source, row.conversationId]));
      if (source === "claude-code") for (const link of prs.get(row.conversationId) ?? []) group.prs.add(link);
    }
    group.requests++;
    group.tokens += row.totalTokens;
    const day = dayOf(row.ts);
    group.days.set(day, (group.days.get(day) ?? 0) + (row.priced ? row.cost : 0));
    if (row.priced) { group.pricedRequests++; group.pricedCostUsd += row.cost; } else group.unpricedRequests++;
    group.firstTs = Math.min(group.firstTs, row.ts);
    group.lastTs = Math.max(group.lastTs, row.ts);
    const source_ = coverage.get(source) ?? { source, requests: 0, recorded: 0 };
    source_.requests++;
    if (branch.state !== "unrecorded") source_.recorded++;
    coverage.set(source, source_);
  }
  const ranked = [...groups.values()].sort((a, b) => b.pricedCostUsd - a.pricedCostUsd || b.tokens - a.tokens || (a.name ?? "").localeCompare(b.name ?? ""));
  const lanes = new Set(options.days === false ? [] : ranked.slice(0, SPAN_LANES));
  const list = [...ranked].sort((a, b) => groupOrder(a) - groupOrder(b));
  const countState = (test: (group: Group) => boolean) => ranked.filter(test).reduce((sum, group) => sum + group.requests, 0);
  const recorded = rows.length - countState(group => group.state === "unrecorded");
  return {
    rows: list.map(group => ({
      state: group.state, name: group.name, bases: [...group.bases].sort(), sources: [...group.sources].map(([source, requests]) => ({ source, requests })),
      sessions: group.sessions.size, requests: group.requests, tokens: group.tokens, pricedRequests: group.pricedRequests, unpricedRequests: group.unpricedRequests, pricedCostUsd: group.pricedCostUsd,
      firstTs: group.firstTs, lastTs: group.lastTs, activeDays: group.days.size, prs: [...group.prs].sort().slice(0, PR_LIMIT), prCount: group.prs.size,
      days: lanes.has(group) ? [...group.days].sort(([a], [b]) => a - b).map(([ts, costUsd]) => ({ ts, date: bucketLabel(ts, "day", tz), costUsd: round(costUsd, 4) })) : null,
    })),
    namedBranches: ranked.filter(group => group.state === "named").length,
    requests: { total: rows.length, recorded, onMain: countState(group => isMain(group.name)), detached: countState(group => group.state === "detached"), unrecorded: rows.length - recorded },
    recordedShare: rows.length ? round(recorded / rows.length, 4) : null,
    coverage: [...coverage.values()].sort((a, b) => a.source.localeCompare(b.source)),
  };
}
