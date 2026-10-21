# Architecture

Yald reads local opencodex usage ledgers and Claude Code transcripts, normalizes
them into shared requests, and serves analytics through a local API and desktop
web dashboard. Yaldi is the decorative detective companion; findings and their
coverage come from server calculations. This describes 0.2.0;
the earlier v0.1.0 preview predates Claude ingestion, reports and Labs. See
[installation](install.md) for GitHub asset availability.

```text
opencodex ledgers ───────────────────┐
Claude transcripts + Yald archive ──┼─> normalized store ─> analytics ─> API ─> dashboard
Codex rollout session metadata ─────┘                         └─> standalone report
```

## Local storage and source identity

The store reads usage, physical-send and quota files under `OCX_HOME` (default
`~/.opencodex`) and transcripts under `CLAUDE_PROJECTS_DIR` (default
`~/.claude/projects`). Codex rollout first lines under `CODEX_HOME` (default
`~/.codex`) supply session-folder attribution for opencodex requests.
[Installation](install.md#data-locations-and-local-archive) lists the exact paths.

Source logs stay untouched. On dashboard or report reads, Yald can append
normalized Claude usage metadata to its **own local archive**,
`$OCX_HOME/yald-claude-usage.jsonl`. Read-time deduplication retains the most
complete request snapshot. There is no automatic expiry. Deleted transcripts
or an empty transcript directory do not remove archived usage, and source
filters neither delete archives nor disable ingestion. A fresh isolated run
needs a fresh `OCX_HOME` as well as empty transcript and Codex directories.

Source follows ingestion protocol: `claude-code` for transcripts, `ocx` otherwise.
It never follows provider; an Anthropic request through opencodex is still `ocx`.
Sessions use `(source, conversationId)`. Source capability and per-request
measurement presence are separate. Claude compatibility status/attempt defaults
cannot become observed outcomes, retries or timing. Missing input stays
unavailable for context, including attempt-summed usage; measured zero is valid.

## Computation and interfaces

The analytics layer uses half-open windows and shared source/project/cohort
filters. The dashboard polls visible views every 30 seconds; hidden tabs pause
polling. ETags and parsed snapshots avoid repeated work when inputs are unchanged.
The server checks the source files at most once per second, and time-bucketed
series resolve each local bucket once rather than once per row; `Server-Timing`
headers report build and compute time. Rolling windows resolve on a clock
rounded down to 10 seconds, so `window.to` can lag real time by up to that
quantum; within it, repeats share one window, one ETag and one memoized body,
and one selection's filtered rows are shared by the toolbar and page requests.
Any rebuild empties these memos. Refresh forces a re-read. Account quota/send data declare their account scope
rather than claiming project attribution. See [metrics](metrics.md) and the
[API reference](api.md).

All costs are **API list-price equivalents**, not subscription bills or proof
of savings. Pricing delegates to the installed opencodex module; there is no
second catalog or historical-price snapshot. The API exposes engine availability.
Missing prices remain unavailable, and pricing coverage stays independent of
project attribution. [Pricing discovery](install.md#pricing-discovery) describes
the search paths and restart requirements.

Labs is gated by local browser preferences. Its server builders own Project
Radar comparisons, Cache Detective economics and Context Replay medians/history.
A finding's [fixed case](labs-evidence.md) carries a validated complete selector,
not just the toolbar's mutable filters. Radar retains both original periods;
full-population totals and eligibility precede pagination. Rows preserve
source-qualified identities and ordinals. No client pricing, model call,
causal inference or transcript-body viewer is involved.

The report CLI uses the same store, window parser and report builder as the
report API, writes standalone HTML/JSON and starts no listener. It can update
Yald's archive while reading. The web server serves the built UI and API in one
process. The packaged launcher defaults to port **4318**; starting the server
directly defaults to **4317**. [Listener options](install.md#listener-defaults-and-options)
explain precedence instead of assuming the same default for every entry point.

## Code map

| Path | Responsibility |
| --- | --- |
| `server/src/env.ts` | Data locations, listener settings and pricing-package discovery |
| `server/src/ocx/store.ts` | File snapshots, normalization and joined attribution |
| `server/src/claude/transcripts.ts` | Claude conversion, deduplication and local usage archive |
| `server/src/codex/sessions.ts` | Codex rollout session-metadata index |
| `server/src/projects.ts` | Folder globs and nearest git roots |
| `server/src/ocx/pricing.ts` | Imported opencodex pricing and fixed-workload cache comparisons |
| `server/src/report/source.ts` | Protocol identity, source capabilities and measurement eligibility |
| `server/src/analytics.ts` | Shared filtering and dashboard metrics |
| `server/src/labs/` | Investigation builders, selectors and fixed evidence |
| `server/src/report/` | Report specification, aggregation, rendering and CLI |
| `server/src/api.ts`, `server/src/index.ts` | HTTP API and built web application |
| `scripts/yald.mjs` | Packaged Node launcher and report dispatch |
| `web/src/pages/`, `web/src/pages/labs/` | Dashboard and Labs views |
| `web/src/components/chartOptions.ts` | Shared chart configuration |

## Interface and future work

The Relay desktop interface uses paper surfaces, ink/coral charts and consistent
model colors, with saved light/dark preference. The eight analytics views and
conversation detail are described in the [user guide](guide.md#dashboard-views).
Yaldi's local static assets are decorative and can be hidden without losing
explanations or controls. Mobile and tablet layouts are outside the supported
scope.

The [release roadmap](https://github.com/Collaboration95/yald/blob/dev/docs/planning/yaldi-release-plan.md) retains deferred ideas:
cache-prefix survival and alternate-cadence analysis, model-switch cost timelines,
retry-cost attribution, budgets, quota simulation, latency regression detection,
conversation fingerprints and hub aggregation. Existing request records do not
by themselves establish causes, productivity, compaction or answer quality.
These possibilities are not claims about implemented features.

[README](../README.md) · [Installation](install.md) · [Metrics](metrics.md) ·
[Views and reports](guide.md) · [Contributing](../CONTRIBUTORS.md)
