import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { filtersFromParams } from "../src/api";
import { MoreFilters } from "../src/components/MoreFilters";
import { FiltersProvider, patchFilterParams } from "../src/lib/useFilters";

function toolbar(search: string) {
  return renderToString(<MemoryRouter initialEntries={[`/usage?${search}`]}><FiltersProvider>
    <MoreFilters providers={["synthetic-provider"]} efforts={["high"]} />
  </FiltersProvider></MemoryRouter>);
}

describe("More filters", () => {
  for (const [params, count] of [
    ["", 0], ["providers=one,two", 1], ["efforts=high", 1], ["statuses=error", 1],
    ["providers=one&efforts=high", 2], ["providers=one,two&efforts=high&statuses=error,cancelled", 3],
    ["models=synthetic&agents=main&search=example", 0],
  ] as const) {
    test(`${params || "no filters"} shows ${count} active hidden filters`, () => {
      const html = toolbar(params);
      expect(html).toContain(count ? `More filters · ${count}` : ">More filters<");
      expect(html).toContain('aria-expanded="false"');
      expect(html.includes("bg-accent-soft")).toBe(count > 0);
    });
  }
  test("clearing hidden filters preserves the visible cohort, time and link intent", () => {
    const params = new URLSearchParams("providers=missing&efforts=unknown&statuses=error&range=30d&models=synthetic&agents=main&search=example&tag=one&tag=two");
    const cleared = patchFilterParams(params, { providers: [], efforts: [], statuses: [] });
    expect([...cleared]).toEqual([...params].filter(([key]) => !["providers", "efforts", "statuses"].includes(key)));
    expect(filtersFromParams(cleared)).toMatchObject({ providers: [], efforts: [], statuses: [] });
    expect(toolbar(cleared.toString())).toContain(">More filters<");
  });
});
