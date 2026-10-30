import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { mergeRolloutQuota, parseRateLimits, readRolloutQuotaSamples, ROLLOUT_ACCOUNT } from "./quota";
import { conversationKey, parseSessionMeta, readCodexSessionIndex } from "./sessions";

const ROOT = "019a1111-0000-7000-8000-000000000001";
const SUBAGENT = "019a1111-0000-7000-8000-000000000002";

function meta(payload: Record<string, unknown>, padding = 0): string {
  const timestamp = "2026-10-11T01:00:00.000Z";
  return JSON.stringify({ timestamp, type: "session_meta", payload: { timestamp, originator: "codex_cli_rs", ...payload, base_instructions: { text: "x".repeat(padding) } } }) + "\n";
}

async function codexHome() {
  const home = await mkdtemp(join(tmpdir(), "yald-codex-"));
  const day = join(home, "sessions", "2026", "10", "11");
  await mkdir(day, { recursive: true });
  await mkdir(join(home, "archived_sessions"));
  return { home, day };
}

test("opencodex conversation ids are the first 32 hex chars of sha256(session id)", () => {
  expect(conversationKey(ROOT)).toBe(createHash("sha256").update(ROOT).digest("hex").slice(0, 32));
  expect(conversationKey(ROOT)).toMatch(/^[0-9a-f]{32}$/);
});

test("indexes live and archived rollouts by hashed session id from the first line only", async () => {
  const { home, day } = await codexHome();
  // The rest of the file is never parsed: a torn second line must not matter.
  await writeFile(join(day, `rollout-a-${ROOT}.jsonl`), meta({ id: ROOT, session_id: ROOT, cwd: "/work/app-a" }) + '{"torn');
  await writeFile(join(day, `rollout-b-${SUBAGENT}.jsonl`), meta({ id: SUBAGENT, session_id: ROOT, cwd: "/work/app-a/server", source: { subagent: "review" } }));
  await writeFile(join(home, "archived_sessions", "rollout-old.jsonl"), meta({ id: "archived", cwd: "/tmp/app-a-1", originator: "codex_sdk_ts" }));
  // Legacy first lines without a cwd, blank files and non-rollout files are skipped.
  await writeFile(join(day, "rollout-legacy.jsonl"), JSON.stringify({ id: "legacy", timestamp: "2025-01-01T00:00:00Z", instructions: "" }) + "\n");
  await writeFile(join(day, "rollout-empty.jsonl"), "");
  await writeFile(join(day, "history.jsonl"), meta({ id: "not-a-rollout", cwd: "/nope" }));

  const index = await readCodexSessionIndex(home);
  expect(index.size).toBe(3);
  expect(index.get(conversationKey(ROOT))).toEqual({ cwd: "/work/app-a", sessionId: ROOT, originator: "codex_cli_rs", startedAt: Date.parse("2026-10-11T01:00:00.000Z"), git: null, subagent: null });
  // The subagent's own id is indexed; traffic under the root id keeps the root's folder.
  expect(index.get(conversationKey(SUBAGENT))?.cwd).toBe("/work/app-a/server");
  expect(index.get(conversationKey("archived"))).toMatchObject({ cwd: "/tmp/app-a-1", originator: "codex_sdk_ts" });
  await rm(home, { recursive: true });
});

test("a surviving subagent rollout attributes the root id when the root rollout is gone", async () => {
  const { home, day } = await codexHome();
  await writeFile(join(day, "rollout-sub.jsonl"), meta({ id: SUBAGENT, session_id: ROOT, cwd: "/work/app-a" }));
  const index = await readCodexSessionIndex(home);
  expect(index.get(conversationKey(ROOT))).toMatchObject({ cwd: "/work/app-a", sessionId: ROOT });
  await rm(home, { recursive: true });
});

test("first lines longer than the 64 KB read cap still yield the id and cwd", async () => {
  const { home, day } = await codexHome();
  await writeFile(join(day, "rollout-huge.jsonl"), meta({ session_id: ROOT, id: ROOT, cwd: "/work/\"quoted\"" }, 100_000));
  const index = await readCodexSessionIndex(home);
  expect(index.get(conversationKey(ROOT))?.cwd).toBe("/work/\"quoted\"");
  await rm(home, { recursive: true });
});

