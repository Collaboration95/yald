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
Claude writes use the engine's single write rate, so 1-hour writes have an
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
- Compressed rollouts (`rollout-*.jsonl.zst`) count the same as plain ones. A missing or invalid frame is treated as no rollout, not an error.
- Where a rollout records them, rows carry `codexSession`: its git branch and commit at session start, and for a spawned thread its parent thread, depth and role. Absent means unavailable. Codex subagent traffic often reuses the parent thread's id and then cannot be split. The repository URL is not kept.
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

Quota samples come from two places, each labelled with its `source`: opencodex's `codex-quota-cache.json`, and `rate_limits` in the `token_count` records of Codex rollouts, including compressed ones. Rollouts name no account, so their samples sit under the label `codex-rollouts` and are never joined to a project or request. Samples are deduplicated by window, reset time and observation time. A window opencodex does not report itself takes its latest reading from them. Rollouts are read in the background, so after a restart this history can appear a little after the first page load.

Calendar buckets use the request's `tz` (default: the configured local timezone), never the server process's zone. Weeks begin Monday. Quota burn is measured from observed samples inside the selected time range; current utilization remains the latest point-in-time value. The history chart may include the sample immediately before the range as a visual baseline, but it does not count toward the two in-range samples required for a burn estimate. With insufficient samples, the dashboard reports that state instead of extrapolating. Projections compare the measured burn against the provider's reset time and may be null when a reset or a positive burn rate is unavailable.

Range presets are rolling elapsed-time windows ending at the current time, rounded down to the API's 10-second clock quantum (see [request clock](api.md)): `24h` is 24 hours and `7d` is exactly 168 hours, including across daylight-saving changes. Calendar chart buckets do not expand or truncate the selected window. Explicit `from`, `to` and `last` parameters override its boundaries (see the [API reference](api.md#time-windows)). Every window is half-open, `[from, to)`: a request exactly at `to` is counted in the next window, and the prior-period comparison is `[from − span, from)`. Future-dated source rows do not move the default end time.

### Quota pace

Labs' Quota pace reads one account and window at a time. It is account-scoped: nothing
is split by project, model or session, and a Claude-only selection shows nothing.

- **Window instance.** The period between resets. Samples whose reset times sit within
  five minutes are one instance, because each sample reports a reset a few seconds
  apart. Start is the reset minus the window length, taken from the window name.
- **Used percent.** The highest value so far in the instance, because parallel
  sessions can report a stale lower value.
- **Pace.** Even pace at time t is `100 × (t − start) / length`. The delta is used
  percent minus even pace at the latest sample, in points, with that sample's age.
  A single opencodex snapshot is enough. After the reset the window is expired, and
  the last percentage is not presented as current. Even pace is a reference line.
- **Weekday burn.** The change in used percent per local day, split at local midnight
  in proportion to time, in instances other than the current one. A day inside a gap
  over 24 hours is unobserved and left out; a day with samples on both sides and no
  change is a real zero. A weekday seen in fewer than three instances uses all days
  pooled.
- **Forecast range.** Windows of at least a week, with at least three past instances.
  From the latest sample, each local day to the reset adds the P25, median or P75 burn
  of its weekday, in proportion to the time left, giving a low, typical and high path.
  The result is the earliest and latest date on which a path reaches 100%, or "not before
  reset", with how many of the three paths run out. It is a range of scenarios, not a
  prediction, and never one date. Days with no samples are left out, so it reads as if
  the window is used on every remaining day. A plan or limit change invalidates it.
- **Exchange rate.** For consecutive samples of one account and window, the tokens and
  list-price cost of that account's requests in `(a, b]`, pooled as tokens over points.
  Intervals across a reset, where used percent fell, with no change or over a 24-hour
  gap are excluded and counted. It needs 10 intervals and 5 points. Rollout samples name
  no account, so no join to requests is established and the rate is unavailable for
  them. It is an observed ratio, not a conversion rule: usage elsewhere on the account
  also moves used percent, which makes tokens per point look lower than what a point
  buys.

Rollouts can blend several accounts under one label. Instances then overlap, and each
is still read on its own. `otherOpenWindows` counts the others still open.

### Claude Code quota

Claude Code subscription quota (5-hour and weekly windows) is not shown, and yald never estimates it from transcript tokens or reports a missing window as 0% usage. Anthropic documents `rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`, `resets_at`) only in the JSON that Claude Code passes to a custom status-line command on stdin; Claude Code does not persist that payload. The local files checked (`~/.claude/projects` transcripts, `stats-cache.json`, `claude-dashboard.local.json`) contain none of these fields, so there is no existing snapshot to ingest. Reading quota would need a status-line collector that writes the payload to a file, which changes Claude settings and is outside yald's passive, read-only design; it requires a separate decision. If such a snapshot exists later, yald would show its sample time and source, mark a window expired once its reset time passes, and never present the previous window's percentage as current.

