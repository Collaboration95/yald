# Second stacked PR: independent dataset snapshots

Research date: 2026-10-02. This document records the premeasurement plan.
See [implementation results](benchmarks/relay-refresh/README.md) for measured outcomes.
The plan required finishing and verifying Relay adoption in PR1
first. Freeze that exact commit as baseline A, then stack PR2 against PR1's branch.
Candidate B must use the same Relay UI, fixtures, pricing engine, dependencies,
and build settings. Do not compare the old UI against Relay and call the difference
an optimization gain. Desktop is the only UI verification target.

## Decision

Try **per-file snapshot reuse for automatic dataset refresh** first. Keep explicit
`GET /api/dataset/refresh` as a full reread, normalization, repricing, and sort.
Use immutable component snapshots and publish a new composed dataset only after
all required work succeeds. This is a concrete caching architecture change,
not a new dependency or a rename of existing whole-dataset caching.

The primary measurable case is a quota-only change with an unchanged 66,000-row
usage ledger. A polling request should rebuild quota without reading, parsing,
pricing, or sorting those unchanged usage rows. A spend-only change is the second
case. An unchanged poll already reuses the entire dataset, so it is a control,
not the expected source of new gains. This experiment does **not** promise faster
explicit Refresh, browser reload, or first chart paint.

Accept B only after correctness parity and repeated timings establish a benefit.
If the primary improvement fails to repeat, publish the inconclusive result and
do not invent a percentage to justify the change.

## What the actual source establishes

- `server/src/ocx/store.ts`: `currentSignature()` combines size and rounded mtime
  for usage, spend, and quota. `build(false)` returns the existing dataset when
  the entire signature matches. If any one file changes, it loads pricing,
  rereads all present files, normalizes/prices every usage row, and sorts all usage
  rows. `getDataset()` coalesces concurrent builds through `inFlight`.
- `parseUsage()` scans newline boundaries without first splitting the entire
  string, but still reads and parses the complete file on rebuild. It accepts a
  valid final JSON object without a newline. An invalid nonempty tail contributes
  one malformed line. Duplicate request IDs are not deduplicated. Equal timestamp
  ordering follows the stable sort and original file order.
- `parseLedger()` reads/splits the complete file, ignores blank or malformed
  lines, and preserves input order. `normalizeLedger()` counts all events and
  sums settled tokens; it does not deduplicate sends.
- `server/src/index.ts` registers the explicit refresh route, forces the store
  rebuild, and returns rows, parse duration, and build timestamp. Importing only
  `server/src/api.ts` does **not** register this route. Startup also builds the
  dataset before the production server starts listening.
- API middleware obtains the current dataset before checking revision/URL ETags.
  A new quota revision therefore invalidates an Overview ETag even if usage did
  not change. Route aggregation is not cached; automatic store refresh and route
  aggregation are separate costs. Preserve this behavior in PR2.
- `web/src/components/Layout.tsx` calls the explicit refresh endpoint and then
  invalidates queries. `web/src/api.ts` defaults to 30-second visible polling,
  conditional JSON requests, and 15-second query staleness. The complete UI refresh
  includes those subsequent active-query responses, not just the refresh response.
- `web/src/components/Chart.tsx` lazily imports the renderer when a Chart renders.
  Several pages render Chart only after their data-derived option exists.
  `ChartRenderer.tsx` registers selected ECharts modules, uses CanvasRenderer,
  initializes in an effect, and applies options with `lazyUpdate: true`. It also
  resizes through ResizeObserver, binds events, and disposes on unmount/theme
  changes. Import completion or canvas existence does not prove plot completion.

Already implemented: route splitting, selected ECharts imports, deferred renderer
loading, revision/query ETags, client response reuse for 304, unchanged whole-file
set reuse, build coalescing, and hidden-tab polling suppression. None is a new PR2
achievement. The installed opencodex source at
`/opt/homebrew/lib/node_modules/@bitkyc08/opencodex/src/usage/cost.ts` also already
memoizes matched prices with provider/model/options and overlay version. Its
`usage/user-cost-overlays.ts` exports `userCostOverlayVersion()`. This is evidence
for this installed dependency, not a guarantee for every supported installation;
record the exact package/source hash in any experiment.

## Why this candidate comes first

