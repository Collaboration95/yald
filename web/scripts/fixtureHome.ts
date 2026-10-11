/**
 * Builds a throwaway opencodex home with synthetic ledgers.
 *
 * The dashboard is only meaningful with data, but nobody should have to publish
 * their own usage to run the tests. Timestamps are generated relative to now so
 * the default 30-day window always contains them.
 *
 * Point CODEX_HOME at `<home>/codex` and CLAUDE_PROJECTS_DIR at `<home>/claude-projects`.
 * Project folders live under `<home>/work`: app-a is a git repo with a `server` subfolder,
 * app-b is a plain folder, and one Codex SDK run started in a macOS temp folder.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface FixtureModel {
  provider: string;
  model: string;
  effort: string;
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
  durationMs: number;
  ttftMs: number;
  status: number;
  errorCode?: string;
  closeReason?: string;
}

const MODELS: FixtureModel[] = [
  { provider: "openai", model: "gpt-6-luna", effort: "high", input: 48_000, output: 900, cacheRead: 40_000, reasoning: 120, durationMs: 6_400, ttftMs: 900, status: 200 },
  { provider: "openai", model: "gpt-6-sol", effort: "medium", input: 21_000, output: 1_400, cacheRead: 16_000, reasoning: 260, durationMs: 9_800, ttftMs: 1_500, status: 200 },
  { provider: "deepseek", model: "deepseek-flash", effort: "low", input: 12_000, output: 2_100, cacheRead: 9_000, reasoning: 40, durationMs: 2_200, ttftMs: 380, status: 200 },
  { provider: "openai", model: "gpt-6-astra", effort: "xhigh", input: 96_000, output: 3_200, cacheRead: 80_000, reasoning: 900, durationMs: 21_500, ttftMs: 2_400, status: 200 },
];

/** opencodex names a Codex conversation by the first 32 hex chars of sha256(<session id>). */
const conversationKey = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex").slice(0, 32);

const CODEX_SESSIONS = ["019a0000-0000-7000-8000-00000000000a", "019a0000-0000-7000-8000-00000000000b"] as const;
const SUBAGENT_SESSION = "019a0000-0000-7000-8000-00000000001a";
const CONVERSATIONS = CODEX_SESSIONS.map(conversationKey);
/** An opencodex conversation whose rollout Codex has already deleted. */
const ORPHAN_CONVERSATION = conversationKey("019a0000-0000-7000-8000-0000000000ff");
const TEMP_RUN = "/private/var/folders/yd/fixture/T/app-a-sdk-run";

function rollout(meta: Record<string, unknown>, ts: number): string {
  const timestamp = new Date(ts).toISOString();
  return [
    { timestamp, type: "session_meta", payload: { ...meta, timestamp, cli_version: "0.0.0-fixture", model_provider: "openai", base_instructions: { text: "fixture instructions" } } },
    { timestamp, type: "event_msg", payload: { type: "user_message", message: "fixture" } },
  ].map(line => JSON.stringify(line)).join("\n") + "\n";
}

function claudeLine(requestId: string, sessionId: string, cwd: string, ts: number, input: number): string {
  return JSON.stringify({
    type: "assistant", requestId, sessionId, cwd, timestamp: new Date(ts).toISOString(),
    message: { id: "msg_" + requestId, model: "claude-fixture-opus", stop_reason: "end_turn", usage: { input_tokens: input, cache_read_input_tokens: input * 4, cache_creation_input_tokens: 600, output_tokens: 450, service_tier: "standard" } },
  });
}

