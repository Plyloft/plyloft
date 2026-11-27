#!/usr/bin/env bash
#
# Contract test for scripts/release-preflight.sh. Runs the real script from a
# throwaway app repository and a throwaway site repository (git is real, local
# bare origins), with xcrun / security / gh stubs on PATH and a throwaway HOME:
# nothing here signs, notarizes, touches Apple or GitHub, or the owner's repos.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ply-preflight-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
command -v git >/dev/null || fail "git is required to run this test"
command -v jq >/dev/null || fail "jq is required to run this test"

export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="Preflight Test" GIT_AUTHOR_EMAIL="preflight@example.invalid"
export GIT_COMMITTER_NAME="Preflight Test" GIT_COMMITTER_EMAIL="preflight@example.invalid"

VERSION="9.8.7"
IDENTITY="Developer ID Application: Test Owner (TEAMID1234)"
GUIDE_REL="src/content/docs/docs/guide.md"
TODAY="$(date +%Y-%m-%d)"

FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"
# xcrun: $NOTARY_FAIL = agreement | profile makes `notarytool history` fail like Apple does.
cat >"$FAKE_BIN/xcrun" <<'STUB'
#!/usr/bin/env bash
echo "xcrun $*" >>"$CALLS"
if [[ "$1 ${2:-}" == "notarytool history" ]]; then
  case "${NOTARY_FAIL:-}" in
    agreement) echo "Error: HTTP status code: 403. A required agreement is missing or has expired. This request requires an in-effect agreement." >&2; exit 1 ;;
    profile) echo "Error: No Keychain password item found for profile: ply-notary" >&2; exit 1 ;;
  esac
