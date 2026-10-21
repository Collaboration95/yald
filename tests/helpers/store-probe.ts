/**
 * Isolated JSON-lines protocol: bun store-probe.ts <checkout> with explicit
 * OCX_HOME/OCX_PACKAGE_DIR. A ready record precedes one {result} or {error} per
 * command. get/concurrent return the Dataset, stable in-process object IDs and
 * read counts. begin/join/finish hold one real read and settle all waiting builds.
 * api invokes the actual Hono routes (not a listening server); price controls
 * only the synthetic engine. YALD_TEST_PRICING_GENERATION=synthetic explicitly
 * mocks ONLY generation for store unit tests; real-adapter probes omit it.
 * Never imports a user's home or weakens the production pricing source audit.
 */
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { Dataset } from "../../server/src/ocx/store";

const root = process.argv[2]!;
if (!process.env.OCX_HOME || !process.env.OCX_PACKAGE_DIR) throw new Error("isolated environment required");
// YALD_TEST_NOW overrides the frozen clock, e.g. to date a fixture home's report day.
const frozenNow = Number(process.env.YALD_TEST_NOW) || 1_791_000_000_000;
Date.now = () => frozenNow;
const actualReadFile = fs.readFile;
const actualOpen = fs.open;
const actualStat = fs.stat;
const actualReaddir = fs.readdir;
const reads: Record<string, number> = {};
/** Directory listings and stats, as the freshness check performs them. */
const lookups = { stat: 0, readdir: 0 };
let barrier: { file: string; entered: () => void; arrived: Promise<void>; wait: Promise<void>; release: () => void; fail: boolean } | null = null;
let readFailures: { file: string; code: string; remaining: number } | null = null;
/** One read of `path` (whole-file or opened for a tail read): counted, then any injected failure or held barrier. */
async function beforeRead(path: unknown) {
  const name = basename(String(path));
  reads[name] = (reads[name] ?? 0) + 1;
  if (readFailures?.file === name && readFailures.remaining > 0) {
    readFailures.remaining--;
    throw Object.assign(new Error(`injected ${readFailures.code} read failure`), { code: readFailures.code });
  }
  const gate = barrier;
  if (gate && name === gate.file) {
    barrier = null;
    gate.entered();
    await gate.wait;
    if (gate.fail) throw Object.assign(new Error("injected read failure"), { code: "EIO" });
  }
}
// Intercept only reads, before dynamically importing either revision. All real
// parsing, normalization, pricing and stat/fingerprint logic remains untouched.
mock.module("node:fs/promises", () => ({
  ...fs,
  stat: ((...args: Parameters<typeof fs.stat>) => { lookups.stat++; return actualStat(...args); }) as typeof fs.stat,
  readdir: ((...args: Parameters<typeof fs.readdir>) => { lookups.readdir++; return actualReaddir(...args); }) as typeof fs.readdir,
  readFile: async (...args: Parameters<typeof fs.readFile>) => {
    await beforeRead(args[0]);
    return actualReadFile(...args);
  },
  open: async (...args: Parameters<typeof fs.open>) => {
    await beforeRead(args[0]);
    return actualOpen(...args);
  },
}));

const pricingUrl = pathToFileURL(join(root, "server/src/ocx/pricing.ts")).href;
const syntheticGeneration = process.env.YALD_TEST_PRICING_GENERATION === "synthetic";
if (syntheticGeneration) {
  // Store contract test only: use the real loadPricing/priceEntry implementations
  // and replace their generation signal. Do not counterfeit audited source bytes,
  // hashes, module identity, or the production adapter's admission decision.
  const adapter = { ...await import(pricingUrl) };
  const registry = await import(pathToFileURL(join(process.env.OCX_PACKAGE_DIR!, "src/usage/user-cost-overlays.ts")).href);
  mock.module(pricingUrl, () => ({
    ...adapter,
    pricingGeneration: () => {
      const version = registry.userCostOverlayVersion();
      return Number.isSafeInteger(version) && version >= 0 ? `synthetic-store-contract:${version}` : null;
    },
  }));
}

