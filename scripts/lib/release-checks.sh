#!/usr/bin/env bash
#
# Checks shared by scripts/release.sh and scripts/release-preflight.sh, moved here
# verbatim so the preflight runs the very code the release will run. Sourced, never
# executed. Each function reads the variables its caller already set (NOTARY_PROFILE;
# ROOT, VERSION, SOURCE_COMMIT, SITE_REPO, SITE_BRANCH, SITE_GUIDE_REL, SITE_GUIDE).
# Contract: scripts/test-release.sh and scripts/test-release-preflight.sh.

# Reads HEAD's three version files into head_pkg, head_conf and head_cargo.
head_version_files() {
  head_pkg="$(git show HEAD:package.json 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)"
  head_conf="$(git show HEAD:src-tauri/tauri.conf.json 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)"
  head_cargo="$(git show HEAD:src-tauri/Cargo.toml 2>/dev/null |
    awk -F'"' '/^\[/ { pkg = ($0 == "[package]") } pkg && /^version[[:space:]]*=/ { print $2; exit }' || true)"
}

# Asks Apple, with the stored credentials, whether the notary profile works now.
# Prints the lines release.sh always printed; returns 1 when it fails.
check_notary_profile() {
  local notary_check
  if ! notary_check="$(xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" 2>&1)"; then
    echo "✗ notarytool preflight failed for profile '$NOTARY_PROFILE':"
    echo "$notary_check" | sed 's/^/    /'
    if grep -qi "agreement" <<<"$notary_check"; then
      echo "  Apple is gating on an unaccepted/expired legal agreement — credentials are fine."
      echo "  Fix: Account Holder accepts it at developer.apple.com/account → Membership,"
      echo "  wait a few minutes, then re-run."
    else
      echo "  If the profile is missing: xcrun notarytool store-credentials \"$NOTARY_PROFILE\" \\"
      echo "             --apple-id <id> --team-id <team> (run in Terminal.app)"
    fi
    return 1
  fi
  echo "  ✓ notarytool profile '$NOTARY_PROFILE' valid"
}

# The user guide's site copy (D26, docs/RELEASING.md "The user guide on the site").
# Stops with exit 1 when the copy is missing or differs: run it in a subshell
# to read the answer.
check_site_guide() {
  local guide_file site_file out code ahead
  guide_file="$(mktemp "${TMPDIR:-/tmp}/ply-guide.XXXXXX")"
  if ! git show "$SOURCE_COMMIT:docs/onboarding/USER_GUIDE.md" >"$guide_file" 2>/dev/null; then
    rm -f -- "$guide_file"
    echo "  ▸ Skipped the user guide's site copy: HEAD has no docs/onboarding/USER_GUIDE.md"
    return 0
  fi
  if [[ ! -d "$SITE_REPO/src/content/docs" ]]; then
    rm -f -- "$guide_file"
    echo "  ▸ Skipped the user guide's site copy: no site repository at $SITE_REPO (set PLY_SITE_REPO to the site's folder)"
    return 0
  fi
  if [[ ! -f "$ROOT/scripts/site-guide.mjs" ]]; then
    rm -f -- "$guide_file"
    echo "✗ scripts/site-guide.mjs is missing: the user guide's site copy can't be checked."
    echo "  Nothing was built or pushed."
    exit 1
  fi
  # The committed copy on the site's branch, not the checkout's file: a
  # checkout on another branch, or with the copy written but not committed,
  # is not what the site publishes. No copy there: site_file stays absent.
  site_file="$(mktemp -d "${TMPDIR:-/tmp}/ply-site-guide.XXXXXX")/guide.md"
  if ! git -C "$SITE_REPO" show "refs/heads/$SITE_BRANCH:$SITE_GUIDE_REL" >"$site_file" 2>/dev/null; then
    rm -f -- "$site_file"
  fi
  code=0
  out="$(node "$ROOT/scripts/site-guide.mjs" --check --guide "$guide_file" --out "$site_file" 2>&1)" || code=$?
  rm -rf -- "$(dirname "$site_file")"
  if [[ "$code" == 3 ]]; then
    rm -f -- "$guide_file"
    echo "✗ HEAD's user guide can't be made into the site's page (D26):"
    echo "$out" | sed 's/^/    /'
    echo "  Fix docs/onboarding/USER_GUIDE.md (it must start with a '# ' title), commit and push it, then run this again."
    echo "  Nothing was built or pushed."
    exit 1
  fi
  if [[ "$code" != 0 ]]; then
    echo "✗ The site has no copy of this commit's user guide on its $SITE_BRANCH branch (D26, docs/RELEASING.md \"The user guide on the site\"):"
    echo "$out" | sed "s|$site_file|$SITE_REPO ($SITE_BRANCH):$SITE_GUIDE_REL|; s/^/    /"
    if [[ -f "$SITE_GUIDE" ]] &&
      node "$ROOT/scripts/site-guide.mjs" --check --guide "$guide_file" --out "$SITE_GUIDE" >/dev/null 2>&1; then
      echo "    The checkout's file is this guide's copy, but it isn't committed on $SITE_BRANCH."
    fi
    rm -f -- "$guide_file"
    echo "  Write the copy from this commit's guide, commit it on the site's $SITE_BRANCH and publish the site, then run this again:"
    echo "    git -C \"$ROOT\" show HEAD:docs/onboarding/USER_GUIDE.md > /tmp/USER_GUIDE.md"
    echo "    node \"$ROOT/scripts/site-guide.mjs\" --write --guide /tmp/USER_GUIDE.md --out \"$SITE_GUIDE\""
    echo "    git -C \"$SITE_REPO\" add $SITE_GUIDE_REL && git -C \"$SITE_REPO\" commit -m \"User guide for $VERSION\""
    echo "  Nothing was built or pushed."
    exit 1
  fi
  rm -f -- "$guide_file"
  echo "  ✓ The site's copy of the user guide matches HEAD's ($SITE_GUIDE_REL on $SITE_BRANCH)"
  # Not fatal: the release can't see what plyloft.com serves, only whether
  # the site's branch is ahead of what this machine last saw on its remote.
  if ahead="$(git -C "$SITE_REPO" rev-list --count "refs/remotes/origin/$SITE_BRANCH..refs/heads/$SITE_BRANCH" 2>/dev/null)" &&
    [[ "$ahead" != 0 ]]; then
    echo "  ⚠ The site's $SITE_BRANCH has $ahead commit(s) not on origin/$SITE_BRANCH: publish the site, or the online guide is older than this release."
  fi
}
