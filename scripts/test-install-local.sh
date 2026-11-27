#!/usr/bin/env bash
#
# Dedicated temporary-root verification for install-local.sh.
# This script never targets /Applications and never launches or quits Plyloft.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck source=scripts/install-local-lib.sh
source "$SCRIPT_DIR/install-local-lib.sh"

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ply-installer-fixture.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

PASS_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  ✓ %s\n' "$1"
}

fail() {
  printf '  ✗ %s\n' "$1" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  [[ "$actual" == "$expected" ]] || {
    printf 'expected: %s\nactual:   %s\n' "$expected" "$actual" >&2
    fail "$label"
  }
}

assert_absent() {
  [[ ! -e "$1" && ! -L "$1" ]] || fail "expected absent: $1"
}

make_bundle() {
  local bundle="$1"
  local marker="$2"
  mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources/Space Dir"
  printf '#!/usr/bin/env bash\necho %s\n' "$marker" > "$bundle/Contents/MacOS/atelier"
  chmod 755 "$bundle/Contents/MacOS/atelier"
  cat > "$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>$marker</string>
</dict>
</plist>
PLIST
  printf '%s\n' "$marker" > "$bundle/Contents/Resources/payload.txt"
  printf '%s\n' "space" > "$bundle/Contents/Resources/Space Dir/file name.txt"
  ln -s "payload.txt" "$bundle/Contents/Resources/payload-link"
}

fixture_case_dirs() {
  local name="$1"
  CASE_ROOT="$TEST_ROOT/$name"
  mkdir -p "$CASE_ROOT"
  CASE_ROOT="$(cd "$CASE_ROOT" && pwd -P)"
  CASE_APPS="$CASE_ROOT/Applications"
  CASE_SUPPORT="$CASE_ROOT/Application Support"
  CASE_LOGS="$CASE_ROOT/Logs"
  CASE_SOURCE="$CASE_ROOT/source/Plyloft.app"
  mkdir -p "$CASE_APPS" "$CASE_SUPPORT" "$CASE_LOGS" "$(dirname "$CASE_SOURCE")"
}

fixture_begin() {
  local name="$1"
  local attempt="$2"
  fixture_case_dirs "$name"
  export PLY_INSTALL_FIXTURE_MODE=1
  unset PLY_INSTALL_FIXTURE_FAULT || true
  install_paths_new "$CASE_APPS" "$attempt"
  export PLY_INSTALL_FIXTURE_ROOT="$INSTALL_ROOT"
  install_log_init "$CASE_LOGS" "$name"
  install_lock_acquire "$CASE_SUPPORT" "$REPO_ROOT"
}

fixture_end() {
  install_lock_release
  unset PLY_INSTALL_FIXTURE_FAULT || true
  unset PLY_INSTALL_FIXTURE_ROOT || true
  unset PLY_INSTALL_FIXTURE_MODE || true
}

echo "── InstallPaths and destructive-path validation"
fixture_case_dirs "paths"
install_paths_new "$CASE_APPS" "attempt-1"
assert_eq "$CASE_APPS/Plyloft.app" "$INSTALL_DESTINATION" "destination path"
assert_eq "$CASE_APPS/.Plyloft.app.install-attempt-1" "$INSTALL_STAGING" "staging path"
assert_eq "$CASE_APPS/.Plyloft.app.previous-attempt-1" "$INSTALL_BACKUP" "backup path"
assert_eq "$CASE_APPS/.Plyloft.app.failed-attempt-1" "$INSTALL_FAILED" "failed path"
if install_paths_new "$CASE_APPS" "../escape" >/dev/null 2>&1; then
  fail "unsafe attempt id was accepted"
fi
INSTALL_STAGING="$CASE_ROOT/not-a-sibling"
if install_validate_path_kind staging "$INSTALL_STAGING" >/dev/null 2>&1; then
  fail "mutated constructor path was accepted"
