# Original UI content inventory for Relay adoption

Source audit: 2 October 2026. This is an inventory and acceptance checklist, not a browser verification report. Boxes remain unchecked until both replicas have been exercised. No optimization is part of this task.

Both design shells must render the same production page components and analytics. A styled Overview alone, anchor links to Overview widgets, static screenshots, and hardcoded sample figures do not satisfy parity. Every tab must have its full route content, controls, data, and nested detail. Additional design elements may supplement this content; they must not replace it.

## Counts and route map

Counts describe render sites when their data/conditions permit them, not the number guaranteed for an empty fixture. `Stat` cards are separate from the headed sections. Tables count rendered instances: Usage's reusable breakdown table appears three times. The Models matrix and Usage detail table are conditional.

| Production route | Component | Stat cards | Headed sections | ECharts | Tables |
| --- | --- | ---: | ---: | ---: | ---: |
| `/` | OverviewPage | 6 | 9 | 4 | 1 |
| `/usage` | UsagePage | 4 | 8 | 5 | 4, including selected-cell dates |
| `/cost` | CostPage | 5 | 7 | 5 | 1 |
| `/performance` | PerformancePage | 6 | 9 | 6 | 2 |
| `/reliability` | ReliabilityPage | 5 | 7 | 4 | 2 |
| `/models` | ModelsPage | 0 | 6 | 3 | 2, including matrix |
| `/quota` | QuotaPage | 4 | 8 | 3 | 1 |
| `/conversations` | ConversationsPage | 4 | 1 | 0 | 1 |
| `/conversations/:id` | ConversationDetailPage | 6 | 3 | 2 | 1 |
| **Total per design** | **8 main tabs + detail** | **40** | **58** | **32** | **15** |

Additional visual data must survive: Overview has three KPI sparklines and one throughput-card sparkline; Performance has one CSS context histogram; Quota has one SVG utilisation gauge per current window; Models has an effort/model intensity matrix; lists contain progress bars and semantic badges. These are not included in the ECharts count.

Routing source: [main.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/main.tsx). Unknown routes redirect to Overview. Conversation detail shares a module with the list but is a separate route.

## Shared shell, filters, and state

Sources: [Layout.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/components/Layout.tsx), [useFilters.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/lib/useFilters.tsx), [api.ts](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/api.ts), [theme.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/lib/theme.tsx), [ui.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/components/ui.tsx).

- [ ] All eight navigation destinations remain accessible at desktop and phone sizes, with correct active state. Production currently hides the sidebar below `lg` and supplies no alternative mobile navigation; do not carry that omission into a purported complete replica.
- [ ] Preserve headings/subtitles for Overview, Usage, Cost & spend, Performance, Reliability, Models, Quota, Conversations. Detail currently falls back to shell heading `yald`; its own ID and back link remain visible.
- [ ] Preserve ledger metadata: all-time requests, tokens, last-request relative update time, and pricing available/unavailable status from `/api/meta`. These are not the selected-window totals.
- [ ] Keep five range choices: `24h`, `7d`, `30d`, `90d`, `All` (`all`). Default is `30d`.
- [ ] Keep four multi-select filter menus: Provider, Model, Effort, Outcome (`ok`, `error`, `cancelled`). Provider/model/effort options come from meta. Selected counts and active styles remain evident. Empty menus show `No options`.
- [ ] Keep `Clear` when at least one list filter is selected. Production reset removes all parameters and sets `range=30d`; search alone does not make Clear appear.
- [ ] Keep global search (`Search model, error, id…`), refresh (`Re-read the opencodex ledgers`), and theme toggle. Refresh calls `/api/dataset/refresh`, then invalidates queries. Do not wire a decorative refresh icon to a no-op.
- [ ] Preserve URL-backed range, providers, models, efforts, statuses, groupBy, metric, bucket, search. List values are comma-separated. Updates replace search history rather than push an entry per change. Sidebar links carry the existing query string.
- [ ] Theme context must continue feeding ECharts options, not only CSS surfaces. Light/dark preference uses `yald-theme` with legacy-key migration and OS fallback.
- [ ] Keep loading, errors and empty states in every card. `StateBlock` precedence is loading → error → empty → children; labels are `Loading`, `Could not load data` + error text, and default `No data for this window`. Query data can coexist with an error, but StateBlock currently shows the error.
- [ ] Preserve table containment and horizontal scrolling. `TableShell` uses a minimum 560px table width and an internal scroll wrapper; some pages add vertical caps. Do not clip trailing columns to achieve a cleaner screenshot.
- [ ] Preserve actual interactions in Segmented, Popover and CheckList. Popovers close on outside mousedown and Escape. Lists remain multi-select. Preserve keyboard access and focus contrast when restyling.
- [ ] Keep Stat value, hint, delta, tone and spark data. Deltas multiply by 100; null is `—`, undefined omits the delta. `inverse` makes lower latency favorable; `none` makes the delta neutral. Spark needs more than one value.
- [ ] Keep precise formatting rules: null/undefined/nonfinite values are `—`; ratios are percent, quota usedPercent is already percent; durations are milliseconds converted for display; positive sub-cent USD values have four decimals; unknown prices are not known zero prices.