## Source capabilities and measurement coverage

Source is determined by the reader protocol: `claude-code` means a Claude Code
transcript; every other protocol is `ocx`. An Anthropic request routed through
opencodex remains `ocx`. The API's `sourceCapabilities` describes what each source
can observe. Capability does not prove that an individual row recorded a value.

Claude transcripts record usage and cache counters, plus the structure listed under
[Claude transcript structure](#claude-transcript-structure). They do not record failures,
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

### Claude transcript structure

Where a transcript records it, a Claude Code request carries `details` in `publicRow` and exports. Every field is null when not recorded, and `details` itself is null on archive lines written before Yald kept these fields, so older data reads as unavailable and never as zero or "main".

| Field | From | Notes |
| --- | --- | --- |
| `agent` | `isSidechain` | `main` or `subagent`. Null is `unlabelled`, in the `agents` filter and the `agent` group, and is never folded into main |
| `agentId`, `attributionAgent` | transcript line | An extra dimension: a session stays `(source, conversationId)` |
| `agentType`, `spawnDepth`, `spawnToolUseId` | `subagents/agent-*.meta.json` | Named fields only; any task description in the file is not kept |
| `effort` (row field), `perTurnEffort`, `thinkingDurationMs` | transcript line | Claude effort is populated where present |
| `cacheWrite5m`, `cacheWrite1h` | `usage.cache_creation` | Token split only. Dollars still use the engine's single write rate |
| `cacheMissReason` | `message.diagnostics` | As the API reported it. A missing reason is not "no miss" |
| `toolCounts`, `toolUseIds` | `tool_use` blocks | Names, ids and counts of requested calls. MCP tool names can reveal which servers you run; they stay local like every other field |
| `gitBranch`, `promptId` | transcript line | |

Records that are not requests live in their own archive and on `Dataset.claudeEvents`: recorded compactions, API errors and client retries, turn durations, human prompt times, PR links and agent records. A `captured` record marks a session read with event capture, so "no recorded compaction" can be told apart from "not captured". A human prompt is a `user` line that is not a tool result, meta, sidechain or compaction summary; its text is examined only to classify it and is never kept.

No prompt, response, tool input or tool output text is stored. Reading a line parses its text in memory, then only the fields above are kept.

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

Each project's `current` and `prior` carry `branches`, so usage below the project
stays on the same fixed pair of windows. A branch is keyed under its project, since
every repository has a `main`. Claude Code records a branch per request (basis
`request time`), so a session that changes branch splits by request. Codex records it
once in `session_meta` (basis `session start`), so a session that switches branch stays
on its starting branch. Each row shows its basis and source split.

Three states are separate. `main` and `master`, in any case, are listed by name. Detached means a
recorded `HEAD`, or a Codex git record with a commit and no branch. Anything else with
no branch is `no branch recorded`: unavailable, never assigned to `main` and never
inferred from cwd, timing or neighbouring requests. Every request lands in exactly one
row, so the rows sum to the project's totals.

PR links come from `pr-link` transcript lines, so only Claude sessions have them. A
branch lists the PRs seen in its sessions as `owner/repo#N`. Association is by session,
not by time, and a link may be recorded after some of the work. A session can link several
PRs and a PR can span branches, so PR figures overlap: they are never added together or
split. Branch cost is where usage was recorded, not the value of the work, and a name is
a label at request time, not an identity over the project's life.

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
- **Interpretation.** These are associations in loaded data. Cost per request mixes models and is partly a model effect. Claude per-model numbers mix a main conversation with its subagents' smaller contexts unless the `agents` filter narrows them.

## Spend structure

The Cost page's structure sections read priced requests only. Cost is the sum of `row.cost` over priced rows and every token denominator uses the same rows, so shares compare like with like. Unpriced requests are counted and disclosed, never treated as $0.

- **Session cost** is the priced cost per `(source, conversationId)`. A partly priced session shows its priced subtotal, which is a lower bound. Requests with no conversation id are reported separately and sit outside the curve. A session cut by the window counts only its in-window part and is flagged.
- **Concentration** is the share of cost held by the top 1% of sessions, the top 5%, and the top 10 sessions, plus the Gini coefficient over priced sessions (`2 * sum(i * x_i) / (n * sum(x)) - (n + 1) / n`, with costs ascending and `i` from 1). Each needs a minimum number of priced sessions (100, 20, 10 and 10) and is `null` below it. The Pareto curve ranks sessions by cost: x is the cumulative share of sessions, y the cumulative share of cost.
- **Ranking.** "Most expensive sessions" and `/api/conversations?sort=cost` rank every session in the selection, then cut. Earlier versions cut to the 50 largest sessions by tokens first, so a costly low-token session could be missing.
- **Blended price per million tokens** is priced cost over priced tokens, per bucket and per model. Earlier versions divided a model's priced cost by all its tokens, including those of unpriced requests, so a model with mixed pricing read low.
- **Price tier** is a fixed band of a row's list input rate (`rateIn`, USD per million tokens): Economy under $1, Standard from $1 to under $5, Premium $5 and up. The thresholds are constants, not fitted to any dataset, and a tier says nothing about quality or whether it was the right choice. Priced rows with no input rate are outside the tiers. Tier share is the share of priced requests (and of tokens) in each tier per bucket, and the per-tier blended price is priced cost over priced tokens within the tier. Flat tier lines under a moving blended line mean the mix moved.
- **Token-class cost mix** splits cost into fresh input, cache read, cache write and output, per bucket and source, beside each class's share of priced tokens. Each row carries the engine's own per-class cost (`costParts`), so the classes add up to `row.cost` exactly, including long-context-tier and priority rows. A row without the split falls back to tokens times table rates and the difference is shown as a separate "tier adjustment", never folded into a class. Reasoning tokens are a subset of output; reasoning cost is the output cost in proportion to reasoning tokens (an attribution, not a measurement) and is never added twice.
- **Interpretation.** These are arithmetic on tokens and today's price table: rows are priced at load with the current engine and overlays, so a series shows mix and the current table, not what was paid at the time. Until Claude's 5m and 1h cache-write split is read, the 1h write premium is understated. A large cache-write share is not waste; the net comparison is Cache Detective's.

## Subagents

Where Claude Code usage ran, by agent. A request counts once, under its own agent kind: `main`, `subagent` or `unlabelled`. A row without a marker is `unlabelled`, its own slice, and is never folded into main. A session stays `(source, conversationId)`; `agentId` is an extra dimension. A chain is `(source, conversationId, agentId ?? "main")`.

- **Shares** of requests, tokens, input tokens and list-price cost are per kind over the selected Claude rows. Cost is priced rows only, with the priced share of each kind. With no labelled rows, the page says the markers are unavailable and shows no split.
- **Label coverage** is the share of Claude requests with a marker, overall and per bucket.
- **Fan-out** is distinct `agentId` per labelled session, sessions with none included: bins 0, 1, 2-3, 4-7, 8-15 and 16+, with median, p90, max and the share with any subagent. A session with no marker on any row is counted apart. Fan-out uses the selection without its `agents` filter, because Main only would otherwise read as zero subagents.
- **Agent type** comes from the sidecar: spawns (distinct `agentId`), requests, tokens, cost, median requests per spawn, the most used model and first-request write cost. **Spawn depth** is as recorded and never derived.
- **First-request cache write** is the cache-write cost of the first request of each `(session, agentId)` by timestamp, from the engine's own class split where the row has it, else tokens times the row's write rate. It is reported as a total, a median per spawn and the share of spawns with 2 or fewer requests. A spawn whose first request is outside the selection is counted as unavailable, and one with an unpriced first request as unpriced. Scatter points are capped at the newest 2,000. All writes use one engine rate, so the 1h premium is understated.
- **Codex.** Subagent traffic often reuses the parent thread's id, so it cannot be split. Rows are reported as `root thread (may include subagents)` and `subagent thread`, the latter only where a rollout names a parent thread. Such a row is `subagent` in the `agents` filter; a root-thread row is `unlabelled`, never main.
- **Interpretation.** A share is where usage was recorded, not waste or overhead. A first-request write is the cost of that request, not a penalty. Older archive lines cannot be back-filled.

## Session anatomy

The shape of one session, built from the same rows as its detail response, so chain totals add up to the session's. A chain is one agent's requests within the session: `main`, one per `agentId`, and `unlabelled` for requests with no marker, which are never folded into main.

- **Cost tree.** Each chain is sized by list-price cost, tokens or requests, and nested under the chain that spawned it. The parent comes from a subagent's recorded `spawnToolUseId` matching a request's `tool_use` id. A chain with no recorded link sits at the top level and reads "spawn point not recorded"; nothing is guessed. A partly priced chain shows its priced subtotal as a lower bound.
- **Timeline.** A lane per chain from its first to its last request, with a tick per request (at most 300 per chain, evenly spaced, first and last kept) and a connector from the spawning request where one is recorded.
- **Context line.** Input tokens per measured request, one chain at a time, main by default (at most 800 points, or 200 for a subagent). Recorded compactions are marked with Claude Code's own pre and post token counts. An event without an agent id is drawn on the main line: a transcript does not say more. These counts are not API usage counters.
- **Stats.** Chains, maximum recorded depth, subagent share of requests, tokens and cost, the first-request cache write (same definition as [Subagents](#subagents)), and coverage: labelled, priced and context-measured shares. A first request outside the selection is unavailable, not zero.
- **Codex** sessions and unmarked Claude sessions read as one chain with a note. Codex subagent traffic often reuses the parent thread's id, so it cannot be split.

## Agent turns and tools

How agent work is shaped, for Claude Code only. opencodex close reasons use a different vocabulary, so those requests are left out and counted. This is not a productivity measure: a deep turn is not good or bad, a high autonomy ratio does not mean the agent did more for you, and no band is ideal.

- A **step** is one logical request. A **turn** is a run of steps in one chain, `(conversationId, agentId ?? "main")`, so interleaved subagents do not break it. A step whose stop reason is `tool_use` continues the turn, as does a step with no stop reason that requested a tool (a transcript can lose the stop reason on a partial line). Any other stop reason ends it. A human prompt between two main-chain steps also ends it: the turn was interrupted, and it counts under its last recorded stop reason. A turn is built from the filtered rows, so a model or Agent filter changes its shape. A turn cut by the start of the window is counted in `clippedTurns`.
- **Turn depth** is the number of steps in a turn, binned 1, 2-4, 5-9, 10-19 and 20+. **Cost share by depth** is the list-price cost of the steps in each bin over all priced cost, priced steps only, next to the share of turns.
- **Autonomy ratio** is main-chain steps divided by human prompts, overall, per session (median, p90) and per week (the median and p90 of session ratios). It is unavailable without prompt counts, never zero. A session with no recorded prompt in the window is left out.
- **Tool mix** counts `tool_use` blocks by name. Counts are requested calls, not successful ones. **Steps with a tool** overlap by design, since a step can use several, and no cost is attributed to a tool. Tool names are local like every other field; MCP names can reveal which servers you run.
- **Stop reasons** are shown as recorded, including unknown values. A step without one reads `not recorded`.

| Tool group | Tools (case-insensitive) |
| --- | --- |
| Bash | Bash, BashOutput, KillShell, Monitor |
| Read | Read, NotebookRead |
| Edit/Write | Edit, Write, MultiEdit, NotebookEdit |
| Search | Grep, Glob, WebSearch, WebFetch, ToolSearch |
| Agent | Agent, Task, SendMessage, SubagentHandback, TaskStop, Skill |
| MCP | any name starting `mcp__` |
| Other | everything else |

Without transcript structure (older archive lines), turn depth is approximate from stop reasons alone, with the share of steps that have one, and autonomy and tool mix read unavailable.

## Working style

Describes how sessions are shaped and when requests happened. A label is about size and span, not value, and a session is not a task. Nothing here measures productivity, overtime or health.

A session is `(source, conversationId)`, using its in-window requests. Requests without a conversation id are counted apart. Rules apply in order, from one table in `server/src/workingStyle.ts`:

| Archetype | Rule |
| --- | --- |
| poke | 1-3 requests |
| quick | 4-24 requests |
| deep | 25-999 requests within one local calendar day |
| marathon | 1,000 or more requests, or 25 or more requests across two or more local days |

A session with requests outside the window is counted in `clippedSessions`, and its archetype is a lower bound. Cost is the list-price equivalent of priced requests, with unpriced requests counted.

- **Concurrency** is the number of distinct sessions with a request in each 10-minute bin. Idle open sessions are invisible, and a Codex subagent under its own id counts as a session. A day's peak is its largest bin.
- **Days with data** are local days with at least one request. A day without requests may be a day without work, a source that was not running, or a gap. Streaks are runs of consecutive days with data, and the current run ends today.
- **Hours** sum requests by local hour. Night share is requests from 00:00 to 05:59 on the selected time zone's clock, divided by all requests.

**Recap.** With `recap=1`, or `--recap` on `yald report`, the report adds a `workingStyle` block whose notes are fixed sentences composed by the server, so the CLI, the HTML report and the dashboard card print the same text. Each note carries its n, and below 5 sessions or requests a note reads "Too little data". The block is off by default because streaks and hours describe personal habits. The session id in it follows `redact`, and the recap adds no project names, paths or prompt text. The PNG export of the card leaves out notes that name a session unless you ask for them, and it is drawn from the same notes.

## Labs context growth

Context Replay compares median input of the first three eligible requests with
median input of the last three, requiring at least six. It reports signed absolute
change and latest/baseline ratio; a zero baseline has no ratio. Missing input and
attempt sums remain gaps, and observed zero remains eligible. Shorter sequences
remain viewable without ranked growth. Sessions are source-qualified; window and
cohort limits and all excluded requests are disclosed. See the
[Context Replay contract](labs-context.md) for denominators and history coverage.
These request observations do not infer turns, compaction, waste or answer quality.

### Cache rebuild ledger

Cache Detective's second question is where the cache write cost comes from, and
how much of it wrote again what was already cached. The ledger is separate from
the net comparison: it has its own population, and the stricter net predicate does
not shrink it. Anthropic only; other rows are not applicable, never zero.

- **Population.** `provider === "anthropic"` with observed cache counters, a session
  and an agent marker. Exclusions are counted: `cache-unmeasured`, `no-session`,
  `no-agent-marker`.
- **Chains.** `(source, conversationId, agentId ?? "main")`, the whole loaded
  history in `orderedRequests` order, so a window never turns a continuing request
  into a first one.
- **Starts.** A chain's first request is `session-start` or `subagent-start`, with
  the same first-request rule as the Subagents page. It is not a rebuild.
- **Rebuild.** A later request with `cacheWriteTokens > cacheReadTokens`. This is a
  threshold on counters and does not prove that an entry existed and expired.
- **Rewritten tokens.** `min(write, max(0, prevRead + prevWrite - read))`.
- **Premium.** Rewritten tokens × (write rate − read rate) at the row's effective
  `cacheEconomics.rates`. It is an upper bound that assumes the earlier prefix
  could have been reused. It is not Cache Detective's write premium, which compares
  writes with uncached input, and the two are never added. The engine gives no read
  rate to a row that read nothing, so such a row uses the effective read rate of an
  earlier request in its chain with the same model and context tier
  (`borrowedRateRequests`). Without one it is unpriced, never zero. Base rates are
  not a fallback.
- **Causes.** First match wins, and all matches stay on the row as `signals`:
  `reported` (`cache_miss_reason`, raw value kept), `compaction` (an event between
  the two requests, placed by `requestsBefore` as in Context Replay, in the chain it
  was recorded in), `model-switch`, `idle-gap`, `no-evidence`. Only `reported` is
  reported; the next three are inferred. The idle gap compares the time since the
  previous request with the lifetime of the chain's latest write: one hour if it
  wrote any 1-hour tokens, otherwise five minutes. Without a split it is not asserted.
- **Warm rate by gap.** Share of later requests with read at least write, by gap
  since the previous request in the chain. A bucket under 20 requests shows its
  count and no rate.
- **Interleaving.** The same rule ordered by session and by chain. `disappeared`
  counts requests that only look like a lost cache in session order.

The write bill reuses the Spend structure class mix on Anthropic rows, and adds
write tokens by lifetime. Its dollars use the engine's single write rate, so 1-hour
writes are understated. Chosen compactions, model switches and subagent start-ups
are described as what happened, never as waste.

### Recorded compactions

Claude Code writes a `compact_boundary` line when it compacts. Context Replay places those events on the session's sequence and never infers one from an input drop.

- **State.** `recorded`: at least one event. `none recorded`: the session was read with event capture and none was seen, shown as "no recorded compaction", never "no compaction". `unavailable`: no capture record, which covers sessions archived before events were kept and all Codex sessions.
- **Placement.** An event sits between the last request before its timestamp and the next request (`requestsBefore` in `server/src/labs/scope.ts`). The Cache Detective rebuild ledger uses the same rule.
- **Requests until first compaction** is the number of selected requests before the first recorded event, counting excluded requests. It is available only when no loaded request precedes the sequence outside the window or cohort, and no event falls outside the window. Otherwise it reads "unavailable: the sequence starts before the window". The first loaded request is still not proof of the session's true start.
- **Counts** are by `trigger`: auto, manual, and any other or missing value as other. An auto-to-manual ratio exists only from 10 events with at least one manual.
- `preTokens` and `postTokens` are Claude Code's own counts, not API usage counters. Missing values are unavailable, not zero. An event with an agent id draws on that chain; without one it cannot be split by agent and draws on the main chain. Events outside a fixed window are counted, not returned.

An event is a record that Claude Code compacted. It is not a cause of cost, of an input drop elsewhere or of answer quality, and it is not waste or failure.

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