fi
make_bundle "$CASE_SOURCE" "link-source"
ln -s "$CASE_SOURCE" "$CASE_ROOT/source-link.app"
if bundle_fingerprint "$CASE_ROOT/source-link.app" >/dev/null 2>&1; then
  fail "symlinked bundle root was accepted"
fi
if install_paths_new "/" "broad-root" >/dev/null 2>&1; then
  fail "filesystem root was accepted as an install root"
fi
pass "one constructor validates every exact sibling"

echo "── Bundle fingerprint"
fixture_case_dirs "fingerprint"
make_bundle "$CASE_SOURCE" "source"
ditto --noqtn "$CASE_SOURCE" "$CASE_APPS/Plyloft.app"
SOURCE_FP="$(bundle_fingerprint "$CASE_SOURCE")"
COPY_FP="$(bundle_fingerprint "$CASE_APPS/Plyloft.app")"
assert_eq "$SOURCE_FP" "$COPY_FP" "copy-preserved fingerprint"

printf 'changed\n' >> "$CASE_APPS/Plyloft.app/Contents/Resources/payload.txt"
[[ "$(bundle_fingerprint "$CASE_APPS/Plyloft.app")" != "$SOURCE_FP" ]] ||
  fail "changed byte did not change fingerprint"
ditto --noqtn "$CASE_SOURCE" "$CASE_APPS/Plyloft-byte-reset.app"
chmod 600 "$CASE_APPS/Plyloft-byte-reset.app/Contents/Resources/payload.txt"
[[ "$(bundle_fingerprint "$CASE_APPS/Plyloft-byte-reset.app")" != "$SOURCE_FP" ]] ||
  fail "mode change did not change fingerprint"
ditto --noqtn "$CASE_SOURCE" "$CASE_APPS/Plyloft-link-reset.app"
rm "$CASE_APPS/Plyloft-link-reset.app/Contents/Resources/payload-link"
ln -s "Space Dir/file name.txt" "$CASE_APPS/Plyloft-link-reset.app/Contents/Resources/payload-link"
[[ "$(bundle_fingerprint "$CASE_APPS/Plyloft-link-reset.app")" != "$SOURCE_FP" ]] ||
  fail "symlink change did not change fingerprint"
ditto --noqtn "$CASE_SOURCE" "$CASE_APPS/Plyloft-newline.app"
printf 'bad\n' > "$CASE_APPS/Plyloft-newline.app/Contents/Resources/"$'bad\nname'
if bundle_fingerprint "$CASE_APPS/Plyloft-newline.app" >/dev/null 2>&1; then
  fail "newline path did not fail closed"
fi
pass "bytes, modes, links, spaces, and newline rejection are authoritative"

echo "── Idempotent transaction"
fixture_case_dirs "idempotent"
make_bundle "$CASE_SOURCE" "same"
ditto --noqtn "$CASE_SOURCE" "$CASE_APPS/Plyloft.app"
fixture_begin "idempotent" "same-1"
install_replace_bundle "$CASE_SOURCE" fixture
assert_absent "$INSTALL_STAGING"
assert_absent "$INSTALL_BACKUP"
assert_absent "$INSTALL_FAILED"
grep -Eq 'outcome=already_installed' "$INSTALL_LOG" ||
  fail "idempotent outcome missing from append log"
fixture_end
pass "same fingerprint exits without staging or replacement"

echo "── Single-installer directory lock"
fixture_case_dirs "lock"
make_bundle "$CASE_SOURCE" "lock"
ditto --noqtn "$CASE_SOURCE" "$CASE_APPS/Plyloft.app"
fixture_begin "lock" "lock-1"
if (
  source "$SCRIPT_DIR/install-local-lib.sh"
  install_log_init "$CASE_LOGS" "lock-contender"
  install_lock_acquire "$CASE_SUPPORT" "$REPO_ROOT"
) >/dev/null 2>&1; then
  fail "second installer acquired the live lock"
fi
[[ -d "$INSTALL_LOCK_DIR" ]] || fail "lock is not a directory"
fixture_end
pass "live owner wins and the lock is structurally a directory"

