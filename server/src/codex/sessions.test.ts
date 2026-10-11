import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationKey, readCodexSessionIndex } from "./sessions";

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
  expect(index.get(conversationKey(ROOT))).toEqual({ cwd: "/work/app-a", sessionId: ROOT, originator: "codex_cli_rs", startedAt: Date.parse("2026-10-11T01:00:00.000Z") });
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
