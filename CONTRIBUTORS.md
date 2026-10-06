# Contributing

## Development

```bash
bun install            # install workspace dependencies
./scripts/dev.sh       # API with reload + Vite HMR on :5317
./scripts/serve.sh     # production build served from one port
```

The API is a Hono app in `server/src/api.ts`. The smoke command exercises it without a browser and renders each page with React's server renderer.

## Verification

```bash
make test
make lint
make typecheck
make build
make smoke
make screenshots                   # requires Chrome or Chromium
make check                         # typecheck, lint, test, build, and smoke
```

The smoke check exercises the pages with synthetic fixture data when no usage ledger is available. It checks for runtime errors, missing sections, invalid rendered values, and quota range-selector behavior.
