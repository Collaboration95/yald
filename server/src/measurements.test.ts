import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// normalizeRow imports env.ts; isolate that module cache so these pure cases cannot
// freeze another test's fixture paths before its API setup runs.
test("source measurement contracts in an isolated synthetic environment", async () => {
  const home = await mkdtemp(join(tmpdir(), "yald-measurement-test-"));
  try {
    const root = resolve(import.meta.dir, "../..");
    const result = spawnSync(process.execPath, ["test", "./tests/helpers/measurement-cases.ts"], {
      cwd: root,
      env: { ...process.env, OCX_HOME: home, CODEX_HOME: join(home, "codex"), CLAUDE_PROJECTS_DIR: join(home, "claude-projects") },
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain("5 pass");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
