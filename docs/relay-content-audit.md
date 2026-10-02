# Relay production content audit

Audit date: 2026-10-02. Scope: desktop production Relay adoption, preserving the original data and controls. This is a source audit and promotion checklist, not a fresh browser certification. The parent owns production edits, desktop browser QA, Git and PRs. This audit makes no performance claim and reads no private ledger records.

## Baseline and evidence

The original reference is local `origin/main` at `dcff3fb4b7e59f2520847136e140198a7c7c0057`. Original versions were read with `git show origin/main:path`, including all eight page modules, shell, theme and client API, and the server API. The final production pages, types, API, analytics, formatters, chart presentation, shell and CSS were rechecked against [the retained source inventory](relay-ui/source-inventory.md).

Relay now uses the actual production page tree at `/`. No original route, widget, table column or page control is missing in source. Server API/analytics, response types and filter serialization remain unchanged against the reference. The retained [18 observations](relay-ui/reference-parity.json) contain nine Original UI and nine Relay pages, with zero Bench records. These are earlier synthetic-fixture evidence, not production browser certification.

## Final source recheck

The promotion findings are resolved in source. The table records the final locations and behavior; browser acceptance remains the parent's separate evidence gate.

| Check | Final source | Verified behavior |
| --- | --- | --- |
| Production root and routes | `web/src/main.tsx`, `web/src/components/Layout.tsx` | Relay at `/`, all eight tabs plus conversation detail, lazy pages, root BrowserRouter, QueryClient/Theme/Filters/Relay providers and catch-all redirect. All original shell filters, search, refresh, theme control and ledger metadata remain. |
| Relay-only presentation | `web/src/lib/RelayProvider.tsx`, `web/src/lib/relayStyle.ts`, `web/src/lib/chartStyle.tsx`, `web/src/styles/relay.css`, `web/index.html` | One Relay palette and font, migrated shared layout/focus/gradient styles, stable model/legend colors, light/dark canvas tokens and `--heatmap-gradient`. No Bench, design switcher, preview preference keys or synthetic/SGT footer claims in production source. Footer reads `Local ledger · Read-only analytics`. |
| Production theme preference | `web/src/lib/theme.tsx`, `web/src/main.tsx` | `yald-theme`, legacy `ocx-observatory-theme` migration and OS fallback remain. No preview storage override or forced light default. |
| Overview effective metric and group | `web/src/pages/Overview.tsx`, `web/src/api.ts` | Effective metric is cost/requests, otherwise tokens; group is provider/effort, otherwise model. Query extras `{ metric, groupBy }`, selected controls and metric formatter use the same effective values. Extras override serialized base filters. Unsupported Usage choices remain in URL state for return navigation, but cannot mislabel the Overview payload. |
| Cost effective group | `web/src/pages/Cost.tsx` | Supported provider/effort, otherwise model, drives both Spend over time's selected control and query override. Retained Usage Account state cannot silently group Cost by Account. |
| Detail navigation state | `web/src/pages/Overview.tsx`, `web/src/pages/Cost.tsx`, `web/src/pages/Conversations.tsx` | Every individual conversation link carries pathname + `location.search`; detail back link retains search. Detail still requests the full session with `range=all`, empty filter lists/search; server returns all rows for the ID. |

The toolbar's normal flow replaces the original sticky header as a design choice; controls remain in source. Existing sortable-header, CheckList and Popover accessibility limitations are not data omissions or a claim of full accessibility. Segmented pressed states and the search label improve the source semantics.

This auditor edited only this document. No browser tools or private-ledger records were used for the final recheck; no production browser certification is asserted.

## Route inventory and acceptance checklist

Counts are render sites, including conditional content, not guaranteed counts on empty data. The Usage date table and Models matrix are conditional. Source-preserved means inspected in the actual components; each unchecked item below is a production/browser acceptance gate for the parent.

