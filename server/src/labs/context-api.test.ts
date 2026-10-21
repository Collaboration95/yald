import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ContextReplayResponse } from "../../../web/src/labs/context-types";

const start = Date.parse("2026-10-10T00:00:00Z");
const usage = { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 40, cacheCreationInputTokens: 10, reasoningOutputTokens: 2 };
const entry = (id: string, ts: number, extra: Record<string, unknown> = {}) => ({
  requestId: id, timestamp: ts, provider: "anthropic", model: "synthetic-model", conversationId: "shared", inboundProtocol: "messages",
  status: 200, usage, usageStatus: "reported", cwd: "/synthetic/project", effectiveEffort: "high", routeDecision: { routeKind: "native" }, ...extra,
});

// Exercise the real parser, normalizer, pricing adapter and API only inside a
// fixture home. No module mock or environment cache can expose a personal log.
test("context endpoint normalizes synthetic presence, source scope, fixed evidence, and parser errors", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "yald-context-api-"));
  try {
    const ledger = join(fixture, "ledger"), pricing = join(fixture, "pricing");
    await mkdir(ledger);
    await mkdir(join(fixture, "codex"));
    await mkdir(join(fixture, "claude"));
    await mkdir(join(pricing, "src/usage"), { recursive: true });
    await writeFile(join(pricing, "src/usage/cost.ts"), `export function estimateRequestCost(input) {
      if (input.model === "unpriced") return null;
      return { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, estimated: false,
        price: { cost4: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } };
    }`);
    const entries = [
      ...[0, 0, 0, 20, 30, 40].map((inputTokens, i) => entry(`eligible-${i}`, start + i * 10, { usage: { ...usage, inputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } })),
      entry("missing-input", start + 15, { usage: { outputTokens: 20 } }),
      entry("unmetered-failure", start + 25, { usage: undefined, status: 502, attempts: [], usageStatus: "unreported" }),
      entry("attempt-sum", start + 35, { usage: undefined, attempts: [{ usage }, { usage }] }),
      entry("transcript", start + 5, { inboundProtocol: "claude-code", usagePresence: { input: true, output: true, cacheRead: true, cacheWrite: true }, durationMs: 100, firstOutputMs: 2 }),
      entry("before-secret", start - 1), entry("after-secret", start + 1000),
      entry("unnamed", start + 5, { conversationId: null, usage: undefined, attempts: [], usageStatus: "unreported", model: "unpriced", cwd: null }),
    ];
    await writeFile(join(ledger, "usage.jsonl"), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
    const fixed = `from=${start}&to=${start + 1000}&tz=Asia%2FSingapore`;
    const paths = [
      `/api/labs/context?${fixed}`, `/api/labs/context?${fixed}&sources=ocx`,
      `/api/labs/context?${fixed}&sources=claude`, `/api/labs/context?${fixed}&sources=ocx&projects=%2Fsynthetic%2Fproject&providers=anthropic&models=synthetic-model&efforts=high&statuses=ok&routeKinds=native&conversationId=shared&search=eligible`,
      `/api/labs/context?${fixed}&models=unpriced`, `/api/labs/context?${fixed}&models=absent`,
      "/api/labs/context?from=garbage", "/api/labs/context?sources=invalid", "/api/labs/context?tz=invalid-zone",
      `/api/labs/context?last=1s&to=${start + 1000}&tz=Asia%2FSingapore`,
    ];
    const root = resolve(import.meta.dir, "../../..");
    const child = spawnSync(process.execPath, [join(root, "tests/helpers/store-probe.ts"), root], {
      cwd: root, input: JSON.stringify({ op: "api", paths }) + "\n", encoding: "utf8", timeout: 30_000,
      env: { ...process.env, OCX_HOME: ledger, CODEX_HOME: join(fixture, "codex"), CLAUDE_PROJECTS_DIR: join(fixture, "claude"),
        OCX_PACKAGE_DIR: pricing, YALD_TEST_NOW: String(start + 1000), YALD_TEST_PRICING_GENERATION: "", TZ: "UTC", YALD_TZ: "UTC" },
    });
    expect(child.status, child.stderr + child.stdout).toBe(0);
    const replies = child.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(replies[0]).toEqual({ ready: true });
    expect(replies[1].error).toBeUndefined();
    const responses = replies[1].result as { status: number; body: ContextReplayResponse & { error?: { code: string } } }[];
    expect(responses.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200, 400, 400, 400, 200]);
    const all = responses[0]!.body;
    expect(all.window).toMatchObject({ from: start, to: start + 1000, tz: "Asia/Singapore", halfOpen: true, fromIso: "2026-10-10T08:00:00+08:00" });
    expect(all.coverage).toMatchObject({ totalRequests: 11, eligibleRequests: 7, excludedRequests: 4, unnamedRequests: 1, pricedRequests: 10, unpricedRequests: 1 });
    expect(all.sessions).toHaveLength(2);
    const proxy = all.sessions.find(s => s.source === "ocx")!;
    expect(proxy).toMatchObject({ totalRequests: 11, inWindowRequests: 9, eligibleRequests: 6, excludedRequests: 3, truncated: true,
      growth: { ranked: true, baseline: 0, latest: 30, absoluteChange: 30, ratio: null } });
    const byId = new Map(proxy.requests.map(p => [p.id, p]));
    expect(byId.get("eligible-0")).toMatchObject({ inputTokens: 0, eligible: true, cost: 0 });
    expect(byId.get("missing-input")).toMatchObject({ inputTokens: null, eligible: false, measurements: { input: false }, exclusionReason: "input accounting missing" });
    expect(byId.get("attempt-sum")).toMatchObject({ inputTokens: null, usageFromAttempts: true, eligible: false, exclusionReason: "attempt-summed usage" });
    expect(byId.get("unmetered-failure")).toMatchObject({ inputTokens: null, totalTokens: null, eligible: false });
    expect(JSON.stringify(all)).not.toContain("secret");
    const transcript = responses[2]!.body;
    expect(transcript.sessions).toHaveLength(1);
    expect(transcript.sessions[0]).toMatchObject({ source: "claude-code", totalRequests: 1, truncated: false });
    expect(transcript.sessions[0]!.requests[0]).toMatchObject({ inputTokens: 100, durationMs: null, ttftMs: null });
    const scoped = responses[3]!.body;
    expect(scoped.coverage.totalRequests).toBe(6);
    const evidence = scoped.sessions[0]!.evidence;
    expect(evidence.selector).toMatchObject({ eligibility: "all", selection: { kind: "session", source: "ocx", conversationId: "shared" },
      cohort: { sources: ["ocx"], projects: ["/synthetic/project"], providers: ["anthropic"], models: ["synthetic-model"], efforts: ["high"], statuses: ["ok"], routeKinds: ["native"], conversationId: "shared", search: "eligible" } });
    expect(evidence.href).toContain(`from=${start}&to=${start + 1000}`);
    expect(evidence.href).not.toContain("range=");
    expect(responses[1]!.body.sessions.every(s => s.source === "ocx")).toBe(true);
    expect(responses[4]!.body).toMatchObject({ coverage: { totalRequests: 1, excludedRequests: 1, unpricedRequests: 1 }, unnamedRequests: 1, sessions: [] });
    expect(responses[5]!.body).toMatchObject({ coverage: { totalRequests: 0 }, sessions: [] });
    expect(responses[6]!.body.error?.code).toBe("invalid_time");
    expect(responses[7]!.body.error?.code).toBe("invalid_source");
    expect(responses[8]!.body.error?.code).toBe("invalid_zone");
    const relative = responses[9]!.body;
    expect(relative.window).toMatchObject({ from: start, to: start + 1000 });
    expect(relative.sessions).toEqual(all.sessions);
    expect(relative.coverage).toEqual(all.coverage);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
