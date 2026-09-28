#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
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

const args = process.argv.slice(2);
let open = false;
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: yald [--port PORT] [--host HOST] [--ocx-home PATH] [--open]");
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === "--open") {
    open = true;
    args.splice(i--, 1);
    continue;
  }
  const envFlags = { "--port": "YALD_PORT", "--host": "YALD_HOST", "--ocx-home": "OCX_HOME" };
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
