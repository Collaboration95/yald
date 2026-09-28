# yald v0.1.0 — draft release notes

yald is a read-only local dashboard for opencodex usage, spend, and quota data.

## What it does

- Eight views cover overview, token usage, cost, performance, reliability, models, quota, and conversations.
- Cost estimates reuse the opencodex `ocx usage` pricing engine, including user price overlays and long-context rates.
- The app reads local ledgers and serves the web UI and API from one process.

## Install

```bash
npx -p yald-dashboard yald --open
```

Or clone the repository and run `bun install && ./scripts/serve.sh`. See [installation details](install.md).

## Known limits

- Unpriced or unmetered requests are excluded from estimated cost totals and shown as coverage gaps.
- Quota burn estimates need at least two samples in the selected range; otherwise no projection is made.
- `routing-history.sqlite` is not read; the JSONL usage ledger is the supported source.
- Publishing and external launch posts require maintainer approval.

Hero image: `screenshots/overview.png`.
