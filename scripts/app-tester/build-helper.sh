#!/usr/bin/env bash
# SL-0 app tester (docs/app-tester/DESIGN.md): builds PlyTestHelper.app into
# ~/ply-build/tools and signs it with the local "Plyloft Test Helper (local)"
# identity, so the macOS permissions granted to it survive rebuilds (its
# designated requirement names the certificate, not the binary's hash).
# Dev tooling only: never part of a Plyloft bundle or release.
#
#   scripts/app-tester/build-helper.sh            build, sign, install
#   scripts/app-tester/build-helper.sh --check    compile only (no signing)
#
# The bundle is assembled beside the installed one and swapped in only once
# signed: a failed or blocked signature leaves the working helper untouched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/tools/ply-test-helper"
TOOLS="${PLY_TEST_TOOLS_DIR:-$HOME/ply-build/tools}"
OUT="$TOOLS/PlyTestHelper.app"
IDENTITY="${PLY_TEST_SIGN_IDENTITY:-Plyloft Test Helper (local)}"
SIGN_TIMEOUT="${PLY_TEST_SIGN_TIMEOUT:-60}"

if [ "${1:-}" = "--check" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  swiftc -O -o "$tmp/PlyTestHelper" "$SRC"/*.swift
  echo "✓ PlyTestHelper compiles"
  exit 0
fi

mkdir -p "$TOOLS"
STAGE="$TOOLS/.PlyTestHelper.staging.app"
rm -rf "$STAGE"
mkdir -p "$STAGE/Contents/MacOS"
cp "$SRC/Info.plist" "$STAGE/Contents/Info.plist"
swiftc -O -o "$STAGE/Contents/MacOS/PlyTestHelper" "$SRC"/*.swift

# codesign waits forever on a keychain prompt nobody can answer (a locked
# screen, a locked keychain): bound it and say what to do.
codesign --force --sign "$IDENTITY" --identifier com.mbadv.ply.testhelper "$STAGE" &
sign_pid=$!
waited=0
while kill -0 "$sign_pid" 2>/dev/null; do
  if [ "$waited" -ge "$SIGN_TIMEOUT" ]; then
    kill "$sign_pid" 2>/dev/null || true
    rm -rf "$STAGE"
    echo "✗ codesign did not finish in ${SIGN_TIMEOUT}s: the login keychain is probably locked" >&2
    echo "  (a locked screen, or a pending 'codesign wants to access key' prompt)." >&2
    echo "  Unlock the Mac, run this again, and answer 'Always Allow'." >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done
wait "$sign_pid"

rm -rf "$OUT"
mv "$STAGE" "$OUT"
codesign -dr - "$OUT" 2>&1 | grep designated
