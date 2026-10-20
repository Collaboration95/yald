/** Compare actual L06 endpoint payloads with the L07 render and chart consumers. */
import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_FILTERS, fetchJson, filtersFromParams, filtersToParams } from "../src/api";
import { lineChart } from "../src/components/chartOptions";
import { ChartStyleContext } from "../src/lib/chartStyle";
import { makeRelayStyle } from "../src/lib/relayStyle";
import { ThemeProvider } from "../src/lib/theme";
import { FiltersProvider } from "../src/lib/useFilters";
import { ContextReplay, ContextReplayView, ContextRequestDetails } from "../src/pages/labs/ContextReplay";
import { LABS_INVESTIGATIONS } from "../src/pages/labs/investigations";
import { contextCost, contextEvidenceHref, contextTimelineOption } from "../src/pages/labs/contextReplayChart";
import type { ContextReplayResponse } from "../src/types";
import { CONTEXT_REPLAY_FROM, CONTEXT_REPLAY_TO, CONTEXT_REPLAY_PARAMS } from "./context-replay-fixtures";
import { evidenceFor } from "../../server/src/labs/scope";

const theme = { text: "#29292b", axis: "#69696c", split: "#e5e5e2", tooltipBg: "#fff", tooltipBorder: "#d5d5d1", area: "transparent" };
const plain = (html: string) => html.replace(/<!--.*?-->/g, "");
const number = (value: number | null) => value === null ? "Unavailable" : value.toLocaleString("en-US");
const htmlText = (html: string) => plain(html).replace(/<[^>]*>/g, "");

