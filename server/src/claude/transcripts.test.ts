import { expect, test } from "bun:test";
import { normalizeRow } from "../ocx/store";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectEntries, readClaudeEntries, toAgentEvent, toEvent } from "./transcripts";

const usage = {
  input_tokens: 2,
  cache_creation_input_tokens: 2375,
  cache_read_input_tokens: 63268,
  output_tokens: 168,
  output_tokens_details: { thinking_tokens: 40 },
  service_tier: "standard",
};
const block = (content: string) => JSON.stringify({
  type: "assistant",
  requestId: "req_1",
  sessionId: "sess-1",
  timestamp: "2026-10-04T16:44:49.068Z",
  message: { id: "msg_1", model: "claude-opus-5-5", stop_reason: "tool_use", usage, content: [{ type: content }] },
});

test("Claude Code transcript lines normalize to the same RequestRow shape as ocx rows", () => {
  const transcript = [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    block("thinking"),
    block("tool_use"),
    JSON.stringify({ type: "assistant", requestId: "req_2", timestamp: "2026-10-04T16:45:00Z", message: { model: "<synthetic>", usage } }),
    "{\"type\":\"assistant\",\"torn",
  ].join("\n");

  const entries = collectEntries([transcript, transcript]);
  expect(entries).toHaveLength(1);
  const row = normalizeRow(entries[0]!);

  // An ocx row carrying the same request, in ocx's own usage vocabulary.
  const ocxRow = normalizeRow({
    requestId: "req_1",
    timestamp: Date.parse("2026-10-04T16:44:49.068Z"),
    provider: "anthropic",
    model: "claude-opus-5-5",
    conversationId: "sess-1",
    status: 200,
    usageStatus: "reported",
    usage: {
      inputTokens: 65645,
      outputTokens: 168,
      cacheReadInputTokens: 63268,
      cacheCreationInputTokens: 2375,
      reasoningOutputTokens: 40,
    },
  });

  expect(Object.keys(row).sort()).toEqual(Object.keys(ocxRow).sort());
  for (const key of ["id", "ts", "provider", "model", "conversationId", "ok", "inputTokens", "outputTokens",
    "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens", "usageStatus"] as const) {
    expect(row[key]).toEqual(ocxRow[key]);
  }
  expect(row.serviceTier).toBe("standard");
  expect(row.closeReason).toBe("tool_use");
});

test("repeated content blocks count one response and retain complete usage across resumed copies", () => {
  const partial = JSON.parse(block("thinking"));
  partial.message.usage.output_tokens = 3;
  partial.message.stop_reason = null;
  const complete = JSON.parse(block("tool_use"));
  complete.timestamp = "2026-10-04T16:44:50.068Z";
  const resumed = structuredClone(complete);
  resumed.sessionId = "resumed-session";
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    resumed.message.usage[key] = 0;
  }
  const entries = collectEntries([
    [partial, complete, complete].map(line => JSON.stringify(line)).join("\n"),
    [resumed, partial].map(line => JSON.stringify(line)).join("\n"),
  ]);
  expect(entries).toHaveLength(1);
  expect(normalizeRow(entries[0]!).totalTokens).toBe(65813);
  expect(entries[0]!.timestamp).toBe(Date.parse(complete.timestamp));
});

test("a zeroed live copy cannot erase archived usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yald-claude-"));
  const file = join(dir, "sess-1.jsonl");
  const archive = join(await mkdtemp(join(tmpdir(), "yald-archive-")), "usage.jsonl");
  await writeFile(file, block("tool_use") + "\n");
  const original = await readClaudeEntries(dir, archive);
  const zeroed = JSON.parse(block("tool_use"));
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    zeroed.message.usage[key] = 0;
  }
  await writeFile(file, JSON.stringify(zeroed) + "\n");
  const copied = await readClaudeEntries(dir, archive);
  expect(copied.entries).toEqual(original.entries);
  expect((await readFile(archive, "utf8")).trim().split("\n")).toHaveLength(1);
});

