#!/usr/bin/env bash
# App tester on Windows (docs/app-tester/DESIGN.md, "Windows"): the *test*
# profile of Plyloft Test in the VM (%APPDATA%\com.mbadv.ply.test and
# %LOCALAPPDATA%\com.mbadv.ply.test). The installed Plyloft's profile
# (com.mbadv.ply) is never touched; both commands refuse while Plyloft Test
# runs. For people and the app-walk skill; no MCP tool exposes them.
#
#   scripts/app-tester/vm-profile.sh seed '<dir in the VM>' [name]
#   scripts/app-tester/vm-profile.sh reset
#   scripts/app-tester/vm-profile.sh status
set -euo pipefail
. "$(dirname "$0")/walk-config.sh"
VM="${PLY_TEST_VM:-Windows 11}"
HELPER="${PLY_TEST_WIN_HELPER:-C:\\ply-test\\bin\\ply-test-winhelper.exe}"
case "${1:-}" in
  seed) [ -n "${2:-}" ] || { echo "usage: vm-profile.sh seed <dir in the VM> [name]" >&2; exit 2; } ;;
  reset|status) ;;
  *) echo "usage: vm-profile.sh seed <dir> [name] | reset | status" >&2; exit 2 ;;
esac
exec prlctl exec "$VM" --current-user "$HELPER" profile "$@"