// Every command checks the disk: probes append and read back at once, so no freshness throttle.
process.env.YALD_FRESHNESS_MS ??= "0";
const { getDataset, ingestReport } = await import(pathToFileURL(join(root, "server/src/ocx/store.ts")).href);
let last: Dataset | null = null;
let pending: Promise<Dataset>[] = [];
let releaseRead: (() => void) | null = null;
let beforeBuild: string | null = null;
const identities = new WeakMap<object, number>();
let nextIdentity = 1;
function identity(value: object): number {
  if (!identities.has(value)) identities.set(value, nextIdentity++);
  return identities.get(value)!;
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
function view(dataset: Dataset) {
  return {
    dataset,
    ids: { dataset: identity(dataset), rows: identity(dataset.rows), rowObjects: dataset.rows.map(identity), quota: identity(dataset.quota), ledger: identity(dataset.ledger) },
    reads: { ...reads },
  };
}

async function command(input: Record<string, any>) {
  switch (input.op) {
    case "get": {
      const dataset = await getDataset({ force: input.force === true });
      last = dataset;
      if (input.freeze) { freeze(dataset.rows); freeze(dataset.quota); freeze(dataset.ledger); }
      return view(dataset);
    }
    case "last": return last ? view(last) : null;
    case "lookups": return { ...lookups };
    case "ingest": return ingestReport?.() ?? null;
    case "scans": return (await import(pathToFileURL(join(root, "server/src/analytics.ts")).href)).filterScans?.() ?? null;
    case "fault": {
      readFailures = { file: input.file, code: input.code, remaining: input.count };
      return { armed: true };
    }
    case "concurrent": {
      const results = await Promise.all(Array.from({ length: input.count ?? 12 }, (_, i) => getDataset({ force: input.force && i === 1 })));
      const dataset: Dataset = results[0]!;
      last = dataset;
      return { ...view(dataset), sameDataset: results.every(result => result === dataset) };
    }
    case "begin": {
      let entered!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      barrier = { file: input.file ?? "usage.jsonl", entered, arrived, wait, release, fail: input.fail === true };
      releaseRead = release;
      beforeBuild = last ? JSON.stringify(last) : null;
      // Attach rejection handler immediately to avoid unhandled rejection noise.
      const build = getDataset({ force: input.force === true });
      build.catch(() => {});
      pending = [build];
      await Promise.race([arrived, build.then(() => { throw new Error("build finished without reaching requested read barrier"); })]);
      return { entered: true };
    }
    case "join": {
      const build = getDataset({ force: input.force === true });
      build.catch(() => {});
      pending.push(build);
      return { joined: pending.length, previousUnchanged: beforeBuild === (last ? JSON.stringify(last) : null) };
    }
    case "finish": {
      if (!releaseRead) throw new Error("no active barrier");
      releaseRead(); releaseRead = null;
      const results = await Promise.allSettled(pending);
      const previousUnchanged = beforeBuild === (last ? JSON.stringify(last) : null);
      const successes = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      if (successes.length) last = successes[0]!;
      return {
        statuses: results.map(result => result.status),
        errors: results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []),
        sameDataset: successes.every(result => result === successes[0]), previousUnchanged,
        ...(last ? view(last) : {}),
      };
    }
    case "price": {
      const cost = await import(pathToFileURL(join(process.env.OCX_PACKAGE_DIR!, "src/usage/cost.ts")).href);
      cost.setPriceEpoch(input.epoch);
      return { changed: true };
    }
    case "adapter": {
      const adapter = await import(pricingUrl);
      await adapter.loadPricing();
      return { generation: adapter.pricingGeneration?.() ?? null, syntheticGeneration, status: adapter.pricingStatus() };
    }
    case "overlay": {
      // Real public registry API, exercised only inside this isolated process.
      const registry = await import(pathToFileURL(join(process.env.OCX_PACKAGE_DIR!, "src/usage/user-cost-overlays.ts")).href);
      const before = registry.userCostOverlayVersion();
      registry.refreshUserCostOverlays(input.config);
      return { before, after: registry.userCostOverlayVersion() };
    }
    case "api": {
      const { api } = await import(pathToFileURL(join(root, "server/src/api.ts")).href);
      const responses = [];
      for (const path of input.paths) {
        const response = await api.request(path, input.etag ? { headers: { "if-none-match": input.etag } } : undefined);
        const text = await response.text();
        responses.push({ path, status: response.status, etag: response.headers.get("etag"), type: response.headers.get("content-type"), disposition: response.headers.get("content-disposition"), csp: response.headers.get("content-security-policy"), body: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text,
          // Durations differ run to run, so they are only returned on request.
          ...(input.timing ? { timing: response.headers.get("server-timing") } : {}) });
      }
      return responses;
    }
    case "report": {
      // What `yald report --json -` computes: the same spec, builder and live context, outside any route.
      const [{ buildReportSpec }, { buildReport }, { liveReportContext }] = await Promise.all(
        ["spec", "build", "context"].map(name => import(pathToFileURL(join(root, `server/src/report/${name}.ts`)).href)),
      );
      const dataset = await getDataset();
      const now = Date.now();
      return buildReport(dataset, buildReportSpec(input.input, { now, first: dataset.rows[0]?.ts ?? now }), liveReportContext(now));
    }
    default: throw new Error(`unknown command: ${input.op}`);
  }
}

console.log(JSON.stringify({ ready: true }));
for await (const line of createInterface({ input: process.stdin })) {
  try { console.log(JSON.stringify({ result: await command(JSON.parse(line)) })); }
  catch (error) { console.log(JSON.stringify({ error: String(error) })); }
}
