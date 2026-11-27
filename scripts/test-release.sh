#!/usr/bin/env bash
#
# Contract test for scripts/release.sh (GH #121). Runs the real script from a
# throwaway root holding a fake bundle folder, with gh / codesign / xcrun /
# spctl / security / npm stubs on PATH. Nothing here builds, signs, notarizes
# or touches GitHub. git is real: each root is a throwaway repository whose
# origin is a local bare repository, so the source tag can be checked there.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ply-release-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v jq >/dev/null || fail "jq is required to run this test"
command -v git >/dev/null || fail "git is required to run this test"

# git never reads the owner's config here (signing, hooks, default branch).
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME="Release Test" GIT_AUTHOR_EMAIL="release-test@example.invalid"
export GIT_COMMITTER_NAME="Release Test" GIT_COMMITTER_EMAIL="release-test@example.invalid"

VERSION="9.8.7"
IDENTITY="Developer ID Application: Test Owner (TEAMID1234)"
TARGET="aarch64-apple-darwin"

# ── Stubs: every call is logged to $CALLS ────────────────────────────────
FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"
stub() { # name, body
  printf '#!/usr/bin/env bash\necho "%s $*" >>"$CALLS"\n%s\n' "$1" "$2" >"$FAKE_BIN/$1"
  chmod +x "$FAKE_BIN/$1"
}
# gh: $GH_ON_PUBLISH, when set, runs once before an upload or create (to
# change the repository while the release publishes). The tag exists when $GH_TAG_EXISTS=1; the first $GH_FAILS uploads or
# creates fail, like the 500 of 2026-09-17. $GH_FEED_JSON, when set, is the
# existing tag's latest.json asset; $GH_DOWNLOAD_FAILS=1 makes its download fail.
stub gh '
fail_once() {
  local n; n="$(cat "$GH_FAIL_COUNT" 2>/dev/null || echo 0)"
  if (( n < ${GH_FAILS:-0} )); then echo $((n + 1)) >"$GH_FAIL_COUNT"; echo "HTTP 500" >&2; exit 1; fi
}
case "$1 ${2:-}" in
  "auth status") exit 0 ;;
  "release view")
    [[ "${GH_TAG_EXISTS:-0}" == 1 ]] || { echo "release not found" >&2; exit 1; }
    if [[ " $* " == *" --json "* ]]; then
      echo "Plyloft_x_aarch64.dmg"
      [[ -n "${GH_FEED_JSON:-}" ]] && echo "latest.json"
    fi
    exit 0 ;;
  "release download")
    [[ "${GH_TAG_EXISTS:-0}" == 1 && -n "${GH_FEED_JSON:-}" ]] || { echo "release not found" >&2; exit 1; }
    [[ "${GH_DOWNLOAD_FAILS:-0}" == 1 ]] && { echo "HTTP 502" >&2; exit 1; }
    dir=.; prev=
    for a in "$@"; do [[ "$prev" == --dir ]] && dir="$a"; prev="$a"; done
    mkdir -p "$dir" && cp "$GH_FEED_JSON" "$dir/latest.json" ;;
  "release upload"|"release create")
    if [[ -n "${GH_ON_PUBLISH:-}" && ! -e "$GH_FAIL_COUNT.hook" ]]; then
      touch "$GH_FAIL_COUNT.hook"; bash -c "$GH_ON_PUBLISH" >/dev/null 2>&1
    fi
    fail_once; exit 0 ;;
  "release edit") exit 0 ;;
  *) echo "fake gh: unexpected: $*" >&2; exit 64 ;;
esac'
stub codesign '
if [[ "$1" == "-dv" ]]; then echo "Authority=$IDENTITY" >&2; fi
exit 0'
stub xcrun '
if [[ "$1 ${2:-}" == "notarytool history" && -n "${NOTARY_FAIL:-}" ]]; then
  if [[ "$NOTARY_FAIL" == agreement ]]; then echo "Error: HTTP status code: 403. A required agreement is missing or has expired." >&2
  else echo "Error: No Keychain password item found for profile: ply-notary" >&2; fi
  exit 1
fi
if [[ "$1 ${2:-}" == "stapler validate" && "${STAPLE_INVALID:-0}" == 1 ]]; then exit 65; fi
exit 0'
stub spctl 'exit 0'
stub security 'echo "  1) ABCDEF \"$IDENTITY\""'
stub npm 'exit 0'
export IDENTITY

# ── A throwaway repository root with a fake, already built bundle ─────────
plist() { # version
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>$1</string>
</dict></plist>
PLIST
}

make_root() { # name, archive version
  local root="$TEST_ROOT/$1" archive_version="${2:-$VERSION}"
  local bundle="$root/src-tauri/target/$TARGET/release/bundle"
  mkdir -p "$root/scripts" "$bundle/dmg" "$bundle/macos/Plyloft.app/Contents/MacOS"
  cp "$SCRIPT_DIR/release.sh" "$root/scripts/"
  mkdir -p "$root/scripts/lib"
  cp "$SCRIPT_DIR/lib/release-checks.sh" "$root/scripts/lib/"
  printf '{"version":"%s"}\n' "$VERSION" >"$root/package.json"
  printf '{"productName":"Plyloft","version":"%s"}\n' "$VERSION" >"$root/src-tauri/tauri.conf.json"
  printf '[package]\nname = "atelier"\nversion = "%s"\n\n[dependencies]\nserde = { version = "1" }\n' \
    "$VERSION" >"$root/src-tauri/Cargo.toml"
  jq -n --arg id "$IDENTITY" '{bundle:{macOS:{signingIdentity:$id}}}' \
    >"$root/src-tauri/tauri.release.conf.json"
  # Build stub for the full run: produces the signed sidecar input.
  cat >"$root/scripts/build-sidecar.sh" <<SIDECAR
#!/usr/bin/env bash
echo "build-sidecar \$*" >>"\$CALLS"
mkdir -p "$root/src-tauri/binaries"
printf '#!/usr/bin/env bash\necho "ply-mcp protocol 2"\n' >"$root/src-tauri/binaries/ply-mcp-$TARGET"
chmod +x "$root/src-tauri/binaries/ply-mcp-$TARGET"
SIDECAR
  chmod +x "$root/scripts/build-sidecar.sh"
  # Launch A2's sign-in configuration check: logged; a root may make it refuse.
  printf '#!/usr/bin/env bash\necho "check-account-config $*" >>"$CALLS"\n[[ -z "${REFUSE_ACCOUNT_CONFIG:-}" ]] || { echo "✗ PLYLOFT_GITHUB_CLIENT_ID in src-tauri/src/account.rs is empty"; exit 1; }\n' \
    >"$root/scripts/check-account-config.sh"
  chmod +x "$root/scripts/check-account-config.sh"
  # The app tester's no-release check: logged, so the full run can assert it ran.
  mkdir -p "$root/scripts/app-tester"
  printf '#!/usr/bin/env bash\necho "check-no-release $*" >>"$CALLS"\n' \
    >"$root/scripts/app-tester/check-no-release.sh"
  chmod +x "$root/scripts/app-tester/check-no-release.sh"

  local app="$bundle/macos/Plyloft.app"
  printf '#!/usr/bin/env bash\necho "ply-mcp protocol 2"\n' >"$app/Contents/MacOS/ply-mcp"
  chmod +x "$app/Contents/MacOS/ply-mcp"
  plist "$archive_version" >"$app/Contents/Info.plist"
  tar -czf "$bundle/macos/Plyloft.app.tar.gz" -C "$bundle/macos" Plyloft.app
  printf 'untrusted comment: fake\nSIGNATURE\n' >"$bundle/macos/Plyloft.app.tar.gz.sig"
  echo "current" >"$bundle/dmg/Plyloft_${VERSION}_aarch64.dmg"
  # An older DMG left behind, sorting first.
  echo "older" >"$bundle/dmg/Plyloft_1.0.0_aarch64.dmg"

  # The release commit, already pushed to origin/main.
  printf 'src-tauri/target/\nsrc-tauri/binaries/\nhome/\ncalls.log\nout\ngh-fails*\nfeed.json\n' >"$root/.gitignore"
  git init -q -b main "$root"
  git -C "$root" add -A
  git -C "$root" commit -q -m "release: v$VERSION"
  git init -q --bare "$root.origin.git"
  git -C "$root" remote add origin "$root.origin.git"
  git -C "$root" push -q origin main
  echo "$root"
}

