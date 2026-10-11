# API reference

All endpoints return JSON except `/api/export` and `/api/report?format=html`. Responses include an ETag derived from the dataset revision and full request URL. Analytics queries whose window can move with the clock (no `to`, or a relative time such as `now`, `today` or `-8h`) also include the current request time, so rolling windows continue advancing when source files are unchanged. Queries pinned to exact instants, metadata, health, and conversation detail can return `304 Not Modified` for an unchanged query and dataset. Each response uses one dataset snapshot and one time for its window boundaries. Analytics endpoints rebuild the dataset if a ledger file's size or modification time changed. The browser polls visible views every 30 seconds; hidden tabs pause polling. Refresh forces a dataset rebuild. Query parameters are URL encoded.

Shared analytics parameters: the time-window parameters below, comma-separated `providers`, `models`, `efforts`, and `statuses` (`ok`, `error`, `cancelled`), `search`, `groupBy` (`model`, `provider`, `effort`, `route`, `outcome`, `account`, `serviceTier`, `none`), `metric` (`tokens`, `cost`, `requests`, `outputTokens`, `inputTokens`, `cacheReadTokens`, `reasoningTokens`), and `bucket` (`hour`, `day`, `week`, or omitted/`auto` for automatic selection).

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
| `projects` | Comma-separated folder globs, as for the analytics routes; sets `coverage.unattributedRows` |
| `top` | Conversations to list: default 10, at most 100 (larger values are capped) |
| `redact` | `1` (default) or `0`. Redaction cuts conversation ids to 8 characters, shows the home directory as `~` and replaces account labels, because the output is meant to be shared |
| `title` | Heading; default `yald report · <window label>` |
| `format` | `json` (default) or `html`; anything else is `invalid_format` |
| `download` | `1` adds `Content-Disposition: attachment; filename="yald-report-<local from>.<ext>"`, e.g. `yald-report-2026-10-11T0900+0800.html` |

`format=json` answers `{ ok: true, report }` with `Content-Type: application/json`. `format=html` answers exactly what `renderReportHtml()` renders: one self-contained file with inline CSS and SVG and the payload embedded as JSON data, served as `text/html; charset=utf-8` with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'`. A bad window, phase, source, `top` or `format` is the 400 error above, as JSON for either format.

The ETag works as on every other route: it hashes the dataset revision and the full URL (so `format` and `download` get their own), plus the request time when the window moves with the clock. It never depends on `generatedAt`, so a report for a pinned window answers `304 Not Modified` until the data changes.

```bash
# The 09:00–17:00 build phase in Singapore, as a downloadable HTML file
curl -sOJ 'http://127.0.0.1:4318/api/report?from=2026-10-11T09:00:00%2B08:00&to=2026-10-11T17:00:00%2B08:00&tz=Asia/Singapore&phase=Build%3D2026-10-11%2009:00..%2B6h&phase=Demo%3D2026-10-11%2015:00..2026-10-11%2017:00&title=Build%20day&format=html&download=1'
# The same report as JSON, for one project
curl -s 'http://127.0.0.1:4318/api/report?from=2026-10-11T09:00:00%2B08:00&to=2026-10-11T17:00:00%2B08:00&tz=Asia/Singapore&projects=~%2Fwork%2Fapp-a*'
```

## Routes

`projects` is a comma-separated list of URL-encoded folder globs, for example `projects=~%2Fwork%2Fapp-a*,%2Ftmp%2Fapp-a-*`. A request matches when its working directory, or any folder above it, matches a glob; `~` expands to the home directory and a trailing `/` is ignored. Requests without a known folder never match. Every analytics response filtered by `projects` (all routes taking shared parameters, except the CSV export) includes `coverage: { unattributedRows, unattributedTokens }`: the requests that matched every other filter but were dropped because their folder is unknown. Without `projects`, `coverage` is omitted. See [Project attribution](metrics.md#project-attribution).

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
| `GET /api/quota` | Window parameters | `quotaView`: current windows, selected-range burn estimates, coverage, and projections |
| `GET /api/ledger` | Window parameters | Spend-ledger counts and selected-range buckets, send/token totals |
| `GET /api/conversations` | Shared; `limit`, `sort` (`tokens`, `cost`, `requests`, `recent`, `errors`) | Ranked conversations and aggregate totals |
| `GET /api/conversations/:id` | — | Conversation summary, timeline, models, and requests across all time; 404 when missing |
| `GET /api/projects` | Shared | Working directories in the window, each rolled up to its nearest git root: `projects: [{ project, gitRoot, folders, requests, tokens, cost, firstSeen, lastSeen }]`, largest first, ending with an `(unattributed)` row (always present). With `projects`, only matching folders are listed, plus `(unattributed)` and `coverage` |
| `GET /api/export` | Shared; `dataset` (`requests`, `models`, `conversations`) | CSV attachment for the filtered rows, named for the local window, e.g. `yald-requests-2026-10-11T0900+0800--2026-10-11T1700+0800.csv` |
| `GET /api/filters` | Shared | Window, and the available providers, models, efforts, and route kinds for the selected time/search filter |

`GET /api/dataset/refresh` is an operational endpoint used by local tooling. It rebuilds immediately and returns `{ok, rows, parseMs, builtAt}`. The application server serves the built web app at `/` and its client routes.
