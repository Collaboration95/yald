#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

function bunRuntime() {
  const require = createRequire(import.meta.url);
  const candidates = [
    join(root, "node_modules/bun/bin/bun.exe"),
    join(root, "node_modules/bun/bin/bun"),
    join(dirname(require.resolve("bun/package.json")), "bin/bun.exe"),
    join(dirname(require.resolve("bun/package.json")), "bin/bun"),
  ];
  const runtime = candidates.find(path => existsSync(path));
  if (!runtime) {
    console.error("yald could not locate its Bun runtime. Reinstall yald with npm.");
    process.exit(1);
  }
  return runtime;
}

// `yald report …` writes a report and exits; it never starts the server. Bun runs from
// the package folder (so a .env or bunfig.toml in the caller's folder is not picked up)
// and the report CLI changes back to the caller's folder (YALD_CWD) for relative paths.
if (args[0] === "demo") {
  const { DEMO_HELP, parseDemoArgs, runDemo } = await import("./demo.mjs");
  try {
    const options = parseDemoArgs(args.slice(1));
    if (options.help) console.log(DEMO_HELP);
    else process.exitCode = await runDemo(options, { runtime: bunRuntime(), root });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
} else if (args[0] === "report") {
  const child = spawn(bunRuntime(), ["run", join(root, "server/src/report/cli.ts"), ...args.slice(1)], {
    cwd: root,
    env: { ...process.env, YALD_CWD: process.cwd() },
    stdio: "inherit",
  });
  child.on("error", error => {
    console.error(`Could not run yald report: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} else {
  serve();
}

function serve() {
  if (args.includes("--version") || args.includes("-v")) {
    console.log(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
    process.exit(0);
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log([
      "Yald — local, read-only analytics for opencodex and Claude Code usage.",
      "Yaldi is Yald's detective companion in optional Labs investigations.",
      "",
      "Usage: yald [--port PORT] [--host HOST] [--ocx-home PATH] [--codex-home PATH] [--open] [--version]",
      "       yald report [window] [options]",
      "       yald demo [--open] [--port PORT] [--now ISO]",
      "",
      "Commands:",
      "  (none)    Run the dashboard at http://127.0.0.1:4318",
      "  report    Write a standalone HTML report for a time window, without a server (yald report --help)",
      "  demo      Explore isolated synthetic data and illustrative prices (yald demo --help)",
    ].join("\n"));
    process.exit(0);
  }
  const runtime = bunRuntime();

  let open = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--open") {
      open = true;
      args.splice(i--, 1);
      continue;
    }
    const envFlags = { "--port": "YALD_PORT", "--host": "YALD_HOST", "--ocx-home": "OCX_HOME", "--codex-home": "CODEX_HOME" };
    if (envFlags[flag]) {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        console.error(`${flag} requires a value`);
        process.exit(2);
      }
      process.env[envFlags[flag]] = value;
      args.splice(i, 2);
      i--;
    }
  }

  const port = process.env.YALD_PORT ?? "4318";
  const hostname = process.env.YALD_HOST ?? "127.0.0.1";
  const url = `http://${hostname}:${port}`;

  const child = spawn(runtime, ["run", join(root, "server/src/index.ts"), ...args], {
    cwd: root,
    env: { ...process.env, YALD_PORT: port },
    stdio: "inherit",
  });
  child.on("error", error => {
    console.error(`Could not start yald: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  if (open) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const openArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const openWhenReady = async () => {
      for (let attempt = 0; attempt < 60 && child.exitCode === null; attempt++) {
        try {
          if ((await fetch(`${url}/api/health`)).ok) {
            const browser = spawn(command, openArgs, { detached: true, stdio: "ignore" });
            browser.unref();
            return;
          }
        } catch {
          // Wait until the listener is ready.
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    };
    void openWhenReady();
  }
}