# The commit the origin's tag vX.Y.Z names (empty when the tag is absent).
origin_tag() { git -C "$1.origin.git" rev-parse -q --verify "refs/tags/v$VERSION^{commit}" 2>/dev/null || true; }
head_of() { git -C "$1" rev-parse HEAD; }
no_origin_tag() { # root, what
  [[ -z "$(origin_tag "$1")" ]] || fail "$2: a tag was pushed to origin"
  [[ -z "$(git -C "$1" tag -l "v$VERSION")" ]] || fail "$2: a local tag was created"
}

run_release() { # root, log, args…
  local root="$1" log="$2"; shift 2
  CALLS="$root/calls.log" GH_FAIL_COUNT="$root/gh-fails" \
    PATH="$FAKE_BIN:$PATH" HOME="$root/home" \
    PLY_RELEASE_UPLOAD_PAUSE_SECONDS=0 \
    "$root/scripts/release.sh" "$@" >"$log" 2>&1 <<<"updater-key-password"
}

export CALLS=/dev/null
# The site steps read $PLY_SITE_REPO: never the owner's real site from here.
unset PLY_SITE_REPO PLY_SITE_BRANCH

# 1. --publish-only on a fresh tag: no build, no notarization, this version's
#    DMG (not the older one), a create with every asset.
root="$(make_root fresh)"
run_release "$root" "$root/out" --publish-only || fail "publish-only failed: $(<"$root/out")"
grep -Eq '^(npm|build-sidecar)' "$root/calls.log" && fail "--publish-only ran the build"
grep -Fq 'notarytool' "$root/calls.log" && fail "--publish-only called notarytool"
grep -Fq 'stapler staple' "$root/calls.log" && fail "--publish-only stapled"
grep -q '^codesign --force' "$root/calls.log" && fail "--publish-only signed"
grep -q "^xcrun stapler validate .*bundle/dmg/Plyloft_${VERSION}_aarch64.dmg$" "$root/calls.log" ||
  fail "--publish-only did not stapler-validate this version's DMG"
grep -Fq "spctl --assess" "$root/calls.log" || fail "--publish-only skipped spctl"
create="$(grep '^gh release create' "$root/calls.log")" || fail "no gh release create"
[[ "$create" == *"Plyloft_${VERSION}_aarch64.dmg"* ]] || fail "create did not upload this version's DMG"
[[ "$create" == *"Plyloft_1.0.0"* ]] && fail "create picked up the older DMG"
[[ "$create" == *"Plyloft.app.tar.gz "* && "$create" == *"latest.json"* ]] || fail "create is missing assets: $create"
jq -e --arg v "$VERSION" '.version == $v and (.platforms["darwin-aarch64"].signature | test("SIGNATURE"))' \
  "$root/src-tauri/target/$TARGET/release/bundle/latest.json" >/dev/null || fail "latest.json is wrong"
pass "--publish-only publishes this version's artifacts without build or notarytool"
[[ "$(origin_tag "$root")" == "$(head_of "$root")" ]] || fail "v$VERSION was not pushed to origin on HEAD: $(<"$root/out")"
[[ "$(git -C "$root.origin.git" cat-file -t "refs/tags/v$VERSION")" == tag ]] || fail "v$VERSION is not annotated"
git -C "$root.origin.git" cat-file tag "refs/tags/v$VERSION" | grep -qx "Plyloft $VERSION" || fail "v$VERSION's message is not 'Plyloft $VERSION'"
published_line="$(grep -n "Publishing GitHub Release" "$root/out" | cut -d: -f1)"
pushed_line="$(grep -n "Pushed v$VERSION to origin" "$root/out" | cut -d: -f1)" || fail "tag push not reported: $(<"$root/out")"
(( pushed_line > published_line )) || fail "the tag was pushed before publishing"
grep -Fq "gh workflow run release-windows.yml -f tag=v$VERSION -f publish=true" "$root/out" ||
  fail "the release-windows next step is not printed: $(tail -n 5 "$root/out")"
pass "after publishing, annotated v$VERSION is pushed on HEAD and the Windows step is printed"

# 2. An existing tag takes the upload --clobber + --latest path.
root="$(make_root existing)"
GH_TAG_EXISTS=1 run_release "$root" "$root/out" --publish-only || fail "clobber path failed: $(<"$root/out")"
grep -q '^gh release upload v'"$VERSION"' .*Plyloft_'"$VERSION"'_aarch64.dmg.* --clobber' "$root/calls.log" ||
  fail "existing tag did not upload --clobber"
grep -q '^gh release edit v'"$VERSION"'.*--latest' "$root/calls.log" || fail "existing tag not marked --latest"
grep -q '^gh release create' "$root/calls.log" && fail "existing tag was created again"
pass "an existing tag takes the upload --clobber path"