| Route | Actual page | Stats | Headed sections | ECharts | Tables |
| --- | --- | ---: | ---: | ---: | ---: |
| `/` | `Overview.tsx` | 6 | 9 | 4 | 1 |
| `/usage` | `Usage.tsx` | 4 | 8 | 5 | 4 including date detail |
| `/cost` | `Cost.tsx` | 5 | 7 | 5 | 1 |
| `/performance` | `Performance.tsx` | 6 | 9 | 6 | 2 |
| `/reliability` | `Reliability.tsx` | 5 | 7 | 4 | 2 |
| `/models` | `Models.tsx` | 0 | 6 | 3 | 2 including matrix |
| `/quota` | `Quota.tsx` | 4 | 8 | 3 | 1 |
| `/conversations` | `Conversations.tsx` | 4 | 1 | 0 | 1 |
| `/conversations/:id` | `Conversations.tsx` | 6 | 3 | 2 | 1 |
| **Total** | **Eight tabs + detail** | **40** | **58** | **32** | **15** |

Other original visuals are also data-bearing: three Overview KPI sparklines plus its throughput-card token sparkline, Performance's CSS context histogram, per-window SVG quota gauges, progress bars, status badges, and the effort/model intensity matrix. The matrix is counted as a table, not an EChart.

### Shared shell and state

Sources: `web/src/components/Layout.tsx`, `web/src/lib/useFilters.tsx`, `web/src/api.ts`, `web/src/lib/theme.tsx`, `web/src/components/ui.tsx`; `/api/meta`, `/api/dataset/refresh`.

- [ ] Eight navigation links, active route state, heading/subtitle and detail ID/back action; direct route reloads and unknown-route redirect work on the production server.
- [ ] Ledger all-time requests, tokens, last-request relative time and pricing available/unavailable status remain visible. They must not be relabeled selected-window totals. Meta menu options remain complete even for a narrow filtered window.
- [ ] Five range choices `24h`, `7d`, `30d`, `90d`, `All`, default `30d`; four multi-select Provider, Model, Effort, Outcome menus. Outcome options are `ok`, `error`, `cancelled`; empty options show `No options`.
- [ ] Global search, active filter count/styles, Clear, refresh and both themes operate. Clear appears for list filters, not search alone; original reset clears every parameter and returns to `range=30d`. Refresh actually forces dataset reread and invalidates queries.
- [ ] URL-backed range/providers/models/efforts/statuses/groupBy/metric/bucket/search, comma-separated lists, replace-history filter updates and query-preserving nav. Preserve exported/API query capabilities even if the UI has no explicit from/to or route-kind controls.
- [ ] Query error/loading/empty handling survives. `StateBlock` precedence is loading → error → empty → children. Theme changes repaint ECharts as well as CSS. Tables scroll locally without hiding final columns.
- [ ] Stat hints, delta signs/tones, null delta versus omitted delta, spark values and semantic warning/error coloring survive. Popovers still close outside/Escape; menus remain multi-select; keyboard heatmap focus isn't clipped by shell chrome.

### Overview — `/`

Source `web/src/pages/Overview.tsx`; `/api/overview`, `OverviewResponse`.

