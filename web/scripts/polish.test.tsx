import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SessionLink } from "../src/components/SessionLink";
import { Stat } from "../src/components/ui";

test("shared session links reuse the title cache and preserve source-qualified navigation", () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["/api/session-titles"], { titles: { collision: "A synthetic recorded title that is deliberately long" } });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter>
    <SessionLink session={{ id: "collision", source: "claude-code", project: "fallback" }} search="?range=30d" />
    <SessionLink session={{ id: "collision", source: "ocx", project: "fallback" }} search="?range=30d" />
  </MemoryRouter></QueryClientProvider>);
  expect(html).toContain('title="A synthetic recorded title that is deliberately long · Claude Code"');
  expect(html).toContain("sessionSource=claude-code");
  expect(html).toContain("sessionSource=ocx");
  expect(html.match(/A synthetic recorded title/g)?.length).toBe(2);
  expect(html).toContain("range=30d");
  expect(client.getQueryCache().getAll()).toHaveLength(1);
  client.clear();
});

test("Stat reserves both number representations and exposes the exact count to assistive technology", () => {
  const html = renderToStaticMarkup(<Stat label="Synthetic count" value="1.2B" exact="1,204,551,220" />);
  expect(html).toContain('aria-label="Synthetic count: 1,204,551,220"');
  expect(html).toContain('tabindex="0"');
  expect(html).toContain('class="stat-compact"');
  expect(html).toContain('class="stat-exact"');
  expect(html).toContain("1.2B");
  expect(html).toContain("1,204,551,220");
});
