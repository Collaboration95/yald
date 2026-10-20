/** Check a built or installed local server against every shipped brand asset. */
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:5329");
assert(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname), "Use an isolated local fixture server");
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("docs/brand/yaldi/manifest.json", root), "utf8")) as {
  assets: { file: string; shipped: boolean }[];
};
const assets = manifest.assets.filter(asset => asset.shipped);
for (const asset of assets) {
  assert(asset.file.startsWith("web/public/"));
  const path = "/" + asset.file.slice("web/public/".length);
  const response = await fetch(new URL(path, base));
  assert.equal(response.status, 200, path);
  const expectedType = path.endsWith(".svg") ? "image/svg+xml" : path.endsWith(".png") ? "image/png" : "image/";
  assert(response.headers.get("content-type")?.startsWith(expectedType), `${path}: correct image content type, not SPA fallback`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(asset.file, root)), `${path}: exact shipped bytes`);
}
const page = await fetch(new URL("/labs", base));
assert.equal(page.status, 200);
const html = await page.text();
for (const value of ["Yald · opencodex + Claude Code analytics", "Yaldi, Yald's detective companion", 'href="/favicon.svg"', 'href="/favicon.ico"', 'href="/apple-touch-icon.png"']) {
  assert(html.includes(value), `Built metadata: ${value}`);
}
console.log(`PASS B02 ${assets.length} local brand assets: HTTP 200, image MIME and exact bytes; built title, description and icon metadata (${base.origin})`);
