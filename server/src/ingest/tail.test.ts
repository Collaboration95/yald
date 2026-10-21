import { afterAll, expect, test } from "bun:test";
import { appendFile, mkdtemp, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_BYTES, readTail, type TailCursor } from "./tail";

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); });

async function file(text: string) {
  const dir = await mkdtemp(join(tmpdir(), "yald-tail-")); dirs.push(dir);
  const path = join(dir, "log.jsonl");
  await writeFile(path, text);
  return path;
}
async function identity(path: string) {
  const info = await stat(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino), size: Number(info.size) };
}
const read = async (path: string, cursor: TailCursor | null) => readTail(path, await identity(path), cursor);
const line = (n: number) => JSON.stringify({ n, pad: "x".repeat(200) }) + "\n";

test("only appended bytes are read, and a torn last line is returned but never consumed", async () => {
  const head = Array.from({ length: 40 }, (_, n) => line(n)).join("");
  const path = await file(head + '{"torn":');
  const first = await read(path, null);
  expect(first.reset).toBe(true);
  expect(first.complete).toBe(head);
  expect(first.partial).toBe('{"torn":');
  expect(first.cursor.offset).toBe(Buffer.byteLength(head));

  await appendFile(path, '1}\n' + line(40));
  const next = await read(path, first.cursor);
  expect(next.reset).toBe(false);
  // Resumes before the torn line, so it comes back whole now that it is complete.
  expect(next.complete).toBe('{"torn":1}\n' + line(40));
  expect(next.partial).toBe("");
  expect(next.bytesRead).toBe(CHECK_BYTES + Buffer.byteLength('{"torn":1}\n' + line(40)));

  // Nothing new but an unterminated line: the cursor does not move.
  await appendFile(path, '{"half"');
  const half = await read(path, next.cursor);
  expect([half.reset, half.complete, half.partial, half.cursor.offset]).toEqual([false, "", '{"half"', next.cursor.offset]);
});

test("a replaced, shrunk, rewritten or same-size changed file is read from the start", async () => {
  const text = Array.from({ length: 30 }, (_, n) => line(n)).join("");
  const path = await file(text);
  const first = await read(path, null);

  // Rewritten just before the cursor, then appended to: the checksum catches it.
  await writeFile(path, text.slice(0, -10) + "y".repeat(9) + "\n" + line(99));
  const rewritten = await read(path, first.cursor);
  expect(rewritten.reset).toBe(true);
  expect(rewritten.complete).toBe(text.slice(0, -10) + "y".repeat(9) + "\n" + line(99));

  // Same size as at the first read, different bytes far before the cursor's checked window:
  // a change that did not grow the file is not an append.
  await writeFile(path, text.replace('"n":0', '"n":7'));
  const sameSize = await read(path, first.cursor);
  expect(sameSize.reset).toBe(true);
  expect(sameSize.complete).toBe(text.replace('"n":0', '"n":7'));

  // Shrunk.
  await truncate(path, 100);
  const shrunk = await read(path, first.cursor);
  expect([shrunk.reset, shrunk.complete, shrunk.partial.length]).toEqual([true, "", 100]);

  // Replaced by another file (new inode), even one that is larger.
  const other = path + ".new";
  await writeFile(other, text + line(30));
  await rename(other, path);
  const replaced = await read(path, first.cursor);
  expect(replaced.reset).toBe(true);
  expect(replaced.complete).toBe(text + line(30));
});

test("multi-byte characters split across reads decode exactly as the whole file does", async () => {
  const path = await file("");
  let cursor: TailCursor | null = null;
  let text = "";
  const whole = ["{\"a\":\"尾🙂\"}\n", "{\"b\":\"é\"}\r\n", "\n", "{\"c\":\"零\"}"].join("");
  const bytes = Buffer.from(whole);
  // Append in byte chunks that cut through multi-byte sequences.
  for (let start = 0; start < bytes.length; start += 5) {
    await appendFile(path, bytes.subarray(start, start + 5));
    const result = await read(path, cursor);
    text = (result.reset ? "" : text) + result.complete;
    cursor = result.cursor;
    if (start + 5 >= bytes.length) expect(text + result.partial).toBe(whole);
  }
});
