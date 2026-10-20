# API reference

All endpoints return JSON except `/api/export` and `/api/report?format=html`. Responses include an ETag derived from the dataset revision and full request URL. Analytics queries whose window can move with the clock (no `to`, or a relative time such as `now`, `today` or `-8h`) also include the current request time, so rolling windows continue advancing when source files are unchanged. Queries pinned to exact instants, metadata, health, and conversation detail without a window can return `304 Not Modified` for an unchanged query and dataset. Windowed conversation detail follows the analytics clock rules. Each response uses one dataset snapshot and one time for its window boundaries. Analytics endpoints rebuild the dataset if a ledger file's size or modification time changed. The browser polls visible views every 30 seconds; hidden tabs pause polling. Refresh forces a dataset rebuild. Query parameters are URL encoded.

Shared analytics parameters: the time-window parameters below, comma-separated `sources`, `projects`, `providers`, `models`, `efforts`, `routeKinds`, and `statuses` (`ok`, `error`, `cancelled`, `unobserved`), `conversationId`, `search`, `groupBy` (`model`, `provider`, `effort`, `route`, `outcome`, `account`, `serviceTier`, `none`), `metric` (`tokens`, `cost`, `requests`, `outputTokens`, `inputTokens`, `cacheReadTokens`, `reasoningTokens`), and `bucket` (`hour`, `day`, `week`, or omitted/`auto` for automatic selection).

## Time windows

Every analytics route takes the same window parameters. Windows are half-open, `[from, to)`: a request at exactly `to` belongs to the next window, so contiguous windows never count a request twice.

| Param | Example | Notes |
| --- | --- | --- |
| `from` | `2026-10-11T09:00%2B08:00`, `2026-10-11 09:00`, `today`, `-8h`, `1791680400000` | Inclusive start; instant grammar below |
| `to` | `2026-10-11 17:00`, `now`, `+8h` | Exclusive end |
| `last` | `8h`, `2d`, `1w` | Window length; duration grammar below |
| `tz` | `Asia/Singapore` | IANA zone for naive times, `today`, calendar days, buckets and labels. Default: `YALD_TZ`, then `OCX_OBSERVATORY_TZ`, then the system zone |
| `range` | `24h`, `7d`, `30d`, `90d`, `all` | Rolling preset ending at `to` or now; default `30d`. Ignored when `from` or `last` is given |
| `bucket` | `hour`, `day`, `week`, `auto` | Chart buckets start on local hours, local midnights and Mondays in `tz` |
| `sources` | `claude-code,ocx` | Request analytics accept the same source filter as reports, including aliases `claude,codex`. Default both; unknown sources return 400 `invalid_source`. Sources are determined by ingestion protocol, so Anthropic API traffic through opencodex remains `ocx` |

**Instants** (`from`, `to`, phase bounds):

| Input | Meaning |
| --- | --- |
| `2026-10-11T09:00:00+08:00`, `2026-10-11T01:00Z` | Exact instant with an explicit offset |
| `2026-10-11T09:00`, `2026-10-11 09:00`, `2026-10-11 09:00:30` | Naive local time, read in `tz` |
| `2026-10-11` | 00:00 on that date in `tz`, so `from=2026-10-11&to=2026-10-12` is exactly one local day |
| `1791680400000` | Epoch milliseconds (12 or 13 digits) |
| `now` | The request time |
| `today`, `yesterday` | 00:00 in `tz` on that local date |
| `now-8h`, `today+9h`, `yesterday+18h30m` | Anchor plus or minus a duration |
| `-8h` | Same as `now-8h` |
| `+6h` | Only as an end (`to`, or a phase end): the start plus the duration |

**Durations** (`last`, relative offsets) are `<int><unit>` repeated, with units `w d h m s`: `90m`, `8h`, `2d`, `1w`, `1h30m`. Zero is an error. `h`, `m` and `s` are exact; `d` is a calendar day in `tz` (24 hours except across a daylight-saving change) and `w` is seven calendar days. Range presets are exact elapsed spans: `7d` is always 168 hours.

**Windows:**

| Given | Window |
| --- | --- |
| `from` + `to` | `[from, to)` |
| `last` | `[now − last, now)` |
| `last` + `to` | `[to − last, to)` |
| `from` + `last` | `[from, from + last)` |
| `from` only | `[from, now)` |
| `range` (+ optional `to`) | The preset ending at `to` or now; `all` starts at the first data point |
| `to` only | Error `conflicting_params` |
| `from`, `to` and `last` together | Error `conflicting_params` |

