# OCX Observatory

[![ci](https://github.com/Collaboration95/yald/actions/workflows/ci.yml/badge.svg)](https://github.com/Collaboration95/yald/actions/workflows/ci.yml)

A read-only analytics dashboard for [opencodex](https://github.com/lidge-jun/opencodex). opencodex already records everything
worth charting — this puts it on one screen: token volume, estimated spend, cache economics, latency, reliability,
quota burn, model comparison and per-conversation drill-down.

The dashboard reads the ledgers directly, so it works whether or not the proxy is running. Pages refresh every 30
seconds, and the Refresh button forces an immediate re-read.

## Quick start

```bash
./scripts/serve.sh          # build the web app, then serve API + UI on one port
# → http://127.0.0.1:4318

./scripts/dev.sh            # API on :4318 + Vite HMR on :5317 (proxies /api)
./scripts/smoke.sh          # render every page against your real ledgers
```

The scripts resolve a Bun runtime on their own: `BUN_BIN`, then `bun` on `PATH`, then the runtime bundled inside the
opencodex npm package. Nothing else needs installing beyond `bun install` for dependencies.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4318` | API / UI port |
| `OCX_HOME` | `~/.opencodex` | Where the ledgers live |
| `OCX_PACKAGE_DIR` | auto-detected | Location of the installed `@bitkyc08/opencodex` package |
| `OCX_OBSERVATORY_TZ` | system timezone | Timezone used for calendar bucketing |

## Where the numbers come from

| Source | What it gives |
| --- | --- |
| `~/.opencodex/usage.jsonl` | One row per logical request: provider, model, effort, status, TTFT, duration, token classes, attempts, cache provenance, route decision |
| `~/.opencodex/spend-ledger.jsonl` | Physical send accounting — `reserve` → `dispatch` → `settle`, plus `lost` sends |
| `~/.opencodex/codex-quota-cache.json` | Current quota windows and every sample ever captured from provider response headers |
| `~/.opencodex/routing-history.sqlite` | Indexed mirror of the usage rows (not read by default; the JSONL is fresher) |

Pricing is not reinvented here. The server imports `@bitkyc08/opencodex/src/usage/cost.ts` at runtime, so every dollar
figure matches `ocx usage` exactly, including your own `ocx models set-price` overlays and long-context rate bands.
If the package cannot be found, the UI keeps working and marks cost as unavailable.

## Views

- **Overview** — KPI row with period-over-period deltas, stacked usage chart (tokens / cost / requests × model /
  provider / effort), cost composition donut, cache savings, model leaderboard, weekday × hour heatmap, quota gauges,
  context pressure, throughput, recent requests.
- **Usage** — token composition over time (cache read vs fresh input vs output vs reasoning), cache hit rate and
  dollars saved, grouped volume by any dimension, large activity heatmap, context-size histogram and breakdown tables.
- **Cost & spend** — spend stacked by model/provider/effort, cost split by token class, cumulative spend, cache savings
  timeline, blended price per 1M tokens, most expensive sessions, cost table with unpriced coverage.
- **Performance** — latency and TTFT percentiles over time, throughput timeline, duration / TTFT / throughput
  histograms, TTFT vs output length scatter, slowest requests, per-model latency table.
- **Reliability** — outcome split, HTTP status codes, attempts-per-request, outcomes over time, error-code table with
  tokens burned, failure rate by model, metering coverage, recent failures.
- **Models** — price vs TTFT scatter (bubble = volume), tokens by provider and model, effort mix, sortable comparison
  table with $/1M, TTFT p50, latency, tok/s, success rate and cache hit rate, effort × model matrix.
- **Quota** — per-window gauges, measured burn rate (%/day), projected exhaustion vs reset time, utilisation history
  per account and window, spend-ledger send/token flow, and a burn table flagging windows that will exhaust before they
  reset. The range selector scopes the history chart, the burn rate and the ledger; current utilisation stays
  point-in-time because that is what the provider reports.
- **Conversations** — sessions ranked by tokens, cost, requests, recency or errors, plus a detail view with cumulative
  token growth against submitted context size, model mix and the request list.

## Ideas worth building next

These came out of the same ledgers and would be straightforward additions:

- **Cache break-even analysis** — for each conversation, how much of the prompt prefix survived between turns, and what
  a different turn cadence would have cost.
- **Model switch timeline** — when a conversation moved between models and what the move cost or saved.
- **Retry cost attribution** — attribute re-sent tokens to the error code that caused the retry.
- **Budget guardrails** — daily/weekly spend targets with projected month-end spend and an alert threshold.
- **Quota simulator** — "what happens to my weekly window if I run this workload", derived from measured tokens/minute.
- **Latency regression detection** — compare each model's p95 against its own trailing baseline and flag shifts.
- **Conversation fingerprints** — cluster sessions by tool-call shape and tokens per turn to find expensive patterns.
- **Hub aggregation** — opencodex supports a remote hub; the same views could aggregate multiple machines.

## Architecture

```
server/src/env.ts              resolves OCX_HOME and the installed opencodex package
server/src/ocx/pricing.ts      imports opencodex's cost engine (with a safe fallback)
server/src/ocx/store.ts        parses usage.jsonl, spend-ledger.jsonl and the quota cache into compact rows
server/src/analytics.ts        filtering, bucketing, percentiles, breakdowns, quota projections
server/src/api.ts              Hono routes under /api
server/src/index.ts            boot, static serving, SSE wiring
web/src/pages/*                one file per view
web/src/components/chartOptions.ts  shared ECharts option builders
```

The whole ledger is parsed and priced in roughly 200 ms for ~66k requests, so the server re-reads the files whenever
their size or mtime changes instead of caching stale aggregates. Pages poll every 30 seconds, and the Refresh button
forces a rebuild.

## Verification

```bash
./scripts/smoke.sh                 # server-renders every page against your real ledgers
./scripts/smoke.sh --fixtures      # same, against a generated synthetic ledger
bun run typecheck                  # web + server TypeScript
bun run build                      # production web bundle
```

The smoke test fails if a page throws, if an expected section is missing, if the HTML contains `NaN`, `Invalid Date`,
`undefined`, `Infinity` or `[object Object]`, or if the quota view stops responding to the range selector.

When `~/.opencodex/usage.jsonl` is missing — a fresh clone or CI — the smoke test generates a synthetic opencodex home
with realistic rows, quota samples and ledger events, so every page is still exercised with data. Expectations are
derived from the API responses rather than hardcoded, so the suite passes against any ledger, including yours.

## Development

```bash
bun install            # install workspace dependencies
./scripts/dev.sh       # API with reload + Vite HMR on :5317
./scripts/serve.sh     # production build served from one port
```

The API is a plain Hono app (`server/src/api.ts`) and can be exercised without a browser, which is what the smoke test
does: it swaps `globalThis.fetch` for the app's own handler and renders each page with React's server renderer.

## License

MIT — see [LICENSE](./LICENSE).

## Known limits

- `surface` is empty in this installation's rows, so there is no Codex/Claude/Grok split; the field is rendered if it
  ever appears.
- Requests that failed before any tokens were metered carry no usage, so failure cost shows as zero rather than a guess.
  The Reliability page reports metering coverage instead of inventing numbers.
- Unpriced models (subscription or free routes) are excluded from cost totals and surfaced as an explicit share.
- Quota samples only refresh while the proxy is running; with the proxy stopped you see the last known values.