fi
exit 0
STUB
printf '#!/usr/bin/env bash\necho "  1) ABCDEF \\"%s\\""\n' "$IDENTITY" >"$FAKE_BIN/security"
printf '#!/usr/bin/env bash\nexit 0\n' >"$FAKE_BIN/gh"
chmod +x "$FAKE_BIN"/*

# A fake highlights module: the real one's shape for what the preflight reads.
write_highlights() { # date
  cat >"$APP/src/lib/releaseHighlights.ts" <<TS
export const RELEASE_HIGHLIGHTS = [
  {
    version: "$VERSION",
    date: "$1",
    title: "The test release",
    points: [{ text: "First point." }, { text: "Second point." }],
  },
];
export function highlightsFor(version: string) {
  return RELEASE_HIGHLIGHTS.find((r) => r.version === version) ?? null;
}
TS
}

# make_env name → APP, SITE, HOME_DIR; everything passes.
make_env() {
  local name="$1"
  APP="$TEST_ROOT/$name/app"; SITE="$TEST_ROOT/$name/site"; HOME_DIR="$TEST_ROOT/$name/home"
  mkdir -p "$APP/scripts/lib" "$APP/docs/onboarding" "$APP/src/lib" "$APP/src-tauri" "$APP/node_modules" \
    "$SITE/src/content/docs/docs" "$SITE/src/data" "$HOME_DIR/.tauri"
  cp "$SCRIPT_DIR/release-preflight.sh" "$SCRIPT_DIR/site-guide.mjs" "$APP/scripts/"
  cp "$SCRIPT_DIR/lib/release-checks.sh" "$APP/scripts/lib/"
  printf '#!/usr/bin/env bash\necho "  ✓ Sign-in configuration filled in (stub)"\n' >"$APP/scripts/check-account-config.sh"
  chmod +x "$APP/scripts/check-account-config.sh"
  printf '{"version":"%s"}\n' "$VERSION" >"$APP/package.json"
  printf '{"productName":"Plyloft","version":"%s"}\n' "$VERSION" >"$APP/src-tauri/tauri.conf.json"
  printf '[package]\nname = "atelier"\nversion = "%s"\n' "$VERSION" >"$APP/src-tauri/Cargo.toml"
  jq -n --arg id "$IDENTITY" '{bundle:{macOS:{signingIdentity:$id}}}' >"$APP/src-tauri/tauri.release.conf.json"
  printf '{"packages":{"":{},"node_modules/left-pad":{"version":"1.3.0"},"node_modules/fsevents":{"version":"2.0.0","optional":true}}}\n' >"$APP/package-lock.json"
  printf '{"packages":{"node_modules/left-pad":{"version":"1.3.0"}}}\n' >"$APP/node_modules/.package-lock.json"
  printf '# Guide\n\nHello.\n' >"$APP/docs/onboarding/USER_GUIDE.md"
  write_highlights "$TODAY"
  printf 'node_modules/\n' >"$APP/.gitignore"
  printf '{"name":"site"}\n' >"$SITE/package.json"
  printf 'old\n' >"$SITE/src/data/releases.ts"
  node "$APP/scripts/site-guide.mjs" --write --guide "$APP/docs/onboarding/USER_GUIDE.md" --out "$SITE/$GUIDE_REL" >/dev/null
  echo key >"$HOME_DIR/.tauri/ply.key"
  for r in "$APP" "$SITE"; do
    git init -q -b main "$r"; git -C "$r" add -A; git -C "$r" commit -q -m "initial"
    git init -q --bare -b main "$r.git"; git -C "$r" remote add origin "$r.git"; git -C "$r" push -q origin main
  done
  CALLS="$TEST_ROOT/$name/calls.log"; : >"$CALLS"; export CALLS
}
run_pre() {
  RC=0
  OUT="$(cd "$APP" && PATH="$FAKE_BIN:$PATH" HOME="$HOME_DIR" PLY_SITE_REPO="$SITE" ./scripts/release-preflight.sh 2>&1)" || RC=$?
}
has() { grep -Fq -- "$1" <<<"$OUT" || fail "no \"$1\" in: $OUT"; }
hasnt() { grep -Fq -- "$1" <<<"$OUT" && fail "unexpected \"$1\" in: $OUT" || true; }
expect_fail() { # what, text…  → exit 1, a ✗, and the texts
  local what="$1"; shift
  [[ "$RC" == 1 ]] || fail "$what: exit $RC: $OUT"
  has "✗"
  local t; for t in "$@"; do has "$t"; done
  hasnt "RELEASE_NOTES=\"\$(cat"
}
# ./scripts/release.sh as the closing line: only on a pass.
NOTES_LINE='RELEASE_NOTES="$(cat '

# 1. Everything good: exit 0, every check ✓, the one-line command, a notes file.
make_env good; run_pre
[[ "$RC" == 0 ]] || fail "a clean setup failed: $OUT"
hasnt "✗"
for t in "On main" "Equal to origin/main" "Clean working tree" "Version files agree: $VERSION" "node_modules matches package-lock.json" \
  "No stale changelog draft" "main equal to origin/main" "The site's copy of the user guide matches HEAD's" \
  "dated today" "identity present" "Updater private key present" "notarytool profile 'ply-notary' valid"; do has "$t"; done
notes="$HOME_DIR/.plyloft-release-notes-$VERSION.txt"
[[ -f "$notes" ]] && grep -Fq "Plyloft $VERSION: The test release" "$notes" && grep -Fq -- "- Second point." "$notes" || fail "notes draft missing or wrong: $(cat "$notes" 2>/dev/null)"
last="$(grep -F "$NOTES_LINE" <<<"$OUT")"
[[ "$last" == "RELEASE_NOTES=\"\$(cat $notes)\" ./scripts/release.sh" ]] || fail "the release line is not the one-line file form: $last"
[[ "$(grep -c '^RELEASE_NOTES=' <<<"$OUT")" == 1 ]] || fail "more than one release line"
pass "a clean setup: all ✓, a notes draft from the highlights, the release line in one piece"

# 2. An edited notes file is kept; a path with a quote still gives one safe line.
printf 'My own words, with "quotes" and $dollars and a\nsecond line.\n' >"$notes"
run_pre; [[ "$RC" == 0 ]] || fail "$OUT"
grep -Fq 'My own words, with "quotes" and $dollars and a' "$notes" || fail "the edited notes were overwritten"
has "already there: kept as it is"
pass "an edited notes file is kept; its words never reach the command line"

# 2b. A notes path with an apostrophe or a space still gives one line that /bin/bash
#     (3.2 on macOS) runs: evaluated with release.sh swapped for a printer, it
#     yields the file's words.
for odd in "it's here" "with space" "q\"uote"; do
  make_env "odd-${odd// /_}"; export PLY_RELEASE_NOTES_FILE="$HOME_DIR/$odd.txt"
  run_pre; [[ "$RC" == 0 ]] || fail "$odd: $OUT"
  line="$(grep '^RELEASE_NOTES=' <<<"$OUT")"
  [[ "$(grep -c '^RELEASE_NOTES=' <<<"$OUT")" == 1 ]] || fail "$odd: not exactly one release line"
  got="$(cd "$TEST_ROOT" && /bin/bash -c "${line/.\/scripts\/release.sh/printenv RELEASE_NOTES}" 2>&1)" || fail "$odd: the line does not run: $got"
  [[ "$got" == "$(<"$PLY_RELEASE_NOTES_FILE")" ]] || fail "$odd: the line gave '$got'"
  unset PLY_RELEASE_NOTES_FILE
done
pass "a notes path with an apostrophe, a space or a double quote: the printed line runs under /bin/bash and yields the notes"

# 3. The stale changelog draft: named, with both commands, never discarded.
make_env draft; echo "draft" >>"$SITE/src/data/releases.ts"; run_pre
expect_fail "stale draft" "src/data/releases.ts has uncommitted changes" "cp \"$SITE/src/data/releases.ts\"" "git -C \"$SITE\" checkout -- src/data/releases.ts"
grep -q draft "$SITE/src/data/releases.ts" || fail "the preflight discarded the draft itself"
pass "a stale releases.ts draft: ✗ naming the file and the two commands, left in place, no release line"

# 4. The site behind or ahead of origin/main.
make_env sitebehind; git clone -q "$SITE.git" "$TEST_ROOT/o1"; git -C "$TEST_ROOT/o1" commit -q --allow-empty -m n; git -C "$TEST_ROOT/o1" push -q origin main
run_pre; expect_fail "site behind" "1 commit(s) behind origin/main" "pull --ff-only"
make_env siteahead; git -C "$SITE" commit -q --allow-empty -m local; run_pre
expect_fail "site ahead" "1 commit(s) not on origin/main" "release-site-step.sh"
pass "the site's main behind or ahead of origin/main: ✗ with its fix"

# 5. The guide: HEAD's guide moved on, the site's copy did not.
make_env guide; printf '# Guide\n\nChanged.\n' >"$APP/docs/onboarding/USER_GUIDE.md"; git -C "$APP" commit -q -am g; git -C "$APP" push -q origin main
run_pre; expect_fail "guide changed" "user guide check would stop" "has no copy of this commit's user guide"
pass "a guide changed since the site's copy: ✗ from release.sh's own check"

# 6. Apple: the 403 agreement answer and a missing profile.
make_env agree; NOTARY_FAIL=agreement; export NOTARY_FAIL; run_pre
expect_fail "agreement 403" "Apple does not accept the notary profile" "HTTP status code: 403" "unaccepted/expired legal agreement" "developer.apple.com/account"
NOTARY_FAIL=profile; run_pre
expect_fail "missing profile" "No Keychain password item" "xcrun notarytool store-credentials"
unset NOTARY_FAIL
pass "Apple's 403 agreement answer and a missing profile: ✗ with the fix text"

# 7. The highlights' date: only a ⚠, naming file and line.
make_env date; write_highlights "2020-01-02"; git -C "$APP" commit -q -am h; git -C "$APP" push -q origin main; run_pre
[[ "$RC" == 0 ]] || fail "a date mismatch failed the preflight: $OUT"
has "⚠ $VERSION's highlights are dated 2020-01-02, today is $TODAY (src/lib/releaseHighlights.ts:4)"
has "RELEASE_NOTES="
pass "a highlights date that is not today: a ⚠ naming the file and line, the preflight still passes"

# 8. The app repo: dirty, not on main, behind, versions disagree, node_modules stale.
make_env dirty; echo x >"$APP/untracked.txt"; run_pre; expect_fail "dirty" "Uncommitted changes"
make_env topic; git -C "$APP" checkout -q -b topic; run_pre; expect_fail "branch" "On 'topic', not main"
make_env behind; git clone -q "$APP.git" "$TEST_ROOT/o2"; git -C "$TEST_ROOT/o2" commit -q --allow-empty -m n; git -C "$TEST_ROOT/o2" push -q origin main
run_pre; expect_fail "behind" "Behind origin/main" "git pull --ff-only"
make_env versions; sed -i '' 's/"version":"'"$VERSION"'"/"version":"9.8.8"/' "$APP/src-tauri/tauri.conf.json"; git -C "$APP" commit -q -am v; git -C "$APP" push -q origin main
run_pre; expect_fail "versions" "Version files disagree" "tauri.conf.json: 9.8.8"
make_env nm; printf '{"packages":{"node_modules/left-pad":{"version":"1.2.0"},"node_modules/extra":{"version":"1.0.0"}}}\n' >"$APP/node_modules/.package-lock.json"
run_pre; expect_fail "node_modules" "node_modules does not match package-lock.json" "left-pad: installed 1.2.0, lockfile 1.3.0" "not in the lockfile: node_modules/extra" "Fix: npm ci"
make_env nonm; rm "$APP/node_modules/.package-lock.json"; run_pre; expect_fail "no node_modules" "Fix: npm ci"
pass "app dirty / off main / behind, version files apart, node_modules stale or absent: each a ✗ with one fix"

# 9. Signing material missing: ✗ each.
make_env nokey; rm "$HOME_DIR/.tauri/ply.key"; run_pre; expect_fail "no key" "Updater private key not found"
pass "a missing updater key: ✗"

echo "release-preflight contract: all checks passed"