## Overview — `/`

Source: [Overview.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/pages/Overview.tsx). Endpoint/type: `/api/overview`, `OverviewResponse`. Six stats, nine headed sections, four ECharts, one table.

- [ ] **Six stats:** Requests (ok/failed hint, requests delta, requests spark); Tokens (input/output hint, tokens delta/spark); Estimated cost (priced/unpriced request counts, cost delta/spark); Success rate (client-closed count, success-rate delta); Median TTFT (p95 and TTFT coverage, inverse delta); Cache savings (input cache hit rate, hit-rate delta).
- [ ] **Usage over time:** stacked area, selected metric over bucket labels, model/provider/effort groups; subtitle shows bucket and filtered request count. Controls: Tokens / Cost / Requests and Model / Provider / Effort. API retains top six groups plus `Other` when positive. ECharts height 288. Empty if no data or no buckets; a filled zero series is not treated as missing.
- [ ] **Cost composition:** donut and per-token-class legend for Fresh input, Cache read, Cache write, Output; estimated center total; cache savings callout and cached-read-token explanation; unpriced requests exclusion note. `Details` links to Cost carrying query string. Height 172. Empty if composition total is zero; the exclusion note is inside StateBlock and therefore currently disappears in the all-unpriced zero-total case.
- [ ] **Model leaderboard:** up to six models; model tag, tokens, cost, token-share bar, percent of tokens, success and median duration. `All models` links to Models carrying query string. No replacement with only a model-share donut.
- [ ] **Activity heatmap:** seven weekdays × 24 hours = 168 cells, Tokens / Requests, minimum-activity slider, live matching-cell count, quiet/peak scale with units. Threshold resets with heatmap metric or filter changes; low cells are faded, not deleted. Height 196. Empty when max activity is zero. Overview has no selected-cell date drilldown; do not confuse it with Usage's richer heatmap.
- [ ] **Quota:** every reported account/window, used-percent progress, reset countdown or `no reset reported`, matching burn (`no data in range`, positive %/day, or `flat`) and exhaustion-before-reset warning. `Details` retains query string. Empty label `No quota samples recorded`.
- [ ] **Recent requests:** newest 25 API rows, all retained. Seven columns: **When, Model, Tokens, Cost, TTFT, Total, Status**. Model includes provider; Cost uses `priced` (`unpriced` otherwise); Total means full duration, not total tokens; status dot plus raw code. This table does not currently open request detail.
- [ ] **Context pressure:** eight input-size bins, counts plus p50/p95/max input; height 148. It is separate from the usage volume chart.
- [ ] **Biggest conversations:** top eight token-ranked sessions, ID link, tokens and request count; `All` links to list carrying search parameters. Individual ID links currently omit search parameters.
- [ ] **Throughput & latency:** output tokens/sec p50, token sparkline, latency p95 with p50 hint, upstream sends, conditional retry-overhead token badge, metering coverage. The sparkline is token volume, not a speed timeline.
- [ ] Keep footer sources (`usage.jsonl`, `spend-ledger.jsonl`, `codex-quota-cache.json`) and query recomputation relative time.

