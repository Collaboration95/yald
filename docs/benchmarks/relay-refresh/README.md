# Relay automatic refresh experiment

Measured 2026-10-02 on Apple M5 / 32 GiB / macOS kernel 25.6.0 / Bun 1.4.2.
The baseline is the completed Relay UI commit `66fa67d`; the candidate changes only
server component snapshots. Both builds have identical frontend asset hashes.
The synthetic usage file contains 66,000 unique requests and 90,959,210 bytes.
All timestamps are frozen at `2026-10-02T10:00:00Z`, with Asia/Singapore bucketing.
Pricing uses the same installed opencodex 2.75.0 engine, including unpriced models.
No personal ledger is used or published.

## Result

The first balanced batch lowers quota-change Overview HTTP p50 from **248.46 ms
to 121.85 ms (51.0%)**, and p95 from **261.15 to 130.22 ms**. These timings include
observing the quota mutation, rebuilding the dataset, route aggregation, and
complete response transfer. The aggregation floor remains; the health probe's
larger gain must not be presented as a page-load improvement.

The independent repeat gives **243.79 → 118.97 ms (51.2%)** at p50 and
**256.21 → 123.30 ms** at p95. The predefined materiality target passes twice.
Both batches together have **1,200 successful observations, zero errors and
zero A/B payload mismatches**. Keep the batches separate when quoting percentiles.

## Batch 1

Each scenario has 50 fresh-process observations per revision, in alternating
baseline/candidate and candidate/baseline pairs. Errors: **0/600**. Every pair's
complete Overview payload hash matches; expected quota, spend, row counts,
malformed counts, HTTP status, and conditional ETag transitions pass.

| Scenario | Baseline p50 / p95 ms | Candidate p50 / p95 ms | Interpretation |
| --- | ---: | ---: | --- |
| Quota change → health | 126.59 / 131.99 | 0.38 / 0.47 | Unchanged usage parsing/pricing/sort avoided |
| Quota change → Overview | 248.46 / 261.15 | 121.85 / 130.22 | 51.0% lower p50; aggregation still required |
| Spend change → health | 126.15 / 135.97 | 0.41 / 0.47 | Unchanged usage parsing/pricing/sort avoided |
| Unchanged conditional Overview | 0.15 / 0.22 | 0.15 / 0.26 | Existing 304 path; no claimed gain |
| Append one usage row → health | 125.60 / 132.30 | 124.98 / 143.82 | Full parse retained; candidate p95 11.52 ms higher |
| Explicit forced refresh | 124.68 / 140.61 | 126.39 / 142.29 | Full rebuild retained; no claimed gain |

Raw evidence: [manifest](batch-1/manifest.json), [all samples](batch-1/samples.jsonl),
[unrounded summary](batch-1/summary.json). Slow samples are retained: Overview's
baseline maximum is 509.34 ms; forced-refresh maxima are 235.29 / 357.67 ms.
The repeat batch below checks the primary result and control-tail differences.

## Batch 2: independent repeat

The same protocol, fixture and source/build hashes; 50 observations per revision
per scenario. Errors: **0/600**. Every complete Overview payload hash matches.

| Scenario | Baseline p50 / p95 ms | Candidate p50 / p95 ms | Interpretation |
| --- | ---: | ---: | --- |
| Quota change → health | 124.69 / 132.51 | 0.37 / 0.48 | Store-work avoidance repeats |
| Quota change → Overview | 243.79 / 256.21 | 118.97 / 123.30 | 51.2% lower p50; repeats primary gain |
| Spend change → health | 125.81 / 191.55 | 0.40 / 0.48 | Store-work avoidance repeats |
| Unchanged conditional Overview | 0.15 / 0.18 | 0.14 / 0.16 | Existing 304 path; sub-ms differences inconclusive |
| Append one usage row → health | 124.43 / 146.75 | 124.90 / 138.08 | Full parse retained; p95 difference reverses |
| Explicit forced refresh | 124.25 / 130.92 | 124.58 / 128.89 | Full rebuild retained; no claimed gain |

Raw evidence: [manifest](batch-2/manifest.json), [all samples](batch-2/samples.jsonl),
[unrounded summary](batch-2/summary.json). No slow samples were discarded; the
candidate usage-append maximum is 390.08 ms and the baseline spend maximum is
381.77 ms. These outliers and the control-tail reversal show variability in local
runs. The measurements cannot attribute an individual outlier to a cause.
No persistent control p95 regression appears across the two batches. Their p50
changes are below 2 ms; further full-parser optimisation remains a separate task.

## Method and scope

This is uninstrumented loopback HTTP timing through complete body consumption,
using the actual production app, including its explicit refresh route. Every
sample has its own process, a restored identical fixture, and primed Overview and
health requests. File copy/mutation, boot, priming, JSON decoding, and subsequent
correctness checks are outside the measured interval. Health and Overview are
independent trials: the health probe cannot warm away Overview's rebuild.
Processes run serially; OS file caches are warm. App and frontend build hashes
are checked before and after each batch. No test/build runs overlap measurements.

