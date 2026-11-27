#!/usr/bin/env bash
# Self-test of check-no-release.sh's built-output scans (run by ppvp): a
# marker late in a big binary, and one in a built frontend, must be found; a
# clean binary and frontend must pass. Only a temporary directory is written.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$ROOT/scripts/app-tester/check-no-release.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0

# 50 MB of text-like bytes (strings would print them all), the marker last.
head -c 52428800 /dev/zero | LC_ALL=C tr '\0' 'a' >"$tmp/clean.bin"
cp "$tmp/clean.bin" "$tmp/dirty.bin"
printf '\0run\\bridge.port\0' >>"$tmp/dirty.bin"
# The marker first: a reader that stops at the first hit (grep -q) must not
# turn the find into a failure of the whole check.
{ printf 'bridge.port\0'; cat "$tmp/clean.bin"; } >"$tmp/dirty-early.bin"
# Launch A2: a binary that can skip the Plyloft sign-in.
{ cat "$tmp/clean.bin"; printf '\0PLYLOFT_DEV_SKIP_SIGNIN\0'; } >"$tmp/skip.bin"
mkdir -p "$tmp/dist-clean" "$tmp/dist-dirty"
echo 'console.log(1)' >"$tmp/dist-clean/a.js"
echo 'x("test-bridge://reply")' >"$tmp/dist-dirty/a.js"
mkdir -p "$tmp/dist-skip"
echo 'x("PLYLOFT_DEV_SKIP_SIGNIN")' >"$tmp/dist-skip/a.js"

expect() {
  local want="$1"; shift
  if "$CHECK" "$@" >/dev/null 2>&1; then got=0; else got=1; fi
  if [ "$got" != "$want" ]; then
    echo "✗ check-no-release $* → exit $got, expected $want" >&2
    fail=1
  fi
}
expect 0 --binary "$tmp/clean.bin"
expect 1 --binary "$tmp/dirty.bin"
expect 1 --binary "$tmp/dirty-early.bin"
expect 1 --binary "$tmp/skip.bin"
expect 0 --dist "$tmp/dist-clean"
expect 1 --dist "$tmp/dist-dirty"
expect 1 --dist "$tmp/dist-skip"
[ "$fail" -eq 0 ] && echo "✓ check-no-release finds a late marker and passes clean output"
exit "$fail"
