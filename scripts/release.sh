#!/usr/bin/env bash
#
# Build a SIGNED + NOTARIZED + STAPLED Plyloft release on this Mac, so it installs
# on another Mac with no Gatekeeper "unidentified developer" warning, and so the
# Tauri auto-updater artifacts are signed.
#
# Prereqs (one-time, see docs/RELEASING.md):
#   - Developer ID Application cert in the login keychain (signing).
#   - A notarytool keychain profile named "ply-notary" (notarization creds).
#   - The Tauri updater private key at ~/.tauri/ply.key (+ its password).
#
# This is the OWNER's release path. The signing/notary credentials never leave
# this machine. install-local.sh stays the unsigned fast-iteration path.
#
# Usage: ./scripts/release.sh                 build, sign, notarize, staple, publish
#        ./scripts/release.sh --publish-only  publish this version's already built,
#                                             notarized artifacts again (no build,
#                                             no signing, no notarization)
#
# Before building, HEAD must be the $VERSION release commit (package.json,
# src-tauri/tauri.conf.json and src-tauri/Cargo.toml at HEAD agree) and already
# on origin/main. After publishing, the annotated tag vX.Y.Z is created on HEAD
# and pushed to origin: release-windows.yml checks that tag out of this repo.
#
# Also before building (D26): when $PLY_SITE_REPO (default ~/code/plyloft-site)
# exists, HEAD's docs/onboarding/USER_GUIDE.md must match the site's copy,
# src/content/docs/docs/guide.md, as committed on $PLY_SITE_BRANCH (default
# main) (scripts/site-guide.mjs).
#
# Last, a draft entry for the site's changelog is written from docs/STATUS.md's
# top entry into $PLY_SITE_REPO (default ~/code/plyloft-site)/src/data/releases.ts
# and left uncommitted for the owner's review (scripts/site-changelog.mjs). That
# step never fails the release.
#
# The contract for this file is scripts/test-release.sh.

set -euo pipefail

PUBLISH_ONLY=0
if (( $# > 1 )); then
  echo "Usage: ./scripts/release.sh [--publish-only]" >&2
  exit 2
fi
case "${1:-}" in
  "") ;;
  --publish-only) PUBLISH_ONLY=1 ;;
  *)
    echo "Usage: ./scripts/release.sh [--publish-only]" >&2
    exit 2
    ;;
esac

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# Checks the preflight (scripts/release-preflight.sh) shares with this file.
# shellcheck source=scripts/lib/release-checks.sh
source "$ROOT/scripts/lib/release-checks.sh"

NOTARY_PROFILE="ply-notary"
UPDATER_KEY="$HOME/.tauri/ply.key"
TARGET="aarch64-apple-darwin"
RELEASE_CONFIG="src-tauri/tauri.release.conf.json"
SIDECAR_PROTOCOL_MARKER="protocol 2"
# Public feed the in-app auto-updater polls (endpoint in tauri.conf.json points
# here). Only signed artifacts live here — source stays private.
RELEASES_REPO="MatteoB-adv/ply-releases"
RESUME_COMMAND="./scripts/release.sh --publish-only"
# GitHub uploads fail transiently (a 500 on 2026-09-17 cost a full rebuild and
# a second notarization). Retry the publish before giving up.
UPLOAD_ATTEMPTS="${PLY_RELEASE_UPLOAD_ATTEMPTS:-4}"
UPLOAD_PAUSE_SECONDS="${PLY_RELEASE_UPLOAD_PAUSE_SECONDS:-15}"

BUNDLE_DIR="$ROOT/src-tauri/target/$TARGET/release/bundle"
APP="$BUNDLE_DIR/macos/Plyloft.app"
APP_SIDECAR="$APP/Contents/MacOS/ply-mcp"
TARBALL="$BUNDLE_DIR/macos/Plyloft.app.tar.gz"
SIG="$TARBALL.sig"

# A publish-stage artifact is absent or belongs to another build: only a full
# run can produce the right one.
need_full_run() {
  echo "✗ $1"
  echo "    $2"
  echo "  A full ./scripts/release.sh run is needed."
  exit 1
}

