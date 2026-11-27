#!/usr/bin/env bash
# Self-test of the team walk's scripts, in a throwaway HOME (run by ppvp):
# seed-profile.sh and reset-profile.sh keep each identity to its own profile,
# make-member-app.sh makes one clean copy, make-instance-env.sh makes both
# identities from walk-config.sh's values (sample ones here). No app is
# started and no real gh is called: the "running" bundle is a shell loop
# naming the bundle's path, gh a script. Skipped while a real
# instance runs, since the scripts then rightly refuse; Mac only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ "$(uname)" != "Darwin" ]; then
  echo "- skipped: Mac only"
  exit 0
fi
if pgrep -f "Plyloft Test( Member)?\.app/Contents/MacOS/" >/dev/null; then
  echo "- skipped: a Plyloft Test instance is running"
  exit 0
fi
tmp="$(mktemp -d)"
sleeper=""
stop_sleeper() {
  if [ -n "$sleeper" ]; then
    pkill -P "$sleeper" 2>/dev/null || true
    kill "$sleeper" 2>/dev/null || true
    wait "$sleeper" 2>/dev/null || true
    sleeper=""
  fi
}
cleanup() { stop_sleeper; rm -rf "$tmp"; }
trap cleanup EXIT
fail=0
bad() { echo "✗ $*" >&2; fail=1; }
export HOME="$tmp/home"
unset GH_CONFIG_DIR PLY_TEST_ENV_BASE
SUPPORT="$HOME/Library/Application Support"
OWNER="$SUPPORT/com.mbadv.ply.test"
MEMBER="$SUPPORT/com.mbadv.ply.test2"
REAL="$SUPPORT/com.mbadv.ply"
mkdir -p "$tmp/project" "$tmp/member-project" "$REAL"
echo keep >"$REAL/workspaces.json"
SEED="$ROOT/scripts/app-tester/seed-profile.sh"
RESET="$ROOT/scripts/app-tester/reset-profile.sh"
MAKE="$ROOT/scripts/app-tester/make-member-app.sh"
ENVS="$ROOT/scripts/app-tester/make-instance-env.sh"

# ── seed ──
"$SEED" "$tmp/project" >/dev/null || bad "seed as the owner failed"
[ -f "$OWNER/workspaces.json" ] || bad "the owner's seed wrote no file"
[ -e "$MEMBER" ] && bad "the owner's seed touched the member"
"$SEED" "$tmp/member-project" --member member-name >/dev/null || bad "--member after the directory failed"
grep -q member-name "$MEMBER/workspaces.json" || bad "the member's seed wrote no project"
grep -q member-name "$OWNER/workspaces.json" && bad "the member's seed reached the owner"
if "$SEED" --member "$tmp/project" >/dev/null 2>&1; then bad "the owner's directory was seeded for the member"; fi
if "$SEED" "$tmp/member-project" >/dev/null 2>&1; then bad "the member's directory was seeded for the owner"; fi
if "$SEED" --membr "$tmp/project" >/dev/null 2>&1; then bad "seed accepted an unknown option"; fi
"$SEED" --member "$tmp/member-project" >/dev/null || bad "seeding the member's own directory again failed"

git -C "$tmp/member-project" init -q
git -C "$tmp/member-project" remote add origin git@github.com:o/r.git
if "$SEED" --member "$tmp/member-project" >/dev/null 2>&1; then bad "an SSH origin was seeded for the member"; fi
git -C "$tmp/member-project" remote set-url origin https://github.com/o/r.git
"$SEED" --member "$tmp/member-project" >/dev/null || bad "an HTTPS origin was refused"
git -C "$tmp/project" init -q
git -C "$tmp/project" remote add origin git@github.com:o/r.git
"$SEED" "$tmp/project" >/dev/null || bad "the owner's SSH origin should stay allowed"

# ── reset ──
if "$RESET" --membr >/dev/null 2>&1; then bad "a mistyped option was accepted"; fi
[ -d "$OWNER" ] && [ -d "$MEMBER" ] || bad "a mistyped option wiped a profile"
mkdir -p "$HOME/Library/WebKit/com.mbadv.ply.test2" "$HOME/Library/WebKit/com.mbadv.ply.test"
"$RESET" --member >/dev/null || bad "reset of the member failed"
[ -e "$MEMBER" ] && bad "the member's profile is still there"
[ -e "$HOME/Library/WebKit/com.mbadv.ply.test2" ] && bad "the member's page storage is still there"
[ -d "$OWNER" ] && [ -d "$HOME/Library/WebKit/com.mbadv.ply.test" ] || bad "the member's reset reached the owner"
"$RESET" >/dev/null || bad "reset of the owner failed"
[ -e "$OWNER" ] && bad "the owner's profile is still there"
[ "$(cat "$REAL/workspaces.json")" = keep ] || bad "the installed profile changed"

