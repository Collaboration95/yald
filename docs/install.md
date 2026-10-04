# Installation

## npm (Node.js 18+)

```bash
npx -p yald-dashboard yald --port 4318 --host 127.0.0.1 --ocx-home ~/.opencodex --open
```

The package is named `yald-dashboard` because `yald` is already claimed on npm by an unrelated package. It includes Bun and the prebuilt UI and exposes the `yald` command. `--open` opens the local dashboard in the system browser.

## Clone

Install Bun 1.1 or newer, clone the repository, then run:

```bash
bun install
./scripts/serve.sh
```

## Data location and options

The default ledger directory is `~/.opencodex`. Use `--ocx-home` or `OCX_HOME` to select another directory. `--port`/`YALD_PORT` and `--host`/`YALD_HOST` configure the listener. `YALD_TZ` sets the calendar-bucketing timezone. Claude Code usage is read from `~/.claude/projects`; set `CLAUDE_PROJECTS_DIR` to another directory, or to an empty one to leave Claude out. Legacy `OCX_OBSERVATORY_TZ` and `OCX_OBSERVATORY_PORT` remain accepted.
