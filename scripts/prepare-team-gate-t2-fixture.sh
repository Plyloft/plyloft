#!/usr/bin/env bash
# Exact T-2 seed renderer and owner-only bootstrap for
# docs/team-tier/T2_FIXTURE_CONTRACT.md section 4.2. --render-only and
# --self-test are local and harmless. --bootstrap-owner is single-use and may
# run only after the reviewed two-profile Stage-A preflight.
set -euo pipefail
shopt -s nullglob
export LC_ALL=C

REPO="MatteoB-adv/ply-team-gate-t2-fixture"
ORIGIN_URL="https://github.com/MatteoB-adv/ply-team-gate-t2-fixture.git"
DEST="/Users/plyval1/code/ply-team-gate-t2-fixture"
APP_DATA="/Users/plyval1/Library/Application Support/com.mbadv.ply"
CONTRACT_COMMIT="1a4f691d993601542a4bbee49e38b11d57fbcec9"
MCP="/Applications/Plyloft.app/Contents/MacOS/ply-mcp"
EXPECTED_ATELIER_SHA="a8fab57eab894fc331e2a70e73420ae2bb230fbddb0848406faa61052a2b0c73"
EXPECTED_MCP_SHA="74b8bab9c8159b4807b2e2b4fd78309ad8aea793d8727ea83006f26cc6544abe"

die() {
  printf 'condition=%s\nstatus=BOOTSTRAP_MISMATCH\n' "$1" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "missing_tool_$1"
}

render_tree() {
  local root="$1"
  [[ ! -e "$root" ]] || die "render_target_already_exists"
  mkdir -p "$root/.atelier/library/knowledge" "$root/.github" "$root/fixture"

  printf '%s\n' \
    '{' \
    '  "name": "Ply Team Gate T-2",' \
    '  "kanbanSyncMode": "local"' \
    '}' \
    > "$root/.atelier/workspace_default.json"

  printf '%s\n' \
    '---' \
    'schemaVersion: 1' \
    'id: t2-shared-baseline' \
    'title: T-2 shared baseline' \
    'tags:' \
    '- t2-validation' \
    'linkedCards: []' \
    'source:' \
    '  kind: manual' \
    'entryType: note' \
    "createdAt: '2026-08-19T20:00:00Z'" \
    "updatedAt: '2026-08-19T20:00:00Z'" \
    '---' \
    'This disposable entry binds the T-2 cross-clone shared read baseline.' \
    > "$root/.atelier/library/knowledge/t2-shared-baseline.md"

  printf '%s\n' '/fixture/owned.txt @MatteoB-adv' \
    > "$root/.github/CODEOWNERS"
  printf '%s\n' '.atelier/worktrees/' > "$root/.gitignore"
  printf '%s\n' \
    '# Ply Team Gate T-2 Fixture' \
    '' \
    'Disposable private two-identity validation fixture. No production data.' \
    > "$root/README.md"
  printf '%s\n' 'T-2 local-control sentinel on main.' \
    > "$root/fixture/control.txt"
  printf '%s\n' 'T-2 CODEOWNERS and overlap sentinel on main.' \
    > "$root/fixture/owned.txt"
}

expected_tree() {
  printf '%s\n' \
    '.atelier/library/knowledge/t2-shared-baseline.md' \
    '.atelier/workspace_default.json' \
    '.github/CODEOWNERS' \
    '.gitignore' \
    'README.md' \
    'fixture/control.txt' \
    'fixture/owned.txt'
}

