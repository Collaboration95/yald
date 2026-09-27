/**
 * Server-render smoke test.
 *
 * Renders every page against the API handler with real ledgers when they exist,
 * or with a synthetic fixture home when they do not (so CI and a fresh clone can
 * still verify the UI). A runtime crash, a broken data shape or a bad formatter
 * shows up here without a browser.
 *
 * Run with: ./scripts/smoke.sh  (add --fixtures to force the synthetic ledger)
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderToString } from "react-dom/server";
import { DEFAULT_FILTERS, fetchJson, filtersToParams } from "../src/api";
import { ThemeProvider } from "../src/lib/theme";
import { FiltersProvider } from "../src/lib/useFilters";
import { OverviewPage } from "../src/pages/Overview";
import { UsagePage } from "../src/pages/Usage";
import { CostPage } from "../src/pages/Cost";
import { PerformancePage } from "../src/pages/Performance";
import { ReliabilityPage } from "../src/pages/Reliability";
import { ModelsPage } from "../src/pages/Models";
import { QuotaPage } from "../src/pages/Quota";
import { ConversationDetailPage, ConversationsPage } from "../src/pages/Conversations";
import { materializeFixtureHome } from "./fixtureHome";

type AnyComponent = () => React.ReactElement | null;

const ocxHome = process.env.OCX_HOME ?? join(homedir(), ".opencodex");
const useFixtures = process.argv.includes("--fixtures") || !existsSync(join(ocxHome, "usage.jsonl"));
if (useFixtures) process.env.OCX_HOME = await materializeFixtureHome();
console.log(useFixtures ? "source: synthetic fixtures" : `source: ${join(ocxHome, "usage.jsonl")}`);

// The API module resolves OCX_HOME when it loads, so import it after that decision.
const { api } = await import("../../server/src/api.ts");

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, "http://localhost");
  return api.fetch(new Request(url.toString(), { headers: { accept: "application/json" } }));
}) as typeof globalThis.fetch;

interface Seed {
  path: string;
  params?: string;
}

interface PageSpec {
  name: string;
  route: string;
  /** Route pattern used by the harness; defaults to the concrete route. */
  pattern?: string;
  Component: AnyComponent;
  queries: Seed[];
  /** Static UI copy that must render regardless of the data. */
  expect: string[];
  /** Extra strings derived from the seeded payloads, asserted only when present. */
  expectFrom?: (payloads: any[]) => (string | undefined | null)[];
}

const detailFilters = { ...DEFAULT_FILTERS, range: "all" };
const conversationsSeed = await fetchJson<{ conversations: { id: string }[] }>(
  "/api/conversations",
  filtersToParams(DEFAULT_FILTERS, { sort: "tokens", limit: 5 }),
);
const sampleConversation = conversationsSeed.conversations[0]?.id ?? "";
const shorten = (value: string) => (value.length <= 14 ? value : value.slice(0, 14));

const PAGES: PageSpec[] = [
  {
    name: "Overview",
    route: "/",
    Component: OverviewPage,
    queries: [{ path: "/api/overview", params: filtersToParams(DEFAULT_FILTERS, { metric: DEFAULT_FILTERS.metric }) }],
    expect: ["Requests", "Tokens", "Estimated cost", "Success rate", "Cost composition", "Activity heatmap", "Model leaderboard"],
    expectFrom: payloads => [payloads[0]?.topModels?.[0]?.key],
  },
  {
    name: "Usage",
    route: "/usage",
    Component: UsagePage,
    queries: [{ path: "/api/usage", params: filtersToParams(DEFAULT_FILTERS, { metric: DEFAULT_FILTERS.metric, groupBy: DEFAULT_FILTERS.groupBy }) }],
    expect: ["Token composition", "Cache efficiency", "Context pressure", "By effort"],
    expectFrom: payloads => [payloads[0]?.byModel?.[0]?.key],
  },
  {
    name: "Cost",
    route: "/cost",
    Component: CostPage,
    queries: [{ path: "/api/cost", params: filtersToParams(DEFAULT_FILTERS, { groupBy: DEFAULT_FILTERS.groupBy }) }],
    expect: ["Spend over time", "Where the dollars go", "Blended price per 1M tokens", "Cost by model"],
    expectFrom: payloads => [payloads[0]?.byModel?.[0]?.key],
  },
  {
    name: "Performance",
    route: "/performance",
    Component: PerformancePage,
    queries: [{ path: "/api/performance", params: filtersToParams(DEFAULT_FILTERS, {}) }],
    expect: ["TTFT p50", "Latency and first-token timeline", "Slowest requests", "Performance by model"],
    expectFrom: payloads => [payloads[0]?.byModel?.[0]?.key],
  },
  {
    name: "Reliability",
    route: "/reliability",
    Component: ReliabilityPage,
    queries: [{ path: "/api/reliability", params: filtersToParams(DEFAULT_FILTERS, {}) }],
    expect: ["Outcomes", "HTTP status codes", "Error breakdown", "Metered", "Failure rate by model"],
    expectFrom: payloads => [payloads[0]?.errors?.[0]?.name, payloads[0]?.recentFailures?.[0]?.errorCode],
  },
  {
    name: "Models",
    route: "/models",
    Component: ModelsPage,
    queries: [{ path: "/api/models", params: filtersToParams(DEFAULT_FILTERS, {}) }],
    expect: ["Price vs time-to-first-token", "Model comparison", "Effort mix", "Effort × model matrix"],
    expectFrom: payloads => [payloads[0]?.models?.[0]?.key],
  },
  {
    name: "Quota",
    route: "/quota",
    Component: QuotaPage,
    queries: [
      { path: "/api/quota", params: filtersToParams(DEFAULT_FILTERS, {}) },
      { path: "/api/ledger", params: filtersToParams(DEFAULT_FILTERS, {}) },
    ],
    expect: ["Utilisation history", "Current windows", "Spend ledger", "Burn table"],
    expectFrom: payloads => [payloads[0]?.windows?.[0]?.window],
  },
  {
    name: "Conversations",
    route: "/conversations",
    Component: ConversationsPage,
    queries: [{ path: "/api/conversations", params: filtersToParams(DEFAULT_FILTERS, { sort: "tokens", limit: 200 }) }],
    expect: ["Sessions ranked", "Median tokens"],
    expectFrom: payloads => [payloads[0]?.conversations?.[0]?.id ? shorten(payloads[0].conversations[0].id) : undefined],
  },
  {
    name: "ConversationDetail",
    route: "/conversations/" + sampleConversation,
    pattern: "/conversations/:id",
    Component: ConversationDetailPage,
    queries: [{ path: "/api/conversations/" + sampleConversation, params: filtersToParams(detailFilters, {}) }],
    expect: ["Token growth", "Models used", "Requests in this conversation"],
    expectFrom: payloads => [sampleConversation, payloads[0]?.models?.[0]?.name],
  },
];

