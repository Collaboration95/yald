import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDemo } from "./demo/generate.mjs";

export const DEMO_HELP = [
  "Usage: yald demo [--open] [--port PORT] [--now ISO]",
  "",
  "Explore Yaldi and all three Labs investigations with isolated synthetic data.",
  "Prices are illustrative examples, not live rates. Quota is synthetic too.",
  "  --open       Open the browser after this demo's server is ready",
  "  --port PORT  Loopback port (default 4318)",
  "  --now ISO    Fixed sample/API/UI clock for screenshots, e.g. 2026-10-20T12:00:00Z",
  "               Default: current wall clock, with fresh samples on every launch",
  "  --help       Show this help without creating data",
  "",
  "Press Ctrl-C to stop the server and remove its temporary demo data.",
].join("\n");

export function parseDemoArgs(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  const options = { port: 4318, open: false, now: null };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--port", "--now", "--open"].includes(flag)) throw new Error(`Unknown demo argument: ${flag}. Use yald demo --help.`);
    if (seen.has(flag)) throw new Error(`Duplicate demo argument: ${flag}`);
    seen.add(flag);
    if (flag === "--open") { options.open = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--port") {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error("--port must be an integer from 1 to 65535");
      options.port = Number(value);
    } else {
      // Require an offset: screenshots cannot depend on the caller's local zone.
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
        || !Number.isFinite(Date.parse(value))) throw new Error("--now requires an ISO timestamp with Z or a UTC offset");
      options.now = Date.parse(value);
    }
  }
  return options;
}

export function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve, reject) => {
    const browser = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => { browser.kill(); reject(new Error("browser opener timed out")); }, 5000);
    browser.once("error", cause => { clearTimeout(timer); reject(cause); });
    browser.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(`browser opener exited ${code}`));
    });
  });
}

/** Inject opener/spawn only through code, so tests never launch an OS browser. */
export async function runDemo(options, { runtime, root, openUrl = openBrowser, spawnServer = spawn,
  signals = process, log = console.log, error = console.error, startupMs = 30_000, shutdownMs = 5_000 } = {}) {
  let directory, child, closed, closeResult, startupTimer, killTimer, interrupted = false, failed = false;
  const token = randomBytes(24).toString("hex");
  const stop = () => {
    if (!child || closeResult) return;
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), shutdownMs);
  };
  const interrupt = () => { interrupted = true; stop(); };
  signals.on("SIGINT", interrupt);
  signals.on("SIGTERM", interrupt);
  const work = async () => { try {
    directory = await mkdtemp(join(tmpdir(), "yald-demo-"));
    const sampleAt = options.now ?? Date.now();
    const inputs = await generateDemo(directory, sampleAt);
    if (interrupted) return 130;
    log(`Demo / synthetic data · illustrative prices, not live rates\nDemo data: ${directory}`);
    // Deliberately do not spread process.env. No credentials, runtime injection,
    // caller .env/config, real homes, global pricing, proxy or port fallback.
    const env = { ...inputs, TZ: "UTC", YALD_TZ: "UTC", YALD_HOST: "127.0.0.1", YALD_PORT: String(options.port),
      YALD_DEMO: "1", YALD_DEMO_TOKEN: token, YALD_DEMO_SAMPLE_AT: String(sampleAt),
      ...(options.now !== null ? { YALD_DEMO_NOW: String(options.now) } : {}),
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) };
    child = spawnServer(runtime, ["run", "--no-env-file", "--no-install", join(root, "server/src/demo/server.ts")], {
      cwd: directory, env, stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    closed = new Promise(resolve => {
      child.once("close", (code, signal) => { closeResult = { code, signal }; resolve(closeResult); });
    });
    let ready = false;
    child.on("error", cause => { failed = true; error(`Could not start demo: ${cause.message}`); stop(); });
    const onMessage = message => {
      if (ready || interrupted || failed || closeResult || message?.type !== "yald-demo-ready"
        || message.token !== token || message.port !== options.port) return;
      ready = true;
      clearTimeout(startupTimer);
      const url = `http://127.0.0.1:${options.port}`;
      log(`Demo ready: ${url}\nPress Ctrl-C to stop and remove demo data.`);
      if (options.open) {
        Promise.resolve().then(() => interrupted || closeResult ? undefined : openUrl(url)).catch(cause => {
          error(`Could not open demo browser: ${cause.message}. Open ${url} manually.`);
        });
      }
    };
    child.on("message", onMessage);
    startupTimer = setTimeout(() => {
      failed = true; error("Demo startup timed out; stopping its server."); stop();
    }, startupMs);
    if (interrupted) stop();
    const result = await closed;
    child.off("message", onMessage);
    if (interrupted) return 130;
    if (!ready || failed || result.code !== 0) {
      error(`Demo stopped${ready ? "" : " before ready"} (${result.signal ?? result.code ?? "spawn error"}). Check that port ${options.port} is free.`);
      return 1;
    }
    return 0;
  } catch (cause) {
    failed = true;
    error(`Could not run demo: ${cause.message}`);
    stop();
    if (closed) await closed;
    return interrupted ? 130 : 1;
  } };
  let result;
  try { result = await work(); } finally {
    clearTimeout(startupTimer);
    clearTimeout(killTimer);
    signals.off("SIGINT", interrupt);
    signals.off("SIGTERM", interrupt);
    // No cleanup while the server can still read/write the archive.
    if (child && !closeResult) { stop(); if (closed) await closed; clearTimeout(killTimer); }
    if (directory) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (cause) { error(`Could not remove demo data at ${directory}: ${cause.message}`); result = 1; }
    }
  }
  return result;
}
