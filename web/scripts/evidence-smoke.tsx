/** Isolated, real API + SSR case checks. Invoked by make smoke in its own process. */
import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { caseQuery, parseCaseIntent } from "../../server/src/labs/evidence-intent";
import { ApiError } from "../src/api";
import { ThemeContext, ThemeProvider } from "../src/lib/theme";
import { PreferencesProvider } from "../src/lib/preferences";
import { FiltersProvider } from "../src/lib/useFilters";
import { EvidenceCase, EvidenceCaseView, EvidenceRequest, evidenceMoney } from "../src/pages/labs/EvidenceCase";
import { LabsLayout } from "../src/pages/labs/LabsLayout";
import { projectRadarEvidenceHref } from "../src/pages/labs/ProjectRadar";

import { contextEvidenceHref } from "../src/pages/labs/contextReplayChart";
import type { EvidenceCaseResponse } from "../src/labs/evidence-types";
import type { CacheEconomicsResponse, ContextReplayResponse, ProjectRadarResponse } from "../src/types";
import { EVIDENCE_PARAMS, EVIDENCE_SESSION, materializeEvidenceFixture } from "./evidence-fixtures";

const fixture = await materializeEvidenceFixture();
Object.assign(process.env, fixture.env);
const realFetch = globalThis.fetch;
let checks = 0;
const check = (fn: () => void, label: string) => { fn(); checks++; console.log(`PASS  L08 ${label}`); };
const cacheEvidenceHref = (evidence: { href: string }) => {
  const url = new URL(evidence.href, "http://localhost"); url.searchParams.set("investigation", "cache-detective"); return url.pathname + url.search;
};
const plain = (html: string) => html.replace(/<!--.*?-->/g, "");
const renderView = (data: EvidenceCaseResponse, href: string, dark = false, hideArtwork = false) => plain(renderToString(
  <ThemeContext.Provider value={{ theme: dark ? "dark" : "light", toggle: () => {},
    chartTheme: { text: "", axis: "", split: "", tooltipBg: "", tooltipBorder: "", area: "" } }}>
    <PreferencesProvider storage={{ getItem: () => JSON.stringify({ version: 1, labsEnabled: true, hideArtwork }), setItem: () => {} }}>
      <MemoryRouter initialEntries={[href]}><EvidenceCaseView data={data} /></MemoryRouter>
    </PreferencesProvider>
  </ThemeContext.Provider>));
