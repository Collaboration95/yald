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
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderToString } from "react-dom/server";
import { conversationLink, DEFAULT_FILTERS, escapeGlob, fetchJson, filtersFromParams, filtersToParams, selectionFilters } from "../src/api";
import { OutcomeDot } from "../src/components/ui";
import { Layout } from "../src/components/Layout";
import { ThemeProvider } from "../src/lib/theme";
import { decodePreferences, PREFERENCES_STORAGE_KEY, PreferencesProvider, usePreferences, type Preferences } from "../src/lib/preferences";
import { LabsPage, LabsInvestigationPage } from "../src/pages/labs/LabsPage";
import { LabsLayout } from "../src/pages/labs/LabsLayout";
import { InvestigationScope } from "../src/pages/labs/InvestigationScope";
import { InvestigationState, type InvestigationStateKind } from "../src/pages/labs/InvestigationState";
import { EvidenceCase } from "../src/pages/labs/EvidenceCase";
import { LABS_INVESTIGATIONS } from "../src/pages/labs/investigations";
import { FiltersProvider } from "../src/lib/useFilters";
import { OverviewPage } from "../src/pages/Overview";
import { UsagePage } from "../src/pages/Usage";
import { CostPage } from "../src/pages/Cost";
import { PerformancePage } from "../src/pages/Performance";
import { ContextPage } from "../src/pages/Context";
import { ReliabilityPage } from "../src/pages/Reliability";
import { ModelsPage } from "../src/pages/Models";
import { QuotaPage } from "../src/pages/Quota";
import { ConversationDetailPage, ConversationsPage } from "../src/pages/Conversations";
import { materializeFixtureHome, materializeFixturePricing } from "./fixtureHome";
import { addContextReplayFixtures } from "./context-replay-fixtures";
import { checkContextReplaySmoke } from "./context-replay-smoke";
import { LABS_INVESTIGATIONS } from "../src/pages/labs/investigations";
import { checkYaldiArtwork } from "./yaldi-smoke";

type AnyComponent = () => React.ReactElement | null;

const ocxHome = process.env.OCX_HOME ?? join(homedir(), ".opencodex");
const useFixtures = process.argv.includes("--fixtures") || !existsSync(join(ocxHome, "usage.jsonl"));
let fixturePricing = "";
if (useFixtures) {
  fixturePricing = await materializeFixturePricing();
  const pricePath = join(fixturePricing, "src/usage/cost.ts");
  await writeFile(pricePath, (await readFile(pricePath, "utf8")).replace("const RATES = {", 'const RATES = { "f01-free": [0, 0, 0, 0],'));
  process.env.OCX_PACKAGE_DIR = fixturePricing;
  process.env.OCX_HOME = await materializeFixtureHome({ dashboardScope: true });
  process.env.CLAUDE_PROJECTS_DIR = join(process.env.OCX_HOME, "claude-projects");
  process.env.CODEX_HOME = join(process.env.OCX_HOME, "codex");
  const ts = Date.now() - 60_000;
  const common = { timestamp: ts, provider: "anthropic", model: "f01-proxy", inboundProtocol: "messages", status: 200, usageStatus: "reported", cacheProvenance: "observed", durationMs: 100, firstOutputMs: 10, attempts: [{}] };
  const synthetic = [
    { ...common, requestId: "f01-failure", status: 502, errorCode: "synthetic_failure", usage: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0 } },
    { ...common, requestId: "f01-input-missing", model: "f01-presence", usage: { outputTokens: 1 } },
    { ...common, requestId: "f01-input-zero", model: "f01-presence", usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 } },
    ...["free", "unpriced"].map(kind => ({ ...common, requestId: `f01-${kind}`, model: `f01-${kind}`, conversationId: `f01-${kind}-session`,
      usage: { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } })),
  ];
  await appendFile(join(process.env.OCX_HOME, "usage.jsonl"), synthetic.map(row => JSON.stringify(row)).join("\n") + "\n");
  const folder = join(process.env.CLAUDE_PROJECTS_DIR, "f01");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "f01.jsonl"), JSON.stringify({ type: "assistant", requestId: "f01-transcript", sessionId: "f01-session", timestamp: new Date(ts).toISOString(),
    message: { model: "f01-transcript", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + "\n");
  await addContextReplayFixtures(process.env.OCX_HOME, fixturePricing);
}
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
const conversationsSeed = await fetchJson<{ conversations: { id: string; source: "ocx" | "claude-code" }[] }>(
  "/api/conversations",
  filtersToParams(DEFAULT_FILTERS, { sort: "tokens", limit: 5 }),
);
const sampleConversation = conversationsSeed.conversations[0]?.id ?? "";
const sampleSource = conversationsSeed.conversations[0]?.source;
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
    queries: [
      { path: "/api/cost", params: filtersToParams(DEFAULT_FILTERS, { groupBy: DEFAULT_FILTERS.groupBy }) },
      { path: "/api/cost/structure", params: filtersToParams({ ...DEFAULT_FILTERS, groupBy: "", metric: "" }, {}) },
    ],
    expect: ["Spend over time", "Where the dollars go", "Blended price per 1M tokens", "Cost by model", "Spend concentration", "Blended price and price tiers", "Price tiers", "Token-class cost mix"],
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
    name: "Context",
    route: "/context",
    Component: ContextPage,
    queries: [{ path: "/api/context", params: filtersToParams(DEFAULT_FILTERS, {}) }],
    expect: ["Context length by model", "Per-model summary", "Model by band", "Context tax by band", "Session growth", "Share above a threshold"],
    expectFrom: payloads => [payloads[0]?.models?.[0]?.model],
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
    expect: ["Utilisation history", "Current windows", "Send accounting", "Burn table"],
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
    route: "/conversations/" + sampleConversation + `?range=all&sessionSource=${sampleSource}`,
    pattern: "/conversations/:id",
    Component: ConversationDetailPage,
    queries: [{ path: "/api/conversations/" + sampleConversation, params: filtersToParams(detailFilters, { sessionSource: sampleSource }) }],
    expect: ["Token growth", "Models used", "Requests in this conversation"],
    expectFrom: payloads => [sampleConversation, payloads[0]?.models?.[0]?.name],
  },
];

