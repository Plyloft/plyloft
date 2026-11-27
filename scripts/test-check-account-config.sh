#!/usr/bin/env bash
# Self-test of scripts/check-account-config.sh (run by ppvp's pure contracts):
# an empty client id or key is refused with a clear message; both filled pass.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK="$SCRIPT_DIR/check-account-config.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0
KEY="231473ad8d61037dd16589a47f1f94b0434625d7960b1590c12dc2a8b73b522f"

make() { # name, client id, key
  mkdir -p "$tmp/$1/src-tauri/src"
  printf 'pub const PLYLOFT_GITHUB_CLIENT_ID: &str = "%s";\nconst ENTITLEMENT_PUBKEY_HEX: &str =\n    "%s";\n' "$2" "$3" \
    >"$tmp/$1/src-tauri/src/account.rs"
  echo "$tmp/$1"
}
expect() { # want, root, text
  local out got
  if out="$("$CHECK" "$2" 2>&1)"; then got=0; else got=1; fi
  [[ "$got" == "$1" ]] || { echo "✗ $2 → exit $got, expected $1: $out" >&2; fail=1; }
  [[ -z "${3:-}" ]] || grep -Fq "$3" <<<"$out" || { echo "✗ $2: no \"$3\" in: $out" >&2; fail=1; }
}
expect 0 "$(make ok Ov23liExample "$KEY")" "configured"
expect 1 "$(make noid "" "$KEY")" "PLYLOFT_GITHUB_CLIENT_ID in src-tauri/src/account.rs is empty"
expect 1 "$(make nokey Ov23liExample "")" "ENTITLEMENT_PUBKEY_HEX in src-tauri/src/account.rs is empty"
expect 1 "$(make badkey Ov23liExample "abc")" "not 32 bytes of hex"
expect 1 "$tmp/missing" "can't check"
# The repository as it is today (client id still empty) is refused.
if "$CHECK" >/dev/null 2>&1; then
  grep -q 'PLYLOFT_GITHUB_CLIENT_ID: &str = "";' "$SCRIPT_DIR/../src-tauri/src/account.rs" &&
    { echo "✗ the repository's empty client id passed" >&2; fail=1; }
fi
[[ "$fail" == 0 ]] && echo "check-account-config: all checks passed"
exit "$fail"