# --- Never the app tester's bridge (docs/app-tester/DESIGN.md) ----------------
# PLY_TEST_BRIDGE=1 would compile the test agent into the frontend: refuse.
if [[ -n "${PLY_TEST_BRIDGE:-}" ]]; then
  echo "✗ PLY_TEST_BRIDGE is set: refuse to build a release with the app tester's bridge"
  exit 1
fi

# --- A release that can sign in to Plyloft (launch A2, D1) --------------------
# An empty production client id or entitlement key would lock every user out
# behind "Sign-in isn't set up": refuse before anything builds.
if [[ "$PUBLISH_ONLY" == 0 ]]; then
  "$ROOT/scripts/check-account-config.sh" "$ROOT" || exit 1
fi

# --- Ensure cargo on PATH ----------------------------------------------------
if [[ "$PUBLISH_ONLY" == 0 ]] && ! command -v cargo >/dev/null 2>&1; then
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
fi

# --- Preflight ---------------------------------------------------------------
echo "── Preflight checks"
if [[ "$PUBLISH_ONLY" == 1 ]]; then
  echo "  ▸ --publish-only: no build, no signing, no notarization"
fi

SIGNING_IDENTITY="$(
  node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(config?.bundle?.macOS?.signingIdentity ?? "");
  ' "$RELEASE_CONFIG"
)"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  echo "✗ No macOS signingIdentity configured in $RELEASE_CONFIG"
  exit 1
fi

if [[ "$PUBLISH_ONLY" == 0 ]]; then
  if ! security find-identity -v -p codesigning | grep -Fq "$SIGNING_IDENTITY"; then
    echo "✗ Configured signing identity is not valid in the keychain:"
    echo "    $SIGNING_IDENTITY"
    echo "  See docs/RELEASING.md (certificate setup)."
    exit 1
  fi
  echo "  ✓ Developer ID Application identity present"

  if [[ ! -f "$UPDATER_KEY" ]]; then
    echo "✗ Updater private key not found at $UPDATER_KEY"
    echo "  Generate it: npm run tauri signer generate -- -w $UPDATER_KEY"
    exit 1
  fi
  echo "  ✓ Updater private key present"

  check_notary_profile || exit 1
fi

# Publishing needs gh (authed) + jq (to build latest.json with safe escaping).
if ! command -v jq >/dev/null 2>&1; then
  echo "✗ jq not found — needed to generate latest.json. Install: brew install jq"
  exit 1
fi
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  echo "✗ gh not found or not authenticated — needed to publish the release."
  echo "  Install: brew install gh, then: gh auth login"
  exit 1
fi
echo "  ✓ gh authenticated + jq present"

VERSION=$(node -p "require('$ROOT/package.json').version")
echo "  ▸ Version: $VERSION"
TAG="v$VERSION"
# Always this version's DMG by name: bundle/dmg/ can still hold older ones.
DMG="$BUNDLE_DIR/dmg/Plyloft_${VERSION}_aarch64.dmg"

# --- Source tag preflight -----------------------------------------------------
# release-windows.yml checks out $TAG in THIS repo (the feed repo's tag only
# carries the Mac artifacts), so the source tag must exist here as well, on the
# commit that is built. That commit is HEAD, recorded now: the build below
# comes from it, and --publish-only publishes artifacts built from it. The
# checks run before anything is built so a wrong setup fails fast; the tag is
# created and pushed only after a successful publish, so a failed run leaves
# no tag behind. Every step is idempotent: a re-run finds the tag and moves on.
SOURCE_REMOTE="origin"
SOURCE_BRANCH="main"
WINDOWS_COMMAND="gh workflow run release-windows.yml -f tag=$TAG -f publish=true"

