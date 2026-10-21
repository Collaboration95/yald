import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

/**
 * Incremental reads of append-only, newline-delimited files (#100). Shared by every reader
 * that follows a growing log: opencodex `usage.jsonl` and Claude transcripts today, and the
 * richer transcript fields (#96) and plain Codex rollouts (#97) next. Compressed files cannot
 * be resumed mid-stream and stay cached by whole-file fingerprint instead.
 *
 * A cursor sits after the last complete line. An unterminated last line is returned as
 * `partial` on every read but never consumed: the cursor stays before it until its newline
 * arrives. Reading resumes at the cursor only when the file is the same file (device and
 * inode), has grown since the last read, and the bytes just before the cursor still hash the
 * same; otherwise the whole file is read again (`reset`). A changed file that did not grow is
 * a rewrite, not an append, so it is always read whole.
 *
 * Limits: the checksum covers only the 4 KB before the cursor, so a file that grew and was
 * also rewritten further back is not detected. Refresh and process start read whole files.
 */

/** Bytes before the cursor that must hash the same before a read may resume there. */
export const CHECK_BYTES = 4096;

export interface TailCursor {
  readonly dev: string;
  readonly ino: string;
  /** Byte offset just after the last complete line. */
  readonly offset: number;
  /** Hash of the up to CHECK_BYTES bytes before `offset`. */
  readonly checksum: string;
  /** The file size this read covered, unterminated last line included. */
  readonly size: number;
}

/** The file as one `stat` saw it: reads stop at this size, never at a later end of file. */
export interface TailFile {
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
}

export interface TailRead {
  /** True when the read started at byte 0: no cursor, another file, a shrunk file or a rewrite before the cursor. */
  readonly reset: boolean;
  readonly cursor: TailCursor;
  /** Complete lines read from the old cursor (or from 0 on reset) to the new one, decoded as UTF-8. */
  readonly complete: string;
  /** The unterminated bytes after the last newline, decoded; "" when the file ends with a newline. */
  readonly partial: string;
  /** Bytes read from disk, including the checked bytes before the cursor. */
  readonly bytesRead: number;
}

/** The file held fewer bytes than its `stat` size while being read: it changed, so the caller retries. */
export class TailChangedError extends Error {
  readonly code = "ETAILCHANGED";
  constructor(path: string) {
    super(`${path} changed while it was read`);
  }
}

const digest = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(end - start);
  const handle = await open(path, "r");
  try {
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
      if (bytesRead === 0) throw new TailChangedError(path);
      filled += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return buffer;
}

/** `bytes` holds [start, file.size); the new content begins at `from`. */
function split(bytes: Buffer, start: number, from: number, file: TailFile, reset: boolean): TailRead {
  const body = bytes.subarray(from - start);
  const end = body.lastIndexOf(10) + 1; // 0 when there is no complete line
  const offset = from + end;
  return {
    reset,
    cursor: { dev: file.dev, ino: file.ino, offset, checksum: digest(bytes.subarray(Math.max(0, offset - CHECK_BYTES) - start, offset - start)), size: file.size },
    // Lines end at a newline byte, which never occurs inside a UTF-8 sequence: decoding the
    // pieces separately gives the same text as decoding the whole file.
    complete: body.toString("utf8", 0, end),
    partial: body.toString("utf8", end),
    bytesRead: bytes.length,
  };
}

/** Reads what was appended since `cursor`, or the whole file when it cannot resume. */
export async function readTail(path: string, file: TailFile, cursor: TailCursor | null): Promise<TailRead> {
  if (cursor && cursor.dev === file.dev && cursor.ino === file.ino && file.size > cursor.size) {
    const start = Math.max(0, cursor.offset - CHECK_BYTES);
    const bytes = await readRange(path, start, file.size);
    if (digest(bytes.subarray(0, cursor.offset - start)) === cursor.checksum) return split(bytes, start, cursor.offset, file, false);
  }
  return split(await readRange(path, 0, file.size), 0, 0, file, true);
}