# 3. A missing .sig stops with the file named and asks for a full run.
root="$(make_root nosig)"
rm "$root/src-tauri/target/$TARGET/release/bundle/macos/Plyloft.app.tar.gz.sig"
run_release "$root" "$root/out" --publish-only && fail "a missing .sig was published"
grep -Fq "Plyloft.app.tar.gz.sig" "$root/out" || fail "missing .sig not named: $(<"$root/out")"
grep -Fq "full ./scripts/release.sh run is needed" "$root/out" || fail "missing .sig did not ask for a full run"
grep -q '^gh release \(create\|upload\)' "$root/calls.log" && fail "published despite the missing .sig"
no_origin_tag "$root" "a missing .sig"
pass "a missing .sig stops with the file named"

# 4. An updater archive of another version stops with the file named.
root="$(make_root mismatch 1.0.0)"
run_release "$root" "$root/out" --publish-only && fail "a version mismatch was published"
grep -Fq "is version '1.0.0', not $VERSION" "$root/out" || fail "mismatch not reported: $(<"$root/out")"
grep -Fq "Plyloft.app.tar.gz" "$root/out" || fail "mismatch did not name the archive"
grep -q '^gh release \(create\|upload\)' "$root/calls.log" && fail "published despite the mismatch"
no_origin_tag "$root" "a version mismatch"
pass "an updater archive of another version stops with the file named"

# 5. Only an older DMG in the folder: stop, naming this version's DMG.
root="$(make_root olddmg)"
rm "$root/src-tauri/target/$TARGET/release/bundle/dmg/Plyloft_${VERSION}_aarch64.dmg"
run_release "$root" "$root/out" --publish-only && fail "an older DMG was published"
grep -Fq "Plyloft_${VERSION}_aarch64.dmg" "$root/out" || fail "missing DMG not named: $(<"$root/out")"
grep -q '^gh release' "$root/calls.log" && fail "reached gh release despite the missing DMG"
pass "only an older DMG present: stops, naming this version's DMG"

# 5b. A DMG without a valid notarization ticket stops before publishing.
root="$(make_root unstapled)"
STAPLE_INVALID=1 run_release "$root" "$root/out" --publish-only && fail "an unstapled DMG was published"
grep -Fq "no valid notarization ticket" "$root/out" || fail "unstapled DMG not reported: $(<"$root/out")"
grep -q '^gh release' "$root/calls.log" && fail "reached gh release despite the unstapled DMG"
no_origin_tag "$root" "an unstapled DMG"
pass "a DMG without a valid ticket stops before publishing"

# 5c. A corrupt updater archive stops with the file named.
root="$(make_root corrupt)"
echo "not a tarball" >"$root/src-tauri/target/$TARGET/release/bundle/macos/Plyloft.app.tar.gz"
run_release "$root" "$root/out" --publish-only && fail "a corrupt archive was published"
grep -Fq "cannot be unpacked" "$root/out" || fail "corrupt archive not reported: $(<"$root/out")"
pass "a corrupt updater archive stops with the file named"

# 6. Upload failures are retried; a transient failure then succeeds.
root="$(make_root retry)"
GH_TAG_EXISTS=1 GH_FAILS=2 run_release "$root" "$root/out" --publish-only ||
  fail "a transient upload failure was not retried: $(<"$root/out")"
[[ "$(grep -c '^gh release upload' "$root/calls.log")" == 3 ]] || fail "expected 3 upload attempts"
pass "transient upload failures are retried"

# 7. A persistent failure gives up; the message ends with the resume command.
root="$(make_root giveup)"
GH_FAILS=99 PLY_RELEASE_UPLOAD_ATTEMPTS=3 run_release "$root" "$root/out" --publish-only &&
  fail "a persistent upload failure passed"
[[ "$(grep -c '^gh release create' "$root/calls.log")" == 3 ]] || fail "expected 3 create attempts"
[[ "$(tail -n 1 "$root/out")" == "./scripts/release.sh --publish-only" ]] ||
  fail "failure message does not end with the resume command: $(tail -n 3 "$root/out")"
no_origin_tag "$root" "a failed publish"
pass "a persistent upload failure ends with ./scripts/release.sh --publish-only"

# 8. The full run notarizes and publishes this version's DMG, not the older
#    one, and retries the upload too.
root="$(make_root full)"
mkdir -p "$root/home/.tauri" && echo key >"$root/home/.tauri/ply.key"
GH_FAILS=1 run_release "$root" "$root/out" || fail "full run failed: $(<"$root/out")"
grep -q "^xcrun notarytool submit .*bundle/dmg/Plyloft_${VERSION}_aarch64.dmg" "$root/calls.log" ||
  fail "full run did not notarize this version's DMG"
grep -Fq "Plyloft_1.0.0" "$root/calls.log" && fail "full run used the older DMG"
[[ "$(grep -c '^gh release create' "$root/calls.log")" == 2 ]] || fail "full run did not retry the upload"
[[ "$(origin_tag "$root")" == "$(head_of "$root")" ]] || fail "the full run did not push v$VERSION on HEAD"
grep -q "^check-no-release --dist dist --binary .*Plyloft.app/Contents/MacOS/atelier$" "$root/calls.log" ||
  fail "the full run did not check the build for the app tester's bridge"
pass "the full run uses this version's DMG and retries the upload"

# 8b. latest.json keeps the other platforms of the same version only.
feed() { # file, version — an existing tag's latest.json with a Windows entry
  jq -n --arg v "$2" '{version:$v, notes:"old notes", pub_date:"2020-01-01T00:00:00Z",
    platforms:{"darwin-aarch64":{signature:"OLD-MAC-SIG", url:"https://example/old.tar.gz"},
               "windows-x86_64":{signature:"WIN-SIG", url:"https://example/Plyloft_x64-setup.exe"}}}' >"$1"
}
bundle_json() { echo "$1/src-tauri/target/$TARGET/release/bundle/latest.json"; }

# No existing release: darwin-aarch64 only, and the missing release is not an error.
root="$(make_root feed-none)"
run_release "$root" "$root/out" --publish-only || fail "no-release publish failed: $(<"$root/out")"
jq -e '.platforms | keys == ["darwin-aarch64"]' "$(bundle_json "$root")" >/dev/null ||
  fail "no existing release: expected darwin-aarch64 only: $(cat "$(bundle_json "$root")")"
grep -Fq "Platforms kept from an existing latest.json: none" "$root/out" || fail "kept platforms not reported: $(<"$root/out")"
pass "no existing release: latest.json has darwin-aarch64 only"

# Same version with windows-x86_64: both kept, darwin refreshed, the rest refreshed.
root="$(make_root feed-same)"
feed "$root/feed.json" "$VERSION"
GH_TAG_EXISTS=1 GH_FEED_JSON="$root/feed.json" RELEASE_NOTES="new notes" \
  run_release "$root" "$root/out" --publish-only || fail "same-version publish failed: $(<"$root/out")"
