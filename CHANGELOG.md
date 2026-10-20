# Changelog

All notable changes to yald are recorded here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning. It stays on 0.x while the upstream opencodex ledger shape can change; 1.0 requires a stable ledger contract and published metric definitions.

## [Unreleased]

### Added

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
