import { afterAll } from "bun:test";
import { stopDescendantsSync } from "./test-suite.mjs";

// This supplements bunfig.toml's data isolation preload. Catchable termination
// and normal/failing exits clean children before they lose their parent identity.
// Bun's test command does not emit process 'exit' on ordinary suite completion.
afterAll(stopDescendantsSync);
process.once("exit", () => {
  try { stopDescendantsSync(); }
  catch (error) { console.error(`[test-suite] worker cleanup: ${error.message}`); process.exitCode ||= 1; }
});
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  process.once(signal, () => process.exit(code));
}
