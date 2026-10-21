/**
 * Endpoint and page-open benchmark against a copy of real (or synthetic) data (#95).
 *
 *   OCX_HOME=<copy> CLAUDE_PROJECTS_DIR=<dir> CODEX_HOME=<dir> \
 *     scripts/bun scripts/bench-endpoints.ts --modes pages,endpoints,poll,append,format \
 *       [--root <checkout>] [--port 4399] [--runs 5] [--ranges 24h,7d,30d,all] [--align-ms 0] \
 *       [--label after] [--out results.json]
 *   scripts/bun scripts/bench-endpoints.ts --compare before.json after.json
 *
 * Yald writes its Claude archive into OCX_HOME, so OCX_HOME must be a copy: the script refuses
 * to run against ~/.opencodex. `append` clones OCX_HOME and CLAUDE_PROJECTS_DIR into a scratch
 * directory next to OCX_HOME and appends synthetic lines to the clones only. Results hold
 * timings and counts, never request content. `--root` runs another checkout's server (for
 * example an export of origin/dev) with the same data and method.
 *
 * pages:     every API call a page makes on open, fired together; wall time until all bodies are read.
 * endpoints: one request at a time; wall time plus the Server-Timing build/compute split when present.
 * poll:      the default view's ETag round trip at once and after one 30 s poll interval.
 * append:    one appended usage.jsonl line, then one appended transcript line: time to the next answer.
 * format:    in-process Intl.DateTimeFormat#formatToParts calls per endpoint.
 * --align-ms waits for the next multiple of this many ms before each measurement, so a response
 * memo keyed on a clock quantum starts cold; it does not change servers without one.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

type Range = string;
const args = new Map<string, string>();
const compare: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]!;
  if (arg === "--compare") { compare.push(...process.argv.slice(i + 1)); break; }
  if (!arg.startsWith("--") || process.argv[i + 1] === undefined) throw new Error(`Expected --option value, got ${arg}`);
  args.set(arg.slice(2), process.argv[++i]!);
}

if (compare.length) {
  printComparison(await Promise.all(compare.map(async path => JSON.parse(await readFile(path, "utf8")) as Results)));
  process.exit(0);
}

const root = resolve(args.get("root") ?? join(import.meta.dir, ".."));
const port = Number(args.get("port") ?? 4399);
const runs = Number(args.get("runs") ?? 5);
const ranges: Range[] = (args.get("ranges") ?? "24h,7d,30d,all").split(",");
const modes = new Set((args.get("modes") ?? "pages,endpoints,poll,format").split(","));
const alignMs = Number(args.get("align-ms") ?? 0);
const label = args.get("label") ?? basename(root);
const out = args.get("out");
const base = `http://127.0.0.1:${port}`;

const ocxHome = process.env.OCX_HOME;
if (!ocxHome || resolve(ocxHome) === resolve(homedir(), ".opencodex")) {
  throw new Error("Set OCX_HOME to a copy of ~/.opencodex: yald writes its Claude archive there, and the live home must stay untouched.");
}
for (const key of ["CLAUDE_PROJECTS_DIR", "CODEX_HOME"]) if (!process.env[key]) throw new Error(`Set ${key} explicitly.`);

/** What each page requests on open with default filters: the toolbar's three calls plus its own. */
const HEADER = (range: Range) => ["/api/meta", `/api/scope?range=${range}`, `/api/projects?range=${range}`];
const VIEW = (path: string) => (range: Range) => [`${path}?range=${range}&groupBy=model&metric=tokens`];
const PAGES: Record<string, (range: Range) => string[]> = {
  Overview: VIEW("/api/overview"),
  Usage: VIEW("/api/usage"),
  Cost: VIEW("/api/cost"),
  Performance: VIEW("/api/performance"),
  Reliability: VIEW("/api/reliability"),
  Models: VIEW("/api/models"),
};
const ENDPOINTS = (range: Range) => [...HEADER(range), ...Object.values(PAGES).flatMap(page => page(range)), "/api/health"];

