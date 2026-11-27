#!/usr/bin/env bash
# Launch A2: a release must be able to sign in to Plyloft. Refuses when the
# production GitHub client id (`PLYLOFT_GITHUB_CLIENT_ID`) or the PLY2
# entitlement key (`ENTITLEMENT_PUBKEY_HEX`) in src-tauri/src/account.rs is
# empty — such a build would show every user "Sign-in isn't set up" and lock
# the app (D1). Run by scripts/release.sh and the Windows release workflow
# before anything builds. Test: scripts/test-check-account-config.sh.
#
#   scripts/check-account-config.sh [ROOT]
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
FILE="$ROOT/src-tauri/src/account.rs"
[[ -f "$FILE" ]] || { echo "✗ no $FILE: can't check the Plyloft sign-in configuration"; exit 1; }

# The string value of `const NAME: &str =` (on the same or the next line).
value_of() {
  awk -v name="$1" '
    found { if (match($0, /"[^"]*"/)) { print substr($0, RSTART + 1, RLENGTH - 2); exit } }
    $0 ~ "const " name ": &str =" {
      found = 1
      rest = substr($0, index($0, "=") + 1)
      if (match(rest, /"[^"]*"/)) { print substr(rest, RSTART + 1, RLENGTH - 2); exit }
    }
  ' "$FILE"
}

fail=0
client_id="$(value_of PLYLOFT_GITHUB_CLIENT_ID)"
pubkey="$(value_of ENTITLEMENT_PUBKEY_HEX)"
if [[ -z "${client_id// /}" ]]; then
  echo "✗ PLYLOFT_GITHUB_CLIENT_ID in src-tauri/src/account.rs is empty: this release could not sign anyone in to Plyloft."
  echo "    Fill in the production \"Plyloft\" OAuth App's client id (LAUNCH_PLAN §6), then build again."
  fail=1
fi
if [[ -z "${pubkey// /}" ]]; then
  echo "✗ ENTITLEMENT_PUBKEY_HEX in src-tauri/src/account.rs is empty: this release could not verify any plan."
  echo "    Fill in the production PLY2 public key, then build again."
  fail=1
elif ! [[ "$pubkey" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "✗ ENTITLEMENT_PUBKEY_HEX in src-tauri/src/account.rs is not 32 bytes of hex."
  fail=1
fi
[[ "$fail" == 0 ]] && echo "✓ Plyloft sign-in is configured for this release"
exit "$fail"
