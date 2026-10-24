import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
];
const clock = { now: Date.parse("2026-10-25T12:00:00Z"), first: Date.parse("2026-08-01T00:00:00Z") };
const intent = new URLSearchParams({ tz: "Asia/Singapore", sources: "claude-code", projects: "/synthetic/app", models: "claude-test",
  providers: "hidden-provider", conversationId: "synthetic-session", sessionSource: "claude-code", day: "2026-10-20",
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
    return { filters: filters!, links, queries: client.getQueryCache().getAll().map(query => query.queryKey) };
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
          expect(requestWindow(destination, target.api)).toEqual(requestWindow(board, target.api));
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
    test(`explicit window ${JSON.stringify(window)} and unrelated query/identity survive both tabs`, () => {
      const params = new URLSearchParams(intent);
      for (const [key, value] of Object.entries(window)) params.set(key, value);
      const board = renderRoute(`/labs/?${params}`);
      for (const target of targets) {
        const tab = board.links.find(link => link.label === target.label)!;
        expect([...new URL(tab.href, "http://fixture.invalid").searchParams]).toEqual([...params]);
        const destination = renderRoute(tab.href);
        expect(filtersToParams(destination.filters)).toBe(filtersToParams(board.filters));
        expect(requestWindow(destination, target.api)).toEqual(requestWindow(board, target.api));
      }
    });
  }

  for (const [path, range] of [["project-radar", "7d"], ["cache-detective", "7d"], ["spend-spikes", "30d"], ["context-replay", "30d"]]) {
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