echo "── Explicit stale-lock recovery"
fixture_case_dirs "stale-lock"
install_log_init "$CASE_LOGS" "stale-lock"
STALE_LOCK="$CASE_SUPPORT/install-local.lock"
mkdir "$STALE_LOCK"
printf '%s\n' "99999999" > "$STALE_LOCK/owner.pid"
printf '%s\n' "old" > "$STALE_LOCK/started-at"
printf '%s\n' "$REPO_ROOT" > "$STALE_LOCK/repository"
printf '%s\n' "$INSTALL_LOG" > "$STALE_LOCK/attempt-log"
install_lock_recover_stale "$CASE_SUPPORT"
assert_absent "$STALE_LOCK"
grep -Eq 'phase=lock_recovery outcome=removed' "$INSTALL_LOG" ||
  fail "stale-lock recovery was not logged"
pass "dead-owner recovery is explicit, exact, and separately logged"

echo "── Explicit installer-residue recovery"
fixture_case_dirs "residue"
make_bundle "$CASE_APPS/Plyloft.app" "installed"
RESIDUE_STAGE="$CASE_APPS/.Plyloft.app.install-old-1"
RESIDUE_BACKUP="$CASE_APPS/.Plyloft.app.previous-old-2"
RESIDUE_FAILED="$CASE_APPS/.Plyloft.app.failed-old-3"
make_bundle "$RESIDUE_STAGE" "staged"
make_bundle "$RESIDUE_BACKUP" "backup"
make_bundle "$RESIDUE_FAILED" "failed"
touch "$CASE_LOGS/install-local-old-1.log"
fixture_begin "residue" "current-1"
if install_assert_no_residue "$CASE_APPS" "$CASE_LOGS" \
  >"$CASE_ROOT/residue-report.out" 2>&1; then
  fail "previous installer residue did not block a new attempt"
fi
grep -Fq "$RESIDUE_STAGE" "$CASE_ROOT/residue-report.out" ||
  fail "residue report omitted the staging path"
grep -Fq "$CASE_LOGS/install-local-old-1.log" "$CASE_ROOT/residue-report.out" ||
  fail "residue report omitted the associated attempt log"
install_recover_residue "$CASE_APPS" "$CASE_LOGS" \
  >"$CASE_ROOT/residue-recovery.out" 2>&1
assert_absent "$RESIDUE_STAGE"
assert_absent "$RESIDUE_BACKUP"
assert_absent "$RESIDUE_FAILED"
[[ -f "$CASE_LOGS/install-local-old-1.log" ]] ||
  fail "residue recovery removed historical attempt logs"
INVALID_RESIDUE="$CASE_APPS/.Plyloft.app.failed-bad!"
mkdir "$INVALID_RESIDUE"
if install_recover_residue "$CASE_APPS" "$CASE_LOGS" >/dev/null 2>&1; then
  fail "invalid residue name was removed"
fi
[[ -d "$INVALID_RESIDUE" ]] || fail "invalid residue was mutated"
fixture_end
pass "old siblings are reported, logs stay discoverable, and cleanup is explicit"

echo "── Injected copy failure"
fixture_case_dirs "copy-failure"
make_bundle "$CASE_SOURCE" "new"
make_bundle "$CASE_APPS/Plyloft.app" "old"
OLD_FP="$(bundle_fingerprint "$CASE_APPS/Plyloft.app")"
fixture_begin "copy-failure" "copy-1"
export PLY_INSTALL_FIXTURE_FAULT=copy
if install_replace_bundle "$CASE_SOURCE" fixture >/dev/null 2>&1; then
  fail "injected copy failure succeeded"
fi
assert_eq "$OLD_FP" "$(bundle_fingerprint "$CASE_APPS/Plyloft.app")" "copy failure destination"
assert_absent "$INSTALL_BACKUP"
assert_absent "$INSTALL_FAILED"
fixture_end
pass "copy failure occurs before quit or destination mutation"