A window that does not end after it starts is `empty_window`. A naive local time inside a spring-forward gap (`2026-03-08 02:30` in `America/New_York`) is `nonexistent_time`; an ambiguous fall-back time (`2026-11-01 01:30`) resolves to the earlier instant. The grammar is specified by the table-driven tests in [`server/src/time/window.test.ts`](../server/src/time/window.test.ts).

An ISO-8601 time with a positive offset must encode the `+` as `%2B`; an unencoded `+` decodes to a space:

```bash
curl -s 'http://127.0.0.1:4318/api/overview?from=2026-10-11T09:00:00%2B08:00&to=2026-10-11T17:00:00%2B08:00'
# the same window, read in Singapore time
curl -s 'http://127.0.0.1:4318/api/overview?from=2026-10-11%2009:00&to=2026-10-11%2017:00&tz=Asia/Singapore'
```

Every route reports the window it used. Its `window` object keeps the existing fields (`bucket`, `range`, and so on) and adds:

```json
{
  "from": 1791680400000, "to": 1791709200000, "tz": "Asia/Singapore",
  "label": "Sun 11 Oct 2026, 09:00–17:00 GMT+8",
  "fromIso": "2026-10-11T09:00:00+08:00", "toIso": "2026-10-11T17:00:00+08:00",
  "halfOpen": true,
  "input": { "from": "2026-10-11 09:00", "to": "2026-10-11 17:00" }
}
```

`label` always states the UTC offset and shows both dates when the window spans dates. `input` echoes the raw `from`, `to`, `last` and the `range` when a preset was used.

### Errors

A window parameter that cannot be read, or a combination that does not define one window, is rejected with HTTP 400. There is no fallback to the default range.

```json
{ "ok": false, "error": { "code": "invalid_time", "param": "from", "message": "Could not read \"2026-10-11T09:00:00 08:00\" as a time. If it has a +HH:MM offset, URL-encode the + as %2B." } }
```

`param` names the input (`from`, `to`, `last`, `tz`, `range`, `phase[0]`, …) and `message` quotes it and says what would work. Codes: `invalid_time`, `nonexistent_time`, `invalid_duration` (also an unknown `range`), `invalid_zone`, `empty_window`, `conflicting_params`, and, from `GET /api/window` and `GET /api/report` only, `invalid_phase`, `phase_outside_window` and `phase_overlap`. `GET /api/report` answers its other bad inputs in the same shape: `invalid_source` (`sources`), `invalid_top` (`top`) and `invalid_format` (`format`).

### `GET /api/window`

Resolves `from`, `to`, `last`, `range`, `tz` and any number of `phase=name=start..end` parameters without aggregating data, for date pickers and dry runs. Phase names are 1–40 characters and unique; a phase end may be `+duration` from its start; relative bounds such as `-2h` are read against the window's end. Phases must lie inside the window and may touch but not overlap. They come back sorted by start.

```bash
curl -s 'http://127.0.0.1:4318/api/window?tz=Asia/Singapore&from=2026-10-11%2009:00&to=2026-10-11%2018:00&phase=Build%3D2026-10-11%2009:00..%2B6h'
```

returns `{ ok: true, window, phases: [{ name, from, to, label, fromIso, toIso }] }`, or the 400 error above.

### `GET /api/report`

The report `yald report` produces, from the running server: KPIs, a phase table, a timeline by source, models, top conversations, quota burn and coverage notes for one window. The route and the CLI build the same `ReportSpec` and call the same `buildReport()`, so for the same inputs the JSON is identical apart from `meta.generatedAt`, which is the request time. The payload is `ReportData`, `schemaVersion: 1` (see [`server/src/report/types.ts`](../server/src/report/types.ts)).

