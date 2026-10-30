# Metric definitions

Dollar amounts are **API list-price equivalents**, not subscription bills or
proof of savings. This guide describes 0.2.0, including Labs;
the earlier v0.1.0 preview predates Claude ingestion, reports and Labs. See
[installation](install.md) for distribution status and [views and reports](guide.md)
for the investigation workflow.

## Requests, sends, and attempts

A **request** is one logical dashboard row. Source, request ID and original-order
ordinal distinguish rows when IDs collide; sessions use `(source, conversationId)`.
An **attempt** is one observed provider execution made to complete a request;
retries can create multiple attempts. A **physical send** is a dispatched upstream
request recorded by the spend ledger. One logical request can therefore have
multiple attempts and sends. Reservations that never dispatch are not sends.
Claude transcripts do not measure retry histories or physical sends.

## Tokens and cache

Input tokens already include cache reads and cache writes. **Fresh input** is `max(0, inputTokens - cacheReadTokens - cacheWriteTokens)`. Output and reasoning are reported separately; reasoning may be a subset of output, so do not add it again to total tokens.

For Claude Code, total tokens are `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`. Multiple transcript content blocks can repeat the same API response usage, and resumed sessions can copy those blocks. Yald counts each request once, including subagent requests, and retains its most complete cumulative usage snapshot across live transcripts and the archive. A raw sum of transcript lines can therefore be much larger than the dashboard total.

Cache provenance is `observed`, `synthesized`, or `unknown`. Cache hit-rate calculations include only rows with observed cache accounting; synthesized estimates do not imply a provider-reported hit. The displayed hit rate is cache-read input divided by input tokens for eligible rows.

## Metering and cost

Metering coverage is the share of requests with reported or otherwise recoverable usage. The four `usageStatus` values are `reported`, `estimated`, `unreported`, and `unsupported`; missing or unfamiliar values are grouped under `other`. Coverage counts reported and estimated rows. Unpriced requests have token usage but no matching price; unmetered requests have no usable token count. Both are excluded from estimated cost totals, and coverage fields expose them.

Cost is estimated by the opencodex pricing engine used by `ocx usage`. It applies the jawcode price table, expected-price overlay, user overlays, long-context bands, and priority multiplier. If that engine is unavailable, yald marks pricing unavailable instead of presenting a second price table.

