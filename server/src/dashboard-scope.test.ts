import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { materializeFixtureHome, materializeFixturePricing } from "../../web/scripts/fixtureHome";

// F02 (#56): the dashboard source/project scope, qualified account views and source-qualified sessions.
// One synthetic fixture home is served by an isolated probe process, like api.test.ts.
const root = resolve(import.meta.dir, "../..");
const helper = join(root, "tests/helpers/store-probe.ts");
const owned: string[] = [];
const probes: ChildProcessWithoutNullStreams[] = [];

interface ApiResponse { path: string; status: number; body: any }
const sessionId = (seed: string) => createHash("sha256").update(seed).digest("hex").slice(0, 32);
/** The conversation id a fixture Codex session produces, deliberately reused by a Claude Code transcript. */
const SHARED_ID = sessionId("019a0000-0000-7000-8000-00000000000a");

let home = "";
let appA = "";
let appB = "";
let request: (...paths: string[]) => Promise<ApiResponse[]>;
const get = async (path: string) => (await request(path))[0]!;

beforeAll(async () => {
  home = await materializeFixtureHome({ reportDay: true });
  const pricing = await materializeFixturePricing();
  owned.push(home, pricing);
  appA = join(home, "work", "app-a");
  appB = join(home, "work", "app-b");
  // A Claude Code session whose id equals a Codex conversation id, in app-b (the Codex one is in app-a).
  const ts = Date.now() - 20 * 60_000;
  await mkdir(join(home, "claude-projects", "-work-app-b"), { recursive: true });
  const line = (turn: number) => JSON.stringify({ type: "assistant", requestId: `shared-${turn}`, sessionId: SHARED_ID, cwd: appB, timestamp: new Date(ts + turn * 60_000).toISOString(),
    message: { id: `msg_shared_${turn}`, model: "claude-fixture-opus", stop_reason: "end_turn", usage: { input_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 90 } } });
  await writeFile(join(home, "claude-projects", "-work-app-b", "shared.jsonl"), [0, 1].map(line).join("\n") + "\n");
  // An old Claude Code request outside every rolling window, in the same session.
  await appendFile(join(home, "claude-projects", "-work-app-b", "shared.jsonl"), JSON.stringify({ type: "assistant", requestId: "shared-old", sessionId: SHARED_ID, cwd: appB,
    timestamp: new Date(ts - 5 * 86_400_000).toISOString(), message: { id: "msg_shared_old", model: "claude-fixture-opus", stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 50 } } }) + "\n");
  const child = spawn(process.execPath, [helper, root], {
    cwd: root, stdio: "pipe",
    env: { ...process.env, OCX_HOME: home, CODEX_HOME: join(home, "codex"), CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), OCX_PACKAGE_DIR: pricing,
      YALD_TEST_PRICING_GENERATION: "", YALD_TEST_NOW: String(Date.now() + 60_000), TZ: "UTC", YALD_TZ: "UTC" },
  });
  probes.push(child);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const next = async () => {
    const next = await lines.next();
    if (next.done) throw new Error(`probe exited: ${stderr}`);
    return JSON.parse(next.value);
  };
  expect(await next()).toEqual({ ready: true });
  request = async (...paths) => {
    child.stdin.write(JSON.stringify({ op: "api", paths }) + "\n");
    const reply = await next();
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  };
});