| Param | Meaning |
| --- | --- |
| `from`, `to`, `last`, `tz`, `range` | The window, as above. With phases but no window, the window runs from the first phase's start to the last phase's end; with neither, it is the last 24 hours |
| `phase` | Repeatable `name=start..end`, URL-encoded, as in `GET /api/window`. Errors name the parameter by its position in the URL: the first `phase` is `phase[0]` |
| `sources` | Comma-separated `claude-code` and `ocx`, or the aliases `claude` and `codex`. Default both |
| `projects` | Comma-separated folder globs, as for the analytics routes; sets `coverage.unattributedRows`, `coverage.unattributedTokens` and the `coverage.attribution` reason breakdown (null without it); the HTML coverage note states the same numbers |
| `top` | Conversations to list: default 10, at most 100 (larger values are capped) |
| `redact` | `1` (default) or `0`. Redaction cuts conversation ids to 8 characters, shows the home directory as `~` and replaces account labels, because the output is meant to be shared |
| `title` | Heading; default `yald report · <window label>` |
| `format` | `json` (default) or `html`; anything else is `invalid_format` |
| `download` | `1` adds `Content-Disposition: attachment; filename="yald-report-<local from>.<ext>"`, e.g. `yald-report-2026-10-11T0900+0800.html` |

`format=json` answers `{ ok: true, report }` with `Content-Type: application/json`. `format=html` answers exactly what `renderReportHtml()` renders: one self-contained file with inline CSS and SVG and the payload embedded as JSON data, served as `text/html; charset=utf-8` with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'`. A bad window, phase, source, `top` or `format` is the 400 error above, as JSON for either format.

The report ETag hashes the resolved payload and the full URL (so `format` and `download` get their own), excluding `generatedAt`. A report for a pinned window answers `304 Not Modified` until its data or derived project roots change. Inputs are validated before a conditional response, so invalid report requests always return 400.

```bash
# The 09:00–17:00 build phase in Singapore, as a downloadable HTML file
curl -sOJ 'http://127.0.0.1:4318/api/report?from=2026-10-11T09:00:00%2B08:00&to=2026-10-11T17:00:00%2B08:00&tz=Asia/Singapore&phase=Build%3D2026-10-11%2009:00..%2B6h&phase=Demo%3D2026-10-11%2015:00..2026-10-11%2017:00&title=Build%20day&format=html&download=1'
# The same report as JSON, for one project
curl -s 'http://127.0.0.1:4318/api/report?from=2026-10-11T09:00:00%2B08:00&to=2026-10-11T17:00:00%2B08:00&tz=Asia/Singapore&projects=~%2Fwork%2Fapp-a*'
```

## Routes