## Usage — `/usage`

Source: [Usage.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/pages/Usage.tsx). `/api/usage` supplies selected metric/grouping and a separate token heatmap query. Types: `UsageResponse`, `UsageHeatmapDatesResponse`. Four stats, eight headed sections, five ECharts, three breakdown tables plus conditional dates table.

- [ ] **Four stats:** Total tokens (cached amount); Output tokens (share of total); Reasoning tokens (share of output); Cache hit rate (cache-read amount).
- [ ] **Token composition:** stacked area of Cache read, Fresh input, Output, Reasoning; all-zero series are omitted. Input already includes cache reads; explanatory subtitle survives. Height 272, empty if no composition buckets.
- [ ] **Cache efficiency:** line chart with cache hit rate ×100 and dashed Savings (USD); height 272. Both current series/data survive; do not drop one to avoid the existing mixed-units issue.
- [ ] **Grouped volume:** stacked area, height 260. Five metric options: Total (`tokens`), Input, Output, Cache, Requests. Four group options: Model, Provider, Effort, Account. API retains top eight groups plus positive `Other`. `reasoningTokens`/`route` occur in casts/API capabilities, but are not visible choices here.
- [ ] **Activity heatmap:** Tokens / Requests, minimum slider, matching count out of 168, explicit scale, pointer selection, 168 accessible keyboard cells with value/request labels. Arrow keys move ±1 hour or ±24 weekday positions clamped 0–167; roving tabIndex and visible focus panel survive. Height 230. Zero activity shows `No activity for these filters` and disabled slider.
- [ ] **Selected heatmap cell dates** nested inside Activity heatmap: weekday/hour, date window with server timezone, `Ranked dates by` selected unit; Clear selection; loading dates; error + Try again; no-dates message; selected-cell total and shown/total-date counts. Table columns **Date, Tokens or Requests, Requests**. If Requests mode, the last two headings are both Requests in current code. Twenty rows per page; Reveal more dates appends pages, disabled/loading while fetching. No automatic detail polling. Selection, offsets and accumulated rows reset on filter/metric changes. Ranked descending by value, ties by descending date. API validates weekday 0–6/hour 0–23; limit max 100, client requests 20.
- [ ] **Context pressure:** eight-bin input distribution; p50/p95/max input; height 180.
- [ ] **By model**, **By effort**, **By route & provider:** three independent breakdown tables with six columns: **Model/Effort/Dimension, Req, Tokens, Share, Cost, p50**. Each caps at 12 displayed rows and has a 300px vertical cap. Third concatenates route rows then provider rows before slicing, not a single recomputed dimension. Zero cost displays `—`. Model/effort cards empty when their arrays are empty; route/provider card checks only data presence.

## Cost & spend — `/cost`

Source: [Cost.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/pages/Cost.tsx). `/api/cost`, `CostResponse`. Five stats, seven headed sections, five ECharts, one table.

