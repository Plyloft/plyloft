#!/usr/bin/env bash
#
# The Mac mini half of a release, in one command: put this commit's user guide
# on the site, build the site, check its SEO, update its sitemap dates, and leave
# two commits ready to push. The app half is scripts/release-preflight.sh and
# scripts/release.sh on the MacBook (docs/RELEASING.md, "The two commands").
#
# Usage: ./scripts/release-site-step.sh            do it
#        ./scripts/release-site-step.sh --check    change nothing in your files; say what it
#                                                  would do (it does fetch from GitHub, which
#                                                  updates the remote-tracking refs)
#
# Needs the app repo on main, clean and equal to origin/main, and the site repo
# ($PLY_SITE_REPO, default ~/code/plyloft-site) on main and not behind origin/main.
# Other uncommitted files in the site repo are left alone: only
# src/content/docs/docs/guide.md and src/data/lastmod.json are ever staged.
#
# It never pushes. It ends by printing the one push command for the owner to type
# (a hook allows exactly that form), after listing the commits that push sends.
# Running it again says there is nothing to do.
#
# Idempotence rule for lastmod: npm run lastmod dates pages in UTC while commits
# carry local time, so around local midnight a second run would find "new" dates
# and make another commit. So lastmod runs only when this run changes the guide, or
# when no "lastmod for X.Y.Z" commit exists yet in the site's recent history: once
# that commit exists, a run that changes nothing else is "nothing to do", whatever
# the clock says. (A guide changed after that commit does run it again.)
#
# The contract for this file is scripts/test-release-site-step.sh.

set -euo pipefail

CHECK=0
case "${1:-}" in
  "") ;;
  --check) CHECK=1 ;;
  *)
    echo "Usage: ./scripts/release-site-step.sh [--check]" >&2
    exit 2
    ;;
