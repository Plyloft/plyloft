#!/usr/bin/env bash
#
# Contract test for scripts/release-site-step.sh. Runs the real script from
# throwaway app and site repositories (git is real, each with a local bare
# origin) with npm / npx stubs on PATH: nothing here builds the real site,
# touches GitHub or pushes anywhere but those bare repositories.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ply-site-step-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
command -v git >/dev/null || fail "git is required to run this test"

export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="Site Step Test" GIT_AUTHOR_EMAIL="site-step@example.invalid"
export GIT_COMMITTER_NAME="Site Step Test" GIT_COMMITTER_EMAIL="site-step@example.invalid"

VERSION="9.8.7"
GUIDE_REL="src/content/docs/docs/guide.md"

# npm / npx stubs: every call is logged. `npm run lastmod` writes $LASTMOD_VALUE
# into src/data/lastmod.json; `npm run check:seo` fails when $SEO_FAIL is set.
FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/npm" <<'STUB'
#!/usr/bin/env bash
echo "npm $*" >>"$CALLS"
case "$*" in
  *lastmod*) mkdir -p src/data; printf '{"/":"%s"}\n' "${LASTMOD_VALUE:-v1}" >src/data/lastmod.json ;;
  *check:seo*) [[ -z "${SEO_FAIL:-}" ]] || { echo "SEO: missing canonical" >&2; exit 1; } ;;
esac
STUB
cat >"$FAKE_BIN/npx" <<'STUB'
#!/usr/bin/env bash
echo "npx $*" >>"$CALLS"
STUB
chmod +x "$FAKE_BIN/npm" "$FAKE_BIN/npx"

# make_env name → sets APP and SITE: both on main, pushed to their bare origins.
make_env() {
  local name="$1"
  APP="$TEST_ROOT/$name/app"; SITE="$TEST_ROOT/$name/site"
  mkdir -p "$APP/scripts" "$APP/docs/onboarding" "$SITE/src/content/docs/docs" "$SITE/src/data"
  cp "$SCRIPT_DIR/release-site-step.sh" "$SCRIPT_DIR/site-guide.mjs" "$APP/scripts/"
  printf '{"version":"%s"}\n' "$VERSION" >"$APP/package.json"
  printf '# Guide\n\nHello.\n' >"$APP/docs/onboarding/USER_GUIDE.md"
  printf '{"name":"site"}\n' >"$SITE/package.json"
  printf 'old\n' >"$SITE/src/data/releases.ts"
  printf '{"/":"v0"}\n' >"$SITE/src/data/lastmod.json"
  printf 'readme\n' >"$SITE/README.md"
  node "$APP/scripts/site-guide.mjs" --write --guide "$APP/docs/onboarding/USER_GUIDE.md" --out "$SITE/$GUIDE_REL" >/dev/null
  for r in "$APP" "$SITE"; do
    git init -q -b main "$r"; git -C "$r" add -A; git -C "$r" commit -q -m "initial"
    git init -q --bare -b main "$r.git"; git -C "$r" remote add origin "$r.git"; git -C "$r" push -q origin main
  done
  CALLS="$TEST_ROOT/$name/calls.log"; : >"$CALLS"; export CALLS
}
# change_guide: HEAD's guide moves on (pushed), so the site's copy is stale.
change_guide() {
  printf '# Guide\n\nHello, again.\n' >"$APP/docs/onboarding/USER_GUIDE.md"
  git -C "$APP" commit -q -am "guide"; git -C "$APP" push -q origin main
}
run_step() { # args…  (output in $OUT, exit code in $RC)
  RC=0
  OUT="$(cd "$APP" && PATH="$FAKE_BIN:$PATH" PLY_SITE_REPO="$SITE" ./scripts/release-site-step.sh "$@" 2>&1)" || RC=$?
}
site_head() { git -C "$SITE" rev-parse HEAD; }
origin_head() { git --git-dir="$SITE.git" rev-parse main; }
PUSH_LINE="cd $TEST_ROOT"

# 1. --check: says what it would do, changes nothing, runs nothing.
make_env check; change_guide; before="$(site_head)"
run_step --check
[[ "$RC" == 0 ]] || fail "--check failed: $OUT"
grep -Fq 'will be rewritten and committed as "User guide for 9.8.7"' <<<"$OUT" || fail "--check does not say the guide changes: $OUT"
grep -Fq "Would not push" <<<"$OUT" || fail "--check does not say it would not push: $OUT"
[[ "$(site_head)" == "$before" && -z "$(git -C "$SITE" status --porcelain)" ]] || fail "--check changed the site"
[[ ! -s "$CALLS" ]] || fail "--check ran npm or npx: $(<"$CALLS")"
pass "--check says what it would do and changes nothing"