test("refreshes reuse unchanged files and return the same index until a session changes", async () => {
  const { home, day } = await codexHome();
  const rollout = join(day, `rollout-a-${ROOT}.jsonl`);
  await writeFile(rollout, meta({ id: ROOT, cwd: "/work/app-a" }));
  const first = await readCodexSessionIndex(home);
  expect(await readCodexSessionIndex(home)).toBe(first);
  // A live session appends events; its first line, and so the index, is unchanged.
  await appendFile(rollout, JSON.stringify({ type: "event_msg" }) + "\n");
  expect(await readCodexSessionIndex(home)).toBe(first);

  await writeFile(join(day, "rollout-b.jsonl"), meta({ id: SUBAGENT, cwd: "/work/app-b" }));
  const added = await readCodexSessionIndex(home);
  expect(added).not.toBe(first);
  expect(added.size).toBe(2);
  await rm(rollout);
  const removed = await readCodexSessionIndex(home);
  expect([...removed.values()].map(session => session.cwd)).toEqual(["/work/app-b"]);
  await rm(home, { recursive: true });
});

test("a missing Codex home is an empty index, not an error", async () => {
  expect((await readCodexSessionIndex(join(tmpdir(), "yald-no-codex-here"))).size).toBe(0);
});

test("same-size cwd rewrites within one millisecond refresh the session index", async () => {
  const { home, day } = await codexHome();
  const rollout = join(day, "rollout-rewrite.jsonl");
  await writeFile(rollout, meta({ id: ROOT, cwd: "/work/app-a" }));
  await utimes(rollout, 1_790_000_000.0001, 1_790_000_000.0001);
  const first = await readCodexSessionIndex(home);
  await writeFile(rollout, meta({ id: ROOT, cwd: "/work/app-b" }));
  await utimes(rollout, 1_790_000_000.0002, 1_790_000_000.0002);
  const changed = await readCodexSessionIndex(home);
  expect(changed.get(conversationKey(ROOT))?.cwd).toBe("/work/app-b");
  expect(changed).not.toBe(first);
  expect(first.get(conversationKey(ROOT))?.cwd).toBe("/work/app-a");
  await rm(home, { recursive: true });
});

test("capped metadata accepts JSON whitespace around fields", async () => {
  const { home, day } = await codexHome();
  await writeFile(join(day, "rollout-spaced.jsonl"), meta({ id: ROOT, cwd: "/work/app-a" }, 100_000).replace(/":/g, '": '));
  expect((await readCodexSessionIndex(home)).get(conversationKey(ROOT))?.cwd).toBe("/work/app-a");
  await rm(home, { recursive: true });
});

test("compressed rollouts attribute like plain ones, and a bad frame is a miss, not an error", async () => {
  const { home, day } = await codexHome();
  const compressed = zstdCompressSync(Buffer.from(meta({ id: ROOT, cwd: "/work/compressed" }, 5_000) + "{}\n".repeat(1000)));
  await writeFile(join(day, "rollout-a.jsonl.zst"), compressed);
  await writeFile(join(day, "rollout-b.jsonl.zst"), "not a zstd frame");
  await writeFile(join(day, "rollout-c.jsonl.zst"), "");
  const index = await readCodexSessionIndex(home);
  expect(index.size).toBe(1);
  expect(index.get(conversationKey(ROOT))?.cwd).toBe("/work/compressed");
  expect(await readCodexSessionIndex(home)).toBe(index);
  await rm(home, { recursive: true, force: true });
});

test("a compressed first line past 64 KB keeps the fields before the cap", async () => {
  const { home, day } = await codexHome();
  const line = JSON.stringify({ type: "session_meta", payload: { id: ROOT, cwd: "/work/long", timestamp: "2026-10-11T01:00:00.000Z", instructions: "x".repeat(200_000) } }) + "\n";
  await writeFile(join(day, "rollout-long.jsonl.zst"), zstdCompressSync(Buffer.from(line)));
  expect((await readCodexSessionIndex(home)).get(conversationKey(ROOT))?.cwd).toBe("/work/long");
  await rm(home, { recursive: true, force: true });
});

test("branch and spawn metadata are kept, and the repository URL never is", () => {
  const line = meta({ id: SUBAGENT, cwd: "/w", git: { branch: "feat/x", commit_hash: "abc", repository_url: "https://token@example.invalid/r" },
    source: { subagent: { thread_spawn: { parent_thread_id: ROOT, depth: 2, agent_role: "worker" } } } }).trim();
  const parsed = parseSessionMeta(line)!;
  expect(parsed.git).toEqual({ branch: "feat/x", commitHash: "abc" });
  expect(parsed.subagent).toEqual({ parentThreadId: ROOT, depth: 2, agentRole: "worker" });
  expect(JSON.stringify(parsed)).not.toContain("token@");
  const plain = parseSessionMeta(meta({ id: ROOT, cwd: "/w" }).trim())!;
  expect(plain).toMatchObject({ git: null, subagent: null });
  const truncated = parseSessionMeta(line.slice(0, line.length - 30).replace(/}+$/, ""))!;
  expect(truncated.git?.branch).toBe("feat/x");
  expect(truncated.subagent?.depth).toBe(2);
});

const limits = (at: string, used: number, resets = 1_792_000_000, window = 10_080) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1 } },
  rate_limits: { primary: { used_percent: used, window_minutes: window, resets_at: resets }, secondary: { used_percent: 3, window_minutes: 300, resets_at: resets - 100 }, credits: { balance: "1" } } } }) + "\n";