- [ ] **Five stats:** Estimated cost (priced request count); Cost / 1M tokens (cost ÷ all tokens ×1M, blended token classes); Cache savings (full-input-price comparison); Output spend (share of composition total); Unpriced share (unpriced requests ÷ all requests).
- [ ] **Spend over time:** stacked bars; Model / Provider / Effort grouping; eight groups plus positive Other; USD precision; height 268.
- [ ] **Where the dollars go:** donut, estimated total, four token classes and legend; height 196. Empty when composition total is zero.
- [ ] **Cumulative spend:** cumulative line/area plus dashed per-bucket cost; height 236.
- [ ] **Cache savings over time:** savings line/area, no legend; height 236.
- [ ] **Blended price per 1M tokens:** horizontal labeled bars for models with positive costPer1MTokens, max ten; dynamic height >=180, 26px per model +40. Current source order is token-ranked, despite subtitle `Cheapest to most expensive`.
- [ ] **Most expensive sessions:** ten API sessions; ID link, cost bar relative to first, request count and tokens. API first takes the top 50 sessions by tokens, then sorts that subset by spend and keeps ten; this is not necessarily the global cost top ten.
- [ ] **Cost by model:** all returned model rows; seven columns **Model, Requests, Tokens, Cost, Cost / 1M, Share, Unpriced**. Share is costShare; Unpriced is unpriced request count or `—`. Price-overlays explanation remains. Export CSV uses `/api/export` with current filters and `dataset=models`.
- [ ] Preserve all-unpriced distinction: table can show zero known cost, null blended price and positive unpriced count; donut can be empty. Do not infer free/subscription semantics solely from zero cost.

## Performance — `/performance`

Source: [Performance.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/pages/Performance.tsx). `/api/performance`, `PerformanceResponse`. Six stats, nine headed sections, six ECharts, two tables, one additional CSS histogram.

- [ ] **Six stats:** TTFT p50 (coverage); TTFT p95; Latency p50; Latency p95; Latency p99; Output tok/s p50 (mean hint).
- [ ] **Latency and first-token timeline:** four lines **Latency p50, Latency p95, TTFT p50, TTFT p95**; TTFT p95 dashed; bucket badge; height 280. Subtitle says dashed lines are TTFT, although TTFT p50 is currently solid.
- [ ] **Generation speed over time:** median output tok/sec line/area, height 220, no legend.
- [ ] **Latency distribution:** eight duration bins **<1s, 1–2.5s, 2.5–5s, 5–10s, 10–20s, 20–40s, 40–80s, 80s+**; height 220. Values are counts despite subtitle saying share.
- [ ] **TTFT distribution:** seven bins **<0.5s, 0.5–1s, 1–2s, 2–4s, 4–8s, 8–16s, 16s+**; height 188.
- [ ] **Throughput distribution:** seven bins **<5, 5–10, 10–20, 20–40, 40–80, 80–160, 160+** tok/s; height 188.
- [ ] **TTFT vs output length:** scatter, x TTFT, y output tokens, model groups; API newest 2,000 eligible rows (non-null TTFT, positive output); client keeps six models ranked by point count; height 188. Keep both caps and sampling disclosure.
- [ ] **Slowest requests:** API top 15 by descending duration, six columns **When, Model, TTFT, Total, Out, Status**; provider tag and outcome dot; Total is duration.
- [ ] **Performance by model:** client first 12 token-ranked models; six columns **Model, Req, TTFT p50, p50, p95, tok/s**.
- [ ] **Context pressure:** CSS histogram for all eight input-size bins with count and share-height bars (minimum height 4px, including zero bins); p50 input, p95 input, max input. This is a real data visualization, not disposable decoration.
- [ ] Keep percentile/TTFT coverage footnote. Null TTFT/duration metrics remain `—`. Timeline empty checks points; distribution/scatter/context cards mostly check data presence, so data with no eligible observations can produce empty axes rather than a generic empty block.

## Reliability — `/reliability`

Source: [Reliability.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/pages/Reliability.tsx). `/api/reliability`, `ReliabilityResponse`. Five stats, seven headed sections, four ECharts, two tables.

