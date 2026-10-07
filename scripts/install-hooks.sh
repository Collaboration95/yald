#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"
git config --local core.hooksPath .githooks
printf '%s\n' 'Installed pre-commit hook: Oxlint and quick unit/API tests.'