esac
if (( $# > 1 )); then
  echo "Usage: ./scripts/release-site-step.sh [--check]" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SITE_REPO="${PLY_SITE_REPO:-$HOME/code/plyloft-site}"
GUIDE_REL="src/content/docs/docs/guide.md"
LASTMOD_REL="src/data/lastmod.json"
REMOTE="origin"
BRANCH="main"

refuse() { # what, fix
  echo "✗ $1"
  [[ -z "${2:-}" ]] || echo "  $2"
  echo "  Nothing was changed."
  exit 1
}

if (( CHECK )); then
  echo "── Site step (--check: changes nothing in your files, builds nothing; it does fetch from GitHub)"
else
  echo "── Site step"
fi

# --- The app repo: the commit the guide is made from ---------------------------
if ! git rev-parse -q --verify 'HEAD^{commit}' >/dev/null 2>&1; then
  refuse "$ROOT is not a git checkout with a commit."
fi
app_branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$app_branch" == "$BRANCH" ]] ||
  refuse "The app repo is on '$app_branch', not $BRANCH." "Fix: git checkout $BRANCH && git pull --ff-only"
if ! fetch_out="$(git fetch --quiet --no-tags "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH" 2>&1)"; then
  refuse "Could not fetch $REMOTE/$BRANCH of the app repo:
$(sed 's/^/    /' <<<"$fetch_out")"
fi
if [[ -n "$(git status --porcelain)" ]]; then
  refuse "The app repo has uncommitted changes:
$(git status --porcelain | sed 's/^/    /')" "Fix: commit or stash them."
fi
head_sha="$(git rev-parse HEAD)"
origin_sha="$(git rev-parse "refs/remotes/$REMOTE/$BRANCH")"
if [[ "$head_sha" != "$origin_sha" ]]; then
  if git merge-base --is-ancestor "$head_sha" "$origin_sha"; then
    refuse "The app repo's $BRANCH is behind $REMOTE/$BRANCH." "Fix: git pull --ff-only"
  fi
  refuse "The app repo's $BRANCH is not $REMOTE/$BRANCH (HEAD is ahead or has diverged)." \
    "Fix: push the release commit first, or check out what $REMOTE/$BRANCH has."
fi
VERSION="$(git show HEAD:package.json | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).version || "")')"
[[ -n "$VERSION" ]] || refuse "HEAD's package.json has no version."
echo "  ✓ App repo: $BRANCH, clean, equal to $REMOTE/$BRANCH ($VERSION, ${head_sha:0:8})"

# --- The site repo ----------------------------------------------------------------
[[ -d "$SITE_REPO/.git" || -f "$SITE_REPO/.git" ]] ||
  refuse "No site repository at $SITE_REPO." "Set PLY_SITE_REPO to the site's folder."
[[ -f "$SITE_REPO/package.json" && -d "$SITE_REPO/src/content/docs" ]] ||
  refuse "$SITE_REPO does not look like the site (no package.json or src/content/docs)."
site_branch="$(git -C "$SITE_REPO" rev-parse --abbrev-ref HEAD)"
[[ "$site_branch" == "$BRANCH" ]] ||
  refuse "The site repo is on '$site_branch', not $BRANCH." "Fix: git -C \"$SITE_REPO\" checkout $BRANCH"
if ! fetch_out="$(git -C "$SITE_REPO" fetch --quiet --no-tags "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH" 2>&1)"; then
  refuse "Could not fetch $REMOTE/$BRANCH of the site repo:
$(sed 's/^/    /' <<<"$fetch_out")"
fi
behind="$(git -C "$SITE_REPO" rev-list --count "HEAD..refs/remotes/$REMOTE/$BRANCH")"
if [[ "$behind" != 0 ]]; then
  refuse "The site repo's $BRANCH is $behind commit(s) behind $REMOTE/$BRANCH." \
    "Fix: git -C \"$SITE_REPO\" pull --ff-only   (if it stops on src/data/releases.ts, that is the last release's changelog draft: save it aside, then discard it)"
fi
ahead="$(git -C "$SITE_REPO" rev-list --count "refs/remotes/$REMOTE/$BRANCH..HEAD")"
for rel in "$GUIDE_REL" "$LASTMOD_REL"; do
  if [[ -n "$(git -C "$SITE_REPO" status --porcelain -- "$rel")" ]]; then
    refuse "The site repo has uncommitted changes in $rel, a file this step owns." \
      "Fix: look at them (git -C \"$SITE_REPO\" diff $rel), then commit or discard them."
  fi
done
echo "  ✓ Site repo: $BRANCH, not behind $REMOTE/$BRANCH (${ahead} commit(s) ahead)"
others="$(git -C "$SITE_REPO" status --porcelain)"
if [[ -n "$others" ]]; then
  echo "  ▸ Other uncommitted files in the site repo, left alone and never staged:"
  echo "$others" | sed 's/^/      /'
  if grep -Eq ' (src/|astro\.config)' <<<"$others"; then
    echo "  ⚠ Some are page sources: lastmod.mjs counts an uncommitted source as changed today."
  fi
fi

# --- The guide, made from HEAD --------------------------------------------------------
guide_tmp="$(mktemp "${TMPDIR:-/tmp}/ply-guide.XXXXXX")"
trap 'rm -f -- "$guide_tmp"' EXIT
git show HEAD:docs/onboarding/USER_GUIDE.md >"$guide_tmp" 2>/dev/null ||
  refuse "HEAD has no docs/onboarding/USER_GUIDE.md."
code=0
out="$(node "$ROOT/scripts/site-guide.mjs" --check --guide "$guide_tmp" --out "$SITE_REPO/$GUIDE_REL" 2>&1)" || code=$?
case "$code" in
  0) GUIDE_CHANGED=0 ;;
  1) GUIDE_CHANGED=1 ;;
  3) refuse "HEAD's user guide can't be made into the site's page:
$(sed 's/^/    /' <<<"$out")" "Fix docs/onboarding/USER_GUIDE.md (it must start with a '# ' title), commit and push it." ;;
  *) refuse "scripts/site-guide.mjs failed ($code):
$(sed 's/^/    /' <<<"$out")" ;;
esac
if (( GUIDE_CHANGED )); then
  echo "  ▸ The guide page differs from HEAD's guide: it will be rewritten and committed as \"User guide for $VERSION\""
else
  echo "  ✓ The guide page already matches HEAD's guide"
fi

# %q leaves a plain path exactly as it is (the form the owner's hook allows) and
# escapes one with a space or a quote so the line still pastes safely.
printf -v quoted_site '%q' "$SITE_REPO"
push_line="cd $quoted_site && git push origin main"
print_push() { # commits that will be on the site's main, not yet on origin
  echo
  echo "This push sends (everything on the site's $BRANCH that $REMOTE/$BRANCH lacks, mine or not):"
  git -C "$SITE_REPO" log --oneline "refs/remotes/$REMOTE/$BRANCH..HEAD" | sed 's/^/    /'
  echo
  echo "Now type this yourself (the site is published by this push, nothing else pushes it):"
  echo "  $push_line"
  echo "Expect: git lists $1 commit(s) and a line ending \"main -> main\"; the site's host rebuilds"
  echo "and the guide shows at https://www.plyloft.com/docs/guide/ a few minutes later."
  echo "Then, on the MacBook: ./scripts/release-preflight.sh"
}

