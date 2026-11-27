#!/usr/bin/env bash
# PPVP step "repository pure-contract tests". Every command here fails the
# step: errexit plus an explicit guard per call. The step used to be an
# inline `bash -c` without `set -e`, so only its last command counted and a
# red test-prepare-p3-4 sat under an 8/8 for as long as nobody looked.
# The contract for this file is scripts/test-ppvp-pure-contracts.sh.
set -euo pipefail
shopt -s nullglob

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

run() {
  "$@" || { echo "FAILED: $*"; exit 1; }
}

tests=(src/lib/*.test.ts)
if (( ${#tests[@]} == 0 )); then
  echo "no src/lib/*.test.ts files found"
  exit 1
fi
for test_file in "${tests[@]}"; do
  run node --experimental-strip-types "$test_file"
done

# GH #172: the behavioural UI tests (`src/**/*.test.tsx`), rendered under jsdom
# by vitest against the stubbed Tauri layer. One command for the whole suite.
run ./scripts/test-ui.sh

# Reviewed shell fixture contracts that mutate only disposable temporary
# roots. By glob, so a new one cannot be left out (P3-2 was, for its whole life).
fixtures=(scripts/test-prepare-p3-*.sh)
if (( ${#fixtures[@]} == 0 )); then
  echo "no scripts/test-prepare-p3-*.sh fixture contracts found"
  exit 1
fi
for fixture in "${fixtures[@]}"; do
  run "./$fixture"
done

# This step's own contract: a red fixture, anywhere in the list, turns it red.
run ./scripts/test-ppvp-pure-contracts.sh
# v1.114.0 (team sharing rung 1): team-init.sh creates a real repository,
# so its contract test drives a fake `gh` over a local bare repo.
run ./scripts/test-team-init.sh
# v1.103.0: the installer harness runs entirely in a temporary root and
# never touches /Applications. It was not wired in when D9 shipped, which
# is how a cleanup failure got to fail a verified installation unnoticed.
run ./scripts/test-install-local.sh
# GH #121: release.sh --publish-only, version-pinned artifacts and the
# retried upload, driven from a fake bundle with gh/codesign/xcrun stubs.
run ./scripts/test-release.sh
run ./scripts/test-check-account-config.sh
# The release helpers: the Mac mini's site step and the MacBook's preflight, each
# driven from throwaway repositories with npm / xcrun stubs (docs/RELEASING.md).
run ./scripts/test-release-site-step.sh
run ./scripts/test-release-preflight.sh
