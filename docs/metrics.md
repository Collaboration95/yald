# Metric definitions

## Requests, sends, and attempts

A **request** is one logical dashboard row, identified by a request ID. An **attempt** is one provider execution made to complete that request; retries can create multiple attempts. A **physical send** is a dispatched upstream request recorded by the spend ledger. One logical request can therefore have multiple attempts and sends. Reservations that never dispatch are not sends.

## Tokens and cache

Input tokens already include cache reads and cache writes. **Fresh input** is `max(0, inputTokens - cacheReadTokens - cacheWriteTokens)`. Output and reasoning are reported separately; reasoning may be a subset of output, so do not add it again to total tokens.

For Claude Code, total tokens are `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`. Multiple transcript content blocks can repeat the same API response usage, and resumed sessions can copy those blocks. Yald counts each request once, including subagent requests, and retains its most complete cumulative usage snapshot across live transcripts and the archive. A raw sum of transcript lines can therefore be much larger than the dashboard total.

Cache provenance is `observed`, `synthesized`, or `unknown`. Cache hit-rate calculations include only rows with observed cache accounting; synthesized estimates do not imply a provider-reported hit. The displayed hit rate is cache-read input divided by input tokens for eligible rows.

## Metering and cost

Metering coverage is the share of requests with reported or otherwise recoverable usage. The four `usageStatus` values are `reported`, `estimated`, `unreported`, and `unsupported`; missing or unfamiliar values are grouped under `other`. Coverage counts reported and estimated rows. Unpriced requests have token usage but no matching price; unmetered requests have no usable token count. Both are excluded from estimated cost totals, and coverage fields expose them.

Cost is estimated by the opencodex pricing engine used by `ocx usage`. It applies the jawcode price table, expected-price overlay, user overlays, long-context bands, and priority multiplier. If that engine is unavailable, yald marks pricing unavailable instead of presenting a second price table.

## Reliability and retries

Success rate uses observed logical request outcomes, not physical sends or Claude transcript compatibility statuses. Retry overhead is the metered attempt-token volume beyond the logical request's token volume. Metering coverage is reported independently so failed requests without provider usage are not assigned invented costs.

## Project attribution

Each request carries the working directory (`cwd`) it was made from, or none when that is unknown.

- **Claude Code:** every transcript line records `cwd`, and yald keeps it, including in its Claude archive. Archive entries written before yald kept `cwd` get it from the live transcript while that file still exists (the filled-in copy is appended to the archive once); otherwise they stay unattributed.
- **Codex through opencodex:** ledger rows carry no folder. An opencodex `conversationId` is the first 32 hex characters of `sha256(<Codex session id>)`, and the first line (`session_meta`) of each Codex rollout in `~/.codex/sessions/**/rollout-*.jsonl` and `~/.codex/archived_sessions/rollout-*.jsonl` records that session id and its `cwd`. Yald hashes every rollout's id and joins on it. Only that first line is read (at most 64 KB per file), and unchanged files are not re-read. Subagent traffic is mostly sent under the root thread's id and inherits the root's folder; some is sent under the subagent's own id, which its own rollout also covers. When the root rollout is gone, a surviving subagent rollout still names the root and supplies its folder. `CODEX_HOME` (or `--codex-home`) selects another Codex home.

A project filter (`projects`) is a list of folder globs. A request matches when its `cwd`, or any folder above it, matches a glob, so `~/work/app-a` covers `~/work/app-a/server` and `~/work/app-a*` also covers `~/work/app-a-api`. `~` is the home directory and a trailing `/` is ignored. On macOS, `/tmp/...` and `/private/tmp/...` (and `/var/...` and `/private/var/...`) are treated as the same folder, so `/tmp/app-a-*` and `/private/var/folders/**/T/app-a-*` match Codex SDK runs started in temp folders. Unattributed requests never match a project filter: they are excluded and reported as `coverage.unattributedRows` and `coverage.unattributedTokens`, so a filtered total can be read as a lower bound.

`coverage.attribution` explains the exclusions for the same source and window. Rows are split into `matched` (kept), `outsideProjects` (a known folder that no glob matches) and `unattributed`, and these add up to every row that matched the other filters. Unattributed rows are broken down by reason, each with rows, tokens and the models involved (the report's coverage note prints the same numbers):

- `noConversationId`: an opencodex row without a conversation id (for example image generation or realtime calls). No rollout can match it.
- `noRollout`: an opencodex row with a conversation id that matched no session in the Codex rollout index yald read. The row does not say why (pruned rollout, a client other than Codex, a side call); yald does not guess.
- `other`: no folder and neither reason is evidenced. This includes Claude Code transcript lines without a `cwd`, and opencodex rows with an id when no Codex rollouts could be read at all.

No time-based or overlap inference is applied: a reason never assigns a folder, and token-less rows are not priced.

The projects list rolls each folder up to the nearest enclosing git root (a folder holding a `.git` directory or file, checked on disk once per folder while yald runs), and lists unattributed requests as `(unattributed)`. Folders that no longer exist keep their own path.

Limits:

- Codex sessions run without opencodex do not appear in the opencodex ledger, so yald sees neither their usage nor their folder.
- Codex can delete or prune old rollouts. Their opencodex rows then lose attribution and count as unattributed, while their usage still counts.
- opencodex traffic from clients other than Codex (or without a conversation id) has no rollout and stays unattributed.
- Attribution is by the folder a session started in. A session that changes directory part-way still counts toward its starting folder.
- Absolute paths appear only in the local API. Shareable outputs redact the home directory to `~`.

## Time series and quota

Calendar buckets use the request's `tz` (default: the configured local timezone), never the server process's zone. Weeks begin Monday. Quota burn is measured from observed samples inside the selected time range; current utilization remains the latest point-in-time value. The history chart may include the sample immediately before the range as a visual baseline, but it does not count toward the two in-range samples required for a burn estimate. With insufficient samples, the dashboard reports that state instead of extrapolating. Projections compare the measured burn against the provider's reset time and may be null when a reset or a positive burn rate is unavailable.

Range presets are rolling elapsed-time windows ending at the current time: `24h` is 24 hours and `7d` is exactly 168 hours, including across daylight-saving changes. Calendar chart buckets do not expand or truncate the selected window. Explicit `from`, `to` and `last` parameters override its boundaries (see the [API reference](api.md#time-windows)). Every window is half-open, `[from, to)`: a request exactly at `to` is counted in the next window, and the prior-period comparison is `[from − span, from)`. Future-dated source rows do not move the default end time.

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
its own append-only Claude usage archive under the opencodex home persists usage
after source transcripts are deleted and has no automatic retention expiry.

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