# Sets LOCAL_TAG_COMMIT and REMOTE_TAG_COMMIT (empty when absent). Stops when
# either points at another source than SOURCE_COMMIT: a tag is never moved.
# The same tree counts as the same source (a release commit and the merge
# commit that brought it to main unchanged build the same app).
same_source() { # commit
  [[ "$1" == "$SOURCE_COMMIT" ]] && return 0
  [[ "$(git rev-parse -q --verify "$1^{tree}" 2>/dev/null)" == "$(git rev-parse "$SOURCE_COMMIT^{tree}")" ]]
}
check_source_tag() { # context line printed when stopping
  local where commit remote_refs
  LOCAL_TAG_COMMIT="$(git rev-parse -q --verify "refs/tags/$TAG^{commit}" 2>/dev/null || true)"
  if ! remote_refs="$(git ls-remote --tags "$SOURCE_REMOTE" "refs/tags/$TAG" 2>&1)"; then
    echo "✗ Could not read the tags of $SOURCE_REMOTE:"
    echo "$remote_refs" | sed 's/^/    /'
    echo "  $1"
    exit 1
  fi
  REMOTE_TAG_COMMIT=""
  if awk -v ref="refs/tags/$TAG" '$2 == ref { found = 1 } END { exit !found }' <<<"$remote_refs"; then
    if ! git fetch --quiet --no-tags "$SOURCE_REMOTE" "refs/tags/$TAG" >/dev/null 2>&1 ||
      ! REMOTE_TAG_COMMIT="$(git rev-parse -q --verify "FETCH_HEAD^{commit}")"; then
      echo "✗ $TAG exists on $SOURCE_REMOTE but could not be fetched to check its commit."
      echo "  $1"
      exit 1
    fi
  fi
  for where in local "$SOURCE_REMOTE"; do
    if [[ "$where" == local ]]; then commit="$LOCAL_TAG_COMMIT"; else commit="$REMOTE_TAG_COMMIT"; fi
    if [[ -n "$commit" ]] && ! same_source "$commit"; then
      echo "✗ Tag $TAG already exists ($where) on another commit:"
      echo "    $TAG → $commit"
      echo "    HEAD → $SOURCE_COMMIT"
      echo "  A tag is never moved. Check out the commit $TAG names, or bump the version."
      echo "  $1"
      exit 1
    fi
  done
}

echo "── Checking the source commit for $TAG"
if ! SOURCE_COMMIT="$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null)"; then
  echo "✗ $ROOT is not a git checkout with a commit: the release commit can't be tagged."
  exit 1
fi
head_version_files
if [[ "$head_pkg" != "$VERSION" || "$head_conf" != "$VERSION" || "$head_cargo" != "$VERSION" ]]; then
  echo "✗ HEAD ($SOURCE_COMMIT) is not the $VERSION release commit. Its version files say:"
  echo "    package.json:              ${head_pkg:-missing}"
  echo "    src-tauri/tauri.conf.json: ${head_conf:-missing}"
  echo "    src-tauri/Cargo.toml:      ${head_cargo:-missing}"
  echo "  Commit the version bump and push it to $SOURCE_BRANCH first. Nothing was built or pushed."
  exit 1
fi
echo "  ✓ HEAD's version files say $VERSION"
# Skills hub H9: a bundled skill's CHANGES.json entry names the release that
# ships it, written on its branch before the bump. None may be later than the
# version being released (the PPVP check allows up to the next minor).
if head_changes="$(git show "HEAD:src-tauri/resources/ply-skills/CHANGES.json" 2>/dev/null)"; then
  if ! later="$(printf '%s' "$head_changes" | node -e '
    const v = (s) => s.split(".").map((n) => parseInt(n, 10) || 0);
    const after = (a, b) => { for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); } return false; };
    const release = v(process.argv[1]);
    const changes = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const out = [];
    for (const [name, list] of Object.entries(changes)) for (const c of list) if (after(v(c.version), release)) out.push(name + " " + c.version);
    console.log(out.join(", "));
  ' "$VERSION" 2>&1)"; then
    echo "✗ src-tauri/resources/ply-skills/CHANGES.json can't be read: $later"
    echo "  Nothing was built or pushed."
    exit 1
  fi
  if [[ -n "$later" ]]; then
    echo "✗ CHANGES.json lists a skill version after $VERSION: $later"
    echo "  Rename that entry (and its ply-skills-history folder) to $VERSION, commit, and push first. Nothing was built or pushed."
    exit 1
  fi
