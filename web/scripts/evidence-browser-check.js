/** Evaluate in an owned native T3 tab. Read-only comparison of the loaded case with the real API. */
async function checkEvidenceBrowser() {
  const url = new URL(location.href);
  const params = new URLSearchParams();
  for (const key of ["investigation", "selector", "priorSelector", "period", "offset", "limit", "selectorVersion"]) {
    for (const value of url.searchParams.getAll(key)) params.append(key, value);
  }
  const response = await fetch(`/api/labs/evidence?${params}`);
  if (!response.ok) throw new Error(`Evidence API ${response.status}`);
  const body = await response.json();
  const root = document.querySelector("[data-evidence-case]");
  const failures = [];
  let assertions = 0;
  const check = (condition, label) => { assertions++; if (!condition) failures.push(label); };
  check(root?.getAttribute("data-evidence-case") === body.intent.investigation, "investigation");
  check(root?.querySelector("[data-case-summary]")?.textContent === body.observation.summary, "server observation template");
  const identities = [...(root?.querySelectorAll("[data-evidence-identity]") ?? [])].map(row => row.getAttribute("data-evidence-identity"));
  check(JSON.stringify(identities) === JSON.stringify(body.rows.map(row => row.identity)), "exact ordered page identities");
  for (const [index, row] of body.rows.entries()) {
    const element = root.querySelectorAll("[data-evidence-identity]")[index];
    const summary = element?.querySelector("summary")?.textContent ?? "";
    check(summary.includes(row.id), `request ID ${index}`);
    check(summary.includes(`#${row.ordinal}`), `selected ordinal ${index}`);
    check(summary.includes(`original ordinal ${row.originalOrdinal}`), `original ordinal ${index}`);
    check(summary.includes(String(row.ts)), `millisecond time ${index}`);
    check(summary.includes(row.conversationId ?? "Unnamed"), `session identity ${index}`);
    const definitions = Object.fromEntries([...element.querySelectorAll("dt")].map(dt => [dt.textContent, dt.nextElementSibling?.textContent]));
    check(definitions.Source.includes(`(${row.source})`), `protocol source ${index}`);
    check(definitions["Submitted input · tokens"] === (row.inputTokens === null ? "Unavailable" : row.inputTokens.toLocaleString("en-US")), `input presence ${index}`);
    check(definitions["API list-price equivalent · USD"] === (row.cost === null ? "Unavailable" : `$${row.cost.toFixed(6)}`), `price presence ${index}`);
    check(definitions.Duration === (row.durationMs === null ? "Unavailable" : `${row.durationMs} ms`), `timing presence ${index}`);
  }
  const windows = root.querySelectorAll("[data-case-window]");
  const current = body.intent.selector.window;
  check(windows[0]?.textContent.includes(new Date(current.from).toISOString()), "original current start");
  check(windows[0]?.textContent.includes(new Date(current.to).toISOString()), "original current end");
  if (body.intent.priorSelector) {
    const prior = body.intent.priorSelector.window;
    check(windows[1]?.textContent.includes(new Date(prior.from).toISOString()), "original prior start");
    check(windows[1]?.textContent.includes(new Date(prior.to).toISOString()), "original prior end");
    check(root.textContent.includes(`Inspecting original ${body.intent.period} requests`), "original paired period");
  }
  check(root.querySelector("[data-case-sample]").textContent.includes(`${body.population.eligibleRequests.toLocaleString("en-US")} of ${body.population.original.requests.toLocaleString("en-US")}`), "full sample denominator");
  check(root.querySelector("[data-evidence-page]").textContent.includes(`of ${body.page.total.toLocaleString("en-US")} evidence requests`), "full pagination denominator");
  check(document.documentElement.scrollWidth <= innerWidth, "no document horizontal overflow");
  return { assertions, failures, investigation: body.intent.investigation, period: body.intent.period, selection: body.intent.selector.selection,
    rows: body.rows.length, original: body.population.original.requests, eligible: body.population.eligibleRequests,
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light", selector: url.searchParams.get("selector"), priorSelector: url.searchParams.get("priorSelector") };
}