- [ ] **Five stats:** Requests (failed count); Success rate (client-closed count); Distinct errors (top code); Retried requests (attempt count >1); Metered (coverage, unreported+unsupported hint).
- [ ] **Outcomes:** donut, success center label, count legend, success/failure/cancellation identities; height 180.
- [ ] **HTTP status codes:** horizontal labeled count bars, first eight statuses sorted by frequency; 2xx green, 4xx warning, otherwise red; height 180.
- [ ] **Attempts per request:** histogram of all returned attempt-count groups; height 180.
- [ ] **Outcomes over time:** daily stacked counts of ok, cancelled, error; height 240. Not all-zero padded for days without rows.
- [ ] **Error breakdown:** all error groups (true errors, excludes cancellations); five columns **Error, Count, Models, Last seen, Tokens burned**. Zero burned tokens shows `—`; Models is a distinct count. Empty on no errors.
- [ ] **Failure rate by model:** first ten by failure count, failures/requests/rate plus normalized warning/red bar. Here failures include non-ok cancellations; preserve the analytics distinction from Error breakdown.
- [ ] **Recent failures:** API takes last 500 non-ok rows, sorts newest first, returns 40; six columns **When, Model, Error, Attempts, Waited, Status**. Error uses errorCode → closeReason → `unknown`; raw status and duration; billing/upstream warning explanation remains.
- [ ] Keep zero/no-data cases: current Requests/Success stats initialize as zero before data; distinct-error/retried/metered values can be `—`. Outcome/status/attempt cards check data existence, not nonempty arrays.

## Models — `/models`

Source: [Models.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/pages/Models.tsx). `/api/models`, `ModelsResponse`. No top Stat cards, six headed sections (matrix conditional), three ECharts, two tables.

- [ ] **Price vs time-to-first-token:** bubble scatter: TTFT p50 vs USD/1M tokens; bubble size total tokens; only positive price and non-null TTFT entries; height 300. It is a single `Models` series, not per-model labeled series in current implementation. Empty guard uses unfiltered scatter length; an all-unpriced dataset can show blank axes.
- [ ] **Tokens by provider:** all provider rows, horizontal bars, height 300.
- [ ] **Tokens by model:** token-ranked top 12, horizontal bars; height clamped 220–420 using 30px per model +40.
- [ ] **Effort mix:** all efforts; tokens/share, share bar, median duration, output tok/s, success rate.
- [ ] **Model comparison:** all returned models; 11 columns **Model, Req, Tokens, Share, Cost, $/1M, TTFT p50, p50, tok/s, Success, Cache**. Share is token share, Cache is cacheHitRate. Eight sortable numeric columns: Req, Tokens, Cost, $/1M, TTFT p50, p50, tok/s, Success. Default tokens descending; switching to TTFT/p50/price defaults ascending, others descending; repeated header toggles direction. Null values sort as −1. Table vertical cap 520px.
- [ ] **Effort × model matrix:** shown only if effortMatrix nonempty; all effort rows, busiest six model columns by summed tokens, plus Effort column (up to seven columns total); normalized intensity and compact token values, `—` for zero; horizontal scrolling.
- [ ] Current table Cost prints `unpriced` when cost <=0, irrespective of priced-row coverage. Preserve data and flag this as existing ambiguity, not a mandate to portray known zero prices as unknown. Null rates/throughput show `—`; success <95% has bad tone.

## Quota — `/quota`

Source: [Quota.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/pages/Quota.tsx). Independent `/api/quota` and `/api/ledger` queries; `QuotaResponse`, `LedgerResponse`. Four stats, eight headed sections, three ECharts, one table, per-window SVG gauges.

