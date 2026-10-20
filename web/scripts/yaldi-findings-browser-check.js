/** Evaluate with native T3 on one of the three isolated production fixtures.
 * Pass the expected finding availability for the chosen synthetic case.
 * Reads the real API, selected summary, evidence, images and chart dimensions.
 */
export async function checkYaldiFindingsBrowser(expectedSupported) {
  let checks = 0;
  const assert = (condition, label) => { checks++; if (!condition) throw new Error(`B02 browser: ${label}`); };
  const equal = (actual, expected, label) => assert(JSON.stringify(actual) === JSON.stringify(expected), label);
  const view = location.pathname.split("/").at(-1);
  const endpoint = { "project-radar": "projects", "cache-detective": "cache", "context-replay": "context" }[view];
  assert(endpoint, "actual investigation route");
  const params = new URLSearchParams(location.search);
  if (endpoint === "cache") params.set("limit", "100");
  const response = await fetch(`/api/labs/${endpoint}?${params}`);
  assert(response.ok, "real synthetic response");
  const data = await response.json();
  const summary = document.querySelector(`[data-finding-summary="${view}"]`);
  const hidden = JSON.parse(localStorage.getItem("yald.preferences")).hideArtwork;
  const dark = document.documentElement.classList.contains("dark");
  const exactEvidence = (link, evidence) => {
    assert(link, "displayed evidence action");
    const intent = new URL(link.href);
    for (const [key, value] of new URL(evidence.href, location.origin).searchParams) equal(intent.searchParams.get(key), value, `unchanged evidence ${key}`);
    equal(intent.searchParams.get("investigation"), view, "investigation intent");
    return intent;
  };
  let selected = null;
  let observation = null;
  if (endpoint === "projects") {
    selected = document.querySelector("[data-selected-project]")?.dataset.selectedProject ?? null;
    const project = data.projects.find(item => item.project === selected);
    if (project) {
      for (const period of ["current", "prior"]) {
        const intent = exactEvidence(summary.querySelector(`[data-radar-evidence="${period}"]`), project.current.evidence);
        equal(intent.searchParams.get("priorSelector"), JSON.stringify(project.prior.evidence.selector), "exact paired prior selector");
        equal(intent.searchParams.get("period"), period, "original paired period");
      }
      observation = { current: project.current.totals, prior: project.prior.totals, comparison: project.comparison.pricedCostUsd };
    }
  } else if (endpoint === "cache") {
    exactEvidence([...summary.querySelectorAll("a")].find(link => link.textContent === "Open scope evidence"), data.totals.evidence);
    const detail = document.querySelector('[aria-label="Selected cache breakdown"]');
    if (detail) {
      const link = detail.querySelector("a");
      const selection = JSON.parse(new URL(link.href).searchParams.get("selector")).selection;
      selected = selection;
      const totals = selection.kind === "unnamed" ? data.unnamed : data.sessions.find(item => item.source === selection.source && item.conversationId === selection.conversationId);
      assert(totals, "selected cache population exists");
      exactEvidence(link, totals.evidence);
    }
    observation = { direction: data.totals.direction, eligible: data.totals.eligibleRequests, netUsd: data.totals.netUsd };
  } else if (summary) {
    const link = summary.querySelector("a");
    const selection = JSON.parse(new URL(link.href).searchParams.get("selector")).selection;
    selected = selection;
    const session = data.sessions.find(item => item.source === selection.source && item.conversationId === selection.conversationId);
    assert(session, "selected source-qualified Context session exists");
    exactEvidence(link, session.evidence);
    observation = session.growth;
    if (expectedSupported) {
      const number = value => value === null ? "Unavailable" : value.toLocaleString("en-US");
      assert(summary.textContent.includes(`First-three median ${number(session.growth.baseline)} → last-three median ${number(session.growth.latest)}`), "exact server medians");
      assert(summary.textContent.includes(`change ${session.growth.absoluteChange > 0 ? "+" : ""}${number(session.growth.absoluteChange)} tokens`), "exact server signed change");
      if (session.growth.ratio === null) assert(summary.textContent.includes("Unavailable"), "null ratio remains unavailable");
    }
  }
  const clues = document.querySelectorAll('img[src*="state-clue-found"]');
  equal(clues.length, expectedSupported && !hidden ? 1 : 0, "one clue only for the expected supported visible finding");
  if (clues.length) assert(summary.contains(clues[0]), "clue inside the actual selected finding summary");
  if (hidden) equal(document.querySelectorAll('img[src^="/yaldi/"]').length, 0, "mark, state and finding hidden together");
  for (const image of document.querySelectorAll('img[src^="/yaldi/"]')) {
    await image.decode();
    assert(image.src.endsWith(dark ? "-dark.svg" : ".svg") && (dark || !image.src.endsWith("-dark.svg")), "app theme chooses asset");
    equal(image.getAttribute("alt"), "", "decorative alternative");
    assert(image.getAttribute("aria-hidden") === "true" || image.closest('[aria-hidden="true"]'), "decorative accessibility");
    assert(image.getAttribute("width") === image.getAttribute("height") && ["32", "160"].includes(image.getAttribute("width")), "intrinsic dimensions retained");
    assert(getComputedStyle(image).animationName === "none", "static artwork");
  }
  const deadline = performance.now() + 5000;
  while (document.querySelector("[data-chart]") && !document.querySelector("[data-chart] canvas") && performance.now() < deadline) await new Promise(resolve => requestAnimationFrame(resolve));
  const charts = [...document.querySelectorAll("[data-chart]")].map(chart => ({ width: chart.clientWidth, height: chart.clientHeight, canvas: chart.querySelectorAll("canvas").length }));
  for (const chart of charts) assert(chart.width > 100 && chart.height >= 250 && chart.canvas > 0, "chart remains rendered and legible");
  assert(document.documentElement.scrollWidth <= innerWidth, "no document overflow");
  if (summary) assert(summary.scrollWidth <= summary.clientWidth + 1, "no finding overflow");
  equal(document.querySelector("aside").getBoundingClientRect().width, 190, "sidebar width retained");
  return { checks, view, selected, observation, theme: dark ? "dark" : "light", osDark: matchMedia("(prefers-color-scheme: dark)").matches, hidden, clue: clues.length, charts };
}