try {
  const { api } = await import("../../server/src/api");
  const { getDataset } = await import("../../server/src/ocx/store");
  const { selectCaseRows } = await import("../../server/src/labs/evidence");
  const { cacheEligibility } = await import("../../server/src/labs/cache");
  const { sourceOf } = await import("../../server/src/report/source");
  const { fetchJson } = await import("../src/api");
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => api.fetch(new Request(new URL(String(input), "http://localhost"), init))) as typeof fetch;
  const dataset = await getDataset();
  const radar = await fetchJson<ProjectRadarResponse>("/api/labs/projects", EVIDENCE_PARAMS);
  const cache = await fetchJson<CacheEconomicsResponse>("/api/labs/cache", EVIDENCE_PARAMS);
  const contextQuery = new URLSearchParams(EVIDENCE_PARAMS); contextQuery.set("search", "l07-"); contextQuery.set("efforts", "high");
  const context = await fetchJson<ContextReplayResponse>("/api/labs/context", contextQuery.toString());
  const hrefs = [
    ...radar.projects.flatMap(project => [projectRadarEvidenceHref(project, "current"), projectRadarEvidenceHref(project, "prior")]),
    ...[cache.totals, cache.unnamed, ...cache.sessions].map(totals => cacheEvidenceHref(totals.evidence)),
    ...[context.coverage.evidence, ...context.sessions.map(session => session.evidence)].map(contextEvidenceHref),
  ];
  const bodies: EvidenceCaseResponse[] = [];
  for (const href of hrefs) {
    const url = new URL(href, "http://localhost");
    const intent = parseCaseIntent(url.searchParams);
    const body = await fetchJson<EvidenceCaseResponse>("/api/labs/evidence", caseQuery(intent));
    bodies.push(body);
    const selector = body.intent.period === "prior" ? body.intent.priorSelector! : body.intent.selector;
    const selected = selectCaseRows(dataset.rows, selector);
    const expected = selector.eligibility === "cache" ? selected.filter(row => cacheEligibility(row).eligible) : selected;
    check(() => {
      assert.equal(body.population.original.requests, selected.length);
      assert.equal(body.population.evidence.requests, expected.length);
      assert.equal(body.population.eligibleRequests + body.population.excludedRequests, selected.length);
      assert.equal(body.population.evidence.tokens, expected.reduce((n, row) => n + row.totalTokens, 0));
      assert.equal(body.population.evidence.pricedCostUsd, expected.reduce((n, row) => n + (row.priced ? row.cost : 0), 0));
      assert.deepEqual(body.rows.map(row => [row.source, row.id, row.ordinal, row.originalOrdinal]), expected.slice(0, 100).map(row => [sourceOf(row), row.id, selected.indexOf(row), dataset.rows.indexOf(row)]));
    }, `${intent.investigation}/${intent.period}/${JSON.stringify(intent.selector.selection)} actual rows and full totals`);
    for (const dark of [false, true]) {
      const html = renderView(body, href, dark);
      check(() => {
        assert(html.includes(body.observation.summary.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")));
        assert(html.includes("Global toolbar changes apply to your next investigation"));
        assert(html.includes("Request evidence")); assert(html.includes("Evidence pagination"));
        assert(html.includes("Complete fixed cohort and coverage"));
        assert(html.includes(new Date(body.intent.selector.window.from).toISOString()));
        if (body.intent.priorSelector) {
          assert(html.includes("Original prior window")); assert(html.includes(new Date(body.intent.priorSelector.window.from).toISOString()));
          assert(html.includes(`Inspecting original ${body.intent.period} requests`));
        }
        for (const row of body.rows) assert(html.includes(`data-evidence-identity="${row.identity.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`));
        assert(!/NaN|Infinity|\[object Object\]/.test(html));
      }, `${dark ? "dark" : "light"} complete case, exact boundaries, bounded evidence and accessible controls`);
    }
  }
  check(() => {
    for (const body of bodies.filter(body => body.intent.investigation === "project-radar")) {
      assert.equal(body.observation.investigation, "project-radar");
      if (body.observation.investigation !== "project-radar") continue;
      const selection = body.intent.selector.selection;
      const trusted = selection.kind === "project" ? radar.projects.find(p => p.project === selection.project)! : radar;
      assert.deepEqual(body.observation.comparison, trusted.comparison);
      assert.deepEqual(body.observation.current, trusted.current);
      assert.deepEqual(body.observation.prior, trusted.prior);
    }
    const collision = bodies.filter(body => body.intent.investigation === "cache-detective" && body.intent.selector.selection.kind === "session" && body.intent.selector.selection.conversationId === EVIDENCE_SESSION);
    assert.equal(collision.length, 2);
    assert.notDeepEqual(collision[0]!.rows.map(row => row.identity), collision[1]!.rows.map(row => row.identity));
  }, "both Radar periods retain original case; Cache session source collisions remain distinct");
  const contextBody = bodies.find(body => body.intent.investigation === "context-replay" && body.intent.selector.selection.kind === "scope")!;
  check(() => {
    for (const row of contextBody.rows) {
      const html = plain(renderToString(<EvidenceRequest row={row} tz={contextBody.scope.window.tz} />));
      const detail = Object.fromEntries([...html.matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(m => [m[1], m[2]]));
      assert.equal(detail["Submitted input · tokens"], row.inputTokens === null ? "Unavailable" : row.inputTokens.toLocaleString("en-US"));
      assert.equal(detail["API list-price equivalent · USD"], evidenceMoney(row.cost));
      assert.equal(detail.Duration, row.durationMs === null ? "Unavailable" : `${row.durationMs} ms`);
      assert.equal(detail["Time to first token"], row.ttftMs === null ? "Unavailable" : `${row.ttftMs} ms`);
      if (!row.eligible) assert(html.includes(row.exclusionReason!));
    }
    assert(contextBody.rows.some(row => row.inputTokens === null));
    assert(contextBody.rows.some(row => row.inputTokens === 0 && row.cost === 0 && row.durationMs === 0));
  }, "all Context details preserve missing/attempt-summed input, observed zero, price and timing presence");

  const body = bodies[0]!;
  const url = new URL(hrefs[0]!, "http://localhost");
  const intent = parseCaseIntent(url.searchParams), queryKey = ["labs-evidence", caseQuery(intent)];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (href: string, enabled = true) => plain(renderToString(<QueryClientProvider client={client}><ThemeProvider>
    <MemoryRouter initialEntries={[href]}><FiltersProvider><PreferencesProvider storage={{ getItem: () => JSON.stringify({ version: 1, labsEnabled: enabled, hideArtwork: true }), setItem: () => {} }}>
      <Routes><Route path="/labs" element={<LabsLayout />}><Route path="evidence" element={<EvidenceCase />} /></Route></Routes>
    </PreferencesProvider></FiltersProvider></MemoryRouter></ThemeProvider></QueryClientProvider>));
  check(() => {
    assert(render(hrefs[0]!).includes("Loading case file"));
    client.setQueryData(queryKey, body);
    assert(render(hrefs[0]!).includes("Request evidence"));
    const changed = new URL(url); changed.searchParams.set("range", "7d"); changed.searchParams.delete("from"); changed.searchParams.delete("to"); changed.searchParams.set("models", "unrelated");
    assert.deepEqual(parseCaseIntent(changed.searchParams), intent);
    assert.equal(caseQuery(parseCaseIntent(changed.searchParams)), queryKey[1]);
    assert(render(changed.pathname + changed.search).includes("Request evidence"));
    assert.equal(client.getQueryCache().getAll().length, 1);
    client.getQueryCache().find({ queryKey })!.setState({ status: "error", error: new ApiError("Synthetic fixture error", 503) });
    const error = render(hrefs[0]!); assert(error.includes("Case file unavailable")); assert(error.includes("Try again")); assert(error.includes('role="alert"'));
    assert(render("/labs/evidence?investigation=unknown&selector=%7B%7D").includes("Invalid case link"));
    const before = client.getQueryCache().getAll().length;
    assert(render(hrefs[0]!, false).includes("Labs is off"));
    assert.equal(client.getQueryCache().getAll().length, before);
    client.clear();
  }, "real case hook: loading/error/retry/invalid/disabled gate, complete key and toolbar-independent cache");

  const q = new URLSearchParams(EVIDENCE_PARAMS); q.set("search", "does-not-match");
  const empty = await fetchJson<CacheEconomicsResponse>("/api/labs/cache", q.toString());
  q.set("search", "l08-unpriced"); const excluded = await fetchJson<CacheEconomicsResponse>("/api/labs/cache", q.toString());
  for (const [finding, state] of [[empty, "empty"], [excluded, "insufficient"]] as const) {
    const href = cacheEvidenceHref(finding.totals.evidence);
    const data = await fetchJson<EvidenceCaseResponse>("/api/labs/evidence", caseQuery(parseCaseIntent(new URL(href, "http://localhost").searchParams)));
    check(() => {
      assert.equal(data.observation.state, state); assert.equal(data.rows.length, 0);
      for (const dark of [false, true]) {
        const html = renderView(data, href, dark);
        const hidden = renderView(data, href, dark, true);
        assert(html.includes(state === "empty" ? "No requests in this case" : "Comparison unavailable"));
        assert(!html.includes("$0.000000"));
        assert(!html.includes("state-clue-found"));
        assert(!hidden.includes("<img"));
        assert.equal(html.replace(/<img\b[^>]*>/g, ""), hidden);
      }
    }, `${state} case uses neutral explanation and unavailable money`);
  }
  console.log(`PASS  L08 ${checks} API/render/query/coverage groups`);
} finally { globalThis.fetch = realFetch; await fixture.cleanup(); }
