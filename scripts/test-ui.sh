#!/usr/bin/env bash
# GH #172: the behavioural UI tests — React components rendered under jsdom
# by vitest, against the stubbed Tauri layer (src/test/). Headless, no dev
# server, no GUI. Run by scripts/ppvp-pure-contracts.sh, and by hand as
# `npm run test:ui` (add `-- --watch` while writing one).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -x node_modules/.bin/vitest ]]; then
  echo "node_modules/.bin/vitest not found — run \`npm ci\` first" >&2
  exit 1
fi
exec node_modules/.bin/vitest run "$@"
