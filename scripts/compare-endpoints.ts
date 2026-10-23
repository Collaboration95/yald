/**
 * Byte-for-byte comparison of API bodies from two checkouts over the same data (#95):
 * every number must be unchanged by the performance work.
 *
 *   OCX_HOME=<copy> CLAUDE_PROJECTS_DIR=<dir> CODEX_HOME=<dir> \
 *     scripts/bun scripts/compare-endpoints.ts --baseline <checkout> [--candidate <checkout>] [--now <epoch ms>]
 *
 * Each checkout runs in its own process with Date.now frozen at the same instant, so rolling
 * windows resolve identically; the routes are called in-process (no server, no port). Bodies
 * are compared by SHA-256 after removing only build diagnostics (builtAt, parse duration,
 * revision) from /api/health and /api/meta. OCX_HOME must be a copy: yald writes its Claude
 * archive there.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1]!);

if (args.has("serve")) await serve(resolve(args.get("serve")!), Number(args.get("now")));
else await compare();

/** Child: answer `path` lines with `{ path, status, hash }`. */
async function serve(root: string, now: number) {
  Date.now = () => now;
  const { api } = await import(join(root, "server/src/api.ts"));
  await (await api.request("/api/health")).text();
  console.log(JSON.stringify({ ready: true }));
  for await (const path of createInterface({ input: process.stdin })) {
    const response = await api.request(path);
    let text = await response.text();
    if (path.startsWith("/api/health") || path.startsWith("/api/meta")) {
      const { builtAt: _builtAt, parseMs: _parseMs, revision: _revision, parse, ...body } = JSON.parse(text);
      text = JSON.stringify({ ...body, ...(parse ? { parse: { malformedLines: parse.malformedLines } } : {}) });
    }
    console.log(JSON.stringify({ path, status: response.status, hash: createHash("sha256").update(text).digest("hex"), bytes: text.length }));
  }
}

function paths(): string[] {
  const list: string[] = ["/api/health", "/api/meta"];
  const views = ["overview", "usage", "cost", "performance", "reliability", "models", "timeseries", "conversations", "scope", "projects", "filters", "quota", "ledger", "labs/context", "labs/cache"];
  for (const range of ["24h", "7d", "30d", "all"]) {
    for (const view of views) list.push(`/api/${view}?range=${range}&groupBy=model&metric=tokens`);
    list.push(`/api/window?range=${range}`);
    for (const tz of ["America/New_York", "Asia/Kolkata", "Australia/Lord_Howe", "Europe/London", "Asia/Kathmandu"]) {
      for (const bucket of ["hour", "day", "week"]) {
        if (range === "all" && bucket === "hour") continue;
        for (const view of ["usage", "cost", "performance", "timeseries"]) list.push(`/api/${view}?range=${range}&tz=${encodeURIComponent(tz)}&bucket=${bucket}&groupBy=provider&metric=cost`);
      }
      list.push(`/api/reliability?range=${range}&tz=${encodeURIComponent(tz)}`, `/api/overview?range=${range}&tz=${encodeURIComponent(tz)}&metric=requests&groupBy=effort`);
      for (const [weekday, hour] of [[0, 9], [3, 14], [6, 1]]) list.push(`/api/usage/heatmap-dates?range=${range}&tz=${encodeURIComponent(tz)}&weekday=${weekday}&hour=${hour}&metric=tokens`);
    }
    list.push(`/api/overview?range=${range}&sources=claude-code`, `/api/cost?range=${range}&sources=ocx&groupBy=effort`, `/api/usage?range=${range}&statuses=error,cancelled`);
  }
  list.push("/api/export?range=24h&dataset=requests", "/api/export?range=30d&dataset=models", "/api/export?range=30d&dataset=conversations");
  return list;
}

async function compare() {
  const home = process.env.OCX_HOME;
  if (!home || resolve(home) === resolve(homedir(), ".opencodex")) throw new Error("Set OCX_HOME to a copy of ~/.opencodex.");
  const baseline = resolve(args.get("baseline") ?? "");
  const candidate = resolve(args.get("candidate") ?? join(import.meta.dir, ".."));
  // A multiple of ten seconds, so a quantized request clock and an exact one agree.
  const now = Number(args.get("now") ?? Math.floor(Date.now() / 10_000) * 10_000);
  const list = paths();
  const run = (root: string) => new Promise<Map<string, { status: number; hash: string; bytes: number }>>((done, fail) => {
    const child = spawn(process.execPath, [import.meta.path, "--serve", root, "--now", String(now)], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, YALD_FRESHNESS_MS: "60000" } });
    const results = new Map<string, { status: number; hash: string; bytes: number }>();
    createInterface({ input: child.stdout! }).on("line", line => {
      const message = JSON.parse(line);
      if (message.ready) { child.stdin!.write(list.join("\n") + "\n"); return; }
      results.set(message.path, message);
      if (results.size === list.length) { child.stdin!.end(); child.kill(); done(results); }
    });
    child.on("exit", code => { if (results.size < list.length) fail(new Error(`${root} exited ${code}`)); });
  });
  const [before, after] = [await run(baseline), await run(candidate)];
  const differing = list.filter(path => before.get(path)!.hash !== after.get(path)!.hash || before.get(path)!.status !== after.get(path)!.status);
  const bytes = list.reduce((sum, path) => sum + after.get(path)!.bytes, 0);
  console.log(JSON.stringify({ now, requests: list.length, identical: list.length - differing.length, differing, comparedBytes: bytes }, null, 2));
  process.exit(differing.length ? 1 : 0);
}
