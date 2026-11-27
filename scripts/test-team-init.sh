#!/usr/bin/env bash
#
# Contract test for scripts/team-init.sh (v1.114.0, team sharing rung 1).
#
# The script creates a real GitHub repository, so the test replaces `gh`
# with a fake on PATH that serves a local bare repo. Nothing here touches
# the network or the developer's GitHub account.
#
# The case that matters most is a run with NO --member: under `set -e` plus
# `pipefail`, an empty member array used to leave a non-zero status that
# abandoned the run *after* `gh repo create` had already succeeded, leaving
# an empty team repo that the existence check then refused to retry into.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v jq >/dev/null || fail "jq is required to run this test"

# ── The fake gh ──────────────────────────────────────────────────────────
# Serves one owner login, one "current repo", and a bare repo per created
# slug under $GH_REMOTES. Anything it is not asked to do fails loudly.
FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
case "$1 ${2:-}" in
  "auth status") exit 0 ;;
  "api user")    echo "$GH_LOGIN"; exit 0 ;;
  "repo view")
    if [[ "${3:-}" == "--json" ]]; then echo "$GH_CURRENT_REPO"; exit 0; fi
    # `gh repo view <slug>`: exists only once created.
    [[ -d "$GH_REMOTES/${3//\//__}.git" ]] || exit 1
    exit 0 ;;
  "repo create")
    slug="$3"
    mkdir -p "$GH_REMOTES"
    git init -q --bare "$GH_REMOTES/${slug//\//__}.git"
    exit 0 ;;
  "repo clone")
    slug="$3"; dest="$4"
    git clone -q "$GH_REMOTES/${slug//\//__}.git" "$dest"
    exit 0 ;;
esac
echo "fake gh: unexpected invocation: $*" >&2
exit 64
GH
chmod +x "$FAKE_BIN/gh"

export GH_LOGIN="MatteoB-adv"
export GH_CURRENT_REPO="MatteoB-adv/atelier"
export GH_REMOTES="$TEST_ROOT/remotes"
export PATH="$FAKE_BIN:$PATH"

manifest_of() { # slug → team.json as pushed
  git -C "$GH_REMOTES/${1//\//__}.git" show HEAD:team.json
}

# ── Case 1: no --member, no --workspace (the zero-argument owner path) ────
echo "── team-init with no members"
OUT="$TEST_ROOT/no-members.out"
( cd "$ROOT" && bash scripts/team-init.sh --name "MB Adv" ) > "$OUT" 2>&1 ||
  fail "team-init.sh exited $? with no --member (see $OUT)$(printf '\n'; cat "$OUT")"

SLUG="MatteoB-adv/mb-adv-team"
tail -1 "$OUT" | grep -qx "$SLUG" ||
  fail "the --team-repo value is not the last line of the output"
grep -q "Finish creating your team" "$OUT" ||
  fail "the step that attaches the team to the plan was not printed"
! grep -q "issue-license" "$OUT" ||
  fail "team keys are retired: no key-minting command may be printed"

MANIFEST="$(manifest_of "$SLUG")"
[[ "$(jq -r '.schemaVersion' <<<"$MANIFEST")" == "1" ]] || fail "schemaVersion"
[[ "$(jq -r '.name' <<<"$MANIFEST")" == "MB Adv" ]] || fail "team name"
[[ "$(jq -r '.members | length' <<<"$MANIFEST")" == "1" ]] ||
  fail "a run with no --member must still list the owner"
[[ "$(jq -r '.members[0].login' <<<"$MANIFEST")" == "$GH_LOGIN" ]] || fail "owner login"
[[ "$(jq -r '.members[0].owner' <<<"$MANIFEST")" == "true" ]] || fail "owner flag"
[[ "$(jq -r '.workspaces[0].repo' <<<"$MANIFEST")" == "$GH_CURRENT_REPO" ]] ||
  fail "the current repo must become the default team workspace"
git -C "$GH_REMOTES/${SLUG//\//__}.git" ls-tree -r --name-only HEAD |
  grep -q '^library/knowledge/.gitkeep$' || fail "the empty library was not pushed"
pass "manifest, library and printed --team-repo value with no --member"

# ── Case 2: explicit members and workspaces ──────────────────────────────
echo "── team-init with members and workspaces"
OUT2="$TEST_ROOT/members.out"
( cd "$ROOT" && bash scripts/team-init.sh --name "Second Team" \
    --repo "MatteoB-adv/second" --member minidev --member thirddev \
    --workspace "MatteoB-adv/atelier" --workspace "MatteoB-adv/tools" ) > "$OUT2" 2>&1 ||
  fail "team-init.sh exited $? with members (see $OUT2)$(printf '\n'; cat "$OUT2")"

M2="$(manifest_of "MatteoB-adv/second")"
[[ "$(jq -r '.members | length' <<<"$M2")" == "3" ]] || fail "owner + 2 members"
[[ "$(jq -r '.members[0].owner' <<<"$M2")" == "true" ]] || fail "owner sorts first"
[[ "$(jq -r '[.members[] | select(.owner)] | length' <<<"$M2")" == "1" ]] ||
  fail "exactly one owner"
[[ "$(jq -r '.workspaces | length' <<<"$M2")" == "2" ]] || fail "both workspaces"
grep -q "collaborators/minidev" "$OUT2" || fail "the invite line for a member is missing"
pass "members, workspaces and the printed invite lines"

# ── Case 3: an existing team repo is refused, not overwritten ─────────────
echo "── team-init against an existing team repo"
if ( cd "$ROOT" && bash scripts/team-init.sh --name "MB Adv" ) > "$TEST_ROOT/again.out" 2>&1; then
  fail "re-running against an existing team repo must refuse"
fi
grep -q "already exists" "$TEST_ROOT/again.out" || fail "the refusal must say why"
[[ "$(manifest_of "$SLUG" | jq -r '.name')" == "MB Adv" ]] ||
  fail "the existing manifest must be untouched"
pass "an existing team repo is refused and its manifest untouched"

# ── Case 5 (F6): a name already ending in "team" is not doubled ─────────
echo "── team-init with a name that ends in team"
( cd "$ROOT" && bash scripts/team-init.sh --name "Plyloft test team" ) > "$TEST_ROOT/f6.out" 2>&1 ||
  fail "team-init.sh exited $? for \"Plyloft test team\" (see $TEST_ROOT/f6.out)$(printf '\n'; cat "$TEST_ROOT/f6.out")"
[[ -d "$GH_REMOTES/MatteoB-adv__plyloft-test-team.git" ]] ||
  fail "the default repo for \"Plyloft test team\" must be MatteoB-adv/plyloft-test-team"
[[ ! -d "$GH_REMOTES/MatteoB-adv__plyloft-test-team-team.git" ]] || fail "\"team\" was doubled"
pass "a name ending in team keeps it once"

# ── Case 4: bad input is refused before anything is created ──────────────
echo "── team-init input validation"
if ( cd "$ROOT" && bash scripts/team-init.sh --name "Bad" --repo "not-a-slug" ) \
     > "$TEST_ROOT/bad.out" 2>&1; then
  fail "--repo without owner/name must be refused"
fi
if ( cd "$ROOT" && bash scripts/team-init.sh --name "Bad" --repo "MatteoB-adv/ok" \
       --member "not a login" ) > "$TEST_ROOT/bad2.out" 2>&1; then
  fail "a --member that is not a login must be refused"
fi
[[ ! -d "$GH_REMOTES/MatteoB-adv__ok.git" ]] ||
  fail "input validation must run before the repo is created"
pass "malformed --repo and --member refused before creating anything"

echo
echo "5 team-init cases passed."
