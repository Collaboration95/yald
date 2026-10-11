import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expectNoNetworkReferences } from "../../../tests/helpers/zero-network";
import { materializeFixtureHome, materializeFixturePricing } from "../../../web/scripts/fixtureHome";
import { renderReportHtml } from "./render";
import { SAMPLE_INPUT, SAMPLE_NOW } from "./sample";
import type { ReportSpecInput } from "./spec";
import type { ReportData } from "./types";

// GET /api/report (#39) against the fixture home's report day. The routes run in
// tests/helpers/store-probe.ts in a child process (env.ts fixes OCX_HOME at import and
// bun shares one module cache across test files), with the clock frozen at SAMPLE_NOW
// so meta.generatedAt is deterministic. The probe's `report` op computes what
// `yald report --json -` does: buildReportSpec, buildReport and liveReportContext.
const root = resolve(import.meta.dir, "../../..");
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'";
let home = "";
let pricing = "";
let child: ChildProcessWithoutNullStreams;
let probeEnv: Record<string, string | undefined> = {};
let next: () => Promise<any>;

interface ApiResponse { path: string; status: number; etag: string | null; type: string | null; disposition: string | null; csp: string | null; body: any }

beforeAll(async () => {
  const now = Date.now;
  try { Date.now = () => SAMPLE_NOW; home = await materializeFixtureHome({ reportDay: true }); } finally { Date.now = now; }
  pricing = await materializeFixturePricing();
  child = spawn(process.execPath, [join(root, "tests/helpers/store-probe.ts"), root], {
    cwd: root, stdio: "pipe",
    env: probeEnv = {
      ...process.env, HOME: home, OCX_HOME: home, CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), CODEX_HOME: join(home, "codex"),
      OCX_PACKAGE_DIR: pricing, YALD_TEST_PRICING_GENERATION: "", YALD_TEST_NOW: String(SAMPLE_NOW), TZ: "UTC", YALD_TZ: "UTC",
    },
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

async function get(paths: string[], etag?: string): Promise<ApiResponse[]> {
  return command({ op: "api", paths, ...(etag ? { etag } : {}) });
}

async function one(path: string): Promise<ApiResponse> {
  return (await get([path]))[0]!;
}

/** The CLI's computation for the same inputs. */
async function direct(input: ReportSpecInput): Promise<ReportData> {
  return command({ op: "report", input });
}

/** A query string with every value percent-encoded (a raw `+` would decode to a space). */
function qs(params: Record<string, string | string[] | undefined>): string {
  return Object.entries(params)
    .flatMap(([key, value]) => (value === undefined ? [] : [value].flat().map(item => `${key}=${encodeURIComponent(item)}`)))
    .join("&");
}

const SAMPLE_QUERY = qs({ tz: SAMPLE_INPUT.tz, from: SAMPLE_INPUT.from, to: SAMPLE_INPUT.to, phase: SAMPLE_INPUT.phases, title: SAMPLE_INPUT.title });

test("format=json is { ok, report } and matches the CLI's buildReport for the same inputs", async () => {
  const [json, defaulted] = await get([`/api/report?${SAMPLE_QUERY}&format=json`, `/api/report?${SAMPLE_QUERY}`]);
  expect(json!.status).toBe(200);
  expect(json!.type).toStartWith("application/json");
  const expected = await direct(SAMPLE_INPUT);
  // Key order and values, i.e. the same bytes once serialized.
  expect(JSON.stringify(json!.body)).toBe(JSON.stringify({ ok: true, report: expected }));
  expect(defaulted!.body).toEqual(json!.body);
  const report: ReportData = json!.body.report;
  expect(report.meta.generatedAt).toBe(SAMPLE_NOW);
  expect(report.meta.title).toBe(SAMPLE_INPUT.title!);
  expect(report.meta.tz).toBe("Asia/Singapore");
  expect(report.phases.map(phase => phase.name)).toEqual(["Prep", "Build", "Demo", "(outside phases)", "Total"]);
  // Redaction is on by default.
  expect(report.conversations.length).toBeGreaterThan(0);
  for (const conversation of report.conversations) expect(conversation.id.length).toBeLessThanOrEqual(8);
  expect(JSON.stringify(report)).not.toContain(home);
});

test("format=html is exactly renderReportHtml(), served with the strict CSP, and makes no network references", async () => {
  const response = await one(`/api/report?${SAMPLE_QUERY}&format=html`);
  expect(response.status).toBe(200);
  expect(response.type).toBe("text/html; charset=utf-8");
  expect(response.csp).toBe(CSP);
  expect(response.disposition).toBeNull();
  const report = await direct(SAMPLE_INPUT);
  expect(response.body).toBe(renderReportHtml(report));
  expectNoNetworkReferences(response.body, report.meta.yaldVersion);
  // JSON responses carry no CSP; there is nothing in them to run.
  expect((await one(`/api/report?${SAMPLE_QUERY}`)).csp).toBeNull();
});

test("repeated phase params are read in the order given; an invalid one is a 400 naming phase[n]", async () => {
  const window = { tz: "Asia/Singapore", from: "2026-10-10 18:00", to: "2026-10-11 18:00" };
  const [demo, prep, build] = SAMPLE_INPUT.phases!;
  const shuffled = await one(`/api/report?${qs({ ...window, phase: [demo!, prep!, build!] })}`);
  expect(shuffled.status).toBe(200);
  expect(shuffled.body.report.phases.map((phase: { name: string }) => phase.name)).toEqual(["Prep", "Build", "Demo", "(outside phases)", "Total"]);

  const invalid = await get([
    `/api/report?${qs({ ...window, phase: [prep!, build!, "Demo=2026-10-11 15:00"] })}`,
    `/api/report?${qs({ ...window, phase: [prep!, "Late=2026-10-11 17:00..2026-10-11 19:00", build!] })}&format=html`,
    `/api/report?${qs({ ...window, phase: ["Overlap=2026-10-11 14:00..2026-10-11 16:00", prep!, build!] })}`,
    `/api/report?${qs({ ...window, phase: [prep!, ""] })}`,
  ]);
  expect(invalid.map(response => [response.status, response.body.error?.code, response.body.error?.param])).toEqual([
    [400, "invalid_phase", "phase[2]"],
    [400, "phase_outside_window", "phase[1]"],
    // Build (phase[2]) starts first, so the overlap is reported on the phase given first.
    [400, "phase_overlap", "phase[0]"],
    [400, "invalid_phase", "phase[1]"],
  ]);
  for (const response of invalid) {
    expect(response.type).toStartWith("application/json");
    expect(response.body).toEqual({ ok: false, error: { code: expect.any(String), param: expect.any(String), message: expect.any(String) } });
  }
});

test("invalid window, format, sources and top answer 400 with the WindowError shape", async () => {
  const responses = await get([
    "/api/report?from=soon-ish",
    `/api/report?${SAMPLE_QUERY}&format=pdf`,
    `/api/report?${SAMPLE_QUERY}&sources=gemini`,
    `/api/report?${SAMPLE_QUERY}&top=0`,
  ]);
  expect(responses.map(response => [response.status, response.body.error?.code, response.body.error?.param])).toEqual([
    [400, "invalid_time", "from"],
    [400, "invalid_format", "format"],
    [400, "invalid_source", "sources"],
    [400, "invalid_top", "top"],
  ]);
  for (const response of responses) expect(response.body.ok).toBe(false);
});

test("download=1 names the attachment for the window's local start", async () => {
  const [json, html, inline] = await get([
    `/api/report?${SAMPLE_QUERY}&download=1`,
    `/api/report?${SAMPLE_QUERY}&format=html&download=1`,
    `/api/report?${SAMPLE_QUERY}&download=0`,
  ]);
  expect(json!.disposition).toBe('attachment; filename="yald-report-2026-10-10T1800+0800.json"');
  expect(html!.disposition).toBe('attachment; filename="yald-report-2026-10-10T1800+0800.html"');
  expect(html!.csp).toBe(CSP);
  expect(inline!.disposition).toBeNull();
  expect(json!.body).toEqual(inline!.body);
});

test("an unchanged dataset and pinned window answer 304 to the ETag", async () => {
  const paths = [`/api/report?${SAMPLE_QUERY}`, `/api/report?${SAMPLE_QUERY}&format=html`];
  const [json, html] = await get(paths);
  expect(json!.etag).toMatch(/^W\/"[0-9a-f]{24}"$/);
  expect(html!.etag).not.toBe(json!.etag);
  const [again, otherFormat] = await get(paths, json!.etag!);
  expect(again!.status).toBe(304);
  expect(again!.body).toBe("");
  expect(otherFormat!.status).toBe(200);
  expect((await get([paths[1]!], html!.etag!))[0]!.status).toBe(304);
});

test("redact=0 keeps full conversation ids and paths", async () => {
  const projects = "~/work/app-*";
  const [redacted, plain] = await get([`/api/report?${SAMPLE_QUERY}&${qs({ projects })}`, `/api/report?${SAMPLE_QUERY}&${qs({ projects })}&redact=0`]);
  expect(plain!.body).toEqual({ ok: true, report: await direct({ ...SAMPLE_INPUT, projects, redact: "0" }) });
  const ids = (body: any) => body.report.conversations.map((conversation: { id: string }) => conversation.id);
  expect(ids(plain!.body).some((id: string) => id.length > 8)).toBe(true);
  expect(ids(redacted!.body)).toEqual(ids(plain!.body).map((id: string) => id.slice(0, 8)));
  expect(redacted!.body.report.meta.filters.projects).toEqual([projects]);
  expect(plain!.body.report.meta.filters.projects).toEqual([projects]);
  expect(JSON.stringify(plain!.body.report)).toContain(home);
  expect(JSON.stringify(redacted!.body.report)).not.toContain(home);
});

test("sources accepts aliases", async () => {
  const [claude, claudeCode, codex, both] = await get(["claude", "claude-code", "codex", "codex,claude"].map(sources => `/api/report?${SAMPLE_QUERY}&${qs({ sources })}`));
  expect(claude!.body.report.meta.filters.sources).toEqual(["claude-code"]);
  expect(claude!.body).toEqual(claudeCode!.body);
  expect(codex!.body.report.meta.filters.sources).toEqual(["ocx"]);
  expect(codex!.body.report.models.every((model: { source: string }) => model.source === "ocx")).toBe(true);
  expect(both!.body.report.meta.filters.sources).toEqual(["claude-code", "ocx"]);
  expect(both!.body).toEqual((await one(`/api/report?${SAMPLE_QUERY}`)).body);
});

test("overview and reports agree for the same sources and projects", async () => {
  for (const sources of ["claude", "codex", "claude-code,ocx"]) {
    for (const projects of [undefined, "~/work/app-a*"]) {
      const query = `${SAMPLE_QUERY}&${qs({ sources, projects })}`;
      const [overview, report] = await get([`/api/overview?${query}`, `/api/report?${query}`]);
      expect(overview!.status).toBe(200);
      expect(report!.status).toBe(200);
      expect(overview!.body.summary.requests).toBe(report!.body.report.kpis.requests);
      expect(overview!.body.summary.tokens.total).toBe(report!.body.report.kpis.tokens);
      expect(overview!.body.summary.cost).toBe(report!.body.report.kpis.costUsd);
      if (projects) expect(overview!.body.coverage.unattributedRows).toBe(report!.body.report.coverage.unattributedRows);
    }
  }
  const [invalid] = await get([`/api/overview?${SAMPLE_QUERY}&sources=gemini`]);
  expect(invalid!.status).toBe(400);
  expect(invalid!.body.error).toMatchObject({ code: "invalid_source", param: "sources" });
});

test("projects filters by folder and reports unattributed rows in coverage", async () => {
  const projects = "~/work/app-a*";
  const [all, scoped] = await get([`/api/report?${SAMPLE_QUERY}`, `/api/report?${SAMPLE_QUERY}&${qs({ projects })}`]);
  expect(all!.body.report.coverage.unattributedRows).toBeNull();
  expect(scoped!.body).toEqual({ ok: true, report: await direct({ ...SAMPLE_INPUT, projects }) });
  // The opencodex-routed Anthropic traffic has no Codex session, so no folder.
  expect(scoped!.body.report.coverage.unattributedRows).toBeGreaterThan(0);
  expect(scoped!.body.report.kpis.tokens).toBeLessThan(all!.body.report.kpis.tokens);
  expect(scoped!.body.report.meta.filters.projects).toEqual([projects]);
});

test("yald report --json - prints the same report as format=json", async () => {
  const flags = ["--tz", SAMPLE_INPUT.tz!, "--from", SAMPLE_INPUT.from!, "--to", SAMPLE_INPUT.to!, "--title", SAMPLE_INPUT.title!,
    ...SAMPLE_INPUT.phases!.flatMap(phase => ["--phase", phase])];
  for (const extra of [[], ["--source", "codex", "--project", "~/work/app-a*", "--no-redact"]]) {
    const query = extra.length ? `${SAMPLE_QUERY}&${qs({ sources: "codex", projects: "~/work/app-a*", redact: "0" })}` : SAMPLE_QUERY;
    const api = await one(`/api/report?${query}&format=json`);
    // The CLI's clock is frozen at the probe's, so meta.generatedAt matches too.
    const cli = spawnSync(process.execPath, ["--preload", join(root, "tests/helpers/frozen-clock.ts"), join(root, "server/src/report/cli.ts"),
      ...flags, ...extra, "--json", "-", "--out", join(home, `parity-${extra.length}.html`)], { cwd: root, env: probeEnv, encoding: "utf8" });
    expect(cli.status).toBe(0);
    expect(api.status).toBe(200);
    expect(JSON.stringify(JSON.parse(cli.stdout))).toBe(JSON.stringify(api.body.report));
  }
});