echo "── Quit timeout"
fixture_case_dirs "quit-timeout"
make_bundle "$CASE_SOURCE" "new"
make_bundle "$CASE_APPS/Plyloft.app" "old"
OLD_FP="$(bundle_fingerprint "$CASE_APPS/Plyloft.app")"
fixture_begin "quit-timeout" "quit-1"
export PLY_INSTALL_FIXTURE_FAULT=quit_timeout
if install_replace_bundle "$CASE_SOURCE" fixture >/dev/null 2>&1; then
  fail "quit timeout succeeded"
fi
assert_eq "$OLD_FP" "$(bundle_fingerprint "$CASE_APPS/Plyloft.app")" "quit timeout destination"
assert_absent "$INSTALL_STAGING"
assert_absent "$INSTALL_BACKUP"
assert_absent "$INSTALL_FAILED"
fixture_end
pass "quit timeout aborts before the first rename"

echo "── Post-backup rollback"
fixture_case_dirs "post-backup"
make_bundle "$CASE_SOURCE" "new"
make_bundle "$CASE_APPS/Plyloft.app" "old"
OLD_FP="$(bundle_fingerprint "$CASE_APPS/Plyloft.app")"
fixture_begin "post-backup" "rollback-1"
export PLY_INSTALL_FIXTURE_FAULT=post_backup
if install_replace_bundle "$CASE_SOURCE" fixture >/dev/null 2>&1; then
  fail "post-backup fault succeeded"
fi
assert_eq "$OLD_FP" "$(bundle_fingerprint "$CASE_APPS/Plyloft.app")" "rollback destination"
assert_absent "$INSTALL_BACKUP"
[[ -d "$INSTALL_STAGING" ]] || fail "verified staging evidence was not retained"
fixture_end
pass "post-backup failure restores the exact old fingerprint"

echo "── Post-install rollback"
fixture_case_dirs "post-install"
make_bundle "$CASE_SOURCE" "new"
make_bundle "$CASE_APPS/Plyloft.app" "old"
OLD_FP="$(bundle_fingerprint "$CASE_APPS/Plyloft.app")"
fixture_begin "post-install" "rollback-2"
export PLY_INSTALL_FIXTURE_FAULT=post_install
if install_replace_bundle "$CASE_SOURCE" fixture \
  >"$CASE_ROOT/post-install.out" 2>&1; then
  fail "post-install fault succeeded"
fi
assert_eq "$OLD_FP" "$(bundle_fingerprint "$CASE_APPS/Plyloft.app")" "post-install rollback"
assert_absent "$INSTALL_BACKUP"
[[ -d "$INSTALL_FAILED" ]] || fail "failed candidate was not retained"
grep -Eq 'previous Plyloft bundle was restored' "$CASE_ROOT/post-install.out" ||
  fail "successful rollback was not visible to the operator"
grep -Fq "Failed candidate: $INSTALL_FAILED (retained)" \
  "$CASE_ROOT/post-install.out" ||
  fail "rollback output omitted the retained failed candidate"
grep -Fq "Attempt log:      $INSTALL_LOG" "$CASE_ROOT/post-install.out" ||
  fail "rollback output omitted the exact attempt log"
fixture_end
pass "failed installed candidate moves aside and old bundle returns"

echo "── Successful replacement"
fixture_case_dirs "success"
make_bundle "$CASE_SOURCE" "new"
make_bundle "$CASE_APPS/Plyloft.app" "old"
NEW_FP="$(bundle_fingerprint "$CASE_SOURCE")"
fixture_begin "success" "success-1"
install_replace_bundle "$CASE_SOURCE" fixture
assert_eq "$NEW_FP" "$(bundle_fingerprint "$CASE_APPS/Plyloft.app")" "successful destination"
assert_absent "$INSTALL_STAGING"
assert_absent "$INSTALL_BACKUP"
assert_absent "$INSTALL_FAILED"
grep -Eq 'outcome=installed' "$INSTALL_LOG" || fail "installed outcome missing"
fixture_end
pass "verified staging swaps atomically and removes backup after success"