- [ ] Six stats: Requests with ok/failed count, delta/spark; Tokens with input/output, delta/spark; Estimated cost with priced/unpriced counts, delta/spark; Success rate with client-closed count/delta; Median TTFT with p95/coverage/inverse delta; Cache savings with input cache rate/delta.
- [ ] Usage over time: all buckets and groups, Tokens/Cost/Requests and Model/Provider/Effort controls, bucket/request subtitle. API top six groups plus positive `Other`. Direct `?metric=cost` agrees with selected control, units and payload.
- [ ] Cost composition: Fresh input/Cache read/Cache write/Output donut, center estimated total, matching value legend, cache-savings callout and cached-token explanation, unpriced exclusion note, Details link.
- [ ] Model leaderboard: token-ranked six models, model identity, tokens, cost, share/bar, success and median duration; All models link.
- [ ] Activity heatmap: all 168 weekday/hour cells, Tokens/Requests, minimum slider, matching-cell count and units/quiet–peak scale. Threshold resets on metric/filter changes; low cells fade rather than disappear. Overview does not have Usage's date drilldown.
- [ ] Quota: every current account/window, used%, progress, reset/no-reset, insufficient/flat/% per day burn and exhaustion-before-reset warning; Details link.
- [ ] Recent requests: newest 25, columns **When / Model (+provider) / Tokens / Cost / TTFT / Total / Status**. Total is duration; unpriced remains distinguishable from zero price; status retains raw code and outcome.
- [ ] Context pressure: all eight input bins and p50/p95/max; Biggest conversations: top eight ID links/tokens/request counts/All link; Throughput & latency: output tok/s p50, token-volume spark, latency p95/p50, upstream sends, conditional retry tokens and metering coverage.
- [ ] Source names `usage.jsonl`, `spend-ledger.jsonl`, `codex-quota-cache.json` and recomputation time remain.

### Usage — `/usage`

Source `web/src/pages/Usage.tsx`; `/api/usage`, `/api/usage/heatmap-dates`, `UsageResponse`, `UsageHeatmapDatesResponse`.

- [ ] Four stats: total/cached tokens, output/share, reasoning/share of output, cache hit rate/read tokens.
- [ ] Token composition retains Cache read/Fresh input/Output/Reasoning and the explanation that input includes cache reads. All-zero series are omitted by the original component, not by Relay's adapter.
- [ ] Cache efficiency retains both hit-rate percent and dashed Savings (USD). Original uses mixed units on one axis; don't remove a series to simplify it.
- [ ] Grouped volume retains Total/Input/Output/Cache/Requests and Model/Provider/Effort/Account controls, all buckets, top eight groups plus `Other`. Heatmap's separate API query stays metric=tokens regardless of grouped-volume metric.
- [ ] Activity heatmap retains Tokens/Requests, slider, count, exact 168 cells and scale; pointer and keyboard selection, roving tabIndex, arrow ±1/±24 navigation clamped to 0–167, full cell values/request labels and focus panel.
- [ ] Selected-cell dates: weekday/hour, range and explicit server timezone, ranked-unit subtitle, total, shown/total dates, loading, error/Try again, no-date message, Clear selection, Reveal more dates. Table **Date / Tokens or Requests / Requests**. Append 20-row pages; filter/metric changes clear selection and accumulation. Selection queries do not poll.
- [ ] Context pressure bins/p50/p95/max; all three independent By model / By effort / By route & provider tables with **dimension / Req / Tokens / Share / Cost / p50**, 12 rows per table, 300px scroll cap. Route rows precede provider rows before the combined slice.

### Cost & spend — `/cost`

Source `web/src/pages/Cost.tsx`; `/api/cost`, `/api/export`, `CostResponse`.

- [ ] Five stats: Estimated cost/priced count; blended cost per 1M all tokens; cache savings; output spend/share; unpriced request share.
- [ ] Five complete charts: Spend over time (Model/Provider/Effort, top eight + Other); Where the dollars go (four token classes, total/legend); Cumulative spend plus dashed per-bucket cost; Cache savings over time; Blended price per 1M tokens (positive-price models, max ten).
- [ ] Most expensive sessions: ID links, cost/bar, request count, token count. Original ranks by cost within the top 50 token sessions, returning ten; do not present that as a newly complete global cost ranking.
- [ ] Cost by model keeps all returned rows and **Model / Requests / Tokens / Cost / Cost per 1M / Share / Unpriced**. Export CSV uses current filters and `dataset=models`; overlays explanation remains. Preserve null rate and positive unpriced count alongside zero known cost.

### Performance — `/performance`

Source `web/src/pages/Performance.tsx`; `/api/performance`, `PerformanceResponse`.

