/** Isolated process: verify the real Overview render with a demo clock behind wall time. */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { materializeFixtureHome, materializeFixturePricing } from "./fixtureHome";
import type { OverviewResponse } from "../src/types";

const fixed = Date.parse("2026-10-02T10:00:00Z");
const wallNow = Date.now;
Date.now = () => fixed;
const home = await materializeFixtureHome();
const pricing = await materializeFixturePricing();
process.env.OCX_HOME = home;
process.env.CLAUDE_PROJECTS_DIR = `${home}/claude-projects`;
process.env.CODEX_HOME = `${home}/codex`;
process.env.OCX_PACKAGE_DIR = pricing;
process.env.YALD_DEMO = "1";
process.env.YALD_DEMO_NOW = process.env.YALD_DEMO_SAMPLE_AT = String(fixed);
// Freeze wall time separately so this remains a regression even if run before/after the fixture date.
Date.now = () => fixed + 10 * 86_400_000;
try {
  // Only the demo bootstrap reads this element. Remove the stub before any React rendering.
  const globals = globalThis as unknown as { document?: { getElementById: () => { textContent: string } } };
  globals.document = { getElementById: () => ({ textContent: JSON.stringify({ synthetic: true, clock: "fixed", now: fixed, sampleAt: fixed }) }) };
  const { displayNow } = await import("../src/lib/demo");
  delete globals.document;
  assert.equal(displayNow(), fixed);
  const { api } = await import("../../server/src/api");
  const { DEFAULT_FILTERS, filtersToParams } = await import("../src/api");
  const { FiltersProvider } = await import("../src/lib/useFilters");
  const { YaldiSmokeProviders } = await import("./yaldi-smoke");
  const { OverviewPage } = await import("../src/pages/Overview");
  const params = filtersToParams(DEFAULT_FILTERS);
  const response = await api.request(`/api/overview?${params}`);
  assert.equal(response.status, 200);
  const data = await response.json() as OverviewResponse;
  const window = data.quota.windows[0];
  assert(window, "fixture must contain plan usage");
  for (const [label, updatedAt, resetAtMs, stale] of [
    ["fresh", fixed - 60_000, fixed + 3_600_000, false],
    ["old reading", fixed - 25 * 3_600_000, fixed + 3_600_000, true],
    ["expired window", fixed - 60_000, fixed - 1, true],
  ] as const) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["/api/overview", params], { ...data, quota: { ...data.quota, windows: [{ ...window, updatedAt, resetAtMs }] } });
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter><FiltersProvider><YaldiSmokeProviders>
      <OverviewPage />
    </YaldiSmokeProviders></FiltersProvider></MemoryRouter></QueryClientProvider>);
    assert(html.includes("Plan usage"));
    assert.equal(html.includes("Stale · last reading"), stale, label);
    assert.equal(html.includes("resets in 1h"), !stale, `${label}: countdown agrees with staleness`);
    client.clear();
  }
  console.log("PASS Overview fixed-clock fresh, old and expired quota renders");
} finally {
  Date.now = wallNow;
  await Promise.all([home, pricing].map(path => rm(path, { recursive: true, force: true })));
}