echo "── Undeletable backup after a verified installation"
fixture_case_dirs "stuck-backup"
make_bundle "$CASE_SOURCE" "new"
make_bundle "$CASE_APPS/Plyloft.app" "old"
NEW_FP="$(bundle_fingerprint "$CASE_SOURCE")"
# The real case (2026-09-04): the installed bundle had been put in place by a
# different macOS account, so this user could not unlink its files. An
# unwritable directory inside the bundle reproduces that failure exactly,
# without needing a second account.
chmod 500 "$CASE_APPS/Plyloft.app/Contents/Resources"
fixture_begin "stuck-backup" "stuck-1"
install_replace_bundle "$CASE_SOURCE" fixture >"$CASE_ROOT/stuck.out" 2>&1
assert_eq "$NEW_FP" "$(bundle_fingerprint "$CASE_APPS/Plyloft.app")" \
  "installed despite an undeletable backup"
[[ -d "$INSTALL_BACKUP" ]] || fail "the retained backup vanished"
grep -Eq 'Installed Plyloft and verified bundle fingerprint' "$CASE_ROOT/stuck.out" ||
  fail "a verified installation did not report its own success"
grep -Fq "sudo rm -rf '$INSTALL_BACKUP'" "$CASE_ROOT/stuck.out" ||
  fail "the operator was not told how to remove the retained backup"
grep -Eq 'outcome=remove_failed' "$INSTALL_LOG" ||
  fail "the retained backup was not logged"
# ...and recovery explains the same thing instead of raw `rm` noise.
if install_recover_residue "$CASE_APPS" "$CASE_LOGS" \
  >"$CASE_ROOT/stuck-recovery.out" 2>&1; then
  fail "residue recovery claimed to remove an undeletable backup"
fi
grep -Fq "sudo rm -rf '$INSTALL_BACKUP'" "$CASE_ROOT/stuck-recovery.out" ||
  fail "residue recovery did not name the escape hatch"
chmod 700 "$INSTALL_BACKUP/Contents/Resources"
fixture_end
pass "a cleanup that cannot run does not fail an installation that did"

echo "── Append-only logs and retention immunity source guards"
fixture_case_dirs "logs"
install_log_init "$CASE_LOGS" "append"
install_log "probe" "one" "first"
install_log "probe" "two" "second"
[[ "$(wc -l < "$INSTALL_LOG" | tr -d ' ')" -eq 3 ]] ||
  fail "attempt log was truncated"
for source_file in cache_retention.rs log_retention.rs; do
  grep -F 'if !metadata.is_file() {' \
    "$REPO_ROOT/src-tauri/src/$source_file" >/dev/null ||
    fail "$source_file no longer skips non-files"
done
pass "logs append and both pruners positively skip lock directories"

echo "── Retired supervisor and external-Terminal containment"
install_command_is_ply_host \
  "/Applications/Plyloft.app/Contents/MacOS/atelier" ||
  fail "installed Plyloft host ancestry was not recognized"
install_command_is_ply_host \
  "/Applications/Ply.app/Contents/MacOS/atelier" ||
  fail "installed pre-rename Ply host ancestry was not recognized (bundle-rename transition)"
install_command_is_ply_host \
  "$REPO_ROOT/src-tauri/target/release/bundle/macos/Plyloft.app/Contents/MacOS/atelier" ||
  fail "non-/Applications Plyloft host ancestry was not recognized"
install_command_is_ply_host \
  "$REPO_ROOT/src-tauri/target/debug/atelier" ||
  fail "tauri-dev Plyloft host ancestry was not recognized"
if install_command_is_ply_host "/bin/bash ./scripts/install-local.sh"; then
  fail "ordinary external shell was misclassified as Plyloft"
fi
if install_command_is_ply_host "/Applications/Plyloft.app/Contents/MacOS/Plyloft"; then
  fail "the dead Plyloft-named-executable path must not match (the executable is always atelier)"