test("rate limits parse per slot, and other lines give nothing", () => {
  const samples = parseRateLimits(limits("2026-10-11T01:00:00.000Z", 40).trim());
  expect(samples.map(sample => [sample.window, sample.usedPercent, sample.resetAtMs])).toEqual([["weekly", 40, 1_792_000_000_000], ["fiveHour", 3, 1_791_999_900_000]]);
  expect(samples[0]).toMatchObject({ account: ROLLOUT_ACCOUNT, source: "rollout" });
  expect(parseRateLimits('{"type":"token_count"}')).toEqual([]);
  expect(parseRateLimits("torn \"token_count\" \"rate_limits\"")).toEqual([]);
});

test("rollout quota comes from plain and compressed files, deduplicated, re-reading only what was appended", async () => {
  const { home, day } = await codexHome();
  const plain = join(day, "rollout-plain.jsonl");
  await writeFile(plain, meta({ id: ROOT, cwd: "/w" }) + limits("2026-10-11T01:00:00.000Z", 40));
  await writeFile(join(day, "rollout-zip.jsonl.zst"), zstdCompressSync(Buffer.from(limits("2026-10-11T01:00:00.000Z", 40) + limits("2026-10-11T02:00:00.000Z", 44))));
  await writeFile(join(day, "rollout-bad.jsonl.zst"), "not a frame");
  const first = await readRolloutQuotaSamples(home);
  expect(first.filter(sample => sample.window === "weekly").map(sample => sample.usedPercent)).toEqual([40, 44]);
  expect(await readRolloutQuotaSamples(home)).toBe(first);
  await appendFile(plain, limits("2026-10-11T03:00:00.000Z", 50));
  const second = await readRolloutQuotaSamples(home);
  expect(second.filter(sample => sample.window === "weekly").map(sample => sample.usedPercent)).toEqual([40, 44, 50]);
  expect((await readFile(plain, "utf8")).length).toBeGreaterThan(0);
  await rm(home, { recursive: true, force: true });
});

test("merging adds rollout samples without replacing a window opencodex reports", () => {
  const quota = { windows: [{ account: "a", window: "weekly", usedPercent: 10, resetAtMs: null, updatedAt: 5 }], samples: [], updatedAt: 5 };
  const samples = parseRateLimits(limits("2026-10-11T01:00:00.000Z", 40).trim());
  const merged = mergeRolloutQuota(quota, samples);
  expect(merged.windows.map(window => [window.account, window.window])).toEqual([["a", "weekly"], [ROLLOUT_ACCOUNT, "fiveHour"]]);
  expect(merged.samples).toHaveLength(2);
  expect(mergeRolloutQuota(quota, [])).toBe(quota);
});
