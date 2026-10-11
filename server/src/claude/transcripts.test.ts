import { expect, test } from "bun:test";
import { normalizeRow } from "../ocx/store";
import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectEntries, readClaudeEntries } from "./transcripts";

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
  await writeFile(archive, [old, { ...old, requestId: "req_gone" }].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const line = JSON.parse(block("text"));
  line.cwd = "/work/app-a";
  await writeFile(join(dir, "sess-1.jsonl"), JSON.stringify(line) + "\n");

  const { entries } = await readClaudeEntries(dir, archive);
  const rows = Object.fromEntries(entries.map(entry => [String(entry.requestId), normalizeRow(entry)]));
  expect(rows.req_1!.cwd).toBe("/work/app-a");
  expect(rows.req_gone!.cwd).toBeNull();
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
