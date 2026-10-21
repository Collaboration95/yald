# Meet Yaldi

**Yald 0.2.0 · 2026-10-20** — Follow the tokens. Find the story.

- Investigate local **opencodex and Claude Code** usage in one desktop dashboard.
- Explore **Project Radar**, **Cache Detective** and **Context Replay** in optional
  Labs, then inspect the exact requests behind a finding.
- Meet **Yaldi**, Yald's detective companion, and try the installed synthetic demo
  before pointing Yald at your own records.

![Installed Yald 0.2.0 Overview with Yaldi and visible Demo label](https://raw.githubusercontent.com/Collaboration95/yald/v0.2.0/docs/screenshots/meet-yaldi-0.2.0/overview-light.png)

*Actual installed candidate UI. All usage, projects, quota and prices in these
screenshots are synthetic; prices are illustrative, not live rates. The fixed
sample clock is 2026-10-20T12:00:00Z. Overview's older “cache savings” label is the
gross read discount before write premiums, not the net comparison below.*

## Three investigations, inspectable evidence

**Project Radar** compares project activity and priced cost with the immediately
preceding equal-duration window. It exposes missing attribution and price
coverage; unknown folders are not inferred. Project filters disclose excluded
unattributed requests.

**Cache Detective** compares cache-read discounts with cache-write premiums for
the identical recorded workload. The result is a fixed-workload API price
comparison, not measured savings. Unpriced or ineligible rows stay visible as
coverage gaps; zero-priced eligible rows remain distinct from missing prices.

**Context Replay** shows how recorded submitted input changes within a
`(source, conversationId)` session, retaining gaps and observed zero. It does
not reconstruct the model's internal context or establish compaction, answer
quality, productivity or causes of cache misses.

Each finding opens a fixed evidence case with its original source, window,
cohort, coverage and request metadata. Toolbar changes do not move the case;
Radar preserves both original periods. No transcript bodies are needed for these
investigations. Labs can be disabled and Yaldi artwork can be hidden.

![Project Radar installed synthetic example in light theme](https://raw.githubusercontent.com/Collaboration95/yald/v0.2.0/docs/screenshots/meet-yaldi-0.2.0/project-radar-light.png)

![Cache Detective installed synthetic example in dark theme](https://raw.githubusercontent.com/Collaboration95/yald/v0.2.0/docs/screenshots/meet-yaldi-0.2.0/cache-detective-dark.png)

![Context Replay installed synthetic example in dark theme, with missing input and observed zero](https://raw.githubusercontent.com/Collaboration95/yald/v0.2.0/docs/screenshots/meet-yaldi-0.2.0/context-replay-dark.png)

![Fixed Context Replay request evidence in the installed synthetic demo](https://raw.githubusercontent.com/Collaboration95/yald/v0.2.0/docs/screenshots/meet-yaldi-0.2.0/context-evidence-light.png)

These image URLs address the intended `v0.2.0` tag; they become public with that
tag. Packaged copies and the capture procedure are listed in the
[candidate packet](https://github.com/Collaboration95/yald/blob/v0.2.0/docs/release-candidate-v0.2.0.md#synthetic-screenshots).

## Install the GitHub package

The distribution baseline is `yald-dashboard-0.2.0.tgz` with `SHA256SUMS`.
Confirm both assets on the
[v0.2.0 release page](https://github.com/Collaboration95/yald/releases/tag/v0.2.0)
before using these commands; a checked-in copy of these notes does not establish
publication. macOS or Linux, Node.js 18+, npm, authenticated `gh` and `shasum`
are required. The UI is prebuilt and npm installs the Bun runtime dependency;
allow its installation scripts. No checkout or global Bun is required.

```bash
release_dir="$(mktemp -d)"
yald_prefix="$HOME/.local"
gh release download v0.2.0 --repo Collaboration95/yald \
  --pattern 'yald-dashboard-0.2.0.tgz' --pattern SHA256SUMS --dir "$release_dir"
(cd "$release_dir" && shasum -a 256 -c SHA256SUMS) && \
npm install --global --prefix "$yald_prefix" "$release_dir/yald-dashboard-0.2.0.tgz"
export PATH="$yald_prefix/bin:$PATH"
yald --version
yald demo --open
```

Continue only after the checksum says `OK` and the CLI prints exactly `0.2.0`.
The demo opens `http://127.0.0.1:4318`, labels every page **Demo / synthetic
data**, and uses invented records from both sources, quota and illustrative
prices. Labs starts enabled. Ctrl-C stops the server and removes its generated
homes and synthetic archive; closing the browser alone does not stop it. No
provider credentials, model calls or live pricing are needed. For repeatable
examples, use `yald demo --now 2026-10-20T12:00:00Z`.

For normal local records, use `yald --open`. Source files remain untouched.
Normal Claude ingestion writes normalized usage metadata to Yald's own
`$OCX_HOME/yald-claude-usage.jsonl` archive, with **no automatic expiry**. It does
not store prompt/response bodies. Emptying the transcript folder or changing a
source filter does not delete archived usage. See
[installation and archive behavior](https://github.com/Collaboration95/yald/blob/v0.2.0/docs/install.md).

## Coverage and limits

- Dollar amounts are **API list-price equivalents**, not subscription bills or
  proof of savings. Normal pricing needs a discoverable installed opencodex
  cost module, including for Claude rows. Usage works without it; absent prices
  remain unavailable. Loaded rates are current assumptions, not historical
  snapshots. The demo's prices are illustrative examples.
- Source is the ingestion protocol, not the provider. Claude transcripts supply
  usage and recorded working directories, including subagents; they do not
  measure failures, retries, duration, time to first token or quota. A compatibility
  HTTP 200 does not establish success. opencodex metrics also depend on what was
  actually recorded; missing input is not zero input.
- Price coverage and project attribution coverage are independent. Unpriced rows
  still count toward activity. opencodex folders require matching Codex rollout
  metadata; missing identity or metadata remains unknown. Loaded history can be
  incomplete. Quota is account-wide and can be stale while the proxy is stopped.
- Yald reads existing records; this release adds no collector or mandatory LLM
  call. No productivity, answer-quality, compaction or cache-miss-cause claim is
  made. The supported interface is desktop, in light and dark themes.
- **npm registry and Homebrew remain UNVERIFIED** distribution channels. No
  registry, `npx` or `brew install` availability is promised by this release.

The same package also includes standalone HTML/JSON reports, source/project
controls and explicit time windows. See
[the guide](https://github.com/Collaboration95/yald/blob/v0.2.0/docs/guide.md),
[metric definitions](https://github.com/Collaboration95/yald/blob/v0.2.0/docs/metrics.md)
and [changelog](https://github.com/Collaboration95/yald/blob/v0.2.0/CHANGELOG.md).
Use the prebuilt `.tgz` asset, rather than GitHub's automatic source archives.
Qualification identities, exact archive SHA256 and platform receipts accompany
the selected artifact; a local build alone is not cross-platform qualification.
