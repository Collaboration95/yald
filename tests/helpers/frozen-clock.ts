/**
 * Preload (`bun --preload tests/helpers/frozen-clock.ts …`) that pins Date.now to
 * YALD_TEST_NOW, so a child process such as `yald report` dates its output like
 * the store probe does.
 */
const frozen = Number(process.env.YALD_TEST_NOW);
if (!Number.isFinite(frozen) || frozen <= 0) throw new Error("frozen-clock: set YALD_TEST_NOW to epoch milliseconds");
Date.now = () => frozen;
