# Changelog

All notable changes to yald are recorded here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning. It stays on 0.x while the upstream opencodex ledger shape can change; 1.0 requires a stable ledger contract and published metric definitions.

## [Unreleased]

## [0.4.0] - 2026-10-30 — A leaner dashboard, and where the money goes

### Added

- **Working style.** A new page shows how sessions are shaped (poke, quick, deep, marathon), how many ran at once, days with data and requests by hour, with thresholds published in the metrics docs. A **Case file** card recaps the last 7 days in fixed sentences, and the same recap is available with `yald report --recap` and `GET /api/report?recap=1`, off by default. The card can export a PNG, which leaves out session ids unless you ask and carries a demo label on demo data ([#105](https://github.com/Collaboration95/yald/issues/105)).
- **Outage episodes on Performance.** Errors less than 10 minutes apart group into episodes, on a timeline and in a table with their status mix, the successes inside them, how concentrated they are and how often an error follows an error. Classes are inferred from status codes, episodes at the window's edge are marked, and tokens appear only where failed requests reported them ([#109](https://github.com/Collaboration95/yald/issues/109)).
- **More Codex history is read.** Compressed rollouts (`.jsonl.zst`) now count for project attribution. `rate_limits` records in rollouts add quota history, labelled by source and account-scoped, shown on the Overview plan usage card. opencodex rows gain the rollout's git branch and subagent parent and depth where recorded ([#97](https://github.com/Collaboration95/yald/issues/97)).
- **More of what Claude Code records is kept.** Requests now carry subagent markers, effort, the 5-minute and 1-hour cache write split, API-reported cache miss reasons, git branch and tool names and counts, and a new `yald-claude-events.jsonl` keeps compactions, API errors, turn durations, prompt times, PR links and agent types after transcripts are deleted. Older data reads as unavailable, not zero. `agents` and `agentTypes` filter any analytics route, and `agent` and `agentType` work as `groupBy`. No prompt, response or tool text is stored ([#96](https://github.com/Collaboration95/yald/issues/96)).
- **A small Yaldi in the page heading.** Yaldi idles slowly on wide screens and wakes with a quip on click, Enter or Space. It respects Hide artwork and reduced motion, pauses in hidden tabs and leaves when a request fails ([#94](https://github.com/Collaboration95/yald/issues/94)).

### Changed

- **Audited opencodex 2.94.0.** Appended usage is ingested incrementally again on this engine. Older opencodex versions still price correctly but re-parse in full.
- **A leaner dashboard.** Pages no longer open with a "Dashboard selection" box or a "09 / DASHBOARD" label. A small "Filtered: 2 projects · Reset" chip appears only when a filter narrows your data, with the project-exclusion note beside it when a project filter leaves requests out. The sidebar footer keeps only when the data was last updated and the opencodex and Yald versions, and the Labs and Hide artwork switches moved into a settings menu next to the theme toggle. Picking a range like 24h or 90d no longer counts as a filter, and Reset keeps your range ([#94](https://github.com/Collaboration95/yald/issues/94), [#121](https://github.com/Collaboration95/yald/issues/121), [#123](https://github.com/Collaboration95/yald/issues/123), [#132](https://github.com/Collaboration95/yald/issues/132)).
- **Fewer, clearer pages.** Models, Quota and Reliability are gone and their links redirect: model costs live on Cost, speed and failures on Performance (tagged "Codex only" once instead of rows of dashes for Claude Code), and plan usage is a card on Overview that marks old readings as stale. Conversations is now **Sessions** at `/sessions` ([#128](https://github.com/Collaboration95/yald/issues/128), [#125](https://github.com/Collaboration95/yald/issues/125)).
- **Each chart lives on one page.** Context pressure is on Context only, the activity heatmap on Usage only, token mix on Usage and per-model costs on Cost. The Cost page drops the price-tier, Gini and Pareto blocks and keeps "Top 10 sessions = 35% of spend"; models with no price fold into "+N unpriced". Long tables show the top few rows with "Show all" ([#127](https://github.com/Collaboration95/yald/issues/127)).
- **Less explaining, more answering.** Coverage captions, method notes and caveats moved into small (i) tooltips, and a "Partial" badge appears only when under 95% of requests were measured. Internal words like "unobserved", "metered" and "eligible" are gone, and Claude Code and Codex are named plainly ([#124](https://github.com/Collaboration95/yald/issues/124), [#125](https://github.com/Collaboration95/yald/issues/125)).
- **One number format everywhere:** dollars as $12.34 or $1.59k (two significant figures under a cent, never six decimals), tokens as 117.7M, ratios with at most two decimals, and dates as "Oct 13" with full times in tooltips ([#126](https://github.com/Collaboration95/yald/issues/126)).
- **Labs leads with the answer.** It opens on four cases, each a finding and one number, with tabs for Spikes, Projects, Cache savings and Context growth. Every investigation has a one-line verdict, one chart, a top-five list with short names, a "See the requests" button and an (i) for its rule and coverage. Spend spikes opens on the biggest day (click a bar to change it) and on Model when most of the change is unattributed; Cache savings leads with "Caching saved $X"; Projects compares 7 days with the 7 before; the case file is a plain request table. The "Labs is on" card is gone, and project names show their last two folders ([#122](https://github.com/Collaboration95/yald/issues/122), [#129](https://github.com/Collaboration95/yald/issues/129)).
- **Sessions are identifiable.** Rows show the title Claude Code recorded, when there is one, or the project and start date instead of a hash. Titles stay in memory: they are never archived, saved in the browser, exported or reported. The session page puts context size on its own chart, hides the scope sentence when nothing is excluded, and highlights requests that missed the cache ([#130](https://github.com/Collaboration95/yald/issues/130)).
- The Model filter lists only models in the window, with counts and a search box; long Project lists get a search box and show the last two folders. Updating shows a small "Updating…" chip and dimming instead of a banner ([#132](https://github.com/Collaboration95/yald/issues/132)).

### Fixed

- **The Sessions count was capped at 200.** It and the medians now cover every session in your selection ([#130](https://github.com/Collaboration95/yald/issues/130)).
- Chart legends no longer overlap axis labels or bars: they sit in one scrolling row under the plot ([#94](https://github.com/Collaboration95/yald/issues/94)).
- The cache hit rate is plotted on a percent axis instead of the dollar axis (it was a flat line), and a chart colour is never shared between "Other" and a model ([#131](https://github.com/Collaboration95/yald/issues/131)).
- Context Replay's axis ticks no longer read "600.000000k", and the session page's context line is no longer flattened by the cumulative axis.
- Slowest requests no longer fill up with multi-hour stalled streams: anything open for over ten minutes is left out.
- Removed the context-tax "Cancel rate" column, which always read 0.0% because cancelled requests carry no measured context.

## [0.3.0] - 2026-10-23 — Faster pages, Context and spend insights

### Changed

- **Pages open in a fraction of the time** ([#95](https://github.com/Collaboration95/yald/issues/95)). On a real history of about 157k requests, the 30-day Cost page went from 4.5 s to under 0.2 s and Usage from 3.5 s to under 0.2 s; a repeat open answers in about 10 ms. Time buckets are now worked out once per bucket instead of once per request, and samples are sorted once per series. Every number is unchanged: API responses were compared byte for byte against the previous version on real data ([#98](https://github.com/Collaboration95/yald/issues/98), [#113](https://github.com/Collaboration95/yald/pull/113)).
- **Your numbers stay on screen while new ones load.** Changing a range or filter keeps the previous numbers visible, dimmed under an "Updating" notice, instead of blanking the page. After a reload, each view first shows its last results under "Showing saved results as of …" while fresh numbers load. They are kept in this browser's IndexedDB (at most 40 responses, none older than 7 days or from another Yald build). Errors and demo data are never saved, and unavailable values stay unavailable ([#99](https://github.com/Collaboration95/yald/issues/99), [#115](https://github.com/Collaboration95/yald/pull/115)).
- **New log lines are read on their own.** When `usage.jsonl` or a Claude Code transcript grows, only the appended bytes are read. One new line now costs about 20 ms instead of re-reading a 250 MB file. A replaced, shrunk or rewritten file, or a price change, is still read whole, with the same result as before ([#100](https://github.com/Collaboration95/yald/issues/100), [#116](https://github.com/Collaboration95/yald/pull/116)).
- **The request clock for rolling windows is rounded down to 10 seconds** (`YALD_CLOCK_QUANTUM_MS`). A rolling window's `to` can lag the real time by up to one quantum, and repeat requests within it are answered from memory or with `304 Not Modified`. ETags now also include the pricing generation. See [API reference](docs/api.md).
- Source files are checked for changes at most once a second (`YALD_FRESHNESS_MS`); Refresh still re-reads at once.
- The project list in the toolbar is refreshed every 5 minutes or on Refresh, instead of on every 30-second poll.
- The README opens with Yaldi and reads more plainly ([#92](https://github.com/Collaboration95/yald/pull/92)).

### Added

- **A Context page** ([#102](https://github.com/Collaboration95/yald/issues/102)). See how long your contexts are, per model: median, p90, p99 and maximum, a box plot, how each model's requests spread across context bands, how much of your requests and list-price cost sits at or above 50k, 150k and 300k, and how cost per request, time to first token and cancel rate look by band. Session growth shows how much a session's context grew between its first and last requests. Figures that need more requests than you have read "too few requests", and opencodex-only columns read "not recorded" for Claude Code. The context cards on Overview, Usage and Performance now link to it.
- **Spend structure on the Cost page** ([#103](https://github.com/Collaboration95/yald/issues/103)). See how concentrated your spend is (the share held by the top 1% and 5% of sessions and by your 10 costliest sessions, the Gini coefficient and a Pareto curve), how your blended price per million tokens moves over time and whether that is a shift between Economy, Standard and Premium price tiers, and what each token class costs per source next to its share of tokens. Figures that need more sessions than you have read "too few", partly priced sessions are marked as lower bounds, and unpriced requests are counted rather than treated as $0.
- **Spend spikes in Labs** ([#106](https://github.com/Collaboration95/yald/issues/106)). Find the days your spend ran well above your own recent pattern: a day is flagged when its cost is above 2.5 times the median of the previous 14 active days, and the rule is printed on the page. Pick a day to see what changed against its baseline by project, model, token class or session, with new contributors marked, a drill-down from project to model to token class, and a fixed case of that day's requests. Days without enough history read "insufficient baseline" rather than normal, partial days are marked, costs are API list-price equivalents of priced requests, and unpriced and unattributed requests are counted beside the figures.
- A `Server-Timing` header on every `/api/*` response, splitting dataset build and route compute time and marking memo hits. It carries durations only, never data.
- `scripts/bench-endpoints.ts` and `scripts/compare-endpoints.ts`, which time page loads and compare API responses between two checkouts on a copy of your data. Both refuse to run against the live `~/.opencodex`.

### Fixed

- **"Most expensive sessions" ranks by cost across every session.** It used to rank only the 50 largest sessions by tokens, so a costly session with few tokens could be missing. The same fix applies to sorting sessions by cost, requests, recency or errors in the conversation list.
- **Token-class costs add up to the total on long-context and priority requests.** They now use the cost engine's own split per class, so the Cost page's "Where the dollars go" matches the estimated cost. Rows without it show the difference as a separate tier adjustment.
- **A model's blended price per million tokens uses priced tokens only.** A model with some unpriced requests no longer reads low.
- The default dashboard view (a rolling window) never got a `304`, because its ETag included the request time to the millisecond, so every 30-second poll recomputed the whole page.
- A health check, or the header's metadata and project requests, no longer waits several seconds behind a heavy page query.
- The test suite can no longer touch your real data. Every `bun test` run uses a throwaway data home, and server code refuses to load under `bun test` without one.

### Removed

- Hosted Ubuntu/macOS test CI and its required branch checks. Verification runs locally.

## [0.2.0] - 2026-10-20 — Meet Yaldi

### Added

- Optional Labs with **Project Radar**, **Cache Detective** and **Context Replay**. Findings open fixed evidence cases containing the exact source, window and cohort; Radar retains both comparison periods.
- **Yaldi**, Yald's detective companion, with static light/dark artwork and controls to hide artwork or disable Labs.
- Installed `yald demo --open`: isolated synthetic opencodex and Claude examples, illustrative prices, visible Demo labels, all three investigations and a fixed clock for repeatable screenshots. It removes its own temporary data after shutdown.
- A single-package qualification process with an exact archive manifest and installed-package receipts on Linux and macOS. Release acceptance requires actual matching receipts for the selected 0.2.0 bytes; the workflow alone does not establish qualification.
- Missing project attribution is explained ([#55](https://github.com/Collaboration95/yald/issues/55), part of [#47](https://github.com/Collaboration95/yald/issues/47)): under a project filter, `coverage.attribution` and the report's coverage note split excluded requests into no conversation id, no matching Codex rollout and other/unknown, with rows, tokens and models per reason. Existing coverage fields are unchanged and no folder is inferred.
- Exact and relative time windows on every analytics route: `from`/`to` accept naive local times, dates, `now`, `today`, `yesterday` and offsets such as `-8h` or `+6h`; `last=8h` sets a length; `tz` reads and buckets the window in any IANA zone. Every response echoes the window it used (`tz`, `label`, `fromIso`, `toIso`, `halfOpen`). `GET /api/window` validates a window and its phases without reading data. CSV exports are named for their local window ([#33](https://github.com/Collaboration95/yald/issues/33), [#34](https://github.com/Collaboration95/yald/issues/34)).
- Claude Code subscription usage, read from `~/.claude/projects` transcripts (`CLAUDE_PROJECTS_DIR`) and shown as provider `anthropic` in every view, priced by the opencodex cost engine ([#26](https://github.com/Collaboration95/yald/pull/26)).
- Project attribution ([#35](https://github.com/Collaboration95/yald/issues/35)): every request carries the folder it came from, from Claude Code transcripts and, for opencodex rows, from the first line of the matching Codex rollout (`CODEX_HOME`, `--codex-home`). Analytics routes take a `projects` glob filter and report `coverage` for unattributed requests, and `GET /api/projects` lists usage per git root.
- Report data for any window ([#36](https://github.com/Collaboration95/yald/issues/36)): `buildReport()` turns a window, phases, sources (`claude-code`, `ocx`) and project globs into one versioned payload (`schemaVersion: 1`) with KPIs, a phase table that adds up exactly to the total, an hourly or daily timeline by source, models, top conversations, quota burn and coverage notes. Conversation ids, home paths and account labels are redacted by default, and the same input always gives byte-identical JSON. `buildReportSpec()` reads report requests the same way for the CLI and HTTP endpoint that follow.
- Self-contained HTML reports ([#37](https://github.com/Collaboration95/yald/issues/37)): `renderReportHtml()` turns a report payload into one HTML file with no network references, light and dark themes, accessible SVG charts and the payload embedded as `<script type="application/json" id="yald-report">`, ready to email, attach or embed.
- `GET /api/report` serves the same report from the running dashboard ([#39](https://github.com/Collaboration95/yald/issues/39)): window, repeated `phase`, `sources` (aliases `claude`, `codex`), `projects`, `top`, `redact` (on by default) and `title` as query parameters; `format=json` (default) returns `{ ok: true, report }`, `format=html` the self-contained HTML report under a CSP that blocks every fetch and script, and `download=1` names the attachment for the window's local start (`yald-report-2026-10-11T0900+0800.html`). Invalid inputs are a 400 naming the parameter, such as `phase[2]`, and pinned windows answer 304 until the data changes.
- `yald report` ([#38](https://github.com/Collaboration95/yald/issues/38)): writes a standalone HTML report, and optionally its JSON payload, for any window, phases, sources and project globs without starting the server or opening a port. `--out -` / `--json -` stream to stdout with progress on stderr, files are written atomically, `--dry-run` prints the resolved window, phases and row counts, and `--open` opens the result in the default browser. Invalid input exits 2 with the parser's message. See README "Reports".
- Hover and focus personality across the dashboard: each navigation and stat icon gets its own animation, money stats turn green and float dollar signs, and card links, model dots, leaderboard bars, filters, and the footer react to the pointer. A few easter eggs are hidden for curious users. Reduced-motion preferences switch all of it off.

### Changed

- Source capabilities and per-request measurement presence now distinguish unavailable data from observed zero. Claude transcript outcomes are `unobserved`; reliability uses eligible requests and returns `successRate: null` without observed outcomes. API responses include measurement coverage and price-presence counts. Existing live Claude records are appended once to Yald's own archive to retain new presence flags; older archive-only records keep unavailable presence until matching live evidence exists.

- **Time windows are half-open, `[from, to)`.** `to` used to be inclusive; a request recorded exactly at `to` now belongs to the next window, so contiguous windows add up exactly. Queries with an explicit `to` no longer count requests recorded exactly at that instant, and the prior period is now `[from − span, from)` ([#34](https://github.com/Collaboration95/yald/issues/34)).
- Hour, day and week buckets, the heatmap and labels follow the request `tz` (default `YALD_TZ`, then the system zone) instead of the server process's timezone.
- Window parameters are strict: an unknown `range`, a `to` without `from`, `last` or `range`, or an empty window returns HTTP 400 instead of falling back to the last 30 days.

### Fixed

- Blank phases and colliding HTML/JSON output paths are rejected before report files are written. Analytics source filters now agree with report totals ([#41](https://github.com/Collaboration95/yald/pull/41), [#42](https://github.com/Collaboration95/yald/pull/42)).
- Blank window inputs and oversized durations return structured errors; early calendar years, partial-hour DST changes and date-line transitions resolve correctly ([#43](https://github.com/Collaboration95/yald/pull/43)).
- Report quota samples stay inside the requested window, conversation IDs remain separate across sources, and model/conversation costs retain micro-dollar precision. HTML preserves phases named `Total` and explains reasoning and coverage accurately. Report ETags reflect the validated payload ([#44](https://github.com/Collaboration95/yald/pull/44)).
- Project attribution refreshes after same-size transcript or rollout edits and external archive updates, retains Claude working directories through resumed copies, and accepts whitespace in capped Codex metadata. Git-root changes update project rollups and invalidate project/report conditional responses.
- A `from` or `to` that cannot be read, such as an ISO time whose unencoded `+08:00` decoded to a space, now returns HTTP 400 with `{ ok: false, error: { code, param, message } }` instead of silently answering for the last 30 days ([#32](https://github.com/Collaboration95/yald/issues/32)).

## [0.1.0] - 2026-10-03

### Added

- Read-only dashboard over opencodex usage, spend, and quota ledgers, with eight analytics views.
- Pricing parity with `ocx usage`, fixture-based smoke coverage, metric and API documentation, and an installable CLI.
- Initial project work tracked by [issues #1](https://github.com/Collaboration95/yald/issues/1), [#2](https://github.com/Collaboration95/yald/issues/2), [#3](https://github.com/Collaboration95/yald/issues/3), [#4](https://github.com/Collaboration95/yald/issues/4), [#5](https://github.com/Collaboration95/yald/issues/5), [#6](https://github.com/Collaboration95/yald/issues/6), [#7](https://github.com/Collaboration95/yald/issues/7), and [#8](https://github.com/Collaboration95/yald/issues/8).
- CLI version reporting with `yald --version`.

### Changed

- Product identity is yald; opencodex remains the data source.
- Adopt Relay's paper surfaces, ink and coral charts, and consistent model colors across all eight analytics views and conversation detail, in light and dark themes.
- Center the desktop dashboard within a 1,480 px frame and move the eight navigation tabs into a left rail.
- Let Overview widgets keep their natural heights, with independent columns that bring the following panels directly beneath their content.
- Separate model leaderboard token volume and cost, label token share, success rate, and latency p50, and wrap long model names.
- Give Yald a brief periodic wiggle and expand it to `YetAnotherLlmDashboard` on hover or keyboard focus with a randomly selected transition; respect reduced-motion preferences.

### Removed

- Remove the “Your work, in view” tagline and replace “ledger” wording in the interface with activity and send accounting.

### Fixed

- Reuse unchanged usage snapshots during refresh and invalidate pricing overlays when their inputs change, retaining API data and freshness semantics.
- Exclude tests and design-verification files from the distribution package; include the prebuilt dashboard and the `yald` launcher.