verify_rendered_tree() {
  local root="$1" actual
  [[ -d "$root" && ! -L "$root" ]] || die "rendered_root_shape"
  actual="$(cd "$root" && find . -path './.git' -prune -o -type f -print \
    | sed 's#^./##' | sort)"
  [[ "$actual" == "$(expected_tree)" ]] || die "rendered_tree"
  if find "$root" -path "$root/.git" -prune -o -type l -print -quit | grep -q .; then
    die "rendered_symlink"
  fi
  jq -e '
    (keys | sort) == ["kanbanSyncMode", "name"] and
    .name == "Ply Team Gate T-2" and
    .kanbanSyncMode == "local" and
    ((.githubOwnerRepo // "") == "")
  ' "$root/.atelier/workspace_default.json" >/dev/null \
    || die "workspace_default_shape"
  [[ "$(<"$root/.github/CODEOWNERS")" == "/fixture/owned.txt @MatteoB-adv" ]] \
    || die "codeowners_bytes"
  [[ "$(<"$root/.gitignore")" == ".atelier/worktrees/" ]] \
    || die "gitignore_bytes"
  [[ "$(<"$root/fixture/control.txt")" == "T-2 local-control sentinel on main." ]] \
    || die "control_bytes"
  [[ "$(<"$root/fixture/owned.txt")" == "T-2 CODEOWNERS and overlap sentinel on main." ]] \
    || die "owned_bytes"
}

verify_fixture_bytes() {
  local root="$1" reference_parent reference relative mismatch=""
  reference_parent="$(mktemp -d /tmp/ply-t2-byte-reference.XXXXXX)"
  reference="$reference_parent/rendered"
  render_tree "$reference"
  while IFS= read -r relative; do
    if ! cmp -s "$reference/$relative" "$root/$relative"; then
      mismatch="$relative"
      break
    fi
  done < <(expected_tree)
  rm -rf "$reference_parent"
  [[ -z "$mismatch" ]] || die "fixture_byte_mismatch"
}

expected_untracked_tree() {
  expected_tree | sed 's/^/?? /'
}

successful_bootstrap_receipt_exists() {
  local receipt final_status
  for receipt in /Users/Shared/ply-team-t2-bootstrap-owner-*.log; do
    [[ -f "$receipt" && -r "$receipt" ]] || die "bootstrap_receipt_unreadable"
    final_status="$(tail -1 "$receipt")" || die "bootstrap_receipt_read"
    case "$final_status" in
      status=BOOTSTRAP_OWNER_COMPLETE) return 0 ;;
      status=BOOTSTRAP_MISMATCH) ;;
      *) die "bootstrap_receipt_status" ;;
    esac
  done
  return 1
}

verify_resumable_clone() {
  local root="$1" indexed
  [[ -d "$root" && ! -L "$root" && -d "$root/.git" && ! -L "$root/.git" ]] \
    || die "resume_clone_shape"
  [[ "$(git -C "$root" remote get-url origin)" == "$ORIGIN_URL" ]] \
    || die "resume_origin"
  [[ "$(git -C "$root" symbolic-ref --short HEAD)" == "main" ]] \
    || die "resume_branch"
  if git -C "$root" rev-parse --verify HEAD >/dev/null 2>&1; then
    die "resume_commit_present"
  fi
  indexed="$(git -C "$root" diff --cached --name-only)" \
    || die "resume_index_query"
  [[ -z "$indexed" ]] || die "resume_index_not_empty"
  verify_rendered_tree "$root"
  verify_fixture_bytes "$root"
  [[ "$(git -C "$root" status --porcelain --untracked-files=all)" == \
     "$(expected_untracked_tree)" ]] || die "resume_worktree_shape"
}

repository_shape_matches() {
  jq -e --arg repo "$REPO" '
    .nameWithOwner == $repo and
    .visibility == "PRIVATE" and
    .isEmpty == true and
    (.defaultBranchRef == null or .defaultBranchRef.name == "") and
    .viewerPermission == "ADMIN"
  ' >/dev/null
}

verify_installed_knowledge_decoder() {
  local root="$1" config output
  config="$(mktemp -d /tmp/ply-t2-mcp-config.XXXXXX)"
  output="$(
    printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ply-t2-fixture","version":"1"}}}' \
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"knowledge_search","arguments":{"query":"T-2 shared baseline","limit":10}}}' \
      | "$MCP" --config-dir "$config" --project-cwd "$root"
  )" || {
    rm -rf "$config"
    die "installed_knowledge_decoder"
  }
  rm -rf "$config"
  printf '%s\n' "$output" | jq -s -e '
    ([.[] | select(.id == 2) |
      .result.structuredContent.entries[] |
      select(.id == "t2-shared-baseline" and
             .title == "T-2 shared baseline" and
             .shared == true)] | length) == 1
  ' >/dev/null || die "installed_knowledge_result"
}

