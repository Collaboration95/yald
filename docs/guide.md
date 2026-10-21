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

- **Overview:** period comparisons, usage by model/provider/effort, token-class
  cost composition, gross cache-read discount, model leaderboard, activity
  heatmap, quota, context pressure, throughput and recent requests.
- **Usage:** fresh input, cache read/write, output and reasoning composition;
  eligible cache-read ratio, grouped volume, activity heatmap, context-size
  distribution and breakdown tables. Reasoning is already within output.
- **Cost & spend:** priced cost by model/provider/effort and token class,
  cumulative cost, gross cache-read discount, blended price per million tokens,
  expensive sessions and unpriced coverage. Gross read discount excludes write
  premiums; use Cache Detective for net fixed-workload economics.
- **Context:** how long contexts are (`inputTokens`, including cached tokens):
  median, p90, p99 and maximum per model, a box plot, a model-by-band grid, the
  share of requests and list-price cost at or above 50k, 150k and 300k, a
  by-band table of cost, time to first token and cancel rate, and session
  growth. Statistics below their minimum sample read "too few requests";
  opencodex-only columns read "not recorded" for Claude Code. The context
  histograms on Overview, Usage and Performance link here.
- **Performance:** measured duration and time-to-first-token (TTFT) percentiles,
  throughput, distributions, TTFT/output scatter, slow requests and model
  timings. Claude transcripts are ineligible for timing and throughput.
- **Reliability:** observed outcomes and HTTP codes, measured attempts/retries,
  errors, metered retry overhead and failure coverage. Claude outcomes and
  retries are unobserved; they cannot establish a success or failure rate.
- **Models:** volume, provider/model and effort mix, base rates, measured timing,
  throughput, observed-outcome success rate and eligible cache-read ratio.
  Missing measurements stay unavailable rather than entering those denominators.
- **Quota:** opencodex account gauges, observed burn, exhaustion/reset comparisons,
  utilization history, send/token flow and burn tables. The selected window
  scopes history and burn; current utilization is point-in-time. Project/model
  filters cannot scope account quota or the physical-send ledger. Claude-only
  selection makes these unavailable.
- **Conversations:** source-qualified sessions ranked by tokens, priced cost,
  requests, recency or observed errors. Detail shows recorded input, cumulative
  volume, model mix and request metadata, with window/cohort exclusions.

Source and Project controls apply to request views and CSV export. Provider is
a separate filter: an Anthropic provider does not imply a Claude transcript.
Session identity is `(source, conversationId)`, even when two sources share an ID.
Unknown folders are excluded under a project filter with an explicit count;
[attribution reasons](metrics.md#project-attribution) explain the gap. Pricing
coverage counts priced requests independently of known project folders.

## Labs investigations

Enable **Labs** in the sidebar and choose an investigation. The preference is
saved for this browser origin. Disabling Labs unmounts its views and stops their
queries; a disabled case URL can be recovered by enabling Labs. **Hide artwork**
hides Yaldi's decorative images while keeping every explanation, value and
control. Artwork supplies no evidence of its own.

**Project Radar** asks which projects account for requests, tokens and priced
cost, and what changed against the immediately preceding equal-duration window.
Named projects and `(unattributed)` remain distinct. Both periods use the same
cohort and loaded price assumptions. Price gaps, unknown folders and incomplete
loaded history have separate coverage. “New” means newly observed activity in
these windows, not a project creation date or delivered value.

**Cache Detective** compares the identical recorded workload, with its observed
cache counters, against the same input priced uncached. Read discount minus write
premium is net benefit; negative means write premiums outweigh read discounts.
Eligibility needs logical reported usage, inclusive input, both observed cache
counters and adequate engine prices/tier provenance. Excluded requests and
reasons remain visible. This comparison does not measure prefix survival, cache
miss causes, a different request cadence or subscription savings. See
[net cache economics](metrics.md#net-cache-economics).

**Context Replay** displays submitted input in request order within a
source-qualified session. With at least six eligible requests, it compares
median input of the first three with the last three; a zero baseline has no
ratio. Missing input and attempt sums remain gaps, while measured zero remains
valid. Shorter sequences stay inspectable without ranked growth. An input drop
or adjacent model change establishes no compaction, cause or answer quality.
See [context metrics](labs-context.md).

Each finding's evidence action opens a **fixed case**. It retains the exact
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
