# Performance investigation

Measured 2026-09-28 on this development Mac with Bun 1.4.2 and the repository's lockfile dependencies. The API benchmark uses a generated fixture expanded to 66,000 usage rows; it contains no personal ledger data. Bundle totals sum built JavaScript and CSS files and their gzip sizes. Baseline is clean `main` (`8838cfa`); both builds used the same installed dependencies.

## Bundle

| Measure | Main baseline | Feature branch | Change |
| --- | ---: | ---: | ---: |
| JavaScript + CSS, uncompressed | 1,541,569 bytes | 1,034,049 bytes | −33% |
| JavaScript + CSS, gzip | 489,412 bytes | 334,371 bytes | −32% |
| Initial app + Overview route JS, gzip (approx.) | 488,920 bytes | about 106,000 bytes | about −78% |

The baseline was one 1,517.54 KB JavaScript chunk (488.92 KB gzip). The updated build splits route modules and keeps the ECharts renderer in an async chunk; that renderer is 606.93 KB (204.00 KB gzip) and loads after the page has committed. Other views load only when selected. The default route starts with a roughly 110 KB gzip entry, Overview, chart-option, and icon chunks. This approximated initial-route total excludes CSS.

## API

The same synthetic 66,000-row input was used on baseline and the feature branch. Cold overview includes initial file parse and route aggregation. Warm latency is 12 requests without conditional headers; the conditional measurement repeats the same URL with its ETag.

| Measure | Main baseline | Feature branch |
| --- | ---: | ---: |
| Store parse reported by health | 128 ms | 119 ms |
| Cold `GET /api/overview?range=30d` | 352.06 ms | 377.09 ms |
| Warm overview p50 | 47.23 ms | 47.33 ms |
| Warm overview p95 | 68.04 ms | 58.02 ms |
| Unchanged request with `If-None-Match` | 200 in 45.63 ms | 304 in 0.14 ms |

These are single local runs, useful as an order-of-magnitude comparison rather than a production SLO. Warm p50 is effectively unchanged and p95 is lower in this run; cold-route variation is noisy. Conditional polling avoids route aggregation and response serialization for an unchanged dataset. A full rebuild still handles truncation and rotation.

## Browser first paint

Fresh headless Chrome runs used the same synthetic fixture and `PerformanceObserver` probe on the Overview route. Standalone runs measured 72–76 ms on baseline and 52 ms across two feature runs. The screenshot pipeline also measured 340 ms on the feature branch, showing substantial local scheduling variance. Every run recorded zero Long Tasks. Treat FCP as inconclusive from this local probe; it does not replace a user-device performance trace.

Reproduce the feature-branch API benchmark with `scripts/bun run scripts/benchmark.ts`. It creates and removes a temporary fixture home. To compare the original source, run the same script with a clean checkout of `main` and its matching dependencies.

## Recommendations

| Change | Effort | Expected gain | Recommendation |
| --- | --- | --- | --- |
| Route splitting, ECharts tree-shaking, and deferred renderer loading | Done | 156 KB gzip off the all-route bundle; about 383 KB gzip off the initial route | Keep the build size totals in release checks. |
| Revision/query ETags and pausing hidden-tab polling | Done | Repeated unchanged overview request measured 45.63 ms → 0.14 ms; hidden tabs make no scheduled requests | Keep conditional requests enabled for visible views. |
| Byte-offset tail parsing with full fallback on rotation/truncation | Medium | Avoid reparsing roughly 119 ms of work on append; depends on safe concurrent append semantics | Consider if ledgers grow or rebuild latency becomes user-visible. |
| Memoize price resolution by provider/model/tier | Medium | Could reduce per-row pricing during full rebuild; not isolated in this run | Profile the pricing stage before implementing. |
| Use `routing-history.sqlite` or derived SQLite aggregates | High | Could accelerate group-bys, but warm overview is already about 51 ms and the SQLite mirror may lag | Defer until a specific route is measured above budget. |
| Browser Long Task API sampling on first paint | Done | Zero Long Tasks in all local runs; FCP varied from 52 to 340 ms on the feature build | Capture traces on representative user devices before drawing conclusions about FCP or changing UI work scheduling. |
