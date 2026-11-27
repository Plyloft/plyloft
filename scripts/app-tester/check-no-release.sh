#!/usr/bin/env bash
# SL-0 app tester (docs/app-tester/DESIGN.md): the dev-only test bridge never
# reaches a release, on macOS or Windows. Source checks always; `--dist DIR`
# also scans a built frontend, `--binary FILE` a built app binary
# (`…/MacOS/atelier` or `…/release/atelier.exe`).
#
#   scripts/app-tester/check-no-release.sh [--dist dist] [--binary path/to/atelier]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
fail=0
bad() { echo "✗ $*" >&2; fail=1; }

# 1. Nothing that builds a release turns the bridge on (the Mac release is
# scripts/release.sh; every release workflow, today release-windows.yml).
for f in src-tauri/tauri.conf.json src-tauri/tauri.release.conf.json scripts/release.sh \
         scripts/install-local.sh scripts/install-local-lib.sh scripts/verify-build.sh \
         .github/workflows/release*.yml; do
  [ -f "$f" ] || continue
  if grep -n "test-bridge\|PLY_TEST_BRIDGE=1" "$f" | grep -v "check-no-release\|refuse" >/dev/null; then
    bad "$f mentions the test bridge"
  fi
done

# 2. The Cargo feature exists, is not a default, and the guards are in place.
grep -q '^test-bridge = \[\]' src-tauri/Cargo.toml || bad "Cargo.toml: test-bridge feature missing or not empty"
if awk '/^\[features\]/{f=1;next} /^\[/{f=0} f && /^default *=/' src-tauri/Cargo.toml | grep -q test-bridge; then
  bad "Cargo.toml: test-bridge is a default feature"
fi
grep -q 'feature = "test-bridge", not(debug_assertions)' src-tauri/src/lib.rs || bad "lib.rs: compile_error guard missing"
grep -q 'refusal_for_identifier' src-tauri/src/test_bridge.rs || bad "test_bridge.rs: identifier refusal missing"
# Windows: the bridge listens on loopback only, never another interface.
if grep -nE '0\.0\.0\.0|UNSPECIFIED|TcpListener::bind\("' src-tauri/src/test_bridge.rs >/dev/null; then
  bad "test_bridge.rs: the bridge may bind only 127.0.0.1"
fi
grep -q 'Ipv4Addr::LOCALHOST, 0' src-tauri/src/test_bridge.rs || bad "test_bridge.rs: loopback bind missing"
# The tester's own tools are never bundled (no externalBin, no resource).
for f in src-tauri/tauri.conf.json src-tauri/tauri.release.conf.json; do
  [ -f "$f" ] || continue
  grep -n "ply-test\|winhelper" "$f" >/dev/null && bad "$f bundles an app-tester tool"
done
grep -q 'TAURI_ENV_DEBUG !== "true"' vite.config.ts || bad "vite.config.ts: debug-only guard missing"

# A compiled vite.config.js next to vite.config.ts wins Vite's lookup and
# drops its guards (found on the v1.154.0 release: a stale one on the MacBook
# built the bridge into the release). The npm scripts name the .ts config;
# a stray file is still refused.
for stray in vite.config.js vite.config.mjs vite.config.cjs vitest.config.js; do
  [ -e "$stray" ] && bad "$stray exists next to the tracked config: delete it (it is a stale build output)"
done

# 2b. A dev-loaded plan skips the seat steps only under the bridge's own gate:
# the predicate and each use, nothing elsewhere.
seat_gate='#[cfg(all(feature = "test-bridge", debug_assertions))]'
if ! awk -v gate="$seat_gate" '/if account\.dev_plan_has_no_seats_at\(/ { n++; p=prev; gsub(/^[ \t]+/, "", p); if (p != gate) bad=1 } { prev=$0 } END { exit (bad || n != 2) }' src-tauri/src/commands.rs; then
  bad "commands.rs: the seat steps' skip must sit, twice, directly under the test-bridge gate"