# ── make-member-app ──
BUNDLES="$tmp/bundles"
SRC="$BUNDLES/Plyloft Test.app"
mkdir -p "$SRC/Contents/MacOS"
printf '#!/bin/sh\nexit 0\n' >"$SRC/Contents/MacOS/atelier"
chmod +x "$SRC/Contents/MacOS/atelier"
/usr/bin/plutil -create xml1 "$SRC/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string com.mbadv.ply.test' \
  -c 'Add :CFBundleName string Plyloft Test' -c 'Add :CFBundleExecutable string atelier' "$SRC/Contents/Info.plist"
DEST="$BUNDLES/Plyloft Test Member.app"
for run in 1 2; do
  "$MAKE" "$SRC" >/dev/null 2>"$tmp/make.err" || { bad "make-member-app run $run failed: $(cat "$tmp/make.err")"; break; }
done
if [ -f "$DEST/Contents/Info.plist" ]; then
  [ "$(/usr/libexec/PlistBuddy -c 'Print :LSEnvironment:PLY_TEST_INSTANCE' "$DEST/Contents/Info.plist")" = member ] \
    || bad "the copy has no LSEnvironment"
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$DEST/Contents/Info.plist")" = com.mbadv.ply.test2 ] \
    || bad "the copy has the wrong id"
  codesign --verify --strict "$DEST" 2>/dev/null || bad "the copy's signature doesn't hold after the plist edit"
else
  bad "no copy was made"
fi
[ "$(ls "$BUNDLES" | wc -l | tr -d ' ')" = 2 ] || bad "copies piled up: $(ls "$BUNDLES")"
/usr/libexec/PlistBuddy -c 'Print :LSEnvironment' "$SRC/Contents/Info.plist" >/dev/null 2>&1 && bad "the owner's bundle changed"
mkdir -p "$BUNDLES/other"
cp -R "$SRC" "$BUNDLES/other/Not Plyloft.app"
if "$MAKE" "$BUNDLES/other/Not Plyloft.app" >/dev/null 2>&1; then bad "another bundle's name was accepted"; fi
rm -rf "$BUNDLES/other"

# ── running ──
for bundle in "Plyloft Test Member.app" "Plyloft Test.app"; do
  bin="$tmp/running/$bundle/Contents/MacOS/atelier"
  mkdir -p "$(dirname "$bin")"
  : >"$bin"
  # The path stays on the loop's command line, where pgrep -f looks.
  /bin/sh -c 'while :; do sleep 1; done' "$bin" 2>/dev/null &
  sleeper=$!
  sleep 0.2
  for script in "$RESET" "$SEED" "$MAKE"; do
    args=()
    [ "$script" = "$SEED" ] && args=("$tmp/project")
    [ "$script" = "$MAKE" ] && args=("$SRC")
    if "$script" ${args[@]+"${args[@]}"} >/dev/null 2>&1; then bad "$(basename "$script") ran while $bundle runs"; fi
    if [ "$script" != "$MAKE" ] && "$script" --member ${args[@]+"${args[@]}"} >/dev/null 2>&1; then
      bad "$(basename "$script") --member ran while $bundle runs"
    fi
  done
  stop_sleeper
done

# ── make-instance-env ──
mkdir -p "$tmp/bin" "$HOME/.config/gh"
cat >"$tmp/bin/gh" <<'GH'
#!/bin/sh
# Answers as the `user:` of the config it was given; a token would be a leak.
[ -z "${GH_TOKEN:-}" ] || { echo leaked; exit 0; }
case "$*" in
  'api user --jq .login') sed -n 's/^    user: //p' "$GH_CONFIG_DIR/hosts.yml" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
GH
chmod +x "$tmp/bin/gh"
# The two identities come from walk-config.sh: sample values in the
# environment, and a walk.env that doesn't exist, so this Mac's own is never read.
export PLY_WALK_ENV="$tmp/no-walk.env"
export PLY_WALK_OWNER_LOGIN=walk-owner PLY_WALK_OWNER_ID=1000001
export PLY_WALK_MEMBER_LOGIN=walk-member PLY_WALK_MEMBER_ID=1000002
printf 'github.com:\n    users:\n        walk-owner:\n        walk-member:\n    user: walk-owner\n' >"$HOME/.config/gh/hosts.yml"
echo 'version: 1' >"$HOME/.config/gh/config.yml"
for run in 1 2; do
  PATH="$tmp/bin:$PATH" GH_TOKEN=x "$ENVS" >/dev/null 2>"$tmp/env.err" || bad "make-instance-env run $run failed: $(cat "$tmp/env.err")"
