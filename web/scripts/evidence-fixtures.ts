/** Synthetic L08 population. No runtime server imports or process environment mutation. */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeFixturePricing } from "./fixtureHome";
import { addContextReplayFixtures, CONTEXT_REPLAY_FROM, CONTEXT_REPLAY_TO } from "./context-replay-fixtures";

export const EVIDENCE_FROM = CONTEXT_REPLAY_FROM;
export const EVIDENCE_TO = CONTEXT_REPLAY_TO;
export const EVIDENCE_SESSION = "l08-shared,{one,two} & ?";
export const EVIDENCE_PARAMS = new URLSearchParams({ from: String(EVIDENCE_FROM), to: String(EVIDENCE_TO), tz: "Asia/Singapore", search: "l08-" }).toString();

export async function addEvidenceFixtures(home: string, pricing: string) {
  const app = join(home, "work", "app"), nested = join(app, "server"), priorOnly = join(home, "work", "prior-only"), zero = join(home, "work", "zero"), unpriced = join(home, "work", "unpriced");
  for (const project of [app, priorOnly, zero, unpriced]) await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(nested);
  const enginePath = join(pricing, "src/usage/cost.ts");
  await writeFile(enginePath, (await readFile(enginePath, "utf8")).replace("const RATES = {", `const RATES = {
    "l08-normal": [10, 40, 1, 12.5], "l08,model": [10, 40, 1, 12.5], "l08-free": [0, 0, 0, 0],
    "l08-tiny": [2, 4, 1, 3], "l08-incomplete": [10, 40, 1, 12.5], "l08-rate-gap": [10, 40, 1, 0],
    "l08-lowerbound": [10, 40, 1, 12.5],`)
    .replace("    tokens,", `    ...(input.model === "l08-incomplete" ? {} : { tokens }),
    ...(input.model === "l08-lowerbound" ? { priorityLowerBound: true } : {}),`));
  const span = EVIDENCE_TO - EVIDENCE_FROM;
  const usage = (inputTokens = 100000, read = 60000, write = 10000) => ({ inputTokens, outputTokens: 1000, reasoningOutputTokens: 100, cacheReadInputTokens: read, cacheCreationInputTokens: write });
  let index = 0;
  const row = (requestId: string, extra: Record<string, unknown> = {}) => ({
    requestId, timestamp: EVIDENCE_FROM + ++index * 1000, cwd: nested, provider: "synthetic", model: "l08-normal",
    inboundProtocol: "messages", conversationId: EVIDENCE_SESSION, effectiveEffort: "high", requestedModel: "synthetic/l08-normal",
    status: 200, durationMs: 50, firstOutputMs: 0, usageStatus: "reported", cacheProvenance: "observed", usage: usage(),
    routeDecision: { routeKind: "native" }, attempts: [{}], ...extra,
  });
  const rows = [
    row("l08-before-prior", { timestamp: EVIDENCE_FROM - span - 1, usage: usage(99999999) }),
    row("l08-prior-first", { timestamp: EVIDENCE_FROM - span, usage: usage(100) }),
    row("l08-prior-last", { timestamp: EVIDENCE_FROM - 1, usage: usage(200) }),
    row("l08-prior-only", { timestamp: EVIDENCE_FROM - 1000, cwd: priorOnly }),
    row("l08-prior-zero", { timestamp: EVIDENCE_FROM - 2000, cwd: zero, model: "l08-free" }),
    row("l08-prior-unpriced", { timestamp: EVIDENCE_FROM - 3000, cwd: unpriced, model: "l08-unknown" }),
    row("l08-current-first", { timestamp: EVIDENCE_FROM }),
    row("l08-duplicate", { timestamp: EVIDENCE_FROM + 100, usage: usage(100000) }),
    row("l08-duplicate", { timestamp: EVIDENCE_FROM + 100, usage: usage(200000) }),
    row("l08-comma", { model: "l08,model" }),
    row("l08-zero", { model: "l08-free", usage: usage(0, 0, 0), durationMs: 0 }),
    row("l08-zero-project", { cwd: zero, model: "l08-free" }),
    row("l08-unpriced-project", { cwd: unpriced, model: "l08-unknown" }),
    row("l08-unpriced", { model: "l08-unknown" }),
    row("l08-unknown", { cacheProvenance: undefined }),
    row("l08-synthesized", { cacheProvenance: "synthesized" }),
    row("l08-input-missing", { usage: { outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }),
    row("l08-attempt-sum", { usage: undefined, attempts: [{ usage: usage() }, { usage: usage() }] }),
    row("l08-usage-estimated", { usageStatus: "estimated" }),
    row("l08-unmeasured", { usage: { inputTokens: 100000, outputTokens: 1000 } }),
    row("l08-incomplete", { model: "l08-incomplete" }),
    row("l08-rate-gap", { model: "l08-rate-gap" }),
    row("l08-mismatch", { usage: { inputTokens: 100000, outputTokens: 1000, cacheReadInputTokens: 60000, cacheWriteInputTokens: 10000 } }),
    row("l08-lowerbound", { model: "l08-lowerbound", requestedServiceTier: "priority" }),
    row("l08-derived", { model: "gpt-6-astra" }),
    row("l08-tiny-positive", { model: "l08-tiny", usage: usage(100, 1, 0) }),
    row("l08-tiny-negative", { model: "l08-tiny", usage: usage(100, 0, 1) }),
    // Two $0.0000025 write premiums must sum before rounding to $0.000005.
    row("l08-round-first", { conversationId: "l08-round", usage: usage(100, 0, 1) }),
    row("l08-round-second", { conversationId: "l08-round", usage: usage(100, 0, 1) }),
    row("l08-unnamed", { conversationId: undefined }),
    row("l08-unattributed", { cwd: undefined, conversationId: undefined }),
    row("l08-other", { cwd: join(home, "work", "other"), conversationId: "l08-other", status: 502, effectiveEffort: "low" }),
    row("l08-at-to", { timestamp: EVIDENCE_TO, usage: usage(99999999) }),
    ...Array.from({ length: 205 }, (_, ordinal) => row(`l08-page-${String(ordinal).padStart(3, "0")}`, { conversationId: "l08-pagination" })),
  ];
  await appendFile(join(home, "usage.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  // Protocol (not provider) supplies this source; identical IDs and named/unnamed collisions.
  await appendFile(join(home, "usage.jsonl"), [
    row("l08-duplicate", { inboundProtocol: "claude-code", timestamp: EVIDENCE_FROM + 100,
      usagePresence: { input: true, output: true, cacheRead: true, cacheWrite: true } }),
    row("l08-unnamed", { inboundProtocol: "claude-code", conversationId: undefined,
      usagePresence: { input: true, output: true, cacheRead: true, cacheWrite: true } }),
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  return { app, nested, priorOnly, zero, unpriced };
}
export async function materializeEvidenceFixture() {
  const home = await mkdtemp(join(tmpdir(), "yald-l08-"));
  const pricing = await materializeFixturePricing();
  const cleanup = () => Promise.all([home, pricing].map(path => rm(path, { recursive: true, force: true })));
  try {
    await mkdir(join(home, "codex"));
    await mkdir(join(home, "claude-projects"));
    await addContextReplayFixtures(home, pricing);
    const projects = await addEvidenceFixtures(home, pricing);
    return { home, pricing, ...projects, cleanup, env: { OCX_HOME: home, OCX_PACKAGE_DIR: pricing,
      CODEX_HOME: join(home, "codex"), CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), YALD_TZ: "UTC", TZ: "UTC" } };
  } catch (error) { await cleanup(); throw error; }
}
