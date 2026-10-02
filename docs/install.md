# Installation

## GitHub preview (Node.js 18+ and npm)

Download the prebuilt package from the `v0.1.0` release:

```bash
gh release download v0.1.0 --repo Collaboration95/yald --pattern 'yald-dashboard-0.1.0.tgz'
npm install -g ./yald-dashboard-0.1.0.tgz
yald --version
yald --open
```

## npm registry (after publication)

```bash
npx -p yald-dashboard yald --port 4318 --host 127.0.0.1 --ocx-home ~/.opencodex --open
```

The package is named `yald-dashboard` because `yald` is already claimed on npm by an unrelated package. It installs Bun, includes the prebuilt UI, and exposes the `yald` command. `--open` opens the local dashboard in the system browser. npm publication and a Homebrew tap are separate steps described in [the distribution guide](releasing.md).

## Clone

Install Bun 1.1 or newer, clone the repository, then run:

```bash
bun install
./scripts/serve.sh
```

## Data location and options

The default ledger directory is `~/.opencodex`. Use `--ocx-home` or `OCX_HOME` to select another directory. `--port`/`YALD_PORT` and `--host`/`YALD_HOST` configure the listener. `YALD_TZ` sets the calendar-bucketing timezone. Legacy `OCX_OBSERVATORY_TZ` and `OCX_OBSERVATORY_PORT` remain accepted.