self_test() {
  local root root_parent restore restore_parent negative_parent negative
  root_parent="$(mktemp -d /tmp/ply-t2-render-self-test.XXXXXX)"
  root="$root_parent/rendered"
  render_tree "$root"
  verify_rendered_tree "$root"
  verify_fixture_bytes "$root"
  printf '%s\n' \
    '{"nameWithOwner":"MatteoB-adv/ply-team-gate-t2-fixture","visibility":"PRIVATE","isEmpty":true,"defaultBranchRef":null,"viewerPermission":"ADMIN"}' \
    '{"nameWithOwner":"MatteoB-adv/ply-team-gate-t2-fixture","visibility":"PRIVATE","isEmpty":true,"defaultBranchRef":{"name":""},"viewerPermission":"ADMIN"}' \
    | while IFS= read -r repository; do
        printf '%s' "$repository" | repository_shape_matches \
          || die "self_test_empty_repository_shape"
      done
  if printf '%s' \
    '{"nameWithOwner":"MatteoB-adv/ply-team-gate-t2-fixture","visibility":"PRIVATE","isEmpty":true,"defaultBranchRef":{"name":"main"},"viewerPermission":"ADMIN"}' \
    | repository_shape_matches; then
    die "self_test_default_branch_present"
  fi
  git -C "$root" init -q -b main
  git -C "$root" remote add origin "$ORIGIN_URL"
  verify_resumable_clone "$root"
  negative_parent="$(mktemp -d /tmp/ply-t2-resume-negative.XXXXXX)"
  negative="$negative_parent/wrong-origin"
  cp -R "$root" "$negative"
  git -C "$negative" remote set-url origin https://github.com/MatteoB-adv/wrong.git
  if (verify_resumable_clone "$negative") >/dev/null 2>&1; then
    die "self_test_resume_wrong_origin"
  fi
  negative="$negative_parent/wrong-branch"
  cp -R "$root" "$negative"
  git -C "$negative" symbolic-ref HEAD refs/heads/wrong
  if (verify_resumable_clone "$negative") >/dev/null 2>&1; then
    die "self_test_resume_wrong_branch"
  fi
  negative="$negative_parent/commit-present"
  cp -R "$root" "$negative"
  git -C "$negative" config user.name "Ply T-2 Self Test"
  git -C "$negative" config user.email "ply-t2-self-test@ply.invalid"
  git -C "$negative" commit --allow-empty -m "test: forbidden resume commit" >/dev/null
  if (verify_resumable_clone "$negative") >/dev/null 2>&1; then
    die "self_test_resume_commit_present"
  fi
  rm -rf "$negative_parent"
  printf '%s\n' unexpected > "$root/unexpected.txt"
  if (verify_resumable_clone "$root") >/dev/null 2>&1; then
    die "self_test_resume_extra_file"
  fi
  rm -f "$root/unexpected.txt"
  git -C "$root" add -- README.md
  if (verify_resumable_clone "$root") >/dev/null 2>&1; then
    die "self_test_resume_staged_file"
  fi
  rm -f "$root/.git/index"
  verify_resumable_clone "$root"
  printf '%s\n' corrupted > "$root/README.md"
  if (verify_resumable_clone "$root") >/dev/null 2>&1; then
    die "self_test_resume_byte_mismatch"
  fi
  restore_parent="$(mktemp -d /tmp/ply-t2-render-restore.XXXXXX)"
  restore="$restore_parent/rendered"
  render_tree "$restore"
  cp "$restore/README.md" "$root/README.md"
  rm -rf "$restore_parent"
  verify_resumable_clone "$root"
  rm -rf "$root_parent"
  printf 'status=T2_FIXTURE_SELF_TEST_COMPLETE\n'
}

installed_decoder_self_test() {
  local root root_parent
  root_parent="$(mktemp -d /tmp/ply-t2-installed-decoder-test.XXXXXX)"
  root="$root_parent/rendered"
  render_tree "$root"
  verify_rendered_tree "$root"
  [[ -x "$MCP" ]] || die "installed_mcp_missing"
  verify_installed_knowledge_decoder "$root"
  rm -rf "$root_parent"
  printf 'status=T2_INSTALLED_DECODER_COMPLETE\n'
}

