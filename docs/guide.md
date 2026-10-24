# Investigating usage with Yald

This guide describes 0.2.0, including Claude ingestion, reports, Yaldi and Labs.
The earlier v0.1.0 prerelease has the opencodex dashboard only. See
[installation](install.md) for GitHub asset availability and source setup.

All dollar figures are **API list-price equivalents**, not subscription bills
or proof of savings. [Metrics](metrics.md) defines eligibility and denominators;
[local data and archive behavior](install.md#data-locations-and-local-archive)
explains what Yald reads and writes.

## Dashboard views

The desktop dashboard supports light and dark themes. Visible views poll every
30 seconds, unchanged responses use ETags, and hidden tabs pause polling.
Refresh forces a re-read. After a filter or range change, the previous numbers
stay on screen, dimmed under an "Updating" notice, until the new selection's
numbers arrive. The project list in the toolbar is not polled; Refresh reloads it.
After a reload, each view first shows the results it last received for the same
selection, under a "Showing saved results as of …" notice with the time they were
saved, while fresh numbers load; if that refresh fails, the notice stays and says
so. Unavailable values stay unavailable in saved results. See
[data locations](install.md#data-locations-and-local-archive) for what the browser keeps. Recorded usage is available with the proxy stopped;
quota then remains the last captured account observation.

- **Overview:** six headline figures with the change against the previous period
  (hover a change for what it compares), usage over time by model, provider or
  effort, the top models, plan usage and the biggest sessions. Success rate and
  time to first token are tagged **Codex only**. Plan usage is an account-wide
  opencodex reading; a reading older than a day is marked stale. It shows only
  when your selection includes opencodex.
- **Usage:** cached versus new tokens, the cache hit rate, tokens by model,
  provider or effort, and the activity heatmap (click a cell for its busiest
  dates), with effort and provider tables. Reasoning is already within output.
  Claude Code records no effort level, so its requests read "Not recorded".
- **Cost:** estimated cost, cost per million tokens and the share of spend held by
  your ten costliest sessions; spend over time, cumulative spend, the most
  expensive sessions, where tokens and dollars go by token class for each source,
  and a cost-by-model table (top eight; models with no price fold into
  "+N unpriced"). Dollars are API list-price equivalents, not a bill. Use Cache
  savings in Labs for net cache economics.
- **Performance:** speed and reliability for opencodex requests, tagged **Codex
  only** because Claude transcripts record no timing or outcome: time to first
  token and latency percentiles, generation speed, a first-token/output scatter,
  timings by model and the slowest requests (requests open for over ten minutes
  are stalled streams and are left out). When there are failures it adds
  failures over time, an error breakdown and recent failures grouped by model and
  error.
- **Context:** how long contexts are (`inputTokens`, including cached tokens):
  median and p90, requests by context size, a box plot per model, length over
  time, a per-model table, what longer contexts coincide with by band, and
  session growth. Statistics below their minimum sample read "few requests". The
  box-plot legend, caveats and coverage sit behind (i) tooltips; a **Partial**
  badge appears when under 95% of requests could be measured.
- **Sessions:** source-qualified sessions, named by the project they ran in, ranked
  by tokens, cost, requests, recency or errors; the count and medians cover every
  session in the selection. Detail shows tokens over the session, context size
  per request and the requests, with cache misses (a request that reread none of
  its prompt from the cache) highlighted.

Models, Quota and Reliability are no longer pages: their links open Cost, Overview
and Performance. `/conversations` links open `/sessions`.

Source and Project controls apply to request views and CSV export. Provider is
a separate filter: an Anthropic provider does not imply a Claude transcript.
Session identity is `(source, conversationId)`, even when two sources share an ID.
Unknown folders are excluded under a project filter with an explicit count;
[attribution reasons](metrics.md#project-attribution) explain the gap. Pricing
coverage counts priced requests independently of known project folders.

## Labs investigations

Turn **Labs** on from the settings menu (the gear next to the theme toggle). The
preference is saved for this browser origin. Turning Labs off unmounts its views
and stops their queries; a disabled Labs link offers to turn it back on. **Hide
artwork**, in the same menu, hides Yaldi's decorative images while keeping every
explanation, value and control. Artwork supplies no evidence of its own.

Labs opens on a board of four cases, each a finding and one number. Every
investigation uses one layout: Yaldi's one-line verdict with a big number, one
chart, a top-five list with short names, a **See the requests** button, and an (i)
holding the rule, coverage, scope and windows. The board shows one 30-day window
until you pick a range; its Investigate links keep that window. Direct investigation
links default to 30 days for spikes and context growth, 7 days for projects and cache
savings. The board and investigations share time-window, source, project and model
controls. Hidden request filters from other pages do not constrain Labs. Evidence
links keep the actual finding's fixed cohort, including any explicit case selectors.

**Spikes** marks local days whose priced cost is unusually high against your own
recent loaded history. A day is unusual when its priced cost is above 2.5 times the
median daily priced cost over the previous 14 active days (days with at least one
priced request). With fewer than 7 baseline days, or a $0 median, the day is "not
enough history", never "normal"; partial days (today, or cut by the window edge)
get a hollow bar with the reason. The page opens on the biggest unusual day; click
any bar to pick another. The breakdown lists the five biggest increases by model,
project, session or token class, opening on Model when unattributed requests make
up most of the change. The day is compared with a typical day (the median); the
per-group breakdown compares each group with the average of the baseline days.
Dollars are API list-price equivalents of priced requests at today's prices. A
spike is not a budget breach, and a share of dollars says where they landed, not
why.

**Projects** asks which projects cost more or less than the equally long period
right before. Named projects and Unattributed stay distinct. Both periods use the
same cohort and loaded price assumptions. "New" means newly observed activity in
these windows, not a project creation date or delivered value.

**Cache savings** leads with what caching saved: the identical recorded workload,
with its observed cache counters, priced against the same input uncached. Read
discount minus write premium is the net; negative means write premiums outweigh
read discounts. Eligibility needs logical reported usage, inclusive input, both
observed cache counters and adequate engine prices/tier provenance. This does not
measure prefix survival, cache-miss causes or subscription savings. See
[net cache economics](metrics.md#net-cache-economics).

**Context growth** shows submitted input in request order within a
source-qualified session. With at least six eligible requests, it compares the
median input of the first three with the last three; a zero baseline has no ratio.
Missing input and attempt sums remain gaps, while measured zero remains valid. An
input drop or adjacent model change establishes no compaction, cause or answer
quality. See [context metrics](labs-context.md).

Each finding's **See the requests** button opens a **fixed case**: a plain table of time, model, project, tokens and cost. It retains the exact
original half-open window, timezone, full cohort and source-qualified selection
through reload, pagination and global-toolbar changes. Radar keeps its original
current/prior pair; switching periods does not rebase it. Full-population counts
precede pagination. Cache shows its eligible population plus original totals and
exclusions; Context retains excluded rows with unavailable submitted input.
Source, session or unnamed identity, request ID, timestamp and ordinals distinguish
rows without exposing transcript bodies. See [case evidence](labs-evidence.md)
for monetary precision, limitations and recovery from an invalid case URL.

## Reports

The 0.2.0 package includes `yald report`. These examples use a
[development checkout](install.md#development-checkout) with dependencies
installed; replace `node scripts/yald.mjs` with `yald` in an installed package:

```bash
node scripts/yald.mjs report --last 8h --out recent.html --json
node scripts/yald.mjs report --from yesterday --to today --tz Asia/Singapore --out yesterday.html
node scripts/yald.mjs report --tz Asia/Singapore \
  --phase 'Prep=2026-10-10 23:30..2026-10-11 09:00' \
  --phase 'Build=2026-10-11 09:00..+6h' \
  --phase 'Review=2026-10-11 15:00..2026-10-11 18:00' \
  --project '~/work/app-*' --out investigation-phases.html --json
```

A report is one self-contained HTML file with inline styling, SVG charts and an
embedded JSON payload. `--json` also writes a JSON file. No server or listening
port is opened. `--open` opens the written HTML in the default browser.
The [report API](api.md#get-apireport) produces the same report data from a
running dashboard; a Labs evidence URL is a separate fixed-case view.

Windows are half-open (`[from, to)`). Naive times use `--tz`, then `YALD_TZ`,
legacy `OCX_OBSERVATORY_TZ`, then the system zone. `--last 8h` is elapsed time;
calendar-day durations and daylight-saving rules are in
[time windows](api.md#time-windows). Named phases must lie inside the window
without overlap. Phase totals plus time outside phases add up to the total.

`--source claude-code,ocx` selects protocols; `claude` and `codex` are aliases.
Repeat `--project` for more folder/ancestor globs. Unknown project attribution is
excluded and disclosed separately from unpriced requests. Quote globs so the
shell does not expand them. `--ocx-home`, `--claude-projects` and `--codex-home`
override data paths; `OCX_PACKAGE_DIR` selects pricing. Filtering does not delete
or disable the local Claude archive.

Without `--out`, the filename uses the local start, such as
`yald-report-2026-10-11T0900+0800.html`. `--out -` sends HTML to stdout;
`--json -` sends JSON to stdout. They cannot both use stdout at once. Progress
uses stderr. `--dry-run` prints resolved bounds, phases and source counts without
writing report outputs; reading Claude usage can still update Yald's archive.
`node scripts/yald.mjs report --help` lists all options. Invalid input exits 2;
runtime failures exit 1.

Reports redact conversation IDs to eight characters, home paths to `~` and omit
account labels by default. `--no-redact` keeps them. Other paths, models,
timestamps and usage can remain identifying; review the HTML and embedded or
separate JSON before sharing. Unpriced usage contributes requests/tokens and
coverage counts but no guessed dollars. A partial money sum is not a cost for
the entire population, and missing input is not an observed context of zero.

[README](../README.md) · [Installation](install.md) · [Metrics](metrics.md) ·
[API](api.md) · [Architecture](architecture.md)
