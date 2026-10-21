/** L07 fixtures contain synthetic usage accounting only, never transcript bodies. */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeFixturePricing } from "./fixtureHome";

export const CONTEXT_REPLAY_FROM = Date.parse("2026-10-10T00:00:00Z");
export const CONTEXT_REPLAY_TO = CONTEXT_REPLAY_FROM + 600_000;
export const CONTEXT_REPLAY_PARAMS = new URLSearchParams({ from: String(CONTEXT_REPLAY_FROM), to: String(CONTEXT_REPLAY_TO), tz: "Asia/Singapore", efforts: "high", search: "l07-" }).toString();

const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 20, reasoningOutputTokens: 2,
  cacheReadInputTokens: Math.floor(inputTokens / 4), cacheCreationInputTokens: Math.floor(inputTokens / 10) });
function entry(requestId: string, offset: number, extra: Record<string, unknown> = {}) {
  return { requestId, timestamp: CONTEXT_REPLAY_FROM + offset, provider: "anthropic", model: "l07-alpha", conversationId: "l07-shared", inboundProtocol: "messages",
    status: 200, usageStatus: "reported", usage: usage(100), cwd: "/synthetic/context/project", effectiveEffort: "high", requestedModel: "requested/l07-alpha", resolvedModel: "l07-alpha",
    cacheProvenance: "observed", durationMs: 1000, firstOutputMs: 100, routeDecision: { routeKind: "native" }, attempts: [{}], ...extra };
}

export function contextReplayEntries() {
  const rows = [
    // IDs deliberately disagree with ledger order; duplicate IDs/timestamps retain ordinals.
    entry("l07-b", 0, { usage: usage(100) }), entry("l07-a", 0, { usage: usage(300) }), entry("l07-a", 0, { usage: usage(200) }),
    entry("l07-missing", 60_000, { usage: { outputTokens: 20 } }),
    entry("l07-unmetered", 120_000, { usage: undefined, status: 502, usageStatus: "unreported", attempts: [], model: "l07-unpriced", durationMs: undefined, firstOutputMs: undefined }),
    entry("l07-no-cache-accounting", 180_000, { usage: { inputTokens: 800, outputTokens: 20, reasoningOutputTokens: 2 } }),
    entry("l07-attempt-sum", 210_000, { usage: undefined, attempts: [{ usage: usage(1000) }, { usage: usage(1000) }], model: "l07-beta" }),
    entry("l07-model-change", 240_000, { usage: usage(1200), model: "l07-beta", resolvedModel: "l07-beta" }),
    entry("l07-unpriced", 300_000, { usage: usage(1000), model: "l07-unpriced", resolvedModel: "l07-unpriced" }),
    entry("l07-zero", 360_000, { usage: usage(0), model: "l07-free", resolvedModel: "l07-free", durationMs: 0, firstOutputMs: 0 }),
    entry("l07-cohort-outside", 420_000, { effectiveEffort: "low" }),
    entry("l07-before-boundary", -1), entry("l07-after-boundary", 600_000),
    ...[400, 500, 600, 100, 50, 0].map((input, i) => entry(`l07-claude-${i}`, i * 60_000, { usage: usage(input), inboundProtocol: "claude-code",
      usagePresence: { input: true, output: true, cacheRead: true, cacheWrite: true }, model: "l07-beta" })),
    ...[0, 0, 0, 30, 40, 50].map((input, i) => entry(`l07-baseline-${i}`, i * 60_000, { usage: usage(input), conversationId: "l07-zero-baseline" })),
    entry("l07-short-zero", 0, { conversationId: "l07-short", usage: usage(0), model: "l07-free" }),
    entry("l07-short-unpriced", 60_000, { conversationId: "l07-short", usage: usage(42), model: "l07-unpriced", durationMs: undefined, firstOutputMs: undefined }),
    entry("l07-excluded-missing", 0, { conversationId: "l07-excluded", usage: undefined, attempts: [], usageStatus: "unreported", model: "l07-unpriced" }),
    entry("l07-excluded-sum", 60_000, { conversationId: "l07-excluded", usage: undefined, attempts: [{ usage: usage(1000) }] }),
    entry("l07-unnamed", 0, { conversationId: undefined, cwd: undefined }),
    entry("l07-unnamed-missing", 60_000, { conversationId: undefined, cwd: undefined, usage: undefined, attempts: [], model: "l07-unpriced" }),
  ];
  return rows;
}

/** Add to the smoke home before the real API/pricing modules are imported. */
export async function addContextReplayFixtures(home: string, pricing: string) {
  await appendFile(join(home, "usage.jsonl"), contextReplayEntries().map(row => JSON.stringify(row)).join("\n") + "\n");
  const path = join(pricing, "src/usage/cost.ts");
  await writeFile(path, (await readFile(path, "utf8")).replace("const RATES = {", 'const RATES = { "l07-alpha": [2, 10, 0.2, 2.5], "l07-beta": [3, 12, 0.3, 3.75], "l07-free": [0, 0, 0, 0],'));
}

export async function materializeContextReplayFixture() {
  const home = await mkdtemp(join(tmpdir(), "yald-l07-fixture-"));
  let pricing = "";
  try {
    pricing = await materializeFixturePricing();
    await mkdir(join(home, "codex"));
    await mkdir(join(home, "claude-projects"));
    await addContextReplayFixtures(home, pricing);
    return { home, pricing };
  } catch (error) {
    await Promise.all([home, pricing].filter(Boolean).map(path => rm(path, { recursive: true, force: true })));
    throw error;
  }
}