jq -e --arg v "$VERSION" '
  .version == $v and .notes == "new notes" and .pub_date != "2020-01-01T00:00:00Z"
  and (.platforms | keys == ["darwin-aarch64", "windows-x86_64"])
  and (.platforms["darwin-aarch64"].signature | test("SIGNATURE"))
  and (.platforms["darwin-aarch64"].url | endswith("/v" + $v + "/Plyloft.app.tar.gz"))
  and .platforms["windows-x86_64"] == {signature:"WIN-SIG", url:"https://example/Plyloft_x64-setup.exe"}' \
  "$(bundle_json "$root")" >/dev/null ||
  fail "same version: windows-x86_64 not kept or darwin not refreshed: $(cat "$(bundle_json "$root")")"
grep -Fq "Platforms kept from v$VERSION's latest.json: windows-x86_64" "$root/out" ||
  fail "kept platforms not reported: $(<"$root/out")"
grep -q '^gh release upload v'"$VERSION"' .*latest.json .*--clobber' "$root/calls.log" || fail "merged latest.json not uploaded"
pass "same-version latest.json: windows-x86_64 kept, darwin-aarch64 refreshed"

# An older version's latest.json on the tag: darwin-aarch64 only.
root="$(make_root feed-old)"
feed "$root/feed.json" "1.0.0"
GH_TAG_EXISTS=1 GH_FEED_JSON="$root/feed.json" run_release "$root" "$root/out" --publish-only ||
  fail "older-version publish failed: $(<"$root/out")"
jq -e --arg v "$VERSION" '.version == $v and (.platforms | keys == ["darwin-aarch64"])
  and (.platforms["darwin-aarch64"].signature | test("SIGNATURE"))' "$(bundle_json "$root")" >/dev/null ||
  fail "older version: another version's platform was carried: $(cat "$(bundle_json "$root")")"
grep -Fq "is version '1.0.0', not $VERSION" "$root/out" || fail "older version not reported: $(<"$root/out")"
pass "older-version latest.json: darwin-aarch64 only"

# An unparseable latest.json on the tag: darwin-aarch64 only.
root="$(make_root feed-bad)"
echo "{not json" >"$root/feed.json"
GH_TAG_EXISTS=1 GH_FEED_JSON="$root/feed.json" run_release "$root" "$root/out" --publish-only ||
  fail "unparseable-feed publish failed: $(<"$root/out")"
jq -e '.platforms | keys == ["darwin-aarch64"]' "$(bundle_json "$root")" >/dev/null ||
  fail "unparseable feed: expected darwin-aarch64 only"
pass "unparseable latest.json: darwin-aarch64 only"

# The tag has a latest.json that can't be downloaded: stop, never drop Windows.
root="$(make_root feed-fail)"
feed "$root/feed.json" "$VERSION"
GH_TAG_EXISTS=1 GH_FEED_JSON="$root/feed.json" GH_DOWNLOAD_FAILS=1 PLY_RELEASE_UPLOAD_ATTEMPTS=2 \
  run_release "$root" "$root/out" --publish-only && fail "published without reading the tag's latest.json"
[[ "$(grep -c '^gh release download' "$root/calls.log")" == 2 ]] || fail "expected 2 download attempts"
grep -q '^gh release \(create\|upload\)' "$root/calls.log" && fail "uploaded despite the failed download"
[[ "$(tail -n 1 "$root/out")" == "./scripts/release.sh --publish-only" ]] ||
  fail "download failure does not end with the resume command: $(tail -n 3 "$root/out")"
pass "a latest.json that can't be read stops before publishing"

# 10. Source tag. Already on origin at HEAD: fine, said so, nothing re-pushed.
root="$(make_root tag-same)"
git -C "$root" tag -a "v$VERSION" -m "Plyloft $VERSION" && git -C "$root" push -q origin "refs/tags/v$VERSION"
before="$(git -C "$root.origin.git" rev-parse "refs/tags/v$VERSION")"
run_release "$root" "$root/out" --publish-only || fail "an existing tag at HEAD failed: $(<"$root/out")"
grep -Fq "already on origin" "$root/out" || fail "the existing tag not reported: $(<"$root/out")"
grep -Fq "Pushed v$VERSION" "$root/out" && fail "an existing tag was pushed again"
[[ "$(git -C "$root.origin.git" rev-parse "refs/tags/v$VERSION")" == "$before" ]] || fail "the existing tag changed"
pass "a tag already on origin at HEAD: fine, not pushed again"

# Only local, at HEAD (a run whose push failed): it is pushed.
root="$(make_root tag-local)"
git -C "$root" tag -a "v$VERSION" -m "Plyloft $VERSION"
run_release "$root" "$root/out" --publish-only || fail "a local tag at HEAD failed: $(<"$root/out")"
[[ "$(origin_tag "$root")" == "$(head_of "$root")" ]] || fail "the local tag was not pushed"
pass "a local tag at HEAD is pushed"

# Only on origin, at HEAD (released from another checkout): fine.
root="$(make_root tag-remote)"
git -C "$root" tag -a "v$VERSION" -m "Plyloft $VERSION" && git -C "$root" push -q origin "refs/tags/v$VERSION"
git -C "$root" tag -d "v$VERSION" >/dev/null
run_release "$root" "$root/out" --publish-only || fail "a tag only on origin failed: $(<"$root/out")"
grep -Fq "already on origin" "$root/out" || fail "the origin tag not reported: $(<"$root/out")"
pass "a tag only on origin at HEAD: fine"

# On the release commit while HEAD is the merge that brought it to main
# unchanged (v1.152.0): same tree, so the same source. Not moved.
root="$(make_root tag-sametree)"
git -C "$root" tag -a "v$VERSION" -m "Plyloft $VERSION" && git -C "$root" push -q origin "refs/tags/v$VERSION"
tagged="$(head_of "$root")"
git -C "$root" commit -q --allow-empty -m "Merge pull request #1" && git -C "$root" push -q origin main
run_release "$root" "$root/out" --publish-only || fail "a tag on the same tree failed: $(<"$root/out")"
[[ "$(origin_tag "$root")" == "$tagged" ]] || fail "a tag on the same tree was moved"
pass "a tag on another commit with HEAD's tree: fine, not moved"

