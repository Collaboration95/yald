/**
 * Builds a throwaway opencodex home with synthetic ledgers.
 *
 * The dashboard is only meaningful with data, but nobody should have to publish
 * their own usage to run the tests. Timestamps are generated relative to now so
 * the default 30-day window always contains them.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
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

const CONVERSATIONS = ["fixture0000000000000000000000000001", "fixture0000000000000000000000000002"];

function usageRow(index: number, ts: number, spec: FixtureModel, conversationId: string): string {
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
  });
}

export async function materializeFixtureHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ocx-observatory-fixture-"));
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