case "${1:-}" in
  --render-only)
    [[ $# -eq 2 ]] || die "render_only_usage"
    require_tool jq
    render_tree "$2"
    verify_rendered_tree "$2"
    printf 'status=RENDER_COMPLETE\n'
    exit 0
    ;;
  --self-test)
    [[ $# -eq 1 ]] || die "self_test_usage"
    for tool in jq git mktemp cmp; do
      require_tool "$tool"
    done
    self_test
    exit 0
    ;;
  --installed-decoder-self-test)
    [[ $# -eq 1 ]] || die "installed_decoder_self_test_usage"
    for tool in jq mktemp; do
      require_tool "$tool"
    done
    installed_decoder_self_test
    exit 0
    ;;
  --bootstrap-owner)
    [[ $# -eq 1 ]] || die "bootstrap_owner_usage"
    ;;
  --verify-resume-owner)
    [[ $# -eq 1 ]] || die "verify_resume_owner_usage"
    ;;
  *) die "usage" ;;
esac

export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
for tool in jq git gh mktemp shasum codesign ps stat cmp; do
  require_tool "$tool"
done
[[ "$(id -un)" == "plyval1" && "$(id -u)" == "502" ]] \
  || die "wrong_owner_profile"
case " $(id -Gn) " in
  *" admin "*) die "profile_is_admin" ;;
esac
[[ "$(gh api user --jq .login)" == "MatteoB-adv" ]] || die "wrong_github_login"
case "$DEST" in
  /Users/mb|/Users/mb/*|*/ply-team-gate-t1-fixture|*/ply-team-gate-t1-fixture/*)
    die "protected_target"
    ;;
esac
[[ "$DEST" == "/Users/plyval1/code/ply-team-gate-t2-fixture" ]] \
  || die "destination_binding"

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
SCRIPT_SHA="$(shasum -a 256 "$SCRIPT_PATH" | awk '{print $1}')" \
  || die "helper_hash"

if [[ "$1" == "--verify-resume-owner" ]]; then
  [[ ! -e "$APP_DATA/pending_imports.json" ]] || die "pending_import_present"
  if successful_bootstrap_receipt_exists; then
    die "bootstrap_already_complete"
  fi
  verify_resumable_clone "$DEST"
  printf 'helper_sha256=%s\nstatus=T2_RESUME_PREFLIGHT_COMPLETE\n' "$SCRIPT_SHA"
  exit 0
fi

STAGE_A_RECEIPT=""
for candidate in /Users/Shared/ply-team-t2-stage-a-owner-*.log; do
  if [[ -z "$STAGE_A_RECEIPT" || "$candidate" > "$STAGE_A_RECEIPT" ]]; then
    STAGE_A_RECEIPT="$candidate"
  fi
done
[[ -n "$STAGE_A_RECEIPT" && -f "$STAGE_A_RECEIPT" ]] \
  || die "stage_a_receipt_missing"
[[ "$(tail -1 "$STAGE_A_RECEIPT")" == "status=STAGE_A_COMPLETE" ]] \
  || die "stage_a_not_complete"
STAGE_A_AGE=$(( $(date +%s) - $(stat -f %m "$STAGE_A_RECEIPT") ))
(( STAGE_A_AGE >= 0 && STAGE_A_AGE <= 3600 )) || die "stage_a_receipt_stale"

[[ ! -e "$APP_DATA/pending_imports.json" ]] || die "pending_import_present"
if successful_bootstrap_receipt_exists; then
  die "bootstrap_already_complete"
fi
BOOTSTRAP_MODE="fresh"
if [[ -e "$DEST" ]]; then
  verify_resumable_clone "$DEST"
  BOOTSTRAP_MODE="resume_rendered"
fi
[[ -x "$MCP" ]] || die "installed_mcp_missing"
[[ "$(shasum -a 256 /Applications/Plyloft.app/Contents/MacOS/atelier | awk '{print $1}')" == "$EXPECTED_ATELIER_SHA" ]] \
  || die "atelier_hash"
[[ "$(shasum -a 256 "$MCP" | awk '{print $1}')" == "$EXPECTED_MCP_SHA" ]] \
  || die "ply_mcp_hash"
codesign --verify --deep --strict --verbose=2 /Applications/Plyloft.app \
  || die "codesign_strict"

REPO_JSON="$(gh repo view "$REPO" \
  --json nameWithOwner,visibility,isEmpty,defaultBranchRef,viewerPermission)" \
  || die "repository_query"
printf '%s' "$REPO_JSON" | repository_shape_matches || die "repository_not_pristine"
[[ "$(gh api "repos/$REPO/issues?state=all&per_page=100" --jq length)" == "0" ]] \
  || die "remote_issue_or_pr_present"

EVIDENCE="/Users/Shared/ply-team-t2-bootstrap-owner-$(date -u '+%Y%m%dT%H%M%SZ').log"
exec > >(tee "$EVIDENCE") 2>&1
printf 'timestamp=%s\nuser=plyval1\nuid=502\nrepo=%s\ndest=%s\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$REPO" "$DEST"
printf 'contract_commit=%s\nhelper_sha256=%s\nstage_a_receipt=%s\n' \
  "$CONTRACT_COMMIT" "$SCRIPT_SHA" "$STAGE_A_RECEIPT"
printf 'bootstrap_mode=%s\n' "$BOOTSTRAP_MODE"

if [[ "$BOOTSTRAP_MODE" == "fresh" ]]; then
  mkdir -p "$(dirname "$DEST")"
  gh repo clone "$REPO" "$DEST" || die "clone_empty_repository"
  [[ -d "$DEST/.git" && ! -L "$DEST" ]] || die "clone_shape"
  git -C "$DEST" remote set-url origin "$ORIGIN_URL" \
    || die "clone_origin_normalize"
  [[ -z "$(find "$DEST" -mindepth 1 -maxdepth 1 ! -name .git -print -quit)" ]] \
    || die "empty_clone_not_empty"
  [[ "$(git -C "$DEST" branch --show-current)" == "main" ]] || die "clone_branch"

  REFERENCE_PARENT="$(mktemp -d /tmp/ply-t2-bootstrap-render.XXXXXX)"
  REFERENCE="$REFERENCE_PARENT/rendered"
  render_tree "$REFERENCE"
  verify_rendered_tree "$REFERENCE"
  verify_fixture_bytes "$REFERENCE"
  cp -R "$REFERENCE/." "$DEST/"
  rm -rf "$REFERENCE_PARENT"
fi
verify_resumable_clone "$DEST"
verify_installed_knowledge_decoder "$DEST"

git -C "$DEST" config user.name "Ply T-2 Owner Fixture"
git -C "$DEST" config user.email "ply-t2-owner@ply.invalid"
git -C "$DEST" add -- \
  .atelier/library/knowledge/t2-shared-baseline.md \
  .atelier/workspace_default.json \
  .github/CODEOWNERS .gitignore README.md fixture/control.txt fixture/owned.txt
[[ "$(git -C "$DEST" diff --cached --name-only)" == "$(expected_tree)" ]] \
  || die "staged_tree"
git -C "$DEST" commit -m "chore: seed disposable T-2 fixture" \
  || die "seed_commit"
[[ "$(git -C "$DEST" show -s --format=%s HEAD)" == "chore: seed disposable T-2 fixture" ]] \
  || die "seed_commit_subject"
[[ "$(git -C "$DEST" show -s --format='%an <%ae>' HEAD)" == \
   "Ply T-2 Owner Fixture <ply-t2-owner@ply.invalid>" ]] \
  || die "seed_commit_author"
[[ "$(git -C "$DEST" ls-files)" == "$(expected_tree)" ]] || die "committed_tree"
[[ -z "$(git -C "$DEST" status --porcelain --untracked-files=all)" ]] \
  || die "clone_dirty_before_push"
git -C "$DEST" push -u origin main || die "push_main"

MAIN_COMMIT="$(git -C "$DEST" rev-parse HEAD)"
[[ "$(gh api "repos/$REPO/commits/main" --jq .sha)" == "$MAIN_COMMIT" ]] \
  || die "remote_main_commit"
[[ "$(gh api "repos/$REPO/issues?state=all&per_page=100" --jq length)" == "0" ]] \
  || die "remote_issue_or_pr_after_seed"
REMOTE_BRANCHES="$(gh api --paginate "repos/$REPO/branches" --jq '.[].name')" \
  || die "remote_branches_query"
[[ "$REMOTE_BRANCHES" == "main" ]] || die "remote_branches"
gh label list --repo "$REPO" --limit 100 --json name \
  | jq -e 'all(.[]; (.name | startswith("status:")) | not)' >/dev/null \
  || die "status_label_present"

printf 'main_commit=%s\n' "$MAIN_COMMIT"
while IFS= read -r relative; do
  printf 'file_sha256=%s %s\n' \
    "$(shasum -a 256 "$DEST/$relative" | awk '{print $1}')" "$relative"
done < <(expected_tree)
printf 'evidence=%s\nstatus=BOOTSTRAP_OWNER_COMPLETE\n' "$EVIDENCE"