fi
# D26 (docs/tutorial/DECISIONS.md): the user guide is published on the site
# at every release. HEAD's docs/onboarding/USER_GUIDE.md, made into the site's
# page by scripts/site-guide.mjs, must equal the copy committed on the site's
# $PLY_SITE_BRANCH (default main, the branch the site publishes), whatever
# branch or uncommitted edits its checkout has. Skipped, with a line saying
# so, when HEAD has no guide or there is no site repository (the same rule as
# the site changelog step below).
SITE_REPO="${PLY_SITE_REPO:-$HOME/code/plyloft-site}"
SITE_BRANCH="${PLY_SITE_BRANCH:-main}"
SITE_GUIDE_REL="src/content/docs/docs/guide.md"
SITE_GUIDE="$SITE_REPO/$SITE_GUIDE_REL"
check_site_guide
# Site labels (docs/RELEASING.md "Site labels (warning)"): the site's
# hand-drawn scenes and copy, on the same committed branch, against HEAD's
# app words (scripts/site-labels.mjs). It only warns: whatever it finds, or
# fails to read, the release goes on (owner decision 2026-10-22).
check_site_labels() {
  if [[ ! -d "$SITE_REPO/src" ]]; then
    echo "  ▸ Skipped the site labels check: no site repository at $SITE_REPO (set PLY_SITE_REPO to the site's folder)"
    return 0
  fi
  if [[ ! -f "$ROOT/scripts/site-labels.mjs" ]]; then
    echo "  ⚠ Site labels: not checked: scripts/site-labels.mjs is missing"
    return 0
  fi
  local behind
  node "$ROOT/scripts/site-labels.mjs" --check --warn \
    --repo "$SITE_REPO" --ref "refs/heads/$SITE_BRANCH" \
    --app-dir "$ROOT" --app-ref "$SOURCE_COMMIT" 2>&1 | sed 's/^/  /' || true
  # The local branch is what was read; behind its origin, the words may
  # already be fixed there.
  if behind="$(git -C "$SITE_REPO" rev-list --count "refs/heads/$SITE_BRANCH..refs/remotes/origin/$SITE_BRANCH" 2>/dev/null)" &&
    [[ "$behind" != 0 ]]; then
    echo "  ⚠ Site labels read your local $SITE_BRANCH, $behind commit(s) behind origin/$SITE_BRANCH as last fetched: pull the site first, or these may already be fixed."
  fi
}
check_site_labels
if ! fetch_out="$(git fetch --quiet --no-tags "$SOURCE_REMOTE" \
  "+refs/heads/$SOURCE_BRANCH:refs/remotes/$SOURCE_REMOTE/$SOURCE_BRANCH" 2>&1)"; then
  echo "✗ Could not fetch $SOURCE_REMOTE/$SOURCE_BRANCH:"
  echo "$fetch_out" | sed 's/^/    /'
  echo "  Nothing was built or pushed."
  exit 1
fi
if ! git merge-base --is-ancestor "$SOURCE_COMMIT" "refs/remotes/$SOURCE_REMOTE/$SOURCE_BRANCH"; then
  echo "✗ HEAD ($SOURCE_COMMIT) is not on $SOURCE_REMOTE/$SOURCE_BRANCH."
  echo "  The release commit must be pushed first: git push $SOURCE_REMOTE $SOURCE_BRANCH"
  echo "  Nothing was built or pushed."
  exit 1
fi
echo "  ✓ HEAD is on $SOURCE_REMOTE/$SOURCE_BRANCH"
check_source_tag "Nothing was built or pushed."
if [[ -n "$LOCAL_TAG_COMMIT$REMOTE_TAG_COMMIT" ]]; then
  echo "  ✓ Tag $TAG already exists on this source"
else
  echo "  ▸ Tag $TAG will be created on HEAD and pushed after publishing"
fi