done
for pair in "ply-test-owner walk-owner walk-member 1000001" "ply-test-member walk-member walk-owner 1000002"; do
  set -- $pair
  hosts="$SUPPORT/$1/gh/hosts.yml"
  grep -q "$2" "$hosts" 2>/dev/null || bad "$1 doesn't name $2"
  grep -q "$3" "$hosts" 2>/dev/null && bad "$1 also names $3"
  grep -qi token "$hosts" 2>/dev/null && bad "$1 holds a token"
  grep -q "name = $2" "$SUPPORT/$1/gitconfig" 2>/dev/null || bad "$1's git identity isn't $2"
  grep -q "email = $4+$2@users.noreply.github.com" "$SUPPORT/$1/gitconfig" 2>/dev/null || bad "$1's e-mail isn't $4+$2"
  [ "$(stat -f %Lp "$SUPPORT/$1/gh")" = 700 ] || bad "$1's gh dir is open"
done
[ "$(ls "$SUPPORT/ply-test-owner/gh" | wc -l | tr -d ' ')" = 2 ] || bad "temp files were left"
grep -q walk-member "$HOME/.config/gh/hosts.yml" || bad "gh's own config changed"
printf 'github.com:\n    users:\n        walk-owner:\n' >"$HOME/.config/gh/hosts.yml"
if PATH="$tmp/bin:$PATH" "$ENVS" >/dev/null 2>&1; then bad "a login gh doesn't have was accepted"; fi
# A value missing everywhere: one line naming it and the example, nothing made.
rm -rf "$SUPPORT/ply-test-owner" "$SUPPORT/ply-test-member"
if (unset PLY_WALK_MEMBER_ID; PATH="$tmp/bin:$PATH" "$ENVS" >/dev/null 2>"$tmp/env.err"); then bad "a missing PLY_WALK_MEMBER_ID was accepted"; fi
[ "$(wc -l <"$tmp/env.err" | tr -d ' ')" = 1 ] && grep -q "PLY_WALK_MEMBER_ID is not set.*walk.env.example" "$tmp/env.err" \
  || bad "a missing value didn't say which and where: $(cat "$tmp/env.err")"
[ -e "$SUPPORT/ply-test-owner" ] && bad "a missing value still made an env dir"
# The file: read when the environment is empty, the environment wins over it,
# and a key it doesn't know is refused.
printf '# c\n\nPLY_WALK_OWNER_LOGIN=file-owner\nexport PLY_WALK_MEMBER_LOGIN="file-member"\nPLY_TEST_VM='"'"'Some VM'"'"'\n' >"$tmp/walk.env"
got="$(env -u PLY_WALK_OWNER_LOGIN -u PLY_WALK_MEMBER_LOGIN PLY_WALK_ENV="$tmp/walk.env" PLY_WALK_MEMBER_ID=7 bash -c '. "$1/walk-config.sh"; echo "$PLY_WALK_OWNER_LOGIN|$PLY_WALK_MEMBER_LOGIN|$PLY_TEST_VM|$PLY_WALK_MEMBER_ID"' _ "$ROOT/scripts/app-tester")"
[ "$got" = "file-owner|file-member|Some VM|7" ] || bad "walk-config.sh read the file as: $got"
got="$(PLY_WALK_ENV="$tmp/walk.env" PLY_WALK_OWNER_LOGIN=env-owner sh -c '. "$1/walk-config.sh"; sh -c "echo \$PLY_WALK_OWNER_LOGIN"' _ "$ROOT/scripts/app-tester")"
[ "$got" = env-owner ] || bad "the environment didn't win over the file (or wasn't exported): $got"
echo 'PLY_WALK_OWNR_LOGIN=x' >"$tmp/typo.env"
if PLY_WALK_ENV="$tmp/typo.env" sh -c '. "$1/walk-config.sh"' _ "$ROOT/scripts/app-tester" 2>/dev/null; then bad "an unknown key in walk.env was accepted"; fi

[ "$fail" -eq 0 ] && echo "✓ the team walk's scripts keep each identity to its own profile and refuse while either runs"
exit "$fail"
