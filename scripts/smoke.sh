#!/usr/bin/env bash
# Renders every page against the real ledgers and reports failures.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}/web"
# Extra arguments are forwarded, so `./scripts/smoke.sh --fixtures` forces the synthetic ledger.
exec "${root}/scripts/bun" run scripts/smoke.tsx "$@"