| Candidate | Evidence and likely effect | Decision |
| --- | --- | --- |
| Start the existing ECharts import alongside route/data loading | The import can currently start after data arrives. Earlier startup could overlap network/parse work, but could also compete with React and API processing. Previous browser readiness excluded chart completion. | Defer until permitted chart-ready timing exists. Keep one cached import promise, avoid eagerly loading it on the chart-free Conversations list, and measure extra bytes and main-thread contention if tried later. |
| Reuse unchanged per-file snapshots | Source shows an unrelated quota/spend mutation triggering complete usage parsing, repricing, and sorting. This cost can be measured with a deterministic server-only workload. | Select for PR2, with pricing invalidation and full-force fallback. |
| Byte-offset incremental JSONL parsing | Usage appends still trigger a full parse. This could help after per-file reuse, but torn tails, rotation, in-place edits, UTF-8, out-of-order timestamps, and repricing create additional correctness requirements. | Separate later experiment. Do not bundle with snapshot reuse, since attribution would be lost. |
| Add price memoization, a worker, SSR chart handoff, or SQLite aggregates | Price matching is already memoized upstream. Current evidence does not isolate a worker/serialization benefit, SSR handoff cost, or aggregate-store need. | Do not implement in PR2 without a new profile supporting it. |

`docs/performance.md` reports a historical 119 ms parse and one 125.3 ms refresh
request at 66,000 rows. Those are old, sparse observations supporting investigation,
not expected savings or a new baseline. Its 12-request warm API sample and five
warm browser clicks per pane are too small for this experiment's primary claim.
The historical browser marker requires heading/link/main text; it does not require
finished charts. Its refresh marker ends when the refresh response arrives, before
query invalidation settles. Do not relabel either as fully interactive readiness.

## Proposed implementation boundaries for PR2

1. Split internal state into usage `{rows, lines, malformed, fingerprint,
   pricingGeneration}`, spend `{ledger, fingerprint}`, and quota
   `{quota, fingerprint}` snapshots. Reuse sorted rows by reference only when
   unchanged; do not sort or mutate a shared array again. Publish a new Dataset
   wrapper with current file metadata, build timestamp, and revision.
2. On `force: true`, cold start, missing snapshot, or unknown reuse safety, retain
   the complete existing rebuild path. Missing files produce empty components;
   corrupt quota produces empty quota, as today. Usage/spend read failures retain
   their existing failure behavior; never silently substitute an old snapshot.
3. On a non-forced rebuild, parse each changed component completely and reuse
   unchanged components. Usage changes still invoke the complete parser and sort.
   There is no byte-tail reader, aggregate cache, worker, watcher, or browser
   scheduling change in this experiment.
4. Pricing is a dependency of normalized usage, even when usage bytes are stable.
   Extend the existing optional pricing adapter to expose a generation only when
   it can prove stability for the loaded engine. For the inspected installation,
   that includes module identity and `userCostOverlayVersion()` from the same
   package/module instance. Unknown engines must re-normalize/reprice usage on a
   component rebuild; absence of a version API must never mean "unchanged".
   Keep force refresh repricing unconditionally. Do not add a new config-loading
   lifecycle or fix pre-existing overlay initialization within this performance PR.
5. Internal file fingerprints should include file identity and unrounded metadata
   sufficient to detect replacement/truncation, rather than relying on rounded
   mtime alone. Metadata cannot prove that adversarial same-metadata content did
   not change: full force reread remains the escape hatch. If metadata changes
   during read/build, do not cache a fingerprint for bytes whose provenance is
   uncertain; retry with a bounded full-read fallback or surface the failure.
   Cross-file atomic transactions are not provided by the current source files.
6. Preserve public endpoints, CSV, ordering, row limits, pricing/null conventions,
   malformed count, and query behavior. Keep `parse.durationMs` as the cost of the
   latest rebuild, including actual reused-component work; do not carry the old
   full-parse duration into a newly built dataset. It is rounded diagnostic data,
   not the primary high-resolution measurement.
7. Do not accidentally narrow revision invalidation to usage alone. Quota/spend
   changes must still invalidate existing response ETags. Forced rebuilds can
   currently retain the revision when file signatures are unchanged; do not
   claim that force itself guarantees an ETag change. Pricing-only revision
   behavior is a known issue to audit explicitly before claiming it is fixed.
8. Keep coalescing and failure recovery. A force request joining an already running
   non-forced build currently receives that same build: document/test this existing
   behavior. If stronger force guarantees are needed, make that a deliberate
   correctness fix, not an accidental benchmark advantage.

## Production benchmark harness to add in PR2

