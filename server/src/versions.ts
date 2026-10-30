import { readFileSync } from "node:fs";
import { join } from "node:path";

function readVersion(file: string): string | null {
  try {
    const value = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

let yald: string | null | undefined;

/** The version of this Yald install, read once from its package.json. */
export function yaldVersion(): string | null {
  yald ??= readVersion(join(import.meta.dir, "..", "..", "package.json"));
  return yald;
}

/** The installed opencodex version, from the package the cost engine was loaded from. */
export function opencodexVersion(packageDir: string | null): string | null {
  return packageDir ? readVersion(join(packageDir, "package.json")) : null;
}