- [ ] **Four stats:** primary window utilisation (first `__main__` window, otherwise first), account/update hint; measured Burn rate in %/day; Resets countdown + timestamp; Projected exhaustion countdown, needs-two-samples/reset-first/exhaust-first hint. Preserve insufficient vs flat vs measured distinctions.
- [ ] **Utilisation history:** first six nonempty account/window series, merged timestamp axis with null gaps; height 260. Sample-count badge and range text; baseline-included note. Chart needs at least one series with >=2 points. No samples uses last-reported relative-time explanation or `No quota samples recorded yet`. A retained baseline line with zero in-range samples has its own explanation.
- [ ] **Current windows:** every latest window, gauge, account/window label, reset countdown. Thresholds: >=90% bad, >=70% warning. Empty `No quota windows recorded yet`. Current utilisation is point-in-time and independent of selected range; keep this explanatory note.
- [ ] **Settled sends:** physical settled-send counts stacked bars, height 230, range subtitle; empty `No ledger activity in this range` if no option/buckets.
- [ ] **Settled tokens:** settled ledger token line/area, height 230; same empty behavior.
- [ ] **Burn table:** all burn entries; seven columns **Account, Window, Used now, %/day, Resets, Projected exhaustion, Risk**. Used-now bar and value; insufficient `no data in range`, measured nonpositive `flat`; no reset/exhaustion `—`; Risk badges `insufficient data`, `exhausts first`, `resets first`.
- [ ] **Spend ledger:** byKind counts; settled tokens; distinct sends; largest single send; median send. API byKind and settledTokens are all-time dataset fields, while buckets/distinct/largest/median are range-filtered. Do not silently unify them in a new shell.
- [ ] **How to read this:** all explanations remain: point-in-time utilisation; range-dependent burn with one prior baseline; physical sends vs logical requests/retries/fan-out; lost entries; rotation can limit old history.
- [ ] **All quota series:** despite heading, same first six nonempty visible series; account/window, sampleCount within range, latest percent, legend identity. Empty `No samples in [range]`.
- [ ] Global provider/model/effort/outcome/search filters remain in shell, but these two endpoints consume only range/from/to. Do not claim quota/ledger is filtered by model.

## Conversations — `/conversations`

Source: [Conversations.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/pages/Conversations.tsx). `/api/conversations?…&sort=…&limit=200`, `ConversationsResponse`. Four stats, one headed table section, no ECharts.

- [ ] **Four stats:** Conversations; Attributed requests (unattributed-row hint); Median requests; Median tokens.
- [ ] **Sessions ranked:** five buttons tokens / cost / requests / recent / errors. Nine columns **Conversation, Models, Req, Tokens, Cost, Span, Tok/hr, Errors, Last seen**. ID links open detail; model tags show first two + remaining count; zero cost/errors show `—`. Table vertical cap 640px.
- [ ] API selects top 200 sessions by tokens before sorting by requested column. Counts/median session metrics cover that returned subset, not necessarily all sessions; attributed/unattributed request totals cover all filtered rows. Preserve actual behavior, and flag cap semantics visibly when evaluating completeness.
- [ ] No pagination exists. Empty sessions show StateBlock. All retained session IDs must resolve into real detail pages; no substitute static modal with fewer fields.

## Conversation detail — `/conversations/:id`

Source: [Conversations.tsx](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/pages/Conversations.tsx:99). `/api/conversations/:id`, `ConversationDetailResponse`. Six stats, three headed sections, two ECharts, one table.