Use a **server-only HTTP harness**, proposed `scripts/refresh-benchmark.ts`, running
the actual Bun production entry `server/src/index.ts` on loopback with the built
Relay `web/dist`. Compile/build both revisions identically outside timed regions.
No Vite dev server, design-lab server, real user ledger, or browser automation is
needed. Supplement with in-process `getDataset()` timing for diagnosis, but label
that separately from HTTP end-to-end timing. Extend rather than treat
`scripts/benchmark.ts` as sufficient: it only measures cold Overview, 12 warm
requests, and one conditional request; it does not measure forced refresh.

Create synthetic homes at 98, 10,000, and 66,000 rows, using
`web/scripts/fixtureHome.ts` as the source. Materialize the fixture once at a fixed
epoch, expand unique request IDs deterministically, and reuse those exact bytes
across A/B. Existing generators use the current time; independently generating A
and B without fixing/copying the fixture is not a fair comparison. Use fixed
`from`, `to`, bucket, and metric query parameters. Freeze wall-clock time through a
benchmark-only process bootstrap when comparing time-dependent quota projections;
leave monotonic timing unchanged. Set `TZ` and `YALD_TZ` identically. Pin pricing
module/package hashes and record priced/unpriced counts. If pricing is unavailable,
report that explicitly and do not extrapolate its results to priced workloads.

Primary protocol: **50 paired trials per revision** at 66,000 rows, arranged in
alternating AB/BA order (100 measured samples total, 50 A and 50 B). No concurrent
A/B servers or competing builds. Each trial uses a fresh owned process/home,
primes its store and conditional Overview once, then performs one quota mutation
before the timed request. Have a deterministic sequence of quota states, including
an actual value/sample change, and give it distinct file metadata; restore the
same pre-mutation state for the paired trial. File writing, startup, and warmup
are excluded from primary latency and recorded separately. This is a warm-process,
warm-OS-cache changed-file experiment, not cold disk I/O.

Record two primary views of the same operation:

- **Store-sensitive polling probe:** after the quota mutation, time
  `GET /api/health` through complete body consumption. Check revision, row count,
  malformed count, and then verify new quota through a separate untimed response.
  The first request observes the change and therefore includes the rebuild.
- **User-facing API case:** in an independent restored/primed trial, apply the same
  mutation and time `GET /api/overview?...` with its previous ETag through complete
  body consumption. Expect 200 with changed quota and unchanged usage aggregates.
  Measure this separately from the health probe: running health first would warm
  the rebuild and invalidate the Overview measurement. Report the different
  aggregation floor rather than claiming the probe gain equals UI gain.

Use the same balanced protocol for secondary cases where a percentile is claimed:
spend-only change; unchanged conditional polling; usage append of 1 and 100 rows;
explicit force refresh with unchanged files; explicit force after a usage append;
full replacement/truncation; and cold process boot. At smaller sizes, label lower
sample-count probes exploratory if not expanded to 50 per revision. Test a
concurrent request burst separately; do not mix it into the serial primary sample.
For a complete server-side explicit-refresh sequence, time the force response
followed by the same active route/meta requests until every body is consumed.
Call this server refresh sequence, not browser rendering time.

Proposed invocation/options (not yet implemented):

```text
scripts/bun run scripts/refresh-benchmark.ts \
  --baseline <PR1-checkout> --candidate <PR2-checkout> \
  --rows 66000 --pairs 50 --order ab-ba \
  --scenario quota-only --endpoint health \
  --out <owned-results-directory>
```

Support `--endpoint overview`, scenarios above, `--seed`, `--epoch`, `--tz`,
`--pricing-package`, `--timeout-ms`, and an explicit concurrency option. Fail fast
on fixture/hash mismatches, wrong status, stale quota, or unexpected row counts.
Use monotonic unrounded durations through body consumption. Capture exit status,
timeouts, HTTP errors, invalid payloads, and correctness failures; never silently
rerun/drop a slow sample. Readiness probes must have timeouts and be excluded from
measured samples. Terminate only owned child processes and clean only owned homes.

Persist a JSONL record for **every attempted sample**, a manifest, and a summary.
Records should include revision, pair/order, scenario, fixture hashes/row counts,
pricing hash/status, query, status/ETag, latency, parse diagnostic, correctness
hash/result, timeout/error, and process identity. The manifest includes hardware,
OS, Bun, lockfile/build hash, seed, timezone, cache policy, excluded warmups,
background workload conditions, and start/end times. An optional common diagnostic
patch can count bytes read, rows normalized, pricing calls, and stages in both A/B;
measure its overhead separately and keep uninstrumented HTTP timing primary.

