import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

type Member = { name: string; type?: string; link?: string; contents?: string; prefix?: string };
// Small synthetic ustar fixtures, including types that must never be extracted.
// No packaging dependency or separate test runner is needed.
function archive(members: Member[]) {
  const blocks: Buffer[] = [];
  for (const { name, type = "0", link = "", contents = "", prefix = "" } of members) {
    const data = Buffer.from(contents), header = Buffer.alloc(512);
    const octal = (offset: number, width: number, value: number) => header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width);
    header.write(name, 0, 100);
    octal(100, 8, type === "5" ? 0o755 : 0o644); octal(108, 8, 0); octal(116, 8, 0);
    octal(124, 12, data.length); octal(136, 12, 0);
    header.fill(32, 148, 156); header.write(type, 156, 1);
    header.write(link, 157, 100); header.write("ustar\0", 257, 6); header.write("00", 263, 2);
    header.write(prefix, 345, 155);
    octal(329, 8, 0); octal(337, 8, 0);
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const hash = (bytes: Buffer, algorithm = "sha256", encoding: "hex" | "base64" = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const pkg = JSON.stringify({ name: "archive-test", version: "0.0.0" });
const base: Member = { name: "package/package.json", contents: pkg };
const node = Bun.which("node")!, tar = Bun.which("tar")!;
let root: string, source: string, bin: string, sentinel: string, identity: { commit: string; tree: string; parents: string[] };
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "yald-archive-test-"));
  source = join(root, "source"); bin = join(root, "bin"); sentinel = join(root, "owned-target");
  await mkdir(join(source, "scripts"), { recursive: true }); await mkdir(bin);
  await writeFile(sentinel, "must remain unchanged");
  await copyFile(resolve(import.meta.dir, "../scripts/qualify-package.mjs"), join(source, "scripts/qualify-package.mjs"));
  // Real clean committed source in a private repo: the CLI's source controls
  // remain active even when this test runs before a development commit.
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: source, encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  git("init", "--quiet"); git("add", ".");
  git("-c", "user.name=Archive test", "-c", "user.email=archive@example.invalid", "commit", "--quiet", "-m", "Archive test fixture");
  identity = { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), parents: [] };
  // Transparently record real tar calls; assertions prove that rejection
  // precedes extraction, rather than relying on tar to refuse unsafe entries.
  await writeFile(join(bin, "tar"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$YALD_TEST_TAR_LOG"\nexec "$YALD_TEST_REAL_TAR" "$@"\n', { mode: 0o755 });
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function verify(label: string, members: Member[], mutate = (bytes: Buffer) => bytes) {
  const directory = join(root, label), receipts = join(root, `${label}-receipts`), trace = join(root, `${label}-tar.log`);
  await mkdir(directory);
  const bytes = mutate(archive(members)), filename = "archive-test.tgz", integrity = `sha512-${hash(bytes, "sha512", "base64")}`;
  const save = (name: string, value: unknown) => writeFile(join(directory, name), JSON.stringify(value));
  await writeFile(join(directory, filename), bytes);
  await writeFile(join(directory, "SHA256SUMS"), `${hash(bytes)}  ${filename}\n`);
  await save("manifest.json", { schemaVersion: 1, source: identity, package: { filename, bytes: bytes.length, sha256: hash(bytes), integrity }, files: [] });
  await save("npm-pack.json", [{ filename, size: bytes.length, integrity, shasum: hash(bytes, "sha1") }]);
  const result = spawnSync(node, [join(source, "scripts/qualify-package.mjs"), "verify", directory, receipts], {
    cwd: source, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      YALD_TEST_REAL_TAR: tar, YALD_TEST_TAR_LOG: trace, YALD_CANDIDATE_ARTIFACT: "" },
  });
  expect(result.status).toBe(1);
  expect(existsSync(receipts)).toBe(false);
  expect(await readFile(sentinel, "utf8")).toBe("must remain unchanged");
  const calls = existsSync(trace) ? (await readFile(trace, "utf8")).trim().split("\n") : [];
  return { error: result.stderr, extraction: calls.filter(call => !call.startsWith("-t")) };
}

for (const [label, type, name] of [
  ["trailing-slash-symlink", "2", "package/review-omitted/"],
  ["symlink", "2", "package/review-link"],
  ["trailing-slash-hardlink", "1", "package/review-hardlink/"],
  ["hardlink", "1", "package/review-hardlink"],
  ["fifo", "6", "package/review-fifo"],
  ["trailing-slash-fifo", "6", "package/review-fifo/"],
  ["character-device", "3", "package/review-character-device"],
  ["block-device", "4", "package/review-block-device"],
  ["contiguous-file", "7", "package/review-contiguous"],
  ["sparse-file", "S", "package/review-sparse"],
  ["pax-override", "x", "package/review-pax"],
  ["global-pax-override", "g", "package/review-global-pax"],
  ["gnu-name-override", "L", "package/review-gnu-name"],
]) {
  test(`qualification rejects ${label} before extraction`, async () => {
    const result = await verify(label!, [base, { name: name!, type, link: type === "1" ? base.name : sentinel }]);
    expect(result.error).toContain("Unsupported tar entry type");
    expect(result.extraction).toEqual([]);
  });
}

for (const [label, member, reason] of [
  ["regular-file-with-slash", { name: "package/review-omitted/" }, "Unsafe tar entry"],
  ["duplicate-file", base, "Duplicate/conflicting tar entry"],
  ["case-alias", { name: "package/PACKAGE.JSON" }, "Duplicate/conflicting tar entry"],
  ["directory-file-alias", { name: "package/package.json/", type: "5" }, "Duplicate/conflicting tar entry"],
  ["file-ancestor", { name: "package/package.json/child" }, "Conflicting tar ancestor"],
  ["directory-traversal", { name: "package/../escape/", type: "5" }, "Unsafe tar entry"],
  ["file-traversal", { name: "package/../escape" }, "Unsafe tar entry"],
  ["absolute-path", { name: "/package/escape" }, "Unsafe tar entry"],
  ["dot-alias", { name: "package/./package.json" }, "Unsafe tar entry"],
  ["empty-component", { name: "package//package.json" }, "Unsafe tar entry"],
  ["escaped-newline", { name: "package/line\nbreak" }, "Unsafe tar entry"],
  ["escaped-backslash", { name: "package/back\\slash" }, "Unsafe tar entry"],
  ["prefix-traversal", { name: "escape", prefix: "package/.." }, "Unsafe tar entry"],
  ["regular-link-target", { name: "package/review-file", link: "package/package.json" }, "Unexpected tar link target"],
  ["directory-payload", { name: "package/review-dir/", type: "5", contents: "hidden" }, "Invalid tar size"],
] as const) {
  test(`qualification rejects ${label} before extraction`, async () => {
    const result = await verify(label, [base, member]);
    expect(result.error).toContain(reason);
    expect(result.extraction).toEqual([]);
  });
}

for (const suffix of ["", "/"]) test(`only real directories are skipped (suffix '${suffix}'); every regular file is inventoried`, async () => {
  const result = await verify(`actual-directories-${suffix ? "slash" : "plain"}`, [{ name: `package${suffix}`, type: "5" }, { ...base, type: "\0" },
    { name: `package/docs${suffix}`, type: "5" }, { name: "guide.md", prefix: "package/docs", contents: "guide" }]);
  // A deliberately empty manifest stops verification at the real inventory
  // comparison, before install. Both file hashes must be present in the error.
  expect(result.error).toContain("Tarball content hashes differ from manifest");
  for (const [path, contents] of [["package.json", pkg], ["docs/guide.md", "guide"]]) {
    expect(result.error).toContain(`path: '${path}'`);
    expect(result.error).toContain(hash(Buffer.from(contents!)));
  }
  expect(result.extraction).toHaveLength(1);
  expect(result.extraction[0]).toStartWith("-xzf ");
});

for (const [label, mutate, reason] of [
  ["hidden-entry-after-end", (bytes: Buffer) => Buffer.concat([bytes, gunzipSync(archive([{ name: "package/hidden" }]))]), "Invalid tar end marker or hidden entries"],
  ["truncated-payload", (bytes: Buffer) => bytes.subarray(0, 512), "Truncated tar entry"],
  ["missing-end-marker", (bytes: Buffer) => bytes.subarray(0, bytes.length - 1024), "Invalid tar end marker or hidden entries"],
  ["checksum", (bytes: Buffer) => { bytes[153] = bytes[153] === 48 ? 49 : 48; return bytes; }, "tar -tzf"],
  ["header-format", (bytes: Buffer) => { bytes[257] = 0; return bytes; }, "Unsupported tar header format"],
  ["binary-size", (bytes: Buffer) => { bytes[124] = 0x80; return bytes; }, "Unsupported tar size"],
] as const) {
  test(`qualification rejects ${label} before extraction with recomputed archive metadata`, async () => {
    const result = await verify(label, [base], bytes => gzipSync(mutate(gunzipSync(bytes))));
    expect(result.error).toContain(reason);
    expect(result.extraction).toEqual([]);
  });
}
