#!/usr/bin/env bash
#
# External-Terminal bootstrap installer for a local unsigned Plyloft build.
#
# Ordinary releases use release.sh and the signed updater. This recovery tool
# is intentionally visible and synchronous: build, graceful quit, verified
# staged replacement, rollback on failure, and one observed relaunch.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck source=scripts/install-local-lib.sh
source "$SCRIPT_DIR/install-local-lib.sh"

# Review gate: this literal was enabled only after Claude accepted the complete
# fixture-tested recovery path. It is deliberately not an environment
# variable, so external callers cannot bypass a future quarantine.
INSTALLER_RECOVERY_ACCEPTED=1
if [[ "$INSTALLER_RECOVERY_ACCEPTED" -ne 1 ]]; then
  echo "✗ install-local.sh remains quarantined pending installer-recovery review." >&2
  echo "  Build-only remains safe: npm run tauri build" >&2
  echo "  See docs/ux-revamp/P3_0_INSTALLER_RECOVERY.md." >&2
  exit 1
fi

usage() {
  echo "Usage: ./scripts/install-local.sh [--recover-stale-lock|--recover-residue]" >&2
}

RECOVERY_MODE=""
case "${1:-}" in
  "") ;;
  --recover-stale-lock) RECOVERY_MODE="stale-lock" ;;
  --recover-residue) RECOVERY_MODE="residue" ;;
  *)
    usage
    exit 2
    ;;
esac
[[ "$#" -le 1 ]] || {
  usage
  exit 2
}

# Binding first gate: no build, quit, copy, or dispatch can occur before an
# interactive terminal outside Plyloft is proved from the live process ancestry.
install_require_external_terminal "$REPO_ROOT" || exit 1

APP_SUPPORT_ROOT="${HOME:?}/Library/Application Support/com.mbadv.ply"
LOG_ROOT="${HOME:?}/Library/Logs/com.mbadv.ply"
mkdir -p "$APP_SUPPORT_ROOT" "$LOG_ROOT"

STAMP="$(date '+%Y%m%d-%H%M%S')"
ATTEMPT_ID="$STAMP-$$"
install_log_init "$LOG_ROOT" "$STAMP"
install_paths_new "/Applications" "$ATTEMPT_ID"

if [[ "$RECOVERY_MODE" == "stale-lock" ]]; then
  install_lock_recover_stale "$APP_SUPPORT_ROOT"
  echo "✓ Removed the dead-owner installer lock."
  echo "  Rerun ./scripts/install-local.sh to install."
  exit 0
fi

install_lock_acquire "$APP_SUPPORT_ROOT" "$REPO_ROOT"

release_lock_on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$INSTALL_LOCK_HELD" -eq 1 ]]; then
    install_lock_release || status=1
  fi
  exit "$status"
}
trap release_lock_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$RECOVERY_MODE" == "residue" ]]; then
  install_recover_residue "/Applications" "$LOG_ROOT"
  exit 0
fi

install_assert_no_residue "/Applications" "$LOG_ROOT"

# Fail fast, before the long build below: `install_replace_bundle` needs an
# existing $INSTALL_DESTINATION (/Applications/Plyloft.app) to replace, and
# would only discover a missing one after the build finishes. If the old
# /Applications/Ply.app is still there, this is almost certainly the
# one-time Plyloft bundle-rename migration not having been done yet, not a
# genuine first install — point at that procedure instead of guessing.
if [[ ! -d "$INSTALL_DESTINATION" || -L "$INSTALL_DESTINATION" ]]; then
  if [[ -d "/Applications/Ply.app" && ! -L "/Applications/Ply.app" ]]; then
    install_error "preflight" "missing_destination" \
      "installed Plyloft is missing, but /Applications/Ply.app exists — do the one-time Plyloft migration first (docs/RELEASING.md, \"Bundle rename: Ply.app -> Plyloft.app\"), then rerun this script"
  else
    install_error "preflight" "missing_destination" \
      "installed Plyloft is missing; use the signed DMG for first installation"
  fi
  exit 1
fi

# Both bundles present means the migration is half done. They share
# com.mbadv.ply, so a still-running Ply.app would absorb the relaunch of the
# new Plyloft.app and this run would roll back with a misleading "failed to
# launch". Finish the migration first, as docs/RELEASING.md says.
if [[ -d "/Applications/Ply.app" && ! -L "/Applications/Ply.app" ]]; then
  install_error "preflight" "old_bundle_present" \
    "/Applications/Ply.app is still installed next to Plyloft.app — quit it and delete it (docs/RELEASING.md, \"Bundle rename: Ply.app -> Plyloft.app\"), then rerun this script"
  exit 1
fi

install_log "build" "started" "repository=$REPO_ROOT"
echo "── Building Plyloft from $REPO_ROOT"
if ! (
  cd "$REPO_ROOT"
  npm run tauri build
); then
  install_error "build" "failed" "npm run tauri build failed"
  exit 1
fi
install_log "build" "complete" "repository=$REPO_ROOT"

SOURCE_BUNDLE="$REPO_ROOT/src-tauri/target/release/bundle/macos/Plyloft.app"
[[ -d "$SOURCE_BUNDLE" ]] || {
  install_error "build" "missing_bundle" "build did not produce $SOURCE_BUNDLE"
  exit 1
}

echo "── Comparing and installing the verified local bundle"
install_replace_bundle "$SOURCE_BUNDLE" production
install_log "attempt" "complete" "destination=$INSTALL_DESTINATION"
