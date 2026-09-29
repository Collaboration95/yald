# yald v0.1.0 — draft release notes

## Overview

- yald is a read-only local dashboard for opencodex usage, spend, and quota data.
- It turns local usage ledgers into eight views for tokens, cost, performance, reliability, models, quota, and conversations.
- Cost estimates use opencodex's `ocx usage` pricing engine, and the UI and API run together in one local process.

Hero screenshot: [Overview dashboard](screenshots/overview.png).

## What it does

- Eight views cover overview, token usage, cost, performance, reliability, models, quota, and conversations.
- Cost estimates reuse the opencodex `ocx usage` pricing engine, including user price overlays and long-context rates.
- The app reads local ledgers and serves the web UI and API from one process.
- The dashboard includes token composition, latency and reliability metrics, model comparisons, quota burn estimates, and conversation drill-downs.

## Install

```bash
npx -p yald-dashboard yald --open
```

Or clone the repository and run `bun install && ./scripts/serve.sh`. See the [README installation details](../README.md#install).

## Known limits

- Unpriced or unmetered requests are excluded from estimated cost totals and shown as coverage gaps.
- Quota burn estimates need at least two samples in the selected range; otherwise no projection is made.
- `routing-history.sqlite` is not read; the JSONL usage ledger is the supported source.
- Estimates depend on the fields present in the local ledger; incomplete or changing upstream data can affect coverage and metrics.
