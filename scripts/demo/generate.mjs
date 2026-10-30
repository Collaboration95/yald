import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HOUR = 3_600_000, DAY = 24 * HOUR, MINUTE = 60_000;
const key = id => createHash("sha256").update(id).digest("hex").slice(0, 32);
const jsonl = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";

const SUBAGENT_SESSION = "synthetic-demo-subagents";

/** A labelled Claude session: a main chain that spawns two subagents, one nested. Structure and counts only. */
async function writeSubagentSession(folder, cwd, now) {
  const line = (id, ts, input, extra = {}) => ({ type: "assistant", requestId: `demo-agents-${id}`, sessionId: SUBAGENT_SESSION, cwd, gitBranch: "synthetic-feature",
    timestamp: new Date(ts).toISOString(), isSidechain: false, ...extra, message: { id: `demo-agents-${id}`, model: "demo-lantern", stop_reason: extra.stop ?? "tool_use", content: extra.tools ?? [],
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: Math.floor(input * 0.1), cache_creation_input_tokens: Math.floor(input * 0.9),
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: Math.floor(input * 0.9) } } } });
  const tool = (id, name) => ({ type: "tool_use", id, name });
  const start = now - 6 * HOUR;
  const main = [
    line("main-0", start, 8000, { tools: [tool("synthetic-spawn-a", "Agent")] }),
    line("main-1", start + 8 * MINUTE, 9000, { tools: [tool("synthetic-spawn-b", "Agent"), tool("synthetic-read", "Read")] }),
    line("main-2", start + 16 * MINUTE, 10000, { stop: "end_turn" }),
  ];
  const sub = (agentId, count, begin, input) => Array.from({ length: count }, (_, i) => line(`${agentId}-${i}`, begin + i * MINUTE, input + i * 1000, { isSidechain: true, agentId,
    stop: i === count - 1 ? "end_turn" : "tool_use", tools: i === count - 1 ? [] : [tool(`synthetic-${agentId}-${i}`, "Read")] }));
  // A human prompt is its line's shape; the demo records no text.
  const prompt = { type: "user", sessionId: SUBAGENT_SESSION, uuid: "synthetic-prompt", timestamp: new Date(start - MINUTE).toISOString() };
  await writeFile(join(folder, `${SUBAGENT_SESSION}.jsonl`), jsonl([prompt, ...main]));
  const agents = join(folder, SUBAGENT_SESSION, "subagents");
  await mkdir(agents, { recursive: true });
  const spawn = async (agentId, lines, meta) => {
    await writeFile(join(agents, `agent-${agentId}.jsonl`), jsonl(lines));
    await writeFile(join(agents, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  };
  await spawn("demoa", sub("demoa", 5, start + MINUTE, 3000), { agentType: "synthetic-explorer", spawnDepth: 1, model: "demo-lantern", toolUseId: "synthetic-spawn-a" });
  await spawn("demob", sub("demob", 2, start + 9 * MINUTE, 2000), { agentType: "synthetic-reviewer", spawnDepth: 1, model: "demo-lantern", toolUseId: "synthetic-spawn-b" });
  await spawn("democ", sub("democ", 3, start + 10 * MINUTE, 1000), { agentType: "synthetic-reviewer", spawnDepth: 2, model: "demo-lantern", toolUseId: "synthetic-demob-0" });
}

/** Only synthetic accounting and session metadata. No prompts or response bodies. */
export async function generateDemo(root, now) {
  const ocx = join(root, "opencodex"), codex = join(root, "codex"), claude = join(root, "claude-projects");
  const pricing = join(root, "illustrative-pricing"), home = join(root, "home");
  const orbit = join(root, "projects", "synthetic-orbit"), lantern = join(root, "projects", "synthetic-lantern");
  const priorOnly = join(root, "projects", "synthetic-prior-only");
  for (const path of [ocx, codex, claude, home, join(home, ".config"), join(pricing, "dist/usage"),
    ...[orbit, lantern, priorOnly].map(path => join(path, ".git")), join(orbit, "server"),
    join(codex, "sessions"), join(codex, "archived_sessions"), join(claude, "synthetic-orbit")]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(join(pricing, "dist/usage/cost.js"), await readFile(new URL("./pricing.mjs", import.meta.url)));
  await writeFile(join(pricing, "package.json"), JSON.stringify({ type: "module", name: "synthetic-demo-pricing" }));
  const shared = key("synthetic-demo-codex-orbit");
  await writeFile(join(codex, "sessions/rollout-synthetic-orbit.jsonl"), jsonl([{
    type: "session_meta", payload: { id: "synthetic-demo-codex-orbit", session_id: "synthetic-demo-codex-orbit",
      cwd: join(orbit, "server"), originator: "synthetic-demo", timestamp: new Date(now - 61 * DAY).toISOString() },
  }]));
  const rows = [], transcripts = [];
  const usage = (input, read = Math.floor(input * 0.6), write = Math.floor(input * 0.1)) => ({
    inputTokens: input, outputTokens: 200, cacheReadInputTokens: read, cacheCreationInputTokens: write,
  });
  const ocxRow = (id, ts, extra = {}) => ({ requestId: `demo-${id}`, timestamp: ts,
    provider: "synthetic-proxy", model: "demo-orbit", inboundProtocol: "openai-responses", conversationId: shared,
    status: 200, usageStatus: "reported", cacheProvenance: "observed", usage: usage(10000),
    durationMs: 1200, firstOutputMs: 150, attempts: [{}], effectiveEffort: "high",
    routeDecision: { routeKind: "native" }, spend: { sends: 1, settled: 1, unresolved: 0 }, ...extra });
  const claudeRow = (id, ts, input, extra = {}) => ({ type: "assistant", requestId: `demo-${id}`, sessionId: shared,
    timestamp: new Date(ts).toISOString(), cwd: join(orbit, "server"), message: {
      id: `demo-${id}`, model: "demo-lantern", usage: { input_tokens: Math.floor(input * 0.3), output_tokens: 200,
        cache_read_input_tokens: Math.floor(input * 0.6), cache_creation_input_tokens: Math.floor(input * 0.1) },
    }, ...extra });

  // First loaded history precedes both windows. Prior-only, declining and growing projects.
  rows.push(ocxRow("history", now - 61 * DAY));
  for (let i = 0; i < 12; i++) {
    const ts = now - (32 + i) * DAY;
    rows.push(ocxRow(`prior-orbit-${i}`, ts, { usage: usage(1000) }));
    rows.push(ocxRow(`prior-lantern-${i}`, ts + HOUR, { cwd: lantern, conversationId: "synthetic-prior-lantern", usage: usage(50000) }));
    if (i < 4) rows.push(ocxRow(`prior-only-${i}`, ts + 2 * HOUR, { cwd: priorOnly, conversationId: "synthetic-prior-only" }));
    transcripts.push(claudeRow(`prior-claude-${i}`, ts + 3 * HOUR, 1000));
  }
  // The same conversation ID belongs to two sources. Codex supplies the ocx cwd.
  [1000, 2000, 3000, 6000, 7000, 8000, 0].forEach((input, i) => {
    rows.push(ocxRow(`orbit-${i}`, now - 3 * HOUR + i * 3 * MINUTE, { usage: usage(input) }));
    transcripts.push(claudeRow(`claude-${i}`, now - 2 * HOUR + i * 3 * MINUTE, [8000, 7000, 6000, 4000, 3000, 2000, 0][i]));
  });
  rows.push(ocxRow("context-gap", now - 3 * HOUR + 7 * MINUTE, { usage: { outputTokens: 200 }, cacheProvenance: undefined }));
  rows.push(ocxRow("attempt-gap", now - 3 * HOUR + 11 * MINUTE, { usage: undefined,
    attempts: [{ usage: usage(4000) }, { usage: usage(5000) }], spend: { sends: 2, settled: 2, unresolved: 0 } }));
  // Cache write premiums exceed discounts; a separate no-cache session is exactly even.
  for (let i = 0; i < 7; i++) {
    rows.push(ocxRow(`write-premium-${i}`, now - DAY + i * MINUTE, { cwd: lantern, conversationId: "synthetic-write-premium",
      usage: usage(30000 + i * 1000, 0, 20000) }));
    rows.push(ocxRow(`even-${i}`, now - 2 * DAY + i * MINUTE, { cwd: lantern, conversationId: "synthetic-no-cache", usage: usage(5000, 0, 0) }));
    rows.push(ocxRow(`free-${i}`, now - 4 * HOUR + i * MINUTE, { cwd: lantern, model: "demo-zero", conversationId: "synthetic-zero-price" }));
  }
  // One session of each working-style archetype, spread over the last week.
  // Unknown cache provenance keeps them out of the cache investigation's exact figures.
  const burst = (name, count, start, step) => {
    for (let i = 0; i < count; i++) rows.push(ocxRow(`${name}-${i}`, start + i * step, { cwd: lantern, conversationId: `synthetic-${name}`, usage: usage(4000), cacheProvenance: undefined }));
  };
  for (let day = 1; day <= 5; day++) burst(`poke-${day}`, 2, now - day * DAY - 3 * HOUR, MINUTE);
  burst("quick", 12, now - 3 * DAY - 2 * HOUR, 2 * MINUTE);
  burst("deep", 30, now - 2 * DAY - 6 * HOUR, 3 * MINUTE);
  burst("marathon", 40, now - 5 * DAY, 45 * MINUTE);
  rows.push(ocxRow("unknown-price", now - HOUR, { model: "demo-unpriced", conversationId: "synthetic-unknown-price", cwd: lantern }));
  rows.push(ocxRow("unknown-cache", now - 30 * MINUTE, { conversationId: "synthetic-unknown-cache", cacheProvenance: undefined }));
  rows.push(ocxRow("missing-cache", now - 20 * MINUTE, { conversationId: "synthetic-missing-cache", usage: { inputTokens: 1000, outputTokens: 200 } }));
  rows.push(ocxRow("unnamed", now - 5 * MINUTE, { conversationId: undefined, cwd: undefined }));
  rows.push(ocxRow("latest", now - MINUTE, { cwd: orbit, conversationId: "synthetic-latest" }));
  const samples = Array.from({ length: 20 }, (_, i) => ({ observedAt: now - (20 - i) * HOUR,
    source: "synthetic-demo", windows: [{ family: "account", window: "weekly", usedPercent: 20 + i, resetAtMs: now + 3 * DAY }] }));
  await writeFile(join(ocx, "usage.jsonl"), jsonl(rows));
  await writeFile(join(ocx, "spend-ledger.jsonl"), jsonl(rows.flatMap(row => (row.usage ? [row.usage] : row.attempts.map(a => a.usage))
    .map((u, i) => ({ u, send: `${row.requestId}-${i}` })).flatMap(({ u, send }) => [
      { kind: "dispatch", at: row.timestamp, send },
      { kind: "settle", at: row.timestamp + 1200, send, tokens: (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) },
    ]))));
  await writeFile(join(claude, "synthetic-orbit/session.jsonl"), jsonl(transcripts));
  await writeSubagentSession(join(claude, "synthetic-orbit"), orbit, now);
  await writeFile(join(ocx, "codex-quota-cache.json"), JSON.stringify({ version: 1,
    quotas: { "synthetic-demo-account": { updatedAt: now - MINUTE, weeklyPercent: 39,
      weeklyResetAt: Math.floor((now + 3 * DAY) / 1000), monthlyPercent: 55, monthlyResetAt: Math.floor((now + 12 * DAY) / 1000) } },
    history: { version: 1, accounts: { "synthetic-demo-account": { identity: "synthetic-demo-account", samples } } } }));
  return { OCX_HOME: ocx, CODEX_HOME: codex, CLAUDE_PROJECTS_DIR: claude, OCX_PACKAGE_DIR: pricing,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") };
}
