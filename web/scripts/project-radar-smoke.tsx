/** Run: scripts/bun web/scripts/project-radar-smoke.tsx (synthetic API + SSR only). */
import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_FILTERS, filtersFromParams, filtersToParams } from "../src/api";
import { YaldiSmokeProviders } from "./yaldi-smoke";
import { FiltersProvider } from "../src/lib/useFilters";
import { ProjectRadar, ProjectRadarResult, radarDailyOption } from "../src/pages/labs/ProjectRadar";
import type { ProjectRadarResponse, RadarChange, RadarTotals } from "../src/types";
import { RADAR_DAY, RADAR_FROM, RADAR_TO, RADAR_WINDOW, projectRadarFixture } from "./project-radar-fixture";

const fixture = await projectRadarFixture();
const { api } = await import("../../server/src/api");
const { getDataset } = await import("../../server/src/ocx/store");
const { buildProjectRadar } = await import("../../server/src/labs/projects");
const { filterRows } = await import("../../server/src/analytics");
const { createProjectIdentity } = await import("../../server/src/projects");
const { parseWindow } = await import("../../server/src/time/window");
const dataset = await getDataset();
const theme = { text: "#29292b", axis: "#69696c", split: "#e5e5e2", tooltipBg: "#ffffff", tooltipBorder: "#d5d5d1", area: "rgba(82,106,203,.1)" };
const periods = ["current", "prior"] as const;
const decode = (value: string) => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const money = (totals: RadarTotals) => totals.pricedRequests ? `$${totals.pricedCostUsd.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 })}` : "Unavailable";
let assertions = 0;
function check(condition: unknown, label: string) { assert.ok(condition, label); assertions++; }
function render(data: ProjectRadarResponse, project?: string, theme: "light" | "dark" = "light", hideArtwork = false) {
  return decode(renderToStaticMarkup(<YaldiSmokeProviders theme={theme} hideArtwork={hideArtwork}><MemoryRouter><ProjectRadarResult data={data} initialProject={project} /></MemoryRouter></YaldiSmokeProviders>));
}
async function payload(patch: Record<string, string> = {}) {
  const params = new URLSearchParams({ ...RADAR_WINDOW, ...patch });
  const response = await api.request(`/api/labs/projects?${params}`);
  assert.equal(response.status, 200);
  return { data: await response.json() as ProjectRadarResponse, params };
}
function verifyChange(html: string, change: RadarChange, label: string) {
  check(html.includes(`data-comparison-state="${change.state}"`), `${label}: server state`);
  if (change.state === "compared" && change.relativeChange !== null) check(html.includes(`${change.relativeChange > 0 ? "+" : ""}${(change.relativeChange * 100).toFixed(1)}%`), `${label}: exact server ratio`);
}
function verifyPayload(data: ProjectRadarResponse, label: string) {
  const ranking = render(data);
  check(!/NaN|Infinity|Invalid Date|undefined|\[object Object\]/.test(ranking), `${label}: finite complete rendering`);
  for (const window of [data.window, data.priorWindow]) check(ranking.includes(window.label) && ranking.includes(window.fromIso) && ranking.includes(window.toIso), `${label}: fixed period label and exact bounds`);
  check(ranking.indexOf("data-finding-summary") < ranking.indexOf("Filtered scope, totals"), `${label}: finding precedes scope`);
  if (data.current.totals.requests === 0 && data.prior.totals.requests === 0) {
    check(ranking.includes("No requests to investigate") && !ranking.includes('data-radar-evidence="'), `${label}: empty state with no invented evidence or chart`);
    return;
  }
  assert.deepEqual([...ranking.matchAll(/data-radar-project="([^"]+)"/g)].map(match => match[1]), data.projects.map(project => project.project));
  assertions++;
  for (const project of data.projects) {
    const html = render(data, project.project);
    check(html.includes(`data-selected-project="${project.project}"`), `${label}: exact selection`);
    for (const metric of ["requests", "tokens", "pricedCostUsd"] as const) {
      const block = html.split(`data-radar-metric="${metric}"`)[1]?.split("</section>")[0] ?? "";
      for (const period of periods) check(block.includes(metric === "pricedCostUsd" ? money(project[period].totals) : project[period].totals[metric].toLocaleString("en-US")), `${label}: ${metric} ${period} is server value`);
      verifyChange(block, project.comparison[metric], `${label}: ${metric}`);
    }
    for (const period of periods) {
      const anchor = [...html.matchAll(/<a\s[^>]+>/g)].find(match => match[0].includes(`data-radar-evidence="${period}"`))?.[0];
      const href = anchor?.match(/href="([^"]+)"/)?.[1];
      assert.ok(href, `${label}: ${period} evidence link`);
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
      const daily = [...html.matchAll(/data-radar-daily="(current|prior)" data-from="(\d+)" data-to="(\d+)"/g)].filter(match => match[1] === period);
      assert.deepEqual(daily.map(match => [Number(match[2]), Number(match[3])]), project[period].daily.map(day => [day.from, day.to]));
      assertions++;
      for (const mix of ["sources", "models"] as const) {
        const block = html.split(`aria-label="${period === "current" ? "Current" : "Prior"} ${mix}"`)[1]?.split("</table>")[0] ?? "";
        for (const row of project[period][mix]) {
          check(block.includes(row.requests.toLocaleString("en-US")) && block.includes(row.tokens.toLocaleString("en-US")) && block.includes(money(row)), `${label}: ${period} ${mix} values`);
          if ("model" in row) check(block.includes(row.model) && block.includes(row.provider), `${label}: model identity`);
        }
      }
      const coverage = project[period].coverage;
      const block = html.split(`data-radar-coverage="${period === "current" ? "Current" : "Prior"} selected project"`)[1]?.split("</section>")[0] ?? "";
      check(block.includes(`Priced: ${coverage.pricing.eligibleRequests}/${coverage.pricing.totalRequests}`) && block.includes(`Known project folder: ${coverage.attribution.eligibleRequests}/${coverage.attribution.totalRequests}`), `${label}: independent coverage`);
    }
    for (const metric of ["requests", "tokens", "pricedCostUsd"] as const) {
      const option = radarDailyOption(project, data.window, data.priorWindow, metric, theme) as any;
      check(option.xAxis.min === data.priorWindow.from && option.xAxis.max === data.window.to, `${label}: original daily dates`);
      for (const [index, period] of periods.entries()) {
        const series = option.series[index];
        check(series.type === "scatter", `${label}: gaps cannot be connected`);
        assert.deepEqual(series.data.map((point: any) => point.value), project[period].daily.map(day => [day.from, metric === "pricedCostUsd" && !day.pricedRequests ? null : day[metric]]));
        assertions++;
      }
    }
  }
  console.log(`PASS L03 ${label}: ranking, selections, comparisons, daily/source/model values, coverage and paired evidence`);
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
  const missingBaseline = await payload({ from: String(RADAR_FROM - 4 * RADAR_DAY - 1), to: String(RADAR_FROM - 4 * RADAR_DAY + 1) });
  for (const theme of ["light", "dark"] as const) for (const [data, project, supported] of [
    [full.data, fixture.alpha, true], [full.data, fixture.beacon, true], [full.data, fixture.noPrice, false],
    [full.data, fixture.zero, false], [full.data, fixture.priorOnly, true], [pricedZero.data, fixture.alpha, true],
    [missingBaseline.data, fixture.alpha, false], [(await payload({ projects: "/no/synthetic/project" })).data, undefined, false],
  ] as const) {
    const shown = render(data, project, theme);
    const hidden = render(data, project, theme, true);
    check(shown.includes(`/yaldi/state-clue-found${theme === "dark" ? "-dark" : ""}.svg`) === supported, `B02 ${theme}: actual selected cost finding ${project} eligibility`);
    check(!hidden.includes("<img") && shown.replace(/<img[^>]*>/g, "") === hidden, `B02 ${theme}: hiding artwork preserves every finding, evidence URL and value`);
  }

  // Exercise the production hook/query key, not only the result renderer.
  for (const { data, params } of [full, combined]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const filters = filtersFromParams(params);
    client.setQueryData(["/api/labs/projects", filtersToParams(filters)], data);
    const html = decode(renderToStaticMarkup(<QueryClientProvider client={client}><YaldiSmokeProviders><MemoryRouter initialEntries={[`/labs/project-radar?${params}`]}><FiltersProvider><ProjectRadar /></FiltersProvider></MemoryRouter></YaldiSmokeProviders></QueryClientProvider>));
    check(html.includes(`data-selected-project="${data.projects[0]!.project}"`) && html.includes(data.window.label), "Hook consumes the full response for its complete filter key");
    client.clear();
  }
  const stateClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const renderState = () => renderToStaticMarkup(<QueryClientProvider client={stateClient}><YaldiSmokeProviders><MemoryRouter><FiltersProvider><ProjectRadar /></FiltersProvider></MemoryRouter></YaldiSmokeProviders></QueryClientProvider>);
  check(renderState().includes("Loading investigation"), "Pending query uses shared loading state");
  try { await stateClient.fetchQuery({ queryKey: ["/api/labs/projects", filtersToParams(DEFAULT_FILTERS)], queryFn: () => Promise.reject(new Error("Synthetic API error")) }); } catch { /* Expected synthetic failure. */ }
  const error = renderState();
  check(error.includes('role="alert"') && error.includes("Synthetic API error") && error.includes("Try again"), "Query failure uses accessible error and retry");
  stateClient.setQueryData(["/api/labs/projects", filtersToParams(DEFAULT_FILTERS)], full.data);
  stateClient.getQueryCache().getAll()[0]!.setState({ status: "error", error: new Error("Synthetic refresh failure") });
  check(renderState().includes("Synthetic refresh failure") && !renderState().includes("clue-found"), "B02 refresh error never decorates retained Radar data");
  stateClient.clear();
  console.log(`PASS L03 ${assertions} payload/SSR assertions; synthetic inputs only`);
} finally {
  await fixture.cleanup();
}
