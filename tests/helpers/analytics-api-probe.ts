// Run by analytics.test.ts in a fresh process with its complete synthetic environment.
// Keep env.ts, the dataset/route caches and the mocked clock out of the unit-test process.
import { expect, spyOn } from "bun:test";

// env.ts enforces all three data paths in test mode before the API can read them.
if (process.env.NODE_ENV !== "test") throw new Error("analytics probe requires an isolated test environment");
const { api } = await import("../../server/src/api");
const now = Number(process.argv[2]);

const paths: [string, string][] = [
  ["/api/health", "revision"], ["/api/meta", "totals"], [`/api/overview?range=7d&to=${now + 60_000}`, "summary"],
  ["/api/timeseries?range=7d", "series"], ["/api/models?range=7d", "scatter"], ["/api/usage?range=7d", "composition"],
  ["/api/usage/heatmap-dates?range=all&weekday=6&hour=12&metric=tokens", "dates"],
  ["/api/cost?range=7d", "cumulative"], ["/api/performance?range=7d", "percentiles"], ["/api/reliability?range=7d", "metering"],
  ["/api/quota?range=7d", "burn"], ["/api/ledger?range=7d", "buckets"], ["/api/conversations?range=7d", "conversations"],
  ["/api/conversations/c1", "points"], ["/api/filters?range=7d", "providers"],
];
let etag = "";
for (const [path, field] of paths) {
  const response = await api.request(path);
  expect(response.status).toBe(200);
  const payload = await response.json() as Record<string, unknown>;
  expect(payload).toHaveProperty("ok", true);
  expect(payload).toHaveProperty(field);
  if (path === `/api/overview?range=7d&to=${now + 60_000}`) {
    etag = response.headers.get("etag") ?? "";
    expect(etag.length).toBeGreaterThan(0);
  }
}
expect((await api.request(`/api/overview?range=7d&to=${now + 60_000}`, { headers: { "if-none-match": etag } })).status).toBe(304);
const clock = spyOn(Date, "now").mockReturnValue(now + 7 * 86_400_000 - 30_000);
try {
  const first = await api.request("/api/overview?range=7d");
  const original = await first.json() as { summary: { requests: number }; window: { from: number; to: number } };
  expect(original.summary.requests).toBe(2);
  const rollingEtag = first.headers.get("etag")!;
  expect((await api.request("/api/overview?range=7d", { headers: { "if-none-match": rollingEtag } })).status).toBe(304);
  // Rolling windows end on the clock rounded down to the 10 s quantum: within one
  // quantum the window, the body and the ETag stay put.
  clock.mockReturnValue(now + 7 * 86_400_000 + 1);
  const sameQuantum = await api.request("/api/overview?range=7d", { headers: { "if-none-match": rollingEtag } });
  expect(sameQuantum.status).toBe(200);
  expect((await sameQuantum.json() as typeof original).window.to).toBe(now + 7 * 86_400_000);
  clock.mockReturnValue(now + 7 * 86_400_000 + 10_001);
  const expired = await api.request("/api/overview?range=7d", { headers: { "if-none-match": rollingEtag } });
  expect(expired.status).toBe(200);
  const current = await expired.json() as typeof original;
  expect(current.summary.requests).toBe(1);
  expect(current.window.to - current.window.from).toBe(168 * 3_600_000);
  expect(current.window.to).toBe(now + 7 * 86_400_000 + 10_000);
  expect(Date.now() - current.window.to).toBeLessThan(10_000);
  // A pinned end time still permits a 304 while the clock advances.
  expect((await api.request(`/api/overview?range=7d&to=${now + 60_000}`, { headers: { "if-none-match": etag } })).status).toBe(304);
} finally {
  clock.mockRestore();
}
// Half-open windows: `to` must pass the sample and ledger events recorded at `now`.
const quota = await (await api.request(`/api/quota?from=${now - 60_000}&to=${now + 1}`)).json() as { observed: { samples: number } };
expect(quota.observed.samples).toBe(1);
const ledger = await (await api.request(`/api/ledger?from=${now - 60_000}&to=${now + 1}`)).json() as { distinctSends: number };
expect(ledger.distinctSends).toBe(1);
expect((await api.request("/api/export?range=7d")).headers.get("content-type")).toContain("text/csv");
expect((await api.request("/api/conversations/missing")).status).toBe(404);
const invalidHeatmapDate = await api.request("/api/usage/heatmap-dates?weekday=7&hour=24");
expect(invalidHeatmapDate.status).toBe(400);
console.log("analytics API assertions passed");
