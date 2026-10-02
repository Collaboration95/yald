# Performance investigation

The [2026-10-02 refresh experiment](benchmarks/relay-refresh/README.md) adds balanced before/after results for per-file
snapshot reuse on the frozen Relay UI. The measurements below are historical investigations of earlier implementations;
their mobile checks and browser probes do not describe the desktop-only Relay change.

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

## Pane switching (issue #11)

Reproduce with `scripts/bun run scripts/pane-benchmark.ts`. The script requires Bun and Chrome/Chromium (`CHROME_BIN` can select the executable). It starts the built app against a temporary synthetic fixture and removes the fixture and browser profile on exit. It exercises all eight sidebar routes at 98, 10,000, and 66,000 synthetic usage rows. The 98-row fixture is the base fixture; larger fixtures repeat its synthetic rows with unique request IDs. Before each direct route load it clears Chrome's browser cache. For each pane it records one cold direct-navigation-to-useful-content sample, then five warm clicks from another pane. “Active” means the destination heading and active sidebar link have updated. “Useful” additionally requires more than 50 characters of rendered main content. Warm p50/p95 use nearest-rank percentiles over those five click samples. Each fixture also checks heatmap pointer and keyboard selection, date/timezone display, Requests metric and keyboard slider changes, dark theme, and 390 px responsive overflow. The default run waits 31 seconds per fixture to observe visible polling; set `YALD_BENCH_SKIP_POLLING=1` to skip that wait, and `YALD_BENCH_ROWS=98` to run only the small fixture.

The run below was captured 2026-09-29 on the development Mac (Apple Silicon, Bun 1.4.2, Google Chrome 154.0.8037.58), using `web/dist` built from the working tree based on `65dda0e` (including the heatmap UI changes). The benchmark readiness loop polls over CDP every animation frame, so warm measurements have browser scheduling granularity. Treat close results as ties. These are local headless-browser measurements, not user-device timings or production SLOs.

| Rows | Pane | Cold to useful (ms) | Warm active p50 / p95 (ms) | Warm useful p50 / p95 (ms) |
| ---: | --- | ---: | ---: | ---: |
| 98 | Overview | 347.6 | 35.0 / 36.5 | 35.6 / 37.6 |
| 98 | Usage | 350.6 | 33.7 / 40.5 | 34.3 / 41.1 |
| 98 | Cost & spend | 335.9 | 33.1 / 43.5 | 34.8 / 44.0 |
| 98 | Performance | 340.6 | 34.0 / 34.8 | 34.5 / 35.3 |
| 98 | Reliability | 339.6 | 30.4 / 32.7 | 30.7 / 33.1 |
| 98 | Models | 321.4 | 30.4 / 33.9 | 30.8 / 34.4 |
| 98 | Quota | 340.7 | 30.3 / 31.4 | 30.6 / 31.8 |
| 98 | Conversations | 336.2 | 30.5 / 30.8 | 30.8 / 31.1 |
| 10,000 | Overview | 341.3 | 31.9 / 64.7 | 32.2 / 66.3 |
| 10,000 | Usage | 371.1 | 34.4 / 35.8 | 36.3 / 37.6 |
| 10,000 | Cost & spend | 345.5 | 33.0 / 38.9 | 33.4 / 39.5 |
| 10,000 | Performance | 336.5 | 49.7 / 52.6 | 51.8 / 53.2 |
| 10,000 | Reliability | 345.5 | 32.1 / 34.4 | 32.4 / 34.7 |
| 10,000 | Models | 335.1 | 32.9 / 33.7 | 33.3 / 34.0 |
| 10,000 | Quota | 344.7 | 32.7 / 38.3 | 33.1 / 39.0 |
| 10,000 | Conversations | 342.2 | 30.9 / 32.5 | 31.2 / 32.8 |
| 66,000 | Overview | 342.5 | 39.7 / 65.6 | 40.4 / 69.5 |
| 66,000 | Usage | 499.0 | 33.1 / 36.2 | 33.9 / 42.3 |
| 66,000 | Cost & spend | 480.5 | 33.2 / 38.7 | 33.7 / 41.7 |
| 66,000 | Performance | 390.7 | 50.8 / 58.5 | 52.8 / 61.3 |
| 66,000 | Reliability | 372.2 | 30.9 / 32.6 | 31.4 / 33.0 |
| 66,000 | Models | 355.7 | 30.0 / 30.5 | 30.3 / 31.1 |
| 66,000 | Quota | 371.1 | 29.7 / 31.7 | 30.1 / 32.0 |
| 66,000 | Conversations | 329.4 | 29.7 / 29.8 | 30.0 / 30.2 |

