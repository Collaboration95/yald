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
async function serve(entries: object[], env: { TZ?: string; YALD_TZ?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "yald-api-test-")); owned.push(dir);
  const home = join(dir, "home"), pricing = join(dir, "pricing");
  await mkdir(home); await mkdir(join(pricing, "src/usage"), { recursive: true });
  await writeFile(join(pricing, "src/usage/cost.ts"), COST_ENGINE);
  await writeFile(join(home, "usage.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const child = spawn(process.execPath, [helper, root], {
    cwd: root, stdio: "pipe",
    env: { ...process.env, OCX_HOME: home, CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), OCX_PACKAGE_DIR: pricing, YALD_TEST_PRICING_GENERATION: "", TZ: env.TZ ?? "UTC", YALD_TZ: env.YALD_TZ ?? "UTC" },
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

const ROUTES = ["overview", "timeseries", "models", "usage", "usage/heatmap-dates", "cost", "performance", "reliability", "quota", "ledger", "conversations", "export", "filters"];
const route = (name: string, query: string) => `/api/${name}?${name === "usage/heatmap-dates" ? "weekday=0&hour=0&" : ""}${query}`;

let request: Awaited<ReturnType<typeof serve>>;
beforeAll(async () => {
  request = await serve([usageEntry("old", now - 20 * 86_400_000), usageEntry("recent", now - 3_600_000), usageEntry("sgt-morning", Date.parse("2026-10-11T01:30:00Z"))]);
});

test("unreadable from/to answers 400 invalid_time on every analytics route, naming the parameter", async () => {
  for (const param of ["from", "to"]) {
    const responses = await request(...ROUTES.map(name => route(name, `${param}=yesterday-ish`)));
    for (const response of responses) {
      expect(response.status, response.path).toBe(400);
      expect(response.body, response.path).toEqual({ ok: false, error: { code: "invalid_time", param, message: expect.stringContaining('"yesterday-ish"') } });
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
    expect(response.body.summary.requests).toBe(1);
  }
});
