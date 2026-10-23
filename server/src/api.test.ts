import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

// Routes run in a child process (tests/helpers/store-probe.ts) so each fixture home,
// process TZ and server zone is isolated from other test files sharing this runtime.
// The probe freezes Date.now at 2026-10-03T04:00:00Z.
const root = resolve(import.meta.dir, "../..");
const helper = join(root, "tests/helpers/store-probe.ts");
const now = 1_791_000_000_000;
const owned: string[] = [];
const probes: ChildProcessWithoutNullStreams[] = [];

interface ApiResponse { path: string; status: number; type: string | null; disposition: string | null; body: any }

const COST_ENGINE = `export function estimateRequestCost(input) {
  if (input.model === "unpriced") return null;
  const u = input.usage ?? {};
  const cacheRead = u.cacheReadInputTokens ?? u.cachedInputTokens ?? 0;
  const cacheWrite = u.cacheCreationInputTokens ?? u.cacheWriteInputTokens ?? 0;
  const cost = { input: Math.max(0, (u.inputTokens ?? 0) - cacheRead) * 10 / 1e6, output: (u.outputTokens ?? 0) * 20 / 1e6, cacheRead: cacheRead / 1e6, cacheWrite: cacheWrite * 5 / 1e6 };
  return { cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite }, estimated: false, price: { cost4: { input: 10, output: 20, cacheRead: 1, cacheWrite: 5 } } };
}
`;

function usageEntry(id: string, timestamp: number, tokens = 100) {
  return {
    requestId: id, timestamp, provider: "test-provider", model: "priced", conversationId: "c1", effectiveEffort: "high",
    routeDecision: { routeKind: "native" }, status: 200, durationMs: 1000, firstOutputMs: 100, usageStatus: "reported",
    usage: { inputTokens: tokens, outputTokens: tokens / 5, cachedInputTokens: tokens / 4, cacheWriteInputTokens: tokens / 10, reasoningOutputTokens: 2 },
  };
}

/** One fixture home served by an isolated probe process with the given process TZ and server zone. */
async function serve(entries: object[], env: { TZ?: string; YALD_TZ?: string } = {}, engine = COST_ENGINE) {
  const dir = await mkdtemp(join(tmpdir(), "yald-api-test-")); owned.push(dir);
  const home = join(dir, "home"), pricing = join(dir, "pricing");
  await mkdir(home); await mkdir(join(home, "codex")); await mkdir(join(pricing, "src/usage"), { recursive: true });
  await writeFile(join(pricing, "src/usage/cost.ts"), engine);
  await writeFile(join(home, "usage.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const child = spawn(process.execPath, [helper, root], {
    cwd: root, stdio: "pipe",
    env: { ...process.env, OCX_HOME: home, CODEX_HOME: join(home, "codex"), CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), OCX_PACKAGE_DIR: pricing, YALD_TEST_PRICING_GENERATION: "", TZ: env.TZ ?? "UTC", YALD_TZ: env.YALD_TZ ?? "UTC" },
  });
  probes.push(child);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const next = async () => {
    const line = await lines.next();
    if (line.done) throw new Error(`probe exited: ${stderr}`);
    return JSON.parse(line.value);
  };
  expect(await next()).toEqual({ ready: true });
  return async (...paths: string[]): Promise<ApiResponse[]> => {
    child.stdin.write(JSON.stringify({ op: "api", paths }) + "\n");
    const reply = await next();
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  };
}