Missing input is not observed zero input; missing price is unavailable, not free.
A priced zero remains valid. An all-unpriced sum cannot establish a zero cost;
mixed coverage gives only the priced subtotal. **Price coverage and project
attribution coverage are independent:** a request can be priced without a known
folder, or attributed without a price. Cost/model views expose price gaps;
project selection, reports and Radar disclose attribution exclusions separately.
See [pricing discovery](install.md#pricing-discovery) and
[project attribution](#project-attribution).

## Net cache economics

Labs Cache Detective (`GET /api/labs/cache`) compares the **identical recorded
workload** with its observed cache accounting against that input priced entirely
uncached. Input includes reads and writes; the baseline keeps raw input, output,
provider, model, routing price options and the evaluated service-tier record.
Only the cache counters change. Price options and tier provenance are evaluated
once and reused by both engine calls. Long-context thresholds therefore use the
same raw input on both sides, and a requested priority tier is never promoted to
response-confirmed priority by Yald. Current engine/overlay rates apply; this is
not a historical pricing snapshot.

Using the baseline's effective input cost per token after tiers and priority:

```text
read discount = read tokens × effective input cost − actual cache-read cost
write premium = actual cache-write cost − write tokens × effective input cost
net benefit  = read discount − write premium = baseline total − actual total
```

Positive net means a lower list-price equivalent with the recorded cache use;
negative means write premiums exceed read discounts; observed zero is even.
This is a fixed-workload counterfactual, not a subscription bill, realized savings,
alternate request-cadence estimate, cache-prefix survival measurement or an
explanation of cache misses. No quality, productivity or compaction claim follows.

Only reported, logical usage with measured inclusive input, both measured cache
counters, exact `observed` provenance and adequate prices supports this comparison.
Missing fields differ from observed zeros. Attempt-summed usage, synthesized or
unknown cache accounting, unavailable engine results, mismatched accounting and
missing rates are excluded with first-match reasons and counts. Exclusions
partition every selected request without contributing dollars. Outcomes do not
gate eligibility. Derived rates remain eligible with a count; explicit user-overlay
zero rates are free, while used zero catalog/expected rates are conservatively
unavailable. An engine missing normalized tokens, source/status or finite cost
classes exposes `economics-unavailable`, with no fallback to the row's base rates.
An engine without `serviceTierContext` also excludes entries with recorded
response/requested/configured tiers or `tierOutcome` (`tier-context-unavailable`);
complete costs alone do not establish that tier provenance was preserved.
Existing actual pricing is unchanged. Entries without tier provenance can still
support the comparison if every other eligibility check passes.

Scope totals include named and unnamed rows. Sessions use
`(source, conversationId)`; unnamed rows have their own totals and no fabricated
conversation. Every group carries total/eligible counts and an exact evidence
selector with fixed `[from,to)`, timezone, every cohort filter and
`eligibility: "cache"`. No eligible rows means `insufficient`, not an observed zero.
The [API contract](api.md#get-apilabscache) lists exclusions, units and sorting.

Amounts accumulate unrounded. At the response boundary read discount and write
premium round to six decimal USD places, then net is their rounded difference.
Actual/baseline totals round independently and can differ from that net by up to
two millionths of a dollar. Rounding sessions independently can likewise leave
small differences from rounded scope totals.

Tier flags count long-context, confirmed/requested-only, priority and lower-bound
rows. The tier summary comes from the engine's evaluated provenance record,
including authoritative attempt outcomes. A lower-bound price flags incomplete
Fast/tier pricing on both sides; it does not guarantee the net is a savings floor.
Claude writes use the engine's single write rate. The transcript conversion does
not preserve separate write TTL accounting, so 1-hour writes can have an
understated premium. TTL reconstruction is outside this comparison.

Existing `summary.cache.savingsUsd`, cache timeline `savingsUsd` and cost
composition `cacheSavingsUsd` keep their original meaning: **gross cache-read
discount at base list rate**, before write premiums and tier adjustments. Their
price/provenance coverage differs from Labs. The normalized `rateIn`, `rateOut`,
`rateCacheRead` and `rateCacheWrite` are base engine rates, not effective post-tier
rates, and are never a fallback for Labs net economics. Gross values are not net
savings and should not be compared as if they had the same eligible population.

## Reliability and retries

Success rate uses observed logical request outcomes, not physical sends or Claude transcript compatibility statuses. Retry overhead is the metered attempt-token volume beyond the logical request's token volume. Metering coverage is reported independently so failed requests without provider usage are not assigned invented costs.

**Outage episodes** group errors (`outcome = error`, so never cancelled or unobserved requests) in time order: a gap of 10 minutes or more (`gapMinutes`) starts a new episode. Only requests with an observed outcome count, which today means opencodex rows; `episodes.coverage` gives the numbers.

- An episode lists its first and last error, its status and error-code mix, providers, models, and the successful requests inside its span, which separate a hard outage from a partial one. A single error has no duration.
- `clippedStart` and `ongoing` mark an episode within one gap of the window's start or end. Its size and length are then lower bounds.
- Concentration is the cumulative share of errors in the largest episodes, with the episode counts reaching 50% and 75%.
- Persistence compares how often the next observed request failed after an error with the base error rate, overall and per provider, with the counts behind both. It does not show a retry loop.
- Status classes are inferred from the code alone, since yald sees no response bodies: `upstream or capacity` (429, 500, 502, 503, 504), `configuration or request` (400, 401, 403, 404, 422) and `other`. The raw status stays visible.
- Tokens and dollars come only from failed rows that reported usage, with the reporting fraction. With none, they are unavailable, not 0.

Clustering is an observation and says nothing about why errors cluster. Episodes do not treat any request as a retry.

## Project attribution

Each request carries the working directory (`cwd`) it was made from, or none when that is unknown.

- **Claude Code:** when a usage record includes `cwd`, Yald keeps it, including in its Claude archive. Archive entries written before Yald kept `cwd` get it from a live transcript that still supplies it (the filled-in copy is appended to the archive once); otherwise they stay unattributed.
- **Codex through opencodex:** ledger rows carry no folder. An opencodex `conversationId` is the first 32 hex characters of `sha256(<Codex session id>)`, and the first line (`session_meta`) of each Codex rollout in `~/.codex/sessions/**/rollout-*.jsonl` and `~/.codex/archived_sessions/rollout-*.jsonl` records that session id and its `cwd`. Yald hashes every rollout's id and joins on it. Only that first line is read (at most 64 KB per file), and unchanged files are not re-read. Subagent traffic is mostly sent under the root thread's id and inherits the root's folder; some is sent under the subagent's own id, which its own rollout also covers. When the root rollout is gone, a surviving subagent rollout still names the root and supplies its folder. `CODEX_HOME` (or `--codex-home`) selects another Codex home.

A project filter (`projects`) is a list of folder globs. A request matches when its `cwd`, or any folder above it, matches a glob, so `~/work/app-a` covers `~/work/app-a/server` and `~/work/app-a*` also covers `~/work/app-a-api`. `~` is the home directory and a trailing `/` is ignored. On macOS, `/tmp/...` and `/private/tmp/...` (and `/var/...` and `/private/var/...`) are treated as the same folder, so `/tmp/app-a-*` and `/private/var/folders/**/T/app-a-*` match Codex SDK runs started in temp folders. Unattributed requests never match a project filter: they are excluded and reported as `coverage.unattributedRows` and `coverage.unattributedTokens`, so a filtered total can be read as a lower bound.

`coverage.attribution` explains the exclusions for the same source and window. Rows are split into `matched` (kept), `outsideProjects` (a known folder that no glob matches) and `unattributed`, and these add up to every row that matched the other filters. Unattributed rows are broken down by reason, each with rows, tokens and the models involved (the report's coverage note prints the same numbers):

- `noConversationId`: an opencodex row without a conversation id (for example image generation or realtime calls). No rollout can match it.
- `noRollout`: an opencodex row with a conversation id that matched no session in the Codex rollout index yald read. The row does not say why (pruned rollout, a client other than Codex, a side call); yald does not guess.
- `other`: no folder and neither reason is evidenced. This includes Claude Code transcript lines without a `cwd`, and opencodex rows with an id when no Codex rollouts could be read at all.

No time-based or overlap inference is applied: a reason never assigns a folder, and token-less rows are not priced.

The projects list rolls each folder up to the nearest enclosing git root (a folder holding a `.git` directory or file, checked on disk once per folder while yald runs), and lists unattributed requests as `(unattributed)`. Folders that no longer exist keep their own path.

The dashboard's Source and Project controls apply the same scope to request-based
views and exports. Project choices use that existing aggregation, but selection
uses the report's folder/ancestor glob rule: a selected root includes nested
projects too. An unattributed row is not a project choice. Under a project
selection, a small note beside the filter chip (below the toolbar) states how many
otherwise-matching requests and tokens had no folder and were excluded; the chip
itself appears only while a filter narrows the data. A zero match offers a reset
instead of assigning that usage elsewhere.
URL filters survive navigation/reload, and session links retain the cohort plus
the source-qualified `(source, conversationId)` identity. Session detail reports
how much history was excluded by the window and the other filters.

Limits:

- Codex sessions run without opencodex do not appear in the opencodex ledger, so yald sees neither their usage nor their folder.
- Codex can delete or prune old rollouts. Their opencodex rows then lose attribution and count as unattributed, while their usage still counts.
- opencodex traffic from clients other than Codex (or without a conversation id) has no rollout and stays unattributed.
- Attribution is by the folder a session started in. A session that changes directory part-way still counts toward its starting folder.
- The local API can include absolute paths. Reports redact home paths to `~` by default, but other absolute paths can remain; `--no-redact` keeps full paths. Review shareable outputs before sending them.

## Time series and quota

Quota and send accounting are global opencodex account observations. They carry no
project/model/outcome identity, so those filters cannot narrow them. The dashboard
labels the account scope and declares ignored filters, and a Claude-only selection
shows them as unavailable. Their history uses the selected window; current quota
and aggregate ledger counts remain the latest available account observations.
They must never be read as a selected project's quota or spend allowance.

Calendar buckets use the request's `tz` (default: the configured local timezone), never the server process's zone. Weeks begin Monday. Quota burn is measured from observed samples inside the selected time range; current utilization remains the latest point-in-time value. The history chart may include the sample immediately before the range as a visual baseline, but it does not count toward the two in-range samples required for a burn estimate. With insufficient samples, the dashboard reports that state instead of extrapolating. Projections compare the measured burn against the provider's reset time and may be null when a reset or a positive burn rate is unavailable.

Range presets are rolling elapsed-time windows ending at the current time, rounded down to the API's 10-second clock quantum (see [request clock](api.md)): `24h` is 24 hours and `7d` is exactly 168 hours, including across daylight-saving changes. Calendar chart buckets do not expand or truncate the selected window. Explicit `from`, `to` and `last` parameters override its boundaries (see the [API reference](api.md#time-windows)). Every window is half-open, `[from, to)`: a request exactly at `to` is counted in the next window, and the prior-period comparison is `[from − span, from)`. Future-dated source rows do not move the default end time.

### Claude Code quota

Claude Code subscription quota (5-hour and weekly windows) is not shown, and yald never estimates it from transcript tokens or reports a missing window as 0% usage. Anthropic documents `rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`, `resets_at`) only in the JSON that Claude Code passes to a custom status-line command on stdin; Claude Code does not persist that payload. The local files checked (`~/.claude/projects` transcripts, `stats-cache.json`, `claude-dashboard.local.json`) contain none of these fields, so there is no existing snapshot to ingest. Reading quota would need a status-line collector that writes the payload to a file, which changes Claude settings and is outside yald's passive, read-only design; it requires a separate decision. If such a snapshot exists later, yald would show its sample time and source, mark a window expired once its reset time passes, and never present the previous window's percentage as current.

## Source capabilities and measurement coverage

Source is determined by the reader protocol: `claude-code` means a Claude Code
transcript; every other protocol is `ocx`. An Anthropic request routed through
opencodex remains `ocx`. The API's `sourceCapabilities` describes what each source
can observe. Capability does not prove that an individual row recorded a value.

Claude transcripts record usage and cache counters. They do not record failures,
retry history, request timing or subscription quota. Their compatibility HTTP 200,
one-attempt and send defaults are not observations. Their API outcome is
`unobserved`, and their request badge says so. `ok`, `error` and `cancelled` filters
select only observed outcomes; `unobserved` selects the remainder. With no outcome
filter, all otherwise-matching rows remain in request, token and priced-cost totals.
The four outcome counts reconcile to total logical requests.

Success rate is `ok / (ok + error + cancelled)` over observed logical requests,
including failed requests without usage. With no eligible requests it is null,
not 100% or zero. HTTP status distributions, failure rates, waste and retry charts
exclude unobserved outcomes or retry histories as applicable. Retry overhead and
upstream-send summaries do not count Claude's compatibility defaults.

Every normalized/public request has `measurements` flags for `outcome`, `duration`,
`ttft`, `retries`, `input`, `output`, `cacheRead` and `cacheWrite`. Token and timing
presence is captured from finite, nonnegative values before numeric defaults;
reported zero is present. Durations and TTFT use only measured values from a
capable source. Output throughput also requires positive duration and output.
`measurements.usage` is `logical`, `attempt-sum`, or `missing`; `usageFromAttempts`
remains available. If neither input nor output is present at the logical level,
usage can be recovered by summing attempts. Explicit logical zero usage is kept.
Attempt sums describe burned volume, not the context of one submission.

Summary and model breakdown `measurementCoverage` fields give
`{ eligibleRequests, totalRequests }` for outcomes, duration, TTFT, throughput,
retries, input, context, cache and pricing. Performance and reliability endpoints
also expose this object. These are counts for the selected cohort; eligibility
does not expand the query scope. Existing TTFT `coverage` remains the fraction of
all selected requests with measured TTFT.

Cache hit ratios require both observed cache-read accounting and observed input.
They divide eligible cache reads by eligible input; zero eligible input gives a
null ratio, including when observed inputs are all zero. Cache provenance counts
still describe all selected rows; ratio coverage separately identifies eligibility.
Cache timeline points expose the same eligible and total counts. Context pressure
and conversation context traces exclude missing-input and attempt-summed rows;
observed zero input remains eligible. Volume totals retain those excluded rows.

Price presence is `priced`, never `cost > 0`: a priced free request has zero cost,
whereas an unpriced request has unavailable prices (`rateIn`, `rateOut`,
`rateCacheRead`, `rateCacheWrite` are nullable). Missing rates are omitted from money
calculations. Existing cache-read discount estimates and token-class cost totals
keep their price-equivalent definitions; a cache-read discount is not net savings
once cache-write premiums are considered. All displayed costs are **API list-price
equivalents**, not subscription bills, productivity or proof of realized savings.

New Claude archive records retain the raw presence flags. Older archive entries
already replaced missing counters with zeros, so absence cannot be reconstructed
from those records alone. Their input/cache presence remains unavailable until a
live copy with the same usage supplies evidence. Yald never changes source logs;
its own append-only Claude usage archive at
`$OCX_HOME/yald-claude-usage.jsonl` (default
`~/.opencodex/yald-claude-usage.jsonl`) persists usage after source transcripts
are deleted and has no automatic retention expiry. An empty transcript folder
does not remove archived usage; a source filter does not delete the archive or
disable ingestion. [Local storage details](install.md#data-locations-and-local-archive)
explain isolation with a separate home.

## Project Radar (Labs)

Radar groups normalized requests by the same nearest git root as the project
list, with cwd fallback for non-repositories/deleted folders and an explicit
`(unattributed)` group for missing cwd. Nested repositories/worktrees retain their
nearest identity. Both current and prior groups use one per-analysis root cache.
No attribution is inferred from timing or neighboring requests.

Named groups plus unattributed reconcile to strict scoped logical requests,
normalized total tokens and **priced** USD sums, with floating-point tolerance.
Under a project filter, unattributed rows are excluded from these totals and the
unattributed group is zero; F03 exclusions/reasons remain separate at
`current.coverage.projectExclusions` and `prior.coverage.projectExclusions`.
Attribution coverage counts known cwd, pricing coverage counts `priced` rows,
and F01 measurement coverage keeps observed/synthesized/missing accounting
visible. These populations are independent; unknown attribution can be priced,
and named projects can have price gaps. All scoped rows remain eligible for
activity/evidence, regardless of cache/input provenance.

`pricedCostUsd` is an unrounded API list-price equivalent under the dataset's
currently loaded engine. Unpriced rows contribute requests/tokens and price-gap
counts, never guessed money. A priced zero is valid; an all-unpriced sum of zero
is unavailable. Mixed price coverage produces a partial money sum, not a
full-population cost estimate. Both windows use the same loaded assumptions;
there is no historical-price snapshot or subscription-cost claim.

The preceding window has exactly the current window's elapsed duration and
preserves all other filters and timezone. Per-metric absolute change is current
minus prior; relative change divides by a positive prior value (fraction, not
percent). A positive current value over zero is `new` without a ratio; two zeros
are `insufficient`. No history before the current start is `insufficient` with
null changes, as is a money comparison with an all-unpriced nonempty period.
Prior-only projects can show a decrease to zero. Volume does not indicate
completion, productivity, quality or delivered value.

History starts at the earliest **loaded** request across sources. Flags disclose
when either window begins earlier or has no earlier loaded history; completeness
is always unknown because retention and collection gaps cannot be proven from
requests alone. Partial prior history remains comparable with that limitation.
A `new` state is newly observed activity/value in these windows, not a project
creation date. Daily trends use occupied local calendar days and clip edge-day
bounds to the exact half-open scope. Active days count days with requests, even
when tokens or prices are zero; missing days are not evidence of known zero use.
Model mix is source/provider qualified. The API reference documents sorting,
units and the exact fixed-window selectors for both periods and each group.

## Context length

The Context page reads `inputTokens` of requests that pass `contextEligible` (input measured, logical usage, not attempt-summed); every other request is counted in the coverage line and never enters a distribution or a share. Yald has no per-model context-window table, so nothing is shown as a percent of a window.

- **Minimum samples.** p10, p25, p75 and p90 need at least 10 eligible requests, p99 needs 100, and a band's cost per request, median TTFT and cancel rate each need 10 values of their own. Below that the value is `null` and shown as "too few requests". The median and mean need one request.
- **Bands.** Fixed edges, not quintiles, so they do not move with the selection: under 50k, 50-150k, 150-300k and 300k+ (lower edge inclusive).
- **At or above a threshold.** Share of eligible requests and of priced list-price cost at or above 50k, 150k and 300k, and with `contextTier === "long"`. The tier cutoff varies by model, so the two differ. Cost shares use priced eligible requests only; unpriced requests count as requests but carry no dollars, and a band or threshold with no priced request has no cost (`null`), not $0.
- **Context tax.** Per band: requests, cost, cost per priced request, median TTFT and cancel rate (`cancelled / (ok + error + cancelled)` over observed outcomes). TTFT and outcomes exist for opencodex requests only; Claude rows read "not recorded". Cancel rate covers requests with a measured context length, so a request cancelled before any usage was recorded is not in it, and a request cancelled before its first token has no TTFT.
- **Session growth.** The median input of a session's first 3 eligible requests versus its last 3, ranked from 6 eligible, through the same helper as Context Replay. Sessions with requests outside the window (loaded history only) are counted as clipped.
- **Interpretation.** These are associations in loaded data. Cost per request mixes models and is partly a model effect. Claude Code subagent requests are not labelled, so Claude per-model numbers can mix a main conversation with its subagents' smaller contexts.

## Spend structure

The Cost page's structure sections read priced requests only. Cost is the sum of `row.cost` over priced rows and every token denominator uses the same rows, so shares compare like with like. Unpriced requests are counted and disclosed, never treated as $0.

- **Session cost** is the priced cost per `(source, conversationId)`. A partly priced session shows its priced subtotal, which is a lower bound. Requests with no conversation id are reported separately and sit outside the curve. A session cut by the window counts only its in-window part and is flagged.
- **Concentration** is the share of cost held by the top 1% of sessions, the top 5%, and the top 10 sessions, plus the Gini coefficient over priced sessions (`2 * sum(i * x_i) / (n * sum(x)) - (n + 1) / n`, with costs ascending and `i` from 1). Each needs a minimum number of priced sessions (100, 20, 10 and 10) and is `null` below it. The Pareto curve ranks sessions by cost: x is the cumulative share of sessions, y the cumulative share of cost.
- **Ranking.** "Most expensive sessions" and `/api/conversations?sort=cost` rank every session in the selection, then cut. Earlier versions cut to the 50 largest sessions by tokens first, so a costly low-token session could be missing.
- **Blended price per million tokens** is priced cost over priced tokens, per bucket and per model. Earlier versions divided a model's priced cost by all its tokens, including those of unpriced requests, so a model with mixed pricing read low.
- **Price tier** is a fixed band of a row's list input rate (`rateIn`, USD per million tokens): Economy under $1, Standard from $1 to under $5, Premium $5 and up. The thresholds are constants, not fitted to any dataset, and a tier says nothing about quality or whether it was the right choice. Priced rows with no input rate are outside the tiers. Tier share is the share of priced requests (and of tokens) in each tier per bucket, and the per-tier blended price is priced cost over priced tokens within the tier. Flat tier lines under a moving blended line mean the mix moved.
- **Token-class cost mix** splits cost into fresh input, cache read, cache write and output, per bucket and source, beside each class's share of priced tokens. Each row carries the engine's own per-class cost (`costParts`), so the classes add up to `row.cost` exactly, including long-context-tier and priority rows. A row without the split falls back to tokens times table rates and the difference is shown as a separate "tier adjustment", never folded into a class. Reasoning tokens are a subset of output; reasoning cost is the output cost in proportion to reasoning tokens (an attribution, not a measurement) and is never added twice.
- **Interpretation.** These are arithmetic on tokens and today's price table: rows are priced at load with the current engine and overlays, so a series shows mix and the current table, not what was paid at the time. Until Claude's 5m and 1h cache-write split is read, the 1h write premium is understated. A large cache-write share is not waste; the net comparison is Cache Detective's.

## Labs context growth

Context Replay compares median input of the first three eligible requests with
median input of the last three, requiring at least six. It reports signed absolute
change and latest/baseline ratio; a zero baseline has no ratio. Missing input and
attempt sums remain gaps, and observed zero remains eligible. Shorter sequences
remain viewable without ranked growth. Sessions are source-qualified; window and
cohort limits and all excluded requests are disclosed. See the
[Context Replay contract](labs-context.md) for denominators and history coverage.
These request observations do not infer turns, compaction, waste or answer quality.

## Labs spend spikes

`GET /api/labs/spend` judges each local day of the window (in the window's time
zone) against a trailing baseline. Parameters, echoed in every response as
`rule`: `baselineActiveDays` 14, `minBaselineActiveDays` 7, `spikeMultiple` 2.5.

- **Cost** is the sum of `cost` over priced rows (API list-price equivalents at the loaded prices). Unpriced rows add requests and tokens, never dollars; a day with no priced row has `pricedCostUsd: null`.
- **Baseline** is the median daily priced cost over the previous 14 active days (a day with at least one priced request) before that day in the same cohort, read from loaded history even before the window. A day is a **spike** when it is complete and its cost is above 2.5 times that median.
- **Insufficient** is fewer than 7 baseline days or a $0 median; it is never reported as normal. **Partial** is a day still in progress or cut by the window edge. A day with no priced request is `no-priced`.
- **Decomposition** compares the day with the mean daily cost over the baseline days, leaving out baseline days above 2.5 times their own median (earlier spikes) so they do not mask the change. Each cut (project, model, token class, session) sums exactly to day minus baseline mean. Groups with no baseline cost are "new". Token-class parts use the engine's cost parts, as on the Cost page.
- **Coverage** is shown beside it: priced over total requests, the unpriced change in requests and tokens, and the share of requests with a known project folder.
- **Interpretation.** Unusual is relative to loaded history, which is not necessarily history that happened (`history.completeness` is `unknown`). It is not a budget, a judgement or a cause.

## Fixed case evidence

Each Labs finding opens a [fixed case](labs-evidence.md) with the exact original
window, cohort and source-qualified selection. Radar preserves both original
current/prior windows; switching the inspected period does not rebase them.
Global toolbar changes do not move an open case. Full-population totals precede
pagination. Cache evidence applies the same monetary eligibility predicate as
its builder and separately discloses original totals/exclusions. Context retains
excluded rows with unavailable submitted input. Missing input, price or timing
is never a numeric zero; observed zero remains valid. Recorded token-volume
totals can include incomplete or attempt-summed usage and are not context medians.
All observations use existing server builders without inferred causes or new
pricing logic. The request list contains public metadata only.

Cache population subtotals use the server's six-decimal USD aggregation, with
ties rounded away from zero. The eligible subtotal is exactly the builder's
actual fixed-workload price; the original subtotal independently includes priced
comparison exclusions. Raw individual request costs are unchanged and need not
sum after display rounding. Radar and Context retain unrounded priced-cost sums.
These precision rules do not turn an all-unpriced population into observed zero.
