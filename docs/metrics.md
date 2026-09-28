# Metric definitions

## Requests, sends, and attempts

A **request** is one logical dashboard row, identified by a request ID. An **attempt** is one provider execution made to complete that request; retries can create multiple attempts. A **physical send** is a dispatched upstream request recorded by the spend ledger. One logical request can therefore have multiple attempts and sends. Reservations that never dispatch are not sends.

## Tokens and cache

Input tokens already include cache reads and cache writes. **Fresh input** is `max(0, inputTokens - cacheReadTokens - cacheWriteTokens)`. Output and reasoning are reported separately; reasoning may be a subset of output, so do not add it again to total tokens.

Cache provenance is `observed`, `synthesized`, or `unknown`. Cache hit-rate calculations include only rows with observed cache accounting; synthesized estimates do not imply a provider-reported hit. The displayed hit rate is cache-read input divided by input tokens for eligible rows.

## Metering and cost

Metering coverage is the share of requests with reported or otherwise recoverable usage. The four `usageStatus` values are `reported`, `estimated`, `unreported`, and `unsupported`; missing or unfamiliar values are grouped under `other`. Coverage counts reported and estimated rows. Unpriced requests have token usage but no matching price; unmetered requests have no usable token count. Both are excluded from estimated cost totals, and coverage fields expose them.

Cost is estimated by the opencodex pricing engine used by `ocx usage`. It applies the jawcode price table, expected-price overlay, user overlays, long-context bands, and priority multiplier. If that engine is unavailable, yald marks pricing unavailable instead of presenting a second price table.

## Reliability and retries

Success rate uses logical request outcomes, not physical sends. Retry overhead is the metered attempt-token volume beyond the logical request's token volume. Metering coverage is reported independently so failed requests without provider usage are not assigned invented costs.

## Time series and quota

Calendar buckets use the configured local timezone. Weeks begin Monday. Quota burn is measured from observed samples inside the selected time range; current utilization remains the latest point-in-time value. The history chart may include the sample immediately before the range as a visual baseline, but it does not count toward the two in-range samples required for a burn estimate. With insufficient samples, the dashboard reports that state instead of extrapolating. Projections compare the measured burn against the provider's reset time and may be null when a reset or a positive burn rate is unavailable.
