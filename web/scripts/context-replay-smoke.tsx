/** Compare actual L06 endpoint payloads with the L07 render and chart consumers. */
import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_FILTERS, fetchJson, filtersFromParams, filtersToParams } from "../src/api";
import { ChartStyleContext } from "../src/lib/chartStyle";
import { makeRelayStyle } from "../src/lib/relayStyle";
import { YaldiSmokeProviders } from "./yaldi-smoke";
import { FiltersProvider } from "../src/lib/useFilters";
import { ContextReplay, ContextReplayView } from "../src/pages/labs/ContextReplay";
import { LABS_INVESTIGATIONS } from "../src/pages/labs/investigations";
import { contextEvidenceHref, contextTimelineOption } from "../src/pages/labs/contextReplayChart";
import type { ContextReplayResponse } from "../src/types";
import { CONTEXT_REPLAY_FROM, CONTEXT_REPLAY_TO, CONTEXT_REPLAY_PARAMS } from "./context-replay-fixtures";
import { evidenceFor } from "../../server/src/labs/scope";

const theme = { text: "#29292b", axis: "#69696c", split: "#e5e5e2", tooltipBg: "#fff", tooltipBorder: "#d5d5d1", area: "transparent" };
const plain = (html: string) => html.replace(/<!--.*?-->/g, "");

export async function checkContextReplaySmoke() {
  let checks = 0;
  const check = (fn: () => void, label: string) => { fn(); checks++; console.log(`PASS  L07 ${label}`); };
  const data = await fetchJson<ContextReplayResponse>("/api/labs/context", CONTEXT_REPLAY_PARAMS);
  const main = data.sessions.find(s => s.source === "ocx" && s.conversationId === "l07-shared")!;
  const transcript = data.sessions.find(s => s.source === "claude-code" && s.conversationId === "l07-shared")!;
  const models = [...new Set(data.sessions.flatMap(s => s.requests.map(r => r.model)))];
  const render = (payload: ContextReplayResponse, dark = false) => renderToString(<YaldiSmokeProviders theme={dark ? "dark" : "light"}><ChartStyleContext.Provider value={makeRelayStyle(dark, models)}>
    <MemoryRouter><ContextReplayView data={payload} /></MemoryRouter></ChartStyleContext.Provider></YaldiSmokeProviders>);

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
        const option: any = style.chart(contextTimelineOption(theme, session, data.window.tz));
        assert.equal(option.series.length, 1);
        assert.equal(option.xAxis.data.length, session.requests.length);
        for (const [index, row] of session.requests.entries()) {
          // A request without a measured input leaves a gap; a measured zero is drawn.
          assert.equal(option.series[0].data[index], row.eligible ? row.inputTokens : null);
        }
        assert.equal(option.series[0].connectNulls, false);
      }
      const zero = main.requests.findIndex(r => r.id === "l07-zero");
      assert.equal((contextTimelineOption(theme, main, data.window.tz) as any).series[0].data[zero], 0);
    }, `${dark ? "dark" : "light"} chart: ineligible requests leave gaps, measured zero is drawn`);
    check(() => {
      const html = plain(render(data, dark));
      assert.match(html, /Sessions grow about/);
      assert.match(html, /Fastest-growing sessions/);
      assert.match(html, /Input per request/);
      for (const bad of ["NaN", "Invalid Date", "Infinity"]) assert(!html.includes(bad));
      // A session with fewer than six measured requests is not ranked, and the page says so instead of inventing a growth figure.
      const short = data.sessions.find(s => s.conversationId === "l07-short")!;
      const shortHtml = plain(render({ ...data, sessions: [short] }, dark));
      assert.match(shortHtml, /Not enough long sessions to measure growth/);
      for (const session of [main, transcript, short]) {
        const shown = plain(render({ ...data, sessions: [session] }, dark));
        const href = shown.match(/href="([^"]+)"[^>]*>See the requests<\/a>/)![1]!.replace(/&amp;/g, "&");
        const original = new URL(session.evidence.href, "http://fixture.invalid");
        const intent = new URL(href, "http://fixture.invalid");
        for (const [key, value] of original.searchParams) assert.equal(intent.searchParams.get(key), value);
        assert.deepEqual(JSON.parse(intent.searchParams.get("selector")!).selection, { kind: "session", source: session.source, conversationId: session.conversationId });
      }
    }, `${dark ? "dark" : "light"} render: verdict, ranking, chart and evidence link`);
  }

  check(() => {
    for (const evidence of [data.coverage.evidence, ...data.sessions.map(s => s.evidence)]) {
      const original = new URL(evidence.href, "http://localhost");
      const intent = new URL(contextEvidenceHref(evidence), "http://localhost");
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
    const html = plain(renderToString(<QueryClientProvider client={client}><YaldiSmokeProviders><MemoryRouter initialEntries={[`/labs/context-replay?${filteredParams}`]}>
      <FiltersProvider><ContextReplay /></FiltersProvider></MemoryRouter></YaldiSmokeProviders></QueryClientProvider>));
    assert.match(html, /Session l07-sh/);
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
  check(() => {
    assert.equal(empty.coverage.totalRequests, 0);
    assert.match(render(empty), /No requests to investigate/);
    const unseeded = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const stateRender = () => renderToString(<QueryClientProvider client={unseeded}><YaldiSmokeProviders><MemoryRouter><FiltersProvider><ContextReplay /></FiltersProvider></MemoryRouter></YaldiSmokeProviders></QueryClientProvider>);
    assert.match(stateRender(), /Loading investigation/);
    unseeded.clear();
  }, "empty and loading states remain readable");
  console.log(`PASS  L07 ${checks} focused API/render/chart groups`);
}
