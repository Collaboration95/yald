// Folders inferred from timing for `yald report --project` (#47). Report-only and labelled:
// the dashboard's cwd stays what a rollout or transcript recorded, and a row is only given a
// folder when exactly one Codex session fits. Switched off with --no-infer / infer=0.
import type { RequestRow } from "../ocx/store";
import { sourceOf } from "./source";

/** A title or setup call runs just before its rollout starts, under its own throwaway id. */
export const SIDE_CALL_WINDOW_MS = 5_000;

export type InferenceBasis = "sideCall" | "overlap";

export interface SessionSpan {
  cwd: string;
  startedAt: number;
  /** The rollout file's modification time: when it last recorded anything. */
  lastActiveAt: number;
}

export interface InferredCoverage {
  rows: number;
  tokens: number;
  /** Inferred rows that the project filter kept. */
  matchedRows: number;
  sideCall: { rows: number; tokens: number };
  overlap: { rows: number; tokens: number };
}

export interface Inferred {
  rows: RequestRow[];
  /** Which copies got their folder by inference, and how. */
  basis: Map<RequestRow, InferenceBasis>;
}

function only<T>(items: T[]): T | null {
  return items.length === 1 ? items[0]! : null;
}

/**
 * `rows` with a folder on each opencodex row that has none and exactly one candidate session:
 * a row whose id matched no rollout takes the session starting within 5 s after it; a row with no
 * id takes the only session active at that moment. Several candidates leave the row unattributed.
 * Rows are copied, never modified.
 */
export function inferFolders(rows: readonly RequestRow[], spans: readonly SessionSpan[]): Inferred {
  const basis: Inferred["basis"] = new Map();
  const result = rows.map(row => {
    if (row.cwd !== null || sourceOf(row) !== "ocx") return row;
    const kind: InferenceBasis | null = row.conversationId ? (row.rolloutMiss ? "sideCall" : null) : "overlap";
    if (!kind) return row;
    const fits = kind === "sideCall"
      ? (span: SessionSpan) => span.startedAt >= row.ts && span.startedAt - row.ts <= SIDE_CALL_WINDOW_MS
      : (span: SessionSpan) => span.startedAt <= row.ts && row.ts <= span.lastActiveAt;
    const session = only(spans.filter(fits));
    if (!session) return row;
    const copy = { ...row, cwd: session.cwd };
    basis.set(copy, kind);
    return copy;
  });
  return { rows: result, basis };
}

/** Counts of `inferred`, with those the project filter kept. */
export function inferredCoverage(inferred: Inferred, kept: (row: RequestRow) => boolean): InferredCoverage {
  const coverage: InferredCoverage = { rows: 0, tokens: 0, matchedRows: 0, sideCall: { rows: 0, tokens: 0 }, overlap: { rows: 0, tokens: 0 } };
  for (const [row, kind] of inferred.basis) {
    coverage.rows++;
    coverage.tokens += row.totalTokens;
    coverage[kind].rows++;
    coverage[kind].tokens += row.totalTokens;
    if (kept(row)) coverage.matchedRows++;
  }
  return coverage;
}
