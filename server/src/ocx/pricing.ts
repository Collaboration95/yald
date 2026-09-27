import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ocxPackageDir } from "../env";

export interface Cost4 {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface PriceLike {
  provider: string;
  modelId: string;
  cost4: Cost4;
  source: string;
  status: string;
}

export interface CostEstimateLike {
  cost: CostBreakdown;
  estimated: boolean;
  price?: PriceLike;
  contextTier?: "long";
  priorityMultiplier?: number;
}

type EstimateFn = (input: Record<string, unknown>) => CostEstimateLike | null;

interface PricingEngine {
  estimate: EstimateFn;
  priceOptions: ((entry: unknown, fallback: unknown) => Record<string, unknown>) | null;
  tierContext: ((entry: Record<string, unknown>) => unknown) | null;
  tokensPerSecond: (outputTokens: number, durationMs: number) => number | null;
  modulePath: string;
}

export interface PricingStatus {
  available: boolean;
  modulePath: string | null;
  packageDir: string | null;
  detail: string;
}

let engine: PricingEngine | null = null;
let status: PricingStatus | null = null;
let pending: Promise<PricingStatus> | null = null;

function fallbackTokensPerSecond(outputTokens: number, durationMs: number): number | null {
  if (!Number.isFinite(outputTokens) || !Number.isFinite(durationMs)) return null;
  if (outputTokens <= 0 || durationMs <= 0) return null;
  return outputTokens / (durationMs / 1000);
}

/**
 * Loads opencodex's own cost module. Reusing it keeps every dollar figure here
 * identical to `ocx usage` — including user price overlays and long-context bands —
 * and means new models are priced as soon as ocx knows about them.
 */
export async function loadPricing(): Promise<PricingStatus> {
  if (status) return status;
  if (pending) return pending;
  pending = (async () => {
    const dir = ocxPackageDir();
    if (!dir) {
      status = { available: false, modulePath: null, packageDir: null, detail: "opencodex package not found; costs unavailable" };
      return status;
    }
    const candidates = [join(dir, "src", "usage", "cost.ts"), join(dir, "dist", "usage", "cost.js")];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        const mod = (await import(pathToFileURL(candidate).href)) as Record<string, unknown>;
        const estimate = mod.estimateRequestCost;
        if (typeof estimate !== "function") continue;
        let priceOptions: PricingEngine["priceOptions"] = null;
        let tierContext: PricingEngine["tierContext"] = null;
        const identityCandidates = [join(dir, "src", "usage", "model-identity.ts"), join(dir, "dist", "usage", "model-identity.js")];
        for (const identityPath of identityCandidates) {
          if (!existsSync(identityPath)) continue;
          try {
            const identity = (await import(pathToFileURL(identityPath).href)) as Record<string, unknown>;
            if (typeof identity.usageModelPriceOptions === "function") {
              priceOptions = identity.usageModelPriceOptions as PricingEngine["priceOptions"];
            }
          } catch {
            // Optional module: price resolution still works without it.
          }
          break;
        }
        tierContext = typeof mod.serviceTierContext === "function"
          ? (mod.serviceTierContext as PricingEngine["tierContext"])
          : null;
        engine = {
          estimate: estimate as EstimateFn,
          priceOptions,
          tierContext,
          tokensPerSecond: typeof mod.tokensPerSecond === "function"
            ? (mod.tokensPerSecond as PricingEngine["tokensPerSecond"])
            : fallbackTokensPerSecond,
          modulePath: candidate,
        };
        status = { available: true, modulePath: candidate, packageDir: dir, detail: "reusing opencodex cost engine" };
        return status;
      } catch (error) {
        status = { available: false, modulePath: candidate, packageDir: dir, detail: `failed to import ${candidate}: ${String(error)}` };
      }
    }
    status ??= { available: false, modulePath: null, packageDir: dir, detail: "no usable cost module in package" };
    return status;
  })();
  return pending;
}

export function pricingStatus(): PricingStatus {
  return status ?? { available: false, modulePath: null, packageDir: ocxPackageDir(), detail: "pricing not loaded yet" };
}

/** Price one persisted usage row exactly the way `ocx usage` does. */
export function priceEntry(entry: Record<string, unknown>): CostEstimateLike | null {
  if (!engine) return null;
  try {
    const extra = engine.priceOptions ? engine.priceOptions(entry, entry) : {};
    const serviceTier = engine.tierContext ? engine.tierContext(entry) : undefined;
    return engine.estimate({
      ...extra,
      provider: entry.provider,
      model: entry.model,
      usage: entry.usage,
      usageStatus: entry.usageStatus,
      serviceTier,
    });
  } catch {
    return null;
  }
}

export function outputTokensPerSecond(outputTokens: number, durationMs: number): number | null {
  return (engine?.tokensPerSecond ?? fallbackTokensPerSecond)(outputTokens, durationMs);
}