`projects` is a comma-separated list of URL-encoded folder globs, for example `projects=~%2Fwork%2Fapp-a*,%2Ftmp%2Fapp-a-*`. A request matches when its working directory, or any folder above it, matches a glob; `~` expands to the home directory and a trailing `/` is ignored. Requests without a known folder never match. Every analytics response filtered by `projects` (all routes taking shared parameters, except the CSV export) includes `coverage: { unattributedRows, unattributedTokens, attribution }`: the requests that matched every other filter but were dropped because their folder is unknown. `attribution` (additive) splits that same source and window population into `matched` (kept), `outsideProjects` (a known folder no glob matches) and `unattributed`, each with `rows` and `tokens`; `unattributed.reasons` always lists `noConversationId`, `noRollout` and `other` with `{ reason, rows, tokens, models: [{ model, rows, tokens }] }`, and sums to `unattributed`. Without `projects`, `coverage` is omitted. See [Project attribution](metrics.md#project-attribution).

`GET /api/projects` resolves git roots for each request and hashes its payload for conditional responses. Adding or removing a git root invalidates its ETag even when ledger files are unchanged.

| Route | Additional query parameters | Response |
| --- | --- | --- |
| `GET /api/health` | — | `ok`, dataset `revision`, row count, parse timing, malformed-line count, pricing status |
| `GET /api/meta` | — | Paths, file stats, parse info, totals, providers/models/efforts, quota and ledger summaries |
| `GET /api/window` | Window parameters; repeated `phase` | The resolved window and phases; no data |
| `GET /api/report` | Window parameters; repeated `phase`, `sources`, `projects`, `top`, `redact`, `title`, `format`, `download` | `{ ok, report }` (`ReportData`) or the standalone HTML report; see [`GET /api/report`](#get-apireport) |
| `GET /api/overview` | Shared parameters | Window, summary, prior-period comparison (the equally long window just before, `[from − span, from)`), deltas, sparkline, series, compositions, leaders, heatmap, context, quota, recent rows |
| `GET /api/timeseries` | Shared; `limit` | Window and grouped series |
| `GET /api/models` | Shared | Model/provider/effort breakdowns, scatter points, effort matrix |
| `GET /api/usage` | Shared | Summary, token composition, cache timeline, series, heatmap, context, breakdowns |
| `GET /api/usage/heatmap-dates` | Shared; `weekday` (0–6, Monday first), `hour` (0–23), `limit`, `offset` | Ranked local dates for one heatmap cell in `tz` |
| `GET /api/cost` | Shared | Summary, cost composition, cost series/cumulative totals, cache savings, breakdowns |
| `GET /api/performance` | Shared | Latency timeline, histograms, percentiles, model breakdown, TTFT/output points, slowest rows |
| `GET /api/reliability` | Shared | Outcome report, recent failures, waste, metering, retry overhead |
| `GET /api/quota` | Window parameters, `sources`; other shared filters are declared ignored | `quotaView`: current windows, selected-range burn estimates, coverage, projections, account `scope` |
| `GET /api/ledger` | Window parameters, `sources`; other shared filters are declared ignored | Account-wide spend-ledger counts and selected-range buckets, send/token totals, account `scope` |
| `GET /api/conversations` | Shared; `limit`, `sort` (`tokens`, `cost`, `requests`, `recent`, `errors`) | Ranked conversations and aggregate totals |
| `GET /api/conversations/:id` | Shared; `sessionSource` | Source-qualified session summary, timeline, models, requests and scope/exclusion counts; no window parameters retains all history; 404 when missing, 409 when ambiguous |
| `GET /api/scope` | Shared | Resolved `window`, `matched` and `windowTotal` request/token tallies, per-source tallies excluding only the source selection, optional project `coverage`, account scope |
| `GET /api/projects` | Shared | Working directories in the window, each rolled up to its nearest git root: `projects: [{ project, gitRoot, folders, requests, tokens, cost, firstSeen, lastSeen }]`, largest first, ending with an `(unattributed)` row (always present) that also carries `reasons`, the same breakdown as `coverage.attribution.unattributed.reasons`. With `projects`, only matching folders are listed, plus `(unattributed)` and `coverage` |
| `GET /api/export` | Shared; `dataset` (`requests`, `models`, `conversations`) | CSV attachment for the filtered rows, named for the local window, e.g. `yald-requests-2026-10-11T0900+0800--2026-10-11T1700+0800.csv` |
| `GET /api/filters` | Shared | Window, and the available providers, models, efforts, and route kinds for the selected time/search filter |

`GET /api/dataset/refresh` is an operational endpoint used by local tooling. It rebuilds immediately and returns `{ok, rows, parseMs, builtAt}`. The application server serves the built web app at `/` and its client routes.

### Dashboard scope and navigation

The shared toolbar obtains project choices from `/api/projects` with every current
filter except `projects`, keeping multiple choices available. A literal picker
path is escaped for `Bun.Glob`; custom globs are passed through unchanged. Matching
uses the same cwd/ancestor predicate as reports. Selecting a git root therefore
also includes requests from nested git roots; it is not an exact project-group
selector. `(unattributed)` is informational and cannot be selected. Because the
API splits `projects` on commas, folder names and custom globs containing commas
cannot be expressed by this picker. Missing choices and custom globs remain
visible and removable, including when the selection matches no requests.

Source/project selections preserve the existing request filters. The URL carries
the whole cohort across navigation and reload, including optional `from`, `to`,
`last` and `tz` strings. These go to the server parser without client date parsing.
A range preset clears explicit `from`, `to` and `last` while keeping `tz`. Reset
returns to the default 30-day window and clears all cohort/view filters; on a
session route only `sessionSource` remains because it identifies the open session.
Selecting both sources serializes as the default (no `sources` parameter).

`/api/scope` gives the toolbar a consistent count and the existing project
attribution coverage. No-match results show a reset action. Quota remains visible
with an account-scope explanation even when no requests match; session detail
shows its own matching and excluded counts.

### Account observations

Quota and send-ledger records cannot be joined to request/project cohorts.
`/api/quota` and `/api/ledger` return `scope`; overview returns `quotaScope`:
`{ kind: "account", source: "ocx", available, requestedSources, ignored, note }`.
`ignored` lists active `projects`, `providers`, `models`, `efforts`, `statuses`,
`routeKinds`, `search` and `conversationId` parameters. None narrows these account
observations or makes them a project's quota. History/burn/buckets honor the time
window; current quota and aggregate ledger counts are latest/all-history values.
When sources exclude `ocx`, the payload contains no quota windows, samples, burn
or ledger observations and `available` is false. The dashboard explains that
Claude Code transcripts record neither. Invalid sources return 400 on these
routes too. `/api/meta` remains explicitly global metadata for all local activity.

### Conversation identity and scope

Session lists, overview/cost leaders and `/api/meta.conversations` group by
`(source, conversationId)`. Lists add `source`; links add `sessionSource` while
preserving every cohort parameter. `sessionSource` accepts the same source names
and aliases as `sources` and chooses identity independently of the cohort.
If an id is held by both sources and the source selection does not identify one,
detail returns 409 `ambiguous_session` with the possible `sources`; use
`sessionSource` to disambiguate. It never mixes their requests.

Detail honors the shared source/project/request filters and, when any `from`,
`to`, `last` or `range` is supplied, the shared window parser. With no window
parameter it retains the legacy all-history behavior. Its additive
`scope: { window, matched, sessionTotal, filtersApplied, excluded: { window,
filters } }` counts requests of that source's session. Known sessions excluded by
the selection return 200 with empty points/requests and a zero summary; missing
sessions still return 404. Counts reconcile: matched + outside-window + other
filter exclusions = sessionTotal. The dashboard always sends its selected window.


### Source and measurement metadata

`/api/meta` adds `sources` and `sourceCapabilities` keyed by `claude-code` and
`ocx`. Source comes from protocol, never provider. Public request rows add `source`,
`protocol`, `measurements`, `usageFromAttempts`, `usageStatus`, `cacheProvenance`,
cache-write tokens, nullable token-class rates, sends, attempt tokens and cwd.
Existing numeric defaults remain for compatibility; consult the measurement flags
before displaying them as observations. CSV exports serialize nested metadata as
JSON in quoted cells.

`outcome` and the shared `statuses` filter accept `unobserved` in addition to `ok`,
`error` and `cancelled`. An observed outcome filter never selects Claude's synthetic
HTTP 200. Without an outcome filter, transcript rows retain their volume and cost.

Summaries, model breakdown rows, `/api/performance` and `/api/reliability` expose
`measurementCoverage`: `totalRequests`, plus `{eligibleRequests, totalRequests}`
for `outcomes`, `duration`, `ttft`, `throughput`, `retries`, `input`, `context`,
`cache` and `pricing`. `/api/reliability` also adds the same nullable `successRate`
as the overview. `unobserved` is a separate outcome timeline series. This metadata
is distinct from project-attribution `coverage`. Cache points and context pressure
add eligible and total counts; conversation context points add `contextEligible`.
See [metric definitions](metrics.md#source-capabilities-and-measurement-coverage)
for denominator, zero-versus-missing and attempt-sum rules.

Aggregate price presence: model breakdowns and conversation summaries expose
`pricedRequests` and `unpricedRequests`. A zero cost with priced requests is a
priced zero; zero without any priced requests is unavailable. Blended model
`costPer1kTokens`/`costPer1MTokens` are null when every request is unpriced.

### `GET /api/labs/projects` — Project Radar

Uses the shared window and all request filters, including `sources`, `projects`,
providers, models, efforts, outcomes, route kinds, conversation ID and search.
The public TypeScript contract is `ProjectRadarResponse` in `web/src/types.ts`;
`buildProjectRadar` lives in `server/src/labs/projects.ts`. No view or evidence
endpoint is supplied by this data route.

The response is `{ ok, window, priorWindow, cohort, pricingBasis, history,
current, prior, comparison, projects }`. Windows echo resolved epoch milliseconds,
ISO bounds, `tz`, label and `halfOpen: true`; they omit rolling presets and raw
`input`. `priorWindow` is exactly `[from − (to − from), from)`, including across
DST; it keeps the timezone and every non-time filter. `cohort` carries sources
(canonical `claude-code`/`ocx`), project globs, providers, models, efforts,
statuses, route kinds, nullable conversation ID and search. Empty lists mean no
restriction except sources, which explicitly defaults to both.

Each scope/project `current` and `prior` period contains:

| Field | Contract |
| --- | --- |
| `totals` | `{ requests, tokens, pricedCostUsd, pricedRequests, unpricedRequests }`. Requests are logical rows, tokens are normalized total tokens, cost is an **unrounded USD sum of priced rows only**. Zero cost without priced requests is unavailable. Round only for display; reconciliation allows floating-point tolerance |
| `coverage` | Total/eligible request counts (all scoped rows eligible for activity); independent `pricing` and `attribution` samples as `{eligibleRequests,totalRequests}`; F01 `measurements`; F03 `unattributedReasons` |
| `coverage.projectExclusions` | At scope level only, the existing F03 `{unattributedRows,unattributedTokens,attribution}` for rows matching every filter except project. Null without a project filter and in exact project periods. Excluded unknown/outside-project rows **never enter** strict Radar totals |
| `daily` | Occupied local days only, ascending `ts` (local midnight, epoch ms), with local `date`, clipped `[from,to)` bucket bounds and the same totals. Unoccupied days are omitted; a view must not infer complete zero-usage history from gaps |
| `activeDays` | Number of occupied local days, including partial edge days |
| `sources` | `{source,...totals}` rows, request count descending, tokens descending, source ascending |
| `models` | `{source,provider,model,...totals}` rows, request count descending, tokens descending, then source/provider/model ascending; equal model names from different sources/providers remain separate |
| `evidence` | `{selector,href}` from shared `evidenceFor`; scope or exact project selection, with `eligibility: "all"` |

`projects` includes the union of both periods' exact project identities and an
always-present `(unattributed)` group (zero when a project filter excluded it).
Each group has `{project,gitRoot,folders,current,prior,comparison}`; folders are
the sorted union of recorded working directories in both periods. Grouping uses
`createProjectIdentity()` from `server/src/projects.ts`, also used by the existing
project breakdown: nearest enclosing `.git` directory/file, otherwise the cwd
itself, or `(unattributed)` for no cwd. Groups sort named first, current priced
USD descending, current tokens descending, then exact project string ascending;
unattributed comes last. Prior-only groups remain inspectable.

Each scope/project `comparison` gives `requests`, `tokens`, `pricedCostUsd` as
`{state,absoluteChange,relativeChange}`. `relativeChange` is a fraction
(`-0.5` = 50% lower), only when the baseline is positive. A zero baseline and
positive current value yields `new` with a null ratio; two zero values are
`insufficient`. No loaded history before the current start yields `insufficient`
with null changes. An all-unpriced nonempty period also makes the money change
insufficient, while activity comparisons remain available. Partial priced sums
can be compared, with their coverage visible. `new` describes a metric's observed
baseline, not project creation or delivered value.

`history` discloses `firstLoadedAt` across all loaded rows, `basis:
"earliest-loaded-request"`, `completeness: "unknown"`, a limitation note and per
period `{startsBeforeLoadedHistory,hasLoadedHistory}` flags. The first flag means
the window starts before any loaded row (also true with no data); the second
means some loaded history predates its end and the window has positive length.
These are history signals, not proof of continuous collection or retention.
Partial prior history permits a comparison but must remain disclosed.
`pricingBasis: "currently-loaded-api-list-price-equivalents"` means both periods
use the same normalized dataset's loaded prices, not historical prices or bills.
The existing dataset refresh policy applies to pricing-only changes.

Every evidence selector has `{version:1,window,cohort,selection,eligibility}`.
Its fixed window and every cohort dimension serialize into `/labs/evidence` query
parameters; there is no moving `range`. `selectorVersion=1` identifies the format.
The `selector` parameter is the complete URL-encoded JSON selector, including its
fixed window, typed cohort arrays, selection and eligibility. It is authoritative
for a case file; the readable `from`/`to`/selection parameters are mirrors for
inspection. A literal comma inside a model or project glob cannot split a list
item, and changing the dashboard's rolling preset cannot move the embedded case
window. The evidence endpoint must validate and decode this object rather than
pass it through the dashboard's legacy comma-separated list parser. Project selection adds
`kind=project&projectKey=<exact identity>`, further intersecting the cohort;
it is **not a project glob**. Scope selection uses `kind=scope`. Current and prior
have separate selectors, including for empty groups. L08 supplies the bounded
request endpoint/view. No links use unscoped conversation detail.

Like `/api/projects`, Radar validates before a conditional response and hashes
its resolved payload, so changes in on-disk git roots invalidate a pinned ETag
without a ledger edit.

### Labs Context Replay

`GET /api/labs/context` returns fixed window/cohort, request and eligibility
coverage, source-qualified sessions, observed request sequences, median-based
growth and exact evidence selectors. Missing input and unpriced cost remain null.
See the [Context Replay response contract](labs-context.md) for fields, units,
sorting, history truncation and eligibility rules.