test("readClaudeEntries reuses unchanged transcripts and re-parses appended ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yald-claude-"));
  const file = join(dir, "sess-1.jsonl");
  const archive = join(await mkdtemp(join(tmpdir(), "yald-archive-")), "claude.jsonl");
  await writeFile(file, block("text") + "\n");
  const first = await readClaudeEntries(dir, archive);
  expect(first.entries).toHaveLength(1);
  // Unchanged file: the very same cached entry object comes back, nothing re-parsed.
  const again = await readClaudeEntries(dir, archive);
  expect(again.entries[0]).toBe(first.entries[0]!);
  expect(again.signature).toBe(first.signature);
  // No input changed, so no merge pass ran: the previous result and its array come back as is.
  expect(again).toBe(first);
  expect(again.entries).toBe(first.entries);
  // A different archive is a different input.
  const other = join(await mkdtemp(join(tmpdir(), "yald-archive-")), "claude.jsonl");
  expect((await readClaudeEntries(dir, other)).entries).not.toBe(first.entries);

  await appendFile(file, block("text").replace(/req_1/g, "req_2") + "\n");
  const appended = await readClaudeEntries(dir, archive);
  expect(appended.entries.map(e => e.requestId).sort()).toEqual(["req_1", "req_2"]);
  expect(appended.signature).not.toBe(first.signature);
});

test("Claude entries keep the transcript cwd and the archive stores it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yald-claude-"));
  const archive = join(await mkdtemp(join(tmpdir(), "yald-archive-")), "claude.jsonl");
  const line = JSON.parse(block("text"));
  line.cwd = "/work/app-a/server";
  await writeFile(join(dir, "sess-1.jsonl"), JSON.stringify(line) + "\n");
  const { entries } = await readClaudeEntries(dir, archive);
  expect(normalizeRow(entries[0]!).cwd).toBe("/work/app-a/server");
  expect(JSON.parse(await readFile(archive, "utf8")).cwd).toBe("/work/app-a/server");
  expect(normalizeRow(collectEntries([block("text")])[0]!).cwd).toBeNull();
});

test("archive entries written before cwd was kept are back-filled from a live transcript, else null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yald-claude-"));
  const archive = join(await mkdtemp(join(tmpdir(), "yald-archive-")), "claude.jsonl");
  // Two pre-cwd archive entries: req_1 still has its transcript, req_gone does not.
  const old = collectEntries([block("text")])[0]!;
  delete old.usagePresence;
  await writeFile(archive, [old, { ...old, requestId: "req_gone" }].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const line = JSON.parse(block("text"));
  line.cwd = "/work/app-a";
  await writeFile(join(dir, "sess-1.jsonl"), JSON.stringify(line) + "\n");

  const { entries } = await readClaudeEntries(dir, archive);
  const rows = Object.fromEntries(entries.map(entry => [String(entry.requestId), normalizeRow(entry)]));
  expect(rows.req_1!.cwd).toBe("/work/app-a");
  expect(rows.req_gone!.cwd).toBeNull();
  expect(rows.req_1!.measurements.input).toBe(true);
  expect(rows.req_gone!.measurements.input).toBe(false);
  expect(rows.req_1!.totalTokens).toBe(normalizeRow(old).totalTokens);
  // The back-filled copy is appended once, so attribution survives the transcript's deletion.
  const archived = (await readFile(archive, "utf8")).trim().split("\n").map(raw => JSON.parse(raw));
  expect(archived.filter(entry => entry.requestId === "req_1").map(entry => entry.cwd ?? null)).toEqual([null, "/work/app-a"]);
  // A fresh load of that archive (new path, so nothing is cached) prefers the copy with a cwd.
  await rm(join(dir, "sess-1.jsonl"));
  const reloaded = archive.replace(/claude\.jsonl$/, "reloaded.jsonl");
  await copyFile(archive, reloaded);
  const after = await readClaudeEntries(dir, reloaded);
  expect(after.entries.find(entry => entry.requestId === "req_1")!.cwd).toBe("/work/app-a");
});

test("archived Claude entries outlive their deleted transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yald-claude-"));
  const archive = join(await mkdtemp(join(tmpdir(), "yald-archive-")), "claude.jsonl");
  await writeFile(join(dir, "sess-1.jsonl"), block("thinking") + "\n" + block("text") + "\n");
  expect((await readClaudeEntries(dir, archive)).entries).toHaveLength(1);
  // Unchanged entries are not re-appended.
  await appendFile(join(dir, "sess-1.jsonl"), "\n");
  await readClaudeEntries(dir, archive);
  expect((await readFile(archive, "utf8")).trim().split("\n")).toHaveLength(1);

  await rm(join(dir, "sess-1.jsonl"));
  const after = await readClaudeEntries(dir, archive);
  expect(after.entries.map(e => e.requestId)).toEqual(["req_1"]);
});

