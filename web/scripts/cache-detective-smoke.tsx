/** Focused L05 SSR checks against the real API, with isolated synthetic homes/pricing. */
import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_FILTERS, filtersToParams, type Filters } from "../src/api";
import { FiltersProvider } from "../src/lib/useFilters";
import { YaldiSmokeProviders } from "./yaldi-smoke";
import { LabsLayout } from "../src/pages/labs/LabsLayout";
import { LabsInvestigationPage } from "../src/pages/labs/LabsPage";
import type { CacheEconomicsResponse, CacheEconomicsTotals } from "../src/types";
import { CACHE_COLLISION_ID, CACHE_FIXTURE_FROM, CACHE_FIXTURE_TO, materializeCacheDetectiveFixture } from "./cache-detective-fixture";

const fixture = await materializeCacheDetectiveFixture();
const originalNow = Date.now;
Date.now = () => CACHE_FIXTURE_TO;
let checks = 0;
const base: Filters = { ...DEFAULT_FILTERS, from: String(CACHE_FIXTURE_FROM), to: String(CACHE_FIXTURE_TO), tz: "Asia/Singapore", search: "case-" };
try {
  const { api } = await import("../../server/src/api");
  const payload = async (filters: Filters) => {
    const response = await api.fetch(new Request(`http://fixture.invalid/api/labs/cache?${filtersToParams(filters, { limit: 100 })}`));
    assert.equal(response.status, 200);
    return await response.json() as CacheEconomicsResponse;
  };
  const render = (filters: Filters, data?: CacheEconomicsResponse, state?: "error" | "disabled", theme: "light" | "dark" = "light", hideArtwork = true) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
    const key = ["/api/labs/cache", filtersToParams(filters, { limit: 100 })];
    if (data) client.setQueryData(key, data);
    if (state === "error") client.getQueryCache().build(client, { queryKey: key }).setState({ status: "error", error: new Error("Synthetic cache API failure"), fetchStatus: "idle" });
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/labs/cache-detective?${filtersToParams(filters)}`]}>
      <FiltersProvider><YaldiSmokeProviders theme={theme} hideArtwork={hideArtwork} labsEnabled={state !== "disabled"}>
        <Routes><Route path="/labs" element={<LabsLayout />}><Route path=":investigation" element={<LabsInvestigationPage />} /></Route></Routes>
      </YaldiSmokeProviders></FiltersProvider>
    </MemoryRouter></QueryClientProvider>);
    if (state === "disabled") assert.equal(client.getQueryCache().getAll().length, 0);
    client.clear();
    assert(!/NaN|Invalid Date|Infinity|\[object Object\]/.test(html));
    return html;
  };
  const check = (label: string, fn: () => void) => { fn(); checks++; console.log(`PASS L05 ${label}`); };
  const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1]!.replace(/&amp;/g, "&"), "http://fixture.invalid")).filter(url => url.pathname === "/labs/evidence");
  const exactEvidence = (html: string, expected: CacheEconomicsTotals[]) => {
    const links = hrefs(html);
    assert.equal(links.length, expected.length);
    links.forEach((url, index) => {
      const evidence = expected[index]!.evidence;
      const server = new URL(evidence.href, "http://fixture.invalid");
      for (const [key, value] of server.searchParams) assert.equal(url.searchParams.get(key), value);
      assert.equal(url.searchParams.get("investigation"), "cache-detective");
      assert.equal(url.searchParams.get("eligibility"), "cache");
      assert.equal(url.searchParams.has("range"), false);
      assert.deepEqual(JSON.parse(url.searchParams.get("selector")!), evidence.selector);
      assert.equal(evidence.selector.eligibility, "cache");
      assert.deepEqual(evidence.selector.window, { from: CACHE_FIXTURE_FROM, to: CACHE_FIXTURE_TO, tz: "Asia/Singapore", label: evidence.selector.window.label });
    });
  };

  for (const [search, direction, net, display] of [
    ["case-positive", "benefit", 0.515, "+$0.515000"],
    ["case-negative", "cost", -0.214, "−$0.214000"],
    ["case-even", "even", 0, "$0.000000"],
    ["case-zero", "even", 0, "$0.000000"],
    ["case-tiny-positive", "benefit", 0.000001, "+$0.000001"],
    ["case-tiny-negative", "cost", -0.000001, "−$0.000001"],
    ["case-free", "even", 0, "$0.000000"],
  ] as const) {
    const filters = { ...base, search };
    const data = await payload(filters);
    const html = render(filters, data);
    const scopeHtml = html.split("Session ranking")[0]!;
    check(`${search}: actual API ${direction} and six-decimal money`, () => {
      assert.equal(data.totals.direction, direction);
      assert.equal(data.totals.netUsd, net);
      assert(data.totals.eligibleRequests > 0);
      assert(scopeHtml.includes(display));
      for (const value of [data.totals.actualUsd, data.totals.baselineUsd, data.totals.readDiscountUsd, data.totals.writePremiumUsd]) {
        assert(scopeHtml.includes(`$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 })}`));
      }
      assert(scopeHtml.includes("effective tier rates"));
      assert(scopeHtml.includes("older gross cache-read discount"));
      assert(html.includes("not bills or realized subscription savings"));
      if (search === "case-zero") assert(html.includes("Measured zero counters support this zero comparison"));
      if (search === "case-free") assert(html.includes("explicit user-overlay zero rates"));
      exactEvidence(html, [data.totals, data.sessions[0]!]);
    });
  }

  for (const [search, reason] of [
    ["case-partial-unpriced", "unpriced"], ["case-unmeasured", "cache-unmeasured"], ["case-input-missing", "input-missing"],
    ["case-partial-synthesized", "cache-synthesized"], ["case-unknown", "cache-unknown"], ["case-estimated", "usage-estimated"],
    ["case-attempts", "attempt-sum"], ["case-incomplete", "economics-unavailable"], ["case-rate-gap", "rate-unavailable"], ["case-mismatch", "accounting-mismatch"],
  ] as const) {
    const filters = { ...base, search };
    const data = await payload(filters);
    const html = render(filters, data);
    check(`${search}: engine loaded but comparison unavailable (${reason})`, () => {
      assert.equal(data.pricing.available, true);
      assert.equal(data.totals.eligibleRequests, 0);
      assert.equal(data.totals.direction, "insufficient");
      assert.equal(data.totals.excluded[reason], 1);
      assert.equal(data.totals.netUsd, 0);
      assert(html.includes("Cache comparison unavailable"));
      assert(html.includes("Partitioned exclusion reasons"));
      assert(!html.includes("$0.000000"));
      exactEvidence(html, [data.totals, data.sessions[0]!]);
    });
  }

  const partialFilters = { ...base, search: "case-partial" };
  const partial = await payload(partialFilters);
  check("partial coverage preserves eligible money and partitioned exclusions", () => {
    assert.equal(partial.totals.totalRequests, 3);
    assert.equal(partial.totals.eligibleRequests, 1);
    assert.equal(partial.totals.netUsd, 0.515);
    const html = render(partialFilters, partial);
    assert(html.includes("Partial coverage: 1 eligible / 3 total"));
    assert(html.includes("Synthesized cache accounting:"));
    assert(html.includes("No price:"));
    exactEvidence(html, [partial.totals, partial.sessions[0]!]);
  });

  const collisionFilters = { ...base, search: "collision" };
  const collisions = await payload(collisionFilters);
  check("colliding conversation IDs remain separate source-qualified session buttons", () => {
    assert.equal(collisions.sessionCount, 2);
    assert.deepEqual(new Set(collisions.sessions.map(session => session.source)), new Set(["ocx", "claude-code"]));
    assert(collisions.sessions.every(session => session.conversationId === CACHE_COLLISION_ID));
    assert.notEqual(collisions.sessions[0]!.key, collisions.sessions[1]!.key);
    const html = render(collisionFilters, collisions);
    assert(html.includes("Inspect ocx session shared-session"));
    assert(html.includes("Inspect claude-code session shared-session"));
    exactEvidence(html, [collisions.totals, collisions.sessions[0]!]);
  });

  const unnamedFilters = { ...base, search: "case-unnamed" };
  const unnamed = await payload(unnamedFilters);
  check("unnamed rows remain in scope and retain unnamed/cache evidence intent", () => {
    assert.equal(unnamed.sessions.length, 0);
    assert.equal(unnamed.totals.netUsd, -0.107);
    assert.deepEqual(unnamed.totals.excluded, unnamed.unnamed.excluded);
    const html = render(unnamedFilters, unnamed);
    assert(html.includes("Unnamed request breakdown"));
    exactEvidence(html, [unnamed.totals, unnamed.unnamed]);
    assert.deepEqual(unnamed.unnamed.evidence.selector.selection, { kind: "unnamed" });
  });

  const all = await payload(base);
  check("every exclusion partitions the scope; derived/lower-bound/TTL notes stay visible", () => {
    assert.equal(all.totals.eligibleRequests + Object.values(all.totals.excluded).reduce((sum, count) => sum + count, 0), all.totals.totalRequests);
    assert.equal(all.totals.derivedRateRequests, 1);
    assert.equal(all.totals.lowerBoundRequests, 1);
    const html = render(base, all);
    assert(html.includes("eligible requests use derived rates"));
    assert(html.includes("net is not a guaranteed savings floor"));
    assert(html.includes("Write TTL splits are unavailable"));
    assert(html.includes("$0.000002"));
    assert(html.includes("1 eligible / 1 total · Net −$0.107000"));
  });

  const fromBoundary = await payload({ ...base, search: "case-from-boundary" });
  const toBoundary = await payload({ ...base, search: "case-to-boundary" });
  check("half-open bounds include the first instant and exclude the last", () => {
    assert.equal(fromBoundary.totals.totalRequests, 1);
    assert.equal(fromBoundary.totals.firstTs, CACHE_FIXTURE_FROM);
    assert.equal(toBoundary.totals.totalRequests, 0);
    assert(render({ ...base, search: "case-from-boundary" }, fromBoundary).includes("+$0.515000"));
    assert(render({ ...base, search: "case-to-boundary" }, toBoundary).includes("No requests to investigate"));
  });

  const bounded = { ...base, sources: ["ocx"], projects: ["/synthetic/l05/app"], providers: ["synthetic"], models: ["l05-normal"], efforts: ["high"], statuses: ["ok"], routeKinds: ["native"], conversationId: CACHE_COLLISION_ID, search: "case-positive" };
  const scoped = await payload(bounded);
  check("all filters, source, project, and exact fixed window survive rendering/evidence", () => {
    assert.equal(scoped.totals.totalRequests, 1);
    assert.equal(scoped.totals.netUsd, 0.515);
    assert.deepEqual(scoped.scope.cohort, { sources: ["ocx"], projects: bounded.projects, providers: bounded.providers, models: bounded.models, efforts: bounded.efforts, statuses: bounded.statuses, routeKinds: bounded.routeKinds, conversationId: CACHE_COLLISION_ID, search: bounded.search });
    const html = render(bounded, scoped);
    assert(html.includes("From (included)"));
    assert(html.includes('dateTime="2026-10-01T00:00:00.000Z"'));
    assert(html.includes('dateTime="2026-10-02T00:00:00.000Z"'));
    assert(html.includes("Asia/Singapore"));
    exactEvidence(html, [scoped.totals, scoped.sessions[0]!]);
  });

  const coverageFilters = { ...base, sources: ["ocx"], projects: ["/synthetic/l05/app"], models: ["l05-normal"] };
  const coverage = await payload(coverageFilters);
  check("project attribution gaps remain separate from money exclusions", () => {
    assert.equal(coverage.coverage?.attribution.outsideProjects.rows, 1);
    assert.equal(coverage.coverage?.unattributedRows, 1);
    const html = render(coverageFilters, coverage);
    assert(html.includes("1 outside the selected projects; 1 excluded because their folder is unknown"));
    assert(html.includes("Project selections exclude requests without a known folder"));
  });

  const limitedFilters = { ...base, search: "limit-" };
  const limited = await payload(limitedFilters);
  check("session limit does not hide full scope totals", () => {
    assert.equal(limited.sessionCount, 105);
    assert.equal(limited.sessions.length, 100);
    assert.equal(limited.totals.totalRequests, 105);
    const html = render(limitedFilters, limited);
    assert(html.includes("Showing 100 of 105 named sessions (limit 100)"));
    assert(html.includes("Scope and unnamed totals still include all selected requests"));
  });

  const emptyFilters = { ...base, search: "does-not-match" };
  const empty = await payload(emptyFilters);
  check("empty, loading, error/retry, and disabled states remain semantic", () => {
    assert.equal(empty.totals.totalRequests, 0);
    const html = render(emptyFilters, empty);
    assert(html.includes("No requests to investigate"));
    assert(!html.includes("$0.000000"));
    assert(render(base).includes("Loading Cache Detective"));
    const error = render(base, undefined, "error");
    assert(error.includes('role="alert"') && error.includes("Synthetic cache API failure") && error.includes("Try again"));
    assert(render(base, undefined, "disabled").includes("Labs is off"));
  });
  const zeroFilters = { ...base, search: "case-free" };
  const zero = await payload(zeroFilters);
  check("eligible zero and nonzero comparisons do not depend on the engine-loading flag", () => {
    assert(render(partialFilters, { ...partial, pricing: { available: false, detail: "Synthetic metadata-only loading change" } }).includes("+$0.515000"));
    assert(render(zeroFilters, { ...zero, pricing: { available: false, detail: "Synthetic metadata-only loading change" } }).includes("$0.000000"));
  });
  for (const theme of ["light", "dark"] as const) {
    for (const [search, supported] of [["case-positive", true], ["case-negative", true], ["case-even", true], ["case-zero", true],
      ["case-free", true], ["case-partial-unpriced", false], ["case-unmeasured", false], ["does-not-match", false]] as const) {
      const filters = { ...base, search };
      const data = await payload(filters);
      check(`B02 ${theme} ${search}: evidence-backed artwork and unchanged hidden text/links`, () => {
        const shown = render(filters, data, undefined, theme, false);
        const hidden = render(filters, data, undefined, theme, true);
        assert.equal(shown.includes(`/yaldi/state-clue-found${theme === "dark" ? "-dark" : ""}.svg`), supported);
        assert.equal(shown.replace(/<img[^>]*>/g, ""), hidden);
        assert(!hidden.includes("<img"));
        exactEvidence(shown, data.sessions.length ? [data.totals, data.sessions[0]!] : [data.totals]);
      });
    }
    check(`B02 ${theme}: retained eligible data on failed refresh has error art and no clue`, () => {
      const error = render(partialFilters, partial, "error", theme, false);
      assert(error.includes("Cache comparison could not refresh") && error.includes("state-error") && error.includes("+$0.515000"));
      assert(!error.includes("clue-found"));
      exactEvidence(error, [partial.totals, partial.sessions[0]!]);
      const engineLoading = render(zeroFilters, { ...zero, pricing: { available: false, detail: "Synthetic metadata-only loading change" } }, undefined, theme, false);
      assert(engineLoading.includes("state-clue-found"));
    });
  }
  console.log(`L05: ${checks} focused synthetic API/SSR checks passed.`);
} finally {
  Date.now = originalNow;
  await fixture.cleanup();
}
