#!/usr/bin/env bash
#
# The MacBook half of a release: every check that can be made before
# scripts/release.sh, in one checklist that changes nothing in your files (it does
# fetch from GitHub, updating the remote-tracking refs), so a problem that has nothing
# to do with the code (a stale file in the site repo, Apple's agreement) shows up
# before anything is built rather than half-way through.
#
# Usage: ./scripts/release-preflight.sh
#
# Prints a ✓/✗ line per check with one fix under each ✗, and exits 1 on any ✗.
# A ⚠ is advice and does not fail. When everything passes it ends with the one
# line to run: the release notes live in a file (the first run writes a draft from
# the version's highlights, an existing file is never overwritten), so the line
# is the same short, single-line command whatever the notes say and a paste
# cannot split it. It fetches (the remote-tracking refs only) and asks Apple
# about the notary profile; it changes nothing else and discards nothing.
#
# The user guide check, the notary check and the version-file read are the very
# functions release.sh runs (scripts/lib/release-checks.sh).
# The contract for this file is scripts/test-release-preflight.sh.

set -euo pipefail

if (( $# > 0 )); then
  echo "Usage: ./scripts/release-preflight.sh" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
# shellcheck source=scripts/lib/release-checks.sh
source "$ROOT/scripts/lib/release-checks.sh"

NOTARY_PROFILE="ply-notary"
UPDATER_KEY="$HOME/.tauri/ply.key"
RELEASE_CONFIG="src-tauri/tauri.release.conf.json"
HIGHLIGHTS_REL="src/lib/releaseHighlights.ts"
SOURCE_REMOTE="origin"
SOURCE_BRANCH="main"
SITE_REPO="${PLY_SITE_REPO:-$HOME/code/plyloft-site}"
SITE_BRANCH="${PLY_SITE_BRANCH:-main}"
SITE_GUIDE_REL="src/content/docs/docs/guide.md"
SITE_GUIDE="$SITE_REPO/$SITE_GUIDE_REL"
SITE_DRAFT_REL="src/data/releases.ts"

FAILS=0
ok() { echo "  ✓ $*"; }
note() { echo "  ▸ $*"; }
warn() { echo "  ⚠ $*"; }
bad() { # what, then one fix line per further argument
  echo "  ✗ $1"
  shift
  local line
  for line in "$@"; do printf '%s\n' "$line" | sed 's/^/      /'; done
  FAILS=$((FAILS + 1))
}
indent() { sed 's/^/      /'; }

echo "── Release preflight (changes nothing in your files; it does fetch from GitHub, which updates the remote-tracking refs)"

# --- The app repo -------------------------------------------------------------------
echo "── App repo"
SOURCE_COMMIT=""
VERSION=""
if ! SOURCE_COMMIT="$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null)"; then
  bad "$ROOT is not a git checkout with a commit."
else
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" == "$SOURCE_BRANCH" ]]; then
    ok "On $SOURCE_BRANCH"
  else
    bad "On '$branch', not $SOURCE_BRANCH." "Fix: git checkout $SOURCE_BRANCH"
  fi
  if fetch_out="$(git fetch --quiet --no-tags "$SOURCE_REMOTE" \
    "+refs/heads/$SOURCE_BRANCH:refs/remotes/$SOURCE_REMOTE/$SOURCE_BRANCH" 2>&1)"; then
    origin_sha="$(git rev-parse "refs/remotes/$SOURCE_REMOTE/$SOURCE_BRANCH")"
    if [[ "$SOURCE_COMMIT" == "$origin_sha" ]]; then
      ok "Equal to $SOURCE_REMOTE/$SOURCE_BRANCH (${SOURCE_COMMIT:0:8})"
    elif git merge-base --is-ancestor "$SOURCE_COMMIT" "$origin_sha"; then
      bad "Behind $SOURCE_REMOTE/$SOURCE_BRANCH." "Fix: git pull --ff-only"
    else
      bad "Not equal to $SOURCE_REMOTE/$SOURCE_BRANCH (ahead or diverged): the release commit must be the one on $SOURCE_REMOTE." \
        "Fix: push it first (git push $SOURCE_REMOTE $SOURCE_BRANCH), or check out $SOURCE_REMOTE/$SOURCE_BRANCH."
    fi
  else
    bad "Could not fetch $SOURCE_REMOTE/$SOURCE_BRANCH:" "$fetch_out"
  fi
  if [[ -z "$(git status --porcelain)" ]]; then
    ok "Clean working tree"
  else
    bad "Uncommitted changes:" "$(git status --porcelain | head -8)" "Fix: commit or stash them (release.sh builds HEAD, but a dirty tree hides what you tested)."
  fi

  head_version_files
  VERSION="$head_pkg"
  if [[ -n "$VERSION" && "$head_conf" == "$VERSION" && "$head_cargo" == "$VERSION" ]]; then
    ok "Version files agree: $VERSION (package.json, tauri.conf.json, Cargo.toml)"
  else
    bad "Version files disagree at HEAD:" \
      "package.json:              ${head_pkg:-missing}" \
      "src-tauri/tauri.conf.json: ${head_conf:-missing}" \
      "src-tauri/Cargo.toml:      ${head_cargo:-missing}" \
      "Fix: bump all three in one commit and push it."
  fi
fi

# node_modules against package-lock.json. `npm ci` writes node_modules/.package-lock.json,
# npm's own record of what is installed. Comparing its versions with package-lock.json
# takes milliseconds and needs no network; `npm ls` takes seconds and fails on harmless
# things (optional platform packages), `npm ci --dry-run` still resolves. Optional
# packages, links and bundled ones are skipped, the rest must be installed at the
# lockfile's version, with nothing extra.
if [[ ! -f package-lock.json ]]; then
  bad "No package-lock.json." "Fix: restore it (git checkout package-lock.json)."
elif [[ ! -f node_modules/.package-lock.json ]]; then
  bad "node_modules is missing or is not installed (no node_modules/.package-lock.json: npm install or npm ci writes it)." "Fix: npm ci"
else
  if nm_out="$(node -e '
    const fs = require("node:fs");
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")).packages || {};
    const have = JSON.parse(fs.readFileSync("node_modules/.package-lock.json", "utf8")).packages || {};
    const problems = [];
    for (const [key, p] of Object.entries(lock)) {
      if (key === "" || p.link || p.optional || p.inBundle || p.os || p.cpu) continue;
      const h = have[key];
      if (!h) problems.push("missing: " + key + "@" + p.version);
      else if (h.version !== p.version) problems.push(key + ": installed " + h.version + ", lockfile " + p.version);
    }
    for (const key of Object.keys(have)) {
      if (!lock[key] && !have[key].link) problems.push("not in the lockfile: " + key);
    }
    if (problems.length) { console.log(problems.slice(0, 6).join("\n") + (problems.length > 6 ? "\n… and " + (problems.length - 6) + " more" : "")); process.exit(1); }
  ' 2>&1)"; then
    ok "node_modules matches package-lock.json"
  else
    bad "node_modules does not match package-lock.json:" "$nm_out" "Fix: npm ci"
  fi
fi

# --- The site repo --------------------------------------------------------------------
echo "── Site repo ($SITE_REPO)"
if [[ ! -d "$SITE_REPO/.git" && ! -f "$SITE_REPO/.git" ]]; then
  bad "No site repository at $SITE_REPO." "Fix: git clone the site there, or set PLY_SITE_REPO."
else
  site_branch="$(git -C "$SITE_REPO" rev-parse --abbrev-ref HEAD)"
  if [[ "$site_branch" == "$SITE_BRANCH" ]]; then
    ok "On $SITE_BRANCH"
  else
    bad "On '$site_branch', not $SITE_BRANCH." "Fix: git -C \"$SITE_REPO\" checkout $SITE_BRANCH"
  fi

  # The changelog draft release.sh leaves uncommitted after each release. It blocks a
  # pull that touches the file, so it is named first, with the way out. Never discarded here.
  if [[ -n "$(git -C "$SITE_REPO" status --porcelain -- "$SITE_DRAFT_REL")" ]]; then
    bad "$SITE_DRAFT_REL has uncommitted changes: the changelog draft the last release.sh left. It will block the pull." \
      "If it was already published, save it aside and discard it (two commands, run them one at a time):" \
      "cp \"$SITE_REPO/$SITE_DRAFT_REL\" \"\$HOME/Desktop/releases.ts.draft\"" \
      "git -C \"$SITE_REPO\" checkout -- $SITE_DRAFT_REL"
  else
    ok "No stale changelog draft in $SITE_DRAFT_REL"
  fi

  if fetch_out="$(git -C "$SITE_REPO" fetch --quiet --no-tags "$SOURCE_REMOTE" \
    "+refs/heads/$SITE_BRANCH:refs/remotes/$SOURCE_REMOTE/$SITE_BRANCH" 2>&1)"; then
    behind="$(git -C "$SITE_REPO" rev-list --count "refs/heads/$SITE_BRANCH..refs/remotes/$SOURCE_REMOTE/$SITE_BRANCH" 2>/dev/null || echo "?")"
    ahead="$(git -C "$SITE_REPO" rev-list --count "refs/remotes/$SOURCE_REMOTE/$SITE_BRANCH..refs/heads/$SITE_BRANCH" 2>/dev/null || echo "?")"
    if [[ "$behind" == 0 && "$ahead" == 0 ]]; then
      ok "$SITE_BRANCH equal to $SOURCE_REMOTE/$SITE_BRANCH"
    elif [[ "$behind" != 0 && "$ahead" == 0 ]]; then
      bad "$SITE_BRANCH is $behind commit(s) behind $SOURCE_REMOTE/$SITE_BRANCH." "Fix: git -C \"$SITE_REPO\" pull --ff-only"
    elif [[ "$ahead" != 0 && "$behind" == 0 ]]; then
      bad "$SITE_BRANCH has $ahead commit(s) not on $SOURCE_REMOTE/$SITE_BRANCH: the online site is older than this release." \
        "Fix: publish the site from the Mac mini (./scripts/release-site-step.sh, then its push line)."
    else
      bad "$SITE_BRANCH has diverged from $SOURCE_REMOTE/$SITE_BRANCH ($ahead ahead, $behind behind)." "Fix: look at it by hand: git -C \"$SITE_REPO\" log --oneline --graph --all -10"
    fi
  else
    bad "Could not fetch the site's $SITE_BRANCH:" "$fetch_out"
  fi
  others="$(git -C "$SITE_REPO" status --porcelain | grep -v " $SITE_DRAFT_REL\$" || true)"
  if [[ -n "$others" ]]; then
    warn "Other uncommitted files in the site repo (they do not fail this check; a pull stops only on one it would change):"
    indent <<<"$others"
  fi

  # The very check release.sh runs, in a subshell because it exits on a refusal.
  if [[ -n "$SOURCE_COMMIT" && -n "$VERSION" ]]; then
    guide_code=0
    guide_out="$( (check_site_guide) 2>&1)" || guide_code=$?
    if [[ "$guide_code" == 0 ]]; then
      echo "$guide_out" | grep -v '^$' || true
    else
      bad "release.sh's user guide check would stop:" "$guide_out" \
        "(On the Mac mini: ./scripts/release-site-step.sh, push, then pull the site here.)"
    fi
  fi
fi

# --- The highlights' date -----------------------------------------------------------------
echo "── Highlights"
if [[ -n "$VERSION" && -f "$HIGHLIGHTS_REL" ]]; then
  today="$(date +%Y-%m-%d)"
  hl="$(node -e '
    const lines = require("node:fs").readFileSync(process.argv[1], "utf8").split("\n");
    const i = lines.findIndex((l) => l.includes("version: \"" + process.argv[2] + "\""));
    if (i < 0) { console.log("none"); process.exit(0); }
    for (let j = i; j < i + 4 && j < lines.length; j++) {
      const m = lines[j].match(/date: "(\d{4}-\d{2}-\d{2})"/);
      if (m) { console.log(m[1] + " " + (j + 1)); process.exit(0); }
    }
    console.log("none");
  ' "$HIGHLIGHTS_REL" "$VERSION")"
  if [[ "$hl" == none ]]; then
    warn "$HIGHLIGHTS_REL has no entry of its own for $VERSION (fine for a patch release that shows its minor's)."
  else
    hl_date="${hl% *}"
    hl_line="${hl#* }"
    if [[ "$hl_date" == "$today" ]]; then
      ok "$VERSION's highlights are dated today ($today)"
    else
      warn "$VERSION's highlights are dated $hl_date, today is $today ($HIGHLIGHTS_REL:$hl_line). release.sh dates the site changelog today."
      note "If the release day is today, change that line and commit it before releasing; otherwise ignore this."
    fi
  fi
else
  warn "Highlights not checked (no version or no $HIGHLIGHTS_REL)."
fi

# --- Signing, the updater key, tools, Apple ---------------------------------------------------
echo "── Signing and Apple"
if [[ -n "${PLY_TEST_BRIDGE:-}" ]]; then
  bad "PLY_TEST_BRIDGE is set: release.sh refuses to build with the app tester's bridge." "Fix: unset PLY_TEST_BRIDGE"
fi
SIGNING_IDENTITY=""
if [[ -f "$RELEASE_CONFIG" ]]; then
  SIGNING_IDENTITY="$(node -e '
    const config = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(config?.bundle?.macOS?.signingIdentity ?? "");
  ' "$RELEASE_CONFIG" 2>/dev/null || true)"
fi
if [[ -z "$SIGNING_IDENTITY" ]]; then
  bad "No macOS signingIdentity configured in $RELEASE_CONFIG." "Fix: see docs/RELEASING.md (certificate setup)."
elif security find-identity -v -p codesigning 2>/dev/null | grep -Fq "$SIGNING_IDENTITY"; then
  ok "Developer ID Application identity present"
else
  bad "Signing identity is not valid in this Mac's keychain: $SIGNING_IDENTITY" "Fix: this is not the release Mac, or the certificate is missing: docs/RELEASING.md (certificate setup)."
fi
if [[ -f "$UPDATER_KEY" ]]; then
  ok "Updater private key present ($UPDATER_KEY)"
else
  bad "Updater private key not found at $UPDATER_KEY" "Fix: copy it from the release Mac; to make a new one is to break updates (docs/RELEASING.md, updater keypair)."
fi
if command -v jq >/dev/null 2>&1 && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  ok "gh authenticated + jq present"
else
  bad "gh missing or not signed in, or jq missing." "Fix: brew install gh jq; gh auth login"
fi
if [[ -x scripts/check-account-config.sh ]]; then
  if acc_out="$(scripts/check-account-config.sh "$ROOT" 2>&1)"; then
    ok "Sign-in configuration filled in"
  else
    bad "check-account-config.sh refuses:" "$acc_out"
  fi
fi
# Apple, right now: the same call release.sh makes before it builds.
if ! command -v xcrun >/dev/null 2>&1; then
  bad "xcrun not found." "Fix: xcode-select --install"
else
  notary_code=0
  notary_out="$( (check_notary_profile) 2>&1)" || notary_code=$?
  if [[ "$notary_code" == 0 ]]; then
    echo "$notary_out" | head -1
  else
    echo "  ✗ Apple does not accept the notary profile right now (release.sh would stop here):"
    FAILS=$((FAILS + 1))
    # check_notary_profile's own words: the answer, then the fix.
    echo "$notary_out" | sed '1d' | sed 's/^/    /'
  fi
fi

# --- Verdict, and the line to run ---------------------------------------------------------------
echo
if (( FAILS > 0 )); then
  echo "✗ $FAILS check(s) failed. Fix them, then run ./scripts/release-preflight.sh again. Do not run release.sh yet."
  exit 1
fi

# The notes: a file, never text typed on the command line. A multi-line paste can
# run half of itself; a path cannot split. The first run drafts the file from the
# version's highlights; an existing file (yours, edited) is kept as it is.
NOTES_FILE="${PLY_RELEASE_NOTES_FILE:-$HOME/.plyloft-release-notes-$VERSION.txt}"
if [[ ! -f "$NOTES_FILE" ]]; then
  draft="$(node --experimental-strip-types --no-warnings -e '
    import("file://" + process.argv[1] + "/src/lib/releaseHighlights.ts").then((m) => {
      const h = m.highlightsFor(process.argv[2]);
      const out = ["Plyloft " + process.argv[2] + (h ? ": " + h.title : "")];
      if (h) { out.push(""); for (const p of h.points) out.push("- " + p.text); }
      console.log(out.join("\n"));
    }).catch(() => console.log("Plyloft " + process.argv[2]));
  ' "$ROOT" "$VERSION" 2>/dev/null || echo "Plyloft $VERSION")"
  printf '%s\n' "$draft" >"$NOTES_FILE"
  note "Wrote a draft of the release notes to $NOTES_FILE (from $HIGHLIGHTS_REL). Edit it if you want other words."
else
  note "Release notes read from $NOTES_FILE (already there: kept as it is)."
fi
echo "  The notes, as release.sh will publish them:"
indent <"$NOTES_FILE"

printf -v quoted_notes_file '%q' "$NOTES_FILE"
echo
echo "✓ All checks passed. Run this, from $ROOT (one line; the notes come from the file, so it can't be cut):"
echo
echo "RELEASE_NOTES=\"\$(cat $quoted_notes_file)\" ./scripts/release.sh"
echo
echo "Then the Windows step, as docs/RELEASING.md describes it (the exact command is printed at the end of release.sh)."
