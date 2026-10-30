import { describe, expect, test } from "bun:test";
import type { RequestRow } from "./ocx/store";
import { EPISODE_GAP_MS, outageEpisodes, statusClass } from "./episodes";

const from = 1_791_000_000_000;
const to = from + 86_400_000;
const minute = 60_000;
const measured = { outcome: true, duration: true, ttft: true, retries: true, input: true, output: true, cacheRead: true, cacheWrite: true, usage: "missing" as const };
const row = (ts: number, overrides: Partial<RequestRow> = {}): RequestRow => ({
  id: String(ts), ts, ok: false, status: 502, provider: "p1", model: "m1", errorCode: null, closeReason: null, totalTokens: 0, cost: 0, priced: false, measurements: measured, ...overrides,
} as RequestRow);
const ok = (ts: number, overrides: Partial<RequestRow> = {}) => row(ts, { ok: true, status: 200, ...overrides });
const mid = from + 6 * 3_600_000;

describe("outageEpisodes", () => {
  test("a single error has no duration and is not clipped mid-window", () => {
    const [episode] = outageEpisodes([row(mid)], { from, to }).episodes;
    expect(episode).toMatchObject({ size: 1, durationMs: null, share: 1, clippedStart: false, ongoing: false });
  });

  test("a gap of exactly 10 minutes splits; just under does not", () => {
    expect(outageEpisodes([row(mid), row(mid + EPISODE_GAP_MS)], { from, to }).episodes).toHaveLength(2);
    const joined = outageEpisodes([row(mid), row(mid + EPISODE_GAP_MS - 1)], { from, to });
    expect(joined.episodes).toHaveLength(1);
    expect(joined.episodes[0]!.durationMs).toBe(EPISODE_GAP_MS - 1);
    expect(joined.gapMs).toBe(EPISODE_GAP_MS);
  });

  test("the gap is a parameter and is echoed", () => {
    const result = outageEpisodes([row(mid), row(mid + 2 * minute)], { from, to, gapMs: minute });
    expect(result.gapMs).toBe(minute);
    expect(result.episodes).toHaveLength(2);
  });

  test("episodes at the window edges are marked as lower bounds", () => {
    const { episodes } = outageEpisodes([row(from + minute), row(to - minute)], { from, to });
    expect(episodes.find(episode => episode.start === from + minute)).toMatchObject({ clippedStart: true, ongoing: false });
    expect(episodes.find(episode => episode.start === to - minute)).toMatchObject({ clippedStart: false, ongoing: true });
  });

  test("successes inside the span separate a partial outage from a hard one", () => {
    const { episodes } = outageEpisodes([row(mid), ok(mid + minute), row(mid + 2 * minute), ok(mid + 3 * minute)], { from, to });
    expect(episodes[0]!.successesInside).toBe(1);
  });

  test("cancelled and unobserved rows are never errors", () => {
    const cancelled = row(mid, { status: 499, closeReason: "client_closed" });
    const unobserved = row(mid + minute, { measurements: { ...measured, outcome: false } });
    const result = outageEpisodes([cancelled, unobserved, row(mid + 2 * minute)], { from, to });
    expect(result.episodes).toHaveLength(1);
    expect(result.coverage).toEqual({ totalRequests: 3, observedRequests: 2, unobservedRequests: 1, errors: 1, cancelled: 1 });
  });

  test("usage comes only from rows that reported it, and is null rather than 0 when none did", () => {
    const silent = outageEpisodes([row(mid), row(mid + minute)], { from, to }).episodes[0]!;
    expect(silent.usage).toEqual({ reportedRows: 0, failedRows: 2, tokens: null, costUsd: null });
    const reporting = row(mid + 2 * minute, { totalTokens: 50, cost: 0.25, priced: true, measurements: { ...measured, usage: "logical" } });
    const mixed = outageEpisodes([row(mid), reporting], { from, to }).episodes[0]!;
    expect(mixed.usage).toEqual({ reportedRows: 1, failedRows: 2, tokens: 50, costUsd: 0.25 });
  });

  test("concentration is cumulative from the largest episode, with its marks", () => {
    const burst = [0, 1, 2].map(n => row(mid + n * minute));
    const result = outageEpisodes([...burst, row(mid + 3 * 3_600_000)], { from, to });
    expect(result.concentration).toEqual([{ episodes: 1, errors: 3, share: 0.75 }, { episodes: 2, errors: 4, share: 1 }]);
    expect(result.marks).toEqual({ p50: 1, p75: 1 });
  });

  test("persistence compares the next observed request with the base rate, counts shown", () => {
    const rows = [row(mid), row(mid + 1), ok(mid + 2), ok(mid + 3), ok(mid + 4, { provider: "p2" })];
    const result = outageEpisodes(rows, { from, to }).persistence;
    expect(result.afterError).toEqual({ errors: 1, total: 2, rate: 0.5 });
    expect(result.base).toEqual({ errors: 2, total: 5, rate: 0.4 });
    expect(result.byProvider.map(entry => entry.provider)).toEqual(["p1", "p2"]);
  });

  test("status classes keep the raw status and an empty window stays unavailable", () => {
    expect([statusClass(429), statusClass(401), statusClass(418)]).toEqual(["upstream or capacity", "configuration or request", "other"]);
    const [episode] = outageEpisodes([row(mid, { status: 401 })], { from, to }).episodes;
    expect(episode!.statuses).toEqual([{ name: "401", value: 1, class: "configuration or request" }]);
    const empty = outageEpisodes([], { from, to });
    expect(empty.marks).toEqual({ p50: null, p75: null });
    expect(empty.persistence.base.rate).toBeNull();
  });
});
