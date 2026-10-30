// Test-runner-only preload, copied into a private per-worker registry. Inherited
// Node/Bun options run this before user code, even if the parent already exited.
// Do not install signal/exit handlers or change child spawning semantics here.
const { execFileSync } = require("node:child_process");
const { lstatSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const directory = lstatSync(__dirname);
if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)) {
  throw new Error("Test process registry must be private to its owner");
}
const gate = join(__dirname, "open");
function checkOpen() {
  if (readFileSync(gate, "utf8") !== "open\n") throw new Error("Test worker is stopping");
}
checkOpen();
const started = execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8", timeout: 2000 }).trim().replace(/\s+/g, " ");
if (!started) throw new Error("Cannot identify test process");
const temporary = join(__dirname, `${process.pid}.${require("node:crypto").randomUUID()}.tmp`);
writeFileSync(temporary, JSON.stringify({ pid: process.pid, started }), { mode: 0o600, flag: "wx" });
renameSync(temporary, join(__dirname, `${process.pid}.json`));
// Cleanup removes the gate BEFORE reading receipts. A concurrent registration
// either published its complete receipt before that read, or must refuse to run
// user code. A removed registry also fails closed, including a late runtime start.
checkOpen();