afterAll(async () => {
  for (const child of probes.splice(0)) child.kill();
  await Promise.all(owned.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const ROUTES = ["overview", "timeseries", "models", "usage", "usage/heatmap-dates", "cost", "performance", "reliability", "quota", "ledger", "conversations", "export", "filters", "context", "cost/structure"];
const route = (name: string, query: string) => `/api/${name}?${name === "usage/heatmap-dates" ? "weekday=0&hour=0&" : ""}${query}`;

const sgt = (wall: string) => Date.parse(`${wall}+08:00`);
// One makeathon day in Singapore, with rows exactly on the 09:00, 13:00 and 17:00 boundaries.
const ENTRIES = [
  usageEntry("old", now - 20 * 86_400_000), usageEntry("recent", now - 3_600_000),
  usageEntry("before-a", sgt("2026-10-11T08:59:59.999"), 20_000),
  usageEntry("on-a", sgt("2026-10-11T09:00:00"), 30_000),
  usageEntry("morning", sgt("2026-10-11T10:15:00"), 40_000),
  usageEntry("on-b", sgt("2026-10-11T13:00:00"), 50_000),
  usageEntry("afternoon", sgt("2026-10-11T16:59:59.999"), 60_000),
  usageEntry("on-c", sgt("2026-10-11T17:00:00"), 70_000),
];

let request: Awaited<ReturnType<typeof serve>>;
beforeAll(async () => {
  // The server zone is Singapore; the process runs in UTC.
  request = await serve(ENTRIES, { TZ: "UTC", YALD_TZ: "Asia/Singapore" });
});

/** A body without the echoed raw input, which is the only part allowed to differ between equivalent queries. */
function withoutInput(body: any) {
  if (!body || typeof body !== "object" || !body.window) return body;
  const { input: _input, ...window } = body.window;
  return { ...body, window };
}

test("unreadable from/to answers 400 invalid_time on every analytics route, naming the parameter", async () => {
  for (const param of ["from", "to"]) {
    const responses = await request(...ROUTES.map(name => route(name, `${param}=soon-ish`)));
    for (const response of responses) {
      expect(response.status, response.path).toBe(400);
      expect(response.body, response.path).toEqual({ ok: false, error: { code: "invalid_time", param, message: expect.stringContaining('"soon-ish"') } });
    }
  }
});

test("a decoded + offset gets the %2B hint", async () => {
  // What `?from=2026-10-11T09:00:00+08:00` looks like after query decoding.
  const [response] = await request(`/api/overview?from=${encodeURIComponent("2026-10-11T09:00:00 08:00")}&to=${encodeURIComponent("2026-10-11T17:00:00 08:00")}`);
  expect(response!.status).toBe(400);
  expect(response!.body.error).toEqual({
    code: "invalid_time", param: "from",
    message: 'Could not read "2026-10-11T09:00:00 08:00" as a time. If it has a +HH:MM offset, URL-encode the + as %2B.',
  });
  const [plain] = await request("/api/overview?from=11/10%209am");
  expect(plain!.body.error.message).not.toContain("%2B");
});

test("blank window inputs and overflowing durations return 400 instead of defaults or runtime failures", async () => {
  for (const [param, code] of [["from", "invalid_time"], ["to", "invalid_time"], ["last", "invalid_duration"], ["range", "invalid_duration"], ["tz", "invalid_zone"]]) {
    const responses = await request(...[...ROUTES, "window", "report"].map(name => route(name, `${param}=`)));
    for (const response of responses) {
      expect(response.status, response.path).toBe(400);
      expect(response.body.error, response.path).toMatchObject({ code, param });
    }
  }
  const responses = await request(...["overview", "window", "report"].map(name => route(name, "last=999999999999999999999999h")));
  for (const response of responses) {
    expect(response.status, response.path).toBe(400);
    expect(response.body.error).toMatchObject({ code: "invalid_duration", param: "last" });
  }
});

test("absent, ISO and epoch from/to keep answering 200 with the window asked for", async () => {
  const [absent, iso, epoch, ui] = await request(
    "/api/overview",
    "/api/overview?from=2026-10-11T09:00:00%2B08:00&to=2026-10-11T17:00:00%2B08:00",
    `/api/overview?from=${Date.parse("2026-10-11T01:00:00Z")}&to=${Date.parse("2026-10-11T09:00:00Z")}`,
    "/api/overview?range=30d",
  );
  expect(absent!.status).toBe(200);
  expect(absent!.body.window.to - absent!.body.window.from).toBe(30 * 86_400_000);
  expect(absent!.body.summary.requests).toBe(2);
  expect(ui!.status).toBe(200);
  for (const response of [iso!, epoch!]) {
    expect(response.status).toBe(200);
    expect(response.body.window.from).toBe(Date.parse("2026-10-11T01:00:00Z"));
    expect(response.body.summary.requests).toBe(4);
  }
});

const DATA_ROUTES = ROUTES.filter(name => name !== "export");

test("naive local times in tz and exact UTC instants return identical bodies", async () => {
  const local = await request(...ROUTES.map(name => route(name, "from=2026-10-11%2009:00&to=2026-10-11%2017:00&tz=Asia/Singapore")));
  const utc = await request(...ROUTES.map(name => route(name, "from=2026-10-11T01:00Z&to=2026-10-11T09:00Z")));
  local.forEach((response, index) => {
    expect(response.status, response.path).toBe(200);
    const { path: _a, ...expected } = utc[index]!;
    const { path: _b, ...actual } = response;
    expect(withoutInput(actual.body), response.path).toEqual(withoutInput(expected.body));
    expect(actual.disposition).toBe(expected.disposition);
  });
  const overview = local[0]!.body;
  expect(overview.summary.requests).toBe(4);
  expect(overview.window).toEqual({
    from: sgt("2026-10-11T09:00:00"), to: sgt("2026-10-11T17:00:00"), tz: "Asia/Singapore",
    label: "Sun 11 Oct 2026, 09:00–17:00 GMT+8", fromIso: "2026-10-11T09:00:00+08:00", toIso: "2026-10-11T17:00:00+08:00", halfOpen: true,
    input: { from: "2026-10-11 09:00", to: "2026-10-11 17:00" },
    bucket: "hour", range: "30d", requests: 4,
  });
  // Every data route echoes the window it used.
  for (const response of local.filter(response => !response.path.startsWith("/api/export"))) {
    expect(response.body.window, response.path).toMatchObject({ tz: "Asia/Singapore", label: "Sun 11 Oct 2026, 09:00–17:00 GMT+8", fromIso: "2026-10-11T09:00:00+08:00", toIso: "2026-10-11T17:00:00+08:00", halfOpen: true });
  }
  expect(DATA_ROUTES.length).toBe(local.length - 1);
  const csv = local.find(response => response.path.startsWith("/api/export"))!;
  expect(csv.disposition).toBe('attachment; filename="yald-requests-2026-10-11T0900+0800--2026-10-11T1700+0800.csv"');
  expect(csv.body).toContain("on-b");
  expect(csv.body).not.toContain("on-c");
});

test("contiguous windows [a, b) and [b, c) sum exactly to [a, c), with a row on b", async () => {
  const [first, second, whole] = await request(
    "/api/overview?from=2026-10-11%2009:00&to=2026-10-11%2013:00&tz=Asia/Singapore",
    "/api/overview?from=2026-10-11%2013:00&to=2026-10-11%2017:00&tz=Asia/Singapore",
    "/api/overview?from=2026-10-11%2009:00&to=2026-10-11%2017:00&tz=Asia/Singapore",
  );
  const ids = (response: ApiResponse) => response.body.recent.map((row: { id: string }) => row.id).sort();
  expect(ids(first!)).toEqual(["morning", "on-a"]);
  expect(ids(second!)).toEqual(["afternoon", "on-b"]);
  expect(ids(whole!)).toEqual(["afternoon", "morning", "on-a", "on-b"]);
  const [a, b, all] = [first!.body.summary, second!.body.summary, whole!.body.summary];
  expect(a.requests + b.requests).toBe(all.requests);
  for (const kind of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"]) {
    expect(a.tokens[kind] + b.tokens[kind], kind).toBe(all.tokens[kind]);
  }
  expect(all.cost).toBeGreaterThan(0);
  expect(a.cost + b.cost).toBeCloseTo(all.cost, 10);
  expect(first!.body.composition.total + second!.body.composition.total).toBeCloseTo(whole!.body.composition.total, 10);
  // The prior period is the equally long window just before, also half-open.
  expect(second!.body.prior.requests).toBe(first!.body.summary.requests);
});

test("buckets follow the request tz, not the server process TZ", async () => {
  const query = "from=2026-10-10&to=2026-10-12&tz=Asia/Singapore&metric=requests&groupBy=none";
  const [hourly, daily, kolkata] = await request(
    `/api/timeseries?${query}&bucket=hour`,
    `/api/timeseries?${query}&bucket=day`,
    "/api/timeseries?from=2026-10-11%2006:00&to=2026-10-11%2015:00&tz=Asia/Kolkata&metric=requests&groupBy=none&bucket=hour",
  );
  const hours = hourly!.body.series.buckets;
  expect(hours).toHaveLength(48);
  expect(hours[0]).toMatchObject({ ts: sgt("2026-10-10T00:00:00"), label: "10-10 00:00" });
  expect(hours.find((bucket: { label: string }) => bucket.label === "10-11 09:00").total).toBe(1);
  expect(hours.find((bucket: { label: string }) => bucket.label === "10-11 08:00").total).toBe(1);
  expect(daily!.body.series.buckets.map((bucket: { ts: number; label: string; total: number }) => [bucket.ts, bucket.label, bucket.total])).toEqual([
    [sgt("2026-10-10T00:00:00"), "2026-10-10", 0],
    [sgt("2026-10-11T00:00:00"), "2026-10-11", 6],
  ]);
  // India is UTC+5:30, so local hours start at half past the UTC hour.
  for (const bucket of kolkata!.body.series.buckets) expect(new Date(bucket.ts).getUTCMinutes()).toBe(30);
  // The same request under another process TZ gives identical bodies (ETags differ: they hash the home path).
  const elsewhere = await serve(ENTRIES, { TZ: "America/Los_Angeles", YALD_TZ: "Asia/Singapore" });
  const paths = [`/api/timeseries?${query}&bucket=hour`, `/api/usage?${query}&bucket=day`, `/api/reliability?${query}`, "/api/overview?from=2026-10-11&to=2026-10-12"];
  const bodies = (responses: ApiResponse[]) => responses.map(response => response.body);
  expect(bodies(await elsewhere(...paths))).toEqual(bodies(await request(...paths)));
});

test("last=8h and from=-8h&to=now resolve to the same window for a frozen now", async () => {
  const [last, relative, window] = await request("/api/overview?last=8h", "/api/overview?from=-8h&to=now", "/api/window?last=8h");
  expect(last!.body.window.to).toBe(now);
  expect(last!.body.window.to - last!.body.window.from).toBe(8 * 3_600_000);
  expect(withoutInput(relative!.body)).toEqual(withoutInput(last!.body));
  expect(last!.body.window.input).toEqual({ last: "8h" });
  expect(relative!.body.window.input).toEqual({ from: "-8h", to: "now" });
  expect(window!.body.window.from).toBe(last!.body.window.from);
});

test("GET /api/window resolves windows and phases without aggregating data", async () => {
  const phase = (spec: string) => `phase=${encodeURIComponent(spec)}`;
  const [response] = await request(`/api/window?from=2026-10-10%2023:30&to=2026-10-11%2018:00&tz=Asia/Singapore&${[
    phase("Demo=2026-10-11 15:00..2026-10-11 18:00"), phase("Prep=2026-10-10 23:30..2026-10-11 09:00"), phase("Build=2026-10-11 09:00..+6h"),
  ].join("&")}`);
  expect(response!.status).toBe(200);
  expect(response!.body).toEqual({
    ok: true,
    window: {
      from: sgt("2026-10-10T23:30:00"), to: sgt("2026-10-11T18:00:00"), tz: "Asia/Singapore",
      label: "Sat 10 Oct 2026, 23:30 – Sun 11 Oct 2026, 18:00 GMT+8",
      fromIso: "2026-10-10T23:30:00+08:00", toIso: "2026-10-11T18:00:00+08:00", halfOpen: true,
      input: { from: "2026-10-10 23:30", to: "2026-10-11 18:00" },
    },
    phases: [
      { name: "Prep", from: sgt("2026-10-10T23:30:00"), to: sgt("2026-10-11T09:00:00"), label: "Sat 10 Oct 2026, 23:30 – Sun 11 Oct 2026, 09:00 GMT+8", fromIso: "2026-10-10T23:30:00+08:00", toIso: "2026-10-11T09:00:00+08:00" },
      { name: "Build", from: sgt("2026-10-11T09:00:00"), to: sgt("2026-10-11T15:00:00"), label: "Sun 11 Oct 2026, 09:00–15:00 GMT+8", fromIso: "2026-10-11T09:00:00+08:00", toIso: "2026-10-11T15:00:00+08:00" },
      { name: "Demo", from: sgt("2026-10-11T15:00:00"), to: sgt("2026-10-11T18:00:00"), label: "Sun 11 Oct 2026, 15:00–18:00 GMT+8", fromIso: "2026-10-11T15:00:00+08:00", toIso: "2026-10-11T18:00:00+08:00" },
    ],
  });
  const [none] = await request("/api/window?range=7d");
  expect(none!.body).toMatchObject({ ok: true, phases: [], window: { to: now, tz: "Asia/Singapore", input: { range: "7d" } } });
});

const WINDOW = "from=2026-10-11%2009:00&to=2026-10-11%2017:00";
const ERRORS: [string, string, string][] = [
  ["from=11/10%209am", "invalid_time", "from"],
  ["from=2026-03-08%2002:30&to=2026-03-08%2004:00&tz=America/New_York", "nonexistent_time", "from"],
  ["last=8x", "invalid_duration", "last"],
  ["last=0h", "invalid_duration", "last"],
  ["range=1y", "invalid_duration", "range"],
  ["range=7d&tz=Mars/Olympus", "invalid_zone", "tz"],
  ["from=2026-10-11%2017:00&to=2026-10-11%2009:00", "empty_window", "to"],
  ["to=2026-10-11%2017:00", "conflicting_params", "to"],
  ["from=-8h&to=now&last=8h", "conflicting_params", "last"],
  [`${WINDOW}&phase=Build`, "invalid_phase", "phase[0]"],
  [`${WINDOW}&phase=${encodeURIComponent("A=2026-10-11 10:00..+1h")}&phase=${encodeURIComponent("A=2026-10-11 12:00..+1h")}`, "invalid_phase", "phase[1]"],
  [`${WINDOW}&phase=${encodeURIComponent("Late=2026-10-11 16:00..+2h")}`, "phase_outside_window", "phase[0]"],
  [`${WINDOW}&phase=${encodeURIComponent("A=2026-10-11 10:00..+2h")}&phase=${encodeURIComponent("B=2026-10-11 11:00..+1h")}`, "phase_overlap", "phase[1]"],
];

test("every WindowErrorCode is a 400 from GET /api/window, and the query-param ones from analytics routes", async () => {
  const windowResponses = await request(...ERRORS.map(([query]) => `/api/window?${query}`));
  const codes = new Set<string>();
  windowResponses.forEach((response, index) => {
    const [, code, param] = ERRORS[index]!;
    expect(response.status, response.path).toBe(400);
    expect(response.body, response.path).toEqual({ ok: false, error: { code, param, message: expect.any(String) } });
    codes.add(code);
  });
  expect([...codes].sort()).toEqual([
    "conflicting_params", "empty_window", "invalid_duration", "invalid_phase", "invalid_time", "invalid_zone", "nonexistent_time", "phase_outside_window", "phase_overlap",
  ]);
  const queryErrors = ERRORS.filter(([query]) => !query.includes("phase="));
  for (const name of ROUTES) {
    const responses = await request(...queryErrors.map(([query]) => route(name, query)));
    responses.forEach((response, index) => {
      const [, code, param] = queryErrors[index]!;
      expect(response.status, response.path).toBe(400);
      expect(response.body.error, response.path).toMatchObject({ code, param });
    });
  }
});

test("F01 metadata and outcome cohorts agree across overview, reliability, performance and request exports", async () => {
  const common = usageEntry("proxy-ok", now - 1000);
  const claude = { ...common, requestId: "transcript", inboundProtocol: "claude-code", provider: "anthropic",
    // These inherited defaults must not become measured reliability or timing.
    usagePresence: { input: true, output: true, cacheRead: true, cacheWrite: true }, conversationId: "claude-session" };
  const request = await serve([
    claude,
    { ...common, provider: "anthropic", inboundProtocol: "messages" },
    { ...common, requestId: "proxy-error", status: 502, errorCode: "upstream" },
    { ...common, requestId: "proxy-cancelled", status: 499, closeReason: "client_closed" },
    { ...common, requestId: "input-missing", usage: { outputTokens: 1 }, status: undefined },
    { ...common, requestId: "input-zero", usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 }, model: "zero" },
    { ...common, requestId: "no-price", model: "unpriced" },
  ]);
  const [meta, overview, claudeOnly, observedOk, errors, cancelled, unobserved, rel, perf, csv, conversation] = await request(
    "/api/meta", "/api/overview?range=all", "/api/overview?range=all&sources=claude-code", "/api/overview?range=all&statuses=ok",
    "/api/overview?range=all&statuses=error", "/api/overview?range=all&statuses=cancelled", "/api/overview?range=all&statuses=unobserved",
    "/api/reliability?range=all", "/api/performance?range=all&sources=claude-code", "/api/export?range=all&statuses=unobserved", "/api/conversations/claude-session",
  );
  expect(meta!.body).toMatchObject({ sources: ["claude-code", "ocx"], sourceCapabilities: { "claude-code": { outcomes: false, quota: false }, ocx: { outcomes: true, timing: true } } });
  expect(overview!.body.summary).toMatchObject({ requests: 7, ok: 3, errors: 1, cancelled: 1, unobserved: 2, successRate: 0.6,
    measurementCoverage: { outcomes: { eligibleRequests: 5, totalRequests: 7 }, context: { eligibleRequests: 6, totalRequests: 7 } } });
  expect(claudeOnly!.body.summary.successRate).toBeNull();
  expect(claudeOnly!.body.recent[0]).toMatchObject({ source: "claude-code", outcome: "unobserved", measurements: { outcome: false, duration: false, retries: false } });
  expect(observedOk!.body.recent.map((r: any) => r.id).sort()).toEqual(["input-zero", "no-price", "proxy-ok"]);
  expect(errors!.body.recent.map((r: any) => r.id)).toEqual(["proxy-error"]);
  expect(cancelled!.body.recent.map((r: any) => r.id)).toEqual(["proxy-cancelled"]);
  expect(unobserved!.body.recent.map((r: any) => r.id).sort()).toEqual(["input-missing", "transcript"]);
  const missing = overview!.body.recent.find((r: any) => r.id === "input-missing");
  const zero = overview!.body.recent.find((r: any) => r.id === "input-zero");
  expect(missing).toMatchObject({ inputTokens: 0, measurements: { input: false } });
  expect(zero).toMatchObject({ inputTokens: 0, cost: 0, priced: true, measurements: { input: true } });
  expect(overview!.body.recent.find((r: any) => r.id === "no-price")).toMatchObject({ priced: false, cost: 0, rateIn: null });
  expect(rel!.body.successRate).toBe(overview!.body.summary.successRate);
  expect(rel!.body.recentFailures.map((r: any) => r.id).sort()).toEqual(["proxy-cancelled", "proxy-error"]);
  expect(rel!.body.outcomes.reduce((n: number, o: any) => n + o.value, 0)).toBe(7);
  expect(perf!.body.percentiles.duration.p50).toBeNull();
  expect(perf!.body.slowest).toEqual([]);
  expect(perf!.body.measurementCoverage.duration).toEqual({ eligibleRequests: 0, totalRequests: 1 });
  expect(csv!.body).toContain("unobserved");
  expect(csv!.body).not.toContain("proxy-ok");
  expect(conversation!.body.requests[0].outcome).toBe("unobserved");
});

// An engine with a long-context tier (twice the rates from 200k input) and one model priced 1,000,000x.
const TIER_ENGINE = `export function estimateRequestCost(input) {
  if (input.model === "unpriced") return null;
  const u = input.usage ?? {};
  const cacheRead = u.cacheReadInputTokens ?? 0, cacheWrite = u.cacheCreationInputTokens ?? 0;
  const long = (u.inputTokens ?? 0) >= 200000;
  const m = (long ? 2 : 1) * (input.model === "pricey" ? 1000000 : 1);
  const cost = { input: Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite) * 10 * m / 1e6, output: (u.outputTokens ?? 0) * 20 * m / 1e6, cacheRead: cacheRead * m / 1e6, cacheWrite: cacheWrite * 5 * m / 1e6 };
  return { cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite }, estimated: false, contextTier: long ? "long" : undefined,
    price: { cost4: { input: 10, output: 20, cacheRead: 1, cacheWrite: 5 } } };
}
`;

test("session cost ranking covers every session, and token-class costs reconcile with cost on tiered rows", async () => {
  const entry = (id: string, conversationId: string, model: string, inputTokens: number, extra: Record<string, unknown> = {}) => ({
    requestId: id, timestamp: now - 3_600_000, provider: "p", model, conversationId, status: 200, usageStatus: "reported",
    usage: { inputTokens, outputTokens: 10, cacheReadInputTokens: Math.floor(inputTokens / 2), cacheCreationInputTokens: Math.floor(inputTokens / 10) }, ...extra,
  });
  const entries = [
    // 60 sessions of ~1000 tokens fill the old "50 largest by tokens" cut; the costly one has far fewer tokens.
    ...Array.from({ length: 60 }, (_, i) => entry(`cheap-${i}`, `cheap-${i}`, "cheap", 1000 + i)),
    entry("costly", "costly", "pricey", 10),
    entry("long", "long-session", "cheap", 300_000),
  ];
  const request = await serve(entries, {}, TIER_ENGINE);
  const [cost, byCost, byTokens, byRequests] = await request(
    "/api/cost?range=all", "/api/conversations?range=all&sort=cost&limit=3", "/api/conversations?range=all&sort=tokens&limit=2", "/api/conversations?range=all&sort=requests&limit=1",
  );
  expect(cost!.body.topConversations[0].id).toBe("costly");
  expect(cost!.body.topConversations).toHaveLength(10);
  const costs = cost!.body.topConversations.map((c: any) => c.cost);
  expect(costs).toEqual([...costs].sort((a: number, b: number) => b - a));
  expect(byCost!.body.conversations.map((c: any) => c.id)).toEqual(["costly", "long-session", expect.any(String)]);
  expect(byTokens!.body.conversations[0].id).toBe("long-session");
  expect(byRequests!.body.conversations).toHaveLength(1);
  // The KPI counts every session in the selection, not the page of them the list returns.
  expect(byRequests!.body.totals.conversations).toBe(62);
  expect(byCost!.body.totals.conversations).toBe(62);
  // Classes add up to the engine's total on every row, including the long-context-tier one.
  const { composition, summary } = cost!.body;
  expect(composition.adjustment).toBe(0);
  expect(composition.freshInput + composition.cacheRead + composition.cacheWrite + composition.output).toBeCloseTo(summary.cost, 3);
  expect(composition.total).toBeCloseTo(summary.cost, 3);
});

test("GET /api/labs/spend flags a planted spike, echoes its rule and answers 400 for an unusable day", async () => {
  const day = 86_400_000;
  const entries = Array.from({ length: 24 }, (_, i) => ({ ...usageEntry(`day-${i}`, now - (24 - i) * day, 100_000), conversationId: `c${i}`, cwd: "/synthetic/app" }));
  // 300x the usual day, five days before the clock.
  entries.push({ ...usageEntry("spike", now - 5 * day + 3_600_000, 30_000_000), conversationId: "big", cwd: "/synthetic/app" });
  const request = await serve(entries);
  const [ok, picked, badFormat, outside, filtered] = await request(
    "/api/labs/spend?range=30d", "/api/labs/spend?range=30d&day=2026-09-28", "/api/labs/spend?range=30d&day=yesterday", "/api/labs/spend?range=7d&day=2020-01-01", "/api/labs/spend?range=30d&models=absent",
  );
  expect(ok!.status).toBe(200);
  expect(ok!.body.analysis).toBe("spend-changes");
  expect(ok!.body.rule).toMatchObject({ id: "trailing-median", baselineActiveDays: 14, minBaselineActiveDays: 7, spikeMultiple: 2.5 });
  const spikes = ok!.body.days.filter((entry: any) => entry.state === "spike");
  expect(spikes).toHaveLength(1);
  expect(ok!.body.selected.day.date).toBe(spikes[0].date);
  expect(ok!.body.selected.decomposition.cuts.session.new[0].label).toContain("big");
  expect(ok!.body.selected.evidence.href).toContain("investigation=spend-changes");
  expect(ok!.body.coverage).toMatchObject({ spikeDays: 1, unpricedRequests: 0 });
  expect(picked!.status).toBe(200);
  expect(badFormat!.status).toBe(400);
  expect(badFormat!.body.error).toMatchObject({ code: "invalid_day", param: "day" });
  expect(outside!.status).toBe(400);
  // A cohort with no rows has no spike and no selected day, rather than a normal one.
  expect(filtered!.body.days.every((entry: any) => entry.state !== "spike" && entry.state !== "normal")).toBe(true);
  expect(filtered!.body.selected).toBeNull();
});