fi
grep -B1 'pub fn dev_plan_has_no_seats_at' src-tauri/src/account.rs | grep -q 'cfg(all(debug_assertions, any(test, feature = "test-bridge")))' || bad "account.rs: dev_plan_has_no_seats_at must be gated"
while IFS= read -r file; do
  case "$file" in src-tauri/src/account.rs|src-tauri/src/commands.rs|src-tauri/src/test_bridge.rs) ;; *) bad "dev_plan_has_no_seats_at used in $file" ;; esac
done < <(git grep --untracked -l "dev_plan_has_no_seats_at" -- src-tauri/src || true)

# 2c. 1.176.3: the Builder screen capture writes screen text (prompts, file
# contents) into the test profile: its module and the PTY size read it uses
# sit directly under the bridge's own gate, and only the bridge starts it.
capture_gate='#[cfg(all(feature = "test-bridge", debug_assertions, any(target_os = "macos", windows)))]'
for pin in 'src-tauri/src/lib.rs:mod builder_screens_capture;' 'src-tauri/src/pty.rs:pub(crate) fn size(&self, id: &str)'; do
  file="${pin%%:*}"; line="${pin#*:}"
  prev="$(grep -B1 -F "$line" "$file" | head -1 | sed 's/^[[:space:]]*//')"
  [ "$prev" = "$capture_gate" ] || bad "$file: '$line' must sit directly under the test-bridge gate"
done
while IFS= read -r file; do
  case "$file" in src-tauri/src/test_bridge.rs|src-tauri/src/builder_screens_capture.rs) ;; *) bad "builder_screens_capture used in $file" ;; esac
done < <(git grep --untracked -l "builder_screens_capture::" -- src-tauri/src || true)

# 3. The build constant appears only where it is allowed (the ux-audit harness
#    defines it false so its browser build of the real src/ loads).
allowed='^(vite\.config\.ts|vitest\.config\.ts|src/vite-env\.d\.ts|src/main\.tsx|src/components/Terminal\.tsx|src/testBridge/|scripts/ux-audit/vite\.harness\.config\.mjs)'
while IFS= read -r file; do
  [[ "$file" =~ $allowed ]] || bad "__PLY_TEST_BRIDGE__ used in $file"
done < <(git grep --untracked -l "__PLY_TEST_BRIDGE__" -- ':!docs' ':!scripts/app-tester' || true)

MARKERS='test-bridge://|__plyTestBridge|__plyTestTerminals|bridge\.sock|bridge\.port|com\.mbadv\.ply\.test|capture\.request\.taken'
# Launch A2: the Sign-in screen's debug-only skip (account.rs) reads this
# variable only under debug_assertions; a release binary never names it.
SIGNIN_SKIP_MARKER='PLYLOFT_DEV_SKIP_SIGNIN'
while [ $# -gt 0 ]; do
  case "$1" in
    --dist)
      [ -d "$2" ] || { bad "no dist at $2"; shift 2; continue; }
      if grep -rlE "$MARKERS" "$2" >/dev/null 2>&1; then
        bad "built frontend $2 contains the test bridge: $(grep -rlE "$MARKERS" "$2" | head -3 | tr '\n' ' ')"
      fi
      if grep -rlq "$SIGNIN_SKIP_MARKER" "$2" 2>/dev/null; then
        bad "built frontend $2 names the sign-in skip ($SIGNIN_SKIP_MARKER)"
      fi
      shift 2 ;;
    --binary)
      [ -f "$2" ] || { bad "no binary at $2"; shift 2; continue; }
      # The bytes themselves, no pipe: `strings | grep -q` under pipefail
      # reported a found marker as "no match" (grep -q exits at the first
      # hit, strings dies of SIGPIPE, the pipeline fails). Self-test:
      # check-no-release.test.sh, run by ppvp.
      if LC_ALL=C grep -aqE "$MARKERS" "$2"; then
        bad "binary $2 contains the test bridge"
      fi
      if LC_ALL=C grep -aq "$SIGNIN_SKIP_MARKER" "$2"; then
        bad "binary $2 can skip the Plyloft sign-in ($SIGNIN_SKIP_MARKER)"
      fi
      shift 2 ;;
    *) bad "unknown argument $1"; shift ;;
  esac
done

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "✓ no test bridge in release paths"
