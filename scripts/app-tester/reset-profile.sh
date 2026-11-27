#!/usr/bin/env bash
# SL-0 app tester (docs/app-tester/DESIGN.md): wipes the *test* profile of
# "Plyloft Test" (com.mbadv.ply.test) so the next walk starts clean. For a
# person to run; no tool exposes it to the agent.
#
#   scripts/app-tester/reset-profile.sh [--member]
#
# --member wipes the second person of a team walk (com.mbadv.ply.test2, the
# profile of "Plyloft Test Member") instead; its gh and git identity outside
# the profile stay.
#
# Refuses any path that is not exactly the chosen test profile, any other
# argument, and refuses while either instance runs. The installed Plyloft's
# profile (com.mbadv.ply) is never touched.
set -euo pipefail
TEST_ID="com.mbadv.ply.test"
case "${1:-}" in
  "") ;;
  --member) TEST_ID="com.mbadv.ply.test2" ;;
  *) echo "✗ usage: reset-profile.sh [--member]" >&2; exit 1 ;;
esac
SUPPORT="$HOME/Library/Application Support"
TARGETS=("$SUPPORT/$TEST_ID" "$HOME/Library/Logs/$TEST_ID" "$HOME/Library/Caches/$TEST_ID" "$HOME/Library/WebKit/$TEST_ID")

if pgrep -f "Plyloft Test( Member)?\.app/Contents/MacOS/" >/dev/null; then
  echo "✗ Plyloft Test (or its Member copy) is running: quit it first" >&2
  exit 1
fi
for dir in "${TARGETS[@]}"; do
  case "$dir" in
    */com.mbadv.ply.test | */com.mbadv.ply.test2) ;;
    *) echo "✗ refusing $dir: not the test profile" >&2; exit 1 ;;
  esac
  if [ -e "$dir" ]; then
    rm -rf -- "$dir"
    echo "removed $dir"
  fi
done
echo "✓ test profile reset ($TEST_ID)"