if [[ "$PUBLISH_ONLY" == 0 ]]; then
  # --- Updater signing key (for the .tar.gz update artifact) -----------------
  # Tauri reads these env vars at build time to sign the updater bundle. The
  # password is prompted (hidden) so it never lands in shell history or a file.
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$UPDATER_KEY")"
  read -r -s -p "Updater key password (TAURI_SIGNING_PRIVATE_KEY_PASSWORD): " TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  echo
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD

  # --- Build + sign the nested sidecar before Tauri seals the app ------------
  export PLY_SIDECAR_TARGET="$TARGET"
  echo "── Building signed ply-mcp sidecar"
  ./scripts/build-sidecar.sh --release
  SIDECAR_INPUT="$ROOT/src-tauri/binaries/ply-mcp-$TARGET"
  codesign --force --timestamp --options runtime \
    --sign "$SIGNING_IDENTITY" "$SIDECAR_INPUT"
  codesign --verify --strict --verbose=2 "$SIDECAR_INPUT"
  if [[ "$("$SIDECAR_INPUT" --version)" != *"$SIDECAR_PROTOCOL_MARKER"* ]]; then
    echo "✗ Signed sidecar has an incompatible protocol marker"
    exit 1
  fi
  echo "  ✓ Signed nested sidecar: $SIDECAR_INPUT"
  # The Tauri before-build hook must validate/reuse this signed input, not
  # overwrite it with a fresh unsigned cargo artifact.
  export PLY_SIDECAR_SKIP_BUILD=1

  # --- Build (signs the .app with the release overlay's signingIdentity) -----
  # Tauri bundles everything in dist/: start it empty, so no file from an
  # earlier build (a dev build with the app tester's bridge) rides along.
  rm -rf dist
  echo "── Building signed bundle (a few minutes)…"
  npm run tauri build -- --target "$TARGET" --config "$RELEASE_CONFIG"

  if [[ ! -f "$DMG" ]]; then
    echo "✗ Build did not produce this version's .dmg:"
    echo "    $DMG"
    ls -la "$BUNDLE_DIR/dmg/" 2>/dev/null || true
    exit 1
  fi
  echo "  ✓ Built: $DMG"
  ./scripts/app-tester/check-no-release.sh --dist dist --binary "$APP/Contents/MacOS/atelier"

  # --- Verify the signature before notarizing --------------------------------
  echo "── Verifying code signature"
  if [[ ! -x "$APP_SIDECAR" ]]; then
    echo "✗ Bundled sidecar missing or not executable: $APP_SIDECAR"
    exit 1
  fi
  if [[ "$("$APP_SIDECAR" --version)" != *"$SIDECAR_PROTOCOL_MARKER"* ]]; then
    echo "✗ Bundled sidecar has an incompatible protocol marker"
    exit 1
  fi
  codesign --verify --strict --verbose=2 "$APP_SIDECAR"
  app_sidecar_signature="$(codesign -dv --verbose=4 "$APP_SIDECAR" 2>&1)"
  if ! grep -Fq "Authority=$SIGNING_IDENTITY" <<<"$app_sidecar_signature"; then
    echo "✗ Bundled sidecar is not signed by the configured identity"
    echo "$app_sidecar_signature" | sed 's/^/    /'
    exit 1
  fi
  echo "  ✓ Nested ply-mcp signature OK"
  codesign --verify --deep --strict --verbose=2 "$APP"
  echo "  ✓ codesign OK"

  # --- Notarize (submit the .dmg, wait for Apple) ----------------------------
  echo "── Notarizing (uploads to Apple, usually 1–5 min)…"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait

  # --- Staple the ticket so it validates offline -----------------------------
  echo "── Stapling notarization ticket"
  xcrun stapler staple "$DMG"
  # Staple the .app too, so the updater .tar.gz carries the ticket as well.
  xcrun stapler staple "$APP" || echo "  (note: .app staple skipped — dmg staple is the one that matters for install)"

  # --- Final Gatekeeper assessment -------------------------------------------
  echo "── Gatekeeper assessment"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG" 2>&1 || true

  echo
  echo "✓ Signed + notarized + stapled: $DMG"
else
  # --- Publish-only: the artifacts on disk must be this version's, notarized -
  echo "── Checking this version's built artifacts"
  [[ -f "$DMG" ]] || need_full_run "This version's .dmg is missing:" "$DMG"
  echo "  ✓ $DMG"
  if ! staple_check="$(xcrun stapler validate "$DMG" 2>&1)"; then
    echo "$staple_check" | sed 's/^/    /'
    need_full_run "The .dmg carries no valid notarization ticket:" "$DMG"
  fi
  echo "  ✓ stapler validate OK"
  if ! gatekeeper_check="$(spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG" 2>&1)"; then
    echo "$gatekeeper_check" | sed 's/^/    /'
    need_full_run "Gatekeeper rejects the .dmg:" "$DMG"
  fi
  echo "  ✓ Gatekeeper accepts the .dmg"
fi

