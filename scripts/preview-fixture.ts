/** Serve the production build against an isolated, frozen synthetic ledger. */
import { rm } from "node:fs/promises";
import { materializeFixtureHome, materializeFixturePricing } from "../web/scripts/fixtureHome";

Date.now = () => Date.parse("2026-10-02T10:00:00Z");
process.env.TZ = "Asia/Singapore";
process.env.YALD_TZ = "Asia/Singapore";
process.env.YALD_HOST = "127.0.0.1";
process.env.YALD_PORT = process.env.YALD_PREVIEW_PORT ?? "5329";
const fixtureHome = await materializeFixtureHome({ dashboardScope: process.argv.includes("--scope"), reportDay: process.argv.includes("--scope") });
const fixturePricing = await materializeFixturePricing();
process.env.OCX_HOME = fixtureHome;
process.env.CLAUDE_PROJECTS_DIR = `${fixtureHome}/claude-projects`;
process.env.CODEX_HOME = `${fixtureHome}/codex`;
process.env.OCX_PACKAGE_DIR = fixturePricing;

let server: ReturnType<typeof Bun.serve> | undefined;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server?.stop(true);
  await Promise.all([fixtureHome, fixturePricing].map(path => rm(path, { recursive: true, force: true })));
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try {
  const { default: app } = await import("../server/src/index");
  server = Bun.serve(app);
  console.log(`Relay production preview: http://127.0.0.1:${server.port} (synthetic data)`);
} catch (error) {
  await Promise.all([fixtureHome, fixturePricing].map(path => rm(path, { recursive: true, force: true })));
  throw error;
}