Report attempted/successful/failed n, nearest-rank p50/p95 of successful latencies,
errors/timeouts with their recorded elapsed values, paired absolute differences,
and `100 * (A - B) / A` only when positive/reproducible. Keep unrounded raw data;
round presentation only. Do not mix baseline and candidate samples or scenarios
into one percentile. Use a second balanced batch/session to confirm the result.
If distributions overlap substantially or the effect fails to repeat, report it
as inconclusive. Predeclare a materiality target (for example at least 20% and
10 ms lower primary API p50) as an experiment target, not an achieved result.
Investigate p95/control regressions rather than hiding them behind a p50 win.

## Correctness gates before publishing results

The existing analytics/API tests check aggregates, route shapes, DST heatmap
details, and one unchanged ETag. They do not exercise store reuse/invalidation,
file races, forced refresh, or concurrent force behavior. Add isolated-process
store/API parity tests to avoid cached module/environment state leaking across
homes. Compare B after each mutation with an independent full-parser A oracle.

- Quota-only and spend-only mutations leave **every RequestRow field**, line count,
  malformed count, tie order, and usage-derived API field identical while exposing
  the updated quota/ledger. No route may mutate reused arrays; freeze snapshots
  in correctness tests to catch this.
- Usage append, same-size rewrite, truncation, rename/rotation to a same-size file,
  deletion/recreation, missing files, and permission/read errors. Repeated refresh
  after failure must recover without publishing stale fingerprints. Metadata
  collision tests must exercise full force reread rather than assert that stat
  metadata proves byte identity.
- Complete final JSON without newline, torn final line then completion, consecutive
  blank lines, whitespace-only usage lines, CRLF, non-ASCII content, malformed
  middle lines, duplicate IDs, and out-of-order/equal timestamps. Preserve the
  current usage-vs-ledger differences in malformed-line handling.
- Pricing generation changes with unchanged usage and a changed quota/spend file,
  unavailable/unknown engine, estimated/unpriced rows, cache alias fields,
  long-context and service-tier resolution, top-level-vs-attempt usage recovery,
  retry tokens, and null vs zero values. Compare exact normalized price/rate fields
  against the existing adapter. Test a pricing-only force rebuild separately;
  explicitly assess the existing ETag behavior rather than ignoring it.
- Multiple callers observing one change, a force call joining a non-forced build,
  concurrent writes during reads, rejection followed by retry, and atomic publication
  of the composed snapshot. Test consistency without inventing cross-file atomicity.
- API payload parity for all eight tabs, conversation detail, heatmap date pagination,
  filters/search/ranges/groups, CSV exports, quota boundary baseline/burn projection,
  ledger totals, and conditional ETag 200/304 transitions. Exclude only declared
  diagnostic fields (parse duration/build timestamp) and path-dependent metadata;
  do not strip missing values, array ordering, or numeric discrepancies.

If a later byte-tail experiment is proposed, it additionally needs byte offsets
(not JS string lengths), split UTF-8 sequences, rollback/reparse of the previous
tail's valid/malformed contribution, stable merge for earlier timestamps, and
fallback for non-append edits. Deferring a torn line would change today's malformed
count; waiting for newline would drop today's valid final object. These cannot be
hand-waved as "append-only semantics".

## Browser verification boundary and deliverable

Do **not** execute `scripts/pane-benchmark.ts` during this task: it launches Chrome
and uses CDP, injected marks/observers, programmatic clicks, and runtime state.
Those are outside the CUA-only browser constraint. CUA read-only DOM evaluation
can inspect rendered content but must not inject timers, callbacks, instrumentation,
or access hidden app state. Tool round-trip timings are not browser performance
measurements. Therefore the selected server experiment has no fabricated browser
load/plot/interactive numbers.

Use CUA normally for desktop visual/content checks after PR2: all tabs, session
detail, actual changed quota/spend/usage values, filters, sorting, heatmap selection,
dark theme, and explicit Refresh. Save desktop screenshots as correctness evidence.
If chart-ready benchmarking becomes permitted later, use explicitly defined
first-accurate-plot and fully-interactive markers, check all expected plots/events,
50 balanced samples per case, cold/warm cache separation, and accurate resource
costs. Import overlap and SSR handoff remain separate experiments.

PR2 should contain the snapshot change, correctness tests, reproducible server
harness, raw manifest/summary links, and a narrowly worded measured claim, e.g.
"Automatic quota-change API refresh on a 66,000-row synthetic priced ledger:
p50 A → B ms, p95 C → D ms, n=50 per revision, zero correctness failures."
Fill numbers only from the actual repeatable results. Explicit force-refresh and
usage-append controls must be reported even if unchanged or slower. Preserve the
Relay visual parity evidence from PR1 and keep unrelated parser/worker/browser
optimizations out of the stack.