# --- Publish to the public releases feed (powers the in-app auto-updater) -----
# The updater plugin polls
#   https://github.com/$RELEASES_REPO/releases/latest/download/latest.json
# so we attach latest.json (manifest) + Plyloft.app.tar.gz (update payload) + the
# .dmg (manual install) to a GitHub Release tagged v<version>, marked --latest.
[[ -f "$TARBALL" ]] || need_full_run "Updater archive missing (was createUpdaterArtifacts:true applied via $RELEASE_CONFIG?):" "$TARBALL"
[[ -f "$SIG" ]] || need_full_run "Updater signature missing (was createUpdaterArtifacts:true applied via $RELEASE_CONFIG?):" "$SIG"

echo "── Verifying updater archive: this version, carrying signed ply-mcp"
SIDECAR_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ply-sidecar-check.XXXXXX")"
trap 'rm -rf -- "$SIDECAR_CHECK_DIR"' EXIT
tar -xzf "$TARBALL" -C "$SIDECAR_CHECK_DIR" ||
  need_full_run "Updater archive cannot be unpacked:" "$TARBALL"
ARCHIVE_PLIST="$SIDECAR_CHECK_DIR/Plyloft.app/Contents/Info.plist"
archive_version="$(plutil -extract CFBundleShortVersionString raw -o - "$ARCHIVE_PLIST" 2>/dev/null || true)"
if [[ "$archive_version" != "$VERSION" ]]; then
  need_full_run "Updater archive is version '${archive_version:-unknown}', not $VERSION:" "$TARBALL"
fi
echo "  ✓ Updater archive is version $VERSION"
ARCHIVE_SIDECAR="$SIDECAR_CHECK_DIR/Plyloft.app/Contents/MacOS/ply-mcp"
if [[ ! -x "$ARCHIVE_SIDECAR" ]]; then
  echo "✗ Updater archive sidecar missing or not executable"
  exit 1
fi
if [[ "$("$ARCHIVE_SIDECAR" --version)" != *"$SIDECAR_PROTOCOL_MARKER"* ]]; then
  echo "✗ Updater archive sidecar has an incompatible protocol marker"
  exit 1
fi
codesign --verify --strict --verbose=2 "$ARCHIVE_SIDECAR"
archive_sidecar_signature="$(codesign -dv --verbose=4 "$ARCHIVE_SIDECAR" 2>&1)"
if ! grep -Fq "Authority=$SIGNING_IDENTITY" <<<"$archive_sidecar_signature"; then
  echo "✗ Updater archive sidecar is not signed by the configured identity"
  echo "$archive_sidecar_signature" | sed 's/^/    /'
  exit 1
fi
rm -rf -- "$SIDECAR_CHECK_DIR"
trap - EXIT
echo "  ✓ Updater archive nested sidecar OK"

echo "── Generating latest.json (updater manifest)"
# The signature in latest.json is the verbatim contents of the .sig file; jq
# --arg handles JSON escaping (it contains a newline). The url points at the
# tarball asset on this specific tagged release.
LATEST_JSON="$BUNDLE_DIR/latest.json"
TARBALL_URL="https://github.com/$RELEASES_REPO/releases/download/$TAG/Plyloft.app.tar.gz"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NOTES="${RELEASE_NOTES:-Plyloft $VERSION}"
# The Windows workflow (release-windows.yml) merges windows-x86_64 into this
# tag's latest.json after the Mac release. Re-publishing the same tag must keep
# it: read the tag's current latest.json and carry over its other platform
# entries when it is this version's. Another version's entries are never
# carried — they would offer an old installer under the new version.
EXISTING_PLATFORMS='{}'
FEED_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ply-feed.XXXXXX")"
trap 'rm -rf -- "$FEED_DIR"' EXIT
if gh release view "$TAG" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
  if ! feed_assets="$(gh release view "$TAG" --repo "$RELEASES_REPO" --json assets --jq '.assets[].name' 2>&1)"; then
    echo "✗ Could not list the assets of $TAG on $RELEASES_REPO:"
    echo "$feed_assets" | sed 's/^/    /'
    echo "  Publishing without reading its latest.json would drop the other platforms. Try again:"
    echo "$RESUME_COMMAND"
    exit 1
  fi
  if grep -qx 'latest.json' <<<"$feed_assets"; then
    downloaded=0
    attempt=1
    while (( attempt <= UPLOAD_ATTEMPTS )); do
      if gh release download "$TAG" --repo "$RELEASES_REPO" --pattern latest.json \
        --dir "$FEED_DIR" >/dev/null 2>&1; then
        downloaded=1
        break
      fi
      if (( attempt < UPLOAD_ATTEMPTS )); then
        echo "  ▸ Reading $TAG's latest.json failed (attempt $attempt of $UPLOAD_ATTEMPTS); retrying in ${UPLOAD_PAUSE_SECONDS}s…"
        sleep "$UPLOAD_PAUSE_SECONDS"
      fi
      attempt=$((attempt + 1))
    done
    if [[ "$downloaded" == 0 ]]; then
      echo "✗ Could not download $TAG's latest.json from $RELEASES_REPO."
      echo "  Publishing without it would drop the other platforms. Try again:"
      echo "$RESUME_COMMAND"
      exit 1
    fi
    if jq -e --arg v "$VERSION" '.version == $v and (.platforms | type == "object")' \
      "$FEED_DIR/latest.json" >/dev/null 2>&1; then
      EXISTING_PLATFORMS="$(jq -c '.platforms | del(.["darwin-aarch64"])' "$FEED_DIR/latest.json")"
    else
      feed_version="$(jq -r '.version // "unknown"' "$FEED_DIR/latest.json" 2>/dev/null || echo unreadable)"
      echo "  ▸ $TAG's latest.json is version '$feed_version', not $VERSION: none of its platforms are kept"
    fi
  fi
