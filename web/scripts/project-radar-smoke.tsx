/** Run: scripts/bun web/scripts/project-radar-smoke.tsx (synthetic API + SSR only). */
import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_FILTERS, filtersFromParams, filtersToParams } from "../src/api";
import { YaldiSmokeProviders } from "./yaldi-smoke";
import { FiltersProvider } from "../src/lib/useFilters";
import { labsFilters } from "../src/lib/labsFilters";
import { ProjectRadar, ProjectRadarResult, projectLabel, projectRadarEvidenceHref } from "../src/pages/labs/ProjectRadar";
import type { ProjectRadarResponse } from "../src/types";
import { RADAR_DAY, RADAR_FROM, RADAR_TO, RADAR_WINDOW, projectRadarFixture } from "./project-radar-fixture";

const fixture = await projectRadarFixture();
const { api } = await import("../../server/src/api");
const { getDataset } = await import("../../server/src/ocx/store");
const { buildProjectRadar } = await import("../../server/src/labs/projects");
const { filterRows } = await import("../../server/src/analytics");
const { createProjectIdentity } = await import("../../server/src/projects");
const { parseWindow } = await import("../../server/src/time/window");
const dataset = await getDataset();
const periods = ["current", "prior"] as const;
const decode = (value: string) => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
let assertions = 0;
function check(condition: unknown, label: string) { assert.ok(condition, label); assertions++; }
function render(data: ProjectRadarResponse, theme: "light" | "dark" = "light") {
  return decode(renderToStaticMarkup(<YaldiSmokeProviders theme={theme}><MemoryRouter><ProjectRadarResult data={data} /></MemoryRouter></YaldiSmokeProviders>));
}
async function payload(patch: Record<string, string> = {}) {
  const params = new URLSearchParams({ ...RADAR_WINDOW, ...patch });
  const response = await api.request(`/api/labs/projects?${params}`);
  assert.equal(response.status, 200);
  return { data: await response.json() as ProjectRadarResponse, params };
}
function verifyPayload(data: ProjectRadarResponse, label: string) {
  const ranking = render(data);
  check(!/NaN|Infinity|Invalid Date|undefined|\[object Object\]/.test(ranking), `${label}: finite complete rendering`);
  if (data.current.totals.requests === 0 && data.prior.totals.requests === 0) {
    check(ranking.includes("No requests to investigate") && !ranking.includes("See the requests"), `${label}: empty state with no invented evidence or chart`);
    return;
  }
  // Every project is in the table, with a pair of evidence links that keep the original windows.
  const table = ranking.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  for (const project of data.projects.slice(0, 5)) check(table.includes(projectLabel(project.project)), `${label}: ${project.project} is listed`);
  for (const project of data.projects) {
    for (const period of periods) {
      const href = projectRadarEvidenceHref(project, period);
      const url = new URL(href, "http://fixture.invalid");
      const currentParams = new URL(project.current.evidence.href, "http://fixture.invalid").searchParams;
      for (const [key, value] of currentParams) assert.equal(url.searchParams.get(key), value, `${label}: original evidence mirror/selector ${key}`);
      assert.equal(url.searchParams.get("investigation"), "project-radar");
      assert.equal(url.searchParams.get("period"), period);
      assert.deepEqual(JSON.parse(url.searchParams.get("selector")!), project.current.evidence.selector);
      assert.deepEqual(JSON.parse(url.searchParams.get("priorSelector")!), project.prior.evidence.selector);
      assertions += 5;
      // Replay decoded selectors against the same actual normalized API dataset.
      const selector = JSON.parse(url.searchParams.get(period === "current" ? "selector" : "priorSelector")!);
      const identity = createProjectIdentity();
      const selectedRows = filterRows(dataset.rows, { ...selector.cohort, conversationId: selector.cohort.conversationId ?? undefined, from: selector.window.from, to: selector.window.to })
        .filter(row => identity(row.cwd).project === selector.selection.project);
      assert.equal(selectedRows.length, project[period].totals.requests);
      assert.equal(selectedRows.reduce((sum, row) => sum + row.totalTokens, 0), project[period].totals.tokens);
      check(Math.abs(selectedRows.filter(row => row.priced).reduce((sum, row) => sum + row.cost, 0) - project[period].totals.pricedCostUsd) < 1e-10, `${label}: evidence cost reconciles`);
      assertions += 2;
    }
  }
  console.log(`PASS L03 ${label}: ranking, comparisons and paired evidence`);
}