test("old archive cwd is back-filled even from an incomplete live snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yald-claude-backfill-"));
  const archiveDir = await mkdtemp(join(tmpdir(), "yald-archive-"));
  const archive = join(archiveDir, "usage.jsonl");
  const old = collectEntries([block("text")])[0]!;
  delete old.usagePresence;
  await writeFile(archive, JSON.stringify(old) + "\n");
  const live = JSON.parse(block("text"));
  live.cwd = "/work/app-a";
  live.message.usage.output_tokens = 0;
  live.message.stop_reason = null;
  await writeFile(join(dir, "session.jsonl"), JSON.stringify(live) + "\n");
  const result = await readClaudeEntries(dir, archive);
  expect(result.entries[0]!.cwd).toBe("/work/app-a");
  expect(result.entries[0]!.totalTokens).toBe(old.totalTokens);
  expect(normalizeRow(result.entries[0]!).measurements.input).toBe(false);
  expect(result.entries[0]!.closeReason).toBe(old.closeReason);
  await rm(join(dir, "session.jsonl"));
  expect((await readClaudeEntries(dir, archive)).entries[0]!.cwd).toBe("/work/app-a");
  await Promise.all([dir, archiveDir].map(path => rm(path, { recursive: true })));
});

test("a more complete snapshot without cwd preserves known attribution", () => {
  const early = JSON.parse(block("thinking"));
  early.cwd = "/work/app-a";
  early.message.usage.output_tokens = 0;
  const complete = JSON.parse(block("text"));
  const entries = collectEntries([JSON.stringify(early), JSON.stringify(complete)]);
  expect(entries[0]!.cwd).toBe("/work/app-a");
  expect(entries[0]!.totalTokens).toBe(65813);
});

test("a same-size change in an older transcript invalidates the combined signature", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yald-claude-signature-"));
  const archiveDir = await mkdtemp(join(tmpdir(), "yald-archive-"));
  const archive = join(archiveDir, "usage.jsonl");
  const oldFile = join(dir, "old.jsonl");
  const newFile = join(dir, "new.jsonl");
  const line = JSON.parse(block("text"));
  line.cwd = "/work/app-a";
  await writeFile(oldFile, JSON.stringify(line) + "\n");
  await writeFile(newFile, block("text").replaceAll("req_1", "req_2") + "\n");
  await utimes(oldFile, 100, 100);
  await utimes(newFile, 200, 200);
  const first = await readClaudeEntries(dir, archive);
  line.requestId = "req_3";
  line.cwd = "/work/app-b";
  await writeFile(oldFile, JSON.stringify(line) + "\n");
  await utimes(oldFile, 101, 101);
  const changed = await readClaudeEntries(dir, archive);
  expect(changed.entries.find(entry => entry.requestId === "req_3")!.cwd).toBe("/work/app-b");
  expect(changed.signature).not.toBe(first.signature);
  await Promise.all([dir, archiveDir].map(path => rm(path, { recursive: true })));
});

test("cached live cwd backfill is persisted when another old archive is opened", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yald-claude-cached-"));
  const archiveDir = await mkdtemp(join(tmpdir(), "yald-archive-"));
  const firstArchive = join(archiveDir, "first.jsonl");
  const oldArchive = join(archiveDir, "old.jsonl");
  const line = JSON.parse(block("text"));
  line.cwd = "/work/app-a";
  const transcript = join(dir, "session.jsonl");
  await writeFile(transcript, JSON.stringify(line) + "\n");
  await readClaudeEntries(dir, firstArchive);
  await writeFile(oldArchive, JSON.stringify(collectEntries([block("text")])[0]) + "\n");
  await readClaudeEntries(dir, oldArchive);
  await rm(transcript);
  const reloaded = join(archiveDir, "reloaded.jsonl");
  await copyFile(oldArchive, reloaded);
  expect((await readClaudeEntries(dir, reloaded)).entries[0]!.cwd).toBe("/work/app-a");
  await Promise.all([dir, archiveDir].map(path => rm(path, { recursive: true })));
});

test("external archive appends, same-size rewrites and deletion refresh entries and signature", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yald-claude-external-"));
  const archiveDir = await mkdtemp(join(tmpdir(), "yald-archive-"));
  const archive = join(archiveDir, "usage.jsonl");
  const old = { ...collectEntries([block("text")])[0]!, cwd: "/work/app-a" };
  await writeFile(archive, JSON.stringify(old) + "\n");
  await utimes(archive, 100.0001, 100.0001);
  const first = await readClaudeEntries(dir, archive);
  await writeFile(archive, JSON.stringify({ ...old, cwd: "/work/app-b" }) + "\n");
  await utimes(archive, 100.0002, 100.0002);
  const rewritten = await readClaudeEntries(dir, archive);
  expect(rewritten.entries[0]!.cwd).toBe("/work/app-b");
  expect(rewritten.signature).not.toBe(first.signature);
  await appendFile(archive, JSON.stringify({ ...old, requestId: "req_2" }) + "\n");
  const appended = await readClaudeEntries(dir, archive);
  expect(appended.entries).toHaveLength(2);
  expect(appended.signature).not.toBe(rewritten.signature);
  expect((await readClaudeEntries(dir, archive)).signature).toBe(appended.signature);
  await rm(archive);
  const removed = await readClaudeEntries(dir, archive);
  expect(removed.entries).toEqual([]);
  expect(removed.signature).not.toBe(appended.signature);
  await Promise.all([dir, archiveDir].map(path => rm(path, { recursive: true })));
});

