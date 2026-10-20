// Test-only preload. Exit rather than throw: production intentionally catches
// missing/unreadable inputs, so a swallowed error would not prove isolation.
import fs from "node:fs";
import fsp from "node:fs/promises";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plugin } from "bun";

const { forbidden, receipt, packageRoot } = JSON.parse(process.env.YALD_TEST_DEMO_GUARD);
const append = fs.appendFileSync.bind(fs);
const read = fs.readFileSync.bind(fs);
const realpath = fs.realpathSync.bind(fs);
const canonical = path => { try { return realpath(path); } catch { return resolve(path); } };
function refuse(message) {
  append(receipt, `${message}\n`);
  console.error(`DEMO ISOLATION GUARD: ${message}`);
  process.exit(99);
}
function check(path) {
  if (typeof path !== "string" && !(path instanceof URL) && !Buffer.isBuffer(path)) return;
  const resolved = canonical(path instanceof URL ? fileURLToPath(path) : String(path)), boundary = canonical(forbidden);
  if (resolved === boundary || resolved.startsWith(`${boundary}/`)) refuse(`forbidden path ${resolved}`);
}
for (const name of ["readFile", "writeFile", "appendFile", "readdir", "stat", "lstat", "open", "realpath", "access", "mkdir"]) {
  const asyncOriginal = fsp[name];
  fsp[name] = function(path, ...args) { check(path); return asyncOriginal.call(this, path, ...args); };
  for (const method of [name, `${name}Sync`]) {
    if (typeof fs[method] !== "function") continue;
    const original = fs[method];
    fs[method] = function(path, ...args) { check(path); return original.call(this, path, ...args); };
  }
}
for (const name of ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork"]) {
  cp[name] = () => refuse(`subprocess ${name}`);
}
for (const name of ["existsSync", "readlinkSync"]) {
  const original = fs[name];
  fs[name] = (path, ...args) => { check(path); return original(path, ...args); };
}
syncBuiltinESMExports();
const file = Bun.file;
Bun.file = function(path, ...args) { check(path); return file.call(this, path, ...args); };
globalThis.fetch = () => refuse("network fetch");
globalThis.__demoIsolationGuard = { check, refuse };
// Bun retains native named builtin exports when their default object changes.
// Wrap the actual imported names too; the negative archive control proves it.
const wrappers = {};
for (const kind of ["fs", "promises", "child"]) {
    const promises = kind === "promises", child = kind === "child";
    const builtin = child ? "child_process" : promises ? "fs/promises" : "fs";
    const names = child ? ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork"]
      : ["readFile", "writeFile", "appendFile", "readdir", "stat", "lstat", "open", "realpath", "access", "mkdir"]
        .flatMap(name => promises ? [name] : [name, `${name}Sync`]).concat(promises ? [] : ["existsSync", "readlinkSync"]);
    const contents = `import original from ${JSON.stringify(builtin)}; export * from ${JSON.stringify(builtin)};
      ${names.map(name => `export const ${name} = (...args) => { globalThis.__demoIsolationGuard.${child ? `refuse('subprocess ${name}')` : "check(args[0])"}; return original.${name}(...args); };`).join("\n")}
      export default { ...original, ${names.join(",")} };`;
    wrappers[kind] = join(dirname(receipt), `guarded-${kind}.mjs`);
    fs.writeFileSync(wrappers[kind], contents);
}
plugin({ name: "demo-module-boundary", setup(build) {
  build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path }) => {
    check(path);
    if (packageRoot && path.startsWith(packageRoot) && /\/(?:web\/scripts|tests)\//.test(path)) refuse(`development import ${path}`);
    append(receipt, `module ${path}\n`);
    const extension = path.split(".").at(-1);
    const contents = read(path, "utf8").replace(/(["'])node:fs\/promises\1/g, JSON.stringify(wrappers.promises))
      .replace(/(["'])node:fs\1/g, JSON.stringify(wrappers.fs)).replace(/(["'])node:child_process\1/g, JSON.stringify(wrappers.child));
    return { contents, loader: ["ts", "tsx", "jsx"].includes(extension) ? extension : "js" };
  });
} });
append(receipt, "guard active\n");
