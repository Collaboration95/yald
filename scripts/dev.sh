#!/usr/bin/env bash
# Runs the API and the Vite dev server together.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"

port="${YALD_PORT:-${PORT:-4318}}"
api_port="${YALD_API_PORT:-${OCX_OBSERVATORY_API_PORT:-${port}}}"

echo "API  -> http://127.0.0.1:${api_port}"
echo "Web  -> http://127.0.0.1:5317 (proxies /api to the API)"

PORT="${api_port}" "${root}/scripts/bun" run server/src/index.ts &
api_pid=$!
trap 'kill ${api_pid} 2>/dev/null || true' EXIT INT TERM

OCX_API="http://127.0.0.1:${api_port}" "${root}/scripts/bun" run --cwd web vite
