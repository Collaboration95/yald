# Context Replay API and metrics

`GET /api/labs/context` accepts the shared time, source, project, provider, model,
effort, outcome, route-kind, conversation ID and search filters. It uses the same
query parser and half-open `[from,to)` window as the other analytics routes. The
response echoes fixed epoch-millisecond bounds, timezone, ISO instants and the
entire cohort. The frontend contract is `ContextReplayResponse`, exported from
`web/src/types.ts`; `useContextReplay` uses the existing endpoint/query machinery.
Mount the hook only in enabled Labs, or pass `enabled:false`.

`coverage.totalRequests` counts every matching request, including unnamed rows.
`eligibleRequests + excludedRequests = totalRequests`. Every exclusion appears
in exactly one `exclusions` reason count, including unnamed excluded requests.
`pricedRequests + unpricedRequests` and `attributedRequests + unattributedRequests`
use the same denominator. Attribution means a recorded working directory, not an
inferred project. When projects are selected, `projectCoverage` separately reports
otherwise-matching requests excluded because their folder is unknown or elsewhere,
using the existing attribution helper. Without a project filter it is null.

Sessions use `(source, conversationId)`, where source comes from protocol, never
provider. `key` is the shared JSON-encoded pair. A row without a conversation ID
contributes to scope coverage and `unnamedRequests`, but creates no session.
Requests sort by timestamp, source, request ID and original dataset ordinal for
identical IDs/timestamps. The returned `ordinal` is zero-based within the selected
session and disambiguates repeated IDs. Input rows and their order are unchanged.

`requests` retains every matching observation. `inputTokens` is null for missing
input or attempt-summed usage, with `eligible:false` and an `exclusionReason`.
`measurements.input` alone is insufficient: the shared `contextEligible` predicate
also requires logical usage and excludes attempt recovery. A provider-reported
zero input is eligible and remains zero. `usageStatus` alone cannot prove input
presence. Other token counters use their own presence flags; totals are null when
logical input or output is unavailable. Reasoning tokens are part of output, never
added again. Cache tokens are already included in input. Token counters use tokens,
timing uses milliseconds, and `cost` is API list-price equivalent USD.

Models, requested/resolved models, effort, provenance and measurement flags remain
available on each observation. Unpriced cost stays null; a priced zero stays zero.
Missing duration and time to first token stay null, including unsupported transcript
timing. Attempt-summed output/cache values remain observations labelled by their
measurement metadata, but never become a request context input.

Growth requires at least six eligible requests in the selected window and cohort.
`growth.baseline` is median input for the first three eligible requests, `latest`
is median input for the last three, and `absoluteChange = latest - baseline`.
`ratio = latest / baseline` only when baseline is nonzero; zero gives null, including
zero to zero. All four numeric fields are null for insufficient samples, with
`ranked:false`; the sequence remains viewable. Sessions sort by descending signed
absolute change, then source and conversation ID; insufficient sessions come last.
Gaps are never converted to zero, so an unmetered failure cannot create a drop or
alter ranking. The ranking does not reconstruct agent turns or infer quality.

Per-session coverage and growth use `inWindowRequests` as their denominator.
Session `totalRequests` counts all loaded rows with that exact source and ID,
before time/cohort filtering. `history.beforeWindowRequests` and
`afterWindowRequests` count rows before `from` and at/after `to` respectively.
`outsideCohortRequests` counts within-window session rows removed by other filters.
`rangeLimited` and `cohortLimited` distinguish these restrictions; `truncated` is
true for either. Only counts use all-session data: no outside request ID, timestamp,
model, tokens or costs appear in the sequence. `loadedHistoryOnly:true` means even
an unclipped sequence is no proof of complete history before collection began.

Each session's `evidence` comes from `evidenceFor` with exactly its source and
conversation ID; scope evidence selects all matching rows, including unnamed ones.
Both selectors carry `eligibility:all`, every cohort filter, and fixed bounds.
The `href` is an intent for the Labs evidence view supplied by L08. It never links
to the unscoped legacy conversation endpoint. Excluded observations remain part
of the evidence population.

Concurrent or interleaved agent requests remain a time-ordered request view.
An observed input decrease does not establish compaction. Nearby model changes
or costs do not establish causality, waste, task turns or answer quality. These
limitations are also returned as text in `limitations` for the view to disclose.