export async function checkContextReplaySmoke() {
  let checks = 0;
  const check = (fn: () => void, label: string) => { fn(); checks++; console.log(`PASS  L07 ${label}`); };
  const data = await fetchJson<ContextReplayResponse>("/api/labs/context", CONTEXT_REPLAY_PARAMS);
  const main = data.sessions.find(s => s.source === "ocx" && s.conversationId === "l07-shared")!;
  const transcript = data.sessions.find(s => s.source === "claude-code" && s.conversationId === "l07-shared")!;
  const models = [...new Set(data.sessions.flatMap(s => s.requests.map(r => r.model)))];
  const render = (payload: ContextReplayResponse, dark = false) => renderToString(<ThemeProvider><ChartStyleContext.Provider value={makeRelayStyle(dark, models)}>
    <MemoryRouter><ContextReplayView data={payload} /></MemoryRouter></ChartStyleContext.Provider></ThemeProvider>);

  check(() => {
    assert.deepEqual(main.growth, { ranked: true, baseline: 200, latest: 1000, absoluteChange: 800, ratio: 5 });
    assert.deepEqual(transcript.growth, { ranked: true, baseline: 500, latest: 50, absoluteChange: -450, ratio: 0.1 });
    assert.notEqual(main.key, transcript.key);
    assert.equal(data.coverage.totalRequests, 28);
    assert.equal(data.coverage.eligibleRequests + data.coverage.excludedRequests, data.coverage.totalRequests);
    assert.equal(data.sessions.reduce((n, s) => n + s.inWindowRequests, 0) + data.unnamedRequests, data.coverage.totalRequests);
    assert.deepEqual(main.requests.slice(0, 3).map(row => [row.id, row.ordinal, row.inputTokens]), [["l07-a", 0, 300], ["l07-a", 1, 200], ["l07-b", 2, 100]]);
  }, "real API growth medians, source collisions, equal-time duplicate ordinals and coverage");

  for (const dark of [false, true]) {
    const style = makeRelayStyle(dark, models);
    check(() => {
      for (const session of data.sessions) {
        const option: any = style.chart(contextTimelineOption(theme, session, data.window.tz, style.modelColor));
        assert.match(option.xAxis.name, /Request index.*Asia\/Singapore/);
        assert.equal(option.yAxis.name, "Input tokens");
        assert.equal(new Set(option.xAxis.data).size, session.requests.length);
        for (const [index, row] of session.requests.entries()) {
          assert.match(option.xAxis.data[index], new RegExp(`^#${row.ordinal + 1}\\n`));
          assert.deepEqual(option.series.slice(0, 3).map((s: any) => s.data[index]), row.eligible ? [row.inputTokens, row.cacheReadTokens, row.cacheWriteTokens] : [null, null, null]);
          for (const series of option.series.slice(3)) {
            assert.equal(series.data[index], row.eligible && series.name === `Model · ${row.model}` ? row.inputTokens : null);
          }
          if (!row.eligible) {
            assert(option.series.every((s: any) => s.data[index] === null));
            assert.match(option.tooltip.formatter([{ dataIndex: index }]), /Submitted input: Unavailable<br\/>Cache read: Unavailable<br\/>Cache write: Unavailable/);
          }
        }
        for (const series of option.series.slice(0, 3)) {
          assert.equal(series.connectNulls, false);
          assert.equal(series.smooth, 0);
          assert.equal(series.symbol, "circle");
        }
        assert.equal(option.tooltip.valueFormatter(null), "Unavailable");
        assert.equal(option.tooltip.valueFormatter(undefined), "Unavailable");
        assert.equal(option.tooltip.valueFormatter("-"), "Unavailable");
        assert.equal(option.tooltip.valueFormatter(0), "0");
        for (const marker of option.series.slice(3)) assert.equal(marker.itemStyle.color, style.modelColor(marker.name.slice("Model · ".length)));
      }
      const option: any = contextTimelineOption(theme, main, data.window.tz, style.modelColor);
      const sum = main.requests.findIndex(r => r.id === "l07-attempt-sum");
      assert.equal(main.requests[sum]!.cacheReadTokens, 500);
      assert(option.series.every((s: any) => s.data[sum] === null));
      const zero = main.requests.findIndex(r => r.id === "l07-zero");
      assert.deepEqual(option.series.slice(0, 3).map((s: any) => s.data[zero]), [0, 0, 0]);
      assert.match(option.tooltip.formatter([{ dataIndex: zero }]), /Submitted input: 0<br\/>Cache read: 0<br\/>Cache write: 0/);
      const missingCache = main.requests.findIndex(r => r.id === "l07-no-cache-accounting");
      assert.deepEqual(option.series.slice(0, 3).map((s: any) => s.data[missingCache]), [800, null, null]);
      const defaults: any = lineChart(theme, ["a", "b"], [{ name: "existing", data: [0, null] }]);
      assert.equal(defaults.series[0].connectNulls, true);
      assert.equal(defaults.tooltip.valueFormatter(null), "0");
    }, `${dark ? "dark" : "light"} chart values: all ineligible series masked, gaps disconnected, zero drawn, stable model colors, shared defaults retained`);
    check(() => {
      const html = plain(render(data, dark));
      const labels = [...html.matchAll(/aria-label="Select ([^"]+) session ([^"]+)"/g)].map(match => match[2]);
      assert.deepEqual(labels, data.sessions.map(s => s.conversationId));
      assert.match(html, /First-three median 200 → last-three median 1,000 input tokens · change \+800 tokens/);
      assert.match(html, /Sequence limited by the window and the cohort/);
      assert.match(html, /1 loaded requests before the window, 1 at or after its end, 1 within the window outside the cohort/);
      assert.match(html, /attempt-summed usage: 1/);
      for (const bad of ["NaN", "Invalid Date", "Infinity"]) assert(!html.includes(bad));
      const short = data.sessions.find(s => s.conversationId === "l07-short")!;
      const shortHtml = plain(render({ ...data, sessions: [short] }, dark));
      assert.match(shortHtml, /Insufficient data · unranked/);
      assert.match(shortHtml, /2 eligible requests; at least six are needed/);
      assert.match(shortHtml, /l07-short-unpriced/);
      const zero = data.sessions.find(s => s.conversationId === "l07-zero-baseline")!;
      assert.match(plain(render({ ...data, sessions: [zero] }, dark)), /Unavailable · zero baseline/);
      assert.equal(zero.growth.ratio, null);
      const excluded = data.sessions.find(s => s.conversationId === "l07-excluded")!;
      assert.match(plain(render({ ...data, sessions: [excluded] }, dark)), /0 eligible requests; at least six are needed/);
      const tooltip: any = contextTimelineOption(theme, { ...short, requests: [{ ...short.requests[0]!, id: "<fixture>" }] }, data.window.tz);
      assert.match(tooltip.tooltip.formatter([{ dataIndex: 0 }]), /&lt;fixture&gt;/);
    }, `${dark ? "dark" : "light"} render uses server ranking, medians, truncation, short/zero-baseline/excluded states`);
  }

  check(() => {
    for (const session of data.sessions) for (const row of session.requests) {
      const html = plain(renderToStaticMarkup(<ContextRequestDetails row={row} session={session} tz={data.window.tz} />));
      const values = [...html.matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(match => [match[1], htmlText(match[2]!)]);
      const detail = Object.fromEntries(values);
      assert.equal(detail["Submitted input · tokens"], number(row.eligible ? row.inputTokens : null));
      assert.equal(detail["Cache read · tokens"], number(row.cacheReadTokens));
      assert.equal(detail["Cache write · tokens"], number(row.cacheWriteTokens));
      assert.equal(detail["Output · tokens"], number(row.outputTokens));
      assert.equal(detail["Reasoning within output · tokens"], number(row.reasoningTokens));
      assert.equal(detail["Total · input + output tokens"], number(row.totalTokens));
      assert.equal(detail["API list-price equivalent · USD"], contextCost(row));
      assert.equal(detail["Request ID"], row.id);
      if (row.durationMs === null) assert.equal(detail.Duration, "Unavailable");
      if (row.durationMs === 0) assert.equal(detail.Duration, "0 ms");
      if (row.ttftMs === null) assert.equal(detail["Time to first token"], "Unavailable");
      if (!row.eligible) assert.match(html, /Excluded from context comparisons/);
    }
    assert.equal(main.requests[0]!.totalTokens, 320); // 300 input + 20 output; reasoning 2 is already within output.
    assert.equal(contextCost(main.requests.find(r => r.id === "l07-zero")!), "$0.00");
    assert.equal(contextCost(main.requests.find(r => r.id === "l07-unpriced")!), "Unavailable (unpriced)");
    assert(transcript.requests.every(row => row.durationMs === null && row.ttftMs === null));
  }, "every real request detail preserves tokens, total, attempt counters, price presence and missing/zero timing");

  check(() => {
    for (const evidence of [data.coverage.evidence, ...data.sessions.map(s => s.evidence)]) {
      const original = new URL(evidence.href, "http://localhost");
      const href = contextEvidenceHref(evidence);
      const intent = new URL(href, "http://localhost");
      assert.equal(intent.pathname, "/labs/evidence");
      assert.equal(intent.searchParams.get("investigation"), "context-replay");
      assert.equal(intent.searchParams.get("eligibility"), "all");
      assert.deepEqual(JSON.parse(intent.searchParams.get("selector")!), evidence.selector);
      assert.equal(intent.searchParams.get("selector"), original.searchParams.get("selector"));
      assert.equal(intent.searchParams.get("from"), String(CONTEXT_REPLAY_FROM));
      assert.equal(intent.searchParams.get("to"), String(CONTEXT_REPLAY_TO));
      for (const [key, value] of original.searchParams) assert.equal(intent.searchParams.get(key), value);
    }
    assert.equal(LABS_INVESTIGATIONS.find(i => i.path === "context-replay")?.Component, ContextReplay);
    const commaEvidence = evidenceFor({ projects: ["/synthetic/{one,two}"], models: ["l07,model"], providers: ["synthetic,provider"] }, data.window,
      { kind: "session", source: "ocx", conversationId: "l07,session" }, "all");
    const commaUrl = new URL(contextEvidenceHref(commaEvidence), "http://localhost");
    assert.deepEqual(JSON.parse(commaUrl.searchParams.get("selector")!), commaEvidence.selector);
    assert.equal(commaUrl.searchParams.get("sessionId"), "l07,session");
  }, "evidence retains exact server session/source/window/cohort and eligibility all, appending investigation only");

  const filteredParams = new URLSearchParams(CONTEXT_REPLAY_PARAMS);
  for (const [key, value] of Object.entries({ sources: "ocx", projects: "/synthetic/context/project", providers: "anthropic", models: "l07-alpha", statuses: "ok", routeKinds: "native", conversationId: "l07-shared" })) filteredParams.set(key, value);
  const scoped = await fetchJson<ContextReplayResponse>("/api/labs/context", filteredParams.toString());
  check(() => {
    assert.equal(scoped.sessions.length, 1);
    assert.equal(scoped.sessions[0]!.source, "ocx");
    assert(scoped.sessions[0]!.requests.every(r => r.source === "ocx" && r.model === "l07-alpha"));
    const filters = filtersFromParams(filteredParams);
    const params = filtersToParams(filters);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["/api/labs/context", params], scoped);
    const html = plain(renderToString(<QueryClientProvider client={client}><ThemeProvider><MemoryRouter initialEntries={[`/labs/context-replay?${filteredParams}`]}>
      <FiltersProvider><ContextReplay /></FiltersProvider></MemoryRouter></ThemeProvider></QueryClientProvider>));
    assert.match(html, /l07-shared/);
    assert(!html.includes("l07-claude-0"));
    assert(!html.includes("l07-model-change"));
    const links = [...html.matchAll(/href="([^"]*investigation=context-replay[^"]*)"/g)].map(match => new URL(match[1]!.replace(/&amp;/g, "&"), "http://localhost"));
    assert(links.some(link => JSON.stringify(JSON.parse(link.searchParams.get("selector")!).cohort) === JSON.stringify(scoped.cohort)));
    client.clear();
    assert.equal(scoped.cohort.projects[0], "/synthetic/context/project");
    assert.equal(scoped.cohort.efforts[0], "high");
    assert.equal(scoped.cohort.search, "l07-");
    assert.equal(scoped.sessions[0]!.history.cohortLimited, true);
  }, "all source/project/request filters flow through the real hook, selection and evidence together");

  const emptyParams = new URLSearchParams(CONTEXT_REPLAY_PARAMS); emptyParams.set("models", "l07-absent");
  const empty = await fetchJson<ContextReplayResponse>("/api/labs/context", emptyParams.toString());
  const unnamedParams = new URLSearchParams(CONTEXT_REPLAY_PARAMS); unnamedParams.set("search", "l07-unnamed");
  const unnamed = await fetchJson<ContextReplayResponse>("/api/labs/context", unnamedParams.toString());
  check(() => {
    assert.equal(empty.coverage.totalRequests, 0);
    assert.match(render(empty), /No requests to investigate/);
    assert.equal(unnamed.unnamedRequests, 2);
    assert.equal(unnamed.sessions.length, 0);
    assert.match(render(unnamed), /No named sessions/);
    assert.match(render(unnamed), /Open scope requests/);
    const unseeded = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToString(<QueryClientProvider client={unseeded}><MemoryRouter><FiltersProvider><ContextReplay /></FiltersProvider></MemoryRouter></QueryClientProvider>);
    assert.match(html, /Loading investigation/);
    unseeded.setQueryData(["/api/labs/context", filtersToParams(DEFAULT_FILTERS)], data);
    unseeded.getQueryCache().find({ queryKey: ["/api/labs/context", filtersToParams(DEFAULT_FILTERS)] })!.setState({ status: "error", error: new Error("Synthetic L07 API error") });
    assert.match(renderToString(<QueryClientProvider client={unseeded}><MemoryRouter><FiltersProvider><ContextReplay /></FiltersProvider></MemoryRouter></QueryClientProvider>), /Synthetic L07 API error/);
    unseeded.clear();
  }, "empty, unnamed, loading and error states remain readable");
  console.log(`PASS  L07 ${checks} focused API/render/chart groups`);
}
