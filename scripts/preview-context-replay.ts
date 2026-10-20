/** Production L07 preview: isolated synthetic homes, pricing and a fixed clock. */
import { rm } from "node:fs/promises";
import { CONTEXT_REPLAY_PARAMS, CONTEXT_REPLAY_TO, materializeContextReplayFixture } from "../web/scripts/context-replay-fixtures";

Date.now = () => CONTEXT_REPLAY_TO + 60_000;
process.env.TZ = "Asia/Singapore";
process.env.YALD_TZ = "Asia/Singapore";
process.env.YALD_HOST = "127.0.0.1";
process.env.YALD_PORT = process.env.YALD_PREVIEW_PORT ?? "5507";
const { home, pricing } = await materializeContextReplayFixture();
process.env.OCX_HOME = home;
process.env.CLAUDE_PROJECTS_DIR = `${home}/claude-projects`;
process.env.CODEX_HOME = `${home}/codex`;
process.env.OCX_PACKAGE_DIR = pricing;
let server: ReturnType<typeof Bun.serve> | undefined;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server?.stop(true);
  await Promise.all([home, pricing].map(path => rm(path, { recursive: true, force: true })));
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try {
  const { default: app } = await import("../server/src/index");
  server = Bun.serve(app);
  console.log(`Context Replay synthetic preview: http://127.0.0.1:${server.port}/labs/context-replay?${CONTEXT_REPLAY_PARAMS}`);
} catch (error) {
  await Promise.all([home, pricing].map(path => rm(path, { recursive: true, force: true })));
  throw error;
}