# On another commit: stop before building, nothing published, tag untouched.
root="$(make_root tag-other)"
tagged="$(head_of "$root")"
git -C "$root" tag -a "v$VERSION" -m "Plyloft $VERSION" && git -C "$root" push -q origin "refs/tags/v$VERSION"
echo "change" >"$root/CHANGE" && git -C "$root" add CHANGE && git -C "$root" commit -q -m "a later change"
git -C "$root" push -q origin main
mkdir -p "$root/home/.tauri" && echo key >"$root/home/.tauri/ply.key"
run_release "$root" "$root/out" && fail "a tag on another commit was accepted"
grep -Fq "already exists (local) on another commit" "$root/out" || fail "the other commit not reported: $(<"$root/out")"
grep -Fq "never moved" "$root/out" || fail "the stop does not say the tag is never moved"
grep -Eq '^(npm|build-sidecar|xcrun notarytool submit)' "$root/calls.log" && fail "built despite the conflicting tag"
grep -q '^gh release \(create\|upload\)' "$root/calls.log" && fail "published despite the conflicting tag"
[[ "$(origin_tag "$root")" == "$tagged" ]] || fail "the conflicting tag was moved"
pass "a tag on another commit stops before building; nothing pushed"

# Only on origin, on another commit: the same stop.
root="$(make_root tag-other-remote)"
git -C "$root" tag -a "v$VERSION" -m "Plyloft $VERSION" && git -C "$root" push -q origin "refs/tags/v$VERSION"
git -C "$root" tag -d "v$VERSION" >/dev/null
tagged="$(head_of "$root")"
echo "change" >"$root/CHANGE" && git -C "$root" add CHANGE && git -C "$root" commit -q -m "a later change"
git -C "$root" push -q origin main
run_release "$root" "$root/out" --publish-only && fail "an origin tag on another commit was accepted"
grep -Fq "already exists (origin) on another commit" "$root/out" || fail "the origin conflict not reported: $(<"$root/out")"
grep -q '^gh release \(create\|upload\)' "$root/calls.log" && fail "published despite the origin conflict"
[[ "$(origin_tag "$root")" == "$tagged" ]] || fail "the origin tag was moved"
[[ -z "$(git -C "$root" tag -l "v$VERSION")" ]] || fail "a local tag was created"
pass "a tag only on origin, on another commit: stops; nothing pushed"

# A conflicting tag pushed while the release publishes: stop after publishing,
# say the Mac release is out, never move it.
root="$(make_root tag-race)"
git -C "$root" branch other && git -C "$root" checkout -q other
echo "change" >"$root/CHANGE" && git -C "$root" add CHANGE && git -C "$root" commit -q -m "elsewhere"
other="$(head_of "$root")"
git -C "$root" push -q origin other
git -C "$root" checkout -q main
GH_ON_PUBLISH="git -C '$root.origin.git' tag -a v$VERSION -m other $other" \
  run_release "$root" "$root/out" --publish-only && fail "a tag that appeared during the publish was accepted"
grep -Fq "The Mac release is published" "$root/out" || fail "the late conflict does not say the release is out: $(<"$root/out")"
[[ "$(origin_tag "$root")" == "$other" ]] || fail "the late conflicting tag was moved"
pass "a conflicting tag that appears while publishing stops, saying the release is out"

# The tag push is refused: exit non-zero with the command to push it.
root="$(make_root tag-refused)"
printf '#!/bin/sh\nwhile read -r old new ref; do case "$ref" in refs/tags/*) echo "tags refused" >&2; exit 1;; esac; done\n' \
  >"$root.origin.git/hooks/pre-receive"
chmod +x "$root.origin.git/hooks/pre-receive"
run_release "$root" "$root/out" --publish-only && fail "a refused tag push passed"
grep -Fq "git push origin refs/tags/v$VERSION" "$root/out" || fail "the refused push gives no command: $(<"$root/out")"
[[ -z "$(origin_tag "$root")" ]] || fail "the refused tag is on origin"
pass "a refused tag push fails with the command to push it"

# 11. HEAD's version files don't say $VERSION: stop before building.
root="$(make_root head-version)"
sed -i.bak "s/^version = \"$VERSION\"/version = \"1.0.0\"/" "$root/src-tauri/Cargo.toml" && rm "$root/src-tauri/Cargo.toml.bak"
git -C "$root" commit -q -am "cargo left behind" && git -C "$root" push -q origin main
mkdir -p "$root/home/.tauri" && echo key >"$root/home/.tauri/ply.key"
run_release "$root" "$root/out" && fail "a HEAD of another version was released"
grep -Fq "is not the $VERSION release commit" "$root/out" || fail "the version mismatch not reported: $(<"$root/out")"
grep -Fq "src-tauri/Cargo.toml:      1.0.0" "$root/out" || fail "the mismatching file not named: $(<"$root/out")"
grep -Eq '^(npm|build-sidecar|xcrun notarytool submit)' "$root/calls.log" && fail "built despite the version mismatch"
grep -q '^gh release' "$root/calls.log" && fail "reached gh release despite the version mismatch"
no_origin_tag "$root" "a HEAD version mismatch"
pass "HEAD's version files not $VERSION: stops before building"

# Uncommitted bump (the working tree says $VERSION, HEAD does not): the same stop.
root="$(make_root head-uncommitted)"
printf '{"version":"1.0.0"}\n' >"$root/package.json" && git -C "$root" commit -q -am "old" && git -C "$root" push -q origin main
printf '{"version":"%s"}\n' "$VERSION" >"$root/package.json"
run_release "$root" "$root/out" --publish-only && fail "an uncommitted bump was released"
grep -Fq "package.json:              1.0.0" "$root/out" || fail "HEAD's package.json not reported: $(<"$root/out")"
grep -q '^gh release' "$root/calls.log" && fail "reached gh release with an uncommitted bump"
no_origin_tag "$root" "an uncommitted bump"
pass "a bump not committed at HEAD: stops before publishing"

# Skills hub H9: a CHANGES.json entry after the version released stops it;
# one at or before it does not (the publish-only runs above have none at all).
root="$(make_root skill-version-later)"
mkdir -p "$root/src-tauri/resources/ply-skills"
printf '{"a":[{"version":"99.0.0","contentId":"x","summary":"s"}],"b":[{"version":"1.0.0","contentId":"y","summary":"s"}]}\n' \
  >"$root/src-tauri/resources/ply-skills/CHANGES.json"
git -C "$root" add -A && git -C "$root" commit -q -m "a skill ahead" && git -C "$root" push -q origin main
run_release "$root" "$root/out" --publish-only && fail "a skill version after the release was published"
grep -Fq "CHANGES.json lists a skill version after $VERSION: a 99.0.0" "$root/out" || fail "the later skill version not named: $(<"$root/out")"
grep -q '^gh release' "$root/calls.log" && fail "reached gh release with a later skill version"
no_origin_tag "$root" "a later skill version"
printf '{"b":[{"version":"1.0.0","contentId":"y","summary":"s"}]}\n' >"$root/src-tauri/resources/ply-skills/CHANGES.json"
git -C "$root" commit -q -am "renamed to the release" && git -C "$root" push -q origin main
run_release "$root" "$root/out" --publish-only || fail "skill versions at or before the release refused: $(<"$root/out")"
pass "a CHANGES.json entry after the release version: stops before publishing"