interface Timing { ms: number; build: number | null; compute: number | null; status: number }
interface Stat { median: number; min: number; max: number; n: number }
interface Results {
  label: string;
  root: string;
  tz: string;
  rows: number | null;
  windowRows: Record<Range, number>;
  pages?: Record<string, Record<Range, Stat>>;
  healthBehindCost?: Stat;
  endpoints?: Record<string, { wall: Stat; build: Stat | null; compute: Stat | null }>;
  poll?: Record<string, { first: Timing; immediate: Timing; afterPoll: Timing; repeat: Timing }>;
  append?: { usage: { wall: Stat; build: Stat | null; cost: Stat }; transcript: { wall: Stat; build: Stat | null; cost: Stat } };
  format?: Record<string, number>;
}

const stats = (values: number[]): Stat => {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  return { median: round(median), min: round(sorted[0]!), max: round(sorted[sorted.length - 1]!), n: sorted.length };
};
const round = (value: number) => Math.round(value * 10) / 10;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
async function align() {
  if (alignMs > 0) await sleep(alignMs - (Date.now() % alignMs) + 25);
}

async function timed(path: string, headers: Record<string, string> = {}, at = base): Promise<Timing & { etag: string | null; body: string }> {
  const started = performance.now();
  const response = await fetch(at + path, { headers });
  const body = await response.text();
  const ms = performance.now() - started;
  const timing = response.headers.get("server-timing") ?? "";
  const part = (name: string) => { const match = new RegExp(`${name};dur=([\\d.]+)`).exec(timing); return match ? Number(match[1]) : null; };
  return { ms, build: part("build"), compute: part("compute"), status: response.status, etag: response.headers.get("etag"), body };
}

async function startServer(env: Record<string, string | undefined> = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["run", join(root, "server/src/index.ts")], {
    env: { ...process.env, ...env, YALD_PORT: String(port) }, stdio: ["ignore", "ignore", "inherit"],
  });
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) { await response.text(); return child; }
    } catch { /* not listening yet */ }
    await sleep(250);
  }
  child.kill();
  throw new Error("server did not become ready");
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise(done => child.once("exit", done));
  child.kill();
  await exited;
}

const results: Results = { label, root, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, rows: null, windowRows: {} };

if (modes.has("pages") || modes.has("endpoints") || modes.has("poll")) {
  const server = await startServer();
  try {
    results.rows = JSON.parse((await timed("/api/health")).body).rows;
    for (const range of ranges) results.windowRows[range] = JSON.parse((await timed(`/api/scope?range=${range}`)).body).windowTotal.requests;
    if (modes.has("pages")) {
      results.pages = {};
      for (const [page, paths] of Object.entries(PAGES)) {
        results.pages[page] = {};
        for (const range of ranges) {
          const urls = [...HEADER(range), ...paths(range)];
          await Promise.all(urls.map(url => timed(url))); // warm-up
          const samples: number[] = [];
          for (let run = 0; run < runs; run++) {
            await align();
            const started = performance.now();
            await Promise.all(urls.map(url => timed(url)));
            samples.push(performance.now() - started);
          }
          results.pages[page][range] = stats(samples);
          console.error(`${label} page ${page} ${range}: ${results.pages[page][range].median} ms`);
        }
      }
      // Head-of-line blocking: a health check sent just after the default Cost page's query.
      const behind: number[] = [];
      for (let run = 0; run < runs; run++) {
        await align();
        const cost = timed(PAGES.Cost!("30d")[0]!);
        await sleep(5);
        behind.push((await timed("/api/health")).ms);
        await cost;
      }
      results.healthBehindCost = stats(behind);
    }
    if (modes.has("endpoints")) {
      results.endpoints = {};
      for (const range of ranges) {
        for (const path of ENDPOINTS(range)) {
          if (results.endpoints[path]) continue;
          await timed(path);
          const samples: Timing[] = [];
          for (let run = 0; run < runs; run++) { await align(); samples.push(await timed(path)); }
          const has = (key: "build" | "compute") => samples.every(sample => sample[key] !== null);
          results.endpoints[path] = {
            wall: stats(samples.map(sample => sample.ms)),
            build: has("build") ? stats(samples.map(sample => sample.build!)) : null,
            compute: has("compute") ? stats(samples.map(sample => sample.compute!)) : null,
          };
          console.error(`${label} ${path}: ${results.endpoints[path].wall.median} ms`);
        }
      }
    }
    if (modes.has("poll")) {
      results.poll = {};
      for (const path of ["/api/overview?range=30d&groupBy=model&metric=tokens", "/api/cost?range=30d&groupBy=model&metric=tokens", "/api/usage?range=30d&groupBy=model&metric=tokens"]) {
        await align();
        const first = await timed(path);
        const immediate = await timed(path, first.etag ? { "if-none-match": first.etag } : {});
        // The dashboard polls every 30 s with the ETag it holds.
        await sleep(30_000);
        const afterPoll = await timed(path, first.etag ? { "if-none-match": first.etag } : {});
        const repeat = await timed(path);
        const strip = ({ ms, build, compute, status }: Timing) => ({ ms: round(ms), build, compute, status });
        results.poll[path] = { first: strip(first), immediate: strip(immediate), afterPoll: strip(afterPoll), repeat: strip(repeat) };
        console.error(`${label} poll ${path}: ${JSON.stringify(results.poll[path])}`);
      }
    }
  } finally {
    await stopServer(server);
  }
}

