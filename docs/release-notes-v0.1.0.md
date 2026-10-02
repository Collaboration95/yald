# Yald v0.1.0 — first public preview

Yald is a read-only local dashboard for opencodex usage, estimated spend, and
quota. This first public 0.x release includes the desktop Relay interface and
all eight analytics views plus conversation detail.

- Explore token volume, cache economics, cost composition, latency, reliability,
  model comparison, quota burn, and individual conversations.
- The centered desktop layout uses a compact navigation rail, natural-height
  Overview widgets, clearer model metrics, light/dark themes, and an animated
  Yald wordmark.
- Cost estimates reuse opencodex's `ocx usage` pricing engine. Unchanged refreshes
  reuse parsed usage snapshots and retain response validators.

## Install from this GitHub release

Node.js 18+ and npm are required. The package installs its Bun runtime and already
contains the built dashboard; users do not need a source checkout or a build.

```bash
gh release download v0.1.0 --repo Collaboration95/yald --pattern 'yald-dashboard-0.1.0.tgz'
npm install -g ./yald-dashboard-0.1.0.tgz
yald --version
yald --open
```

The CLI is `yald`; the npm package is `yald-dashboard` because the unscoped npm
name `yald` belongs to another project. Registry publication and a Homebrew tap
are separate follow-up steps. See the
[distribution guide](https://github.com/Collaboration95/yald/blob/v0.1.0/docs/releasing.md).

## Included downloads

- `yald-dashboard-0.1.0.tgz`: the tested distribution package, suitable for npm
  installation or publishing without rebuilding.
- `SHA256SUMS`: SHA-256 checksum for the package.
- GitHub's automatically generated source archives contain the tagged source;
  use the `.tgz` download for the prebuilt dashboard.

## Known limits

- 0.x is an early preview while the upstream data format and metric definitions
  can still evolve.
- This interface supports desktop use; mobile and tablet layouts are outside its
  design scope.
- Unpriced or unmetered requests remain explicit coverage gaps in estimated cost.
- Quota projections need multiple samples; quota snapshots only refresh while
  the upstream proxy is running.
- Pricing availability depends on discovering the installed opencodex package.

The dashboard listens on `127.0.0.1:4318` by default and reads
`~/.opencodex`. Use `--port`, `--host`, and `--ocx-home` to change those options.