fi
rm -rf -- "$FEED_DIR"
trap - EXIT
KEPT_PLATFORMS="$(jq -r 'keys | join(", ")' <<<"$EXISTING_PLATFORMS")"
jq -n \
  --arg version "$VERSION" \
  --arg notes "$NOTES" \
  --arg pub_date "$PUB_DATE" \
  --arg sig "$(cat "$SIG")" \
  --arg url "$TARBALL_URL" \
  --argjson kept "$EXISTING_PLATFORMS" \
  '{version:$version, notes:$notes, pub_date:$pub_date,
    platforms:($kept + {"darwin-aarch64":{signature:$sig, url:$url}})}' \
  > "$LATEST_JSON"
if [[ -n "$KEPT_PLATFORMS" ]]; then
  echo "  ▸ Platforms kept from $TAG's latest.json: $KEPT_PLATFORMS (darwin-aarch64 refreshed)"
else
  echo "  ▸ Platforms kept from an existing latest.json: none (darwin-aarch64 only)"
fi
echo "  ✓ $LATEST_JSON"

# One publish attempt. The tag is looked up each time: a create that failed
# mid-upload can leave the release behind, and the next attempt then takes the
# --clobber path (and undrafts it).
publish_once() {
  if gh release view "$TAG" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
    echo "  ▸ Release $TAG already exists — overwriting its assets"
    gh release upload "$TAG" "$DMG" "$TARBALL" "$LATEST_JSON" \
      --repo "$RELEASES_REPO" --clobber || return 1
    gh release edit "$TAG" --repo "$RELEASES_REPO" --draft=false --latest >/dev/null || return 1
  else
    gh release create "$TAG" "$DMG" "$TARBALL" "$LATEST_JSON" \
      --repo "$RELEASES_REPO" --target main --title "Plyloft $VERSION" \
      --notes "$NOTES" --latest || return 1
  fi
}

echo "── Publishing GitHub Release $TAG to $RELEASES_REPO"
attempt=1
until publish_once; do
  if (( attempt >= UPLOAD_ATTEMPTS )); then
    echo
    echo "✗ Publishing $TAG to $RELEASES_REPO failed after $attempt attempts."
    echo "  The built, signed and notarized artifacts are intact in $BUNDLE_DIR."
    echo "  Publish them again, without rebuilding or notarizing, with:"
    echo "$RESUME_COMMAND"
    exit 1
  fi
  echo "  ▸ Publish attempt $attempt of $UPLOAD_ATTEMPTS failed; retrying in ${UPLOAD_PAUSE_SECONDS}s…"
  sleep "$UPLOAD_PAUSE_SECONDS"
  attempt=$((attempt + 1))
done

