# Architecture

Last checked: 2026-10-06.

Yald reads local usage data from opencodex and Claude Code, normalizes both sources into a shared request format, and serves analytics through a local API and web dashboard.

```text
opencodex ledgers ─┐
                   ├─> data store ─> analytics ─> API ─> dashboard
Claude transcripts┘
```

The server reads opencodex usage, spend, and quota files from `OCX_HOME`. Claude Code subscription transcripts are read from `CLAUDE_PROJECTS_DIR` (by default, `~/.claude/projects`). Claude usage is normalized alongside opencodex usage and priced with the opencodex cost engine when it is available.

The analytics layer filters and groups normalized requests, computes time series and summary metrics, and returns JSON from the `/api` routes. The React dashboard displays those results. The server also serves the built web app, so the dashboard and API use one local process.

```text
server/src/env.ts                  resolves data locations and runtime settings
server/src/ocx/store.ts             reads and normalizes opencodex ledgers
server/src/claude/transcripts.ts    adapts Claude Code session transcripts
server/src/ocx/pricing.ts           connects to opencodex pricing
server/src/analytics.ts             filters and computes dashboard metrics
server/src/api.ts                  exposes analytics routes
server/src/index.ts                starts the API and serves the web app
web/src/pages/                     dashboard views
web/src/components/chartOptions.ts shared chart configuration
```

Claude Code transcript usage is retained in a local Yald data file so usage remains available if the source transcript is later removed. The dashboard is read-only with respect to the original opencodex and Claude Code data.
