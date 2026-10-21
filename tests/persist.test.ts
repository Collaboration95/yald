import { expect, test } from "bun:test";
import {
  adoptSavedResponses, currentVersion, MAX_AGE_MS, MAX_ENTRIES, MAX_ENTRY_SIZE, retain, savedResponse, savedTime, saveResponse,
  storageKey, type SavedResponse,
} from "../web/src/lib/persist";

const now = 1_791_000_000_000;
const entry = (url: string, savedAt: number, body: unknown = { ok: true }, version = currentVersion()): SavedResponse =>
  ({ key: storageKey(url, version), url, savedAt, etag: `W/"${url}"`, size: 10, body });

test("saved responses are keyed by URL, app build and response version, and other versions are dropped", () => {
  expect(storageKey("/api/cost?range=30d")).toBe(`${currentVersion()}|/api/cost?range=30d`);
  const current = entry("/api/cost?range=30d", now - 1_000);
  const otherBuild = entry("/api/cost?range=30d", now - 1_000, {}, "0.1.0+old|1");
  const otherShape = entry("/api/usage?range=30d", now - 1_000, {}, `${currentVersion().split("|")[0]}|0`);
  const { keep, drop } = retain([current, otherBuild, otherShape], now);
  expect(keep).toEqual([current]);
  expect(drop.sort()).toEqual([otherBuild.key, otherShape.key].sort());
});

test("saved responses are bounded by age and count, newest first, and a clock in the past drops future entries", () => {
  const old = entry("/api/old", now - MAX_AGE_MS - 1);
  const future = entry("/api/future", now + 60_000);
  const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => entry(`/api/n${i}`, now - i * 1_000));
  const { keep, drop } = retain([old, future, ...many], now);
  expect(keep.map(item => item.url)).toEqual(many.slice(0, MAX_ENTRIES).map(item => item.url));
  expect(drop).toContain(old.key);
  expect(drop).toContain(future.key);
  expect(drop).toHaveLength(7);
});

test("a stored body round-trips null as null and is recognised as saved only until replaced", () => {
  // IndexedDB stores structured clones: unavailable (null) must not come back as zero or be dropped.
  const body = { summary: { cost: null, latency: { p50: null, p95: 12 } }, series: [null, 0, 3] };
  const stored = structuredClone(entry("/api/overview?range=30d", now - 5_000, body));
  expect(stored.body).toEqual(body);
  adoptSavedResponses([stored], now);
  expect(savedResponse("/api/overview?range=30d")).toBe(stored);
  expect(savedTime(stored.body)).toBe(now - 5_000);
  // A response saved by this page load is current, not "as of" an earlier load.
  const fresh = { summary: { cost: null } };
  saveResponse("/api/overview?range=30d", fresh, 'W/"fresh"', 20);
  expect(savedResponse("/api/overview?range=30d")!.body).toBe(fresh);
  expect(savedTime(fresh)).toBeUndefined();
});

test("responses too large to be worth keeping are not saved", () => {
  saveResponse("/api/export-like", { rows: [] }, null, MAX_ENTRY_SIZE + 1);
  expect(savedResponse("/api/export-like")).toBeUndefined();
});
