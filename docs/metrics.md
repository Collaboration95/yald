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

Success rate uses logical request outcomes, not physical sends. Retry overhead is the metered attempt-token volume beyond the logical request's token volume. Metering coverage is reported independently so failed requests without provider usage are not assigned invented costs.

## Time series and quota

Calendar buckets use the configured local timezone. Weeks begin Monday. Quota burn is measured from observed samples inside the selected time range; current utilization remains the latest point-in-time value. The history chart may include the sample immediately before the range as a visual baseline, but it does not count toward the two in-range samples required for a burn estimate. With insufficient samples, the dashboard reports that state instead of extrapolating. Projections compare the measured burn against the provider's reset time and may be null when a reset or a positive burn rate is unavailable.

Range presets are rolling elapsed-time windows ending at the current time: `24h` is 24 hours and `7d` is exactly 168 hours, including across daylight-saving changes. Calendar chart buckets do not expand or truncate the selected window. Explicit `from` and `to` parameters override its boundaries. Future-dated source rows do not move the default end time.

### Claude Code quota

Claude Code subscription quota (5-hour and weekly windows) is not shown, and yald never estimates it from transcript tokens or reports a missing window as 0% usage. Anthropic documents `rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`, `resets_at`) only in the JSON that Claude Code passes to a custom status-line command on stdin; Claude Code does not persist that payload. The local files checked (`~/.claude/projects` transcripts, `stats-cache.json`, `claude-dashboard.local.json`) contain none of these fields, so there is no existing snapshot to ingest. Reading quota would need a status-line collector that writes the payload to a file, which changes Claude settings and is outside yald's passive, read-only design; it requires a separate decision. If such a snapshot exists later, yald would show its sample time and source, mark a window expired once its reset time passes, and never present the previous window's percentage as current.
