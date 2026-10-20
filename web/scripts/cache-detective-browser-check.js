/** Run this function via native T3 preview_evaluate on the isolated L05 fixture. */
export async function checkCacheDetectiveBrowser() {
  const assert = (condition, label) => { if (!condition) throw new Error(`L05 browser: ${label}`); };
  const equal = (actual, expected, label) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  const params = new URLSearchParams(location.search);
  params.set("limit", "100");
  const response = await fetch(`/api/labs/cache?${params}`);
  assert(response.ok, "real synthetic API responds");
  const data = await response.json();
  const root = document.querySelector('[data-investigation="cache-detective"]');
  assert(root, "registered view mounted");
  const supported = totals => totals.eligibleRequests > 0 && totals.direction !== "insufficient";
  const usd = (value, eligible, signed = false) => eligible ? `${value < 0 ? "−" : signed && value > 0 ? "+" : ""}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 })}` : "Unavailable";
  const compare = (element, totals) => {
    for (const [label, value, signed] of [["Read discount", totals.readDiscountUsd, false], ["Write premium", totals.writePremiumUsd, false], ["Net ·", totals.netUsd, true], ["Actual ·", totals.actualUsd, false], ["Baseline ·", totals.baselineUsd, false]]) {
      const dt = [...element.querySelectorAll("dt")].find(item => item.textContent.startsWith(label));
      equal(dt?.nextElementSibling?.textContent, usd(value, supported(totals), signed), label);
    }
    assert(element.textContent.includes(`${totals.eligibleRequests.toLocaleString("en-US")} eligible / ${totals.totalRequests.toLocaleString("en-US")} total`), "eligible/total coverage");
  };
  compare(root.querySelector('[aria-label="Scope cache comparison"]'), data.totals);
  const rows = [...root.querySelectorAll("tbody tr")];
  equal(rows.length, data.sessions.length, "ranking length");
  rows.forEach((row, index) => {
    const session = data.sessions[index];
    const button = row.querySelector("button");
    equal(button.getAttribute("aria-label"), `Inspect ${session.source} session ${session.conversationId}`, "source-qualified session");
    const cells = row.querySelectorAll("td");
    equal(cells[1].textContent, `${session.eligibleRequests.toLocaleString("en-US")} / ${session.totalRequests.toLocaleString("en-US")}`, "session coverage");
    equal(cells[2].textContent, usd(session.readDiscountUsd, supported(session)), "session read");
    equal(cells[3].textContent, usd(session.writePremiumUsd, supported(session)), "session write");
    equal(cells[4].querySelector("span").textContent, usd(session.netUsd, supported(session), true), "session net");
  });
  const links = [...root.querySelectorAll('a[href^="/labs/evidence?"]')];
  const evidence = links.map(link => {
    const url = new URL(link.href);
    const selector = JSON.parse(url.searchParams.get("selector"));
    equal(selector.eligibility, "cache", "authoritative cache eligibility");
    equal(url.searchParams.get("eligibility"), "cache", "cache mirror");
    equal(url.searchParams.get("investigation"), "cache-detective", "investigation template");
    assert(!url.searchParams.has("range"), "evidence contains no rolling range");
    equal(selector.cohort, data.scope.cohort, "lossless full cohort");
    for (const name of ["from", "to", "tz"]) equal(selector.window[name], data.scope.window[name], `fixed ${name}`);
    const selection = selector.selection;
    const totals = selection.kind === "scope" ? data.totals : selection.kind === "unnamed" ? data.unnamed
      : data.sessions.find(session => session.source === selection.source && session.conversationId === selection.conversationId);
    assert(totals, "evidence population exists in real payload");
    equal(selector, totals.evidence.selector, "exact server selector");
    const server = new URL(totals.evidence.href, location.origin);
    for (const [name, value] of server.searchParams) equal(url.searchParams.get(name), value, `server href ${name}`);
    if (selection.kind !== "scope") compare(root.querySelector('[aria-label="Selected cache breakdown"]'), totals);
    return selection;
  });
  for (const time of root.querySelectorAll("time")) assert([data.scope.window.from, data.scope.window.to].some(ts => time.dateTime === new Date(ts).toISOString()), "rendered fixed time");
  assert(document.documentElement.scrollWidth <= innerWidth, "no page horizontal overflow");
  assert(!/NaN|Invalid Date|Infinity|\[object Object\]/.test(root.textContent), "no broken values");
  return { direction: data.totals.direction, eligible: data.totals.eligibleRequests, total: data.totals.totalRequests, netUsd: data.totals.netUsd, evidence, theme: document.documentElement.classList.contains("dark") ? "dark" : "light", rankingRows: rows.length, fixedWindow: data.scope.window, cohort: data.scope.cohort };
}
