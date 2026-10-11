import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { materializeFixtureHome, materializeFixturePricing } from "../../../web/scripts/fixtureHome";
import committedSample from "./__fixtures__/report.sample.json";
import { formatTokens, openCommand, openInBrowser, openPlan, summaryLine, USAGE } from "./cli";
import { SAMPLE_INPUT, SAMPLE_NOW } from "./sample";
import { buildReportSpec, type ReportSpecInput } from "./spec";
import type { ReportData } from "./types";

// Every run is a child process: env.ts fixes data paths at import and bun shares one
// module cache across test files, so running the CLI in-process would race them.
// Each child also runs under tests/helpers/no-listener.ts, which exits 99 if the
// process calls Bun.serve, listens on any node:net server, or loads
// server/src/index.ts. A passing run therefore proves no port was opened.
const root = resolve(import.meta.dir, "../../..");
const cli = join(root, "server/src/report/cli.ts");
const guard = join(root, "tests/helpers/no-listener.ts");
const HOUR = 3_600_000;
let home = "";
let pricing = "";
const scratch: string[] = [];

beforeAll(async () => {
  const now = Date.now;
  try { Date.now = () => SAMPLE_NOW; home = await materializeFixtureHome({ reportDay: true }); } finally { Date.now = now; }
  pricing = await materializeFixturePricing();
});

afterAll(async () => {
  await Promise.all([home, pricing, ...scratch].filter(Boolean).map(path => rm(path, { recursive: true, force: true })));
});

async function emptyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yald-report-cli-"));
  scratch.push(dir);
  return dir;
}

/** A path inside the fixture home, removed with it. */
let scratchFileCount = 0;
function scratchFile(name: string): string {
  return join(home, `scratch-${scratchFileCount++}-${name}`);
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = { ...process.env as Record<string, string> };
  // The process zone is UTC and no default zone is configured, so any SGT in the
  // output comes from --tz.
  delete base.YALD_TZ;
  delete base.OCX_OBSERVATORY_TZ;
  delete base.YALD_CWD;
  return {
    ...base,
    // HOME is the fixture root, so redaction shows its paths as ~.
    HOME: home, OCX_HOME: home, CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), CODEX_HOME: join(home, "codex"),
    OCX_PACKAGE_DIR: pricing, YALD_TEST_PRICING_GENERATION: "", TZ: "UTC",
    ...extra,
  };
}