- [ ] **All conversations** back link and full/truncated-layout-safe session ID. Back link carries the detail URL's current query string.
- [ ] Detail deliberately requests `range=all` with empty provider/model/effort/outcome/search; endpoint also returns the full session. Do not apply the shell's selected filters to detail unless explicitly changing the product contract. Unknown ID returns 404 and card errors.
- [ ] **Six stats** (only when data exists): Requests; Tokens (cached-token hint); Cost (unpriced-request count); Span (first-request start timestamp); Median latency (p95); Errors (errors+cancellations, failed-only hint).
- [ ] **Token growth:** cumulative token line/area plus dashed input/context size per request, every timeline point; height 280; local-time labels.
- [ ] **Models used:** request counts per model donut, request-total center, legend; height 180. Current legend uses green for first model and blue for all later models, which can disagree with donut palette after two models.
- [ ] **Requests in this conversation:** nine columns **When, Model, Input, Cached, Output, Cost, TTFT, Total, Status**. Newest 150 displayed (reverse of API's chronological rows), all timeline points still kept. Subtitle discloses cap if >150; otherwise says chronological although displayed rows are newest first. Cost uses priced flag (four decimal USD or `—`), Total is duration; badges ok / closed / raw error status. Table vertical cap 520px.

## Data contracts and semantics that must survive shell reuse

Sources: [types.ts](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/types.ts), [server API](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/server/src/api.ts), [analytics.ts](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/server/src/analytics.ts), [format.ts](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/lib/format.ts).

- [ ] Both designs use the same endpoints/query serialization, `OverviewResponse`, `UsageResponse`, `UsageHeatmapDatesResponse`, `CostResponse`, `PerformanceResponse`, `ReliabilityResponse`, `ModelsResponse`, `QuotaResponse`, `LedgerResponse`, `ConversationsResponse`, `ConversationDetailResponse`, `MetaResponse`, and shared Summary/BreakdownRow/RequestRow semantics. Keep query error/status handling and ETag reuse; do not invent an alternate data adapter with fabricated totals.
- [ ] Preserve zero buckets and `Other` aggregation. `buildSeries` fills bucket boundaries; top-group caps do not erase the remaining positive volume. Standard auto bucket: hour <=48h, day <=120d, otherwise week; `all` explicitly uses day.
- [ ] Input context bins are exactly **<8k, 8–16k, 16–32k, 32–64k, 64–128k, 128–256k, 256–512k, 512k+**. Zero bins remain available.
- [ ] Preserve unknown metering/pricing and nullable TTFT/latency/cache-hit metrics; successful, failed and client-cancelled outcomes have distinct meaning. `priced=false` is not synonymous with cost=0. Cost totals aggregate only known priced cost; unpriced counts and context/metering limitations must stay visible where the page currently explains them.
- [ ] The entire response remains intact even when UI shows a subset. API fields not currently displayed must not be removed: Overview prior/topProviders/topEfforts; Cost daily/byProvider/byEffort; Performance p90/p10/context/coverage; Reliability waste/retryOverhead and error cost; conversations providers/cache/output/average duration; quota observation bounds/baseline status; ledger send counts and timestamps. Reusing the component does not authorize changing analytics outputs.
- [ ] Range/filter parity can be checked by equal API URL and response revision/window before comparing rendered totals. Usage date detail uses explicit server timezone; most other date formatting is browser-local. Keep labels and timestamps honest when those differ.
- [ ] On unchanged dataset, useEndpoint preserves 15s stale time, 30s polling, no background interval, no focus refetch; selected heatmap detail is enabled only on selection with polling disabled. Meta uses 60s stale time. This inventory does not authorize performance changes.

## Architectural preservation risks and existing control quirks

These are source observations. They are not claims of visual verification, nor requests to optimize.

1. **Use one routed production page tree per frame.** A shell may wrap the same components with different tokens/nav/layout, but must not replace them with a reduced custom overview. Keep QueryClientProvider, ThemeProvider, BrowserRouter, FiltersProvider and route parameters available. Keep CSS scopes isolated; an alternative background alone does not restyle ECharts.
2. **Route base and links.** Production links are absolute (`/cost`, `/models`, `/conversations/:id`) and TITLES keys are absolute pathnames. Nesting under a preview prefix needs an appropriate router basename or separate entry roots; otherwise links can escape the shell and headings/active states can fail. Direct nested-route reloads need SPA serving fallback, not Python file-path 404. Sidebar keeps search; Overview/Cost/list individual session links currently drop it.
3. **Fixed DOM IDs.** Usage uses `heatmap-cell-0` through `heatmap-cell-167` and global `document.getElementById` for focus. Rendering both full designs into one document creates ID collisions and can focus the wrong design. Separate iframe documents or only one live route tree avoids this. Hidden duplicate trees are not a safe shortcut.
4. **Fixed chart palette.** [palette.ts](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/lib/palette.ts) exports fixed hex palette/composition/outcome colors. chartOptions assigns colors by series index; ModelTag hashes model names to HSL, so it does not match those series colors automatically. Page-level fixed blue/purple/green histogram colors remain in Overview, Usage, Performance, Models and Reliability. Quota and detail legends hardcode colors. CSS variable changes alone leave these untouched.
5. **Heatmap dark detection is a magic color.** [chartOptions.ts](/Users/speedpowermac/Documents/projects/CODE_MAIN/personal/yald/web/src/components/chartOptions.ts:226) and Usage's scale select dark palette by `chartTheme.split === '#1e293b'`. New shell tokens can silently pick the light palette in dark mode. Overview's quiet/peak gradient also does not represent the multicolor heatmap scale faithfully.
6. **Overview metric has duplicate state.** Local `metric` initializes to tokens while request metric comes from URL-backed `filters.metric`. Direct `?metric=cost` or returning from Usage can show Tokens selected/formatter while plotting another metric. The control updates both only on click. Acceptance must exercise direct links and cross-tab navigation, not only default fixture screenshot.
7. **Control capabilities differ by route.** Overview/Cost group menus expose model/provider/effort, Usage additionally account. URL state can carry choices outside a route's menu. Usage's primary and token-heatmap queries must retain separate semantics. Quota ignores non-time filters. Detail is full-session/all-range by design.
8. **Accessibility gaps in source.** Segmented buttons lack aria-pressed; CheckList selection is visual rather than checkbox semantics; Popover lacks expanded/control relationship; sortable Th uses click without keyboard button/aria-sort; global search lacks an explicit label; OutcomeDot alone has no text alternative; Usage error uses `text-danger`, whereas shared semantics use `text-bad`. Preserve operation and improve presentation without removing controls; do not assert full accessibility from source reuse alone.
9. **Tooltip/data identity risks.** chartOptions constructs HTML tooltip strings from series/model names, uses small fixed label/legend sizes, and lineChart enables `connectNulls: true` and smoothing. CSS cannot change a painted canvas's text or colors. Preserve points/units/legends and null data, and treat any drawing-behavior change as explicit design work rather than deleting data.
10. **Known label/order mismatches.** Cost price ranking is token-ordered; Cost sessions are cost-ranked within token top 50; conversation sorting is within token top 200; detail table is newest-first despite chronological subtitle; Performance TTFT p50 is solid despite subtitle; Models zero-priced rows may say unpriced; detail model legend colors diverge after two models. Keep these in review notes and avoid claiming the new shells fixed them without verification.
11. **Collection keys.** Usage combines route and provider rows then uses row.key as React key; equal names can collide. Quota concatenates account+window without separator. Shell reuse preserves these risks; duplicate render trees amplify them.
12. **Content clipping.** Dense fixed-width table columns, 560px minimum tables, large card header controls, 168-cell focus panel, sticky headers, popover z-index, gauges, legend truncation and inherited absolute/fixed positioning need desktop checks. Styling must not hide entire cards/columns or leave overlays under a new shell chrome. Mobile/iPad checks are excluded by the user's scope correction.

## Acceptance matrix for each design

- [ ] Desktop: visit all eight tabs plus a valid detail route; verify the counts/headings above and all rows up to the documented caps. Read tables' final columns by scrolling. No source-only claim of parity is enough.
- Out of scope: phone, iPad, and other device-specific acceptance, per the user's explicit desktop-only requirement.
- [ ] Data: populated fixture, sparse long window, no matching rows, all-unpriced rows, missing TTFT, unavailable quota, insufficient quota history, many models/efforts/sessions, >150 detail requests, and unknown detail ID. Do not use a uniformly populated week to hide sparse behavior.
- [ ] Controls: five ranges, four multi-select filters, search, Clear, refresh, both themes; Overview metric/group choices; Usage five metrics/four groups/two heatmap modes/threshold/pointer/keyboard/clear/retry/reveal-more; Cost groups/export; Models eight sort columns/directions; Conversations five sort buttons; all cross-tab/detail/back links.
- [ ] Compare API windows, totals, priced/unpriced coverage and rendered series with the current production components under matching filters. A design may change composition or emphasis while retaining every existing chart, metric and action.
- [ ] Verify no duplicate IDs/focus targets across simultaneously displayed designs, and no absolute route links escaping a chosen shell.
- [ ] Mark each box with the tested design(s) and evidence after browser QA. This file currently establishes requirements; it does not certify either replica.