- [ ] Six stats: TTFT p50/coverage, TTFT p95, latency p50/p95/p99, output tok/s p50/mean.
- [ ] Latency timeline retains Latency p50/p95 and TTFT p50/p95 plus bucket label; Generation speed over time retains median output tok/s; latency/TTFT/throughput distributions retain all eight/seven/seven bins.
- [ ] TTFT vs output length retains x=TTFT, y=output tokens and point identity: newest 2,000 eligible rows, then busiest six models by point count, with sampling subtitle.
- [ ] Slowest requests keeps 15 rows, **When / Model (+provider) / TTFT / Total / Out / Status**. Performance by model keeps first 12 token-ranked models, **Model / Req / TTFT p50 / p50 / p95 / tok/s**.
- [ ] CSS context histogram retains all eight bins/counts/bars and p50/p95/max input; percentile and TTFT-coverage explanation remains. Preserve null metrics and sparse timelines, not fabricated zeros.

### Reliability — `/reliability`

Source `web/src/pages/Reliability.tsx`; `/api/reliability`, `ReliabilityResponse`.

- [ ] Five stats: requests/failed, success/client-closed, distinct errors/top code, retried requests (>1 attempts), metering coverage/unknown-usage rows.
- [ ] Four charts: Outcomes (ok/error/cancelled counts, success center/legend); HTTP codes (first eight by frequency with status-class color); attempts histogram; daily stacked outcomes.
- [ ] Error breakdown keeps every true-error group, **Error / Count / Models / Last seen / Tokens burned**. Models is a distinct count; zero burned tokens renders `—`.
- [ ] Failure rate by model keeps first ten by failure count, counts/rate/bar. Here cancellations count as failures; true-error breakdown excludes them. Recent failures keeps 40 newest non-ok rows from the API's last-500 subset, **When / Model (+provider) / Error / Attempts / Waited / Status**, fallback errorCode→closeReason→unknown and billing explanation.

### Models — `/models`

Source `web/src/pages/Models.tsx`; `/api/models`, `ModelsResponse`.

- [ ] Price vs time-to-first-token preserves TTFT vs USD/1M and token-sized bubbles; eligible positive price/non-null TTFT only. Original has a single `Models` series. Tokens by provider retains all providers; Tokens by model keeps top 12.
- [ ] Effort mix retains all efforts, tokens/share/bar, median duration, output tok/s and success.
- [ ] Model comparison retains every model and all 11 columns **Model / Req / Tokens / Share / Cost / $ per 1M / TTFT p50 / p50 / tok/s / Success / Cache**. Eight numeric sort controls: Req/Tokens/Cost/price/TTFT/latency/tok/s/Success. Default tokens descending; new price/TTFT/latency sort ascending; repeated click reverses; null sorts as −1; 520px vertical cap.
- [ ] Conditional effort×model matrix retains every effort row and busiest six model columns, normalized intensity/token values and zero `—`, horizontal scrolling. No matrix for an empty effortMatrix.

### Quota — `/quota`

Source `web/src/pages/Quota.tsx`; independent `/api/quota` and `/api/ledger`, `QuotaResponse`, `LedgerResponse`.

- [ ] Four stats: primary (`__main__`, else first) window utilization with account/update hint, burn/day, reset/countdown timestamp, projected exhaustion plus insufficient/reset-first/exhaust-first hint.
- [ ] Utilisation history retains first six nonempty account/window series, merged timestamp axis with null gaps, in-range sample count, selected-range label, baseline disclosure and no-samples states. Chart requires at least one series with two points.
- [ ] Current windows retains every latest window, account/window names, SVG gauges/reset labels and >=70 warning/>=90 bad tones; point-in-time independence explanation remains.
- [ ] Settled sends and settled tokens retain complete padded ledger bucket series, original units, selected-range text and empty/error handling.
- [ ] Burn table retains all entries and **Account / Window / Used now / % per day / Resets / Projected exhaustion / Risk**. Distinguish no-data-in-range, flat and measured positive burn; retain risk badges and projection nulls.
- [ ] Spend ledger retains every byKind count, settled tokens, distinct sends, largest send and median send. byKind/settledTokens are all-time; sends/size/buckets are range-filtered.
- [ ] All explanations in How to read this and All quota series remain. The latter repeats the same first six visible series, with account/window/sampleCount/latest%. Global non-time filters remain in the shell but these endpoints consume only range/from/to.