afterAll(async () => {
  for (const child of probes.splice(0)) child.kill();
  await Promise.all(owned.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const q = (extra: string) => `range=all&${extra}`;
const esc = (value: string) => encodeURIComponent(value);

test("source and project choices come from the project aggregation under the other filters", async () => {
  const all = await get(`/api/projects?${q("")}`);
  const names = all.body.projects.map((p: any) => p.project);
  expect(names).toEqual(expect.arrayContaining([appA, appB, "(unattributed)"]));
  const unattributed = all.body.projects.find((p: any) => p.project === "(unattributed)");
  expect(unattributed.requests).toBeGreaterThan(0);
  // Source narrows the choices; `projects` itself is what the client omits so a multi-select keeps its options.
  const claudeOnly = await get(`/api/projects?${q("sources=claude-code")}`);
  expect(claudeOnly.body.projects.find((p: any) => p.project === appA).requests).toBeLessThan(all.body.projects.find((p: any) => p.project === appA).requests);
  expect(claudeOnly.body.projects.find((p: any) => p.project === "(unattributed)").requests).toBe(0);
});

test("every request route honours the same source and project selection", async () => {
  const selection = q(`sources=claude-code&projects=${esc(appA)}`);
  const [overview, timeseries, models, usage, cost, performance, reliability, conversations, filters, projects, scope, csv] = await request(
    ...["overview", "timeseries", "models", "usage", "cost", "performance", "reliability", "conversations", "filters", "projects", "scope"].map(name => `/api/${name}?${selection}`),
    `/api/export?${selection}`,
  );
  const expected = scope!.body.matched.requests;
  expect(expected).toBeGreaterThan(0);
  expect(overview!.body.summary.requests).toBe(expected);
  expect(overview!.body.recent.every((r: any) => r.source === "claude-code" && r.cwd.startsWith(appA))).toBe(true);
  expect(reliability!.body.measurementCoverage.totalRequests).toBe(expected);
  expect(usage!.body.summary.requests).toBe(expected);
  expect(cost!.body.summary.requests).toBe(expected);
  expect(models!.body.models.reduce((n: number, m: any) => n + m.requests, 0)).toBe(expected);
  expect(timeseries!.body.series).toBeDefined();
  expect(performance!.body.measurementCoverage.totalRequests).toBe(expected);
  expect(conversations!.body.totals.requests + conversations!.body.totals.unattributed).toBe(expected);
  expect(conversations!.body.conversations.every((c: any) => c.source === "claude-code")).toBe(true);
  expect(filters!.body.models).toEqual(["claude-fixture-opus"]);
  expect(csv!.body.trim().split("\n").length - 1).toBe(expected);
  // Project choices outside the selection are gone; the unattributed row stays visible as a count.
  expect(projects!.body.projects.map((p: any) => p.project)).not.toContain(appB);
  // Both sources, same project: the Codex rows come back.
  const both = await get(`/api/scope?${q(`projects=${esc(appA)}`)}`);
  expect(both.body.matched.requests).toBeGreaterThan(expected);
});

test("the scope lists the models in the window with counts, whatever model is selected", async () => {
  const all = await get(`/api/scope?${q("")}`);
  const models: { model: string; requests: number }[] = all.body.models;
  expect(models.length).toBeGreaterThan(0);
  expect(models.reduce((sum, entry) => sum + entry.requests, 0)).toBe(all.body.matched.requests);
  expect(models.every((entry, index) => index === 0 || models[index - 1]!.requests >= entry.requests)).toBe(true);
  const picked = await get(`/api/scope?${q(`models=${encodeURIComponent(models[0]!.model)}`)}`);
  expect(picked.body.models).toEqual(models);
  expect(picked.body.matched.requests).toBe(models[0]!.requests);
});

test("a project filter explains the usage it excluded and never assigns it to the project", async () => {
  const mixed = await get(`/api/scope?${q(`projects=${esc(appA)}`)}`);
  const total = await get(`/api/scope?${q("")}`);
  expect(mixed.body.coverage.unattributedRows).toBeGreaterThan(0);
  expect(mixed.body.coverage.attribution.unattributed.rows).toBe(mixed.body.coverage.unattributedRows);
  expect(mixed.body.matched.requests + mixed.body.coverage.attribution.outsideProjects.rows + mixed.body.coverage.unattributedRows).toBe(total.body.matched.requests);
  const overview = await get(`/api/overview?${q(`projects=${esc(appA)}`)}`);
  expect(overview.body.coverage.unattributedRows).toBe(mixed.body.coverage.unattributedRows);
  expect(overview.body.summary.requests).toBe(mixed.body.matched.requests);
  expect((await get(`/api/scope?${q("")}`)).body.coverage).toBeUndefined();
});

test("a selection with no match reports zero, keeps the window total and still explains attribution", async () => {
  const none = await get(`/api/scope?${q(`projects=${esc("/nowhere/at-all")}`)}`);
  expect(none.body.matched).toEqual({ requests: 0, tokens: 0 });
  expect(none.body.windowTotal.requests).toBeGreaterThan(0);
  expect(none.body.coverage.unattributedRows).toBeGreaterThan(0);
  const overview = await get(`/api/overview?${q(`projects=${esc("/nowhere/at-all")}`)}`);
  expect(overview.body.summary.requests).toBe(0);
  const empty = await get(`/api/scope?${q("sources=claude-code&models=no-such-model")}`);
  expect(empty.body.matched.requests).toBe(0);
  expect(empty.body.sources.find((s: any) => s.source === "claude-code").requests).toBe(0);
});

test("globs stay literal when escaped and keep the ancestor semantics of reports", async () => {
  const folder = esc(`${appA}/server`);
  const sub = await get(`/api/scope?${q(`projects=${folder}`)}`);
  const root = await get(`/api/scope?${q(`projects=${esc(appA)}`)}`);
  expect(sub.body.matched.requests).toBeGreaterThan(0);
  expect(sub.body.matched.requests).toBeLessThan(root.body.matched.requests);
  const wildcard = await get(`/api/scope?${q(`projects=${esc(`${home}/work/app-*`)}`)}`);
  expect(wildcard.body.matched.requests).toBeGreaterThan(root.body.matched.requests);
  const escaped = await get(`/api/scope?${q(`projects=${esc(`${home}/work/app-\\*`)}`)}`);
  expect(escaped.body.matched.requests).toBe(0);
  // The same selection through the report route agrees with the dashboard's count.
  const report = await get(`/api/report?${q(`projects=${esc(appA)}&sources=claude-code`)}`);
  const claude = await get(`/api/scope?${q(`projects=${esc(appA)}&sources=claude-code`)}`);
  expect(report.status).toBe(200);
  expect(report.body.report.kpis.requests).toBe(claude.body.matched.requests);
  expect(report.body.report.kpis.tokens).toBe(claude.body.matched.tokens);
});

test("quota and the send ledger stay account-wide and are unavailable for a Claude Code only selection", async () => {
  const [quota, ledger, overview] = await request(`/api/quota?range=all`, `/api/ledger?range=all`, `/api/overview?range=all`);
  expect(quota!.body.scope).toMatchObject({ kind: "account", available: true, ignored: [], requestedSources: ["claude-code", "ocx"] });
  expect(quota!.body.windows.length).toBeGreaterThan(0);
  expect(ledger!.body.settledTokens).toBeGreaterThan(0);
  expect(overview!.body.quotaScope.available).toBe(true);
  // A project selection neither narrows nor claims the account figures; it says it did not apply.
  const [projQuota, projLedger, projOverview] = await request(`/api/quota?range=all&projects=${esc(appA)}&models=gpt-6-luna`, `/api/ledger?range=all&projects=${esc(appA)}`, `/api/overview?range=all&projects=${esc(appA)}`);
  expect(projQuota!.body.scope.ignored).toEqual(["projects", "models"]);
  expect(projQuota!.body.windows).toEqual(quota!.body.windows);
  expect(projLedger!.body.settledTokens).toBe(ledger!.body.settledTokens);
  expect(projLedger!.body.scope.ignored).toEqual(["projects"]);
  expect(projOverview!.body.quota.windows).toEqual(overview!.body.quota.windows);
  expect(projOverview!.body.quotaScope.ignored).toEqual(["projects"]);
  // Claude Code only: nothing from the Codex account is returned.
  const [claudeQuota, claudeLedger, claudeOverview, ocxQuota, bad] = await request(
    `/api/quota?range=all&sources=claude`, `/api/ledger?range=all&sources=claude-code`, `/api/overview?range=all&sources=claude-code`, `/api/quota?range=all&sources=codex`, `/api/quota?sources=nope`);
  for (const response of [claudeQuota!, claudeLedger!, claudeOverview!]) expect(response.status).toBe(200);
  expect(claudeQuota!.body.scope).toMatchObject({ available: false, requestedSources: ["claude-code"] });
  expect(claudeQuota!.body.windows).toEqual([]);
  expect(claudeQuota!.body.series).toEqual([]);
  expect(claudeLedger!.body.scope.available).toBe(false);
  expect(claudeLedger!.body).toMatchObject({ byKind: {}, settledTokens: 0, distinctSends: 0, updatedAt: null });
  expect(claudeLedger!.body.buckets.every((b: any) => b.settled === 0 && b.tokens === 0)).toBe(true);
  expect(claudeOverview!.body.quota.windows).toEqual([]);
  expect(claudeOverview!.body.quotaScope.available).toBe(false);
  expect(ocxQuota!.body.scope.available).toBe(true);
  expect(ocxQuota!.body.windows).toEqual(quota!.body.windows);
  expect(bad!.status).toBe(400);
  expect(bad!.body.error).toMatchObject({ code: "invalid_source", param: "sources" });
});

test("a conversation id shared by two sources is two sessions", async () => {
  const list = await get(`/api/conversations?${q("")}`);
  const shared = list.body.conversations.filter((c: any) => c.id === SHARED_ID);
  expect(shared.map((c: any) => c.source).sort()).toEqual(["claude-code", "ocx"]);
  const claude = shared.find((c: any) => c.source === "claude-code");
  const ocx = shared.find((c: any) => c.source === "ocx");
  expect(claude.requests).toBe(3);
  expect(ocx.requests).toBeGreaterThan(3);
  expect(claude.requests + ocx.requests).toBe(list.body.totals.requests - list.body.conversations.filter((c: any) => c.id !== SHARED_ID).reduce((n: number, c: any) => n + c.requests, 0));
  const meta = await get("/api/meta");
  expect(meta.body.conversations).toBe(new Set(list.body.conversations.map((c: any) => `${c.source}:${c.id}`)).size);
});

test("conversation detail never mixes sources and refuses an ambiguous id", async () => {
  const [bare, claude, ocx, byCohort, bad, missing] = await request(
    `/api/conversations/${SHARED_ID}`, `/api/conversations/${SHARED_ID}?sessionSource=claude-code`, `/api/conversations/${SHARED_ID}?sessionSource=codex`,
    `/api/conversations/${SHARED_ID}?sources=claude-code`, `/api/conversations/${SHARED_ID}?sessionSource=nope`, `/api/conversations/no-such-session`);
  expect(bare!.status).toBe(409);
  expect(bare!.body.error).toMatchObject({ code: "ambiguous_session", sources: ["claude-code", "ocx"] });
  expect(claude!.status).toBe(200);
  expect(claude!.body.source).toBe("claude-code");
  expect(claude!.body.requests.map((r: any) => r.source)).toEqual(["claude-code", "claude-code", "claude-code"]);
  expect(claude!.body.points).toHaveLength(3);
  expect(claude!.body.scope).toMatchObject({ window: null, matched: 3, sessionTotal: 3, excluded: { window: 0, filters: 0 } });
  expect(ocx!.body.source).toBe("ocx");
  expect(ocx!.body.requests.every((r: any) => r.source === "ocx")).toBe(true);
  expect(ocx!.body.requests.length).toBe(ocx!.body.scope.sessionTotal);
  expect(byCohort!.body.source).toBe("claude-code");
  expect(byCohort!.body.requests).toHaveLength(3);
  expect(bad!.status).toBe(400);
  expect(bad!.body.error).toMatchObject({ code: "invalid_source", param: "sessionSource" });
  expect(missing!.status).toBe(404);
});

test("conversation detail honours window, project and request filters and reports what they left out", async () => {
  const base = `/api/conversations/${SHARED_ID}?sessionSource=claude-code`;
  const [windowed, wrongProject, rightProject, otherSource, model, custom] = await request(
    `${base}&range=24h`, `${base}&projects=${esc(appA)}`, `${base}&projects=${esc(appB)}&range=all`, `${base}&sources=ocx`, `${base}&models=gpt-6-luna`,
    `${base}&from=${Date.now() - 30 * 86_400_000}&to=${Date.now() + 120_000}&tz=Asia/Singapore`);
  // The five-day-old request is outside a 24h window but belongs to the session.
  expect(windowed!.body.scope).toMatchObject({ matched: 2, sessionTotal: 3, excluded: { window: 1, filters: 0 } });
  expect(windowed!.body.scope.window.label).toBeString();
  expect(windowed!.body.requests).toHaveLength(2);
  expect(wrongProject!.status).toBe(200);
  expect(wrongProject!.body.points).toEqual([]);
  expect(wrongProject!.body.requests).toEqual([]);
  expect(wrongProject!.body.scope).toMatchObject({ matched: 0, sessionTotal: 3, filtersApplied: ["projects"], excluded: { window: 0, filters: 3 } });
  expect(rightProject!.body.scope).toMatchObject({ matched: 3, excluded: { window: 0, filters: 0 } });
  expect(otherSource!.body.scope).toMatchObject({ matched: 0, excluded: { filters: 3 } });
  expect(model!.body.scope).toMatchObject({ matched: 0, filtersApplied: ["models"] });
  expect(custom!.body.scope).toMatchObject({ matched: 3, window: { tz: "Asia/Singapore" } });
});

test("combined request filters and half-open explicit bounds apply to every detail row", async () => {
  const session = (await get(`/api/conversations/${SHARED_ID}?sessionSource=ocx`)).body;
  const sample = session.requests.find((r: any) => r.outcome === "ok");
  const params = new URLSearchParams({ sources: "ocx", sessionSource: "ocx", projects: appA, providers: sample.provider, models: sample.model,
    efforts: sample.effort, statuses: "ok", routeKinds: sample.routeKind, search: sample.id, from: String(sample.ts), to: String(sample.ts + 1), tz: "Asia/Singapore" });
  const detail = await get(`/api/conversations/${SHARED_ID}?${params}`);
  expect(detail.status).toBe(200);
  expect(detail.body.requests).toHaveLength(1);
  expect(detail.body.requests[0].id).toBe(sample.id);
  expect(detail.body.scope.matched + detail.body.scope.excluded.window + detail.body.scope.excluded.filters).toBe(detail.body.scope.sessionTotal);
  expect(detail.body.scope.filtersApplied).toEqual(["sources", "projects", "providers", "models", "efforts", "statuses", "routeKinds", "search"]);
  params.set("from", String(sample.ts - 1));
  params.set("to", String(sample.ts));
  expect((await get(`/api/conversations/${SHARED_ID}?${params}`)).body.requests).toEqual([]);
});

test("new scope and detail boundaries reject invalid sources and use the shared time parser", async () => {
  for (const endpoint of ["scope", "quota", "ledger", `conversations/${SHARED_ID}`]) {
    const invalidSource = await get(`/api/${endpoint}?sources=unknown`);
    expect(invalidSource.status).toBe(400);
    expect(invalidSource.body.error).toMatchObject({ code: "invalid_source", param: "sources" });
    const invalidWindow = await get(`/api/${endpoint}?from=not-a-date&to=now`);
    expect(invalidWindow.status).toBe(400);
    expect(invalidWindow.body.error).toMatchObject({ code: "invalid_time", param: "from" });
  }
});

test("an unscoped request keeps the legacy all-history behaviour", async () => {
  const solo = (await get(`/api/conversations?${q("sources=claude-code")}`)).body.conversations.find((c: any) => c.id === "claude-fixture-session-a");
  const detail = await get(`/api/conversations/claude-fixture-session-a`);
  expect(detail.status).toBe(200);
  expect(detail.body.requests).toHaveLength(solo.requests);
  expect(detail.body.scope).toMatchObject({ window: null, filtersApplied: [], matched: solo.requests, excluded: { window: 0, filters: 0 } });
  expect(detail.body.coverage).toBeUndefined();
  expect(detail.body.source).toBe("claude-code");
});