function run(args: string[], options: { cwd?: string; env?: Record<string, string>; entry?: string[] } = {}) {
  const result = spawnSync(process.execPath, ["--preload", guard, ...(options.entry ?? [cli]), ...args], {
    cwd: options.cwd ?? root, env: options.env ?? env(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const SAMPLE_FLAGS = [
  "--tz", SAMPLE_INPUT.tz!, "--from", SAMPLE_INPUT.from!, "--to", SAMPLE_INPUT.to!,
  ...SAMPLE_INPUT.phases!.flatMap(phase => ["--phase", phase]),
  "--title", SAMPLE_INPUT.title!,
];
const BUILD_HOURS = ["--tz", "Asia/Singapore", "--from", "2026-10-11 09:00", "--to", "2026-10-11 17:00"];

describe("no listener guard", () => {
  test("fails a process that serves, listens or loads the server entry", () => {
    for (const code of [
      "Bun.serve({ port: 0, fetch: () => new Response('') })",
      "require('node:http').createServer().listen(0)",
      `await import(${JSON.stringify(join(root, "server/src/index.ts"))})`,
    ]) {
      const result = run([], { entry: ["-e", code] });
      expect(result.code).toBe(99);
      expect(result.stderr).toContain("NO-LISTENER GUARD");
    }
  });
});

describe("yald report", () => {
  test("--help prints the usage, from the CLI and from yald.mjs", () => {
    const direct = run(["--help"]);
    expect(direct.code).toBe(0);
    expect(direct.stdout).toBe(USAGE);
    expect(USAGE.startsWith("yald report [window] [options]\n")).toBe(true);

    const viaBin = spawnSync(process.execPath, [join(root, "scripts/yald.mjs"), "report", "--help"], { encoding: "utf8", env: env() });
    expect(viaBin.status).toBe(0);
    expect(viaBin.stdout).toBe(USAGE);
    const top = spawnSync(process.execPath, [join(root, "scripts/yald.mjs"), "--help"], { encoding: "utf8" });
    expect(top.stdout).toContain("yald report [window] [options]");
  });

  test("--dry-run prints the window, phases in local time and rows per phase and source, and writes nothing", async () => {
    const cwd = await emptyDir();
    const result = run([...SAMPLE_FLAGS, "--dry-run", "--json"], { cwd });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const out = result.stdout;
    expect(out).toContain("Window    Sat 10 Oct 2026, 18:00 – Sun 11 Oct 2026, 18:00 GMT+8");
    expect(out).toContain("Sources   claude-code, ocx");
    expect(out).toMatch(/Phase +Local time +claude-code +ocx +total/);
    // One line per phase, local times included; per-source rows add up to the
    // phase's requests in the committed sample, built from the same fixture.
    const sample = committedSample as unknown as ReportData;
    const times = ["Sat 10 Oct 2026, 23:30 – Sun 11 Oct 2026, 09:00 GMT+8", "Sun 11 Oct 2026, 09:00–15:00 GMT+8", "Sun 11 Oct 2026, 15:00–18:00 GMT+8", "", ""];
    sample.phases.forEach((phase, index) => {
      const line = out.split("\n").find(text => text.startsWith(`${phase.name} `));
      expect(line).toBeDefined();
      expect(line!).toContain(times[index]!);
      const [claude, ocx, total] = line!.trim().split(/\s+/).slice(-3).map(Number);
      expect(claude! + ocx!).toBe(total!);
      expect(total).toBe(phase.requests);
    });
    expect(out).toContain("Would write HTML to yald-report-2026-10-10T1800+0800.html and JSON to yald-report-2026-10-10T1800+0800.json. Nothing written");
    expect(await readdir(cwd)).toEqual([]);
  });

  test("--out - writes only the HTML to stdout", async () => {
    const cwd = await emptyDir();
    const result = run([...BUILD_HOURS, "--out", "-"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("<!doctype html>\n")).toBe(true);
    expect(result.stdout.trimEnd().endsWith("</html>")).toBe(true);
    expect(result.stderr.trimEnd().split("\n").at(-1)).toMatch(/^Wrote HTML to stdout \(\d+ KB\) · 41 requests · /);
    expect(await readdir(cwd)).toEqual([]);
  });

  test("--json - writes only the JSON to stdout, equal to the committed sample apart from the clock", async () => {
    const cwd = await emptyDir();
    const result = run([...SAMPLE_FLAGS, "--out", "report.html", "--json", "-"], { cwd });
    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout) as ReportData;
    expect(result.stdout).toBe(`${JSON.stringify(data, null, 2)}\n`);
    // generatedAt and quota projections follow the real clock; the sample's is frozen.
    const strip = (report: ReportData) => ({ ...report, meta: { ...report.meta, generatedAt: 0 }, quota: null });
    expect(strip(data)).toEqual(strip(committedSample as unknown as ReportData));
    expect(await readdir(cwd)).toEqual(["report.html"]);
    expect(result.stderr.trimEnd().split("\n").at(-1)).toMatch(/^Wrote report\.html \(\d+ KB\) and JSON to stdout \(\d+ KB\) · 72 requests · /);
  });

  test("defaults to ./yald-report-<local from>.html and .json next to it, written atomically", async () => {
    const cwd = await emptyDir();
    const result = run([...BUILD_HOURS, "--json"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect((await readdir(cwd)).sort()).toEqual(["yald-report-2026-10-11T0900+0800.html", "yald-report-2026-10-11T0900+0800.json"]);
    const html = await readFile(join(cwd, "yald-report-2026-10-11T0900+0800.html"), "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(result.stderr.trimEnd().split("\n").at(-1)).toMatch(
      /^Wrote yald-report-2026-10-11T0900\+0800\.html \(\d+ KB\) and yald-report-2026-10-11T0900\+0800\.json \(\d+ KB\) · 41 requests · [\d.]+[KMB] tokens · \$\d+\.\d\d API-equivalent.* · Sun 11 Oct 2026, 09:00–17:00 GMT\+8$/,
    );
  });

  test("yald.mjs report resolves relative paths against the caller's folder", async () => {
    const cwd = await emptyDir();
    const result = spawnSync(process.execPath, [join(root, "scripts/yald.mjs"), "report", ...BUILD_HOURS, "--out", "rel.html"], { cwd, env: env(), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(await readdir(cwd)).toEqual(["rel.html"]);
  });

  test("TZ=UTC with --tz Asia/Singapore reads naive times as SGT and buckets SGT hours and days", () => {
    const hourly = JSON.parse(run([...BUILD_HOURS, "--json", "-", "--out", scratchFile("h.html")]).stdout) as ReportData;
    expect(hourly.meta.tz).toBe("Asia/Singapore");
    expect(hourly.meta.window.from).toBe(Date.parse("2026-10-11T09:00:00+08:00"));
    expect(hourly.meta.window.to).toBe(Date.parse("2026-10-11T17:00:00+08:00"));
    expect(hourly.timeline.bucket).toBe("hour");
    expect(hourly.timeline.points.map(point => point.label)).toEqual(["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"]);
    expect(hourly.timeline.points.map(point => point.ts)).toEqual(Array.from({ length: 8 }, (_, i) => hourly.meta.window.from + i * HOUR));

    const daily = JSON.parse(run(["--tz", "Asia/Singapore", "--from", "2026-10-08", "--to", "2026-10-11", "--json", "-", "--out", scratchFile("d.html")]).stdout) as ReportData;
    expect(daily.timeline.bucket).toBe("day");
    expect(daily.timeline.points.map(point => point.ts)).toEqual(["2026-10-08", "2026-10-09", "2026-10-10"].map(day => Date.parse(`${day}T00:00:00+08:00`)));
    const bucketed = daily.timeline.points.reduce((sum, point) => sum + point.bySource["claude-code"].requests + point.bySource.ocx.requests, 0);
    expect(bucketed).toBe(daily.kpis.requests);
  });

  test("--open is skipped when the HTML goes to a pipe", async () => {
    const cwd = await emptyDir();
    const result = run([...BUILD_HOURS, "--out", "-", "--open"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Not opening a browser");
  });

  test("a write failure exits 1", () => {
    const result = run([...BUILD_HOURS, "--out", join(home, "no-such-folder", "r.html")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("yald report failed:");
  });
});

describe("invalid input exits 2 with the message and writes nothing", () => {
  const window = { tz: "Asia/Singapore", from: "2026-10-11 09:00", to: "2026-10-11 17:00" };
  const windowFlags = ["--tz", window.tz, "--from", window.from, "--to", window.to];
  // [flags, the same request as a ReportSpecInput]: the CLI must print exactly the error buildReportSpec throws.
  const specCases: Array<[string[], ReportSpecInput]> = [
    [["--from", "nonsense"], { from: "nonsense" }],
    [["--last", "2x"], { last: "2x" }],
    [["--from", ""], { from: "" }],
    [["--to", " "], { to: " " }],
    [["--tz", ""], { tz: "" }],
    [["--last", "999999999999999999999999h"], { last: "999999999999999999999999h" }],
    [["--tz", "Mars/Base", "--last", "8h"], { tz: "Mars/Base", last: "8h" }],
    [["--tz", "America/New_York", "--from", "2026-03-08 02:30", "--to", "2026-03-08 05:00"], { tz: "America/New_York", from: "2026-03-08 02:30", to: "2026-03-08 05:00" }],
    [["--tz", window.tz, "--from", window.to, "--to", window.from], { tz: window.tz, from: window.to, to: window.from }],
    [[...windowFlags, "--last", "1h"], { ...window, last: "1h" }],
    [[...windowFlags, "--phase", "no separator"], { ...window, phases: ["no separator"] }],
    [[...windowFlags, "--phase", ""], { ...window, phases: [""] }],
    [[...windowFlags, "--phase", "Late=2026-10-11 16:00..2026-10-11 18:00"], { ...window, phases: ["Late=2026-10-11 16:00..2026-10-11 18:00"] }],
    [[...windowFlags, "--phase", "A=2026-10-11 09:00..+3h", "--phase", "B=2026-10-11 11:00..+1h"], { ...window, phases: ["A=2026-10-11 09:00..+3h", "B=2026-10-11 11:00..+1h"] }],
    [[...windowFlags, "--source", "claude,gemini"], { ...window, sources: "claude,gemini" }],
    [[...windowFlags, "--top", "0"], { ...window, top: "0" }],
  ];
  for (const [flags, input] of specCases) {
    test(flags.join(" "), async () => {
      let expected = "";
      try { buildReportSpec(input, { now: Date.now(), first: 0 }); } catch (error) { expected = (error as Error).message; }
      expect(expected).not.toBe("");
      const cwd = await emptyDir();
      const result = run(flags, { cwd });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(expected);
      expect(await readdir(cwd)).toEqual([]);
    });
  }

  const usageCases: Array<[string[], string]> = [
    [["--bogus"], "Unknown option '--bogus'"],
    [["report.html"], "Unexpected argument 'report.html'"],
    [["--out", "-", "--json", "-"], "--out and --json cannot both be -"],
    [["--last"], "--last"],
    [["--source", "gemini"], `Unknown source "gemini"`],
    [["--out", "report.html", "--json", "report.html"], "must use different file paths"],
    [["--out", "report.html", "--json", "./report.html"], "must use different file paths"],
  ];
  for (const [flags, message] of usageCases) {
    test(flags.join(" "), async () => {
      const cwd = await emptyDir();
      const result = run(flags, { cwd });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
      expect(await readdir(cwd)).toEqual([]);
    });
  }
});

describe("--open", () => {
  test("uses open, start or xdg-open per platform", () => {
    expect(openCommand("darwin", "/tmp/r.html")).toEqual({ command: "open", args: ["/tmp/r.html"] });
    expect(openCommand("win32", "C:\\r.html")).toEqual({ command: "cmd", args: ["/c", "start", "", "C:\\r.html"] });
    expect(openCommand("linux", "/tmp/r.html")).toEqual({ command: "xdg-open", args: ["/tmp/r.html"] });
    expect(openCommand("freebsd", "/tmp/r.html").command).toBe("xdg-open");
  });

  test("opens the file, a temporary copy for --out - on a terminal, and nothing for --out - into a pipe", () => {
    expect(openPlan({ open: false, toStdout: false, stdoutIsTTY: true })).toBe("none");
    expect(openPlan({ open: true, toStdout: false, stdoutIsTTY: false })).toBe("file");
    expect(openPlan({ open: true, toStdout: true, stdoutIsTTY: true })).toBe("temp");
    expect(openPlan({ open: true, toStdout: true, stdoutIsTTY: false })).toBe("skip");
  });

  test("hands the command to the injected opener", () => {
    const calls: Array<[string, string[]]> = [];
    openInBrowser("/tmp/r.html", { platform: "linux", opener: (command, args) => calls.push([command, args]) });
    openInBrowser("/tmp/r.html", { platform: "darwin", opener: (command, args) => calls.push([command, args]) });
    expect(calls).toEqual([["xdg-open", ["/tmp/r.html"]], ["open", ["/tmp/r.html"]]]);
  });
});

describe("summary line", () => {
  const sample = committedSample as unknown as ReportData;
  test("names the files, requests, tokens, API-equivalent cost and window", () => {
    expect(summaryLine({ ...sample, kpis: { ...sample.kpis, requests: 1621, tokens: 210_100_000, costUsd: 82.32 }, coverage: { ...sample.coverage, unpriced: [] } }, [{ what: "makeathon.html", bytes: 142 * 1024 }]))
      .toBe(`Wrote makeathon.html (142 KB) · 1,621 requests · 210.1M tokens · $82.32 API-equivalent · ${sample.meta.window.label}`);
  });

  test("says so when pricing is unavailable", () => {
    expect(summaryLine({ ...sample, kpis: { ...sample.kpis, costUsd: null } }, [{ what: "HTML to stdout", bytes: 900 }]))
      .toContain("Wrote HTML to stdout (900 B) · ");
    expect(summaryLine({ ...sample, kpis: { ...sample.kpis, costUsd: null } }, [])).toContain("cost unavailable (opencodex pricing not found)");
  });

  test("formats token counts compactly", () => {
    expect([12, 1_500, 2_250_000, 3_100_000_000].map(formatTokens)).toEqual(["12", "1.5K", "2.3M", "3.1B"]);
  });
});
