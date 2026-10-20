import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { materializeFixtureHome, materializeFixturePricing } from "../../../web/scripts/fixtureHome";
import committedSample from "./__fixtures__/report.sample.json";
import { gitRoot } from "../projects";
import { buildReport, OUTSIDE_PHASES, TOTAL_ROW, type ReportContext, type ReportDataset } from "./build";
import { SAMPLE_INPUT, SAMPLE_NOW, sampleJson, sampleReport } from "./sample";
import { sourceOf } from "./source";
import { buildReportSpec, type ReportSpecInput } from "./spec";
import type { ReportData } from "./types";

// The dataset and the reference routes come from tests/helpers/store-probe.ts in a
// child process: env.ts fixes OCX_HOME at import and bun shares one module cache
// across test files, so reading the fixture home in-process would race other files.
// buildReport itself is pure and runs here on the dataset the probe returns.
const root = resolve(import.meta.dir, "../../..");
let home = "";
let pricing = "";
let child: ChildProcessWithoutNullStreams;
let next: () => Promise<any>;
let dataset: ReportDataset;

beforeAll(async () => {
  const now = Date.now;
  try { Date.now = () => SAMPLE_NOW; home = await materializeFixtureHome({ reportDay: true }); } finally { Date.now = now; }
  pricing = await materializeFixturePricing();
  child = spawn(process.execPath, [join(root, "tests/helpers/store-probe.ts"), root], {
    cwd: root, stdio: "pipe",
    // HOME is the fixture root, so `~/work/app-a*` means the fixture's own folders.
    env: { ...process.env, HOME: home, OCX_HOME: home, CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), CODEX_HOME: join(home, "codex"), OCX_PACKAGE_DIR: pricing, YALD_TEST_PRICING_GENERATION: "", TZ: "UTC", YALD_TZ: "UTC" },
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  next = async () => {
    const line = await lines.next();
    if (line.done) throw new Error(`probe exited: ${stderr}`);
    return JSON.parse(line.value);
  };
  expect(await next()).toEqual({ ready: true });
  dataset = (await command({ op: "get" })).dataset;
});

afterAll(async () => {
  child?.kill();
  await Promise.all([home, pricing].filter(Boolean).map(path => rm(path, { recursive: true, force: true })));
});

async function command(input: object): Promise<any> {
  child.stdin.write(JSON.stringify(input) + "\n");
  const reply = await next();
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}

async function get(path: string): Promise<any> {
  const [response] = await command({ op: "api", paths: [path] });
  expect(response.status).toBe(200);
  return response.body;
}

const WINDOW = { tz: SAMPLE_INPUT.tz, from: SAMPLE_INPUT.from, to: SAMPLE_INPUT.to };
const windowQuery = `tz=${encodeURIComponent(WINDOW.tz!)}&from=${encodeURIComponent(WINDOW.from!)}&to=${encodeURIComponent(WINDOW.to!)}`;

function report(input: ReportSpecInput, ctx: Partial<ReportContext> = {}, data: ReportDataset = dataset): ReportData {
  const spec = buildReportSpec(input, { now: SAMPLE_NOW, first: data.rows[0]?.ts ?? SAMPLE_NOW });
  return buildReport(data, spec, { now: SAMPLE_NOW, yaldVersion: "test", pricing: "ok", home, ...ctx });
}

const TOTAL_KEYS = ["requests", "tokens", "freshInput", "cacheRead", "cacheWrite", "output", "reasoning"] as const;
const cents = (value: number | null) => Math.round((value ?? 0) * 1e6);

/** Named phases plus "(outside phases)" equal "Total", and "Total" equals kpis, for every class, requests and cost. */
function expectPhasesAddUp(data: ReportData): void {
  const total = data.phases.at(-1)!;
  expect(total.name).toBe(TOTAL_ROW);
  expect(data.phases.at(-2)!.name).toBe(OUTSIDE_PHASES);
  const parts = data.phases.slice(0, -1);
  for (const key of TOTAL_KEYS) {
    expect(parts.reduce((sum, row) => sum + row[key], 0)).toBe(total[key]);
    expect(total[key]).toBe(data.kpis[key]);
  }
  expect(parts.reduce((sum, row) => sum + cents(row.costUsd), 0)).toBe(cents(total.costUsd));
  expect(cents(total.costUsd)).toBe(cents(data.kpis.costUsd));
  for (const source of ["claude-code", "ocx"] as const) {
    expect(parts.reduce((sum, row) => sum + row.tokensBySource[source], 0)).toBe(total.tokensBySource[source]);
  }
}

// JSON imports widen literals ("measured" → string, 1 → number); see render.test.ts.
type Widened<T> = T extends string ? string
  : T extends number ? number
  : T extends boolean ? boolean
  : T extends Array<infer U> ? Widened<U>[]
  : T extends object ? { [K in keyof T]: Widened<T[K]> }
  : T;

describe("report sample", () => {
  test("type-checks against ReportData and is exactly what sample.ts generates", async () => {
    const widened = committedSample satisfies Widened<ReportData>;
    const built = sampleReport(dataset, home) satisfies ReportData;
    const text = await Bun.file(new URL("./__fixtures__/report.sample.json", import.meta.url)).text();
    // A failure here means the fixture or buildReport changed: run `bun run server/src/report/sample.ts`.
    expect(sampleJson(built)).toBe(text);
    expect(built).toEqual(widened as ReportData);
    expect(Buffer.byteLength(text)).toBeLessThan(60 * 1024);
  });

  test("has two sources, three phases, 24 hourly points, 6 models and 10 conversations", () => {
    const sample = sampleReport(dataset, home);
    expect(sample.meta.filters.sources).toEqual(["claude-code", "ocx"]);
    expect(new Set(sample.models.map(m => m.source))).toEqual(new Set(["claude-code", "ocx"]));
    expect(sample.phases.map(p => p.name)).toEqual(["Prep", "Build", "Demo", OUTSIDE_PHASES, TOTAL_ROW]);
    expect(sample.timeline.bucket).toBe("hour");
    expect(sample.timeline.points).toHaveLength(24);
    expect(sample.models).toHaveLength(6);
    expect(sample.conversations).toHaveLength(10);
    expect(sample.meta.title).toBe("Fixture makeathon");
    expect(sample.meta.generatedAt).toBe(SAMPLE_NOW);
  });
});

describe("buildReport", () => {
  test("kpis match /api/overview summary and /api/conversations totals for the same window", async () => {
    const data = report(WINDOW);
    const overview = await get(`/api/overview?${windowQuery}`);
    const listed = await get(`/api/conversations?${windowQuery}&limit=1000`);
    expect(overview.window.from).toBe(data.meta.window.from);
    expect(overview.window.to).toBe(data.meta.window.to);
    const { summary } = overview;
    expect(data.kpis).toMatchObject({
      requests: summary.requests,
      tokens: summary.tokens.total,
      cacheRead: summary.tokens.cacheRead,
      cacheWrite: summary.tokens.cacheWrite,
      output: summary.tokens.output,
      reasoning: summary.tokens.reasoning,
      cacheHitRate: summary.cache.hitRate,
      cacheSavingsUsd: summary.cache.savingsUsd,
    });
    expect(data.kpis.costUsd!).toBeCloseTo(summary.cost, 3);
    expect(data.coverage.estimatedCostShare).toBe(summary.estimatedCostShare);
    expect(data.kpis.conversations).toBe(listed.totals.conversations);
    expect(listed.totals.requests + listed.totals.unattributed).toBe(data.kpis.requests);
    expect(data.coverage.rowsWithoutConversation).toBe(listed.totals.unattributed);
    // Every view of the window adds up to the same totals.
    const timelineTokens = data.timeline.points.reduce((sum, p) => sum + p.bySource["claude-code"].tokens + p.bySource.ocx.tokens, 0);
    expect(timelineTokens).toBe(data.kpis.tokens);
    expect(data.models.reduce((sum, m) => sum + m.tokens, 0)).toBe(data.kpis.tokens);
    const { freshInput, cacheRead, cacheWrite, output, reasoning } = data.composition;
    expect(freshInput + cacheRead + cacheWrite + output + reasoning).toBe(data.kpis.tokens);
  });

  test("a project filter matches /api/overview and reports unattributed rows; without one it is null", async () => {
    const scoped = report({ ...WINDOW, projects: ["~/work/app-a*"] }, { projectOf: cwd => gitRoot(cwd) ?? cwd });
    const overview = await get(`/api/overview?${windowQuery}&projects=${encodeURIComponent("~/work/app-a*")}`);
    expect(scoped.kpis.requests).toBe(overview.summary.requests);
    expect(scoped.kpis.tokens).toBe(overview.summary.tokens.total);
    expect(scoped.coverage.unattributedRows).toBe(overview.coverage.unattributedRows);
    // The Anthropic-via-opencodex rows and the orphaned Codex conversation have no folder.
    expect(scoped.coverage.unattributedRows).toBe(8);
    const { matched, outsideProjects, unattributed } = scoped.coverage.attribution!;
    expect(matched).toEqual({ rows: scoped.kpis.requests, tokens: scoped.kpis.tokens });
    expect(unattributed.rows).toBe(8);
    expect(unattributed.reasons.reduce((n, r) => n + r.rows, 0)).toBe(8);
    expect(scoped.coverage.unattributedTokens).toBe(unattributed.tokens);
    // Same source and window without the glob: kept + elsewhere + unknown folder is the whole population.
    expect(matched.rows + outsideProjects.rows + unattributed.rows).toBe(report(WINDOW).kpis.requests);
    expect(scoped.meta.filters.projects).toEqual(["~/work/app-a*"]);
    expect(scoped.conversations.every(c => c.project === "~/work/app-a")).toBe(true);
    expect(report(WINDOW).coverage.unattributedRows).toBeNull();
  });

  test("phase rows add up to Total and kpis with gaps between phases", () => {
    const data = report({ ...WINDOW, phases: SAMPLE_INPUT.phases });
    expectPhasesAddUp(data);
    // 18:00 to 23:30 is outside every phase and holds requests.
    expect(data.phases.at(-2)!.requests).toBeGreaterThan(0);
    expect(data.phases.at(-2)!).toMatchObject({ from: data.meta.window.from, to: data.meta.window.to });
  });

  test("contiguous phases add up exactly, with a request on the shared boundary counted once", () => {
    const window = report(WINDOW).meta.window;
    const boundary = dataset.rows.find(row => row.ts > window.from + 6 * 3_600_000 && row.ts < window.to)!.ts;
    const data = report({ ...WINDOW, phases: [`A=${window.from}..${boundary}`, `B=${boundary}..${window.to}`] });
    expectPhasesAddUp(data);
    const [a, b, outside] = data.phases;
    expect(outside!.requests).toBe(0);
    expect(outside!.tokens).toBe(0);
    const onBoundary = dataset.rows.filter(row => row.ts === boundary).length;
    expect(b!.requests).toBe(dataset.rows.filter(row => row.ts >= boundary && row.ts < window.to).length);
    expect(a!.requests + b!.requests).toBe(data.kpis.requests);
    expect(onBoundary).toBeGreaterThan(0);
  });

  test("no phases means no phase table", () => {
    expect(report(WINDOW).phases).toEqual([]);
  });

  test("sources: claude-code keeps transcript rows only, ocx keeps opencodex rows including Anthropic via opencodex", () => {
    const inWindow = (data: ReportData) => dataset.rows.filter(row => row.ts >= data.meta.window.from && row.ts < data.meta.window.to);
    const claude = report({ ...WINDOW, sources: ["claude-code"] });
    expect(claude.meta.filters.sources).toEqual(["claude-code"]);
    expect(claude.kpis.requests).toBe(inWindow(claude).filter(row => row.protocol === "claude-code").length);
    expect(claude.models.every(m => m.source === "claude-code")).toBe(true);
    expect(claude.conversations.every(c => c.source === "claude-code")).toBe(true);
    expect(claude.timeline.points.every(p => p.bySource.ocx.tokens === 0)).toBe(true);
    expect(claude.kpis.successRate).toBeNull();
    expect(claude.quota.windows).toEqual([]);
    expect(claude.coverage.sourcesRead.every(text => text.startsWith("Claude Code"))).toBe(true);

    const ocx = report({ ...WINDOW, sources: "codex" });
    expect(ocx.meta.filters.sources).toEqual(["ocx"]);
    expect(ocx.kpis.requests).toBe(inWindow(ocx).filter(row => row.protocol !== "claude-code").length);
    expect(ocx.models.every(m => m.source === "ocx")).toBe(true);
    // Keyed on the reader, never on provider: Anthropic traffic through opencodex is ocx.
    expect(ocx.models).toContainEqual(expect.objectContaining({ model: "claude-fixture-haiku", provider: "anthropic", source: "ocx" }));
    expect(dataset.rows.some(row => row.provider === "anthropic" && sourceOf(row) === "ocx")).toBe(true);
    expect(ocx.kpis.successRate).not.toBeNull();

    const both = report(WINDOW);
    expect(claude.kpis.requests + ocx.kpis.requests).toBe(both.kpis.requests);
    expect(claude.kpis.tokens + ocx.kpis.tokens).toBe(both.kpis.tokens);
  });

  test("quota keeps insufficient windows insufficient and Claude Code quota unavailable", () => {
    const { quota } = sampleReport(dataset, home);
    expect(quota.claudeCode).toBe("unavailable");
    expect(quota.windows).toContainEqual({ account: "account 1", window: "weekly", status: "insufficient", samples: 0, usedPctStart: null, usedPctEnd: null, burnPctPerDay: null });
    const measured = quota.windows.find(w => w.status === "measured")!;
    expect(measured.samples).toBeGreaterThanOrEqual(2);
    expect(measured.usedPctEnd!).toBeGreaterThan(measured.usedPctStart!);
    expect(measured.burnPctPerDay!).toBeGreaterThan(0);
    // A one-hour window holds at most one 90-minute sample: insufficient, never 0%.
    const short = report({ tz: "UTC", from: String(SAMPLE_NOW - 3_600_000), to: String(SAMPLE_NOW) });
    expect(short.quota.windows.every(w => w.status === "insufficient" && w.burnPctPerDay === null)).toBe(true);
  });

  test("quota start and burn use only samples inside the half-open report window", () => {
    const window = report(WINDOW).meta.window;
    const sample = (observedAt: number, usedPercent: number) => ({
      account: "private-account", family: "codex", window: "weekly", usedPercent,
      observedAt, resetAtMs: null, source: "test",
    });
    const data: ReportDataset = {
      ...dataset,
      quota: {
        updatedAt: window.to,
        windows: [{ account: "private-account", window: "weekly", usedPercent: 90, resetAtMs: null, updatedAt: window.to }],
        samples: [sample(window.from - 12 * 3_600_000, 0), sample(window.from, 30), sample(window.from + 12 * 3_600_000, 40), sample(window.to, 90)],
      },
    };
    expect(report(WINDOW, {}, data).quota.windows).toEqual([{
      account: "account 1", window: "weekly", status: "measured", samples: 2,
      usedPctStart: 30, usedPctEnd: 40, burnPctPerDay: 20,
    }]);
  });

  test("conversation identity includes source, with source-specific tokens and projects", () => {
    const window = report(WINDOW).meta.window;
    const id = "shared-conversation-id";
    const rows = [
      { ...dataset.rows[0]!, ts: window.from, protocol: "claude-code", conversationId: id, cwd: `${home}/claude-project`, model: "claude-model", totalTokens: 100 },
      { ...dataset.rows[0]!, ts: window.from + 1, protocol: "responses", conversationId: id, cwd: `${home}/ocx-project`, model: "ocx-model", totalTokens: 200 },
    ];
    const data = report({ ...WINDOW, redact: false }, {}, { ...dataset, rows });
    expect(data.kpis.conversations).toBe(2);
    expect(data.conversations).toMatchObject([
      { id, source: "ocx", requests: 1, tokens: 200, models: ["ocx-model"], project: `${home}/ocx-project` },
      { id, source: "claude-code", requests: 1, tokens: 100, models: ["claude-model"], project: `${home}/claude-project` },
    ]);
    const phased = report({ ...WINDOW, phases: [`Build=${window.from}..${window.to}`] }, {}, { ...dataset, rows });
    expect(phased.phases.every(p => p.requests === 0 || p.conversations === 2)).toBe(true);
  });

  test("model and conversation dollar totals retain the same precision as the KPI", () => {
    const window = report(WINDOW).meta.window;
    const row = { ...dataset.rows[0]!, ts: window.from, cost: 0.000042, priced: true, conversationId: "tiny-cost", model: "tiny-model" };
    const data = report(WINDOW, {}, { ...dataset, rows: [row] });
    expect(data.kpis.costUsd).toBe(0.000042);
    expect(data.models[0]!.costUsd).toBe(data.kpis.costUsd);
    expect(data.conversations[0]!.costUsd).toBe(data.kpis.costUsd);
    expect(data.models[0]!.usdPerMTok).toBeCloseTo(0.000042 / row.totalTokens * 1e6, 2);
  });

  test("redaction is on by default and redact: false keeps full values", () => {
    const redacted = report(WINDOW);
    const json = JSON.stringify(redacted);
    expect(json).not.toContain(home);
    for (const label of ["__main__", "chatgpt-fixture"]) expect(json).not.toContain(label);
    expect(redacted.quota.windows.map(w => w.account)).toEqual(["account 1", "account 2"]);
    expect(redacted.conversations.every(c => c.id.length <= 8)).toBe(true);
    expect(redacted.conversations.map(c => c.project)).toContain("~/work/app-a");
    expect(redacted.coverage.sourcesRead).toContain("opencodex request ledger (~/usage.jsonl)");

    const full = report({ ...WINDOW, redact: false });
    expect(full.conversations.some(c => c.id.length > 8)).toBe(true);
    expect(full.conversations.map(c => c.project)).toContain(join(home, "work", "app-a", "server"));
    expect(full.quota.windows.map(w => w.account)).toEqual(["__main__", "chatgpt-fixture"]);
    expect(full.coverage.sourcesRead).toContain(`opencodex request ledger (${join(home, "usage.jsonl")})`);
    // Redaction changes labels, never numbers.
    expect(full.kpis).toEqual(redacted.kpis);
  });

  test("the same input twice gives the identical JSON string", () => {
    const first = JSON.stringify(report({ ...WINDOW, phases: SAMPLE_INPUT.phases }));
    const second = JSON.stringify(report({ ...WINDOW, phases: SAMPLE_INPUT.phases }, {}, structuredClone(dataset)));
    expect(second).toBe(first);
  });

  test("ordering: models by tokens then name, conversations by tokens, top limits the list", () => {
    const data = report({ ...WINDOW, top: 3 });
    expect(data.conversations).toHaveLength(3);
    const tokens = report(WINDOW).conversations.map(c => c.tokens);
    expect(tokens).toEqual([...tokens].sort((a, b) => b - a));
    for (let i = 1; i < data.models.length; i++) {
      const [before, after] = [data.models[i - 1]!, data.models[i]!];
      expect(before.tokens > after.tokens || (before.tokens === after.tokens && before.model <= after.model)).toBe(true);
    }
  });

  test("timeline is hourly up to 48 hours and daily beyond", () => {
    const twoDays = report({ tz: "Asia/Singapore", from: "2026-10-09 18:00", to: "2026-10-11 18:00" });
    expect(twoDays.timeline.bucket).toBe("hour");
    expect(twoDays.timeline.points).toHaveLength(48);
    expect(twoDays.timeline.points[0]!.label).toBe("Fri 18:00");
    const threeDays = report({ tz: "Asia/Singapore", from: "2026-10-08", to: "2026-10-11" });
    expect(threeDays.timeline.bucket).toBe("day");
    expect(threeDays.timeline.points.map(p => p.label)).toEqual(["Thu 8 Oct", "Fri 9 Oct", "Sat 10 Oct"]);
  });

  test("unavailable pricing leaves dollars null", () => {
    const data = report({ ...WINDOW, phases: SAMPLE_INPUT.phases }, { pricing: "unavailable" });
    expect(data.coverage.pricing).toBe("unavailable");
    expect(data.kpis.costUsd).toBeNull();
    expect(data.phases.every(p => p.costUsd === null)).toBe(true);
    expect(data.models.every(m => m.costUsd === null && m.usdPerMTok === null)).toBe(true);
    expect(data.conversations.every(c => c.costUsd === null)).toBe(true);
  });

  test("an empty window is a valid report", () => {
    const data = report({ tz: "UTC", from: "2020-01-01", to: "2020-01-02", phases: ["A=2020-01-01 06:00..+1h"] });
    expect(data.kpis).toMatchObject({ requests: 0, tokens: 0, conversations: 0, activeHours: 0, cacheHitRate: null, successRate: null });
    expect(data.timeline.points).toHaveLength(24);
    expect(data.models).toEqual([]);
    expect(data.conversations).toEqual([]);
    expectPhasesAddUp(data);
  });
});