The cold navigation sample includes initial document startup and useful-content readiness; it is one sample per pane and has no meaningful p95. Resource Timing records identify loaded JavaScript chunks and API paths on cold navigation. The warm click records resources initiated after the click. When query data or modules are already cached, warm clicks may initiate no API request or route download, so resource timing does not prove which work caused the observed delay. The content-ready condition is deliberately semantic and lightweight: it does not require all charts to finish painting.

The instrumented rerun observed no Long Tasks before useful content at any fixture size. It recorded route/API resource timings and renderer-chunk/canvas presence. The renderer chunk was absent at useful-content time for all eight panes in the 66,000-row fixture, and no pane had a canvas at that point, consistent with chart work continuing after the primary content is available. For panes with charts, canvases were present by later warm samples; Conversations has no chart canvas. This does not measure React commit, `setOption`, resize, or chart disposal duration; those ECharts internals are not instrumented.

### Findings for issues #12 and #13

Proposed warm-switch target: p95 below 100 ms from click to the destination heading/active link and useful main content. The maximum observed per-pane useful-content p95 was 44.0 ms with 98 rows, 66.3 ms with 10,000 rows, and 69.5 ms with 66,000 rows. The browser observes state changes on animation frames, so the remaining margin is more meaningful than small differences between panes. Cold direct-navigation-to-useful-content was about 321–499 ms; it includes a fresh document startup and is not a cold sidebar-click measurement. On cold navigations, route chunks took about 1–3 ms and API resources about 2–18 ms in this run. These timings do not identify initial React startup cost precisely.

No route or query prefetch was added for #12: warm switching is within the proposed target, and the captured route/API transfer timings do not show a material wait that justifies extra prefetching. No chart lifecycle change was added for #13: no Long Tasks occurred before useful content, the renderer/canvases were not prerequisites for that content marker, and warm useful-content p95 stayed below 70 ms. The browser run does not provide ECharts-internal timings or a cold first sidebar-click trace; if either is slow on a representative user device, capture that trace before changing chart or route scheduling.

The 98-row browser interaction check selected a cell with pointer input and moved to another hour with the keyboard, then confirmed the dated detail showed `2026-09-26 – 2026-09-29 (Asia/Singapore)`. Requests mode exposed a 0–3 slider; ArrowRight raised its value to 1 and updated the matching-cell count. Dark mode toggled successfully. At a 390 px viewport the document width was 380 px; the wide breakdown table remained in its own horizontal scroll area.

The explicit refresh button completed in 28.6 ms, 26.6 ms, and 136.5 ms at 98, 10,000, and 66,000 rows respectively; its request timing was 1.5 ms, 23.1 ms, and 125.3 ms. A 31-second visible-page window observed one `/api/conversations` poll at each fixture size. Hidden-tab suppression was not separately measured because this run kept one browser target visible; the app's `refetchIntervalInBackground: false` setting is code evidence, not a measured hidden-page result. Each fixture size has only one refresh and polling observation, so those values have no percentile estimates. The 66,000-row refresh is the clearest fixture-size-related increase in this run; the sample is too small to infer a general scaling curve.

## Recommendations

| Change | Effort | Expected gain | Recommendation |
| --- | --- | --- | --- |
| Route splitting, ECharts tree-shaking, and deferred renderer loading | Done | 156 KB gzip off the all-route bundle; about 383 KB gzip off the initial route | Keep the build size totals in release checks. |
| Revision/query ETags and pausing hidden-tab polling | Done | Repeated unchanged overview request measured 45.63 ms → 0.14 ms; hidden tabs make no scheduled requests | Keep conditional requests enabled for visible views. |
| Byte-offset tail parsing with full fallback on rotation/truncation | Medium | Avoid reparsing roughly 119 ms of work on append; depends on safe concurrent append semantics | Consider if ledgers grow or rebuild latency becomes user-visible. |
| Memoize price resolution by provider/model/tier | Medium | Could reduce per-row pricing during full rebuild; not isolated in this run | Profile the pricing stage before implementing. |
| Use `routing-history.sqlite` or derived SQLite aggregates | High | Could accelerate group-bys, but warm overview is already about 51 ms and the SQLite mirror may lag | Defer until a specific route is measured above budget. |
| Browser Long Task API sampling on first paint | Done | Zero Long Tasks in all local runs; FCP varied from 52 to 340 ms on the feature build | Capture traces on representative user devices before drawing conclusions about FCP or changing UI work scheduling. |