# --- Source tag: vX.Y.Z on the built commit, in this repo ----------------------
# After the publish, so a failed run leaves no tag. Checked again first: the
# tag may have appeared while the build ran.
push_source_tag() {
  check_source_tag "The Mac release is published; $TAG was not created or pushed."
  if [[ -n "$REMOTE_TAG_COMMIT" ]]; then
    echo "  ✓ $TAG is already on $SOURCE_REMOTE ($REMOTE_TAG_COMMIT): nothing to push"
    return 0
  fi
  if [[ -n "$LOCAL_TAG_COMMIT" ]]; then
    echo "  ▸ $TAG already exists locally ($LOCAL_TAG_COMMIT)"
  else
    git tag -a "$TAG" -m "Plyloft $VERSION" "$SOURCE_COMMIT" || return 1
    echo "  ✓ Created $TAG on $SOURCE_COMMIT"
  fi
  git push "$SOURCE_REMOTE" "refs/tags/$TAG" || return 1
  echo "  ✓ Pushed $TAG to $SOURCE_REMOTE"
}

echo "── Tagging the source: $TAG in this repo (release-windows.yml checks it out)"
if ! push_source_tag; then
  echo
  echo "✗ The Mac release is published, but $TAG could not be tagged or pushed to $SOURCE_REMOTE."
  echo "  The Windows workflow needs it. Push it (the commit built is $SOURCE_COMMIT):"
  echo "    git rev-parse -q --verify refs/tags/$TAG || git tag -a $TAG -m \"Plyloft $VERSION\" $SOURCE_COMMIT"
  echo "    git push $SOURCE_REMOTE refs/tags/$TAG"
  echo "  or run $RESUME_COMMAND again (it re-publishes, then tags)."
  exit 1
fi

# --- Site changelog draft (launch W5; never fails the release) -----------------
# Writes a draft entry for this version into the site's src/data/releases.ts,
# from the top entry of docs/STATUS.md as committed at the built commit, and
# leaves it UNCOMMITTED: the owner reviews and rewrites it before committing
# in the site repository. Anything that goes wrong here is logged and skipped.
# SITE_REPO is set with the user guide's check, in the preflight.
SITE_RELEASES="$SITE_REPO/src/data/releases.ts"
SITE_SCRIPT="$ROOT/scripts/site-changelog.mjs"
echo "── Site changelog draft for $VERSION (not fatal)"
site_changelog() {
  local status_file out
  if [[ ! -f "$SITE_SCRIPT" ]]; then
    echo "  ▸ Skipped: $SITE_SCRIPT is missing"
    return 0
  fi
  if [[ ! -f "$SITE_RELEASES" ]]; then
    echo "  ▸ Skipped: no site changelog at $SITE_RELEASES (set PLY_SITE_REPO to the site's folder)"
    return 0
  fi
  status_file="$(mktemp "${TMPDIR:-/tmp}/ply-status.XXXXXX")" || return 1
  if ! git show "$SOURCE_COMMIT:docs/STATUS.md" >"$status_file" 2>/dev/null; then
    rm -f -- "$status_file"
    echo "  ⚠ Skipped: docs/STATUS.md could not be read at $SOURCE_COMMIT"
    return 0
  fi
  if out="$(node "$SITE_SCRIPT" --status "$status_file" --releases "$SITE_RELEASES" \
    --version "$VERSION" --date "$(date +%Y-%m-%d)" 2>&1)"; then
    echo "$out" | sed 's/^/  /'
    if ! git -C "$SITE_REPO" diff --quiet -- src/data/releases.ts 2>/dev/null; then
      echo "  ▸ Left uncommitted for your review: git -C \"$SITE_REPO\" diff src/data/releases.ts"
    fi
  else
    echo "$out" | sed 's/^/  /'
    echo "  ⚠ No site changelog draft was written; the release itself is fine."
  fi
  rm -f -- "$status_file"
  return 0
}
site_changelog || echo "  ⚠ The site changelog step failed; the release itself is fine."

echo
echo "✓ Published: https://github.com/$RELEASES_REPO/releases/tag/$TAG"
echo "  • The .dmg installs on any Mac with no Gatekeeper warning (hand it to the dev once)."
echo "  • Every running Plyloft ≥ this version's updater will now see v$VERSION on next launch"
echo "    and offer a one-click in-place update."
echo
echo "Now run release-windows for $TAG (it builds the Windows installer from $TAG"
echo "in this repo and adds it to the same release):"
echo "  $WINDOWS_COMMAND"
