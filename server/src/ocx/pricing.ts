import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
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
  /** The engine's normalized split: input excludes cache read and write. */
  tokens?: Cost4;
  priorityLowerBound?: boolean;
}

type EstimateFn = (input: Record<string, unknown>) => CostEstimateLike | null;

interface PricingEngine {
  estimate: EstimateFn;
  priceOptions: ((entry: unknown, fallback: unknown) => Record<string, unknown>) | null;
  tierContext: ((entry: Record<string, unknown>) => unknown) | null;
  tokensPerSecond: (outputTokens: number, durationMs: number) => number | null;
  modulePath: string;
  generation: (() => string | null) | null;
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

// Audited 2026-10-30 against opencodex 2.94.0: the single-request pricing path
// uses compiled catalog, expected/tier tables and pure identity helpers. The only
// changing price state it reads is the versioned overlay/provider/account registry.
// A version export alone is not a contract for other engines or future dependency
// revisions.
const AUDITED_PRICE_SOURCES = [
  "usage/cost.ts", "generated/model-metadata.ts", "usage/expected-prices.ts",
  "usage/model-identity.ts", "usage/user-cost-overlays.ts", "usage/user-cost-validation.ts",
  "providers/label.ts", "providers/fastwire.ts", "providers/antigravity-models.ts",
  "providers/anthropic-instance-id.ts", "adapters/cursor/claude-id.ts", "adapters/cursor/catalog.ts",
  "codex/account-id.ts", "codex/account-label.ts", "lib/redact.ts",
] as const;
const AUDITED_PRICE_HASH = "60398bb71dd3133ef6f512f1151bacc14e00dc6fed168d0f1a9f86d52e67566b";

async function auditedPricingSources(modulePath: string): Promise<string | null> {
  if (extname(modulePath) !== ".ts") return null;
  try {
    const sourceDir = dirname(dirname(modulePath));
    const sources = await Promise.all(AUDITED_PRICE_SOURCES.map(file => readFile(join(sourceDir, file))));
    const hash = createHash("sha256");
    for (let index = 0; index < sources.length; index++) {
      hash.update(AUDITED_PRICE_SOURCES[index]).update("\0").update(sources[index]).update("\0");
    }
    const digest = hash.digest("hex");
    return digest === AUDITED_PRICE_HASH ? digest : null;
  } catch {
    return null;
  }
}

/** Follow the audited cost module's own import to the same registry instance. */
async function overlayGeneration(modulePath: string, sourceHash: string): Promise<PricingEngine["generation"]> {
  try {
    const source = await readFile(modulePath, "utf8");
    // A neighboring src registry is not evidence for a dist/bundled engine.
    // Follow this engine's own import so both consumers use the same instance.
    const registryImport = source.match(/^import\s*\{[^}]*\buserCostOverlayVersion\b[^}]*\}\s*from\s*["'](\.\/user-cost-overlays(?:\.(?:ts|js))?)["']/m);
    if (!registryImport) return null;
    const specifier = registryImport[1];
    const registryPath = join(dirname(modulePath), extname(specifier) ? specifier : `${specifier}${extname(modulePath)}`);
    const registry = await import(pathToFileURL(registryPath).href) as Record<string, unknown>;
    const version = registry.userCostOverlayVersion;
    if (typeof version !== "function") return null;
    // Loaded ESM tables stay process-stable. Disk/package/model-registry edits
    // are not hot-reloaded (even by force); restart loads new code, which must
    // pass this audit again. No config/discovery lifecycle is added here.
    return () => {
      try {
        const value: unknown = version();
        return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
          ? `${pathToFileURL(modulePath).href}:${sourceHash}:${value}`
          : null;
      } catch {
        return null;
      }
    };
  } catch {
    // Unknown engines still price normally; they simply cannot reuse usage.
    return null;
  }
}

function fallbackTokensPerSecond(outputTokens: number, durationMs: number): number | null {
  if (!Number.isFinite(outputTokens) || !Number.isFinite(durationMs)) return null;
  if (outputTokens <= 0 || durationMs <= 0) return null;
  return outputTokens / (durationMs / 1000);
}

/**
 * Loads opencodex's own cost module and shares its formulas, registered user
 * overlays, compiled model prices and tier rules. This does not initialize or
 * watch config. Package/catalog updates require a process restart, as before.
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
        const auditedSources = await auditedPricingSources(candidate);
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
          generation: auditedSources && auditedSources === await auditedPricingSources(candidate)
            ? await overlayGeneration(candidate, auditedSources)
            : null,
        };
        status = { available: true, modulePath: candidate, packageDir: dir,
          detail: process.env.YALD_DEMO === "1" ? "illustrative demo prices (not live rates)" : "reusing opencodex cost engine" };
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

/** Null means price stability is unknown, never an unchanged generation. */
export function pricingGeneration(): string | null {
  return engine?.generation?.() ?? null;
}

function estimateWith(input: Record<string, unknown>, usage: unknown): CostEstimateLike | null {
  return engine!.estimate({ ...input, usage });
}

/** Price one persisted usage row exactly the way `ocx usage` does. */
export function priceEntry(entry: Record<string, unknown>): CostEstimateLike | null {
  return priceWithCacheCounterfactual(entry, false).estimate;
}

export type CacheEconomicsUnavailable = "engine-incomplete" | "tier-context-unavailable" | "baseline-unpriced" | "baseline-mismatch" | "tier-mismatch";

/** One row priced with and without its cache counters; bounded numbers and tier provenance, never content. */
export type CacheEconomics =
  | {
    available: true;
    /** Engine-priced inclusive input, i.e. the baseline's uncached input. */
    inputTokens: number;
    readTokens: number;
    writeTokens: number;
    actualUsd: number;
    baselineUsd: number;
    readDiscountUsd: number;
    writePremiumUsd: number;
    /** Effective USD per 1M tokens after context tier and priority; null when the class priced no tokens. */
    rates: { input: number | null; cacheRead: number | null; cacheWrite: number | null };
    /** Tokens priced at zero by a non-user price: an unpublished rate, not a free one. */
    zeroRate: { input: boolean; cacheRead: boolean; cacheWrite: boolean };
    rateSource: string;
    rateStatus: string;
    derivedRate: boolean;
    explicitFree: boolean;
    contextTier: "long" | null;
    priorityMultiplier: number | null;
    priorityLowerBound: boolean;
    serviceTier: { response: string | null; requested: string | null; configured: string | null };
  }
  | { available: false; reason: CacheEconomicsUnavailable };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const tokensOf = (estimate: CostEstimateLike): Cost4 | null => {
  const t = estimate.tokens;
  return t && [t.input, t.output, t.cacheRead, t.cacheWrite].every(nonnegative) ? t : null;
};
const costOf = (estimate: CostEstimateLike): CostBreakdown | null => {
  const c = estimate.cost;
  return c && [c.input, c.output, c.cacheRead, c.cacheWrite, c.total].every(nonnegative) ? c : null;
};
const completeTier = (estimate: CostEstimateLike): boolean =>
  (estimate.contextTier == null || estimate.contextTier === "long")
  && (estimate.priorityMultiplier == null || (nonnegative(estimate.priorityMultiplier) && estimate.priorityMultiplier > 0))
  && (estimate.priorityLowerBound == null || typeof estimate.priorityLowerBound === "boolean");
const perMillion = (cost: number, tokens: number): number | null => tokens > 0 ? cost / tokens * 1e6 : null;
// Effective rates of the two calls agree up to float noise, not bit for bit.
const sameRate = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const sameCost = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Prices the row as recorded, then the identical workload with only its cache
 * counters zeroed. Raw inputTokens and the service-tier record are untouched,
 * so the engine makes the same long-context and priority decisions for both.
 */
export function priceWithCacheCounterfactual(entry: Record<string, unknown>, withCache = true): { estimate: CostEstimateLike | null; cache: CacheEconomics | null } {
  if (!engine) return { estimate: null, cache: null };
  let input: Record<string, unknown>;
  let actual: CostEstimateLike | null;
  try {
    // Evaluate routing price options and tier provenance once. Both calls reuse
    // these exact values, including nested objects and the tierOutcome record.
    const extra = engine.priceOptions ? engine.priceOptions(entry, entry) : {};
    const serviceTier = engine.tierContext ? engine.tierContext(entry) : undefined;
    input = { ...extra, provider: entry.provider, model: entry.model, usageStatus: entry.usageStatus, serviceTier };
    actual = estimateWith(input, entry.usage);
  } catch {
    return { estimate: null, cache: null };
  }
  if (!actual || !withCache) return { estimate: actual, cache: null };
  const unavailable = (reason: CacheEconomicsUnavailable) => ({ estimate: actual, cache: { available: false as const, reason } });
  const tokens = tokensOf(actual);
  const price = actual.price;
  const cost = costOf(actual);
  if (!tokens || !price || !text(price.source) || !text(price.status)
    || !cost || !completeTier(actual)) return unavailable("engine-incomplete");

  // Actual pricing still supports engines without this optional helper. A
  // comparison cannot silently discard the entry's recorded tier provenance.
  if (!engine.tierContext && [entry.responseServiceTier, entry.requestedServiceTier,
    entry.configuredServiceTier, entry.tierOutcome].some(value => value != null)) return unavailable("tier-context-unavailable");

  let baseline: CostEstimateLike | null = actual;
  if (tokens.cacheRead + tokens.cacheWrite > 0) {
    // Numeric zeros, not deletions: `??` would otherwise fall through to legacy fields.
    const usage: Record<string, unknown> = { ...(entry.usage as Record<string, unknown>), cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    delete usage.cachedInputTokens;
    try {
      baseline = estimateWith(input, usage);
    } catch {
      baseline = null;
    }
    if (!baseline) return unavailable("baseline-unpriced");
    const base = tokensOf(baseline);
    const baseCost = costOf(baseline);
    if (!base || !baseCost || !text(baseline.price?.source) || !text(baseline.price?.status)
      || !completeTier(baseline)) return unavailable("engine-incomplete");
    if (base.input !== tokens.input + tokens.cacheRead + tokens.cacheWrite || base.output !== tokens.output
      || base.cacheRead !== 0 || base.cacheWrite !== 0) return unavailable("baseline-mismatch");
    if ((baseline.contextTier ?? null) !== (actual.contextTier ?? null)
      || (baseline.priorityMultiplier ?? null) !== (actual.priorityMultiplier ?? null)
      || (baseline.priorityLowerBound === true) !== (actual.priorityLowerBound === true)
      || baseline.price!.source !== price.source || baseline.price!.status !== price.status
      || (tokens.input > 0 && !sameRate(cost.input / tokens.input * 1e6, baseCost.input / base.input * 1e6))) return unavailable("tier-mismatch");
  }
  const inputTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const baselineInputCost = baseline === actual ? cost.input : baseline.cost.input;
  const perToken = inputTokens > 0 && baseline !== actual ? baselineInputCost / inputTokens
    : tokens.input > 0 ? cost.input / tokens.input : 0;
  const readDiscountUsd = tokens.cacheRead * perToken - cost.cacheRead;
  const writePremiumUsd = cost.cacheWrite - tokens.cacheWrite * perToken;
  const rates = {
    input: perMillion(baselineInputCost, baseline === actual ? tokens.input : inputTokens),
    cacheRead: perMillion(cost.cacheRead, tokens.cacheRead),
    cacheWrite: perMillion(cost.cacheWrite, tokens.cacheWrite),
  };
  if (![inputTokens, readDiscountUsd, writePremiumUsd].every(finite)
    || Object.values(rates).some(rate => rate !== null && !nonnegative(rate))) return unavailable("engine-incomplete");
  // Identical output must cancel, and both engine totals must match their cost
  // classes. Fail closed if a changed/partial engine violates the comparison.
  if (!sameCost(cost.total, cost.input + cost.output + cost.cacheRead + cost.cacheWrite)
    || !sameCost(baseline.cost.total, baseline.cost.input + baseline.cost.output + baseline.cost.cacheRead + baseline.cost.cacheWrite)
    || !sameCost(baseline.cost.total, baseline.cost.input + baseline.cost.output)
    || !sameCost(cost.output, baseline.cost.output)
    || !sameCost(baseline.cost.total - cost.total, readDiscountUsd - writePremiumUsd)) return unavailable("baseline-mismatch");
  const explicit = price.source === "user";
  const tier = typeof input.serviceTier === "object" && input.serviceTier !== null
    ? input.serviceTier as Record<string, unknown> : {};
  return {
    estimate: actual,
    cache: {
      available: true,
      inputTokens,
      readTokens: tokens.cacheRead,
      writeTokens: tokens.cacheWrite,
      actualUsd: cost.total,
      baselineUsd: baseline.cost.total,
      readDiscountUsd,
      writePremiumUsd,
      rates,
      zeroRate: {
        input: !explicit && inputTokens > 0 && baselineInputCost === 0,
        cacheRead: !explicit && tokens.cacheRead > 0 && cost.cacheRead === 0,
        cacheWrite: !explicit && tokens.cacheWrite > 0 && cost.cacheWrite === 0,
      },
      rateSource: price.source,
      rateStatus: price.status,
      derivedRate: price.status === "verified-derived",
      explicitFree: explicit && ((inputTokens > 0 && baselineInputCost === 0)
        || (tokens.cacheRead > 0 && cost.cacheRead === 0) || (tokens.cacheWrite > 0 && cost.cacheWrite === 0)),
      contextTier: actual.contextTier ?? null,
      priorityMultiplier: finite(actual.priorityMultiplier) ? actual.priorityMultiplier : null,
      priorityLowerBound: actual.priorityLowerBound === true,
      serviceTier: { response: text(tier.responseServiceTier), requested: text(tier.requestedServiceTier), configured: text(tier.configuredServiceTier) },
    },
  };
}

export function outputTokensPerSecond(outputTokens: number, durationMs: number): number | null {
  return (engine?.tokensPerSecond ?? fallbackTokensPerSecond)(outputTokens, durationMs);
}
