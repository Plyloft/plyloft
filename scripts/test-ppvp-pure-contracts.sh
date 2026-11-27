#!/usr/bin/env bash
# Contract for scripts/ppvp-pure-contracts.sh: any failing command fails the
# step — in particular a red fixture script that is not the last command.
# Runs the real runner against throwaway roots of stub scripts; nothing here
# touches the repository or live state.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ply-ppvp-contract-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

STUBS=(
  test-prepare-p3-1-a test-prepare-p3-2-b test-prepare-p3-3-c
  test-ui test-ppvp-pure-contracts test-team-init test-install-local test-release
  test-check-account-config test-release-site-step test-release-preflight
)

# A repository root holding the real runner, one passing TS test and a
# green stub for every script the runner calls. Each stub logs that it ran.
make_root() {
  local root="$TEST_ROOT/$1" stub
  mkdir -p "$root/scripts" "$root/src/lib"
  cp "$SCRIPT_DIR/ppvp-pure-contracts.sh" "$root/scripts/"
  printf '// passes\n' >"$root/src/lib/ok.test.ts"
  for stub in "${STUBS[@]}"; do
    printf '#!/usr/bin/env bash\necho %s >>"%s/ran.log"\n' "$stub" "$root" \
      >"$root/scripts/$stub.sh"
  done
  chmod +x "$root/scripts/"*.sh
  : >"$root/ran.log"
}

make_red() {
  printf '#!/usr/bin/env bash\necho "status=FIXTURE_CONTRACT_MISMATCH" >&2\nexit 1\n' >"$1"
  chmod +x "$1"
}

# 1. All green: the step passes and every command ran.
make_root green
"$TEST_ROOT/green/scripts/ppvp-pure-contracts.sh" >"$TEST_ROOT/green.out" 2>&1 ||
  fail "all-green root failed the step: $(<"$TEST_ROOT/green.out")"
[[ "$(wc -l <"$TEST_ROOT/green/ran.log" | tr -d ' ')" == "${#STUBS[@]}" ]] ||
  fail "all-green root did not run every command"

# 2. A red fixture in the middle, with the last command green: the step fails,
#    names the fixture and stops there.
make_root middle
make_red "$TEST_ROOT/middle/scripts/test-prepare-p3-2-b.sh"
if "$TEST_ROOT/middle/scripts/ppvp-pure-contracts.sh" >"$TEST_ROOT/middle.out" 2>&1; then
  fail "a red fixture script was swallowed by the step"
fi
grep -Fq 'FAILED: ./scripts/test-prepare-p3-2-b.sh' "$TEST_ROOT/middle.out" ||
  fail "the step did not name the red fixture"
if grep -Fxq test-install-local "$TEST_ROOT/middle/ran.log"; then
  fail "the step kept going after a red fixture"
fi

# 3. A red first fixture is not rescued by the rest.
make_root first
make_red "$TEST_ROOT/first/scripts/test-prepare-p3-1-a.sh"
if "$TEST_ROOT/first/scripts/ppvp-pure-contracts.sh" >/dev/null 2>&1; then
  fail "a red first fixture was swallowed by the step"
fi

# 4. A red TS test fails the step.
make_root ts
printf 'process.exit(1);\n' >"$TEST_ROOT/ts/src/lib/red.test.ts"
if "$TEST_ROOT/ts/scripts/ppvp-pure-contracts.sh" >/dev/null 2>&1; then
  fail "a red TS test was swallowed by the step"
fi

# 5. No fixture contracts at all is a broken gate, not a pass.
make_root none
rm "$TEST_ROOT/none/scripts/"test-prepare-p3-*.sh
if "$TEST_ROOT/none/scripts/ppvp-pure-contracts.sh" >/dev/null 2>&1; then
  fail "a root with no fixture contracts passed the step"
fi

# 6. A red behavioural UI suite fails the step (GH #172).
make_root ui
make_red "$TEST_ROOT/ui/scripts/test-ui.sh"
if "$TEST_ROOT/ui/scripts/ppvp-pure-contracts.sh" >"$TEST_ROOT/ui.out" 2>&1; then
  fail "a red behavioural UI suite was swallowed by the step"
fi
grep -Fq 'FAILED: ./scripts/test-ui.sh' "$TEST_ROOT/ui.out" ||
  fail "the step did not name the red UI suite"

echo "PPVP pure-contract step contract ✓"
