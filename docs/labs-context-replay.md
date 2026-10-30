# Context Replay view

Turn on Labs and open `/labs/context-replay` (the Context growth tab). The view consumes the real
`useContextReplay` / `ContextReplayResponse` boundary documented in
[labs-context.md](labs-context.md). Sessions retain the server's source-qualified
keys and ranking order. Growth, coverage, token totals and prices are never
recomputed in the browser.

The fixed inclusive/exclusive period and ranking appear before detailed scope.
Select a session, then a request using native buttons (Tab, Enter or Space).
Request ordinals distinguish equal timestamps and duplicate IDs. Selection is
local to the current cohort; changing dashboard filters resets it. The exact
source and session stay visible above the timeline and in request detail.

The timeline uses request index/time on the horizontal axis and input tokens on
the vertical axis. Submitted input, cache read and cache write are separate,
unstacked series; cache counters are already within input. Model markers use the
existing Relay identity palette. Monetary values appear separately in USD in the
request table/detail, as API list-price equivalents.

Every context series, including model markers, is null when `eligible:false`.
This also masks attempt-summed cache counters that remain present in request
detail. Missing counters stay null and lines do not bridge them. Reported zero
remains a point at zero. Shared `lineChart(..., { preserveGaps:true })` opts in to
disconnected gaps and unavailable tooltips; existing callers retain their defaults.
The focused timeline also uses straight segments and explicit point symbols.

Short and fully excluded sessions remain inspectable with an insufficient-data,
unranked label. A zero baseline has no ratio. Timing and price absence are shown
as unavailable; priced zero stays `$0.00`. Reasoning remains within output and the
view displays the server's total without adding it again.

History limits, loaded-only coverage and exclusion reasons are explicit. Scope
evidence also includes unnamed requests. A recorded compaction is shown as an
event. An input decrease with no recorded event, or a nearby model change, is an
observation; the view infers no cause or task quality. No prompt or
response bodies are displayed.

Both evidence actions preserve the server's complete `href` selector and append
only `investigation=context-replay`. Session evidence retains exact source plus
conversation ID, fixed window, full cohort and `eligibility=all`, including
excluded rows. L08 owns decoding and rendering `/labs/evidence`; until integrated,
the shell shows its existing placeholder. Artwork integration is independent.

## Verification

Run `make typecheck`, `make build`, and `make smoke`. The focused smoke uses the
actual API parser, normalizer and synthetic pricing, then compares every request's
rendered detail and chart series against the response in both palettes. It checks
source collisions, equal-time duplicate IDs, median ranking, zero/missing/cache
presence, attempt and unmetered gaps, reasoning totals, short/excluded sessions,
zero baseline, truncation, filters, empty/unnamed/error/loading states and evidence
selectors, including comma-bearing arrays.

For native T3 browser verification:

```sh
make build
YALD_PREVIEW_PORT=5507 scripts/bun run scripts/preview-context-replay.ts
```

The server prints the exact fixture URL, creates private temporary opencodex,
Codex and Claude homes plus synthetic pricing, and removes them on shutdown.
Open your own native T3 tab with `reuseExistingTab:false` and the incognito profile.
Turn on Labs, then verify the fixture's 22 eligible / 28 selected requests and two
unnamed requests. The proxy's `l07-shared` has medians 200 → 1,000, change +800,
ratio 5; the Claude session with the same ID has 500 → 50, change −450, ratio 0.1.
The first two proxy requests share ID and timestamp but show input 300 and 200
respectively. The attempt-sum row shows cache read 500 / write 200 in detail and
no context chart points. The reported-zero row has input/cache zero, cost `$0.00`
and measured timing `0 ms`. Short-session unpriced/timing fields are unavailable.

Check keyboard session/request selection, both themes, neutral decreases, model
color identity, toolbar source/project filters and exact evidence selector/window.
The selected session's three hidden-history counts are 1 before, 1 after and 1
outside the cohort in the window. A rolling toolbar preset on an opened evidence
intent must retain its authoritative selector. Test empty/unnamed scopes and a
synthetic API failure/retry. Do not use a normal server pointed at personal homes.
