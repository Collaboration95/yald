// `yald report` (#38): writes a standalone HTML report (and optionally its JSON
// payload) for an exact window, without starting the server or opening a port.
//
//   scripts/bun run server/src/report/cli.ts --last 8h --open
//
// scripts/yald.mjs runs this file for `yald report …`. env.ts fixes the data paths
// when it is first imported, so this file statically imports only modules that never
// read it (node built-ins and the pure time/spec modules); the data, pricing and
// context modules are imported after the flags have been copied into process.env.
// It never imports server/src/index.ts.
import { spawn } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isoInZone, windowLabel, WindowError } from "../time/window";
import { buildReportSpec, ReportSpecError, type ReportSpecInput } from "./spec";
import type { ReportData, ReportSpec, Source } from "./types";

export const USAGE = `yald report [window] [options]

Window (grammar from #33; naive times are read in --tz):
  --from <time>               Start, inclusive. 2026-10-11 09:00 | 2026-10-11T09:00+08:00 | today | -8h
  --to <time>                 End, exclusive. 2026-10-11 17:00 | now | +8h (relative to --from)
  --last <duration>           8h | 2d | 1w. With --to: ends at --to. Alone: ends now.
  --tz <IANA zone>            Default: YALD_TZ, then system zone.
  --phase <name=start..end>   Repeatable. Inside the window, no overlaps. If no window is
                              given, the window is [first phase start, last phase end).

Scope:
  --source <list>             claude-code,ocx (default both). Aliases: claude, codex.
  --project <glob>            Repeatable. Folder or ancestor match (#35).

Output:
  --out <path|->              HTML path, or - for stdout. Default: ./yald-report-<local from>.html
  --json [path|-]             Also write the payload. Default path: same name, .json
  --title <text>              Default: "yald report · <window label>"
  --top <n>                   Conversations listed. Default 10.
  --no-redact                 Full ids, absolute paths, account labels.
  --open                      Open the HTML in the default browser when done.
  --dry-run                   Print the resolved window, phases and row counts per phase/source; write nothing.

Data locations:
  --ocx-home <path>           Same as OCX_HOME
  --claude-projects <path>    Same as CLAUDE_PROJECTS_DIR
  --codex-home <path>         Same as CODEX_HOME

Examples:
  yald report --last 8h --open
  yald report --from yesterday --to today --tz Asia/Singapore --out yesterday.html
  yald report --tz Asia/Singapore \\
    --phase "Prep=2026-10-10 23:30..2026-10-11 09:00" \\
    --phase "Build=2026-10-11 09:00..+6h" \\
    --phase "Demo=2026-10-11 15:00..2026-10-11 18:00" \\
    --project '~/personal/common-grounds-makeathon*' \\
    --out makeathon.html --json
`;

const STRING_FLAGS = ["from", "to", "last", "tz", "phase", "source", "project", "out", "title", "top", "ocx-home", "claude-projects", "codex-home"] as const;

