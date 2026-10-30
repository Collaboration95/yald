import { expect, test } from "bun:test";
import { normalizeRow } from "../ocx/store";
import { appendFile, copyFile, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionTitles, collectEntries, readClaudeEntries } from "./transcripts";

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

test("recorded session titles stay in memory: ranked, capped, and never in the archive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yald-titles-"));
  try {
    const archive = join(dir, "archive.jsonl");
    const usageLine = JSON.stringify({ type: "assistant", requestId: "req_title", sessionId: "s-title", timestamp: "2026-10-04T16:44:49.068Z", message: { model: "claude-opus-5-5", usage } });
    await writeFile(join(dir, "s-title.jsonl"), [
      JSON.stringify({ type: "summary", summary: "SECRET summary title", leafUuid: "u" }),
      JSON.stringify({ type: "ai-title", aiTitle: "SECRET generated title", sessionId: "s-title" }),
      JSON.stringify({ type: "user", sessionId: "s-title", message: { content: "ai-title is only a word in this prompt" } }),
      usageLine, "",
    ].join("\n"));
    await writeFile(join(dir, "s-long.jsonl"), JSON.stringify({ type: "custom-title", customTitle: `SECRET ${"x".repeat(200)}`, sessionId: "s-long" }) + "\n");
    await writeFile(join(dir, "s-summary.jsonl"), JSON.stringify({ type: "summary", summary: "SECRET from the file name" }) + "\n");
    await readClaudeEntries(dir, archive);
    const titles = claudeSessionTitles();
    expect(titles.get("s-title")).toBe("SECRET generated title");
    expect(titles.get("s-summary")).toBe("SECRET from the file name");
    expect(titles.get("s-long")!.length).toBe(120);

    await appendFile(join(dir, "s-title.jsonl"), JSON.stringify({ type: "custom-title", customTitle: "SECRET chosen title", sessionId: "s-title" }) + "\n");
    await readClaudeEntries(dir, archive);
    expect(claudeSessionTitles().get("s-title")).toBe("SECRET chosen title");
    expect(await readFile(archive, "utf8")).not.toContain("SECRET");

    await rm(join(dir, "s-title.jsonl"));
    await readClaudeEntries(dir, archive);
    expect(claudeSessionTitles().has("s-title")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