const SUSPECT = ["NaN", "Invalid Date", "undefined", "Infinity", "[object Object]"];
let failures = 0;
let warnings = 0;

function renderPage(Component: AnyComponent, client: QueryClient, route: string, pattern?: string) {
  return renderToString(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[route]}>
          <FiltersProvider>
            <Routes>
              <Route path={pattern ?? route} element={<Component />} />
            </Routes>
          </FiltersProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

for (const page of PAGES) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, refetchInterval: false } } });
  const payloads: any[] = [];
  for (const seed of page.queries) {
    const data = await fetchJson(seed.path, seed.params ?? filtersToParams(DEFAULT_FILTERS, {}));
    payloads.push(data);
    queryClient.setQueryData(seed.params === undefined ? [seed.path] : [seed.path, seed.params], data);
  }

  try {
    const html = renderPage(page.Component, queryClient, page.route, page.pattern);
    const expected = [
      ...page.expect,
      ...(page.expectFrom ? page.expectFrom(payloads).filter((value): value is string => Boolean(value)) : []),
    ];
    const missing = expected.filter(text => !html.includes(text));
    const suspects = SUSPECT.filter(token => html.includes(token));
    const loadFailure = html.includes("Could not load data");
    const tooThin = html.length < 2_000;
    const ok = missing.length === 0 && suspects.length === 0 && !loadFailure && !tooThin;

    if (!ok) failures++;
    if (suspects.length > 0) warnings++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${page.name.padEnd(20)} ${String(html.length).padStart(7)} chars` +
      (missing.length ? `\n        missing: ${missing.join(", ")}` : "") +
      (loadFailure ? "\n        page rendered an error state" : "") +
      (tooThin ? "\n        page rendered suspiciously little markup" : "") +
      (suspects.length ? `\n        suspicious tokens: ${suspects.join(", ")}` : "") +
      (missing.length ? `\n        excerpt: ${html.replace(/\s+/g, " ").slice(0, 300)}` : ""),
    );
  } catch (error) {
    failures++;
    console.log(`FAIL  ${page.name.padEnd(20)} threw: ${(error as Error).message}`);
    console.log((error as Error).stack?.split("\n").slice(0, 6).join("\n"));
  }
}

/**
 * Regression guard: changing the range selector must change the quota view.
 * Renders the page twice over the same seeded data and asserts the output differs,
 * and that an empty window is explained rather than silently blank.
 */
async function checkQuotaRange(): Promise<void> {
  const renderQuota = async (range: string) => {
    const ranged = { ...DEFAULT_FILTERS, range };
    const params = filtersToParams(ranged, {});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, refetchInterval: false } } });
    client.setQueryData(["/api/quota", params], await fetchJson("/api/quota", params));
    client.setQueryData(["/api/ledger", params], await fetchJson("/api/ledger", params));
    return renderPage(QuotaPage, client, "/quota?range=" + range, "/quota");
  };

  const wide = await renderQuota("30d");
  const narrow = await renderQuota("24h");
  const responds = wide !== narrow;
  const explains = /No quota samples|no data in range/.test(narrow);
  if (!responds) failures++;
  console.log(
    `${responds ? "PASS" : "FAIL"}  ${"Quota range".padEnd(20)} range selector changes the quota view` +
    (explains ? " (empty window is explained)" : " (warning: empty window not explained)"),
  );
}

await checkQuotaRange();

globalThis.fetch = realFetch;
console.log(`\n${PAGES.length - failures}/${PAGES.length} pages rendered, ${warnings} with suspicious tokens`);
if (failures > 0) process.exit(1);