try {
  const full = await payload();
  assert.equal(full.data.current.totals.requests, 10);
  assert.equal(full.data.prior.totals.requests, 6);
  assert.equal(full.data.window.from, RADAR_FROM);
  assert.equal(full.data.window.to, RADAR_TO);
  assert.equal(full.data.priorWindow.from, RADAR_FROM - 4 * RADAR_DAY);
  verifyPayload(full.data, "full mixed-source API payload");
  const alpha = full.data.projects.find(project => project.project === fixture.alpha)!;
  assert.equal(alpha.comparison.requests.state, "compared");
  assert.equal(alpha.comparison.pricedCostUsd.state, "compared");
  assert.equal(full.data.projects.find(project => project.project === fixture.beacon)!.comparison.requests.state, "new");
  assert.equal(full.data.projects.find(project => project.project === fixture.zero)!.current.totals.pricedCostUsd, 0);
  assert.equal(full.data.projects.find(project => project.project === fixture.noPrice)!.comparison.pricedCostUsd.state, "insufficient");
  assert.equal(alpha.current.models.filter(model => model.model === "radar,model").length, 2);
  check(alpha.current.daily.some(day => day.pricedRequests > 0 && day.pricedCostUsd === 0) && alpha.current.daily.some(day => day.pricedRequests === 0), "Observed daily zero and missing daily price are distinct");
  const combined = await payload({ sources: "ocx", projects: fixture.alpha, providers: "synthetic", models: "radar-metered", efforts: "high", statuses: "ok", routeKinds: "native", conversationId: "collision", search: "radar" });
  assert.equal(combined.data.current.totals.requests, 2);
  assert.equal(combined.data.prior.totals.requests, 2);
  verifyPayload(combined.data, "combined filters API payload");
  const filtered = await payload({ sources: "ocx", projects: fixture.alpha });
  check(filtered.data.current.coverage.projectExclusions!.attribution.unattributed.rows > 0, "Filtered exclusions exist outside strict totals");
  verifyPayload(filtered.data, "project filter and excluded populations");
  verifyPayload((await payload({ projects: fixture.noPrice })).data, "no-price project");
  verifyPayload((await payload({ projects: fixture.zero })).data, "priced zero project");
  verifyPayload((await payload({ from: String(RADAR_FROM - 4 * RADAR_DAY - 1), to: String(RADAR_FROM - 4 * RADAR_DAY + 1) })).data, "missing baseline history");
  verifyPayload((await payload({ projects: "/no/synthetic/project" })).data, "empty cohort");
  verifyPayload((await payload({ from: "2026-11-01", to: "2026-11-02", tz: "UTC" })).data, "empty windows");
  const typed = buildProjectRadar(dataset.rows, { projects: [`${fixture.root}/work/{alpha,beacon}`], models: ["radar,model"] }, parseWindow(RADAR_WINDOW, { now: Date.now(), first: dataset.rows[0]!.ts }));
  verifyPayload(typed, "server payload with comma-bearing typed arrays");

  const pricedZero = await payload({ from: String(RADAR_FROM + RADAR_DAY), to: String(RADAR_FROM + 3 * RADAR_DAY), projects: fixture.alpha, models: "radar-metered" });
  assert.equal(pricedZero.data.projects[0]!.current.totals.pricedCostUsd, 0);
  assert.equal(pricedZero.data.projects[0]!.comparison.pricedCostUsd.state, "compared");
  for (const theme of ["light", "dark"] as const) {
    const html = render(full.data, theme);
    check(html.includes("spent more") || html.includes("spent less") || html.includes("No project changed in cost"), `${theme}: verdict renders`);
  }

  // Exercise the production hook/query key, not only the result renderer.
  for (const { params } of [full, combined]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const query = filtersToParams(labsFilters(filtersFromParams(params)));
    const response = await api.request(`/api/labs/projects?${query}`);
    assert.equal(response.status, 200);
    const data = await response.json() as ProjectRadarResponse;
    for (const key of ["providers", "efforts", "statuses", "routeKinds"] as const) assert.deepEqual(data.cohort[key], []);
    client.setQueryData(["/api/labs/projects", query], data);
    const html = decode(renderToStaticMarkup(<QueryClientProvider client={client}><YaldiSmokeProviders><MemoryRouter initialEntries={[`/labs/project-radar?${params}`]}><FiltersProvider><ProjectRadar /></FiltersProvider></MemoryRouter></YaldiSmokeProviders></QueryClientProvider>));
    check(html.includes(projectLabel(data.projects[0]!.project)) && html.includes("Top projects by cost"), "Hook consumes the full response for its complete filter key");
    client.clear();
  }
  const stateClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const renderState = () => renderToStaticMarkup(<QueryClientProvider client={stateClient}><YaldiSmokeProviders><MemoryRouter><FiltersProvider><ProjectRadar /></FiltersProvider></MemoryRouter></YaldiSmokeProviders></QueryClientProvider>);
  check(renderState().includes("Loading investigation"), "Pending query uses shared loading state");
  stateClient.clear();
  console.log(`PASS L03 ${assertions} payload/SSR assertions; synthetic inputs only`);
} finally {
  await fixture.cleanup();
}