const OPTIONS = {
  from: { type: "string" }, to: { type: "string" }, last: { type: "string" }, tz: { type: "string" },
  phase: { type: "string", multiple: true },
  source: { type: "string", multiple: true },
  project: { type: "string", multiple: true },
  out: { type: "string" }, json: { type: "string" }, title: { type: "string" }, top: { type: "string" },
  "no-redact": { type: "boolean" }, open: { type: "boolean" }, "dry-run": { type: "boolean" },
  "ocx-home": { type: "string" }, "claude-projects": { type: "string" }, "codex-home": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** Bad input: exit code 2. */
export class UsageError extends Error {}

export interface CliArgs {
  help: boolean;
  spec: ReportSpecInput;
  /** HTML path, "-" for stdout, or undefined for the default name. */
  out?: string;
  /** undefined: no JSON; "": the default path; "-": stdout; else a path. */
  json?: string;
  open: boolean;
  dryRun: boolean;
  dirs: { ocxHome?: string; claudeProjects?: string; codexHome?: string };
}

/**
 * Rewrites `--flag value` as `--flag=value` for string flags, so values that start
 * with a dash (`--from -8h`) are read as values rather than rejected by parseArgs as
 * ambiguous. `--json` takes a value only when the next word is `-` or not a flag;
 * otherwise it means "the default path".
 */
function normalize(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const next = argv[i + 1];
    if (token === "--json") {
      if (next !== undefined && (next === "-" || !next.startsWith("-"))) {
        out.push(`--json=${next}`);
        i++;
      } else {
        out.push("--json=");
      }
    } else if (token.startsWith("--") && !token.includes("=") && (STRING_FLAGS as readonly string[]).includes(token.slice(2))
      && next !== undefined && !next.startsWith("--")) {
      out.push(`${token}=${next}`);
      i++;
    } else {
      out.push(token);
    }
  }
  return out;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let values: Record<string, string | string[] | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: normalize(argv), options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const str = (name: string) => values[name] as string | undefined;
  const many = (name: string) => (values[name] as string[] | undefined) ?? [];
  const args: CliArgs = {
    help: values.help === true,
    spec: {
      from: str("from"), to: str("to"), last: str("last"), tz: str("tz"),
      phases: many("phase"),
      // Each --source may itself be a comma-separated list.
      sources: many("source").join(","),
      projects: many("project"),
      top: str("top"),
      redact: values["no-redact"] !== true,
      title: str("title"),
    },
    out: str("out"),
    json: str("json"),
    open: values.open === true,
    dryRun: values["dry-run"] === true,
    dirs: { ocxHome: str("ocx-home"), claudeProjects: str("claude-projects"), codexHome: str("codex-home") },
  };
  if (args.out === "") throw new UsageError("--out needs a path, or - for stdout.");
  if (args.out === "-" && args.json === "-") throw new UsageError("--out and --json cannot both be - (stdout). Write one of them to a file.");
  return args;
}

/** Flag name for an error's `param` (`phase[1]` → `--phase`, `sources` → `--source`). */
function flagOf(param: string): string {
  if (param.startsWith("phase")) return "--phase";
  if (param === "sources") return "--source";
  if (param === "projects") return "--project";
  return `--${param}`;
}

/** Local time for file names, like CSV export names: 2026-10-11T0900+0800. */
export function fileStamp(ts: number, tz: string): string {
  return isoInZone(ts, tz).replace(/^(.{10}T)(\d{2}):(\d{2}).*([+-]\d{2}):(\d{2})$/, "$1$2$3$4$5");
}

export interface Outputs {
  /** null: stdout. */
  html: string | null;
  /** undefined: no JSON; null: stdout. */
  json: string | null | undefined;
}

/** Where the HTML and JSON go, as given or by default (relative to the working directory). */
export function outputPaths(args: Pick<CliArgs, "out" | "json">, spec: Pick<ReportSpec, "window">): Outputs {
  const stem = `yald-report-${fileStamp(spec.window.from, spec.window.tz)}`;
  const html = args.out === "-" ? null : args.out ?? `${stem}.html`;
  let json: string | null | undefined;
  if (args.json === undefined) json = undefined;
  else if (args.json === "-") json = null;
  else if (args.json !== "") json = args.json;
  else json = html === null ? `${stem}.json` : html.replace(/\.html?$/i, "") + ".json";
  if (html !== null && json !== undefined && json !== null && resolve(html) === resolve(json)) {
    throw new UsageError("--out and --json must use different file paths.");
  }
  return { html, json };
}

/** Writes next to the target, then renames over it, so readers never see half a file. */
export async function writeAtomic(path: string, content: string): Promise<void> {
  const target = resolve(path);
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temp, content);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function writeStdout(content: string): Promise<void> {
  return new Promise((done, fail) => process.stdout.write(content, error => (error ? fail(error) : done())));
}

// --open

export type Opener = (command: string, args: string[]) => void;

/** The platform's "open with the default app" command: open, start (via cmd) or xdg-open. */
export function openCommand(platform: NodeJS.Platform, target: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [target] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", target] };
  return { command: "xdg-open", args: [target] };
}

/**
 * What --open does: open the written file; with `--out -`, open a temporary copy
 * when stdout is a terminal, and skip when stdout is piped or redirected (the HTML
 * went somewhere else on purpose).
 */
