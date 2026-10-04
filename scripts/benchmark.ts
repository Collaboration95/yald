import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  }, null, 2));
} finally {
  await rm(home, { recursive: true, force: true });
}
