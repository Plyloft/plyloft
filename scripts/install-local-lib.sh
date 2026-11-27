#!/usr/bin/env bash
#
# Shared bootstrap-installer primitives.
#
# This file is sourced by install-local.sh and the temporary-root fixture
# harness. It is not an entry point. Production and fixtures use the same
# InstallPaths-style constructor and destructive-path validator.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "✗ install-local-lib.sh is a library, not an entry point." >&2
  exit 1
fi

INSTALL_ROOT=""
INSTALL_ATTEMPT_ID=""
INSTALL_DESTINATION=""
INSTALL_STAGING=""
INSTALL_BACKUP=""
INSTALL_FAILED=""
INSTALL_LOG=""
INSTALL_LOCK_DIR=""
INSTALL_LOCK_HELD=0

install_now() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

install_log() {
  local phase="$1"
  local outcome="$2"
  shift 2
  local detail="$*"
  if [[ -n "${INSTALL_LOG:-}" ]]; then
    printf '%s pid=%s phase=%s outcome=%s detail=%s\n' \
      "$(install_now)" "$$" "$phase" "$outcome" "$detail" >> "$INSTALL_LOG"
  fi
}

install_error() {
  local phase="$1"
  shift
  install_log "$phase" "error" "$*"
  echo "✗ $*" >&2
  return 1
}

install_contains_newline() {
  [[ "$1" == *$'\n'* || "$1" == *$'\r'* ]]
}

