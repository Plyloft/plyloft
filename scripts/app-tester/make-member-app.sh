#!/usr/bin/env bash
# Two-member walks (docs/app-tester/DESIGN.md): copies a built "Plyloft Test.app"
# to "Plyloft Test Member.app" under com.mbadv.ply.test2, so the second person
# has its own profile and its own page storage (~/Library/WebKit/<bundle id>)
# without a second build. Started with PLY_TEST_INSTANCE=member.
#
#   scripts/app-tester/make-member-app.sh "<path>/Plyloft Test.app"
#
# Prints the copy's path last. Signed like build-app.sh when the local identity
# exists; never a release (the source bundle is a test-bridge debug build).
# Refused while either instance runs. The copy carries PLY_TEST_INSTANCE=member
# in LSEnvironment, so opening it by hand can't run on the owner's profile.
set -euo pipefail
SRC="${1:?usage: make-member-app.sh <path to Plyloft Test.app>}"
SRC="${SRC%/}"
case "$SRC" in */"Plyloft Test.app") ;; *) echo "✗ not a Plyloft Test.app: $SRC" >&2; exit 1 ;; esac
PLIST="$SRC/Contents/Info.plist"
test -f "$PLIST" || { echo "✗ no bundle at $SRC" >&2; exit 1; }
ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST")"
[ "$ID" = "com.mbadv.ply.test" ] || { echo "✗ refused: bundle id is $ID, not com.mbadv.ply.test" >&2; exit 1; }

if pgrep -f "Plyloft Test( Member)?\.app/Contents/MacOS/" >/dev/null; then
  echo "✗ Plyloft Test (or its Member copy) is running: quit it first" >&2
  exit 1
fi
DEST="$(dirname "$SRC")/Plyloft Test Member.app"
MEMBER_ID="com.mbadv.ply.test2"
STAGE="$DEST.new"
# Only this script's own two paths, whatever they hold.
remove_own() {
  case "$1" in
    */"Plyloft Test Member.app" | */"Plyloft Test Member.app.new") rm -rf -- "$1" ;;
    *) echo "✗ refusing to remove $1" >&2; exit 1 ;;
  esac
}
remove_own "$STAGE"
ditto "$SRC" "$STAGE"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $MEMBER_ID" \
  -c 'Set :CFBundleName Plyloft Test Member' "$STAGE/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Delete :LSEnvironment' "$STAGE/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :LSEnvironment dict' \
  -c 'Add :LSEnvironment:PLY_TEST_INSTANCE string member' "$STAGE/Contents/Info.plist"
# As build-app.sh: `timeout` isn't on every Mac, and a locked keychain would
# wait forever.
SIGN_TIMEOUT=60
bounded_codesign() {
  codesign "$@" &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$SIGN_TIMEOUT" ]; then
      kill "$pid" 2>/dev/null || true
      echo "✗ codesign did not finish in ${SIGN_TIMEOUT}s: the login keychain is probably locked" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}
IDENTITY="${PLY_TEST_APP_SIGN_IDENTITY:-Plyloft Test Dev}"
if security find-identity -p codesigning 2>/dev/null | grep -qF "\"$IDENTITY\""; then
  if [ -f "$STAGE/Contents/MacOS/ply-mcp" ]; then
    bounded_codesign --force --sign "$IDENTITY" --identifier "$MEMBER_ID.mcp" "$STAGE/Contents/MacOS/ply-mcp" >&2
  fi
  bounded_codesign --force --sign "$IDENTITY" --identifier "$MEMBER_ID" "$STAGE" >&2
else
  bounded_codesign --force --deep --sign - "$STAGE" >&2
fi
codesign --verify --strict "$STAGE" >&2
remove_own "$DEST"
mv "$STAGE" "$DEST"
echo "$DEST"
