#!/usr/bin/env node
// Artifact bookkeeping around the existing checks, not a second test harness.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, platform, release, tmpdir, version } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [command, directoryArg, receiptArg] = process.argv.slice(2);
const sha = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${program} ${args.join(" ")}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout == null ? "" : options.encoding === null ? result.stdout : result.stdout.trim();
}
const json = async path => JSON.parse(await readFile(path, "utf8"));
const save = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + "\n");
function source() {
  assert.equal(run("git", ["status", "--porcelain", "--untracked-files=all"]), "", "Qualification requires a clean committed source tree");
  const commit = run("git", ["rev-parse", "HEAD"]);
  // Pretty-format %P hides parents at a shallow boundary, including CI's
  // default checkout. Raw commit headers retain the actual ordered parents.
  const headers = run("git", ["cat-file", "commit", "HEAD"]).split("\n\n", 1)[0];
  const parents = headers.split("\n").filter(line => line.startsWith("parent ")).map(line => line.slice(7));
  return { commit, tree: run("git", ["rev-parse", "HEAD^{tree}"]), parents };
}
function runtime(bun) {
  return { platform: platform(), arch: arch(), osRelease: release(), osVersion: version(), node: process.version,
    npm: run("npm", ["--version"]), bun: run(bun, ["--version"]), runnerOS: process.env.RUNNER_OS ?? null,
    runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null };
}
function execution() {
  return { kind: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "local",
    repository: process.env.GITHUB_REPOSITORY ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null, workflow: process.env.GITHUB_WORKFLOW ?? null,
    ref: process.env.GITHUB_REF ?? null, event: process.env.GITHUB_EVENT_NAME ?? null,
    job: process.env.GITHUB_JOB ?? null };
}
function outside(path) {
  const fromRoot = relative(root, path);
  assert.ok(fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot), `Use a directory outside the checkout: ${path}`);
  return path;
}
async function fresh(path) {
  outside(path);
  await mkdir(path, { recursive: true });
  assert.deepEqual(await readdir(path), [], `Refusing to reuse or overwrite an artifact/receipt directory: ${path}`);
}
async function inventory(tarball) {
  // Inspect raw ustar headers: BSD tar renders even a regular-file header
  // ending in '/' as a directory. A textual type listing loses that distinction.
  // npm's candidate uses plain ustar. Reject extensions (including PAX/GNU
  // overrides) rather than risk validating a different path/type than tar uses.
  const archive = gunzipSync(await readFile(tarball)), members = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").split("\0", 1)[0];
    assert.equal(header.toString("utf8", 257, 265), "ustar\0" + "00", "Unsupported tar header format");
    const prefix = field(345, 155), name = (prefix ? `${prefix}/` : "") + field(0, 100);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    assert.ok(type === "0" || type === "5", `Unsupported tar entry type ${type}: ${name}`);
    assert.equal(field(157, 100), "", `Unexpected tar link target: ${name}`);
    const sizeField = header.toString("utf8", 124, 136);
    assert.match(sizeField, /^ *[0-7]+[ \0]*$/, `Unsupported tar size: ${name}`);
    const size = parseInt(sizeField, 8), directory = type === "5";
    assert.ok(Number.isSafeInteger(size) && size >= 0 && (!directory || size === 0), `Invalid tar size: ${name}`);
    offset += 512 + Math.ceil(size / 512) * 512;
    assert.ok(offset <= archive.length, `Truncated tar entry: ${name}`);
    members.push({ name, directory });
  }
  assert.ok(archive.length % 512 === 0 && archive.length - offset >= 1024 && archive.subarray(offset).every(byte => byte === 0), "Invalid tar end marker or hidden entries");
  const entries = new Map(), filesToRead = [];
  for (const { name, directory } of members) {
    // Conservative portable names reject control characters and ambiguous
    // spellings. Only actual directories may end in '/'.
    const path = directory ? name.replace(/\/$/, "") : name;
    assert.ok(/^package(?:\/[A-Za-z0-9_@+.-]+)*$/.test(path) && !path.split("/").some(p => p === ".." || p === ".") &&
      (directory || path !== "package"), `Unsafe tar entry: ${name}`);
    // Include directory/file aliases and case collisions on macOS, not just
    // byte-identical names, and reject files used as ancestor directories.
    const key = path.toLowerCase();
    assert.ok(!entries.has(key), `Duplicate/conflicting tar entry: ${name}`);
    entries.set(key, directory);
    if (!directory) filesToRead.push(name);
  }
  for (const path of entries.keys()) {
    for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) {
      assert.notEqual(entries.get(parent), false, `Conflicting tar ancestor: ${path}`);
    }
  }
  // Let the platform tar validate checksums and agree on every effective name
  // before extraction. Directory suffix presentation varies between tar tools.
  const names = run("tar", ["-tzf", tarball], { encoding: null, env: { ...process.env, LC_ALL: "C" } }).toString("utf8").split("\n");
  assert.equal(names.pop(), "", "Incomplete tar listing");
  assert.deepEqual(names.map(name => name.replace(/\/$/, "")), members.map(({ name }) => name.replace(/\/$/, "")), "Ambiguous tar inventory");
  const unpack = await mkdtemp(join(tmpdir(), "yald-tar-inventory-"));
  try {
    run("tar", ["-xzf", tarball, "-C", unpack]);
    const files = [];
    for (const name of filesToRead.sort()) {
      const path = join(unpack, name), info = await lstat(path);
      assert.ok(info.isFile() && !info.isSymbolicLink(), `Expected regular file: ${name}`);
      files.push({ path: name.slice(8), bytes: info.size, sha256: sha(await readFile(path)) });
    }
    return { files, package: await json(join(unpack, "package/package.json")) };
  } finally { await rm(unpack, { recursive: true, force: true }); }
}
async function audit(files, pkg, tarball) {
  const paths = new Set(files.map(file => file.path));
  for (const required of ["package.json", "scripts/yald.mjs", "scripts/demo.mjs", "scripts/demo/generate.mjs", "scripts/demo/pricing.mjs",
    "server/src/index.ts", "server/src/demo/server.ts", "server/src/report/cli.ts", "server/src/report/report.css", "web/dist/index.html",
    "README.md", "LICENSE", "CONTRIBUTORS.md", "docs/install.md", "docs/guide.md", "docs/metrics.md", "docs/api.md", "docs/architecture.md",
    "docs/demo.md", "docs/labs-evidence.md", "docs/labs-context.md", "docs/releasing.md", "docs/release-evidence.md", "docs/screenshots/overview.png"]) {
    assert.ok(paths.has(required), `Missing package resource: ${required}`);
  }
  const brand = await json(join(root, "docs/brand/yaldi/manifest.json"));
  for (const asset of brand.assets.filter(asset => asset.shipped)) {
    assert.ok(paths.has(asset.file.replace("web/public/", "web/dist/")), `Missing shipped brand asset: ${asset.file}`);
  }
  let links = 0;
  for (const file of files) {
    assert.ok(file.path === "package.json" || file.path === "README.md" || pkg.files.some(entry => file.path === entry || file.path.startsWith(`${entry}/`)), `Undeclared file: ${file.path}`);
    assert.ok(!/(^|\/)(?:tests?|__fixtures__|__snapshots__|output|coverage|node_modules|\.env|\.yald)(\/|$)|\.test\.|\.snap$|\.jsonl$|\.log$|\.map$|^server\/src\/report\/sample\.ts$|^docs\/brand\//.test(file.path), `Development/private file shipped: ${file.path}`);
    // Non-built resources must equal the source being qualified. Never compare
    // platform build output to the producer's installed web bundle.
    if (!file.path.startsWith("web/dist/")) assert.equal(sha(await readFile(join(root, file.path))), file.sha256, `Source resource differs: ${file.path}`);
    const bytes = run("tar", ["-xOzf", tarball, `package/${file.path}`], { encoding: null });
    if (/\.(?:md|mjs|js|ts|css|html|json|svg)$/.test(file.path)) {
      const content = bytes.toString("utf8");
      assert.ok(!/\/(?:Users|home)\/[\w.-]+\//.test(content), `Machine-local home path shipped: ${file.path}`);
      if (file.path.endsWith(".md")) {
        for (const match of content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
          const target = match[1].replace(/^<|>$/g, "");
          if (/^(?:[a-z]+:|#|\/\/)/i.test(target)) continue;
          const path = decodeURIComponent(target.split("#")[0]);
          const resolved = relative(root, resolve(root, dirname(file.path), path)).split(sep).join("/");
          assert.ok(paths.has(resolved), `Broken installed Markdown link: ${file.path} -> ${target}`);
          links++;
        }
      }
    }
  }
  assert.ok(files.some(file => /^web\/dist\/assets\/.+\.js$/.test(file.path)) && files.some(file => /^web\/dist\/assets\/.+\.css$/.test(file.path)), "Built JS/CSS required");
  return { files: files.length, installedRelativeLinks: links, requiredResources: true, excludedDevelopmentAndPrivateFiles: true, machineLocalPaths: false };
}
async function compareInstalled(installed, files) {
  const actual = [];
  async function walk(path, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!prefix && entry.name === "node_modules") continue;
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), `${name}/`);
      else {
        assert.ok(entry.isFile() && !entry.isSymbolicLink(), `Unexpected installed entry: ${name}`);
        const bytes = await readFile(join(path, entry.name));
        actual.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  await walk(installed);
  assert.deepEqual(actual.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), files, "Installed package differs from the actual tarball inventory");
}

async function produce(directory) {
  const identity = source();
  await fresh(directory);
  run(join(root, "scripts/bun"), ["run", "build"], { stdio: "inherit" });
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory]));
  assert.equal(packed.length, 1, "Exactly one package must be packed");
  await save(join(directory, "npm-pack.json"), packed);
  const pack = packed[0], tarball = join(directory, pack.filename), bytes = await readFile(tarball);
  const unpacked = await inventory(tarball);
  assert.deepEqual(unpacked.files.map(file => file.path), pack.files.map(file => file.path).sort(), "npm pack file list differs from tar");
  assert.equal(pack.size, bytes.length);
  assert.equal(pack.integrity, `sha512-${sha(bytes, "sha512", "base64")}`);
  assert.equal(pack.shasum, sha(bytes, "sha1"));
  const checks = await audit(unpacked.files, unpacked.package, tarball);
  assert.deepEqual(source(), identity, "Source changed during production");
  const context = execution();
  const artifactName = context.kind === "github-actions" ? `yald-candidate-${context.runId}-${context.runAttempt}` : `yald-candidate-local-${basename(directory)}`;
  const manifest = { schemaVersion: 1, artifactName, source: identity,
    package: { name: unpacked.package.name, version: unpacked.package.version, filename: pack.filename, bytes: bytes.length,
      sha256: sha(bytes), integrity: pack.integrity, declaredNode: unpacked.package.engines.node, declaredBun: unpacked.package.dependencies.bun },
    files: unpacked.files, audit: checks, producer: { execution: context, runtime: runtime(join(root, "scripts/bun")) } };
  await save(join(directory, "manifest.json"), manifest);
  await writeFile(join(directory, "SHA256SUMS"), `${manifest.package.sha256}  ${pack.filename}\n`);
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `artifact-name=${artifactName}\n`, { flag: "a" });
  console.log(JSON.stringify({ artifactName, source: identity, package: manifest.package, audit: checks }));
}
async function verify(directory, receipts) {
  const identity = source(), manifest = await json(join(directory, "manifest.json"));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.source, identity, "Downloaded candidate is from a different source commit/tree/parents");
  assert.equal(basename(manifest.package.filename), manifest.package.filename);
  if (process.env.YALD_CANDIDATE_ARTIFACT) assert.equal(manifest.artifactName, process.env.YALD_CANDIDATE_ARTIFACT, "Wrong producer attempt downloaded");
  const tarball = join(directory, manifest.package.filename), bytes = await readFile(tarball);
  assert.equal(sha(bytes), manifest.package.sha256, "Downloaded tarball SHA256 mismatch");
  assert.equal(bytes.length, manifest.package.bytes);
  assert.equal(`sha512-${sha(bytes, "sha512", "base64")}`, manifest.package.integrity);
  assert.equal(await readFile(join(directory, "SHA256SUMS"), "utf8"), `${manifest.package.sha256}  ${manifest.package.filename}\n`);
  const unpacked = await inventory(tarball);
  assert.deepEqual(unpacked.files, manifest.files, "Tarball content hashes differ from manifest");
  assert.equal(unpacked.package.version, manifest.package.version);
  assert.equal(unpacked.package.name, manifest.package.name);
  const pack = await json(join(directory, "npm-pack.json"));
  assert.equal(pack.length, 1);
  assert.equal(pack[0].filename, manifest.package.filename);
  assert.equal(pack[0].size, bytes.length);
  assert.equal(pack[0].integrity, manifest.package.integrity);
  assert.equal(pack[0].shasum, sha(bytes, "sha1"));
  assert.deepEqual(pack[0].files.map(file => ({ path: file.path, bytes: file.size })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    unpacked.files.map(({ path, bytes }) => ({ path, bytes })), "Downloaded npm file list differs from actual tar entries");
  await fresh(receipts);
  const receipt = { schemaVersion: 1, status: "failed", artifactName: manifest.artifactName, source: identity,
    package: manifest.package, producer: manifest.producer, verifier: { execution: execution(), runtime: runtime(join(root, "scripts/bun")) }, checks: {} };
  const work = await mkdtemp(join(tmpdir(), "yald-candidate-verify-"));
  try {
    receipt.checks.packageAudit = await audit(unpacked.files, unpacked.package, tarball);
    const prefix = join(work, "fresh install");
    run("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", tarball], { cwd: work, stdio: "inherit" });
    const installed = join(prefix, "node_modules", manifest.package.name), cli = join(prefix, "node_modules/.bin/yald");
    await compareInstalled(installed, manifest.files);
    assert.equal(run(process.execPath, [cli, "--version"], { cwd: work }), manifest.package.version);
    const require = createRequire(join(installed, "package.json"));
    const bunDir = dirname(require.resolve("bun/package.json"));
    const bun = [join(bunDir, "bin/bun.exe"), join(bunDir, "bin/bun")].find(path => existsSync(path));
    assert.ok(bun, "Installed Bun executable missing");
    receipt.verifier.installedBun = run(bun, ["--version"]);
    const validator = join(work, "verify-demo-package.mjs"), guard = join(work, "demo-guard.mjs");
    await copyFile(join(root, "scripts/verify-demo-package.mjs"), validator);
    await copyFile(join(root, "tests/helpers/demo-guard.mjs"), guard);
    const demoPath = join(receipts, "demo-receipt.json");
    run(process.execPath, [validator, cli, tarball, demoPath, guard, join(directory, "manifest.json")], { cwd: work, stdio: "inherit" });
    const demo = await json(demoPath);
    assert.equal(demo.package.sha256, manifest.package.sha256);
    assert.deepEqual(demo.source, identity);
    assert.equal(demo.status, "passed");
    await compareInstalled(installed, manifest.files);
    assert.equal(sha(await readFile(tarball)), manifest.package.sha256, "Candidate changed during verification");
    assert.deepEqual(source(), identity);
    receipt.checks = { ...receipt.checks, installedFilesBeforeAndAfter: manifest.files.length,
      installedCliVersion: manifest.package.version, installedDemo: "passed; see demo-receipt.json", candidateUnchanged: true };
    receipt.status = "passed";
  } catch (error) { receipt.error = String(error.stack ?? error); throw error; }
  finally {
    await save(join(receipts, "receipt.json"), receipt);
    await copyFile(join(directory, "manifest.json"), join(receipts, "candidate-manifest.json"));
    await rm(work, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ status: receipt.status, artifactName: receipt.artifactName, sha256: receipt.package.sha256, source: identity, verifier: receipt.verifier }));
}

if (command === "produce" && directoryArg && !receiptArg) await produce(outside(resolve(directoryArg)));
else if (command === "verify" && directoryArg && receiptArg) await verify(outside(resolve(directoryArg)), outside(resolve(receiptArg)));
else throw new Error("Usage: node scripts/qualify-package.mjs produce ARTIFACT_DIR | verify CANDIDATE_DIR RECEIPT_DIR");
