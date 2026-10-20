/** L03-only, frozen synthetic inputs for the real API. Never reads a personal home. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RADAR_DAY = 86_400_000;
export const RADAR_FROM = Date.parse("2026-10-11T09:00:00+08:00");
export const RADAR_TO = RADAR_FROM + 4 * RADAR_DAY;
export const RADAR_NOW = RADAR_TO + RADAR_DAY;
export const RADAR_WINDOW = { from: String(RADAR_FROM), to: String(RADAR_TO), tz: "Asia/Singapore" };

export async function projectRadarFixture() {
  const root = await mkdtemp(join(tmpdir(), "yald-l03-"));
  const alpha = join(root, "work", "alpha"), beacon = join(root, "work", "beacon"), zero = join(root, "work", "priced-zero"), noPrice = join(root, "work", "unpriced"), priorOnly = join(root, "work", "prior-only");
  for (const path of [alpha, beacon, zero, noPrice, priorOnly]) await mkdir(join(path, ".git"), { recursive: true });
  await mkdir(join(alpha, "server"), { recursive: true });
  await mkdir(join(root, "codex"), { recursive: true });
  await mkdir(join(root, "claude-projects", "synthetic"), { recursive: true });
  await mkdir(join(root, "pricing", "src", "usage"), { recursive: true });
  // Same source-qualified conversation ID and model names are intentional.
  function row(requestId: string, ts: number, cwd: string | null, input: number, model = "radar-metered", extra: Record<string, unknown> = {}) {
    return { requestId, timestamp: ts, cwd, provider: "synthetic", model, conversationId: "collision", inboundProtocol: "responses", status: 200,
      effectiveEffort: "high", durationMs: 100, firstOutputMs: 10, usageStatus: "reported", cacheProvenance: "observed",
      usage: { inputTokens: input, outputTokens: 0, totalTokens: input, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      attempts: [{ status: 200 }], routeDecision: { routeKind: "native" }, ...extra };
  }
  const rows = [
    row("before-prior", RADAR_FROM - 4 * RADAR_DAY - 1, alpha, 999_999_999),
    row("prior-start", RADAR_FROM - 4 * RADAR_DAY, alpha, 600_000),
    row("prior-last", RADAR_FROM - 1, join(alpha, "server"), 400_000),
    row("prior-only", RADAR_FROM - RADAR_DAY, priorOnly, 200_000),
    row("prior-zero", RADAR_FROM - 2 * RADAR_DAY, zero, 50, "radar-zero"),
    row("prior-price-gap", RADAR_FROM - 3 * RADAR_DAY, noPrice, 80, "radar-unpriced"),
    row("current-start", RADAR_FROM, join(alpha, "server"), 100_000),
    row("current-observed-zero", RADAR_FROM + 2 * RADAR_DAY, alpha, 0),
    row("current-price-gap", RADAR_FROM + 3 * RADAR_DAY, alpha, 900, "radar-unpriced"),
    row("source-collision", RADAR_FROM + 60_000, alpha, 200, "radar,model"),
    row("new-project", RADAR_FROM + RADAR_DAY, beacon, 2_000_000),
    row("current-zero", RADAR_TO - 1, zero, 60, "radar-zero"),
    row("current-no-price", RADAR_FROM + RADAR_DAY, noPrice, 1_234, "radar-unpriced"),
    row("no-id", RADAR_FROM + 1, null, 70, "radar-unpriced", { conversationId: undefined }),
    row("no-rollout", RADAR_FROM + 2, null, 80),
    row("at-to", RADAR_TO, alpha, 999_999_999),
  ];
  await writeFile(join(root, "usage.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const transcript = [
    { type: "assistant", requestId: "claude-collision", sessionId: "collision", cwd: alpha, timestamp: new Date(RADAR_FROM + 120_000).toISOString(),
      message: { id: "msg_synthetic_collision", model: "radar,model", usage: { input_tokens: 300, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "assistant", requestId: "claude-prior", sessionId: "collision", cwd: alpha, timestamp: new Date(RADAR_FROM - RADAR_DAY).toISOString(),
      message: { id: "msg_synthetic_prior", model: "radar,model", usage: { input_tokens: 400, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ];
  await writeFile(join(root, "claude-projects", "synthetic", "session.jsonl"), transcript.map(row => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(join(root, "pricing", "src", "usage", "cost.ts"), `
export function estimateRequestCost(input) {
  if (input.model === "radar-unpriced") return null;
  const rate = input.model === "radar-zero" ? 0 : 2;
  const u = input.usage ?? {};
  const tokens = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: 0, cacheWrite: 0 };
  const cost = { input: tokens.input * rate / 1e6, output: tokens.output * rate / 1e6, cacheRead: 0, cacheWrite: 0 };
  return { tokens, cost: { ...cost, total: cost.input + cost.output }, estimated: false,
    price: { provider: input.provider, modelId: input.model, source: "user", status: "verified", cost4: { input: rate, output: rate, cacheRead: rate, cacheWrite: rate } } };
}
`);
  process.env.OCX_HOME = root;
  process.env.CODEX_HOME = join(root, "codex");
  process.env.CLAUDE_PROJECTS_DIR = join(root, "claude-projects");
  process.env.OCX_PACKAGE_DIR = join(root, "pricing");
  process.env.YALD_TZ = "Asia/Singapore";
  Date.now = () => RADAR_NOW;
  return { root, alpha, beacon, zero, noPrice, priorOnly, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// Serve the production build with precisely the same fixture/API used by the SSR checks.
if (import.meta.main) {
  const fixture = await projectRadarFixture();
  process.env.YALD_HOST = "127.0.0.1";
  process.env.YALD_PORT = process.env.YALD_L03_PORT ?? "5333";
  const { default: app } = await import("../../server/src/index");
  const server = Bun.serve(app);
  const shutdown = async () => { server.stop(true); await fixture.cleanup(); process.exit(0); };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}/labs/project-radar?${new URLSearchParams(RADAR_WINDOW)}`, fixture: { alpha: fixture.alpha, beacon: fixture.beacon, zero: fixture.zero, noPrice: fixture.noPrice, priorOnly: fixture.priorOnly } }));
}