### Conversations — `/conversations`

Source `web/src/pages/Conversations.tsx`; `/api/conversations`, `ConversationsResponse`.

- [ ] Four stats: session count, attributed request count/unattributed hint, median requests and median tokens.
- [ ] Sessions ranked keeps five controls tokens/cost/requests/recent/errors and nine columns **Conversation / Models / Req / Tokens / Cost / Span / Tok per hour / Errors / Last seen**, ID links, first two model labels +remaining count, 640px vertical cap.
- [ ] Preserve the original 200-session token-ranking cap before requested sort; session count/medians cover that subset, while attributed/unattributed request counts cover all matching requests. No invented pagination or decorative-only sort.

### Conversation detail — `/conversations/:id`

Source `web/src/pages/Conversations.tsx`; `/api/conversations/:id`, `ConversationDetailResponse`.

- [ ] Full session ID and All conversations back link, six conditional stats Requests/Tokens with cached hint/Cost with unpriced hint/Span with start/Median latency with p95/Errors including cancellations with failed-only hint.
- [ ] Detail retains full-session semantics irrespective of global filters: client asks `range=all` with empty lists/search; server resolves all rows for the ID. Unknown ID returns 404/card errors.
- [ ] Token growth retains every timeline point, cumulative tokens and dashed submitted input/context; Models used retains every model count, request total and matching legend identity.
- [ ] Request table retains newest 150 rows (reverse of chronological API rows), >150 disclosure and all nine columns **When / Model (+provider) / Input / Cached / Output / Cost / TTFT / Total / Status**. All timeline points remain even when the table caps. Priced zero rows display known cost; unpriced displays `—`; badges distinguish ok/closed/error code.

## Data, sparse and unknown-value invariants

Sources: `server/src/api.ts`, `server/src/analytics.ts`, `server/src/ocx/store.ts`, `web/src/types.ts`, `web/src/lib/format.ts`, `web/src/components/chartOptions.ts`.

1. Preserve all response fields, not only currently displayed ones: Overview prior/topProviders/topEfforts/deltas; Cost daily/provider/effort breakdowns; Performance p90/p10/coverage/context; Reliability error cost/waste/retry overhead; conversation provider/cache/output/average duration; quota baseline/observation bounds; ledger sends/timestamps. A presentation change does not authorize narrowing API contracts.
2. `priced` and `unpricedRequests` carry price coverage. Unknown price is not a known zero price. Store normalization sets unpriced cost to zero; summary sums row cost and counts priced coverage, composition skips unpriced rows. Preserve both numeric known totals and coverage. Cache savings needs published input/cache rates. Cache hit rate uses observed-cache provenance, not every token row; missing observed input yields null.
3. Null/undefined/nonfinite formatting is `—`, not zero. Latency uses positive durations; TTFT uses non-null observations (including known zero); output speed requires positive output and duration. Empty percentile arrays yield null. Success ratio is null for an empty summary; original Reliability derives a displayed zero separately. Keep intentional route differences rather than applying a blanket “zero means missing” rule.
4. `buildSeries` pads requested bucket boundaries with zeros and retains positive remainder volume in `Other`; Overview keeps six, Usage/Cost eight. Auto buckets hour <=48h, day <=120d, otherwise week; `all` explicitly uses day. Latency bucket percentiles remain null where no eligible observations exist; outcome timeline is unpadded. `lineChart` originally connects null gaps; Relay preserves values while removing smoothing. Do not claim that means gaps are no longer connected.
5. Heatmap has all 7×24 cells even with no activity. Usage uses explicit server timezone; selected dates show that timezone and validate weekday 0–6/hour 0–23, limit 1–100, default/client 20, nonnegative offset. Ranked dates descend by selected value, tie by descending date. Zero activity disables slider and shows the original no-activity text.
6. Context bins are exactly <8k / 8–16k / 16–32k / 32–64k / 64–128k / 128–256k / 256–512k / 512k+. Zero bins remain. Overview/Usage/Performance context text intentionally coalesces missing percentile values to zero in existing JSX; preserve raw nullable API values regardless.
7. Quota current windows are latest point-in-time snapshots. History retains one pre-window baseline per series and `sampleCount` counts only in-range points. Burn remains **insufficient unless at least two in-range samples** exist; a baseline plus one in-range sample is still insufficient. Once measured, the rate calculation can include the baseline. Flat/nonpositive measured rate gives null exhaustion; projection warning needs a reset and projected timestamp before it. Missing quota windows/history has explicit empty text; quota and ledger can fail independently.
8. Preserve fetch/ETag semantics and selected-cell query enablement; original normal queries are stale after 15s, poll at 30s, no background polling/focus refetch; meta is 60s stale. Existing ETags use dataset revision+URL. Do not intermingle deferred optimization behavior with the UI PR unless explicitly justified.

