// Why a request has no project folder (#55). Reasons are read off the row and never
// guessed: nothing here assigns a folder, and a row that fits no evidence-backed reason
// lands in `other`.
import type { RequestRow } from "./ocx/store";
import { sourceOf } from "./report/source";

/**
 * - `noConversationId`: an opencodex row without a conversation id, so no rollout can ever match.
 * - `noRollout`: an opencodex row whose id matched no Codex rollout in a session index that was read.
 * - `other`: no folder and neither reason is evidenced, for example a Claude transcript line
 *   without a `cwd`, or an id checked against no Codex index at all. The cause is not stated.
 */
export type UnattributedReason = "noConversationId" | "noRollout" | "other";

/** Every reason, in the order breakdowns list them. */
export const UNATTRIBUTED_REASONS: readonly UnattributedReason[] = ["noConversationId", "noRollout", "other"];

export interface ModelCount { model: string; rows: number; tokens: number }

export interface ReasonSummary {
  reason: UnattributedReason;
  rows: number;
  tokens: number;
  /** Every model behind the rows, most rows then tokens then name. */
  models: ModelCount[];
}

export interface AttributionCoverage {
  /** Rows the project filter kept. */
  matched: { rows: number; tokens: number };
  /** Rows with a known folder outside every glob. */
  outsideProjects: { rows: number; tokens: number };
  /** Rows without a folder; `reasons` always lists all three reasons and sums to rows/tokens. */
  unattributed: { rows: number; tokens: number; reasons: ReasonSummary[] };
}

/** The reason a row has no folder; null when it has one. */
export function unattributedReason(row: Pick<RequestRow, "cwd" | "protocol" | "conversationId" | "rolloutMiss">): UnattributedReason | null {
  if (row.cwd !== null) return null;
  if (sourceOf(row) === "claude-code") return "other";
  if (!row.conversationId) return "noConversationId";
  return row.rolloutMiss ? "noRollout" : "other";
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The unattributed rows grouped by reason, all reasons present. */
export function summarizeReasons(rows: Iterable<RequestRow>): ReasonSummary[] {
  const byReason = new Map(UNATTRIBUTED_REASONS.map(reason => [reason, new Map<string, ModelCount>()]));
  for (const row of rows) {
    const reason = unattributedReason(row);
    if (reason === null) continue;
    const models = byReason.get(reason)!;
    const entry = models.get(row.model) ?? { model: row.model, rows: 0, tokens: 0 };
    entry.rows++;
    entry.tokens += row.totalTokens;
    models.set(row.model, entry);
  }
  return UNATTRIBUTED_REASONS.map(reason => {
    const models = [...byReason.get(reason)!.values()].sort((a, b) => b.rows - a.rows || b.tokens - a.tokens || compare(a.model, b.model));
    return { reason, rows: models.reduce((n, m) => n + m.rows, 0), tokens: models.reduce((n, m) => n + m.tokens, 0), models };
  });
}

/**
 * Splits rows (already limited to the source and window) into those a project matcher keeps,
 * those with a folder elsewhere and those without a folder, so the three add up to the rows.
 */
export function attributionCoverage(rows: RequestRow[], inProject: (cwd: string | null) => boolean): AttributionCoverage {
  const matched = { rows: 0, tokens: 0 };
  const outsideProjects = { rows: 0, tokens: 0 };
  const missing: RequestRow[] = [];
  for (const row of rows) {
    if (row.cwd === null) missing.push(row);
    else {
      const bucket = inProject(row.cwd) ? matched : outsideProjects;
      bucket.rows++;
      bucket.tokens += row.totalTokens;
    }
  }
  const reasons = summarizeReasons(missing);
  return { matched, outsideProjects, unattributed: { rows: missing.length, tokens: reasons.reduce((n, r) => n + r.tokens, 0), reasons } };
}