const SECRET = "SECRET-TEXT";
const richLine = (block: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "assistant", requestId: "req_rich", sessionId: "s1", uuid: "u1", timestamp: "2026-10-04T16:44:49.068Z",
  isSidechain: true, agentId: "a1", gitBranch: "feat/x", effort: "high", thinkingDurationMs: 900, promptId: "p1", attributionAgent: "explorer",
  message: { id: "m1", model: "claude-opus-5-5", stop_reason: "tool_use", diagnostics: { cache_miss_reason: "messages_changed" }, content: [block],
    usage: { ...usage, cache_creation: { ephemeral_5m_input_tokens: 375, ephemeral_1h_input_tokens: 2000 } } }, ...extra,
});

test("new transcript fields reach the row; an old line reads as unavailable, not zero", () => {
  const lines = [
    richLine({ type: "thinking", thinking: SECRET }),
    richLine({ type: "tool_use", id: "t1", name: "Bash", input: { command: SECRET } }),
    richLine({ type: "tool_use", id: "t2", name: "Bash", input: { command: SECRET } }),
    richLine({ type: "tool_use", id: "t3", name: "Read", input: { file_path: SECRET } }),
  ];
  const [entry] = collectEntries([lines.join("\n"), lines.join("\n")]);
  expect(JSON.stringify(entry)).not.toContain(SECRET);
  const row = normalizeRow(entry!);
  expect(row.effort).toBe("high");
  expect(row.details).toMatchObject({ agent: "subagent", agentId: "a1", cacheWrite5m: 375, cacheWrite1h: 2000, cacheMissReason: "messages_changed", gitBranch: "feat/x", promptId: "p1", thinkingDurationMs: 900, attributionAgent: "explorer" });
  expect(row.details!.toolCounts).toEqual({ Bash: 2, Read: 1 });

  const old = normalizeRow(collectEntries([block("text")])[0]!);
  expect(old.details).toMatchObject({ agent: null, cacheWrite1h: null, gitBranch: null, cacheMissReason: null });
  const archived = { ...collectEntries([block("text")])[0]! };
  delete archived.detail;
  expect(normalizeRow(archived).details).toBeNull();
});

test("a later, larger snapshot keeps the structure of earlier copies", () => {
  const first = richLine({ type: "tool_use", id: "t1", name: "Edit", input: {} });
  const later = JSON.stringify({ type: "assistant", requestId: "req_rich", sessionId: "s1", timestamp: "2026-10-04T16:44:50.068Z",
    message: { model: "claude-opus-5-5", usage: { ...usage, output_tokens: 999 }, content: [] } });
  const row = normalizeRow(collectEntries([[first, later].join("\n")])[0]!);
  expect(row.outputTokens).toBe(999);
  expect(row.details).toMatchObject({ agentId: "a1", gitBranch: "feat/x", toolCounts: { Edit: 1 } });
});