install_require_absolute_existing_dir() {
  local path="$1"
  local label="$2"
  [[ "$path" == /* ]] ||
    install_error "paths" "invalid" "$label must be absolute: $path" ||
    return 1
  ! install_contains_newline "$path" ||
    install_error "paths" "invalid" "$label contains a newline" ||
    return 1
  [[ -d "$path" ]] ||
    install_error "paths" "invalid" "$label is not an existing directory: $path" ||
    return 1
}

# Shell equivalent of InstallPaths::new(root, attempt_id). Every destructive
# bundle path is derived here and validated by install_validate_path_kind.
install_paths_new() {
  local root="$1"
  local attempt_id="$2"

  install_require_absolute_existing_dir "$root" "install root" || return 1
  [[ ! -L "$root" ]] ||
    install_error "paths" "invalid" "install root cannot be a symlink: $root" ||
    return 1
  [[ "$attempt_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
    install_error "paths" "invalid" "unsafe attempt id: $attempt_id" ||
    return 1

  INSTALL_ROOT="$(cd "$root" && pwd -P)" || return 1
  [[ "$INSTALL_ROOT" != "/" ]] ||
    install_error "paths" "invalid" "filesystem root cannot be an install root" ||
    return 1
  INSTALL_ATTEMPT_ID="$attempt_id"
  INSTALL_DESTINATION="$INSTALL_ROOT/Plyloft.app"
  INSTALL_STAGING="$INSTALL_ROOT/.Plyloft.app.install-$attempt_id"
  INSTALL_BACKUP="$INSTALL_ROOT/.Plyloft.app.previous-$attempt_id"
  INSTALL_FAILED="$INSTALL_ROOT/.Plyloft.app.failed-$attempt_id"

  install_validate_path_kind destination "$INSTALL_DESTINATION" || return 1
  install_validate_path_kind staging "$INSTALL_STAGING" || return 1
  install_validate_path_kind backup "$INSTALL_BACKUP" || return 1
  install_validate_path_kind failed "$INSTALL_FAILED" || return 1
}

install_expected_path_for_kind() {
  case "$1" in
    destination) printf '%s\n' "$INSTALL_DESTINATION" ;;
    staging) printf '%s\n' "$INSTALL_STAGING" ;;
    backup) printf '%s\n' "$INSTALL_BACKUP" ;;
    failed) printf '%s\n' "$INSTALL_FAILED" ;;
    *)
      install_error "paths" "invalid" "unknown install path kind: $1"
      return 1
      ;;
  esac
}

install_validate_path_kind() {
  local kind="$1"
  local path="$2"
  local expected
  expected="$(install_expected_path_for_kind "$kind")" || return 1

  [[ -n "$INSTALL_ROOT" && -n "$INSTALL_ATTEMPT_ID" ]] ||
    install_error "paths" "invalid" "install paths are not initialized" ||
    return 1
  [[ "$path" == "$expected" ]] ||
    install_error "paths" "invalid" "$kind path differs from constructor output" ||
    return 1
  [[ "$path" == "$INSTALL_ROOT/"* ]] ||
    install_error "paths" "invalid" "$kind is not below the install root" ||
    return 1
  [[ "$(dirname "$path")" == "$INSTALL_ROOT" ]] ||
    install_error "paths" "invalid" "$kind is not a direct install-root sibling" ||
    return 1
  ! install_contains_newline "$path" ||
    install_error "paths" "invalid" "$kind path contains a newline" ||
    return 1
}

install_remove_path_kind() {
  local kind="$1"
  local path
  path="$(install_expected_path_for_kind "$kind")" || return 1
  install_validate_path_kind "$kind" "$path" || return 1
  if [[ -e "$path" || -L "$path" ]]; then
    # v1.103.0 (D9): report the outcome instead of relying on `set -e`.
    # Callers that check this must not be told "removed" when the bundle is
    # still there — a backup owned by another macOS account cannot be
    # deleted by this user, and `rm`'s own stderr is not the message the
    # reader needs.
    if ! rm -rf -- "$path" 2>/dev/null || [[ -e "$path" || -L "$path" ]]; then
      install_log "cleanup" "remove_failed" "$kind=$path"
      return 1
    fi
    install_log "cleanup" "removed" "$kind=$path"
  fi
}

install_rename_path_kinds() {
  local from_kind="$1"
  local to_kind="$2"
  local from_path to_path
  from_path="$(install_expected_path_for_kind "$from_kind")" || return 1
  to_path="$(install_expected_path_for_kind "$to_kind")" || return 1
  install_validate_path_kind "$from_kind" "$from_path" || return 1
  install_validate_path_kind "$to_kind" "$to_path" || return 1
  [[ -e "$from_path" || -L "$from_path" ]] ||
    install_error "rename" "missing" "$from_kind does not exist: $from_path" ||
    return 1
  [[ ! -e "$to_path" && ! -L "$to_path" ]] ||
    install_error "rename" "occupied" "$to_kind already exists: $to_path" ||
    return 1
  mv -- "$from_path" "$to_path"
  install_log "rename" "ok" "$from_kind->$to_kind"
}

INSTALL_RESIDUE_KIND=""
INSTALL_RESIDUE_ATTEMPT=""
INSTALL_RESIDUE_LOG=""

install_classify_residue() {
  local root="$1"
  local candidate="$2"
  local log_root="$3"
  local base kind attempt
  base="$(basename "$candidate")"
  case "$base" in
    .Plyloft.app.install-*)
      kind="staging"
      attempt="${base#.Plyloft.app.install-}"
      ;;
    .Plyloft.app.previous-*)
      kind="backup"
      attempt="${base#.Plyloft.app.previous-}"
      ;;
    .Plyloft.app.failed-*)
      kind="failed"
      attempt="${base#.Plyloft.app.failed-}"
      ;;
    *)
      install_error "residue" "invalid" "unrecognized installer residue: $candidate"
      return 1
      ;;
  esac

  local saved_root="$INSTALL_ROOT"
  local saved_attempt="$INSTALL_ATTEMPT_ID"
  local saved_destination="$INSTALL_DESTINATION"
  local saved_staging="$INSTALL_STAGING"
  local saved_backup="$INSTALL_BACKUP"
  local saved_failed="$INSTALL_FAILED"
  local expected=""
  if install_paths_new "$root" "$attempt"; then
    expected="$(install_expected_path_for_kind "$kind")"
  fi
  INSTALL_ROOT="$saved_root"
  INSTALL_ATTEMPT_ID="$saved_attempt"
  INSTALL_DESTINATION="$saved_destination"
  INSTALL_STAGING="$saved_staging"
  INSTALL_BACKUP="$saved_backup"
  INSTALL_FAILED="$saved_failed"
  [[ -n "$expected" && "$candidate" == "$expected" ]] ||
    install_error "residue" "invalid" \
      "residue does not match constructor output: $candidate" ||
    return 1

  INSTALL_RESIDUE_KIND="$kind"
  INSTALL_RESIDUE_ATTEMPT="$attempt"
  INSTALL_RESIDUE_LOG="${log_root%/}/install-local-$attempt.log"
}

install_residue_scan() {
  local root="$1"
  local log_root="$2"
  local output_file="$3"
  install_require_absolute_existing_dir "$root" "install root" || return 1
  install_require_absolute_existing_dir "$log_root" "log directory" || return 1
  : > "$output_file"

  local entries
  entries="$(mktemp "${TMPDIR:-/tmp}/ply-installer-residue.XXXXXX")" || return 1
  if ! find "$root" -mindepth 1 -maxdepth 1 \
    \( -name '.Plyloft.app.install-*' \
       -o -name '.Plyloft.app.previous-*' \
       -o -name '.Plyloft.app.failed-*' \) \
    -print0 > "$entries"; then
    rm -f -- "$entries"
    return 1
  fi

  local candidate
  while IFS= read -r -d '' candidate; do
    if ! install_classify_residue "$root" "$candidate" "$log_root"; then
      rm -f -- "$entries"
      return 1
    fi
    printf '%s\t%s\t%s\t%s\n' \
      "$INSTALL_RESIDUE_KIND" \
      "$INSTALL_RESIDUE_ATTEMPT" \
      "$candidate" \
      "$INSTALL_RESIDUE_LOG" >> "$output_file"
  done < "$entries"
  rm -f -- "$entries"
}

install_report_residues() {
  local residue_file="$1"
  local kind attempt path evidence_log
  while IFS=$'\t' read -r kind attempt path evidence_log; do
    [[ -n "$kind" ]] || continue
    echo "  • $kind residue from attempt $attempt"
    echo "    path: $path"
    if [[ -f "$evidence_log" ]]; then
      echo "    log:  $evidence_log"
    else
      echo "    log:  $evidence_log (not found)"
    fi
  done < "$residue_file"
}

install_assert_no_residue() {
  local root="$1"
  local log_root="$2"
  local residue_file
  residue_file="$(mktemp "${TMPDIR:-/tmp}/ply-installer-residue-report.XXXXXX")" ||
    return 1
  if ! install_residue_scan "$root" "$log_root" "$residue_file"; then
    rm -f -- "$residue_file"
    return 1
  fi
  if [[ -s "$residue_file" ]]; then
    install_log "residue" "blocked" "previous installer evidence exists"
    echo "✗ Previous installer evidence must be inspected before continuing." >&2
    install_report_residues "$residue_file" >&2
    echo "  After inspection, remove only these validated siblings with:" >&2
    echo "  ./scripts/install-local.sh --recover-residue" >&2
    rm -f -- "$residue_file"
    return 1
  fi
  rm -f -- "$residue_file"
}

install_recover_residue() {
  local root="$1"
  local log_root="$2"
  install_require_absolute_existing_dir "$root" "install root" || return 1
  [[ ! -L "$root" ]] ||
    install_error "residue_recovery" "invalid_root" \
      "install root cannot be a symlink: $root" ||
    return 1
  local canonical_root
  canonical_root="$(cd "$root" && pwd -P)" || return 1
  local destination="$canonical_root/Plyloft.app"
  [[ -d "$destination" && ! -L "$destination" ]] ||
    install_error "residue_recovery" "missing_destination" \
      "refusing residue cleanup while the installed destination is missing" ||
    return 1

  local residue_file
  residue_file="$(mktemp "${TMPDIR:-/tmp}/ply-installer-residue-recovery.XXXXXX")" ||
    return 1
  if ! install_residue_scan "$canonical_root" "$log_root" "$residue_file"; then
    rm -f -- "$residue_file"
    return 1
  fi
  if [[ ! -s "$residue_file" ]]; then
    rm -f -- "$residue_file"
    install_error "residue_recovery" "missing" "no installer residue exists"
    return 1
  fi

  echo "── Removing explicitly validated installer residue"
  install_report_residues "$residue_file"
  local kind attempt path evidence_log
  while IFS=$'\t' read -r kind attempt path evidence_log; do
    [[ -n "$kind" ]] || continue
    install_paths_new "$canonical_root" "$attempt" || {
      rm -f -- "$residue_file"
      return 1
    }
    [[ "$(install_expected_path_for_kind "$kind")" == "$path" ]] || {
      rm -f -- "$residue_file"
      install_error "residue_recovery" "path_changed" \
        "validated residue changed before removal: $path"
      return 1
    }
    if ! install_remove_path_kind "$kind"; then
      rm -f -- "$residue_file"
      install_error "residue_recovery" "remove_failed" \
        "could not remove $kind residue: $path"
      {
        echo "  Its files belong to another account, so this user cannot"
        echo "  delete them. Remove it with:"
        echo "    sudo rm -rf '$path'"
      } >&2
      return 1
    fi
    install_log "residue_recovery" "removed" \
      "kind=$kind attempt=$attempt path=$path evidence_log=$evidence_log"
  done < "$residue_file"
  rm -f -- "$residue_file"
  echo "✓ Removed every reported installer residue. Prior attempt logs were retained."
}

install_hex() {
  LC_ALL=C od -An -v -tx1 | tr -d ' \n'
}

# Prints one SHA-256 identity for paths, entry types, POSIX modes, file bytes,
# and symlink targets. Newline-bearing paths fail before a manifest is used.
bundle_fingerprint() {
  local bundle="$1"
  local manifest_out="${2:-}"
  install_require_absolute_existing_dir "$bundle" "bundle" || return 1
  [[ ! -L "$bundle" ]] ||
    install_error "fingerprint" "invalid" "bundle root cannot be a symlink: $bundle" ||
    return 1

  local entries unsorted sorted
  entries="$(mktemp "${TMPDIR:-/tmp}/ply-bundle-entries.XXXXXX")" || return 1
  unsorted="$(mktemp "${TMPDIR:-/tmp}/ply-bundle-unsorted.XXXXXX")" || {
    rm -f -- "$entries"
    return 1
  }
  sorted="$(mktemp "${TMPDIR:-/tmp}/ply-bundle-manifest.XXXXXX")" || {
    rm -f -- "$entries" "$unsorted"
    return 1
  }
  if ! find "$bundle" -print0 > "$entries"; then
    rm -f -- "$entries" "$unsorted" "$sorted"
    return 1
  fi

  local failed=0
  local entry rel path_hex mode kind payload
  while IFS= read -r -d '' entry; do
    if [[ "$entry" == "$bundle" ]]; then
      rel="."
    else
      rel="${entry#"$bundle"/}"
    fi
    if install_contains_newline "$rel"; then
      echo "bundle path contains a newline: $rel" >&2
      failed=1
      break
    fi

    path_hex="$(printf '%s' "$rel" | install_hex)"
    mode="$(stat -f '%Lp' "$entry")" || {
      failed=1
      break
    }

    if [[ -L "$entry" ]]; then
      kind="symlink"
      payload="$(readlink "$entry" | install_hex)" || {
        failed=1
        break
      }
    elif [[ -d "$entry" ]]; then
      kind="directory"
      payload="-"
    elif [[ -f "$entry" ]]; then
      kind="file"
      payload="$(shasum -a 256 "$entry" | awk '{print $1}')" || {
        failed=1
        break
      }
    else
      echo "unsupported bundle entry: $rel" >&2
      failed=1
      break
    fi

    printf '%s\t%s\t%s\t%s\n' "$path_hex" "$kind" "$mode" "$payload" >> "$unsorted"
  done < "$entries"
  rm -f -- "$entries"

  if [[ "$failed" -ne 0 ]]; then
    rm -f -- "$unsorted" "$sorted"
    return 1
  fi

  LC_ALL=C sort "$unsorted" > "$sorted" || {
    rm -f -- "$unsorted" "$sorted"
    return 1
  }
  rm -f -- "$unsorted"

  local fingerprint
  fingerprint="$(shasum -a 256 "$sorted" | awk '{print $1}')" || {
    rm -f -- "$sorted"
    return 1
  }
  if [[ -n "$manifest_out" ]]; then
    mv -- "$sorted" "$manifest_out"
  else
    rm -f -- "$sorted"
  fi
  printf '%s\n' "$fingerprint"
}

bundle_version() {
  local bundle="$1"
  install_require_absolute_existing_dir "$bundle" "bundle" || return 1
  [[ ! -L "$bundle" ]] ||
    install_error "version" "invalid" "bundle root cannot be a symlink: $bundle" ||
    return 1
  local plist="$bundle/Contents/Info.plist"
  [[ -f "$plist" ]] ||
    install_error "version" "missing" "bundle has no Contents/Info.plist: $bundle" ||
    return 1
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist" 2>/dev/null ||
    install_error "version" "invalid" "bundle version is unreadable: $plist"
}

install_log_init() {
  local log_dir="$1"
  local stamp="$2"
  install_require_absolute_existing_dir "$log_dir" "log directory" || return 1
  INSTALL_LOG="$log_dir/install-local-$stamp-$$.log"
  [[ ! -e "$INSTALL_LOG" ]] ||
    install_error "log" "collision" "attempt log already exists: $INSTALL_LOG" ||
    return 1
  touch "$INSTALL_LOG"
  install_log "attempt" "started" "log=$INSTALL_LOG"
}

install_lock_path() {
  local support_root="$1"
  install_require_absolute_existing_dir "$support_root" "Application Support root" ||
    return 1
  printf '%s\n' "${support_root%/}/install-local.lock"
}

install_lock_acquire() {
  local support_root="$1"
  local repo_root="$2"
  local lock
  lock="$(install_lock_path "$support_root")" || return 1

  if ! mkdir "$lock" 2>/dev/null; then
    if [[ -L "$lock" ]]; then
      install_error "lock" "invalid" "installer lock path is a symlink: $lock"
      return 1
    fi
    local owner="unknown"
    [[ -f "$lock/owner.pid" ]] && owner="$(tr -d '[:space:]' < "$lock/owner.pid")"
    if [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null; then
      install_error "lock" "busy" "installer lock is held by live pid $owner"
    else
      install_error "lock" "stale" \
        "stale installer lock found; run ./scripts/install-local.sh --recover-stale-lock"
    fi
    return 1
  fi

  INSTALL_LOCK_DIR="$lock"
  INSTALL_LOCK_HELD=1
  printf '%s\n' "$$" > "$lock/owner.pid"
  printf '%s\n' "$(install_now)" > "$lock/started-at"
  printf '%s\n' "$repo_root" > "$lock/repository"
  printf '%s\n' "$INSTALL_LOG" > "$lock/attempt-log"
  install_log "lock" "acquired" "path=$lock"
}

install_lock_release() {
  [[ "$INSTALL_LOCK_HELD" -eq 1 ]] || return 0
  local owner=""
  [[ -f "$INSTALL_LOCK_DIR/owner.pid" ]] &&
    owner="$(tr -d '[:space:]' < "$INSTALL_LOCK_DIR/owner.pid")"
  if [[ "$owner" != "$$" ]]; then
    install_log "lock" "owner_mismatch" "expected=$$ observed=$owner"
    return 1
  fi
  rm -f -- \
    "$INSTALL_LOCK_DIR/owner.pid" \
    "$INSTALL_LOCK_DIR/started-at" \
    "$INSTALL_LOCK_DIR/repository" \
    "$INSTALL_LOCK_DIR/attempt-log"
  rmdir "$INSTALL_LOCK_DIR"
  INSTALL_LOCK_HELD=0
  install_log "lock" "released" "path=$INSTALL_LOCK_DIR"
}

install_lock_recover_stale() {
  local support_root="$1"
  local lock owner
  lock="$(install_lock_path "$support_root")" || return 1
  [[ ! -L "$lock" ]] ||
    install_error "lock_recovery" "invalid" "installer lock path is a symlink: $lock" ||
    return 1
  [[ -d "$lock" ]] ||
    install_error "lock_recovery" "missing" "no stale installer lock exists" ||
    return 1
  owner="unknown"
  [[ -f "$lock/owner.pid" ]] && owner="$(tr -d '[:space:]' < "$lock/owner.pid")"
  if [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null; then
    install_error "lock_recovery" "live_owner" "pid $owner is still alive"
    return 1
  fi

  rm -f -- \
    "$lock/owner.pid" \
    "$lock/started-at" \
    "$lock/repository" \
    "$lock/attempt-log"
  if ! rmdir "$lock"; then
    install_error "lock_recovery" "unknown_entries" \
      "lock contains unknown entries; inspect manually: $lock"
    return 1
  fi
  install_log "lock_recovery" "removed" "owner=$owner path=$lock"
}

install_command_is_ply_host() {
  local command="$1"
  # Both bundle names during the transition: an app may still be running from
  # /Applications/Ply.app (updated in place by the in-app updater) or from
  # the migrated /Applications/Plyloft.app. The executable name itself
  # (`atelier`) never changes — see AGENTS.md / RELEASING.md.
  [[ "$command" == *"/Ply.app/Contents/MacOS/atelier"* ||
     "$command" == *"/Plyloft.app/Contents/MacOS/atelier"* ||
     "$command" == *"/src-tauri/target/debug/atelier"* ||
     "$command" == *"/src-tauri/target/release/atelier"* ]]
}

install_require_external_terminal() {
  local repo_root="${1:-$PWD}"
  if [[ "${PLY_HOST:-0}" == "1" ||
        "${ATELIER_SHELL_INTEGRATION:-0}" == "1" ]]; then
    echo "✗ The local installer cannot run inside a Plyloft-owned terminal." >&2
    echo "  Open an external terminal, then run:" >&2
    echo "  cd \"$repo_root\" && ./scripts/install-local.sh" >&2
    return 1
  fi
  if [[ ! -t 0 || ! -t 1 ]]; then
    echo "✗ Run the local installer from an interactive external terminal." >&2
    echo "  cd \"$repo_root\" && ./scripts/install-local.sh" >&2
    return 1
  fi

  local pid="$PPID"
  local depth=0
  local command parent
  while [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && "$depth" -lt 64 ]]; do
    command="$(ps -ww -p "$pid" -o command= 2>/dev/null)" || {
      echo "✗ Cannot inspect process ancestry; refusing local installation." >&2
      return 1
    }
    if install_command_is_ply_host "$command"; then
      echo "✗ The local installer cannot run inside Plyloft." >&2
      echo "  Open an external terminal, then run:" >&2
      echo "  cd \"$repo_root\" && ./scripts/install-local.sh" >&2
      return 1
    fi
    parent="$(ps -ww -p "$pid" -o ppid= 2>/dev/null | tr -d '[:space:]')" || {
      echo "✗ Cannot inspect process ancestry; refusing local installation." >&2
      return 1
    }
    [[ -n "$parent" && "$parent" != "$pid" ]] || break
    pid="$parent"
    depth=$((depth + 1))
  done
  [[ "$depth" -lt 64 ]] || {
    echo "✗ Process ancestry exceeded the safety bound." >&2
    return 1
  }
}

install_extract_exact_ply_pids() {
  awk '
    $2 == "/Applications/Plyloft.app/Contents/MacOS/atelier" && NF == 2 {
      print $1
    }
  '
}

install_exact_ply_pids() {
  ps -axo pid=,args= 2>/dev/null | install_extract_exact_ply_pids
}

install_request_graceful_quit() {
  local timeout_secs="${1:-30}"
  local before
  before="$(install_exact_ply_pids)"
  [[ -n "$before" ]] || {
    install_log "quit" "not_running" "destination process absent"
    return 0
  }

  install_log "quit" "requested" "pids=$(printf '%s' "$before" | tr '\n' ',')"
  osascript -e 'tell application id "com.mbadv.ply" to quit' >/dev/null 2>&1 || {
    install_error "quit" "request_failed" "macOS rejected the graceful quit request"
    return 1
  }

  local waited=0
  while [[ "$waited" -lt "$timeout_secs" ]]; do
    [[ -z "$(install_exact_ply_pids)" ]] && {
      install_log "quit" "complete" "waited=${waited}s"
      return 0
    }
    sleep 1
    waited=$((waited + 1))
  done
  install_error "quit" "timeout" \
    "Plyloft did not quit after ${timeout_secs}s; close it manually and rerun"
}

install_open_and_wait() {
  local timeout_secs="${1:-30}"
  open "$INSTALL_DESTINATION" || return 1
  local waited=0
  while [[ "$waited" -lt "$timeout_secs" ]]; do
    [[ -n "$(install_exact_ply_pids)" ]] && {
      install_log "launch" "running" "waited=${waited}s"
      return 0
    }
    sleep 1
    waited=$((waited + 1))
  done
  install_error "launch" "timeout" "installed Plyloft did not appear after ${timeout_secs}s"
}

install_fixture_fault() {
  local mode="$1"
  local phase="$2"
  [[ "$mode" == "fixture" ]] || return 1
  [[ "${PLY_INSTALL_FIXTURE_FAULT:-}" == "$phase" ]]
}

install_validate_mode() {
  local mode="$1"
  case "$mode" in
    production)
      [[ "$INSTALL_ROOT" == "/Applications" ]] ||
        install_error "mode" "invalid" "production root must be /Applications" ||
        return 1
      ;;
    fixture)
      [[ "${PLY_INSTALL_FIXTURE_MODE:-0}" == "1" ]] ||
        install_error "mode" "invalid" "fixture mode is not enabled" ||
        return 1
      [[ "$INSTALL_ROOT" != "/Applications" ]] ||
        install_error "mode" "invalid" "fixture mode cannot target /Applications" ||
        return 1
      [[ -n "${PLY_INSTALL_FIXTURE_ROOT:-}" &&
         "$INSTALL_ROOT" == "$PLY_INSTALL_FIXTURE_ROOT" ]] ||
        install_error "mode" "invalid" \
          "fixture root must match its explicitly registered temporary root" ||
        return 1
      ;;
    *)
      install_error "mode" "invalid" "unknown installer mode: $mode"
      return 1
      ;;
  esac
}

install_rollback() {
  local old_fingerprint="$1"
  local mode="$2"
  local failure_detail="$3"
  install_log "rollback" "started" "$failure_detail"

  if [[ -e "$INSTALL_DESTINATION" || -L "$INSTALL_DESTINATION" ]]; then
    if [[ -e "$INSTALL_FAILED" || -L "$INSTALL_FAILED" ]]; then
      install_log "rollback" "failed_path_occupied" "path=$INSTALL_FAILED"
      echo "✗ Rollback needs manual recovery; failed path is occupied." >&2
      echo "  destination: $INSTALL_DESTINATION" >&2
      echo "  backup:      $INSTALL_BACKUP" >&2
      echo "  failed:      $INSTALL_FAILED" >&2
      return 1
    fi
    install_rename_path_kinds destination failed || return 1
  fi

  if [[ ! -e "$INSTALL_BACKUP" && ! -L "$INSTALL_BACKUP" ]]; then
    install_log "rollback" "missing_backup" "path=$INSTALL_BACKUP"
    echo "✗ Rollback needs manual recovery; backup is missing." >&2
    return 1
  fi
  install_rename_path_kinds backup destination || return 1

  local restored
  restored="$(bundle_fingerprint "$INSTALL_DESTINATION")" || return 1
  if [[ "$restored" != "$old_fingerprint" ]]; then
    install_log "rollback" "fingerprint_mismatch" \
      "expected=$old_fingerprint observed=$restored"
    echo "✗ Restored bundle fingerprint does not match the backup." >&2
    return 1
  fi

  if [[ "$mode" == "production" ]]; then
    install_open_and_wait 30 || {
      echo "✗ Old Plyloft was restored but did not relaunch." >&2
      return 1
    }
  fi
  install_log "rollback" "complete" "failed_candidate=$INSTALL_FAILED"
  echo "✓ The previous Plyloft bundle was restored and its fingerprint was reverified." >&2
  if [[ "$mode" == "production" ]]; then
    echo "✓ The previous Plyloft bundle was relaunched." >&2
  fi
  echo "  Failure:          $failure_detail" >&2
  if [[ -e "$INSTALL_FAILED" || -L "$INSTALL_FAILED" ]]; then
    echo "  Failed candidate: $INSTALL_FAILED (retained)" >&2
  else
    echo "  Failed candidate: $INSTALL_FAILED (not created)" >&2
  fi
  if [[ -e "$INSTALL_STAGING" || -L "$INSTALL_STAGING" ]]; then
    echo "  Staged candidate: $INSTALL_STAGING (retained)" >&2
  fi
  echo "  Attempt log:      ${INSTALL_LOG:-unavailable}" >&2
}

# Transaction begins after the caller has acquired the installer lock and
# prepared the source bundle. Fixture faults are accepted only under a
# non-/Applications root with PLY_INSTALL_FIXTURE_MODE=1.
install_replace_bundle() {
  local source_bundle="$1"
  local mode="$2"
  install_validate_mode "$mode" || return 1
  install_require_absolute_existing_dir "$source_bundle" "source bundle" || return 1
  [[ ! -L "$source_bundle" ]] ||
    install_error "preflight" "invalid_source" "source bundle cannot be a symlink" ||
    return 1
  [[ -d "$INSTALL_DESTINATION" && ! -L "$INSTALL_DESTINATION" ]] ||
    install_error "preflight" "missing_destination" \
      "installed Plyloft is missing; use the signed DMG for first installation" ||
    return 1

  local source_fingerprint destination_fingerprint staged_fingerprint
  local old_fingerprint installed_fingerprint
  local source_version destination_version
  source_version="$(bundle_version "$source_bundle")" || return 1
  destination_version="$(bundle_version "$INSTALL_DESTINATION")" || return 1
  source_fingerprint="$(bundle_fingerprint "$source_bundle")" || return 1
  destination_fingerprint="$(bundle_fingerprint "$INSTALL_DESTINATION")" || return 1
  install_log "version" "source" "$source_version"
  install_log "version" "destination" "$destination_version"
  install_log "fingerprint" "source" "$source_fingerprint"
  install_log "fingerprint" "destination" "$destination_fingerprint"
  echo "  Source version:      $source_version"
  echo "  Installed version:   $destination_version"

  if [[ "$source_fingerprint" == "$destination_fingerprint" ]]; then
    install_log "transaction" "already_installed" "fingerprint=$source_fingerprint"
    echo "✓ Plyloft is already installed with the same bundle fingerprint."
    return 0
  fi

  for kind in staging backup failed; do
    local candidate
    candidate="$(install_expected_path_for_kind "$kind")" || return 1
    [[ ! -e "$candidate" && ! -L "$candidate" ]] ||
      install_error "preflight" "residue" "$kind path already exists: $candidate" ||
      return 1
  done

  if install_fixture_fault "$mode" "copy"; then
    install_log "stage" "injected_copy_failure" "before ditto"
    return 1
  fi
  ditto --noqtn "$source_bundle" "$INSTALL_STAGING" || {
    install_log "stage" "copy_failed" "source=$source_bundle"
    install_remove_path_kind staging || true
    return 1
  }
  staged_fingerprint="$(bundle_fingerprint "$INSTALL_STAGING")" || {
    install_remove_path_kind staging || true
    return 1
  }
  if [[ "$staged_fingerprint" != "$source_fingerprint" ]]; then
    install_log "stage" "fingerprint_mismatch" \
      "source=$source_fingerprint staged=$staged_fingerprint"
    install_remove_path_kind staging || true
    return 1
  fi
  install_log "stage" "verified" "fingerprint=$staged_fingerprint"

  if install_fixture_fault "$mode" "quit_timeout"; then
    install_log "quit" "timeout" "fixture"
    install_remove_path_kind staging || true
    return 1
  elif [[ "$mode" == "production" ]]; then
    if ! install_request_graceful_quit 30; then
      install_remove_path_kind staging || true
      return 1
    fi
  fi

  old_fingerprint="$destination_fingerprint"
  install_rename_path_kinds destination backup || {
    install_remove_path_kind staging || true
    return 1
  }

  local failure=""
  if install_fixture_fault "$mode" "post_backup"; then
    failure="injected failure after backup rename"
  elif ! install_rename_path_kinds staging destination; then
    failure="staging-to-destination rename failed"
  elif install_fixture_fault "$mode" "post_install"; then
    failure="injected failure after replacement"
  else
    installed_fingerprint="$(bundle_fingerprint "$INSTALL_DESTINATION")" ||
      failure="installed fingerprint could not be computed"
    if [[ -z "$failure" && "$installed_fingerprint" != "$source_fingerprint" ]]; then
      failure="installed fingerprint mismatch"
    fi
  fi

  if [[ -z "$failure" && "$mode" == "production" ]]; then
    xattr -cr "$INSTALL_DESTINATION" ||
      failure="quarantine removal failed"
  fi
  if [[ -z "$failure" ]] && install_fixture_fault "$mode" "launch"; then
    failure="injected launch failure"
  elif [[ -z "$failure" && "$mode" == "production" ]]; then
    install_open_and_wait 30 || failure="installed Plyloft failed to launch"
  fi

  if [[ -n "$failure" ]]; then
    install_log "transaction" "failed_after_backup" "$failure"
    echo "✗ Local installation failed after the previous bundle was backed up." >&2
    install_rollback "$old_fingerprint" "$mode" "$failure" || return 1
    return 1
  fi

  install_log "transaction" "installed" "fingerprint=$source_fingerprint"
  # v1.103.0 (D9): by here the bundle is staged, renamed, fingerprint-checked
  # and launched — the installation succeeded. A backup that cannot be
  # deleted (typically one installed earlier by a different macOS account) is
  # residue to report, never a reason to call a good install failed. Under
  # `set -e` this line used to abort the script after success: no ✓, non-zero
  # exit, and a residue that then blocked the next run.
  if ! install_remove_path_kind backup; then
    echo "✓ Installed Plyloft and verified bundle fingerprint $source_fingerprint."
    {
      echo "⚠ The previous bundle could not be removed:"
      echo "    $INSTALL_BACKUP"
      echo "  It belongs to another account. The next install will refuse to"
      echo "  start until it is gone. Remove it with:"
      echo "    sudo rm -rf '$INSTALL_BACKUP'"
    } >&2
    return 0
  fi
  echo "✓ Installed Plyloft and verified bundle fingerprint $source_fingerprint."
}
