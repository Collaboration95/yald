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
quick server, demo, chart and UI tests. It checks the working
tree, so unstaged code changes also affect the result. It leaves snapshot and
package qualification integration tests, typechecking, builds, and smoke checks
to local `make check` runs.

## Branch workflow

Start work from `dev`. Feature branches merge into `dev`; releases merge from
this repository's `dev` branch into `main` through a pull request. Fork branches
named `dev` do not satisfy the source policy.

`main` requires the `dev-to-main` source check, an up-to-date
branch, and resolved review conversations. Direct pushes, force pushes, and
branch deletion are blocked, including for administrators. Reviewer approval
is optional. The source check runs from the trusted `main` workflow without
checking out pull request code.

## Verification

Verification runs locally. There is no hosted Ubuntu/macOS test workflow or
required platform-test matrix.

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

`make test` and `scripts/bun run test` use the same runner. It discovers
`*.test.*`, `*.spec.*`, `*_test.*` and `*_spec.*` JavaScript/TypeScript files under
`server/`, `tests/` and `web/`, including new web tests. Dependency, generated and
Git directories (`node_modules`, `vendor`, `bower_components`, `dist`, `build`,
`generated`, `__generated__`, `coverage`, `output`, `.git`, `.cache`, `.next`,
`.turbo`, `.yald`, `__snapshots__`)
are skipped at every depth. Symlinks are not followed.

The full run assigns every discovered file exactly once to three process groups:
the cold-parser snapshot oracle, window/bucketing tests, and the remaining tests.
At most three Bun workers run at once, capped by available CPUs. Tests inside
each worker remain sequential; each worker loads `bunfig.toml` and gets its own
module cache and isolated fixture home. Whole worker logs print in group order
after execution, with file counts, timing, exit status and signal diagnostics.
A supplemental worker preload cleans descendants before Bun exits, including
an immediate failing test that launched a detached child. Inherited Node/Bun
startup preloads also register each process's PID and start identity in a private
per-worker directory, so an ordinary intermediate parent can exit without losing
ownership of a detached grandchild. Existing runtime options and preloads remain
in place; the registration hook does not install signal/exit handlers or change
`detached`. Cleanup closes registration before reading receipts, checks live
start identities before signalling, and refuses late startup before user code.
Cancellation stops owned workers and descendants, waits for exit, and returns a
failure. This runner uses POSIX process groups and `ps` on macOS/Linux, with a
private directory under `/tmp` (Bun 1.4 cannot quote whitespace in `BUN_OPTIONS`).
SIGKILL cannot run cleanup hooks. Processes that deliberately remove runtime
options, or opaque non-Node/Bun runtimes, have only process-group/observed-ancestry
coverage; arbitrary detached double-forks from those processes are not covered.

```bash
YALD_TEST_WORKERS=1 make test        # run one worker at a time, including cleanup
node scripts/test-suite.mjs --serial # equivalent serial batch override
node scripts/test-suite.mjs --list   # exact full inventory and worker capacity
node scripts/test-suite.mjs --fast --list
scripts/bun test                    # direct, single-process diagnostic run
scripts/bun test ./tests/demo.test.ts # focused diagnostic; keeps test preload
```

`YALD_TEST_WORKERS` accepts a positive integer and is capped at three and the CPU
capacity; `--serial` takes precedence. `make test-fast` / `scripts/bun run
test:fast` retain the server, demo and chart suites and include all discovered UI
and format tests, persistence, isolation and project tests. Only
`tests/store-snapshots.test.ts` (independent cold-parser integration) and
`tests/qualify-package.test.ts` (package/archive qualification) are excluded.
New tests are included by default. Each worker completes its tests and teardown;
Bun's `--bail` skips teardown and is therefore not used. Any worker failure
cancels its peers and prevents queued work from starting.
`make check-fast` adds lint to that same fast run; running both commands duplicates
the test work. Run the full `make check` before review.

Demo API and lifecycle tests copy the runtime into a private temporary package
with a minimal HTML test fixture, removed after the suite. They run without a UI
build, including with raw `bun test`, and never write to the checkout's `web/dist`.
The build and smoke checks cover the UI; `scripts/verify-demo-package.mjs` checks
a built, installed tarball with real assets and the missing-assets failure.

The smoke check exercises the pages with synthetic fixture data when no usage ledger is available. It checks for runtime errors, missing sections, invalid rendered values, and quota range-selector behavior.