test("events are classified from structure and keep no text", () => {
  const base = { sessionId: "s1", timestamp: "2026-10-04T16:44:49.068Z", uuid: "u" };
  expect(toEvent({ ...base, type: "system", subtype: "compact_boundary", content: SECRET, compactMetadata: { preTokens: 900, postTokens: 90, trigger: "auto", durationMs: 12 } }))
    .toMatchObject({ kind: "compact", preTokens: 900, postTokens: 90, trigger: "auto", durationMs: 12 });
  expect(toEvent({ ...base, type: "system", subtype: "compact_boundary" })).toMatchObject({ kind: "compact", preTokens: null, trigger: null });
  expect(toEvent({ ...base, type: "system", subtype: "api_error", retryAttempt: 2, maxRetries: 10, error: { status: 529, message: SECRET } }))
    .toMatchObject({ kind: "api-error", retryAttempt: 2, maxRetries: 10, status: 529 });
  expect(toEvent({ ...base, type: "system", subtype: "turn_duration", durationMs: 1500, messageCount: 7 })).toMatchObject({ kind: "turn", durationMs: 1500, messageCount: 7 });
  expect(toEvent({ ...base, type: "pr-link", prNumber: 42, prRepository: "owner/repo", prUrl: SECRET })).toMatchObject({ kind: "pr", prNumber: 42, prRepository: "owner/repo" });
  expect(toEvent({ ...base, type: "user", message: { content: SECRET } })).toMatchObject({ kind: "prompt" });
  expect(JSON.stringify(toEvent({ ...base, type: "user", promptId: "p", message: { content: SECRET } }))).not.toContain(SECRET);
  expect(toEvent({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: SECRET }] } })).toBeNull();
  expect(toEvent({ ...base, type: "user", isMeta: true, message: { content: SECRET } })).toBeNull();
  expect(toEvent({ ...base, type: "user", isSidechain: true, message: { content: SECRET } })).toBeNull();
  expect(toAgentEvent("/x/s1/subagents/agent-a1.meta.json", JSON.stringify({ agentType: "Explore", spawnDepth: 2, toolUseId: "t1", description: SECRET })))
    .toMatchObject({ kind: "agent", sessionId: "s1", agentId: "a1", agentType: "Explore", spawnDepth: 2, toolUseId: "t1" });
});

test("archives hold the new fields and no text, and events outlive their transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yald-detail-"));
  try {
    const projects = join(dir, "projects", "p");
    const archive = join(dir, "usage.jsonl");
    await mkdir(join(projects, "s1", "subagents"), { recursive: true });
    await writeFile(join(projects, "s1.jsonl"), [
      JSON.stringify({ type: "user", sessionId: "s1", uuid: "prompt", timestamp: "2026-10-04T16:44:00Z", message: { content: SECRET } }),
      richLine({ type: "tool_use", id: "t1", name: "Agent", input: { prompt: SECRET } }, { isSidechain: false, agentId: undefined }),
      JSON.stringify({ type: "system", subtype: "compact_boundary", sessionId: "s1", uuid: "c1", timestamp: "2026-10-04T16:45:00Z", content: SECRET, compactMetadata: { preTokens: 5, postTokens: 1, trigger: "manual" } }),
      JSON.stringify({ type: "user", sessionId: "s1", uuid: "tr", timestamp: "2026-10-04T16:45:01Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: SECRET }] } }),
      "",
    ].join("\n"));
    await writeFile(join(projects, "s1", "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", spawnDepth: 1, toolUseId: "t1", description: SECRET }));
    const live = await readClaudeEntries(join(dir, "projects"), archive);
    const kinds = live.events.map(event => event.kind).sort();
    expect(kinds).toEqual(["agent", "captured", "compact", "prompt"]);
    const written = (await readFile(archive, "utf8")) + (await readFile(`${archive}.events`, "utf8"));
    expect(written).not.toContain(SECRET);
    expect(written).toContain('"Agent"');

    const again = await readClaudeEntries(join(dir, "projects"), archive);
    expect(again).toBe(live);
    expect((await readFile(`${archive}.events`, "utf8")).trim().split("\n")).toHaveLength(4);

    await rm(join(dir, "projects"), { recursive: true });
    const gone = await readClaudeEntries(join(dir, "projects"), archive);
    expect(gone.events.map(event => event.kind).sort()).toEqual(kinds);
    expect(normalizeRow(gone.entries[0]!).details).toMatchObject({ agent: "main", toolCounts: { Agent: 1 } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("older archive lines stay valid and gain structure from a live copy once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yald-backfill-"));
  try {
    const archive = join(dir, "usage.jsonl");
    const [entry] = collectEntries([richLine({ type: "text", text: SECRET })]);
    const old = { ...entry! };
    delete old.detail;
    await writeFile(archive, JSON.stringify(old) + "\n");
    await mkdir(join(dir, "projects"));
    expect(normalizeRow((await readClaudeEntries(join(dir, "projects"), archive)).entries[0]!).details).toBeNull();
    await writeFile(join(dir, "projects", "s1.jsonl"), richLine({ type: "text", text: SECRET }) + "\n");
    const filled = await readClaudeEntries(join(dir, "projects"), archive);
    expect(normalizeRow(filled.entries[0]!).details).toMatchObject({ agentId: "a1" });
    expect((await readFile(archive, "utf8")).trim().split("\n")).toHaveLength(2);
    await utimes(join(dir, "projects", "s1.jsonl"), new Date(), new Date(Date.now() + 5_000));
    await readClaudeEntries(join(dir, "projects"), archive);
    expect((await readFile(archive, "utf8")).trim().split("\n")).toHaveLength(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
