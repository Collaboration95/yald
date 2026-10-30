import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { activeFilterCount, filtersToParams, type Filters } from "../src/api";
import { FiltersProvider, patchFilterParams } from "../src/lib/useFilters";
import { useLabsFilters } from "../src/pages/labs/shared";
import { usageCompositionOption } from "../src/pages/Usage";
import type { ThemeTokens } from "../src/components/chartOptions";

const inherited = new URLSearchParams({ range: "30d", sources: "claude-code", projects: "/synthetic/app", models: "claude-test",
  providers: "wrong-provider", efforts: "high", statuses: "error", routeKinds: "native", search: "no-match", conversationId: "other-session",
  groupBy: "provider", metric: "requests", bucket: "hour", tz: "UTC" });
function renderedFilters(path: string, params = inherited): Filters {
  let result: Filters | undefined;
  function Probe() { result = useLabsFilters(); return null; }
  renderToString(<MemoryRouter initialEntries={[`${path}?${params}`]}><FiltersProvider><Probe /></FiltersProvider></MemoryRouter>);
  return result!;
}

describe("Labs effective toolbar scope", () => {
  for (const path of ["/labs", "/labs/", "/labs/spend-spikes", "/labs/project-radar", "/labs/cache-detective", "/labs/context-replay", "/labs/project-radar/"]) {
    test(`${path} ignores inherited hidden filters and counts only its visible cohort`, () => {
      const effective = renderedFilters(path);
      expect(Object.fromEntries(new URLSearchParams(filtersToParams(effective)))).toEqual({
        range: "30d", sources: "claude-code", projects: "/synthetic/app", models: "claude-test", tz: "UTC",
      });
      expect(activeFilterCount(effective)).toBe(3);
      expect(inherited.get("providers")).toBe("wrong-provider");
    });
  }
  test("explicit relative window and timezone survive the Labs scope", () => {
    expect(renderedFilters("/labs/cache-detective", new URLSearchParams("last=12h&tz=Asia/Singapore"))).toMatchObject({ last: "12h", tz: "Asia/Singapore" });
  });
  test("main pages and explicit evidence cases retain their request selectors", () => {
    for (const path of ["/usage", "/labs/evidence", "/sessions/synthetic"]) {
      expect(renderedFilters(path).providers).toEqual(["wrong-provider"]);
      expect(activeFilterCount(renderedFilters(path))).toBe(9);
    }
  });
});

describe("spike day belongs to its time window", () => {
  const intent = new URLSearchParams({ range: "30d", day: "2026-09-20", selector: '{"cohort":{"providers":["literal,provider"]}}',
    priorSelector: "paired-case", sessionSource: "claude-code", investigation: "spend-changes" });
  for (const patch of [{ range: "24h" }, { from: "2026-09-25" }, { to: "2026-09-30" }, { last: "12h" }, { tz: "Asia/Singapore" }]) {
    test(`${JSON.stringify(patch)} clears the old day while preserving evidence and session intent`, () => {
      const next = patchFilterParams(intent, patch);
      expect(next.has("day")).toBe(false);
      for (const key of ["selector", "priorSelector", "sessionSource", "investigation"]) expect(next.get(key)).toBe(intent.get(key));
      expect(intent.get("day")).toBe("2026-09-20");
    });
  }
  test("unrelated edits and unchanged windows preserve the selected day", () => {
    expect(patchFilterParams(intent, { sources: ["ocx"] }).get("day")).toBe("2026-09-20");
    expect(patchFilterParams(intent, { range: "30d" }).get("day")).toBe("2026-09-20");
    const custom = new URLSearchParams(intent); custom.set("from", "2026-09-15");
    expect(patchFilterParams(custom, { range: "30d" }).has("day")).toBe(false);
  });
});

test("Cached + New reconciles cache-write-heavy Claude token accounting, without double-counting reasoning", () => {
  const sample = { ts: 0, label: "Synthetic Claude", freshInput: 1000, cacheRead: 2000, cacheWrite: 60000, output: 500,
    reasoning: 300, total: 63500, requests: 1 };
  const theme: ThemeTokens = { text: "#000", axis: "#000", split: "#eee", tooltipBg: "#fff", tooltipBorder: "#ddd", area: "#eee" };
  const option = usageCompositionOption(theme, [sample, { ...sample, label: "Empty", freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }]);
  const series = option.series as { name: string; data: number[] }[];
  expect(series.map(s => s.name)).toEqual(["Cached", "New"]);
  expect(series[0]!.data).toEqual([2000, 0]);
  expect(series[1]!.data).toEqual([61500, 0]);
  expect(series[0]!.data[0]! + series[1]!.data[0]!).toBe(sample.total);
});