# 12. HEAD not on origin/main (not pushed): stop before building.
root="$(make_root head-unpushed)"
echo "change" >"$root/CHANGE" && git -C "$root" add CHANGE && git -C "$root" commit -q -m "not pushed"
mkdir -p "$root/home/.tauri" && echo key >"$root/home/.tauri/ply.key"
run_release "$root" "$root/out" && fail "an unpushed HEAD was released"
grep -Fq "is not on origin/main" "$root/out" || fail "the unpushed HEAD not reported: $(<"$root/out")"
grep -Fq "git push origin main" "$root/out" || fail "the unpushed stop gives no command"
grep -Eq '^(npm|build-sidecar|xcrun notarytool submit)' "$root/calls.log" && fail "built from an unpushed HEAD"
grep -q '^gh release' "$root/calls.log" && fail "reached gh release from an unpushed HEAD"
no_origin_tag "$root" "an unpushed HEAD"
pass "HEAD not on origin/main: stops before building"

# 9. Unknown arguments are refused before anything runs.
root="$(make_root badarg)"
run_release "$root" "$root/out" --publish && fail "an unknown argument was accepted"
[[ ! -s "$root/calls.log" ]] || fail "an unknown argument ran something"
run_release "$root" "$root/out" --publish-only extra && fail "an extra argument was accepted"
[[ ! -s "$root/calls.log" ]] || fail "an extra argument ran something"
pass "unknown or extra arguments are refused"

# 10. PLY_TEST_BRIDGE set: refused before anything runs (docs/app-tester/DESIGN.md).
root="$(make_root testbridge)"
PLY_TEST_BRIDGE=1 run_release "$root" "$root/out" && fail "a release with PLY_TEST_BRIDGE set was accepted"
grep -Fq "PLY_TEST_BRIDGE is set" "$root/out" || fail "the refusal does not name PLY_TEST_BRIDGE: $(<"$root/out")"
[[ ! -s "$root/calls.log" ]] || fail "PLY_TEST_BRIDGE ran something"
pass "a release with PLY_TEST_BRIDGE set is refused"

# 11. Launch A2: an unconfigured Plyloft sign-in refuses the build before it runs.
root="$(make_root accountconfig)"
REFUSE_ACCOUNT_CONFIG=1 run_release "$root" "$root/out" && fail "a release without the sign-in configuration was accepted"
grep -Fq "PLYLOFT_GITHUB_CLIENT_ID in src-tauri/src/account.rs is empty" "$root/out" || fail "the refusal does not say why: $(<"$root/out")"
grep -v "^check-account-config" "$root/calls.log" | grep -q . && fail "an unconfigured sign-in ran something: $(<"$root/calls.log")"
pass "a release whose Plyloft sign-in is not configured is refused"

# 12. W5: the site changelog draft. Its transform has its own tests.
node "$SCRIPT_DIR/site-changelog.test.mjs" >/dev/null || fail "site-changelog.test.mjs failed"
site_root() { # name, STATUS top version — a root with the script, STATUS.md and a site repo
  local root; root="$(make_root "$1")"
  cp "$SCRIPT_DIR/site-changelog.mjs" "$root/scripts/"
  mkdir -p "$root/docs"
  printf '# Status\n\n## v%s — a test release: more\n\n**What.**\n- *A thing (A1).* It works. More.\n' "$2" >"$root/docs/STATUS.md"
  git -C "$root" add -A && git -C "$root" commit -q -m "status" && git -C "$root" push -q origin main
  mkdir -p "$root/home/code/plyloft-site/src/data"
  printf "export const RELEASES: Release[] = [\n];\n\nexport const SINCE = { count: 7, from: 'x' };\n" \
    >"$root/home/code/plyloft-site/src/data/releases.ts"
  git -C "$root/home/code/plyloft-site" init -q -b main
  git -C "$root/home/code/plyloft-site" add -A && git -C "$root/home/code/plyloft-site" commit -q -m site
  echo "$root"
}
root="$(site_root site-ok "$VERSION")"
run_release "$root" "$root/out" --publish-only || fail "the site changelog step failed the release: $(<"$root/out")"
site_ts="$root/home/code/plyloft-site/src/data/releases.ts"
grep -Fq "v: '$VERSION', date: '$(date +%Y-%m-%d)', title: 'A test release'," "$site_ts" || fail "no draft entry: $(<"$site_ts")"
grep -Fq "'A thing: It works.'," "$site_ts" || fail "the draft note is wrong: $(<"$site_ts")"
grep -Fq "count: 8," "$site_ts" || fail "SINCE.count not bumped"
[[ -n "$(git -C "$root/home/code/plyloft-site" status --porcelain)" ]] || fail "the draft was committed"
[[ "$(git -C "$root/home/code/plyloft-site" rev-list --count HEAD)" == 1 ]] || fail "the site repo got a commit"
grep -Fq "Left uncommitted for your review" "$root/out" || fail "the review step is not said: $(<"$root/out")"
pass "the site changelog draft is written from STATUS.md and left uncommitted"

root="$(site_root site-wrong 1.0.0)"
run_release "$root" "$root/out" --publish-only || fail "a STATUS of another version failed the release: $(<"$root/out")"
grep -Fq "top entry is v1.0.0, not v$VERSION" "$root/out" || fail "the skipped draft does not say why: $(<"$root/out")"
grep -Fq "the release itself is fine" "$root/out" || fail "the skip is not said to be harmless"
[[ -z "$(git -C "$root/home/code/plyloft-site" status --porcelain)" ]] || fail "a draft was written for another version"
pass "a STATUS top entry of another version: no draft, the release still passes"

root="$(make_root site-none)"
run_release "$root" "$root/out" --publish-only || fail "a missing site failed the release: $(<"$root/out")"
grep -Fq "Skipped:" "$root/out" || fail "the missing site is not said: $(<"$root/out")"
pass "no site repository: the step is skipped"

