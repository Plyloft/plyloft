#!/usr/bin/env bash
#
# v1.11.x (Phase C): build a sandboxed Plyloft-Verify.app that runs side-
# by-side with the installed /Applications/Plyloft.app. Different bundle
# identifier ⇒ macOS treats them as separate apps. Different data dir
# ⇒ they cannot clobber each other's kanban / workspaces / settings.
#
# Output:
#   src-tauri/target/release/bundle/macos/Plyloft-Verify.app
#
# This script is invoked by the verify pipeline when the configured
# verifySuite includes the `tauri-build` step (Phase D). It never touches
# /Applications/Plyloft.app.
#
# Cleanup: keeps the most recent 3 Plyloft-Verify.app builds in
# `src-tauri/target/release/bundle/macos/` (decision 19). Older sandbox
# builds are deleted before the new build kicks off.
#
# Usage: ./scripts/verify-build.sh

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# Ensure cargo is on PATH.
if ! command -v cargo >/dev/null 2>&1; then
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
fi

# Card Verify sessions build into the workspace's shared CARGO_TARGET_DIR.
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}"
if [[ "$TARGET_DIR" != /* ]]; then
  TARGET_DIR="$ROOT/$TARGET_DIR"
fi
BUNDLE_DIR="$TARGET_DIR/release/bundle/macos"
SANDBOX_NAME="Plyloft-Verify.app"
SANDBOX_BUNDLE_ID="com.mbadv.ply.verify"
SANDBOX_PRODUCT_NAME="Plyloft-Verify"

# v1.11.x (Phase C, decision 19): keep last 3 sandbox builds. We mark
# each archived build with a timestamp suffix; oldest beyond 3 are
# pruned before this build kicks off.
prune_old_sandbox_builds() {
  local pattern="$BUNDLE_DIR/Plyloft-Verify-*.app"
  shopt -s nullglob
  local builds=( $pattern )
  shopt -u nullglob
  if (( ${#builds[@]} > 2 )); then
    # Sort by mtime ascending; delete the oldest until ≤ 2 remain (the
    # current run will produce a 3rd).
    local sorted
    while IFS= read -r line; do
      sorted+=( "$line" )
    done < <(ls -1tr "$BUNDLE_DIR"/Plyloft-Verify-*.app 2>/dev/null || true)
    local to_remove=$(( ${#sorted[@]} - 2 ))
    if (( to_remove > 0 )); then
      echo "── pruning $to_remove old Plyloft-Verify build(s)"
      for ((i=0; i<to_remove; i++)); do
        rm -rf "${sorted[$i]}"
      done
    fi
  fi
}

# Archive the previous Plyloft-Verify.app under a timestamped name so it
# isn't clobbered by this build. Pruning above keeps the archive bounded.
archive_previous_sandbox() {
  if [[ -d "$BUNDLE_DIR/$SANDBOX_NAME" ]]; then
    local stamp
    stamp=$(date +%Y%m%d-%H%M%S)
    mv "$BUNDLE_DIR/$SANDBOX_NAME" "$BUNDLE_DIR/Plyloft-Verify-$stamp.app"
  fi
}

mkdir -p "$BUNDLE_DIR"
prune_old_sandbox_builds
archive_previous_sandbox

# Build with config override. Tauri 2 supports `--config '<json>'` to
# merge over tauri.conf.json. We override identifier + productName so the
# resulting .app is a distinct bundle from the installed Plyloft.
CONFIG_OVERRIDE=$(cat <<JSON
{
  "identifier": "$SANDBOX_BUNDLE_ID",
  "productName": "$SANDBOX_PRODUCT_NAME"
}
JSON
)

echo "── Building $SANDBOX_NAME (bundle id $SANDBOX_BUNDLE_ID)"
npm run tauri build -- --config "$CONFIG_OVERRIDE"

# Tauri writes the build to a path derived from `productName`. Locate
# the freshly-built .app.
PRODUCT_APP="$BUNDLE_DIR/$SANDBOX_PRODUCT_NAME.app"
if [[ ! -d "$PRODUCT_APP" ]]; then
  # Fallback: tauri sometimes outputs based on package.json name.
  if [[ -d "$BUNDLE_DIR/Plyloft.app" ]]; then
    PRODUCT_APP="$BUNDLE_DIR/Plyloft.app"
  fi
fi
if [[ ! -d "$PRODUCT_APP" ]]; then
  echo "✗ Build did not produce a recognizable .app"
  exit 1
fi

# Normalize the output to Plyloft-Verify.app for downstream consumers.
if [[ "$PRODUCT_APP" != "$BUNDLE_DIR/$SANDBOX_NAME" ]]; then
  mv "$PRODUCT_APP" "$BUNDLE_DIR/$SANDBOX_NAME"
fi

# Strip Gatekeeper attribute so the unsigned sandbox build launches without
# a "developer cannot be verified" dialog. Same trick as install-local.sh.
xattr -cr "$BUNDLE_DIR/$SANDBOX_NAME"

echo ""
echo "✓ Sandbox build done: $BUNDLE_DIR/$SANDBOX_NAME"
echo "  Bundle id: $SANDBOX_BUNDLE_ID"
echo "  Will use data dir: ~/Library/Application Support/$SANDBOX_BUNDLE_ID/"
echo "  Launch: open '$BUNDLE_DIR/$SANDBOX_NAME'"