export function openPlan(input: { open: boolean; toStdout: boolean; stdoutIsTTY: boolean }): "none" | "file" | "temp" | "skip" {
  if (!input.open) return "none";
  if (!input.toStdout) return "file";
  return input.stdoutIsTTY ? "temp" : "skip";
}

export const spawnOpener: Opener = (command, args) => {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", error => process.stderr.write(`Could not open the report: ${error.message}\n`));
  child.unref();
};

export function openInBrowser(target: string, deps: { platform: NodeJS.Platform; opener: Opener }): void {
  const { command, args } = openCommand(deps.platform, target);
  deps.opener(command, args);
}

// Summary line

const KB = 1024;
export function formatBytes(bytes: number): string {
  return bytes < KB ? `${bytes} B` : `${Math.round(bytes / KB).toLocaleString("en-US")} KB`;
}

export function formatTokens(tokens: number): string {
  for (const [size, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (tokens >= size) return `${(tokens / size).toFixed(1)}${unit}`;
  }
  return String(tokens);
}

function formatCost(data: ReportData): string {
  if (data.kpis.costUsd === null) return "cost unavailable (opencodex pricing not found)";
  const dollars = `$${data.kpis.costUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} API-equivalent`;
  const unpriced = data.coverage.unpriced.reduce((sum, entry) => sum + entry.requests, 0);
  return unpriced ? `${dollars} (${unpriced.toLocaleString("en-US")} unpriced requests excluded)` : dollars;
}

/** `Wrote makeathon.html (142 KB) · 1,621 requests · 210.1M tokens · $82.32 API-equivalent · <window label>` */
export function summaryLine(data: ReportData, written: Array<{ what: string; bytes: number }>): string {
  const files = written.map(entry => `${entry.what} (${formatBytes(entry.bytes)})`).join(" and ");
  return [
    `Wrote ${files}`,
    `${data.kpis.requests.toLocaleString("en-US")} requests`,
    `${formatTokens(data.kpis.tokens)} tokens`,
    formatCost(data),
    data.meta.window.label,
  ].join(" · ");
}

// Dry run

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)));
  return rows.map(row => row.map((cell, column) => (column === 0 || column === 1 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join("  ").trimEnd()).join("\n");
}

/** Window, phases in local time, and rows per phase and source. `bySource` holds one report per selected source. */
export function dryRunText(spec: ReportSpec, bySource: Map<Source, ReportData>, outputs: Outputs): string {
  const { window } = spec;
  const lines = [
    `Window    ${window.label}`,
    `          ${isoInZone(window.from, window.tz)} to ${isoInZone(window.to, window.tz)} (half-open, ${window.tz})`,
    `Sources   ${spec.sources.join(", ")}`,
    `Projects  ${spec.projects.length ? spec.projects.join(", ") : "all"}`,
    `Redact    ${spec.redact ? "yes" : "no"}`,
    "",
  ];
  const sources = [...bySource.keys()];
  const header = ["Phase", "Local time", ...sources, "total"];
  const counts = (pick: (data: ReportData) => number) => {
    const values = sources.map(source => pick(bySource.get(source)!));
    return [...values, values.reduce((a, b) => a + b, 0)].map(value => value.toLocaleString("en-US"));
  };
  const rows = [header];
  if (spec.phases.length) {
    const sample = bySource.get(sources[0]!)!;
    sample.phases.forEach((phase, index) => {
      const time = index < spec.phases.length ? windowLabel(phase.from, phase.to, window.tz) : "";
      rows.push([phase.name, time, ...counts(data => data.phases[index]!.requests)]);
    });
  } else {
    rows.push(["(no phases)", window.label, ...counts(data => data.kpis.requests)]);
  }
  lines.push("Rows per phase and source", table(rows), "");
  const target = (path: string | null) => path ?? "stdout";
  lines.push(`Would write HTML to ${target(outputs.html)}${outputs.json === undefined ? "" : ` and JSON to ${target(outputs.json)}`}. Nothing written (--dry-run).`);
  return `${lines.join("\n")}\n`;
}

// Main

export interface MainDeps {
  stdoutIsTTY: boolean;
  platform: NodeJS.Platform;
  opener: Opener;
  now: () => number;
}

const defaultDeps: MainDeps = {
  stdoutIsTTY: process.stdout.isTTY === true,
  platform: process.platform,
  opener: spawnOpener,
  now: () => Date.now(),
};

function fail(message: string): number {
  process.stderr.write(`yald report: ${message}\nRun "yald report --help" for usage.\n`);
  return 2;
}

/** Runs the command; returns the exit code (0 ok, 2 bad input, 1 runtime failure). */
export async function main(argv: string[], deps: MainDeps = defaultDeps): Promise<number> {
  let args: CliArgs;
  let spec: ReportSpec;
  let outputs: Outputs;
  const now = deps.now();
  try {
    args = parseCliArgs(argv);
    if (args.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    // Pure: validates every window, phase, source and top input before any data is read.
    spec = buildReportSpec(args.spec, { now, first: now });
    outputs = outputPaths(args, spec);
  } catch (error) {
    if (error instanceof WindowError || error instanceof ReportSpecError) return fail(`${flagOf(error.param)}: ${error.message}`);
    if (error instanceof UsageError) return fail(error.message);
    throw error;
  }

  // Data locations and the zone, before anything imports env.ts.
  if (args.dirs.ocxHome) process.env.OCX_HOME = resolve(args.dirs.ocxHome);
  if (args.dirs.claudeProjects) process.env.CLAUDE_PROJECTS_DIR = resolve(args.dirs.claudeProjects);
  if (args.dirs.codexHome) process.env.CODEX_HOME = resolve(args.dirs.codexHome);
  process.env.YALD_TZ = spec.window.tz;

  try {
    const { loadPricing } = await import("../ocx/pricing");
    const { getDataset } = await import("../ocx/store");
    const { liveReportContext } = await import("./context");
    const { buildReport } = await import("./build");
    const { renderReportHtml } = await import("./render");

    if (!args.dryRun) process.stderr.write(`Reading usage for ${spec.window.label}…\n`);
    await loadPricing();
    const dataset = await getDataset();
    const ctx = liveReportContext(now);

    if (args.dryRun) {
      const bySource = new Map(spec.sources.map(source => [source, buildReport(dataset, { ...spec, sources: [source] }, ctx)] as const));
      process.stdout.write(dryRunText(spec, bySource, outputs));
      return 0;
    }

    const data = buildReport(dataset, spec, ctx);
    const html = renderReportHtml(data);
    const json = `${JSON.stringify(data, null, 2)}\n`;
    const written: Array<{ what: string; bytes: number }> = [];
    for (const [content, path, kind] of [[html, outputs.html, "HTML"], [json, outputs.json, "JSON"]] as const) {
      if (path === undefined) continue;
      if (path === null) await writeStdout(content);
      else await writeAtomic(path, content);
      written.push({ what: path ?? `${kind} to stdout`, bytes: Buffer.byteLength(content) });
    }
    process.stderr.write(`${summaryLine(data, written)}\n`);

    const plan = openPlan({ open: args.open, toStdout: outputs.html === null, stdoutIsTTY: deps.stdoutIsTTY });
    if (plan === "file") {
      openInBrowser(resolve(outputs.html!), deps);
    } else if (plan === "temp") {
      const temp = join(await mkdtemp(join(tmpdir(), "yald-report-")), `yald-report-${fileStamp(spec.window.from, spec.window.tz)}.html`);
      await writeAtomic(temp, html);
      openInBrowser(temp, deps);
    } else if (plan === "skip") {
      process.stderr.write("Not opening a browser: the HTML went to stdout, which is not a terminal.\n");
    }
    return 0;
  } catch (error) {
    process.stderr.write(`yald report failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  // scripts/yald.mjs runs Bun from the package folder and passes the caller's folder here,
  // so relative paths (--out, data folders) mean what the caller typed.
  if (process.env.YALD_CWD) {
    process.chdir(process.env.YALD_CWD);
    delete process.env.YALD_CWD;
  }
  process.exitCode = await main(process.argv.slice(2));
}
