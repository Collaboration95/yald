#!/usr/bin/env bash
# Renders every page against the real ledgers and reports failures, then runs
# `yald report` end to end on a synthetic fixture home.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bun="${root}/scripts/bun"
# Extra arguments are forwarded, so `./scripts/smoke.sh --fixtures` forces the synthetic ledger.
(cd "${root}/web" && "${bun}" run scripts/smoke.tsx "$@")

# Each real-view fixture initializes its own isolated source homes and pricing.
"${bun}" run "${root}/web/scripts/project-radar-smoke.tsx"
"${bun}" run "${root}/web/scripts/cache-detective-smoke.tsx"
# Exact case evidence uses separate synthetic homes/process so server module caches cannot cross fixtures.
"${bun}" run "${root}/web/scripts/evidence-smoke.tsx"
"${bun}" run "${root}/web/scripts/overview-clock-smoke.tsx"

# `yald report --last 24h` through the npm bin, against a fixture home and the fixture
# cost engine, so it never reads real ledgers and never opens a port.
read -r fixture pricing < <(YALD_FIXTURE_MODULE="${root}/web/scripts/fixtureHome.ts" "${bun}" -e '
  const fixture = await import(process.env.YALD_FIXTURE_MODULE);
  console.log(await fixture.materializeFixtureHome({ reportDay: true }), await fixture.materializeFixturePricing());
')
tmp="${TMPDIR:-/tmp}"
out="$(mktemp -d "${tmp%/}/yald-smoke-report-XXXXXX")"
trap 'rm -rf "${fixture}" "${pricing}" "${out}"' EXIT
OCX_PACKAGE_DIR="${pricing}" node "${root}/scripts/yald.mjs" report --last 24h \
  --ocx-home "${fixture}" --claude-projects "${fixture}/claude-projects" --codex-home "${fixture}/codex" \
  --out "${out}/report.html" --json
grep -q '^<!doctype html>' "${out}/report.html"
grep -q '"schemaVersion": 1' "${out}/report.json"
echo "yald report: ok"