function usageRow(index: number, ts: number, spec: FixtureModel, conversationId: string | undefined, extra: Record<string, unknown> = {}): string {
  const failed = spec.status >= 400;
  const totalTokens = spec.input + spec.output;
  return JSON.stringify({
    requestId: "fixture-" + String(index).padStart(4, "0"),
    timestamp: ts,
    provider: spec.provider,
    model: spec.model,
    admissionKind: "loopback",
    inboundProtocol: "responses",
    conversationId,
    requestedModel: spec.provider + "/" + spec.model,
    resolvedModel: spec.model,
    requestedEffort: spec.effort,
    effectiveEffort: spec.effort,
    configuredServiceTier: "default",
    modelSupportsServiceTier: false,
    responseServiceTier: "default",
    status: spec.status,
    durationMs: spec.durationMs,
    firstOutputMs: spec.ttftMs,
    usageStatus: failed ? "unreported" : "reported",
    usage: failed ? undefined : {
      inputTokens: spec.input,
      outputTokens: spec.output,
      totalTokens,
      cacheReadInputTokens: spec.cacheRead,
      cachedInputTokens: spec.cacheRead,
      reasoningOutputTokens: spec.reasoning,
    },
    totalTokens: failed ? 0 : totalTokens,
    cacheProvenance: failed ? undefined : "observed",
    attempts: [{ ordinal: 1, provider: spec.provider, model: spec.model, adapter: "openai-responses", status: spec.status, durationMs: spec.durationMs, firstOutputMs: spec.ttftMs, sendCount: 1, recoveryKinds: [], usageStatus: failed ? "unreported" : "reported" }],
    spend: { sends: 1, settled: failed ? 0 : 1, unresolved: failed ? 1 : 0 },
    routeDecision: { version: 1, decisionId: "fixture-decision-" + index, createdAt: ts, requestedModel: spec.provider + "/" + spec.model, routeKind: spec.provider === "openai" ? "native" : "explicit-provider", requirements: [], candidates: [{ provider: spec.provider, model: spec.model, eligible: true, exclusions: [] }], selected: { candidateIndex: 0, provider: spec.provider, model: spec.model, reason: "fixture" } },
    transportPhase: "terminal_sse",
    terminalSource: "upstream",
    ...(spec.errorCode ? { errorCode: spec.errorCode } : {}),
    ...(spec.closeReason ? { closeReason: spec.closeReason } : {}),
    ...(spec.errorCode === "upstream_server_error" ? { upstreamError: "Provider error 502: fixture upstream failure" } : {}),
    ...extra,
  });
}

export interface FixtureOptions {
  /**
   * Adds one busy day ending at now for report tests and the report sample (#36):
   * five more Claude Code sessions across app-a and app-b, and Anthropic traffic
   * routed through opencodex (source `ocx`, no Codex session, so no folder), one
   * request of it without a conversation id. Off by default so the dashboard
   * fixtures and their expected counts stay unchanged.
   */
  reportDay?: boolean;
}

