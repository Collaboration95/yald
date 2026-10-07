# Contributing

## Development

```bash
make install           # install workspace dependencies and Git hooks
./scripts/dev.sh       # API with reload + Vite HMR on :5317
./scripts/serve.sh     # production build served from one port
```

The API is a Hono app in `server/src/api.ts`. The smoke command exercises it without a browser and renders each page with React's server renderer.

For an existing checkout with dependencies installed, run `make hooks` (or
`scripts/bun run hooks:install`). The tracked pre-commit hook runs Oxlint and the
quick unit/API and chart tests, stopping on failure. It checks the working tree,
so unstaged code changes also affect the result. It leaves snapshot integration
tests, typechecking, builds, and smoke checks to `make check` and GitHub CI.

## Branch workflow

Start work from `dev`. Feature branches merge into `dev`; releases merge from
this repository's `dev` branch into `main` through a pull request. Fork branches
named `dev` do not satisfy the source policy.

`main` requires the `dev-to-main` source check, Linux and macOS CI, an up-to-date
branch, and resolved review conversations. Direct pushes, force pushes, and
branch deletion are blocked, including for administrators. Reviewer approval
is optional. The source check runs from the trusted `main` workflow without
checking out pull request code.

## Verification

```bash
make test
make check-fast                    # the pre-commit lint and quick test checks
make lint
make typecheck
make build
make smoke
make screenshots                   # requires Chrome or Chromium
make check                         # typecheck, lint, test, build, and smoke
```

The smoke check exercises the pages with synthetic fixture data when no usage ledger is available. It checks for runtime errors, missing sections, invalid rendered values, and quota range-selector behavior.