if (modes.has("append")) {
  // Clones only: the scratch copies are appended to and deleted, never the inputs.
  const scratch = join(dirname(resolve(ocxHome)), `append-scratch-${process.pid}`);
  await mkdir(scratch, { recursive: true });
  const clone = (from: string, to: string) => {
    const result = spawnSync("cp", process.platform === "darwin" ? ["-c", "-R", from, to] : ["-R", "--reflink=auto", from, to]);
    if (result.status !== 0) throw new Error(`could not copy ${from}: ${result.stderr}`);
  };
  const home = join(scratch, "ocx");
  const claude = join(scratch, "claude");
  clone(resolve(ocxHome), home);
  clone(resolve(process.env.CLAUDE_PROJECTS_DIR!), claude);
  const server = await startServer({ OCX_HOME: home, CLAUDE_PROJECTS_DIR: claude });
  try {
    const costPath = "/api/cost?range=30d&groupBy=model&metric=tokens";
    await timed(costPath);
    await sleep(1_200);
    await timed("/api/health");
    const newest = await newestTranscript(claude);
    const measure = async (append: (n: number) => Promise<void>) => {
      const wall: number[] = [], build: number[] = [], cost: number[] = [];
      for (let n = 0; n < runs; n++) {
        await append(n);
        // Longer than any freshness interval, so the next request sees the append.
        await sleep(1_200);
        const health = await timed("/api/health");
        wall.push(health.ms);
        if (health.build !== null) build.push(health.build);
        cost.push((await timed(costPath)).ms);
      }
      return { wall: stats(wall), build: build.length === wall.length ? stats(build) : null, cost: stats(cost) };
    };
    const usage = await measure(n => appendFile(join(home, "usage.jsonl"), JSON.stringify(syntheticUsage(n)) + "\n"));
    const transcript = await measure(n => appendFile(newest, JSON.stringify(syntheticAssistant(n)) + "\n"));
    results.append = { usage, transcript };
    console.error(`${label} append: ${JSON.stringify(results.append)}`);
  } finally {
    await stopServer(server);
    await rm(scratch, { recursive: true, force: true });
  }
}

if (modes.has("format")) {
  // In-process: count zone lookups per endpoint at the default 30d view.
  const { api } = await import(join(root, "server/src/api.ts"));
  await (await api.request("/api/health")).text();
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (this: Intl.DateTimeFormat, ...input: Parameters<typeof original>) {
    calls++;
    return original.apply(this, input);
  };
  results.format = {};
  for (const path of [...HEADER("30d"), ...Object.values(PAGES).flatMap(page => page("30d"))]) {
    calls = 0;
    await (await api.request(path)).text();
    results.format[path] = calls;
  }
  Intl.DateTimeFormat.prototype.formatToParts = original;
  console.error(`${label} formatToParts: ${JSON.stringify(results.format)}`);
}

if (out) {
  await mkdir(dirname(resolve(out)), { recursive: true });
  await writeFile(out, JSON.stringify(results, null, 2) + "\n");
}
console.log(JSON.stringify(results, null, 2));
process.exit(0);

function syntheticUsage(n: number) {
  return {
    requestId: `bench-append-${Date.now()}-${n}`, timestamp: Date.now(), provider: "openai", model: "gpt-5", inboundProtocol: "responses",
    status: 200, durationMs: 1200, firstOutputMs: 300, usageStatus: "reported", conversationId: "bench-append",
    usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 500, reasoningOutputTokens: 10 },
  };
}

