#!/usr/bin/env bash
# App tester on Windows (docs/app-tester/DESIGN.md, "Windows"): builds
# "Plyloft Test" and ply-test-winhelper inside the Parallels Windows VM, from
# a branch of this repo fetched through the shared folder (\\Mac\Home).
#
#   scripts/app-tester/vm-build.sh [branch] [--helper-only]
#
# Env: PLY_TEST_VM (default "Windows 11"; or in walk.env). The VM must be running with its
# user signed in (prlctl exec --current-user). Logs in the VM:
# C:\build\ply-test-logs\. Never a release: debug build, test-bridge feature,
# identifier com.mbadv.ply.test.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
. "$(dirname "$0")/walk-config.sh"
VM="${PLY_TEST_VM:-Windows 11}"
branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
helper_only=""
for arg in "$@"; do
  case "$arg" in
    --helper-only) helper_only="-HelperOnly" ;;
    *) branch="$arg" ;;
  esac
done

to_unc() {
  case "$1" in
    "$HOME"/*) printf '\\\\Mac\\Home\\%s' "$(printf '%s' "${1#"$HOME"/}" | tr '/' '\\')" ;;
    *) echo "✗ $1 is not under \$HOME, so the VM cannot reach it through \\\\Mac\\Home" >&2; return 1 ;;
  esac
}
# The repo that holds the branch (a worktree's common dir), as the VM sees it.
common="$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd)"
unc="$(to_unc "${common%/.git}")"
script_unc="$(to_unc "$ROOT/scripts/app-tester/windows/build-test.ps1")"
git -C "$ROOT" rev-parse --verify -q "refs/heads/$branch" >/dev/null || { echo "✗ no local branch $branch" >&2; exit 1; }

# prlctl exec takes a short command line only: copy the script into the VM
# and run it from there (a local file, so no zone prompt).
run() { prlctl exec "$VM" --current-user "$@" 2>&1 | grep -v '^#< CLIXML\|^<Objs' || true; }
run cmd /c "mkdir C:\ply-test 2>nul & copy /y \"$script_unc\" C:\ply-test\build-test.ps1 >nul && echo copied" | grep -q copied ||
  { echo "✗ could not copy the build script into \"$VM\" (is the VM running, its user signed in, and Home shared?)" >&2; exit 1; }
echo "→ building $branch in \"$VM\" from $unc" >&2
out="$(run powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\ply-test\build-test.ps1' -Repo "$unc" -Branch "$branch" $helper_only)"
printf '%s\n' "$out"
if [ -n "$helper_only" ]; then
  printf '%s\n' "$out" | grep -q "^ply-test-winhelper " || { echo "✗ VM helper build failed (C:\\build\\ply-test-logs\\helper.log)" >&2; exit 1; }
else
  printf '%s\n' "$out" | grep -q BUILD_OK || { echo "✗ VM build failed (logs: C:\\build\\ply-test-logs\\ in the VM)" >&2; exit 1; }
fi
echo "✓ built in the VM" >&2