## Existing ambiguities to distinguish from Relay omissions

- All-unpriced Overview composition is empty, so its inside-StateBlock exclusion note disappears; the priced/unpriced KPI remains. Cost still shows Unpriced share and table counts. Preserve coverage and consider clearer empty messaging as an explicit fix, not evidence of a new missing chart.
- Models renders `unpriced` for cost <=0 even when some rows may have known zero price. Usage/list/detail use other zero-cost conventions. Cost's unpriced/free/subscription wording is source copy, not proof of why a price is unavailable.
- Models all-unpriced or missing-TTFT scatter can show blank axes because the outer guard checks unfiltered scatter length. Empty distributions can likewise render axes because they guard data presence, not eligible observations.
- Cost price ranking subtitle says cheapest-to-most-expensive but source order is token-ranked; expensive sessions rank within token top 50. Conversation sort operates within token top 200. Keep caps truthful and don't claim these existing limitations were removed by Relay styling.
- Performance latency subtitle says all TTFT lines are dashed but only TTFT p95 is dashed; latency distribution subtitle says share while values are counts. Detail says chronological below the row cap while displaying newest-first. These are existing labeling bugs.
- Quota “All quota series” means the first six nonempty series; a single retained baseline cannot satisfy the history chart's two-point guard. Ledger fields mix all-time and range-filtered scope as documented above.
- Usage Requests date mode duplicates Requests headings; concatenated route/provider table rows can duplicate React keys. Quota concatenated account+window keys can also collide. No additional duplicate route tree or fixed heatmap IDs should be introduced.

## Production completion evidence still required

- [ ] Final production source has Relay-only shell/presentation and the original nine routes; no Bench/default gallery or synthetic branding in runtime UI.
- [ ] Parent's production build and desktop browser observations compare all preserved sections/metrics/table columns with the baseline, including final horizontally scrollable columns.
- [ ] Meaningful edge coverage: no-match, all-unpriced, missing TTFT, sparse range, unavailable/insufficient quota, >150-request detail and unknown ID; high cardinality checks prove original caps rather than an accidental new truncation.
- [ ] Controls above operate against the normal production entry, not just the old comparison preview; direct nested-route reload and query semantics are verified.
- [ ] Keep exact fixture/production provenance with verification artifacts. Do not persist private records or raw private-ledger screenshots into this audit/PR.

Mobile, iPad and other device-specific acceptance are explicitly excluded. This document deliberately leaves production browser gates unchecked; earlier preview parity is useful evidence but cannot certify code the parent has not yet promoted.
