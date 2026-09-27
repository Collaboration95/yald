import { execFileSync } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Where opencodex keeps its ledgers. Overridable for tests and multi-home setups. */
export const OCX_HOME = process.env.OCX_HOME ?? join(homedir(), ".opencodex");

export const PORT = Number(process.env.PORT ?? process.env.OCX_OBSERVATORY_PORT ?? 4317);
export const HOSTNAME = process.env.HOST ?? "127.0.0.1";

/** Local timezone used for calendar bucketing; defaults to the machine's zone. */
export const TIME_ZONE = process.env.OCX_OBSERVATORY_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

export const PATHS = {
  usage: join(OCX_HOME, "usage.jsonl"),
  spendLedger: join(OCX_HOME, "spend-ledger.jsonl"),
  quotaCache: join(OCX_HOME, "codex-quota-cache.json"),
  routingHistory: join(OCX_HOME, "routing-history.sqlite"),
  config: join(OCX_HOME, "config.json"),
  serviceState: join(OCX_HOME, "service-state.json"),
  runtimePort: join(OCX_HOME, "runtime-port.json"),
};

function looksLikeOcxPackage(dir: string): boolean {
  return existsSync(join(dir, "src", "usage", "cost.ts"))
    || existsSync(join(dir, "dist", "usage", "cost.js"));
}

function packageDirFromBin(binPath: string): string | null {
  try {
    const real = resolve(dirname(binPath), readlinkSync(binPath));
    // <pkg>/bin/ocx.mjs -> <pkg>
    return dirname(dirname(real));
  } catch {
    return null;
  }
}

let cachedPackageDir: string | null | undefined;

/**
 * Locate the installed @bitkyc08/opencodex package so the dashboard can reuse its
 * pricing engine instead of inventing a second, drifting price table.
 */
export function ocxPackageDir(): string | null {
  if (cachedPackageDir !== undefined) return cachedPackageDir;
  const candidates: string[] = [];
  if (process.env.OCX_PACKAGE_DIR) candidates.push(process.env.OCX_PACKAGE_DIR);

  for (const probe of ["/opt/homebrew/bin/ocx", "/usr/local/bin/ocx", "/usr/bin/ocx"]) {
    if (!existsSync(probe)) continue;
    const dir = packageDirFromBin(probe);
    if (dir) candidates.push(dir);
  }

  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (globalRoot) candidates.push(join(globalRoot, "@bitkyc08", "opencodex"));
  } catch {
    // npm may be missing; the static candidates below still cover common installs.
  }

  candidates.push(
    "/opt/homebrew/lib/node_modules/@bitkyc08/opencodex",
    "/usr/local/lib/node_modules/@bitkyc08/opencodex",
    join(homedir(), ".bun", "install", "global", "node_modules", "@bitkyc08", "opencodex"),
  );

  cachedPackageDir = candidates.find(candidate => looksLikeOcxPackage(candidate)) ?? null;
  return cachedPackageDir;
}
