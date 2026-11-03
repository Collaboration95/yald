import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { MovedTo } from "../src/components/MovedTo";
import { parseWindow } from "../../server/src/time/window";
import { filtersToParams, type Filters } from "../src/api";
import { PreferencesProvider } from "../src/lib/preferences";
import { ThemeProvider } from "../src/lib/theme";
import { FiltersProvider } from "../src/lib/useFilters";
import { LabsLayout } from "../src/pages/labs/LabsLayout";
import { LabsInvestigationPage, LabsPage } from "../src/pages/labs/LabsPage";
import { useLabsFilters } from "../src/pages/labs/shared";

const targets = [
  { path: "project-radar", label: "Projects", api: "/api/labs/projects" },
  { path: "cache-detective", label: "Cache savings", api: "/api/labs/cache" },
  { path: "style", label: "Working style", api: "/api/style" },
  { path: "turns", label: "Agent turns", api: "/api/turns" },
];
const clock = { now: Date.parse("2026-10-25T12:00:00Z"), first: Date.parse("2026-08-01T00:00:00Z") };
const intent = new URLSearchParams({ tz: "Asia/Singapore", sources: "claude-code", projects: "/synthetic/app", models: "claude-test",
  providers: "hidden-provider", agents: "subagent", efforts: "high", statuses: "error", search: "no-match", conversationId: "synthetic-session", sessionSource: "claude-code", day: "2026-10-20",
  selector: '{"cohort":{"providers":["literal,provider"]}}', priorSelector: "paired-case", investigation: "project-radar" });
intent.append("tag", "one");
intent.append("tag", "two");

function renderRoute(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let filters: Filters | undefined;
  function Probe() { filters = useLabsFilters(); return null; }
  try {
    const html = renderToString(<QueryClientProvider client={client}><ThemeProvider><MemoryRouter initialEntries={[route]}><FiltersProvider>
      <PreferencesProvider storage={{ getItem: () => '{"version":1,"labsEnabled":true,"hideArtwork":true}', setItem: () => {} }}>
        <Probe />
        <Routes><Route path="/labs" element={<LabsLayout />}>
          <Route index element={<LabsPage />} /><Route path=":investigation" element={<LabsInvestigationPage />} />
        </Route></Routes>
      </PreferencesProvider>
    </FiltersProvider></MemoryRouter></ThemeProvider></QueryClientProvider>);
    const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
      .map(match => ({ href: match[1]!.replace(/&amp;/g, "&"), label: match[2]! }));
    return { html, filters: filters!, links, queries: client.getQueryCache().getAll().map(query => query.queryKey) };
  } finally { client.clear(); }
}

function requestWindow(rendered: ReturnType<typeof renderRoute>, api: string) {
  const query = rendered.queries.find(key => key[0] === api);
  expect(query).toBeDefined();
  return parseWindow(Object.fromEntries(new URLSearchParams(query![1] as string)), clock);
}