# 13. D26: the user guide's site copy. Its transform has its own tests.
node "$SCRIPT_DIR/site-guide.test.mjs" >/dev/null || fail "site-guide.test.mjs failed"
guide_root() { # name — a root with the guide and site-guide.mjs, and a site repo with no copy
  local root; root="$(make_root "$1")"
  cp "$SCRIPT_DIR/site-guide.mjs" "$root/scripts/"
  mkdir -p "$root/docs/onboarding"
  printf '# Getting started with Plyloft\n\n<!-- tour:base.one -->\n1. **One.**\n' >"$root/docs/onboarding/USER_GUIDE.md"
  git -C "$root" add -A && git -C "$root" commit -q -m "guide" && git -C "$root" push -q origin main
  local site="$root/home/code/plyloft-site"
  mkdir -p "$site/src/content/docs/docs"
  echo "---" >"$site/src/content/docs/docs/index.mdx"
  git -C "$site" init -q -b main
  git -C "$site" add -A && git -C "$site" commit -q -m site
  echo "$root"
}
site_guide_of() { echo "$1/home/code/plyloft-site/src/content/docs/docs/guide.md"; }
write_site_guide() { # root — writes the copy from the root's guide and commits it in the site
  node "$1/scripts/site-guide.mjs" --write --guide "$1/docs/onboarding/USER_GUIDE.md" --out "$(site_guide_of "$1")" >/dev/null
  git -C "$1/home/code/plyloft-site" add -A && git -C "$1/home/code/plyloft-site" commit -q -m "guide"
}
refused_before_publishing() { # root, what
  grep -Fq "Nothing was built or pushed." "$1/out" || fail "$2: the refusal does not say nothing happened: $(<"$1/out")"
  grep -Eq '^(npm|build-sidecar|xcrun notarytool submit)' "$1/calls.log" && fail "$2: built anyway"
  grep -q '^gh release' "$1/calls.log" && fail "$2: reached gh release"
  no_origin_tag "$1" "$2"
}

# The site has no copy yet: refused, with the commands to write and commit it.
root="$(guide_root guide-missing)"
mkdir -p "$root/home/.tauri" && echo key >"$root/home/.tauri/ply.key"
run_release "$root" "$root/out" && fail "a release without the guide's site copy was accepted"
grep -Fq "The site has no copy of this commit's user guide on its main branch" "$root/out" ||
  fail "the missing copy not reported: $(<"$root/out")"
grep -Fq "The site has no copy of the user guide yet: $root/home/code/plyloft-site (main):src/content/docs/docs/guide.md" \
  "$root/out" || fail "the reason is not said: $(<"$root/out")"
# ($root may spell TMPDIR's slash twice; release.sh's own root is its pwd.)
grep -Fq "/scripts/site-guide.mjs\" --write --guide /tmp/USER_GUIDE.md --out \"$root/home/code/plyloft-site/src/content/docs/docs/guide.md\"" \
  "$root/out" || fail "no command to write the copy: $(<"$root/out")"
grep -Eq '^    git -C "[^"]+/guide-missing" show HEAD:docs/onboarding/USER_GUIDE.md > /tmp/USER_GUIDE.md$' "$root/out" ||
  fail "no command to take HEAD's guide"
refused_before_publishing "$root" "a missing site copy"
pass "the user guide with no copy on the site: refused before building"

# The copy is of an older guide: refused, --publish-only too.
root="$(guide_root guide-stale)"
write_site_guide "$root"
printf '\nA new paragraph.\n' >>"$root/docs/onboarding/USER_GUIDE.md"
git -C "$root" commit -q -am "guide changed" && git -C "$root" push -q origin main
run_release "$root" "$root/out" --publish-only && fail "a guide changed since its site copy was published"
grep -Fq "is not this guide" "$root/out" || fail "the stale copy not reported: $(<"$root/out")"
refused_before_publishing "$root" "a stale site copy"
pass "a user guide changed since its site copy: refused before publishing"

# An uncommitted change to the guide doesn't count: HEAD's guide is the one checked.
root="$(guide_root guide-head)"
write_site_guide "$root"
printf '\nNot committed.\n' >>"$root/docs/onboarding/USER_GUIDE.md"
run_release "$root" "$root/out" --publish-only || fail "HEAD's guide matching its copy was refused: $(<"$root/out")"
grep -Fq "The site's copy of the user guide matches HEAD's" "$root/out" || fail "the match is not said: $(<"$root/out")"
pass "HEAD's guide is the one compared, not the working tree's"

# The copy matches but isn't committed in the site: refused, and said so.
root="$(guide_root guide-uncommitted)"
node "$root/scripts/site-guide.mjs" --write --guide "$root/docs/onboarding/USER_GUIDE.md" --out "$(site_guide_of "$root")" >/dev/null
run_release "$root" "$root/out" --publish-only && fail "an uncommitted site copy was accepted"
grep -Fq "The checkout's file is this guide's copy, but it isn't committed on main." "$root/out" ||
  fail "the uncommitted copy not reported: $(<"$root/out")"
refused_before_publishing "$root" "an uncommitted site copy"
pass "a matching site copy not committed in the site: refused"

# The copy is committed on another branch the site's checkout is on: refused;
# main is what the site publishes. PLY_SITE_BRANCH names another branch.
root="$(guide_root guide-branch)"
git -C "$root/home/code/plyloft-site" switch -q -c draft
write_site_guide "$root"
run_release "$root" "$root/out" --publish-only && fail "a copy only on another site branch was accepted"
grep -Fq "on its main branch" "$root/out" || fail "the branch is not said: $(<"$root/out")"
refused_before_publishing "$root" "a copy on another site branch"
PLY_SITE_BRANCH=draft run_release "$root" "$root/out" --publish-only ||
  fail "PLY_SITE_BRANCH=draft with the copy on draft was refused: $(<"$root/out")"
grep -Fq "matches HEAD's (src/content/docs/docs/guide.md on draft)" "$root/out" || fail "the branch matched is not said"
pass "a copy committed only on another site branch: refused (PLY_SITE_BRANCH chooses the branch)"

# The copy is committed on main while the checkout is elsewhere: accepted.
root="$(guide_root guide-elsewhere)"
write_site_guide "$root"
git -C "$root/home/code/plyloft-site" switch -q -c other
printf 'edited by hand\n' >"$(site_guide_of "$root")"
run_release "$root" "$root/out" --publish-only || fail "main's committed copy was refused: $(<"$root/out")"
grep -Fq "matches HEAD's (src/content/docs/docs/guide.md on main)" "$root/out" || fail "the match is not said"
pass "the copy committed on main counts, whatever the site's checkout has"

# A guide that can't be made into a page (no title): refused, and said so.
root="$(guide_root guide-untitled)"
printf 'No title here.\n' >"$root/docs/onboarding/USER_GUIDE.md"
git -C "$root" commit -q -am "untitled" && git -C "$root" push -q origin main
run_release "$root" "$root/out" --publish-only && fail "an untitled guide was accepted"
grep -Fq "HEAD's user guide can't be made into the site's page" "$root/out" || fail "the untitled guide not reported: $(<"$root/out")"
refused_before_publishing "$root" "an untitled guide"
pass "a guide with no '# ' title: refused before publishing"

