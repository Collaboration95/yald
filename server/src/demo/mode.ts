/** Populated only by the isolated demo launcher, before any server imports. */
export const DEMO = process.env.YALD_DEMO === "1" ? {
  synthetic: true as const,
  clock: process.env.YALD_DEMO_NOW ? "fixed" as const : "wall" as const,
  now: process.env.YALD_DEMO_NOW ? Number(process.env.YALD_DEMO_NOW) : null,
  sampleAt: Number(process.env.YALD_DEMO_SAMPLE_AT),
  pricing: "Illustrative example prices, not live rates",
} : null;

if (DEMO && (!Number.isSafeInteger(DEMO.sampleAt) || (DEMO.now !== null && !Number.isSafeInteger(DEMO.now)))) {
  throw new Error("Invalid demo clock; use yald demo [--now ISO].");
}

export const requestNow = () => DEMO?.now ?? Date.now();
