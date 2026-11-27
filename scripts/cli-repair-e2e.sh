#!/bin/bash
# 1.176.0 R9: the Repair engine against the REAL official installers, in a
# throwaway home. Runs the #[ignore]d tests in src-tauri/src/cli_repair_e2e_tests.rs
# with HOME pointing at the sandbox; the tests themselves refuse to run on the
# real home. Downloads Claude Code (~360 MB, a few times) and Codex.
#
#   scripts/cli-repair-e2e.sh [test-name-filter]
#
# Never runs sudo, `claude doctor/update`, `codex doctor/update/app-server`.
set -euo pipefail

REAL_HOME="$(cd ~ && pwd)"
SANDBOX="${PLY_REPAIR_E2E_HOME:-$REAL_HOME/ply-build/cli-repair-e2e/home}"
case "$SANDBOX" in
  *cli-repair-e2e*) ;;
  *) echo "refusing: the sandbox must be under a path containing cli-repair-e2e" >&2; exit 1 ;;
esac
case "$REAL_HOME/" in
  "$SANDBOX"/*|"$SANDBOX/") echo "refusing: the sandbox is the real home or above it" >&2; exit 1 ;;
esac
mkdir -p "$SANDBOX"
LOG="${PLY_REPAIR_E2E_LOG:-$(dirname "$SANDBOX")/results.md}"
: > "$LOG"

cd "$(dirname "$0")/../src-tauri"
# Build with the real HOME first (cargo, rustup), then run with the sandbox.
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
cargo test --lib cli_repair_e2e --no-run

env -u CODEX_HOME -u CLAUDE_CONFIG_DIR -u XDG_DATA_HOME -u XDG_STATE_HOME -u XDG_CACHE_HOME -u XDG_CONFIG_HOME \
  -u NPM_CONFIG_PREFIX -u npm_config_prefix \
  HOME="$SANDBOX" \
  CARGO_HOME="${CARGO_HOME:-$REAL_HOME/.cargo}" \
  RUSTUP_HOME="${RUSTUP_HOME:-$REAL_HOME/.rustup}" \
  PLY_REPAIR_E2E_HOME="$SANDBOX" \
  PLY_REPAIR_E2E_LOG="$LOG" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin:$REAL_HOME/.cargo/bin" \
  cargo test --lib "${1:-cli_repair_e2e}" -- --ignored --test-threads=1 --nocapture "${@:2}"
echo "results: $LOG"