# The copy matches and is committed: the release goes on, and says so; a
# site main ahead of its origin is a warning only.
root="$(guide_root guide-ok)"
write_site_guide "$root"
git -C "$root/home/code/plyloft-site" update-ref refs/remotes/origin/main HEAD~1
run_release "$root" "$root/out" --publish-only || fail "a matching site copy was refused: $(<"$root/out")"
grep -Fq "The site's copy of the user guide matches HEAD's (src/content/docs/docs/guide.md on main)" "$root/out" ||
  fail "the match is not said: $(<"$root/out")"
grep -Fq "has 1 commit(s) not on origin/main: publish the site" "$root/out" || fail "the unpublished site is not said"
grep -q '^gh release create' "$root/calls.log" || fail "a matching site copy did not publish"
pass "a matching, committed site copy: the release goes on (an unpublished site is a warning)"

# A guide but no site repository: skipped, the release goes on.
root="$(guide_root guide-nosite)"
rm -rf "$root/home/code/plyloft-site"
run_release "$root" "$root/out" --publish-only || fail "a missing site repository failed the release: $(<"$root/out")"
grep -Fq "Skipped the user guide's site copy: no site repository at" "$root/out" || fail "the skip is not said: $(<"$root/out")"
pass "no site repository: the user guide's check is skipped"

# No guide at HEAD (every root above 13): skipped, said so.
grep -Fq "Skipped the user guide's site copy: HEAD has no docs/onboarding/USER_GUIDE.md" "$TEST_ROOT/site-none/out" ||
  fail "the skip without a guide is not said: $(<"$TEST_ROOT/site-none/out")"
pass "no user guide at HEAD: the check is skipped"

# 14. Site labels: warnings only, never a stop. The script has its own tests.
node "$SCRIPT_DIR/site-labels.test.mjs" >/dev/null || fail "site-labels.test.mjs failed"
grep -Fq "Skipped the site labels check: no site repository at" "$TEST_ROOT/guide-nosite/out" ||
  fail "no site repository: the labels skip is not said: $(<"$TEST_ROOT/guide-nosite/out")"
pass "no site repository: the site labels check is skipped"
labels_root() { # name — a guide root whose site copy is published, with the real script and the app's label sources
  local root f; root="$(guide_root "$1")"
  cp "$SCRIPT_DIR/site-labels.mjs" "$root/scripts/"
  for f in src/lib/cardLifecycle.ts src/lib/boardSemantics.ts src/lib/settingsNav.ts src/lib/setupSteps.ts \
    src/lib/sidebarNav.ts src/lib/challengerReview.ts src/lib/shippingPage.ts src/components/CardDetailPanel.tsx; do
    mkdir -p "$root/$(dirname "$f")" && cp "$SCRIPT_DIR/../$f" "$root/$f"
  done
  printf '\n- **Windows:** Windows 11, 64-bit (x64).\n' >>"$root/docs/onboarding/USER_GUIDE.md"
  git -C "$root" add -A && git -C "$root" commit -q -m "labels" && git -C "$root" push -q origin main
  write_site_guide "$root"
  echo "$root"
}

# A retired word on the site's main: warned about, and the release publishes.
root="$(labels_root labels-retired)"
site="$root/home/code/plyloft-site"
mkdir -p "$site/src/i18n" && printf "export default { step: 'Press Build done.' };\n" >"$site/src/i18n/en.ts"
git -C "$site" add -A && git -C "$site" commit -q -m "old word"
git -C "$site" update-ref refs/remotes/origin/main HEAD
run_release "$root" "$root/out" --publish-only || fail "a site label warning failed the release: $(<"$root/out")"
grep -Fq '⚠ Site labels: src/i18n/en.ts:1: "Build done" → "Finish and check"' "$root/out" ||
  fail "the retired word is not warned about: $(<"$root/out")"
grep -q '^gh release create' "$root/calls.log" || fail "the release did not publish after a site labels warning"
grep -Fq "the retired list drifted" "$root/out" && fail "the copied app sources made the retired list drift: $(<"$root/out")"
grep -Fq "commit(s) behind origin/main" "$root/out" && fail "a site main level with origin was said to be behind"
pass "a retired word on the site: a warning, and the release publishes"

# The local main behind origin/main: said, since the words may be fixed there.
git -C "$site" commit -q --allow-empty -m "fixed upstream"
git -C "$site" update-ref refs/remotes/origin/main HEAD
git -C "$site" reset -q --hard HEAD~1
run_release "$root" "$root/out" --publish-only || fail "a site main behind origin failed the release: $(<"$root/out")"
grep -Fq "⚠ Site labels read your local main, 1 commit(s) behind origin/main as last fetched" "$root/out" ||
  fail "a site main behind origin is not said: $(<"$root/out")"
pass "the site's main behind origin/main: said, the release goes on"

# The script failing outright (a stub exiting 1): the release still goes on.
root="$(labels_root labels-stub)"
printf '#!/usr/bin/env node\nconsole.log("⚠ Site labels: stub says no");\nprocess.exit(1);\n' >"$root/scripts/site-labels.mjs"
git -C "$root" commit -q -am "stub" && git -C "$root" push -q origin main
run_release "$root" "$root/out" --publish-only || fail "a failing site labels script failed the release: $(<"$root/out")"
grep -Fq "⚠ Site labels: stub says no" "$root/out" || fail "the script's line is not shown: $(<"$root/out")"
grep -q '^gh release create' "$root/calls.log" || fail "the release did not publish after the script failed"
pass "the site labels script exiting 1: shown, the release publishes"

# The notary preflight (check_notary_profile, shared with release-preflight.sh):
# Apple's 403 agreement answer and a missing profile each stop a full run
# before anything builds, with their own fix; a good profile goes on.
root="$(make_root notary)"
mkdir -p "$root/home/.tauri" && echo key >"$root/home/.tauri/ply.key"
NOTARY_FAIL=agreement run_release "$root" "$root/out" && fail "the agreement 403 did not stop the release"
grep -Fq "✗ notarytool preflight failed for profile 'ply-notary':" "$root/out" || fail "403 not reported: $(<"$root/out")"
grep -Fq "Apple is gating on an unaccepted/expired legal agreement" "$root/out" || fail "403 fix missing: $(<"$root/out")"
grep -Eq '^(npm|build-sidecar|xcrun notarytool submit)' "$root/calls.log" && fail "built despite the 403"
NOTARY_FAIL=missing run_release "$root" "$root/out" && fail "a missing profile did not stop the release"
grep -Fq "xcrun notarytool store-credentials \"ply-notary\"" "$root/out" || fail "missing profile fix absent: $(<"$root/out")"
run_release "$root" "$root/out" --publish-only || fail "--publish-only needs no notary profile: $(<"$root/out")"
pass "the notary preflight: the agreement 403 and a missing profile stop a full run, each with its fix"

echo "release.sh contract: all checks passed"
