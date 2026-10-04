import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { materializeFixtureHome } from "../web/scripts/fixtureHome";

const root = resolve(import.meta.dir, "..");
const output = join(root, "docs/screenshots");
const chrome = process.env.CHROME_BIN ?? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find(path => Bun.file(path).size > 0);
if (!chrome) throw new Error("Chrome is required. Set CHROME_BIN to a Chrome or Chromium executable.");

await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "yald-captures-"));
const home = await materializeFixtureHome();
const port = await new Promise<number>((resolvePort, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    if (!address || typeof address === "string") return reject(new Error("Could not allocate a scratch port"));
    probe.close(error => error ? reject(error) : resolvePort(address.port));
  });
});
const server = spawn(join(root, "scripts/bun"), ["run", "server/src/index.ts"], {
  cwd: root,
  env: { ...process.env, OCX_HOME: home, CLAUDE_PROJECTS_DIR: join(home, "claude-projects"), YALD_PORT: String(port), YALD_HOST: "127.0.0.1" },
  stdio: "inherit",
});

const routes: Record<string, string> = {
  overview: "/",
  usage: "/usage",
  cost: "/cost",
  performance: "/performance",
  reliability: "/reliability",
  models: "/models",
  quota: "/quota",
  conversations: "/conversations",
};

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`yald server exited with ${server.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error("yald did not become healthy within 15 seconds");
}

async function capture(url: string, path: string, profile: string, size = "1680,1450", minimumBytes = 100_000) {
  const child = spawn(chrome!, [
      "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${size}`,
      "--virtual-time-budget=9000", "--run-all-compositor-stages-before-draw", "--disable-gpu", "--no-first-run",
      "--no-default-browser-check", "--disable-background-networking", "--disable-extensions",
      `--user-data-dir=${profile}`, `--screenshot=${path}`, url,
    ], { stdio: "ignore" });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let lastSize = 0;
  let stablePolls = 0;
  let captured = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const sizeOnDisk = (await stat(path)).size;
      if (sizeOnDisk > minimumBytes && sizeOnDisk === lastSize) stablePolls++;
      else stablePolls = 0;
      lastSize = sizeOnDisk;
      if (stablePolls >= 2) {
        captured = true;
        child.kill("SIGKILL");
        break;
      }
    } catch {
      if (child.exitCode !== null) break;
    }
    await Bun.sleep(500);
  }
  if (!captured && child.exitCode === null) child.kill("SIGKILL");
  const result = await exited;
  if (!captured && result.code !== 0) throw new Error(`Chrome screenshot failed (${result.code ?? result.signal}): ${url}`);
  const bytes = (await stat(path)).size;
  if (bytes < minimumBytes) throw new Error(`Suspiciously small screenshot (${bytes} bytes): ${path}`);
  if (bytes > 500_000) throw new Error(`Screenshot exceeds 500 KB (${bytes} bytes): ${path}`);
  console.log(`${path}: ${bytes} bytes`);
}

async function measureFirstPaint() {
  const profile = await mkdtemp(join(scratch, "performance-chrome-"));
  const child = spawn(chrome!, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--virtual-time-budget=9000", `--user-data-dir=${profile}`, "--dump-dom", `http://127.0.0.1:${port}/?yaldPerf=1`,
  ], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  const exited = new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
  for (let attempt = 0; attempt < 60 && !output.includes("data-yald-perf="); attempt++) await Bun.sleep(500);
  if (!output.includes("data-yald-perf=")) {
    child.kill("SIGKILL");
    await exited;
    throw new Error("Chrome did not report first-paint performance data");
  }
  child.kill("SIGKILL");
  await exited;
  const value = output.match(/data-yald-perf="([^"]+)"/)?.[1];
  if (!value) throw new Error("Could not parse first-paint performance data");
  console.log(`Overview browser performance: ${value}`);
  await rm(profile, { recursive: true, force: true });
  return value;
}

try {
  await waitForServer();
  for (const [name, route] of Object.entries(routes)) {
    const profile = await mkdtemp(join(scratch, `${name}-chrome-`));
    const minimumBytes = name === "conversations" ? 75_000 : 100_000;
    await capture(`http://127.0.0.1:${port}${route}`, join(output, `${name}.png`), profile, "1680,1450", minimumBytes);
    await rm(profile, { recursive: true, force: true });
  }
  const socialProfile = await mkdtemp(join(scratch, "social-chrome-"));
  await capture(`file://${join(root, "docs/social-preview.html")}`, join(root, "docs/social-preview.png"), socialProfile, "1200,630", 5_000);
  await measureFirstPaint();
} finally {
  server.kill("SIGTERM");
  await rm(scratch, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}
