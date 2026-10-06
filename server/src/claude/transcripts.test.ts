import { expect, test } from "bun:test";
import { normalizeRow } from "../ocx/store";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
