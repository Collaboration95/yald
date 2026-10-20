/** Isolated synthetic L05 API fixture. No product imports before the homes are set. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeFixturePricing } from "./fixtureHome";

export const CACHE_FIXTURE_FROM = Date.parse("2026-10-01T00:00:00Z");
export const CACHE_FIXTURE_TO = CACHE_FIXTURE_FROM + 86_400_000;
export const CACHE_COLLISION_ID = "shared-session,{one,two} & ?";

export async function materializeCacheDetectiveFixture() {
  const home = await mkdtemp(join(tmpdir(), "yald-l05-home-"));
  const pricing = await materializeFixturePricing();
  const cleanup = () => Promise.all([home, pricing].map(path => rm(path, { recursive: true, force: true })));
  try {
    await mkdir(join(home, "codex"));
    await mkdir(join(home, "claude", "synthetic"), { recursive: true });
    const path = join(pricing, "src/usage/cost.ts");
    let engine = await readFile(path, "utf8");
    engine = engine.replace("const RATES = {", `const RATES = {
      "l05-normal": [10, 40, 1, 12.5], "l05-tiny": [2, 4, 1, 3], "l05-free": [0, 0, 0, 0],
      "l05-incomplete": [10, 40, 1, 12.5], "l05-rate-gap": [10, 40, 1, 0],
      "l05-lowerbound": [10, 40, 1, 12.5], "l05-limit": [10, 40, 1, 12.5],`)
      .replace("    tokens,", `    ...(input.model === "l05-incomplete" ? {} : { tokens }),
    ...(input.model === "l05-lowerbound" ? { priorityLowerBound: true } : {}),`);
    await writeFile(path, engine);

    let ordinal = 0;
    const entry = (id: string, read = 60000, write = 10000, extra: Record<string, unknown> = {}) => ({
      requestId: id, timestamp: CACHE_FIXTURE_FROM + ++ordinal * 1000, provider: "synthetic", model: "l05-normal",
      conversationId: id, cwd: "/synthetic/l05/app/server", inboundProtocol: "responses", status: 200,
      usageStatus: "reported", cacheProvenance: "observed", effectiveEffort: "high", routeDecision: { routeKind: "native" },
      usage: { inputTokens: 100000, outputTokens: 1000, cacheReadInputTokens: read, cacheCreationInputTokens: write }, ...extra,
    });
    const rows = [
      entry("case-positive-collision", 60000, 10000, { conversationId: CACHE_COLLISION_ID }),
      entry("case-negative", 2000, 50000),
      entry("case-even", 5, 18),
      entry("case-zero", 0, 0),
      entry("case-tiny-positive", 1, 0, { model: "l05-tiny" }),
      entry("case-tiny-negative", 0, 1, { model: "l05-tiny" }),
      entry("case-free", 60000, 10000, { model: "l05-free" }),
      entry("case-derived", 60000, 0, { model: "gpt-6-astra" }),
      entry("case-lowerbound", 60000, 10000, { model: "l05-lowerbound", requestedServiceTier: "priority" }),
      entry("case-unnamed", 2000, 50000, { conversationId: undefined }),
      entry("case-partial-observed", 60000, 10000, { conversationId: "partial-session" }),
      entry("case-partial-synthesized", 60000, 10000, { conversationId: "partial-session", cacheProvenance: "synthesized" }),
      entry("case-partial-unpriced", 60000, 10000, { conversationId: "partial-session", model: "l05-no-price" }),
      entry("case-unmeasured", 0, 0, { usage: { inputTokens: 100000, outputTokens: 1000 } }),
      entry("case-input-missing", 0, 0, { usage: { outputTokens: 1000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }),
      entry("case-unknown", 60000, 10000, { cacheProvenance: undefined }),
      entry("case-estimated", 60000, 10000, { usageStatus: "estimated" }),
      entry("case-attempts", 0, 0, { usage: undefined, attempts: [{ usage: { inputTokens: 100000, outputTokens: 1000, cacheReadInputTokens: 60000, cacheCreationInputTokens: 10000 } }] }),
      entry("case-incomplete", 60000, 10000, { model: "l05-incomplete" }),
      entry("case-rate-gap", 60000, 10000, { model: "l05-rate-gap" }),
      entry("case-mismatch", 0, 0, { usage: { inputTokens: 100000, outputTokens: 1000, cacheReadInputTokens: 60000, cacheWriteInputTokens: 10000 } }),
      entry("case-other-project", 60000, 10000, { cwd: "/synthetic/l05/other", effectiveEffort: "low", status: 502, routeDecision: { routeKind: "explicit-provider" } }),
      entry("case-unattributed", 60000, 10000, { cwd: undefined }),
      entry("case-from-boundary", 60000, 10000, { timestamp: CACHE_FIXTURE_FROM }),
      entry("case-to-boundary", 60000, 10000, { timestamp: CACHE_FIXTURE_TO }),
      ...Array.from({ length: 105 }, (_, index) => entry(`limit-${String(index).padStart(3, "0")}`, 60000, 10000, { model: "l05-limit" })),
    ];
    await writeFile(join(home, "usage.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(join(home, "claude/synthetic/session.jsonl"), JSON.stringify({
      type: "assistant", requestId: "case-negative-collision", sessionId: CACHE_COLLISION_ID,
      timestamp: new Date(CACHE_FIXTURE_FROM + 500).toISOString(), cwd: "/synthetic/l05/app/server",
      message: { id: "synthetic-l05", model: "l05-normal", usage: { input_tokens: 8000, output_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 50000, service_tier: "standard" } },
    }) + "\n");
    Object.assign(process.env, {
      OCX_HOME: home, OCX_PACKAGE_DIR: pricing, CODEX_HOME: join(home, "codex"), CLAUDE_PROJECTS_DIR: join(home, "claude"),
      YALD_TZ: "UTC", TZ: "UTC",
    });
    return { home, pricing, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

// Production browser preview: scripts/bun run web/scripts/cache-detective-fixture.ts
if (import.meta.main) {
  Date.now = () => CACHE_FIXTURE_TO;
  const fixture = await materializeCacheDetectiveFixture();
  process.env.YALD_HOST = "127.0.0.1";
  process.env.YALD_PORT = process.env.YALD_PREVIEW_PORT ?? "5505";
  let server: ReturnType<typeof Bun.serve> | undefined;
  const requests: string[] = [];
  const shutdown = async () => { server?.stop(true); await fixture.cleanup(); process.exit(0); };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  try {
    const { default: app } = await import("../../server/src/index");
    server = Bun.serve({ ...app, fetch: request => {
      const url = new URL(request.url);
      if (url.pathname === "/__l05/requests") return Response.json(requests);
      if (url.pathname.startsWith("/api/labs/")) requests.push(url.pathname + url.search);
      if (url.pathname === "/api/labs/cache" && url.searchParams.get("search") === "fixture-error") return Response.json({ error: "Synthetic L05 API failure" }, { status: 503 });
      return app.fetch(request);
    } });
    console.log(`L05 synthetic preview: http://127.0.0.1:${server.port}/labs/cache-detective?from=${CACHE_FIXTURE_FROM}&to=${CACHE_FIXTURE_TO}&tz=Asia%2FSingapore&search=case-`);
  } catch (error) { await fixture.cleanup(); throw error; }
}
