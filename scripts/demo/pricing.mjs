// Illustrative USD per million tokens. These are invented examples, never live rates.
// Same estimate/tokens contract as the production opencodex pricing adapter consumes.
export const RATES = Object.freeze({
  "demo-orbit": [2, 8, 0.2, 3],
  "demo-lantern": [4, 12, 0.4, 6],
  "demo-zero": [0, 0, 0, 0],
});

export function serviceTierContext(entry) {
  return { responseServiceTier: entry.responseServiceTier, requestedServiceTier: entry.requestedServiceTier,
    configuredServiceTier: entry.configuredServiceTier };
}

export function estimateRequestCost(input) {
  const rate = RATES[input.model];
  if (!rate) return null;
  const u = input.usage ?? {};
  const inputTokens = u.inputTokens ?? 0, output = u.outputTokens ?? 0;
  const cacheRead = u.cacheReadInputTokens ?? u.cachedInputTokens ?? 0;
  const cacheWrite = u.cacheCreationInputTokens ?? 0;
  if (![inputTokens, output, cacheRead, cacheWrite].every(v => Number.isFinite(v) && v >= 0)
    || cacheRead + cacheWrite > inputTokens) return null;
  const tokens = { input: inputTokens - cacheRead - cacheWrite, output, cacheRead, cacheWrite };
  const [inRate, outRate, readRate, writeRate] = rate;
  const cost = { input: tokens.input * inRate / 1e6, output: output * outRate / 1e6,
    cacheRead: cacheRead * readRate / 1e6, cacheWrite: cacheWrite * writeRate / 1e6 };
  return { tokens, cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
    estimated: false, price: { provider: input.provider, modelId: input.model,
      cost4: { input: inRate, output: outRate, cacheRead: readRate, cacheWrite: writeRate },
      source: input.model === "demo-zero" ? "user" : "demo-illustrative", status: "illustrative" } };
}
