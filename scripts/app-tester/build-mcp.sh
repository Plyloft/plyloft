#!/usr/bin/env bash
# SL-0 app tester (docs/app-tester/DESIGN.md): builds ply-test-mcp (the MCP
# server the app-tester agent declares in its own frontmatter) and installs
# it at ~/ply-build/tools/ply-test-mcp.bin, behind the wrapper
# ply-test-mcp (scripts/app-tester/ply-test-mcp-wrapper.sh), which reads the
# app under test from ~/ply-build/tools/ply-test-app and the walk's
# configuration from the walk.env copied beside it. Dev tooling; never bundled.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="${PLY_TEST_TOOLS_DIR:-$HOME/ply-build/tools}"
: "${CARGO_TARGET_DIR:?set CARGO_TARGET_DIR to the target dir of this lane (e.g. ~/ply-build/sl0)}"
cargo build --release --manifest-path "$ROOT/tools/ply-test-mcp/Cargo.toml" >&2
mkdir -p "$TOOLS"
# The binary goes beside the wrapper, never over it (2026-10-17: installing it
# as ply-test-mcp dropped the wrapper, the tester fell back to an old build and
# macOS asked for the keychain password).
install -m 0755 "$CARGO_TARGET_DIR/release/ply-test-mcp" "$TOOLS/ply-test-mcp.bin.tmp"
mv "$TOOLS/ply-test-mcp.bin.tmp" "$TOOLS/ply-test-mcp.bin"
# The wrapper reads its configuration beside itself: walk-config.sh and a copy
# of walk.env (PLY_WALK_ENV or scripts/app-tester/walk.env), installed first.
install -m 0644 "$ROOT/scripts/app-tester/walk-config.sh" "$TOOLS/walk-config.sh.tmp"
mv "$TOOLS/walk-config.sh.tmp" "$TOOLS/walk-config.sh"
WALK_ENV="${PLY_WALK_ENV:-$ROOT/scripts/app-tester/walk.env}"
if [ -f "$WALK_ENV" ]; then
  install -m 0600 "$WALK_ENV" "$TOOLS/walk.env.tmp"
  mv "$TOOLS/walk.env.tmp" "$TOOLS/walk.env"
else
  echo "build-mcp: no $WALK_ENV: copy scripts/app-tester/walk.env.example to it and fill it in, then run this again (the wrapper refuses to start without PLY_WALK_DEV_GITHUB_CLIENT_ID)" >&2
fi
install -m 0755 "$ROOT/scripts/app-tester/ply-test-mcp-wrapper.sh" "$TOOLS/ply-test-mcp.tmp"
mv "$TOOLS/ply-test-mcp.tmp" "$TOOLS/ply-test-mcp"
[ -s "$TOOLS/ply-test-app" ] || echo "build-mcp: write the Plyloft Test.app path into $TOOLS/ply-test-app" >&2
"$TOOLS/ply-test-mcp.bin" --version
