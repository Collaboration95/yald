import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeFixtureHome } from "../web/scripts/fixtureHome";

const home = await materializeFixtureHome();
const usagePath = join(home, "usage.jsonl");
const template = (await readFile(usagePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const rows = Array.from({ length: 66_000 }, (_, index) => {
  const row = { ...template[index % template.length] };
  row.requestId = `benchmark-${index}`;
  return JSON.stringify(row);
});
await writeFile(usagePath, rows.join("\n") + "\n");
process.env.OCX_HOME = home;
process.env.CLAUDE_PROJECTS_DIR = join(home, "claude-projects");
process.env.CODEX_HOME = join(home, "codex");

try {
  const { api } = await import("../server/src/api");
  const coldStart = performance.now();
  const first = await api.request("/api/overview?range=30d");
  await first.arrayBuffer();
  const coldOverviewMs = performance.now() - coldStart;
  const health = await (await api.request("/api/health")).json() as { parseMs: number; rows: number };
  const latency: number[] = [];
  let etag = "";
  for (let index = 0; index < 12; index++) {
    const started = performance.now();
    const response = await api.request("/api/overview?range=30d");
    etag = response.headers.get("etag") ?? etag;
    await response.arrayBuffer();
    latency.push(performance.now() - started);
  }
  const cachedStarted = performance.now();
  const cachedResponse = await api.request("/api/overview?range=30d", { headers: { "if-none-match": etag } });
  const notModifiedMs = performance.now() - cachedStarted;
  latency.sort((a, b) => a - b);
  console.log(JSON.stringify({
    rows: health.rows,
    datasetParseMs: health.parseMs,
    coldOverviewMs: Number(coldOverviewMs.toFixed(2)),
    overviewWarmMs: { p50: Number(latency[Math.floor(latency.length * 0.5)]!.toFixed(2)), p95: Number(latency[Math.floor(latency.length * 0.95)]!.toFixed(2)) },
    unchangedRequest: { status: cachedResponse.status, latencyMs: Number(notModifiedMs.toFixed(2)) },
    codexSessionIndex: await benchmarkCodexIndex(),
  }, null, 2));
} finally {
  await rm(home, { recursive: true, force: true });
}

/** Cold and warm index builds over 1,000 synthetic rollouts with realistic ~20 KB first lines. */
async function benchmarkCodexIndex() {
  const codexHome = await mkdtemp(join(tmpdir(), "yald-benchmark-codex-"));
  try {
    const instructions = "You are Codex. ".repeat(1_400);
    const events = Array.from({ length: 40 }, (_, turn) => JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(400), turn } })).join("\n");
    for (let index = 0; index < 1_000; index++) {
      const day = join(codexHome, "sessions", "2026", "10", String(1 + (index % 28)).padStart(2, "0"));
      await mkdir(day, { recursive: true });
      const id = `019a0000-0000-7000-8000-${String(index).padStart(12, "0")}`;
      const meta = { timestamp: "2026-10-11T01:00:00.000Z", type: "session_meta", payload: { session_id: id, id, timestamp: "2026-10-11T01:00:00.000Z", cwd: `/Users/bench/work/app-${index % 40}`, originator: "codex_cli_rs", source: "cli", base_instructions: { text: instructions } } };
      await writeFile(join(day, `rollout-2026-10-11T01-00-00-${id}.jsonl`), JSON.stringify(meta) + "\n" + events + "\n");
    }
    const { readCodexSessionIndex } = await import("../server/src/codex/sessions");
    const coldStart = performance.now();
    const index = await readCodexSessionIndex(codexHome);
    const coldMs = performance.now() - coldStart;
    const warm: number[] = [];
    for (let run = 0; run < 12; run++) {
      const started = performance.now();
      if (await readCodexSessionIndex(codexHome) !== index) throw new Error("warm refresh rebuilt an unchanged index");
      warm.push(performance.now() - started);
    }
    warm.sort((a, b) => a - b);
    return {
      rollouts: index.size,
      coldMs: Number(coldMs.toFixed(2)),
      warmMs: { p50: Number(warm[Math.floor(warm.length * 0.5)]!.toFixed(2)), p95: Number(warm[Math.floor(warm.length * 0.95)]!.toFixed(2)) },
      budgetMs: { cold: 300, warm: 20 },
    };
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}