fi
if PLY_HOST=1 install_require_external_terminal "$REPO_ROOT" \
  >"$TEST_ROOT/ply-host.out" 2>&1; then
  fail "Plyloft-owned PTY marker did not refuse the installer"
fi
grep -Eq 'Plyloft-owned terminal' "$TEST_ROOT/ply-host.out" ||
  fail "Plyloft-owned PTY refusal was not specific"
if ATELIER_SHELL_INTEGRATION=1 install_require_external_terminal "$REPO_ROOT" \
  >"$TEST_ROOT/existing-ply-host.out" 2>&1; then
  fail "existing Plyloft shell marker did not refuse the installer"
fi
EXACT_PIDS="$(
  printf '%s\n' \
    '  41 /Applications/Plyloft.app/Contents/MacOS/atelier --unexpected' \
    '  42 /Applications/Plyloft.app/Contents/MacOS/atelier' \
    '  43 /Applications/Plyloft.app/Contents/MacOS/ply-mcp --config-dir /tmp' \
    '  44 /private/tmp/Plyloft.app/Contents/MacOS/atelier' |
    install_extract_exact_ply_pids
)"
assert_eq "42" "$EXACT_PIDS" "exact installed Plyloft process parser"
if grep -En 'launchctl submit|nohup|disown' \
  "$SCRIPT_DIR/install-local.sh" \
  "$SCRIPT_DIR/install-local-detached.sh" \
  "$SCRIPT_DIR/install-local-lib.sh" >/dev/null; then
  fail "retired supervisor/detach mechanism remains"
fi
if env -u PLY_HOST -u ATELIER_SHELL_INTEGRATION \
  "$SCRIPT_DIR/install-local.sh" >"$TEST_ROOT/boundary.out" 2>&1; then
  fail "non-interactive public installer unexpectedly succeeded"
fi
grep -Eq 'interactive external terminal' "$TEST_ROOT/boundary.out" ||
  fail "public installer did not fail at the external-terminal boundary"
if grep -Eq 'Building Plyloft|Comparing and installing' "$TEST_ROOT/boundary.out"; then
  fail "public installer crossed the process boundary before refusing"
fi
if "$SCRIPT_DIR/install-local-detached.sh" >"$TEST_ROOT/detached.out" 2>&1; then
  fail "retired detached entry unexpectedly succeeded"
fi
grep -Eq 'Detached local installation is retired' "$TEST_ROOT/detached.out" ||
  fail "detached entry does not explain the external-Terminal path"
pass "Plyloft-owned/non-interactive entries refuse and detached callers stay retired"

echo "── Missing-destination preflight precedes the build"
# Structural, not behavioral: install-local.sh hardcodes "/Applications" (not
# parameterizable), so this can't be driven end to end from a temp root.
# Instead prove the source has the fast-fail check, that it points at the
# migration doc when the pre-rename Ply.app is what's actually there, and
# that it appears before the build step so a missing destination is never
# discovered only after a ~10-minute build.
PREFLIGHT_LINE="$(grep -n 'missing_destination' "$SCRIPT_DIR/install-local.sh" | head -1 | cut -d: -f1)"
BUILD_LINE="$(grep -n 'Building Plyloft from' "$SCRIPT_DIR/install-local.sh" | head -1 | cut -d: -f1)"
[[ -n "$PREFLIGHT_LINE" && -n "$BUILD_LINE" ]] ||
  fail "install-local.sh is missing the preflight or the build marker"
[[ "$PREFLIGHT_LINE" -lt "$BUILD_LINE" ]] ||
  fail "missing-destination preflight must run before the build, not after"
grep -Fq 'do the one-time Plyloft migration first' "$SCRIPT_DIR/install-local.sh" ||
  fail "preflight does not point at the migration procedure when old Ply.app is present"
grep -Fq 'use the signed DMG for first installation' "$SCRIPT_DIR/install-local.sh" ||
  fail "preflight lost the genuine-first-install message"
pass "the preflight fails fast and before the build, with the right message either way"

printf '\n%d installer fixture groups passed.\n' "$PASS_COUNT"