# 2. The real run: two commits with exactly the two files, unrelated files untouched, no push.
make_env run; change_guide
printf 'edited\n' >>"$SITE/README.md"; printf 'scratch\n' >"$SITE/notes.txt"; printf 'draft\n' >>"$SITE/src/data/releases.ts"
before_origin="$(origin_head)"
run_step
[[ "$RC" == 0 ]] || fail "the run failed: $OUT"
[[ "$(git -C "$SITE" log -1 --format=%s)" == "lastmod for $VERSION" ]] || fail "last commit is not the lastmod one: $(git -C "$SITE" log --oneline -3)"
[[ "$(git -C "$SITE" log -2 --format=%s | tail -1)" == "User guide for $VERSION" ]] || fail "no guide commit"
[[ "$(git -C "$SITE" show --name-only --format= HEAD)" == "src/data/lastmod.json" ]] || fail "lastmod commit holds more than lastmod.json"
[[ "$(git -C "$SITE" show --name-only --format= HEAD~1)" == "$GUIDE_REL" ]] || fail "guide commit holds more than the guide"
grep -q "Hello, again" "$SITE/$GUIDE_REL" || fail "the guide page was not rewritten from HEAD's guide"
st="$(git -C "$SITE" status --porcelain | sort)"
[[ "$st" == " M README.md
 M src/data/releases.ts
?? notes.txt" ]] || fail "unrelated files were staged, committed or lost: $st"
[[ "$(origin_head)" == "$before_origin" ]] || fail "the run pushed"
grep -Fq "npx astro build" "$CALLS" && grep -Fq "npm run check:seo" "$CALLS" || fail "build or SEO check not run: $(<"$CALLS")"
grep -Fq "  cd $SITE && git push origin main" <<<"$OUT" || fail "the push line is not printed exactly: $OUT"
grep -Fq "This push sends" <<<"$OUT" && grep -Fq "lastmod for $VERSION" <<<"$OUT" && grep -Fq "User guide for $VERSION" <<<"$OUT" || fail "the commits the push sends are not listed: $OUT"
grep -Fq "2 commit(s)" <<<"$OUT" || fail "what to expect is not said: $OUT"
pass "two commits holding only the guide and lastmod.json; unrelated files untouched; nothing pushed; the push line printed"

# 3. Idempotent: again before the push, then after it.
: >"$CALLS"; head1="$(site_head)"
run_step
[[ "$RC" == 0 && "$(site_head)" == "$head1" ]] || fail "a second run changed something: $OUT"
grep -Fq "Nothing to do here" <<<"$OUT" || fail "second run does not say there is nothing to do: $OUT"
grep -Fq "git push origin main" <<<"$OUT" || fail "second run forgot the unpushed commits"
grep -Eq 'npx|check:seo' "$CALLS" && fail "second run built again: $(<"$CALLS")"
git -C "$SITE" push -q origin main
run_step
[[ "$RC" == 0 ]] && grep -Fq "Nothing to do: the site already has $VERSION's guide" <<<"$OUT" || fail "after the push: $OUT"
grep -Fq "git push" <<<"$OUT" && fail "nothing pushed yet it asks to push"
pass "a second run says there is nothing to do (and still names an unpushed push), then nothing at all after the push"

# 3b. A later run on another clock (lastmod would now give other dates): still nothing to do.
make_env clock; change_guide; run_step; [[ "$RC" == 0 ]] || fail "$OUT"
: >"$CALLS"; head1="$(site_head)"; export LASTMOD_VALUE=v-other-day
run_step; unset LASTMOD_VALUE
[[ "$RC" == 0 && "$(site_head)" == "$head1" ]] || fail "a run on another day made a commit: $OUT"
grep -Fq "Nothing to do here" <<<"$OUT" || fail "no 'nothing to do' on another day: $OUT"
grep -q lastmod "$CALLS" && fail "lastmod ran again: $(<"$CALLS")"
[[ -z "$(git -C "$SITE" status --porcelain -- src/data/lastmod.json)" ]] || fail "lastmod.json was left changed"
pass "once \"lastmod for $VERSION\" exists, a run with other dates is still nothing to do"

# 3c. A path with a space: the push line is quoted so it pastes, a plain one stays plain (3 above).
make_env "sp ace"; change_guide; run_step; [[ "$RC" == 0 ]] || fail "$OUT"
printf -v q '%q' "$SITE"
grep -Fq "  cd $q && git push origin main" <<<"$OUT" || fail "the push line is not quoted: $OUT"
[[ "$q" != "$SITE" ]] || fail "the space was not escaped in $q"
pass "a site path with a space: the push line is quoted"

# 4. Guide current, lastmod moved: one commit, the lastmod one.
make_env lastmod; export LASTMOD_VALUE=v2
run_step; unset LASTMOD_VALUE
[[ "$RC" == 0 ]] || fail "$OUT"
[[ "$(git -C "$SITE" rev-list --count origin/main..HEAD)" == 1 && "$(git -C "$SITE" log -1 --format=%s)" == "lastmod for $VERSION" ]] ||
  fail "expected exactly the lastmod commit: $(git -C "$SITE" log --oneline -3)"
pass "an unchanged guide makes no guide commit"

# 5. Refusals, each before anything is written.
expect_refused() { # what, text
  [[ "$RC" == 1 ]] || fail "$1: exit $RC: $OUT"
  grep -Fq "$2" <<<"$OUT" || fail "$1: no \"$2\" in: $OUT"
  grep -Fq "Nothing was changed" <<<"$OUT" || fail "$1: no 'Nothing was changed'"
  [[ ! -s "$CALLS" ]] || fail "$1: ran npm/npx: $(<"$CALLS")"
}
make_env dirty; echo x >>"$APP/package.json"; run_step; expect_refused "app dirty" "uncommitted changes"
make_env nomain; git -C "$APP" checkout -q -b topic; run_step; expect_refused "app not on main" "is on 'topic', not main"
make_env appbehind; git clone -q "$APP.git" "$TEST_ROOT/other-app"; git -C "$TEST_ROOT/other-app" commit -q --allow-empty -m next; git -C "$TEST_ROOT/other-app" push -q origin main
run_step; expect_refused "app behind" "behind origin/main"
make_env appahead; git -C "$APP" commit -q --allow-empty -m local; run_step; expect_refused "app ahead" "not origin/main"
make_env sitebranch; git -C "$SITE" checkout -q -b topic; run_step; expect_refused "site not on main" "site repo is on 'topic'"
make_env sitebehind; git clone -q "$SITE.git" "$TEST_ROOT/other-site"; git -C "$TEST_ROOT/other-site" commit -q --allow-empty -m next; git -C "$TEST_ROOT/other-site" push -q origin main
run_step; expect_refused "site behind" "behind origin/main"
make_env guidedirty; echo x >>"$SITE/$GUIDE_REL"; run_step; expect_refused "guide edited by hand" "uncommitted changes in $GUIDE_REL"
make_env noguide; git -C "$APP" rm -q docs/onboarding/USER_GUIDE.md; git -C "$APP" commit -q -m "no guide"; git -C "$APP" push -q origin main
run_step; expect_refused "no guide at HEAD" "no docs/onboarding/USER_GUIDE.md"
pass "refused, with the fix and nothing written: app dirty / not main / behind / ahead, site not main / behind / guide edited, no guide"

# 5b. A commit git refuses (a commit-msg hook stands in for an unfinished merge).
hook() { printf '#!/usr/bin/env bash\ngrep -q "^%s" "$1" && { echo "refused by test hook" >&2; exit 1; }\nexit 0\n' "$1" >"$SITE/.git/hooks/commit-msg"; chmod +x "$SITE/.git/hooks/commit-msg"; }
make_env refuse2; change_guide; hook "lastmod"; before="$(site_head)"
run_step
[[ "$RC" == 1 ]] || fail "a refused second commit did not fail: $OUT"
grep -Fq "git would not commit \"lastmod for $VERSION\"" <<<"$OUT" && grep -Fq "Already committed in the site repo: \"User guide for $VERSION\"" <<<"$OUT" && grep -Fq "Do not push yet" <<<"$OUT" || fail "the partial commit is not said plainly: $OUT"
[[ "$(git -C "$SITE" log -1 --format=%s)" == "User guide for $VERSION" && -z "$(git -C "$SITE" status --porcelain -- src/data/lastmod.json)" ]] || fail "state after a refused second commit is wrong: $(git -C "$SITE" log --oneline -3; git -C "$SITE" status --porcelain; echo "$OUT")"
rm "$SITE/.git/hooks/commit-msg"; run_step
[[ "$RC" == 0 && "$(git -C "$SITE" log -1 --format=%s)" == "lastmod for $VERSION" ]] || fail "the run after the fix did not finish the job: $OUT"
make_env refuse1; change_guide; hook "User guide"; before="$(site_head)"
run_step
[[ "$RC" == 1 && "$(site_head)" == "$before" && -z "$(git -C "$SITE" status --porcelain)" ]] || fail "a refused first commit left changes: $OUT"
grep -Fq "Nothing was committed" <<<"$OUT" || fail "$OUT"
pass "a refused commit: said plainly (partial or none), files put back, the next run finishes the job"

# 6. A failing SEO check: nothing committed, the two files put back.
make_env seo; change_guide; before="$(site_head)"
export SEO_FAIL=1; run_step; unset SEO_FAIL
[[ "$RC" == 1 ]] && grep -Fq "SEO check failed" <<<"$OUT" || fail "a failing SEO check did not stop the run: $OUT"
[[ "$(site_head)" == "$before" && -z "$(git -C "$SITE" status --porcelain)" ]] || fail "a failed run left changes: $(git -C "$SITE" status --porcelain)"
pass "a failing SEO check: nothing committed, the guide page put back"

echo "release-site-step contract: all checks passed"
