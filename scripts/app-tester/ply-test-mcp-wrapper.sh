#!/bin/sh
# Installed by scripts/app-tester/build-mcp.sh as ~/ply-build/tools/ply-test-mcp:
# the command the app-tester agent's frontmatter starts. It sets what the MCP
# forwards to Plyloft Test, then runs the real server (ply-test-mcp.bin).
#
# - The app under test: ~/ply-build/tools/ply-test-app (one line, the bundle's
#   path). Required: without it the MCP refuses to start instead of falling
#   back to an old build, whose own signature would make macOS ask for the
#   keychain password (walk of 2026-10-17).
# - The licence server: staging, or ~/ply-build/tools/ply-test-api-url (one
#   line), e.g. an unreachable URL for offline plan walks.
# - The development OAuth app (PLY_WALK_DEV_GITHUB_CLIENT_ID, from walk.env:
#   walk-config.sh, which build-mcp.sh installs beside this wrapper with a copy
#   of walk.env) and the dev entitlement key.
TOOLS="$(dirname "$0")"
. "$TOOLS/walk-config.sh"
walk_config_require PLY_WALK_DEV_GITHUB_CLIENT_ID
if [ ! -s "$TOOLS/ply-test-app" ]; then
  echo "ply-test-mcp: $TOOLS/ply-test-app is missing; write the path of the Plyloft Test.app to test into it" >&2
  exit 1
fi
PLY_TEST_APP="$(cat "$TOOLS/ply-test-app")"
export PLY_TEST_APP
PLYLOFT_API_URL=https://staging-api.plyloft.com/v1
[ -f "$TOOLS/ply-test-api-url" ] && PLYLOFT_API_URL="$(cat "$TOOLS/ply-test-api-url")"
export PLYLOFT_API_URL
PLYLOFT_GITHUB_CLIENT_ID="$PLY_WALK_DEV_GITHUB_CLIENT_ID"
export PLYLOFT_GITHUB_CLIENT_ID
if [ -f "$HOME/ply-build/launch-dev-keys/entitlement-dev.pub.hex" ]; then
  PLYLOFT_ENTITLEMENT_PUBKEY="$(cat "$HOME/ply-build/launch-dev-keys/entitlement-dev.pub.hex")"
  export PLYLOFT_ENTITLEMENT_PUBKEY
fi
exec "$TOOLS/ply-test-mcp.bin" "$@"
