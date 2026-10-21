// Preloaded by bunfig.toml for every `bun test` run from the repo root. Points the
// data directories at a throwaway home before any server module reads them, so
// tests (and the processes they spawn) never touch the user's real logs or archive.
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "yald-test-home-"));
for (const [name, dir] of [["OCX_HOME", "opencodex"], ["CLAUDE_PROJECTS_DIR", "claude-projects"], ["CODEX_HOME", "codex"]]) {
  process.env[name] = join(home, dir);
  mkdirSync(process.env[name]!);
}

afterAll(() => rmSync(home, { recursive: true, force: true }));
