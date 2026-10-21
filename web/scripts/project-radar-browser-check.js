// Evaluate this expression with native T3 preview_evaluate on the L03 synthetic server.
// It reads the real endpoint and page; it does not stub a payload or drive another tab.
(async () => {
  const root = document.querySelector("[data-project-radar]");
  if (!root) throw new Error("Project Radar has not loaded");
  const response = await fetch(`/api/labs/projects${location.search}`);
  if (!response.ok) throw new Error(`Fixture API ${response.status}`);
  const data = await response.json();
  let checks = 0;
  const equal = (actual, expected, label) => {
    checks++;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  };
  const includes = (node, text, label) => {
    checks++;
    if (!node?.textContent.includes(text)) throw new Error(`${label}: missing ${text}`);
  };
  const integer = value => value.toLocaleString("en-US");
  const money = totals => totals.pricedRequests ? `$${totals.pricedCostUsd.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 })}` : "Unavailable";
  equal(/NaN|Infinity|Invalid Date|undefined|\[object Object\]/.test(root.textContent), false, "No invalid values");
  for (const [period, window] of [["current", data.window], ["prior", data.priorWindow]]) {
    const label = root.querySelector(`[data-radar-period="${period}"]`);
    includes(label, window.label, `${period} exact period label`);
    equal([...label.querySelectorAll("time")].map(time => time.dateTime), [window.fromIso, window.toIso], `${period} exact bounds`);
  }
  const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
  const scope = [...root.querySelectorAll("summary")].find(node => node.textContent === "Filtered scope, totals and excluded populations");
  equal(Boolean(root.querySelector("[data-finding-summary]").compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING), true, "Finding precedes verbose scope");
  if (!data.current.totals.requests && !data.prior.totals.requests) {
    includes(root, "No requests to investigate", "Empty state");
    equal(root.querySelectorAll("[data-radar-evidence], [data-chart]").length, 0, "No fabricated evidence/chart on empty data");
    return { checks, theme, empty: true, current: data.current.totals, prior: data.prior.totals };
  }
  equal([...root.querySelectorAll("[data-radar-project]")].map(row => row.dataset.radarProject), data.projects.map(project => project.project), "Server ranking order");
  const selection = root.querySelector("[data-selected-project]").dataset.selectedProject;
  const selected = data.projects.find(project => project.project === selection);
  if (!selected) throw new Error("Selected project is outside the response");
  equal(root.querySelectorAll('[data-radar-project] button[aria-pressed="true"]').length, 1, "One selected project");
  equal(root.querySelector('[data-radar-project] button[aria-pressed="true"]').closest("tr").dataset.radarProject, selection, "Ranking and detail selection agree");
  for (const metric of ["requests", "tokens", "pricedCostUsd"]) {
    const block = root.querySelector(`[data-radar-metric="${metric}"]`);
    for (const period of ["current", "prior"]) includes(block.querySelector(`[data-period="${period}"]`), metric === "pricedCostUsd" ? money(selected[period].totals) : integer(selected[period].totals[metric]), `${period} ${metric} server value`);
    const change = selected.comparison[metric];
    equal(block.querySelector("[data-comparison-state]").dataset.comparisonState, change.state, `${metric} server state`);
    if (change.state === "compared" && change.relativeChange !== null) includes(block, `${change.relativeChange > 0 ? "+" : ""}${(change.relativeChange * 100).toFixed(1)}%`, `${metric} server ratio`);
  }
  for (const period of ["current", "prior"]) {
    const link = root.querySelector(`[data-radar-evidence="${period}"]`);
    const params = new URL(link.href).searchParams;
    for (const [key, value] of new URL(selected.current.evidence.href, location.origin).searchParams) equal(params.get(key), value, `${period} retained original ${key}`);
    equal(params.get("investigation"), "project-radar", "Investigation identity");
    equal(params.get("period"), period, "Original paired period choice");
    equal(JSON.parse(params.get("selector")), selected.current.evidence.selector, "Original current selector retained");
    equal(JSON.parse(params.get("priorSelector")), selected.prior.evidence.selector, "Original prior selector retained");
    const daily = [...root.querySelectorAll(`[data-radar-daily="${period}"]`)];
    equal(daily.map(row => [Number(row.dataset.from), Number(row.dataset.to)]), selected[period].daily.map(day => [day.from, day.to]), "Occupied daily buckets only");
    daily.forEach((row, index) => {
      const day = selected[period].daily[index];
      const cells = row.querySelectorAll("td");
      includes(cells[0], integer(day.requests), "Daily requests");
      includes(cells[1], integer(day.tokens), "Daily tokens");
      includes(cells[2], money(day), "Daily price presence");
    });
    for (const mix of ["sources", "models"]) {
      const table = root.querySelector(`table[aria-label="${period === "current" ? "Current" : "Prior"} ${mix}"]`);
      if (!selected[period].totals.requests) continue;
      equal(table.querySelectorAll("tbody tr").length, selected[period][mix].length, `${period} ${mix} population`);
      [...table.querySelectorAll("tbody tr")].forEach((row, index) => {
        const value = selected[period][mix][index];
        const cells = row.querySelectorAll("td");
        includes(cells[0], integer(value.requests), "Mix requests");
        includes(cells[1], integer(value.tokens), "Mix tokens");
        includes(cells[2], money(value), "Mix price presence");
        if (mix === "models") { includes(row, value.provider, "Provider identity"); includes(row, value.model, "Model identity"); }
      });
    }
    for (const [label, value] of [["selected project", selected[period]], ["filtered scope", data[period]]]) {
      const coverage = root.querySelector(`[data-radar-coverage="${period === "current" ? "Current" : "Prior"} ${label}"]`);
      includes(coverage, `Priced: ${value.coverage.pricing.eligibleRequests}/${value.coverage.pricing.totalRequests}`, "Pricing denominator");
      includes(coverage, `Known project folder: ${value.coverage.attribution.eligibleRequests}/${value.coverage.attribution.totalRequests}`, "Attribution denominator");
      if (value.coverage.projectExclusions) {
        const excluded = value.coverage.projectExclusions.attribution;
        includes(coverage, `${excluded.outsideProjects.rows} requests / ${integer(excluded.outsideProjects.tokens)} tokens in other known projects`, "Outside-project population");
        includes(coverage, `${excluded.unattributed.rows} requests / ${integer(excluded.unattributed.tokens)} tokens without attribution excluded`, "Excluded unattributed population");
      }
    }
  }
  const noDaily = !selected.current.daily.length && !selected.prior.daily.length;
  const noDailyPrice = root.querySelector('[aria-label="Daily metric"]').value === "pricedCostUsd" && !selected.current.totals.pricedRequests && !selected.prior.totals.pricedRequests;
  const expectedChart = !noDaily && !noDailyPrice;
  // The real chart renderer is lazy-loaded. Wait for its canvas before judging it.
  const deadline = performance.now() + 5000;
  while (expectedChart && !root.querySelector("[data-chart] canvas") && performance.now() < deadline) await new Promise(resolve => requestAnimationFrame(resolve));
  const chart = root.querySelector("[data-chart]");
  equal(Boolean(chart), expectedChart, "Only observable values get a chart");
  if (expectedChart) {
    equal(chart.querySelectorAll("canvas").length, 1, "Daily chart rendered");
    equal(chart.getBoundingClientRect().width > 100 && chart.getBoundingClientRect().height === 250, true, "Chart has desktop dimensions");
  }
  const summary = root.querySelector("[data-finding-summary]");
  equal(summary.scrollWidth <= summary.clientWidth + 1, true, "Finding has no horizontal overflow");
  return { checks, theme, selected: selection, current: selected.current.totals, prior: selected.prior.totals, comparison: selected.comparison, days: { current: selected.current.daily.length, prior: selected.prior.daily.length }, chart: Boolean(chart) };
})()
