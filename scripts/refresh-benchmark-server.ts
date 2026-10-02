/** Common bootstrap for both revisions; no benchmark routes enter the app. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.YALD_BENCH_ROOT;
if (!root || !process.env.OCX_HOME) throw new Error("Missing benchmark checkout or isolated home");
const epoch = Number(process.env.YALD_BENCH_EPOCH);
if (!Number.isFinite(epoch)) throw new Error("Invalid benchmark epoch");
Date.now = () => epoch;
const { default: app } = await import(pathToFileURL(resolve(root, "server/src/index.ts")).href);
const server = Bun.serve(app);
console.log("YALD_BENCH_READY " + JSON.stringify({ port: server.port, pid: process.pid }));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => { server.stop(true); process.exit(0); });
}