describe("Labs board navigation", () => {
  for (const boardPath of ["/labs", "/labs/"]) {
    for (const target of targets) {
      test(`${boardPath} rendered ${target.label} tab and card retain the displayed 30-day window`, () => {
        for (const params of [new URLSearchParams(), intent]) {
          const board = renderRoute(`${boardPath}?${params}`);
          expect(board.filters.range).toBe("30d");
          const tab = board.links.find(link => link.label === target.label)!;
          const destination = renderRoute(tab.href);
          expect(destination.filters).toEqual(board.filters);
          if (["style", "turns"].includes(target.path)) {
            expect(requestWindow(destination, target.api)).toEqual(parseWindow(Object.fromEntries(new URLSearchParams(filtersToParams(board.filters))), clock));
          } else expect(requestWindow(destination, target.api)).toEqual(requestWindow(board, target.api));
          const expected = new URLSearchParams(params); expected.set("range", "30d");
          expect([...new URL(tab.href, "http://fixture.invalid").searchParams]).toEqual([...expected]);
          expect(board.links.find(link => link.label === "Investigate" && link.href.startsWith(`/labs/${target.path}?`))?.href).toBe(tab.href);
        }
      });
    }
  }

  for (const window of [
    { range: "7d" },
    { from: "2026-10-01T09:00:00+08:00", to: "2026-10-10T17:00:00+08:00" },
    { from: "2026-10-01" },
    { to: "2026-10-10" },
    { last: "12h" },
    { range: "90d", from: "2026-10-01", to: "2026-10-10" },
    { last: "12h", to: "2026-10-10" },
  ]) {
    test(`explicit window ${JSON.stringify(window)} and unrelated query/identity survive investigation tabs`, () => {
      const params = new URLSearchParams(intent);
      for (const [key, value] of Object.entries(window)) params.set(key, value);
      const board = renderRoute(`/labs/?${params}`);
      for (const target of targets) {
        const tab = board.links.find(link => link.label === target.label)!;
        expect([...new URL(tab.href, "http://fixture.invalid").searchParams]).toEqual([...params]);
        const destination = renderRoute(tab.href);
        expect(filtersToParams(destination.filters)).toBe(filtersToParams(board.filters));
        if (["style", "turns"].includes(target.path)) {
          expect(requestWindow(destination, target.api)).toEqual(parseWindow(Object.fromEntries(new URLSearchParams(filtersToParams(board.filters))), clock));
        } else expect(requestWindow(destination, target.api)).toEqual(requestWindow(board, target.api));
      }
    });
  }

  for (const [path, range] of [["project-radar", "7d"], ["cache-detective", "7d"], ["spend-spikes", "30d"], ["context-replay", "30d"], ["style", "7d"], ["turns", "7d"]]) {
    test(`direct ${path} keeps its ${range} default without injecting it into onward tabs`, () => {
      for (const suffix of ["", "/"]) {
        const direct = renderRoute(`/labs/${path}${suffix}?${intent}`);
        expect(direct.filters.range).toBe(range);
        for (const target of targets) {
          const tab = direct.links.find(link => link.label === target.label)!;
          expect([...new URL(tab.href, "http://fixture.invalid").searchParams]).toEqual([...intent]);
          const destination = renderRoute(tab.href);
          expect(destination.filters.range).toBe("7d");
          const window = requestWindow(destination, target.api);
          expect(window.to - window.from).toBe(7 * 86_400_000);
        }
      }
    });
  }
});

for (const path of ["style", "turns"]) {
  test(`${path} uses the visible Labs cohort and is gated when Labs is off`, () => {
    const result = renderRoute(`/labs/${path}?${intent}`);
    expect(result.filters).toMatchObject({ providers: [], agents: [], efforts: [], statuses: [], search: "",
      sources: ["claude-code"], projects: ["/synthetic/app"], models: ["claude-test"] });
    const client = new QueryClient();
    try {
      const html = renderToString(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/labs/${path}`]}><FiltersProvider>
        <PreferencesProvider storage={{ getItem: () => null, setItem: () => {} }}>
          <Routes><Route path="/labs" element={<LabsLayout />}><Route path=":investigation" element={<LabsInvestigationPage />} /></Route></Routes>
        </PreferencesProvider>
      </FiltersProvider></MemoryRouter></QueryClientProvider>);
      expect(html).toContain("Labs is off");
      expect(client.getQueryCache().getAll()).toHaveLength(0);
    } finally { client.clear(); }
  });
}

for (const [from, to] of [["/style", "/labs/style"], ["/turns", "/labs/turns"]]) {
  test(`${from} redirects with replace and preserves every query parameter`, () => {
    let destination: ReturnType<typeof MovedTo> | undefined;
    function RedirectProbe() { destination = MovedTo({ to: to! }); return null; }
    renderToString(<MemoryRouter initialEntries={[`${from}?${intent}`]}><RedirectProbe /></MemoryRouter>);
    expect(destination!.props).toMatchObject({ replace: true, to: { pathname: to, search: `?${intent}` } });
    const target = renderRoute(`${destination!.props.to.pathname}${destination!.props.to.search}`);
    expect(target.filters.providers).toEqual([]);
    expect(target.filters.agents).toEqual([]);
    expect(target.filters.efforts).toEqual([]);
    expect(target.filters.statuses).toEqual([]);
    expect(target.filters.search).toBe("");
  });
}