Percentiles use nearest rank. Raw samples retain unrounded timings, process IDs,
statuses, ETags, parse diagnostics, correctness hashes, and every error attempt.
The manifests record hardware, runtime, pricing/source/fixture/build hashes,
epoch, timezone, ordering, cache policy, and excluded work. The predefined primary
target is at least 20% and 10 ms lower Overview p50, confirmed in a second batch.

No browser reload, first plot, interaction, cold disk, cold boot, concurrent
throughput, or complete UI Refresh sequence is measured. Automatic quota/spend
updates benefit; usage appends and the explicit Refresh button still use full
parsing. Existing lazy routes, ECharts imports, price memoization, ETags, and
hidden-tab polling are not new optimisations in this change. Desktop visuals and
original content remain those verified in [PR1](../../relay-ui/README.md).

Final CUA desktop observations on the candidate match all nine pages' chart and
metric counts, section titles, table columns/row counts, and lack of page overflow
([structural evidence](desktop-parity.json)). An owned fixture mutation displays
82% weekly quota, 97 settled sends / 4.7M settled tokens, and 99 requests / 4.5M
tokens. The explicit Refresh updates the ledger header and active view; restoring
the fixture returns 98 requests. Light/dark desktop rendering is checked again.
These are correctness observations, with no UI timing claim.

## Correctness and pricing boundary

Independent usage, spend, and quota snapshots are keyed by device/inode/size and
nanosecond mtime/ctime. Only the changed components are replaced. Sorted usage
rows are never mutated or sorted again while reused. Before/after fingerprints
and pricing generations must match; moving files allow three attempts. Failed
builds publish neither a composed dataset nor a partial snapshot. Missing files,
malformed usage, torn tails, corrupt quota, and full force retain their parser
semantics. Unknown pricing generations always reparse usage on a component change.

Usage reuse is enabled only for the audited 13-source pricing fingerprint
`fa56531a6b4dba32a97f9aaea863ebdcb41f4f93623b8b3e203ef1aaf47bf154`, checked around
module loading. It follows that cost module's own overlay registry import and
reads its version from the same module instance. The version covers mutable user
rates, configured provider namespaces, and account pricing identities; catalog,
tier, and identity tables are process-stable ESM state. Unknown, bundled, or newer
source revisions keep normal pricing and conservative reparsing. A dependency
upgrade requires a new source audit to enable usage reuse; disk upgrades require
restart. This guard does not introduce config loading or model discovery.

21 snapshot tests exercise every normalized row field and all tab/detail APIs,
heatmap pagination, filters, CSV, and ETags against an independent cold full-parser
oracle. Synthetic store-contract tests explicitly mock only the pricing-generation
signal; separate unmocked tests verify the installed engine's reuse/repricing and
the rejection of an unaudited lookalike. Additional cases cover frozen arrays,
ties/duplicates, CRLF/Unicode, append/rewrite/truncate/rotate/delete/recreate,
read errors, bounded disappearance retries, concurrent readers, and recovery.
Together with chart/analytics tests: **60 passing tests, 1,269 assertions**.

Existing limits remain: file-only fast-path reads do not notice a pricing-only
registry change; force is required. Unchanged-file force keeps its revision and
ETag, including the pre-existing pricing-only ETag limitation. A force request
joining an active build receives that build. Fingerprints cannot establish byte
identity against adversarial metadata collisions, and independently written
files do not become a cross-file transaction.

## Reproduce

Check out PR1 at `66fa67d` in a separate directory, install the same lockfile
dependencies, and build both checkouts. Use the same inspected pricing package.
Run from the candidate checkout:

```sh
scripts/bun run scripts/refresh-benchmark.ts \
  --baseline /absolute/path/to/relay-pr1 \
  --candidate /absolute/path/to/relay-pr2 \
  --pricing-package /absolute/path/to/opencodex \
  --rows 66000 --pairs 50 --out /absolute/path/to/new-results
```

Repeat with a new output directory. Outputs refuse overwriting an existing run.
Optional `--scenarios` selects comma-separated scenario names shown in the JSON
summary; `--epoch`, `--tz`, and `--timeout-ms` control the common fixture clock,
timezone, and timeout. The runner creates and cleans only its own temporary homes
and server processes. Startup/API failures, mismatched payloads, unavailable real
pricing, and changes to measured source/build files fail the batch and preserve
attempted records. Unit/API parity can select the frozen oracle with
`YALD_SNAPSHOT_BASELINE=/absolute/path/to/relay-pr1 scripts/bun test`.

The [premeasurement plan](../../performance-experiment-plan.md) retains the deferred
browser, incremental-parser, worker, and SSR experiments. Its proposed extra
scenarios are not claims of measurements performed here.
