#!/usr/bin/env bash
# SL-0 app tester (docs/app-tester/DESIGN.md): builds "Plyloft Test.app" — a
# debug build with the dev-only test bridge, under its own identifier
# (com.mbadv.ply.test) and so its own app data, next to the installed Plyloft.
# The frontend is embedded, so the app runs without a Vite server and the
# tester can quit and relaunch it like a user.
#
# Never a release: debug profile, `test-bridge` feature (refused without
# debug_assertions), and the bridge refuses any other identifier.
#
#   CARGO_TARGET_DIR=~/ply-build/sl0 scripts/app-tester/build-app.sh
#
# Signing: if the local identity "Plyloft Test Dev" exists (one-time setup:
# scripts/app-tester/make-signing-identity.sh), the bundle is re-signed with it
# under the fixed identifier com.mbadv.ply.test, so its designated requirement
# is the same on every rebuild and keychain "Always Allow" / TCC grants stick.
# Without it the bundle keeps the linker's ad-hoc signature, as before.
#
# Prints the .app path last.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
: "${CARGO_TARGET_DIR:?set CARGO_TARGET_DIR to the target dir of this lane (e.g. ~/ply-build/sl0)}"
export CARGO_TARGET_DIR
export PLY_TEST_BRIDGE=1
# 1.176.3: the dev-only screen capture compiles only with this feature, so no
# other gate builds or tests it; every test app build runs its own tests.
(cd src-tauri && cargo test --lib --features test-bridge builder_screens_capture >&2)
npx tauri build --debug --features test-bridge \
  --config src-tauri/tauri.test.conf.json --bundles app --no-sign >&2
APP="$CARGO_TARGET_DIR/debug/bundle/macos/Plyloft Test.app"
test -d "$APP" || { echo "✗ no bundle at $APP" >&2; exit 1; }

IDENTITY="${PLY_TEST_APP_SIGN_IDENTITY:-Plyloft Test Dev}"
SIGN_TIMEOUT="${PLY_TEST_SIGN_TIMEOUT:-60}"

# codesign waits forever on a keychain prompt nobody can answer (a locked
# screen, a locked keychain): bound it and say what to do.
bounded_codesign() {
  codesign "$@" &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$SIGN_TIMEOUT" ]; then
      kill "$pid" 2>/dev/null || true
      echo "✗ codesign did not finish in ${SIGN_TIMEOUT}s: the login keychain is probably locked" >&2
      echo "  (a locked screen, or a pending 'codesign wants to access key' prompt)." >&2
      echo "  Unlock the Mac, run this again, and answer 'Always Allow'." >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}

# No -v: a self-signed identity is listed as CSSMERR_TP_NOT_TRUSTED, and
# codesign signs with it all the same.
if security find-identity -p codesigning 2>/dev/null | grep -qF "\"$IDENTITY\""; then
  # No hardened runtime (`--options runtime`): this is an unnotarized debug
  # build; without the runtime the release entitlements (JIT, unsigned
  # executable memory, library validation, DYLD env, audio input) are not
  # needed, exactly as with the ad-hoc signature. No --deep: the one nested
  # executable, the ply-mcp sidecar, is signed first under its own
  # identifier, then the bundle seals it.
  if [ -f "$APP/Contents/MacOS/ply-mcp" ]; then
    bounded_codesign --force --sign "$IDENTITY" --identifier com.mbadv.ply.test.mcp \
      "$APP/Contents/MacOS/ply-mcp" >&2
  fi
  bounded_codesign --force --sign "$IDENTITY" --identifier com.mbadv.ply.test \
    "$APP" >&2
  codesign --verify --strict "$APP" >&2
  echo "✓ signed with \"$IDENTITY\"; designated requirement (stable across rebuilds):" >&2
  codesign -d -r- "$APP" 2>&1 | grep designated >&2
else
  echo "• ad-hoc signature (keychain/TCC answers reset on every rebuild); for a stable one run scripts/app-tester/make-signing-identity.sh once" >&2
fi

echo "$APP"
