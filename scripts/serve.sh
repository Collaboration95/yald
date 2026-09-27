#!/usr/bin/env bash
# Builds the web app and serves everything from one port.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"

"${root}/scripts/bun" run --cwd web vite build
exec env PORT="${PORT:-4318}" "${root}/scripts/bun" run server/src/index.ts