const SUSPECT = ["NaN", "Invalid Date", "undefined", "Infinity", "[object Object]"];
let failures = 0;
let warnings = 0;

function renderPage(Component: AnyComponent, client: QueryClient, route: string, pattern?: string, withLayout = false, preferences: Preferences = { labsEnabled: false, hideArtwork: false }) {
  const content = route.split("?")[0]!.startsWith("/labs")
    ? <Route path="/labs" element={<LabsLayout />}>
        <Route index element={<Component />} /><Route path=":investigation" element={<Component />} /><Route path="*" element={<Component />} />
      </Route>
    : <Route path={pattern ?? route} element={<Component />} />;
  return renderToString(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[route]}>
          <FiltersProvider>
          <PreferencesProvider storage={{ getItem: () => JSON.stringify({ version: 1, ...preferences }), setItem: () => { throw new Error("SSR must not write preferences"); } }}>
            <Routes>
              {withLayout ? <Route element={<Layout />}>{content}</Route> : content}
            </Routes>
          </PreferencesProvider>
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

/** Exercise source/presence policy through real API data and the rendered consumers. */
async function checkMeasurementCohorts() {
  const check = (condition: boolean, label: string) => {
    if (!condition) failures++;
    console.log(`${condition ? "PASS" : "FAIL"}  F01 ${label}`);
  };
  const params = filtersToParams(DEFAULT_FILTERS, {});
  const claudeFilters = { ...DEFAULT_FILTERS, models: ["f01-transcript"] };
  const claudeParams = filtersToParams(claudeFilters, {});
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  const reliability = await fetchJson<any>("/api/reliability", claudeParams);
  const overview = await fetchJson<any>("/api/overview", claudeParams);
  client.setQueryData(["/api/reliability", claudeParams], reliability);
  client.setQueryData(["/api/overview", claudeParams], overview);
  client.setQueryData(["/api/meta"], await fetchJson("/api/meta"));
  const html = renderPage(ReliabilityPage, client, "/reliability?models=f01-transcript", "/reliability");
  const overviewHtml = renderPage(OverviewPage, client, "/?models=f01-transcript", "/");
  check(reliability.successRate === null && reliability.measurementCoverage.outcomes.eligibleRequests === 0 && reliability.outcomes[0]?.name === "unobserved", "Claude-only outcome denominator");
  check(html.includes("0 of 1 requests observed") && html.includes("Retry history unavailable"), "Claude-only reliability rendering");
  check(overviewHtml.includes("unobserved") && overviewHtml.includes("Retry history unavailable"), "transcript request badge");
  const badge = renderToString(<OutcomeDot outcome="unobserved" />);
  check(badge.includes('aria-label="unobserved"') && !badge.includes("bg-bad"), "unobserved badge accessibility");
  const layout = renderPage(Layout, client, "/", "/");
  check(layout.includes("Outcome"), "shared outcome control renders");
  // Every outcome cohort is queried through the same shared statuses parameter.
  for (const status of ["ok", "error", "cancelled", "unobserved"]) {
    const filtered = await fetchJson<any>("/api/overview", filtersToParams({ ...claudeFilters, statuses: [status] }, {}));
    check(filtered.summary.requests === (status === "unobserved" ? 1 : 0), `Claude-only ${status} cohort`);
  }
  const mixed = await fetchJson<any>("/api/overview", filtersToParams({ ...DEFAULT_FILTERS, models: ["f01-transcript", "f01-proxy"] }, {}));
  check(mixed.summary.requests === 2 && mixed.summary.successRate === 0 && mixed.summary.measurementCoverage.outcomes.eligibleRequests === 1 && mixed.recent.find((r: any) => r.id === "f01-failure")?.source === "ocx", "mixed failure and Anthropic proxy source");
  const presence = await fetchJson<any>("/api/overview", filtersToParams({ ...DEFAULT_FILTERS, models: ["f01-presence"] }, {}));
  check(presence.recent.find((r: any) => r.id === "f01-input-missing")?.measurements.input === false && presence.recent.find((r: any) => r.id === "f01-input-zero")?.measurements.input === true && presence.context.eligibleRequests === 1, "missing input versus observed zero");
  // Ensure mixed production data retains unobserved volume while rates stay eligible.
  const full = await fetchJson<any>("/api/reliability", params);
  check(full.outcomes.reduce((n: number, x: any) => n + x.value, 0) === full.measurementCoverage.totalRequests, "outcome totals reconcile");

  const priceFilters = { ...DEFAULT_FILTERS, models: ["f01-free", "f01-unpriced"] };
  const priceParams = filtersToParams(priceFilters);
  for (const [path, route, Component, extra] of [
    ["/api/overview", "/", OverviewPage, {}],
    ["/api/usage", "/usage", UsagePage, {}],
    ["/api/cost", "/cost", CostPage, {}],
    ["/api/conversations", "/conversations", ConversationsPage, { sort: "tokens", limit: 200 }],
  ] as const) {
    const queryParams = filtersToParams(priceFilters, extra);
    const payload = await fetchJson<any>(path, queryParams);
    const priceClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    priceClient.setQueryData([path, queryParams], payload);
    const rendered = renderPage(Component, priceClient, `${route}?${priceParams}`, route);
    const entries = rendered.match(path === "/api/overview" ? /<li class="leaderboard-row"[\s\S]*?<\/li>/g : /<tr\b[\s\S]*?<\/tr>/g) ?? [];
    const free = entries.find(entry => entry.replace(/<[^>]*>/g, "").includes("f01-free"));
    const unknown = entries.find(entry => entry.replace(/<[^>]*>/g, "").includes("f01-unpriced"));
    check(Boolean(free?.includes("$0.00") && unknown?.includes("unpriced") && !unknown.includes("$0.00")), `${path} priced zero versus unavailable`);
    priceClient.clear();
  }
}
if (useFixtures) await checkMeasurementCohorts();

/** F02: real scoped queries, toolbar/status rendering and source-qualified links on synthetic data. */
async function checkDashboardScope() {
  const check = (condition: boolean, label: string) => {
    if (!condition) failures++;
    console.log(`${condition ? "PASS" : "FAIL"}  F02 ${label}`);
  };
  const appA = join(process.env.OCX_HOME!, "work", "app-a");
  const combined = { ...DEFAULT_FILTERS, sources: ["ocx"], projects: [escapeGlob(appA)], providers: ["openai"], models: ["gpt-6-luna"],
    efforts: ["high"], statuses: ["ok"], search: "fixture", routeKinds: ["native"], from: "now-24h", to: "now", tz: "UTC", bucket: "hour", groupBy: "effort", metric: "requests" };
  check(JSON.stringify(filtersFromParams(new URLSearchParams(filtersToParams(combined)))) === JSON.stringify(combined), "complete URL cohort round trip");
  check(!new URLSearchParams(filtersToParams({ ...DEFAULT_FILTERS, sources: ["claude", "codex", "ocx"] })).has("sources"), "aliases and both-source default");

  const renderScoped = async (Component: AnyComponent, path: string, filters: typeof DEFAULT_FILTERS, endpoint: string, extra = {}, layout = true) => {
    const params = filtersToParams(filters);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    client.setQueryData(["/api/meta"], await fetchJson("/api/meta"));
    // The toolbar's scope and project queries leave out chart controls (selectionFilters), as the app does.
    for (const [url, query] of [["/api/scope", filtersToParams(selectionFilters(filters))], ["/api/projects", filtersToParams(selectionFilters({ ...filters, projects: [] }))], [endpoint, filtersToParams(filters, extra)]] as const) {
      client.setQueryData([url, query], await fetchJson(url, query));
    }
    const html = renderPage(Component, client, `${path}?${params}`, path.startsWith("/conversations/") ? "/conversations/:id" : path, layout);
    client.clear();
    return html;
  };
  const html = await renderScoped(ConversationsPage, "/conversations", combined, "/api/conversations", { sort: "tokens", limit: 200 });
  const payload = await fetchJson<any>("/api/conversations", filtersToParams(combined));
  check(payload.totals.requests > 0 && payload.conversations.every((c: any) => c.source === "ocx"), "combined cohort has matching source-qualified sessions");
  check(html.includes("Source · 1") && html.includes("Project · 1") && html.includes("Project selection excludes") && html.includes("Custom window"), "toolbar, attribution and custom-window status");
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]!.replace(/&amp;/g, "&"));
  const cohort = new URLSearchParams(filtersToParams(combined));
  const routeLinks = links.filter(link => link.startsWith("/") && !link.startsWith("/api/"));
  check(routeLinks.length >= 9 && routeLinks.every(link => [...cohort].every(([key, value]) => new URL(link, "http://localhost").searchParams.get(key) === value)), "all navigation retains every cohort parameter");
  check(routeLinks.some(link => link.includes("/conversations/") && new URL(link, "http://localhost").searchParams.get("sessionSource") === "ocx"), "session links add source identity");
  check(!html.includes("Could not load data") && !html.includes("No requests match these filters"), "combined dashboard renders without an error or false empty state");

  const none = await renderScoped(UsagePage, "/usage", { ...combined, projects: ["/no/such/synthetic/project"] }, "/api/usage");
  check(none.includes("No requests match these filters") && none.includes("Reset all filters") && none.includes("unattributed requests"), "no-match result offers reset and explains exclusions");
  const claudeFilters = { ...DEFAULT_FILTERS, sources: ["claude-code"] };
  const unavailable = await renderScoped(QuotaPage, "/quota", claudeFilters, "/api/quota");
  check(unavailable.includes("Quota and send ledger unavailable for Claude Code") && !unavailable.includes("Burn table") && !unavailable.includes("Send accounting"), "Claude-only account observations hidden and explained");
  const overview = await renderScoped(OverviewPage, "/", { ...DEFAULT_FILTERS, sources: ["claude-code"], projects: [escapeGlob(appA)] }, "/api/overview", { metric: "tokens", groupBy: "model" });
  check(overview.includes("Quota and send ledger unavailable for Claude Code") && !overview.includes("81%"), "Claude-only overview does not show Codex quota");
  const quota = await renderScoped(QuotaPage, "/quota", combined, "/api/quota");
  check(quota.includes("Account-wide opencodex observation") && quota.includes("not a project&#x27;s own usage") && quota.includes("projects, providers, models, efforts, statuses, routeKinds, search"), "project-filtered quota declares every ignored dimension");

  const literal = await fetchJson<any>("/api/scope", filtersToParams({ ...DEFAULT_FILTERS, projects: [escapeGlob(join(process.env.OCX_HOME!, "work", "literal[app]*"))] }));
  check(literal.matched.requests === 2, "picker escapes literal glob metacharacters");
  const detail = conversationsSeed.conversations[0]!;
  const link = conversationLink(detail, `?${filtersToParams({ ...combined, projects: ["/no/match"] })}`);
  const detailParams = new URLSearchParams(link.search);
  const detailFilters = filtersFromParams(detailParams);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  const params = filtersToParams(detailFilters, { sessionSource: detail.source });
  const scoped = await fetchJson<any>(`/api${link.pathname}`, params);
  client.setQueryData([`/api${link.pathname}`, params], scoped);
  const rendered = renderPage(ConversationDetailPage, client, `${link.pathname}?${params}`, "/conversations/:id");
  check(scoped.scope.matched === 0 && rendered.includes("No requests in this session match") && !rendered.includes("NaN") && !rendered.includes("Could not load data"), "empty scoped detail renders without leaking session history or crashing");
  client.clear();
}
if (useFixtures) await checkDashboardScope();
async function checkLabsShell() {
  const check = (condition: boolean, label: string) => {
    if (!condition) failures++;
    console.log(`${condition ? "PASS" : "FAIL"}  L01 ${label}`);
  };
  const fixed = { from: Date.parse("2026-09-01T00:00:00Z"), to: Date.parse("2026-09-02T00:00:00Z"), tz: "Asia/Singapore", label: "Fixed day" };
  const cohort = { sources: ["ocx" as const], projects: ["/synthetic/{one,two}"], providers: ["synthetic-provider"], models: ["synthetic,model"],
    efforts: ["high"], statuses: ["ok" as const], routeKinds: ["native"], conversationId: "synthetic-session", search: "fixture" };
  const selector = JSON.stringify({ version: 1, window: fixed, cohort, selection: { kind: "scope" }, eligibility: "all" });
  const params = new URLSearchParams({ range: "7d", sources: "ocx", projects: "/no/synthetic/matches", providers: "openai", models: "gpt-6-luna",
    efforts: "high", statuses: "ok", routeKinds: "native", conversationId: "synthetic-session", from: "2026-09-01", to: "2026-09-02", tz: "UTC",
    search: "fixture", selectorVersion: "1", selector, priorSelector: selector });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const filters = filtersFromParams(params);
  const scopeParams = filtersToParams(selectionFilters(filters));
  client.setQueryData(["/api/scope", scopeParams], await fetchJson("/api/scope", scopeParams));
  client.setQueryData(["/api/meta"], await fetchJson("/api/meta"));
  const disabledChild = () => { throw new Error("Disabled Labs mounted an investigation"); };
  for (const path of ["/labs", "/labs/project-radar", "/labs/cache-detective", "/labs/context-replay", "/labs/evidence", "/labs/unknown/deep"]) {
    const html = renderPage(disabledChild, client, `${path}?${params}`, "/labs/*", true);
    const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]!.replace(/&amp;/g, "&")).filter(link => link.startsWith("/"));
    check(html.includes("Labs is off") && html.includes("Enable Labs") && html.includes("Return to Overview") && !html.includes("No requests match these filters"), `${path} recovers even when the cohort is empty; child never mounts`);
    check(links.length >= 9 && links.every(link => [...params].every(([key, value]) => new URL(link, "http://localhost").searchParams.get(key) === value)), `${path} links preserve the complete cohort and comma-bearing selector JSON`);
  }
  const enabledPreferences = { labsEnabled: true, hideArtwork: true };
  const home = renderPage(LabsPage, client, `/labs?${params}`, "/labs", true, enabledPreferences);
  check(["Project Radar", "Cache Detective", "Context Replay", "Disable Labs"].every(text => home.includes(text))
    && home.includes("Not available yet.") === LABS_INVESTIGATIONS.some(entry => !entry.Component), "enabled shell exposes the three independent component slots");
  for (const path of [...LABS_INVESTIGATIONS.filter(entry => !entry.Component).map(entry => entry.path), "unknown/deep"]) {
    const html = renderPage(LabsInvestigationPage, client, `/labs/${path}?${params}`, "/labs/*", true, enabledPreferences);
    check(html.includes("not available yet") && html.includes("All investigations") && !html.includes("Could not load data"), `${path} has a neutral placeholder without experiment queries`);
  }
  const invalidEvidence = renderPage(EvidenceCase, client, "/labs/evidence?investigation=unknown&selector=%7B%7D", "/labs/*", false, enabledPreferences);
  check(invalidEvidence.includes("Invalid case link") && invalidEvidence.includes("Choose an investigation"), "evidence route explains invalid intent without issuing an experiment query");
  check(!client.getQueryCache().getAll().some(query => String(query.queryKey[0]).startsWith("/api/labs/")), "disabled and enabled empty shell create no experiment queries");
  const cacheParams = filtersToParams(filters, { limit: 100 });
  client.setQueryData(["/api/labs/cache", cacheParams], await fetchJson("/api/labs/cache", cacheParams));
  const cache = renderPage(LabsInvestigationPage, client, `/labs/cache-detective?${params}`, "/labs/*", true, enabledPreferences);
  check(["Cache Detective", "No requests to investigate", "Read discount", "Write premium", "Net · Unavailable", "Unnamed requests", "Investigation scope"].every(text => cache.includes(text)), "registered Cache Detective renders the real empty API payload without treating missing money as zero");
  for (const kind of ["loading", "error", "empty", "insufficient"] as InvestigationStateKind[]) {
    const html = renderToString(<ThemeProvider><PreferencesProvider storage={{ getItem: () => JSON.stringify({ version: 1, ...enabledPreferences }), setItem: () => {} }}>
      <InvestigationState kind={kind} onRetry={() => {}} /></PreferencesProvider></ThemeProvider>);
    check(html.includes(`role="${kind === "error" ? "alert" : "status"}"`) && html.includes("aria-describedby") && !html.includes("<img")
      && html.includes("Try again") === (kind === "error"), `${kind} state has complete text and accessible semantics`);
  }
  const scope = renderToString(<InvestigationScope window={fixed} cohort={cohort} sample={{ eligibleRequests: 0, totalRequests: 4 }}
    unpricedRequests={0} unattributedRequests={2} notes={["Only measured inputs are eligible."]} />).replace(/<!--.*?-->/g, "");
  check(["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z", "From (included)", "Until (excluded)", "Asia/Singapore", "/synthetic/{one,two}",
    "synthetic,model", "0 of 4", "0 requests without a price", "2 requests without project attribution", "Only measured inputs are eligible."].every(text => scope.includes(text)), "fixed scope presents exact bounds, lossless cohort, observed zero and separate coverage notes");
  const defaults = JSON.stringify({ labsEnabled: false, hideArtwork: false });
  for (const raw of [null, "{broken", "null", "true", "[]", '{"labsEnabled":true}', '{"version":2,"labsEnabled":true}', '{"version":1,"labsEnabled":"true","hideArtwork":1}']) {
    check(JSON.stringify(decodePreferences(raw)) === defaults, `invalid or unsupported preferences use defaults: ${raw}`);
  }
  const Probe = () => { const { labsEnabled, hideArtwork } = usePreferences(); return <p>{`${labsEnabled}/${hideArtwork}`}</p>; };
  check(renderToString(<PreferencesProvider storage={null}><Probe /></PreferencesProvider>).includes("false/false"), "SSR without browser storage uses defaults");
  check(renderToString(<PreferencesProvider storage={{ getItem: () => { throw new Error("blocked"); }, setItem: () => {} }}><Probe /></PreferencesProvider>).includes("false/false"), "blocked storage uses defaults");
  check(PREFERENCES_STORAGE_KEY === "yald.preferences", "single documented preference storage key");
  client.clear();
}
await checkLabsShell();
if (useFixtures) await checkContextReplaySmoke();
failures += checkYaldiArtwork();
if (useFixtures) await Promise.all([process.env.OCX_HOME!, fixturePricing].map(path => rm(path, { recursive: true, force: true })));

globalThis.fetch = realFetch;
console.log(`\n${PAGES.length - failures}/${PAGES.length} pages rendered, ${warnings} with suspicious tokens`);
if (failures > 0) process.exit(1);
