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

// Audited 2026-10-02: the single-request pricing path uses compiled catalog,
// expected/tier tables and pure identity helpers. The only changing price state
// it reads is the versioned overlay/provider/account registry. A version export
// alone is not a contract for other engines or future dependency revisions.
const AUDITED_PRICE_SOURCES = [
  "usage/cost.ts", "generated/model-metadata.ts", "usage/expected-prices.ts",
  "usage/model-identity.ts", "usage/user-cost-overlays.ts", "providers/label.ts",
  "providers/fastwire.ts", "providers/antigravity-models.ts", "adapters/cursor/claude-id.ts",
  "codex/account-id.ts", "codex/account-label.ts", "codex/main-account.ts", "lib/redact.ts",
] as const;
const AUDITED_PRICE_HASH = "fa56531a6b4dba32a97f9aaea863ebdcb41f4f93623b8b3e203ef1aaf47bf154";

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

/** Null means price stability is unknown, never an unchanged generation. */
export function pricingGeneration(): string | null {
  return engine?.generation?.() ?? null;
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
