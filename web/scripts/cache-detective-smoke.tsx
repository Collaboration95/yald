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
import { formatUsd } from "../src/lib/format";
import { CacheResults } from "../src/pages/labs/CacheDetective";
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
  const render = (data: CacheEconomicsResponse) => {
    const html = renderToStaticMarkup(<MemoryRouter><YaldiSmokeProviders><CacheResults data={data} /></YaldiSmokeProviders></MemoryRouter>);
    assert(!/NaN|Invalid Date|Infinity|\[object Object\]/.test(html));
    return html;
  };
  /** The hook path with nothing cached: loading, and the disabled shell never queries. */
  const renderShell = (filters: Filters, labsEnabled: boolean) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/labs/cache-detective?${filtersToParams(filters)}`]}>
      <FiltersProvider><YaldiSmokeProviders labsEnabled={labsEnabled}>
        <Routes><Route path="/labs" element={<LabsLayout />}><Route path=":investigation" element={<LabsInvestigationPage />} /></Route></Routes>
      </YaldiSmokeProviders></FiltersProvider>
    </MemoryRouter></QueryClientProvider>);
    if (!labsEnabled) assert.equal(client.getQueryCache().getAll().length, 0);
    client.clear();
    return html;
  };
  const check = (label: string, fn: () => void) => { fn(); checks++; console.log(`PASS L05 ${label}`); };
  const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1]!.replace(/&amp;/g, "&"), "http://fixture.invalid")).filter(url => url.pathname === "/labs/evidence");
  /** Every evidence link is one of the server's own selectors, with only the investigation and eligibility appended. */
  const exactEvidence = (html: string, expected: CacheEconomicsTotals[]) => {
    const links = hrefs(html);
    assert(links.length > 0);
    for (const url of links) {
      const match = expected.find(item => JSON.stringify(item.evidence.selector) === url.searchParams.get("selector"));
      assert(match, "link carries a server selector");
      const server = new URL(match.evidence.href, "http://fixture.invalid");
      for (const [key, value] of server.searchParams) assert.equal(url.searchParams.get(key), value);
      assert.equal(url.searchParams.get("investigation"), "cache-detective");
      assert.equal(url.searchParams.get("eligibility"), "cache");
      assert.equal(url.searchParams.has("range"), false);
      assert.equal(match.evidence.selector.eligibility, "cache");
      assert.deepEqual(match.evidence.selector.window, { from: CACHE_FIXTURE_FROM, to: CACHE_FIXTURE_TO, tz: "Asia/Singapore", label: match.evidence.selector.window.label });
    }
    return links;
  };

  for (const [search, direction, net] of [
    ["case-positive", "benefit", 0.515],
    ["case-negative", "cost", -0.214],
    ["case-even", "even", 0],
    ["case-zero", "even", 0],
    ["case-tiny-positive", "benefit", 0.000001],
    ["case-tiny-negative", "cost", -0.000001],
    ["case-free", "even", 0],
  ] as const) {
    const data = await payload({ ...base, search });
    const html = render(data);
    check(`${search}: actual API ${direction}, headline and evidence`, () => {
      assert.equal(data.totals.direction, direction);
      assert.equal(data.totals.netUsd, net);
      assert(data.totals.eligibleRequests > 0);
      assert(html.includes(direction === "cost" ? "Caching cost" : direction === "even" ? "Caching roughly broke even" : "Caching saved"));
      assert(html.includes(formatUsd(direction === "cost" ? Math.abs(net) : net)) || direction === "even");
      assert(html.includes("See the requests") && html.includes("Reads vs writes"));
      exactEvidence(html, [data.totals, ...data.sessions]);
    });
  }

  for (const [search, reason] of [
    ["case-partial-unpriced", "unpriced"], ["case-unmeasured", "cache-unmeasured"], ["case-input-missing", "input-missing"],
    ["case-partial-synthesized", "cache-synthesized"], ["case-unknown", "cache-unknown"], ["case-estimated", "usage-estimated"],
    ["case-attempts", "attempt-sum"], ["case-incomplete", "economics-unavailable"], ["case-rate-gap", "rate-unavailable"], ["case-mismatch", "accounting-mismatch"],
  ] as const) {
    const data = await payload({ ...base, search });
    const html = render(data);
    check(`${search}: engine loaded but comparison unavailable (${reason})`, () => {
      assert.equal(data.pricing.available, true);
      assert.equal(data.totals.eligibleRequests, 0);
      assert.equal(data.totals.direction, "insufficient");
      assert.equal(data.totals.excluded[reason], 1);
      assert.equal(data.totals.netUsd, 0);
      assert(html.includes("Not enough cache data to compare"));
      assert(!html.includes("See the requests") && !html.includes("Reads vs writes"));
    });
  }

  const partial = await payload({ ...base, search: "case-partial" });
  check("partial coverage keeps the eligible money", () => {
    assert.equal(partial.totals.totalRequests, 3);
    assert.equal(partial.totals.eligibleRequests, 1);
    assert.equal(partial.totals.netUsd, 0.515);
    const html = render(partial);
    assert(html.includes(formatUsd(0.515)));
    exactEvidence(html, [partial.totals, ...partial.sessions]);
  });

  const collisions = await payload({ ...base, search: "collision" });
  check("colliding conversation IDs remain separate source-qualified sessions", () => {
    assert.equal(collisions.sessionCount, 2);
    assert.deepEqual(new Set(collisions.sessions.map(session => session.source)), new Set(["ocx", "claude-code"]));
    assert(collisions.sessions.every(session => session.conversationId === CACHE_COLLISION_ID));
    assert.notEqual(collisions.sessions[0]!.key, collisions.sessions[1]!.key);
    exactEvidence(render(collisions), [collisions.totals, ...collisions.sessions]);
  });

  const unnamed = await payload({ ...base, search: "case-unnamed" });
  check("unnamed rows remain in scope and retain unnamed/cache evidence intent", () => {
    assert.equal(unnamed.sessions.length, 0);
    assert.equal(unnamed.totals.netUsd, -0.107);
    assert.deepEqual(unnamed.totals.excluded, unnamed.unnamed.excluded);
    exactEvidence(render(unnamed), [unnamed.totals, unnamed.unnamed]);
    assert.deepEqual(unnamed.unnamed.evidence.selector.selection, { kind: "unnamed" });
  });

  const all = await payload(base);
  check("every exclusion partitions the scope", () => {
    assert.equal(all.totals.eligibleRequests + Object.values(all.totals.excluded).reduce((sum, count) => sum + count, 0), all.totals.totalRequests);
    assert.equal(all.totals.derivedRateRequests, 1);
    assert.equal(all.totals.lowerBoundRequests, 1);
    render(all);
  });

  const fromBoundary = await payload({ ...base, search: "case-from-boundary" });
  const toBoundary = await payload({ ...base, search: "case-to-boundary" });
  check("half-open bounds include the first instant and exclude the last", () => {
    assert.equal(fromBoundary.totals.totalRequests, 1);
    assert.equal(fromBoundary.totals.firstTs, CACHE_FIXTURE_FROM);
    assert.equal(toBoundary.totals.totalRequests, 0);
    assert(render(fromBoundary).includes(formatUsd(0.515)));
    assert(render(toBoundary).includes("No requests to investigate"));
  });

  const bounded = { ...base, sources: ["ocx"], projects: ["/synthetic/l05/app"], providers: ["synthetic"], models: ["l05-normal"], efforts: ["high"], statuses: ["ok"], routeKinds: ["native"], conversationId: CACHE_COLLISION_ID, search: "case-positive" };
  const scoped = await payload(bounded);
  check("all filters, source, project, and exact fixed window survive into the evidence", () => {
    assert.equal(scoped.totals.totalRequests, 1);
    assert.equal(scoped.totals.netUsd, 0.515);
    assert.deepEqual(scoped.scope.cohort.sources, ["ocx"]);
    assert.deepEqual(scoped.scope.cohort.projects, bounded.projects);
    exactEvidence(render(scoped), [scoped.totals, ...scoped.sessions]);
  });

  const coverage = await payload({ ...base, sources: ["ocx"], projects: ["/synthetic/l05/app"], models: ["l05-normal"] });
  check("project attribution gaps remain separate from money exclusions", () => {
    assert.equal(coverage.coverage?.attribution.outsideProjects.rows, 1);
    assert.equal(coverage.coverage?.unattributedRows, 1);
  });

  const limited = await payload({ ...base, search: "limit-" });
  check("session limit does not hide full scope totals", () => {
    assert.equal(limited.sessionCount, 105);
    assert.equal(limited.sessions.length, 100);
    assert.equal(limited.totals.totalRequests, 105);
  });

  const empty = await payload({ ...base, search: "does-not-match" });
  check("empty, loading and disabled states remain semantic", () => {
    assert.equal(empty.totals.totalRequests, 0);
    const html = render(empty);
    assert(html.includes("No requests to investigate"));
    assert(renderShell(base, true).includes("Loading cache savings"));
    assert(renderShell(base, false).includes("Labs is off"));
  });
  console.log(`L05: ${checks} focused synthetic API/SSR checks passed.`);
} finally {
  Date.now = originalNow;
  await fixture.cleanup();
}
