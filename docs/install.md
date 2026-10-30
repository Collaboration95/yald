# Installation and local data

## Meet Yaldi 0.2.0 GitHub package

The baseline channel for **0.2.0 — Meet Yaldi** is the GitHub tarball,
`yald-dashboard-0.2.0.tgz`, with `SHA256SUMS`. Confirm both assets are present on
the [v0.2.0 release page](https://github.com/Collaboration95/yald/releases/tag/v0.2.0)
before downloading; preparing these instructions does not publish the candidate.
npm registry and Homebrew distribution remain **UNVERIFIED**. The executable is
`yald`; the package name is `yald-dashboard`.

Prerequisites: macOS or Linux, Node.js 18+, npm, an authenticated GitHub CLI
(`gh`) and `shasum`. The tarball contains the built UI and server. npm installs
the Bun runtime dependency; its installation scripts must be allowed. A source
checkout, Make and a separate global Bun installation are unnecessary.

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

Continue only if checksum verification says `OK`; the installed version should
be exactly `0.2.0`. The installed demo opens **http://127.0.0.1:4318** with
synthetic data, illustrative prices and Labs enabled. Stop with Ctrl+C to remove
its generated data. Run `yald --open` to read your normal sources instead; that
mode writes Yald's own Claude usage archive as documented below. Add the chosen
prefix's `bin` directory to your shell's `PATH` for later sessions. If the runtime is missing,
check npm's install-script policy and reinstall the same verified tarball.

The earlier [v0.1.0 prerelease](https://github.com/Collaboration95/yald/releases/tag/v0.1.0)
is the opencodex-only preview; it has no Claude ingestion, source/project controls,
reports, Yaldi, Labs or demo. The sections below describe 0.2.0. See the
[demo guide](demo.md), [release notes](release-notes-v0.2.0.md) and
[candidate process](release-candidate-v0.2.0.md) for feature and qualification details.

## Data locations and local archive

Yald reads existing files; it makes no model calls and does not modify source
ledgers, transcripts or Codex rollouts. It can read recorded usage with the
proxy stopped. Pricing is an **API list-price equivalent**, not a subscription
bill or proof of savings.

| Path | Purpose |
| --- | --- |
| `$OCX_HOME/usage.jsonl` | Logical opencodex requests and recorded usage, attempts, outcomes and timing |
| `$OCX_HOME/spend-ledger.jsonl` | Account-wide physical sends: reserve, dispatch, settle and lost records |
| `$OCX_HOME/codex-quota-cache.json` | Latest recorded account quota windows and captured sample history |
| `$OCX_HOME/routing-history.sqlite` | Upstream indexed mirror; Yald does not read it by default |
| `$CLAUDE_PROJECTS_DIR/**/*.jsonl` | Claude Code transcripts, including nested subagent files |
| `$CODEX_HOME/sessions/**/rollout-*.jsonl[.zst]` and `$CODEX_HOME/archived_sessions/rollout-*.jsonl[.zst]` | First-line Codex session metadata for opencodex project attribution, and `rate_limits` from `token_count` records as quota history. Message content in these files is parsed in memory and not kept |
| `$OCX_HOME/yald-claude-usage.jsonl` | **Yald-owned archive, written locally** from Claude usage metadata |
| Browser IndexedDB, database `yald` | **Written by the dashboard page**: the last successful API response per view and selection, so a reload shows it at once |

Defaults are `OCX_HOME=~/.opencodex`,
`CLAUDE_PROJECTS_DIR=~/.claude/projects` and `CODEX_HOME=~/.codex`.
Claude transcripts do not supply measured failures, retries, timing or quota.
See [source coverage](metrics.md#source-capabilities-and-measurement-coverage).

The Claude archive is append-only, deduplicated on read and has **no automatic
retention expiry**. It retains normalized usage metadata (including IDs, cwd, git
branch, agent markers and tool names and counts), not prompt/response bodies or
tool inputs and outputs. Records that are not requests (compactions, API errors,
prompt times, PR links, agent types) go in `yald-claude-events.jsonl` beside it,
under the same rules. More complete live records can fill gaps in older
entries. Usage remains after transcripts are deleted or `CLAUDE_PROJECTS_DIR`
is changed to an empty directory. Source filtering changes the displayed
population; it neither deletes this archive nor stops ingestion from the
configured transcript directory.

The dashboard keeps the last successful response for each view and selection in
this browser profile's IndexedDB (database `yald`, at most 40 responses, none
older than 7 days or from another Yald build). The responses are the same JSON the
local API returns, so they include project folder names, model names and
conversation ids, but no prompt or response text. They never leave the browser
profile; clearing the site's data for the Yald address removes them. Error
responses and the demo's synthetic data are never stored.

To run without previously archived Claude usage, choose a **new, separate
`OCX_HOME`** as well as an empty transcript directory. This also selects a
separate opencodex ledger location; it is not a filter for an existing home.
There is no archive-retention or deletion command. The published v0.1.0 package
does not ingest or archive Claude transcripts.

## Pricing discovery

Yald reuses the installed `@bitkyc08/opencodex` cost module, including its loaded
user overlays (`ocx models set-price`), long-context rates and tier rules. It
does not bundle a second
price table. This engine is needed for prices even when only Claude is selected.
Usage views still work without it; prices remain unavailable.

Discovery checks `OCX_PACKAGE_DIR` first, then `ocx` symlinks in common system
locations, `npm root -g`, common global npm directories and Bun's global package
directory. A candidate needs `src/usage/cost.ts` or `dist/usage/cost.js`; Yald
loads the first usable cost module in the selected package. Set an explicit
absolute `OCX_PACKAGE_DIR` if automatic discovery misses an installation. The
dashboard pricing status and `/api/meta` expose the loaded path/status.

The engine can depend on an existing `CODEX_HOME`; create that directory before
using a custom one. Package/catalog changes need a process restart. Rates are
the currently loaded assumptions, not historical snapshots. Missing prices
are unavailable, never evidence of a free route. Price coverage and project
attribution coverage remain independent. See [cost](metrics.md#metering-and-cost),
[cache comparisons](metrics.md#net-cache-economics) and
[project limits](metrics.md#project-attribution).

## Listener defaults and options

| Entry point | Default address | Configuration |
| --- | --- | --- |
| Installed `yald` or `node scripts/yald.mjs` | `127.0.0.1:4318` | `--port` / `YALD_PORT`, `--host` / `YALD_HOST` |
| `make run` / `scripts/serve.sh` | `127.0.0.1:4318` | Builds UI; sets `PORT=4318` when `PORT` is absent; server env precedence still applies |
| `make dev` / `scripts/dev.sh` | API `127.0.0.1:4318`, Vite `localhost:5317` | See the HMR override below; use Vite's printed URL if it selects another free port |
| Direct `scripts/bun run server/src/index.ts` or `npm start` | `127.0.0.1:4317` | No launcher port override |
| Report CLI | No listener | Writes local output files |

The direct server resolves port as `YALD_PORT`, then `OCX_OBSERVATORY_PORT`, then
`PORT`, then `4317`. The packaged launcher explicitly supplies `YALD_PORT=4318`
when it is unset, so `PORT` and the legacy port variable do not override its
default. The launcher accepts `--port`; `YALD_PORT` controls its port and the
direct server's port. HMR also needs the alignment described below.
For the host, the direct server uses `YALD_HOST`, then `HOST`, then `127.0.0.1`;
the launcher's `--open` URL uses `YALD_HOST` or loopback, so use `--host` /
`YALD_HOST` for that entry point.

For HMR, the script chooses its proxy port from `YALD_API_PORT`, then
`OCX_OBSERVATORY_API_PORT`, `YALD_PORT`, `PORT`, or `4318`. It passes that port
to the server as `PORT`. The server still gives `YALD_PORT` and
`OCX_OBSERVATORY_PORT` higher precedence. Unset those higher-precedence values
in the server environment or align them with `YALD_API_PORT`; otherwise Vite
can target a different port from the actual listener. This example aligns the
ports and binds the API to loopback:

```bash
YALD_HOST=127.0.0.1 YALD_API_PORT=4319 YALD_PORT=4319 \
  OCX_OBSERVATORY_PORT=4319 make dev
```

| Variable | Default / use |
| --- | --- |
| `OCX_HOME` | `~/.opencodex`; launcher/report `--ocx-home` overrides it |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects`; report also accepts `--claude-projects` |
| `CODEX_HOME` | `~/.codex`; current launcher/report also accept `--codex-home` |
| `OCX_PACKAGE_DIR` | Auto-discovered pricing package; use an absolute path |
| `YALD_TZ` | System timezone; legacy `OCX_OBSERVATORY_TZ` is the fallback; report `--tz` overrides both |
| `YALD_PORT`, `YALD_HOST` | Listener settings above |
| `YALD_API_PORT` | HMR proxy port and server `PORT` fallback; legacy `OCX_OBSERVATORY_API_PORT` is its fallback. Higher-precedence server port variables must be unset or aligned as above |
| `BUN_BIN` | Checkout runtime override after a package-local Bun runtime |

## Development checkout

Use this path to develop Yald from source, separate from installing the GitHub
package above. Install Bun compatible with the declared `^1.4.0` dependency
(or supply a compatible runtime through `BUN_BIN`), Git, Node.js and npm; then:

```bash
gh repo clone Collaboration95/yald yald -- --branch dev
cd yald
scripts/bun install --frozen-lockfile
./scripts/serve.sh
```

Open **http://127.0.0.1:4318**. After dependencies are installed, the checkout
launcher also works: `node scripts/yald.mjs`. For HMR use `make dev` and the
Vite URL above. To build without starting a listener use `make build`.

The checkout runtime helper tries package-local Bun, `BUN_BIN`, Bun on `PATH`,
a cached runtime path, then installed opencodex Bun locations. `make install`
also installs Git hooks; [Contributing](../CONTRIBUTORS.md) lists all checks.
For reports, replace installed `yald report` with
`node scripts/yald.mjs report`; see [views and reports](guide.md).

An isolated empty-data run, from a checkout with dependencies installed:

```bash
scratch="$(mktemp -d)"
mkdir -p "$scratch/ocx" "$scratch/claude" "$scratch/codex"
OCX_HOME="$scratch/ocx" CLAUDE_PROJECTS_DIR="$scratch/claude" \
  CODEX_HOME="$scratch/codex" YALD_PORT=4318 ./scripts/serve.sh
```

This selects a fresh archive as well as empty sources. Add an explicit
`OCX_PACKAGE_DIR` to control pricing. Stop the process before removing your
scratch directory. [Architecture](architecture.md) explains the data flow;
[release procedure](releasing.md) covers distribution qualification.