export async function materializeFixtureHome(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yald-fixture-"));
  const now = Date.now();
  const rows: string[] = [];
  const ledger: string[] = [];

  let index = 1;
  // 96 requests spread over the last three days.
  for (let step = 95; step >= 0; step--) {
    const spec = MODELS[index % MODELS.length]!;
    const ts = now - step * (3 * DAY) / 96 - (index % 7) * MINUTE;
    rows.push(usageRow(index, Math.round(ts), spec, CONVERSATIONS[index % CONVERSATIONS.length]!));
    ledger.push(JSON.stringify({ v: 1, kind: "dispatch", send: "fixture-send-" + index, at: Math.round(ts) }));
    if (spec.status < 400) {
      ledger.push(JSON.stringify({ v: 1, kind: "settle", send: "fixture-send-" + index, tokens: spec.input + spec.output, at: Math.round(ts) + 500 }));
    }
    index++;
  }

  // A failure pair so the reliability views have something to show.
  rows.push(usageRow(index, now - 2 * HOUR, { ...MODELS[0]!, status: 502, errorCode: "upstream_server_error" }, CONVERSATIONS[0]!));
  ledger.push(JSON.stringify({ v: 1, kind: "lost", send: "fixture-send-" + index, at: now - 2 * HOUR }));
  index++;
  rows.push(usageRow(index, now - 40 * MINUTE, { ...MODELS[2]!, status: 499, errorCode: "client_closed_request", closeReason: "client_closed" }, CONVERSATIONS[1]!));
  index++;
  rows.push(usageRow(index, now - 3 * HOUR, MODELS[1]!, ORPHAN_CONVERSATION));
  index++;

  // Codex rollouts: app-a's root session, a review subagent naming that root, and an SDK run in a temp folder.
  const appA = join(root, "work", "app-a");
  const appB = join(root, "work", "app-b");
  await mkdir(join(appA, ".git"), { recursive: true });
  await mkdir(join(appA, "server"), { recursive: true });
  await mkdir(appB, { recursive: true });
  const sessions = join(root, "codex", "sessions", "2026", "10", "01");
  const archived = join(root, "codex", "archived_sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(archived, { recursive: true });
  const [rootSession, sdkSession] = CODEX_SESSIONS;
  const started = now - 3 * DAY - HOUR;
  await writeFile(join(sessions, `rollout-2026-10-01T09-00-00-${rootSession}.jsonl`), rollout({ id: rootSession, session_id: rootSession, cwd: appA, originator: "codex_cli_rs", source: "cli" }, started));
  await writeFile(join(sessions, `rollout-2026-10-01T09-30-00-${SUBAGENT_SESSION}.jsonl`), rollout({ id: SUBAGENT_SESSION, session_id: rootSession, parent_thread_id: rootSession, cwd: appA, originator: "codex_cli_rs", source: { subagent: "review" } }, started));
  await writeFile(join(archived, `rollout-2026-10-01T10-00-00-${sdkSession}.jsonl`), rollout({ id: sdkSession, session_id: sdkSession, cwd: TEMP_RUN, originator: "codex_sdk_ts", source: "exec" }, started));

  // Claude Code transcripts from two folders: app-a's server subfolder and app-b.
  const transcripts = [["-work-app-a-server", "claude-fixture-session-a", join(appA, "server"), 5 * HOUR], ["-work-app-b", "claude-fixture-session-b", appB, 26 * HOUR]] as const;
  for (const [folder, sessionId, cwd, ago] of transcripts) {
    await mkdir(join(root, "claude-projects", folder), { recursive: true });
    const lines = [0, 1].map(turn => claudeLine(`${sessionId}-req-${turn}`, sessionId, cwd, now - ago + turn * 4 * MINUTE, 1_200 + turn * 300));
    await writeFile(join(root, "claude-projects", folder, `${sessionId}.jsonl`), lines.join("\n") + "\n", "utf8");
  }

  if (options.reportDay) {
    // [folder, session id, cwd, first turn (ago), turns, minutes between turns]
    const sessions = [
      ["-work-app-a", "5f0c1a2e-0000-4000-8000-000000000001", appA, 17 * HOUR, 6, 20],
      ["-work-app-a-server", "8d41b7c3-0000-4000-8000-000000000002", join(appA, "server"), 8 * HOUR, 10, 15],
      ["-work-app-b", "a92e60f4-0000-4000-8000-000000000003", appB, 6 * HOUR, 5, 30],
      ["-work-app-a", "c3b85d17-0000-4000-8000-000000000004", appA, 2.5 * HOUR, 4, 10],
      ["-work-app-b", "e7f2a940-0000-4000-8000-000000000005", appB, 22 * HOUR, 3, 25],
    ] as const;
    for (const [folder, sessionId, cwd, ago, turns, gap] of sessions) {
      await mkdir(join(root, "claude-projects", folder), { recursive: true });
      const lines = Array.from({ length: turns }, (_, turn) => claudeLine(`${sessionId.slice(0, 8)}-req-${turn}`, sessionId, cwd, now - ago + turn * gap * MINUTE, 2_000 + turn * 400));
      await writeFile(join(root, "claude-projects", folder, `${sessionId}.jsonl`), lines.join("\n") + "\n", "utf8");
    }
    const haiku: FixtureModel = { provider: "anthropic", model: "claude-fixture-haiku", effort: "medium", input: 30_000, output: 1_100, cacheRead: 24_000, reasoning: 0, durationMs: 3_100, ttftMs: 620, status: 200 };
    const viaOcx = conversationKey("anthropic-via-opencodex-fixture");
    for (let turn = 0; turn < 6; turn++) {
      rows.push(usageRow(index++, now - 7 * HOUR + turn * 50 * MINUTE, haiku, viaOcx, { inboundProtocol: "anthropic-messages", routeDecision: undefined }));
    }
    rows.push(usageRow(index++, now - 90 * MINUTE, haiku, undefined, { inboundProtocol: "anthropic-messages", routeDecision: undefined }));
  }

  const quotaSamples = Array.from({ length: 40 }, (_, position) => ({
    observedAt: now - (39 - position) * 90 * MINUTE,
    source: "response-header",
    credentialGeneration: 1,
    windows: [
      { family: "account", window: "weekly", usedPercent: 42 + position, resetAtMs: now + 3 * DAY, monthlyIsPrimaryWindow: false },
      { family: "account", window: "monthly", usedPercent: 61 + Math.round(position * 0.6), resetAtMs: now + 12 * DAY, monthlyIsPrimaryWindow: true },
    ],
  }));

  const quota = {
    version: 1,
    quotas: {
      __main__: { updatedAt: now - MINUTE, weeklyPercent: 81, weeklyResetAt: Math.floor((now + 3 * DAY) / 1000), resetCredits: 0 },
      "chatgpt-fixture": { updatedAt: now - MINUTE, monthlyPercent: 85, monthlyResetAt: Math.floor((now + 12 * DAY) / 1000), monthlyIsPrimaryWindow: true, resetCredits: 0 },
    },
    mainPolicyQuota: { identityKey: "fixture-identity", quota: { updatedAt: now - MINUTE, weeklyPercent: 81, weeklyResetAt: Math.floor((now + 3 * DAY) / 1000), resetCredits: 0 } },
    history: { version: 1, accounts: { "chatgpt-fixture": { identity: "fixture-account", samples: quotaSamples } } },
  };

  await writeFile(join(root, "usage.jsonl"), rows.join("\n") + "\n", "utf8");
  await writeFile(join(root, "spend-ledger.jsonl"), ledger.join("\n") + "\n", "utf8");
  await writeFile(join(root, "codex-quota-cache.json"), JSON.stringify(quota, null, 2), "utf8");
  return root;
}

/**
 * A stand-in opencodex package whose cost engine prices the fixture models at fixed
 * list prices (USD per million tokens) and leaves deepseek unpriced. Point
 * OCX_PACKAGE_DIR at the returned directory. Fixture use only: the real engine
 * is never replaced outside tests and the report sample script.
 */
export async function materializeFixturePricing(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yald-fixture-pricing-"));
  await mkdir(join(dir, "src", "usage"), { recursive: true });
  await writeFile(join(dir, "src", "usage", "cost.ts"), `const RATES = {
  "gpt-6-luna": [1.25, 10, 0.125, 0], "gpt-6-sol": [2.5, 15, 0.25, 0], "gpt-6-astra": [5, 40, 0.5, 0],
  "claude-fixture-opus": [5, 25, 0.5, 6.25], "claude-fixture-haiku": [1, 5, 0.1, 1.25],
};
export function estimateRequestCost(input) {
  const rate = RATES[input.model];
  if (!rate) return null;
  const u = input.usage ?? {};
  const cacheRead = u.cacheReadInputTokens ?? u.cachedInputTokens ?? 0;
  const cacheWrite = u.cacheCreationInputTokens ?? u.cacheWriteInputTokens ?? 0;
  const [inRate, outRate, readRate, writeRate] = rate;
  const cost = {
    input: Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite) * inRate / 1e6,
    output: (u.outputTokens ?? 0) * outRate / 1e6,
    cacheRead: cacheRead * readRate / 1e6,
    cacheWrite: cacheWrite * writeRate / 1e6,
  };
  return {
    cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
    estimated: input.model === "gpt-6-astra",
    price: { cost4: { input: inRate, output: outRate, cacheRead: readRate, cacheWrite: writeRate } },
  };
}
`, "utf8");
  return dir;
}