function syntheticAssistant(n: number) {
  const id = `bench-append-${Date.now()}-${n}`;
  return {
    type: "assistant", requestId: id, sessionId: "bench-append", timestamp: new Date().toISOString(),
    message: { id: `msg_${id}`, model: "claude-sonnet-4-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
  };
}

async function newestTranscript(dir: string): Promise<string> {
  let best = { path: "", mtime: -1 };
  for (const name of await readdir(dir, { recursive: true })) {
    if (!String(name).endsWith(".jsonl")) continue;
    const path = join(dir, String(name));
    const info = await stat(path);
    if (info.mtimeMs > best.mtime) best = { path, mtime: info.mtimeMs };
  }
  if (!best.path) throw new Error("no transcript to append to");
  return best.path;
}

function printComparison(all: Results[]) {
  const head = (cols: string[]) => `| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |`;
  const ms = (stat?: Stat | null) => stat ? (stat.median >= 1000 ? `${(stat.median / 1000).toFixed(2)} s` : `${Math.round(stat.median)} ms`) : "–";
  const labels = all.map(result => result.label);
  const rangesSeen = [...new Set(all.flatMap(result => Object.keys(result.windowRows)))];
  console.log(`Rows: ${all.map(result => `${result.label} ${result.rows}`).join(", ")}; rows per window: ${rangesSeen.map(range => `${range} ${all[0]!.windowRows[range]}`).join(", ")}; TZ ${all[0]!.tz}\n`);
  if (all.some(result => result.pages)) {
    console.log("Page open (all of a page's calls fired together; median)\n");
    console.log(head(["Page", ...rangesSeen.flatMap(range => labels.map(name => `${range} ${name}`))]));
    for (const page of Object.keys(all.find(result => result.pages)!.pages!)) {
      console.log(`| ${page} | ${rangesSeen.flatMap(range => all.map(result => ms(result.pages?.[page]?.[range]))).join(" | ")} |`);
    }
    console.log(`| /api/health sent 5 ms after Cost 30d | ${all.map(result => ms(result.healthBehindCost)).join(" | ")} |\n`);
  }
  if (all.some(result => result.endpoints)) {
    console.log("Per endpoint, one request at a time (median wall; Server-Timing build/compute when present)\n");
    console.log(head(["Endpoint", ...labels]));
    for (const path of Object.keys(all.find(result => result.endpoints)!.endpoints!)) {
      console.log(`| \`${path}\` | ${all.map(result => {
        const entry = result.endpoints?.[path];
        if (!entry) return "–";
        return entry.compute ? `${ms(entry.wall)} (build ${ms(entry.build)}, compute ${ms(entry.compute)})` : ms(entry.wall);
      }).join(" | ")} |`);
    }
    console.log("");
  }
  if (all.some(result => result.format)) {
    console.log("formatToParts calls per request, 30d\n");
    console.log(head(["Endpoint", ...labels]));
    for (const path of Object.keys(all.find(result => result.format)!.format!)) {
      console.log(`| \`${path}\` | ${all.map(result => result.format?.[path]?.toLocaleString("en-US") ?? "–").join(" | ")} |`);
    }
    console.log("");
  }
  if (all.some(result => result.poll)) {
    console.log("Poll behaviour: status and wall time\n");
    console.log(head(["Request", ...labels]));
    for (const path of Object.keys(all.find(result => result.poll)!.poll!)) {
      for (const step of ["first", "immediate", "afterPoll", "repeat"] as const) {
        console.log(`| \`${path}\` ${step} | ${all.map(result => {
          const timing = result.poll?.[path]?.[step];
          return timing ? `${timing.status}, ${Math.round(timing.ms)} ms` : "–";
        }).join(" | ")} |`);
      }
    }
    console.log("");
  }
  if (all.some(result => result.append)) {
    console.log("Append cost: next /api/health after one appended line (median wall; build from Server-Timing), then /api/cost 30d\n");
    console.log(head(["Append", ...labels]));
    for (const kind of ["usage", "transcript"] as const) {
      console.log(`| ${kind} line, health | ${all.map(result => result.append ? `${ms(result.append[kind].wall)}${result.append[kind].build ? ` (build ${ms(result.append[kind].build)})` : ""}` : "–").join(" | ")} |`);
      console.log(`| ${kind} line, then cost 30d | ${all.map(result => result.append ? ms(result.append[kind].cost) : "–").join(" | ")} |`);
    }
  }
}
