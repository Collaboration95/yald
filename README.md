# Yald — Yet Another LLM Dashboard

[![Yald CI](https://github.com/Collaboration95/yald/actions/workflows/ci.yml/badge.svg)](https://github.com/Collaboration95/yald/actions/workflows/ci.yml)

**Follow the tokens. Find the story.** Yald turns local usage records into a
desktop dashboard for investigating token volume, estimated cost, cache use and
submitted context. **Yaldi** is its detective companion in optional Labs.

Dollar amounts are **API list-price equivalents**, not subscription bills or
proof of savings. Missing input or price is unavailable, not zero or free.

![Installed 0.2.0 Overview with Yaldi and labeled synthetic demo data](docs/screenshots/meet-yaldi-0.2.0/overview-light.png)

*Actual installed 0.2.0 demo, with synthetic usage and illustrative prices.
Overview's “cache savings” is the gross cache-read discount before write premiums;
use Cache Detective for the net fixed-workload comparison. See
[metric definitions](docs/metrics.md#net-cache-economics).*

## Install Meet Yaldi 0.2.0

The selected release candidate is **0.2.0 — Meet Yaldi** (2026-10-20), distributed
as `yald-dashboard-0.2.0.tgz`. Confirm that the
[v0.2.0 release page](https://github.com/Collaboration95/yald/releases/tag/v0.2.0)
contains the package and `SHA256SUMS` before running these commands. A versioned
link in this checkout does not establish publication. npm registry and Homebrew
distribution remain **unverified**; use the GitHub tarball.

The earlier [v0.1.0 prerelease](https://github.com/Collaboration95/yald/releases/tag/v0.1.0)
is an opencodex-only preview without Claude ingestion, reports, Yaldi, Labs or demo.

On macOS or Linux, use Node.js 18+, npm, an authenticated `gh` CLI and `shasum`:

```bash
release_dir="$(mktemp -d)"
yald_prefix="$HOME/.local"
gh release download v0.2.0 --repo Collaboration95/yald \
  --pattern 'yald-dashboard-0.2.0.tgz' --pattern SHA256SUMS --dir "$release_dir"
(cd "$release_dir" && shasum -a 256 -c SHA256SUMS) && \
npm install --global --prefix "$yald_prefix" "$release_dir/yald-dashboard-0.2.0.tgz"
export PATH="$yald_prefix/bin:$PATH"
yald --version
yald --help
yald demo --open
```

The version should be exactly `0.2.0`. The installed demo opens
**http://127.0.0.1:4318** with synthetic examples and illustrative prices; stop
with Ctrl+C to remove its temporary data. Run `yald --open` for your normal local
sources instead. Source files stay untouched; normal Claude ingestion writes
Yald's own archive with no automatic expiry, as explained below.
Choose another user-writable `yald_prefix` if needed; keep its `bin` on `PATH`.
See [installation, data locations and development setup](docs/install.md).

## Sources and capabilities

The following describes **0.2.0**. Supply existing opencodex
ledgers or Claude Code transcripts; Yald does not collect new model usage.
Pricing needs a discoverable installed opencodex cost engine, including for
Claude rows. [Exact paths and pricing discovery](docs/install.md#data-locations-and-local-archive).

| Recorded capability | opencodex (`ocx`) | Claude transcripts (`claude-code`) |
| --- | --- | --- |
| Tokens and cache counters | When recorded | When recorded; subagents included |
| API price equivalent | When usage and price are available | When usage and price are available |
| Outcomes / failures and retries | When observed | Unavailable |
| Duration / time to first token | When measured | Unavailable |
| Quota | Recorded account snapshots | Unavailable |
| Project folder | Joined Codex rollout metadata | Recorded `cwd` |

**Source is the ingestion protocol, not the provider.** Anthropic traffic through
opencodex remains `ocx`. Sessions use `(source, conversationId)`. Capability does
not guarantee that a row has a measurement. [Coverage definitions](docs/metrics.md#source-capabilities-and-measurement-coverage).

## Three questions for Labs

Enable **Labs** in the sidebar (already enabled in the isolated demo):

- **Project Radar:** Which projects account for activity and priced cost, and
  what changed against the immediately preceding equal-duration window?
- **Cache Detective:** For the identical recorded workload, do cache-read
  discounts outweigh cache-write premiums?
- **Context Replay:** How did recorded submitted input change within a
  source-qualified session?

Each finding opens a **fixed evidence case** with its original window, complete
cohort, source identity, coverage and request metadata. Toolbar changes do not
move that case; Radar retains both original periods. [Investigation guide](docs/guide.md#labs-investigations)
and [case evidence](docs/labs-evidence.md).

![Installed Cache Detective demo in dark theme, showing write premiums exceeding read discounts](docs/screenshots/meet-yaldi-0.2.0/cache-detective-dark.png)

*Synthetic example, not measured savings. More actual candidate
[screenshots and capture procedure](docs/release-candidate-v0.2.0.md#synthetic-screenshots).*

Explore without personal usage records in the installed package:

```bash
yald demo --open
```

From a checkout, use `node scripts/yald.mjs demo --open` after
[development setup](docs/install.md#development-checkout). Example prices are illustrative, not
live rates. See [the demo guide](docs/demo.md) for its sample clock and cleanup.

## One report

The installed 0.2.0 CLI also writes standalone reports:

```bash
yald report --from '2026-10-11 09:00' --to '2026-10-11 18:00' \
  --tz Asia/Singapore --out investigation.html --json
```

This writes a standalone HTML file and JSON without starting a server. Reports
redact IDs and home paths by default; review files before sharing. More
[report examples and window rules](docs/guide.md#reports).

## Limits and local storage

- Source files stay untouched. Yald **writes its own local Claude archive** at
  `$OCX_HOME/yald-claude-usage.jsonl` (default
  `~/.opencodex/yald-claude-usage.jsonl`), with no automatic expiry. An empty
  transcript folder does **not** remove archived usage; source filters do **not**
  delete archives. [Archive behavior](docs/install.md#data-locations-and-local-archive).
- Claude transcripts do not measure failures, retries, timing or quota; a
  compatibility HTTP 200 is not evidence of success. [Measurement limits](docs/metrics.md#source-capabilities-and-measurement-coverage).
- Price coverage and project attribution coverage are separate. Unpriced rows
  still count toward activity; project filters exclude unknown folders and
  disclose that exclusion. [Pricing](docs/metrics.md#metering-and-cost) · [Attribution](docs/metrics.md#project-attribution).
- Quota is account-wide and can be stale while the proxy is stopped. Loaded
  history may be incomplete. The desktop UI makes no claim about productivity,
  answer quality, compaction or cache-miss causes.

[Views and reports](docs/guide.md) · [Metrics](docs/metrics.md) · [API](docs/api.md) ·
[Architecture](docs/architecture.md) · [Contributing](CONTRIBUTORS.md) ·
[Changelog](CHANGELOG.md) · [Release procedure](docs/releasing.md) · [MIT license](LICENSE)