if (( CHECK )); then
  if (( GUIDE_CHANGED )); then echo "  ▸ Would: rewrite the guide page, run npm run lastmod,"; else echo "  ▸ Would: leave the guide page as it is, run npm run lastmod,"; fi
  echo "    and if either file changed run: npx astro build && npm run check:seo, then commit only"
  echo "    $GUIDE_REL (\"User guide for $VERSION\") and $LASTMOD_REL (\"lastmod for $VERSION\")."
  echo "  ▸ Would not push."
  if (( ahead > 0 && ! GUIDE_CHANGED )); then
    echo "  ▸ The site already has $ahead commit(s) not on $REMOTE/$BRANCH: after the real run you would push them."
  fi
  echo
  echo "✓ --check: nothing was changed"
  exit 0
fi

# --- Write, then build ----------------------------------------------------------------
# From the first write on, any failure (a refused write, a failed build, a commit
# git won't make) puts the two files back as committed before the script ends.
restore() { # from HEAD, so a file already staged by a refused commit goes back too
  local f
  for f in "$GUIDE_REL" "$LASTMOD_REL"; do git -C "$SITE_REPO" checkout -q HEAD -- "$f" 2>/dev/null || true; done
}
trap 'restore; rm -f -- "$guide_tmp"' EXIT
if (( GUIDE_CHANGED )); then
  node "$ROOT/scripts/site-guide.mjs" --write --guide "$guide_tmp" --out "$SITE_REPO/$GUIDE_REL" >/dev/null
fi
lastmod_changed=0
lastmod_done=0
recent_subjects="$(git -C "$SITE_REPO" log -n 300 --format=%s)"
if (( ! GUIDE_CHANGED )) && grep -Fxq "lastmod for $VERSION" <<<"$recent_subjects"; then
  lastmod_done=1
  echo "  ✓ A \"lastmod for $VERSION\" commit already exists: lastmod.json is not run again"
else
  if ! lastmod_out="$(cd "$SITE_REPO" && npm run --silent lastmod 2>&1)"; then
    refuse "npm run lastmod failed in the site repo:
$(sed 's/^/    /' <<<"$lastmod_out")" "The site's guide page and lastmod.json were put back as committed."
  fi
  [[ -z "$(git -C "$SITE_REPO" status --porcelain -- "$LASTMOD_REL")" ]] || lastmod_changed=1
  (( lastmod_changed )) || echo "  ✓ lastmod.json is already current"
fi

if (( ! GUIDE_CHANGED && ! lastmod_changed )); then
  echo
  if (( ahead > 0 )); then
    echo "✓ Nothing to do here: the site's commits for $VERSION exist. $ahead of them are not on $REMOTE/$BRANCH yet."
    print_push "$ahead"
  else
    echo "✓ Nothing to do: the site already has $VERSION's guide and dates, and $REMOTE/$BRANCH has them."
  fi
  exit 0
fi

echo "── Building the site and checking its SEO"
if ! (cd "$SITE_REPO" && npx astro build && npm run check:seo); then
  echo "✗ The site build or its SEO check failed (output above)."
  echo "  The guide page and lastmod.json were put back as committed; nothing was committed."
  exit 1
fi
echo "  ✓ Site built, SEO check passed"

committed=""
commit_only() { # message, path
  local out
  if ! out="$(git -C "$SITE_REPO" add -- "$2" 2>&1 && git -C "$SITE_REPO" commit -q -m "$1" -- "$2" 2>&1)"; then
    echo "✗ git would not commit \"$1\":"
    sed 's/^/    /' <<<"$out"
    if [[ -n "$committed" ]]; then
      echo "  Already committed in the site repo: $committed. The commit above was not made, and $2 was put back as committed."
      echo "  Fix the cause (an unfinished merge, a hook), then run this again: it picks up from here. Do not push yet."
    else
      echo "  Nothing was committed, and the two files were put back as committed. Fix the cause, then run this again."
    fi
    exit 1
  fi
  committed="${committed:+$committed, }\"$1\""
  echo "  ✓ Committed: $1"
}
(( ! GUIDE_CHANGED )) || commit_only "User guide for $VERSION" "$GUIDE_REL"
(( ! lastmod_changed )) || commit_only "lastmod for $VERSION" "$LASTMOD_REL"
total="$(git -C "$SITE_REPO" rev-list --count "refs/remotes/$REMOTE/$BRANCH..HEAD")"
echo
echo "✓ The site is ready: $total commit(s) not yet on $REMOTE/$BRANCH."
print_push "$total"
