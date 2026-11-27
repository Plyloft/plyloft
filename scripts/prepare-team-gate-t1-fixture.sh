#!/usr/bin/env bash
# Build the exact disposable repository frozen in
# docs/team-tier/T1_FIXTURE_CONTRACT.md. The external bootstrap mode is
# intentionally single-use and profile-bound. --render-only is the harmless
# local path used by the production-decoder Rust test.
set -euo pipefail

REPO="MatteoB-adv/ply-team-gate-t1-fixture"
DEST="/Users/plyval1/code/ply-team-gate-t1-fixture"
APP_DATA="/Users/plyval1/Library/Application Support/com.mbadv.ply"
QUEUE="$APP_DATA/pending_imports.json"
OVERLAP_BRANCH="ply-t1/overlap-pr"

die() {
  printf 'condition=%s\nstatus=FIXTURE_MISMATCH\n' "$1" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "missing_tool_$1"
}

render_tree() {
  local root="$1"
  [[ ! -e "$root" ]] || die "render_target_already_exists"
  mkdir -p \
    "$root/.atelier/library/knowledge" \
    "$root/.github" \
    "$root/fixture" \
    "$root/scripts"

  jq -n '{
    name: "Ply Team Gate T-1",
    accentColor: "#2563eb",
    layoutPreset: "single",
    kanbanSyncMode: "local",
    githubOwnerRepo: "MatteoB-adv/ply-team-gate-t1-fixture"
  }' > "$root/.atelier/workspace_default.json"

  jq -n '{
    version: 1,
    prompts: [{
      id: "t1-shared-prompt",
      name: "T-1 shared prompt",
      description: "Disposable Team-gate validation fixture.",
      systemPrompt: "Stay inside the disposable T-1 fixture.",
      promptTemplate: "Report the fixture state without external writes.",
      tags: ["t1-validation"],
      createdAt: 1785787200000,
      updatedAt: 1785787200000,
      author: "fixture@ply.invalid",
      lastEditedBy: "fixture@ply.invalid"
    }]
  }' > "$root/.atelier/library/prompts.json"

  jq -n '{
    version: 1,
    templates: [{
      id: "t1-shared-workspace-template",
      label: "T-1 shared workspace template",
      description: "Disposable Team-gate validation fixture.",
      tiles: [{kind: "shell"}],
      createdAt: 1785787200000,
      updatedAt: 1785787200000,
      author: "fixture@ply.invalid",
      lastEditedBy: "fixture@ply.invalid"
    }]
  }' > "$root/.atelier/library/templates.json"

  jq -n '{
    version: 1,
    templates: [{
      schemaVersion: 1,
      id: "t1-shared-swarm-template",
      label: "T-1 shared swarm template",
      description: "Disposable Team-gate validation fixture.",
      steps: [{role: "scout", expectsArtifact: false}],
      maxIterations: 1,
      maxWallSeconds: 60,
      builtin: false,
      coordinator: false,
      outputKind: "code",
      createdAt: 1785787200000,
      updatedAt: 1785787200000,
      author: "fixture@ply.invalid",
      lastEditedBy: "fixture@ply.invalid"
    }]
  }' > "$root/.atelier/library/swarm_templates.json"

  printf '%s\n' \
    '---' \
    'schemaVersion: 1' \
    'id: t1-shared-knowledge' \
    'title: T-1 shared knowledge' \
    'tags:' \
    '- t1-validation' \
    'linkedCards: []' \
    'source:' \
    '  kind: manual' \
    'entryType: note' \
    "createdAt: '2026-08-03T20:00:00Z'" \
    "updatedAt: '2026-08-03T20:00:00Z'" \
    '---' \
    'This disposable entry exists only to exercise the production shared Knowledge' \
    'promote, demote, and fork paths.' \
    > "$root/.atelier/library/knowledge/t1-shared-knowledge.md"

  printf '%s\n' '/fixture/owned.txt @MatteoB-adv' \
    > "$root/.github/CODEOWNERS"
  printf '%s\n' 'T-1 CODEOWNERS sentinel on main.' > "$root/fixture/owned.txt"
  printf '%s\n' 'T-1 overlap sentinel on main.' > "$root/fixture/overlap.txt"
  printf '%s\n' 'T-1 expired create/patch sentinel on main.' > "$root/fixture/drift.txt"

  jq -n '{
    name: "ply-team-gate-t1-fixture",
    private: true,
    version: "0.0.0"
  }' > "$root/package.json"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    '' \
    'ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"' \
    'test -f "$ROOT/.atelier/workspace_default.json"' \
    'test -f "$ROOT/.atelier/library/prompts.json"' \
    'test -f "$ROOT/.atelier/library/templates.json"' \
    'test -f "$ROOT/.atelier/library/swarm_templates.json"' \
    'test -f "$ROOT/.atelier/library/knowledge/t1-shared-knowledge.md"' \
    'test -f "$ROOT/.github/CODEOWNERS"' \
    'test -f "$ROOT/fixture/owned.txt"' \
    'test -f "$ROOT/fixture/overlap.txt"' \
    'test -f "$ROOT/fixture/drift.txt"' \
    'jq -e '\''.name == "Ply Team Gate T-1" and' \
    '       .kanbanSyncMode == "local" and' \
    '       .githubOwnerRepo == "MatteoB-adv/ply-team-gate-t1-fixture"'\'' \' \
    '  "$ROOT/.atelier/workspace_default.json" >/dev/null' \
    'git -C "$ROOT" diff --check' \
    "printf 'T-1 verify fixture passed\\n'" \
    > "$root/scripts/verify.sh"
  chmod 755 "$root/scripts/verify.sh"

  printf '%s\n' \
    '# Ply Team gate T-1 fixture' \
    '' \
    'Disposable private repository for the Ply v1.100.0 Team-entitlement walk.' \
    'Never use it for production work, real credentials, or owner data.' \
    > "$root/README.md"
}

if [[ "${1:-}" == "--render-only" ]]; then
  [[ $# -eq 2 ]] || die "render_only_usage"
  require_tool jq
  render_tree "$2"
  printf 'status=RENDER_COMPLETE\n'
  exit 0
fi

[[ "${1:-}" == "--bootstrap" && $# -eq 1 ]] || die "bootstrap_usage"

export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
for tool in jq git gh claude mktemp shasum; do
  require_tool "$tool"
done

[[ "$(id -un)" == "plyval1" ]] || die "wrong_macos_user"
case " $(id -Gn) " in
  *" admin "*) die "profile_is_admin" ;;
esac
[[ "$(id -u)" == "502" ]] || die "wrong_uid"
[[ "$(gh api user --jq .login)" == "MatteoB-adv" ]] || die "wrong_github_login"
claude auth status | jq -e '
  .loggedIn == true and
  .authMethod == "claude.ai" and
  .apiProvider == "firstParty" and
  .subscriptionType == "max"
' >/dev/null || die "wrong_claude_auth"

[[ ! -e "$APP_DATA" ]] || die "stage_a_app_data_changed"
[[ ! -e "$DEST" ]] || die "FIXTURE_TARGET_ALREADY_EXISTS"
[[ -n "$(git config --global user.name || true)" ]] || die "missing_git_user_name"
[[ -n "$(git config --global user.email || true)" ]] || die "missing_git_user_email"

API_ERR="$(mktemp /tmp/ply-t1-repo-check.XXXXXX)"
trap 'rm -f "$API_ERR"' EXIT
if gh api "repos/$REPO" >/dev/null 2>"$API_ERR"; then
  die "FIXTURE_TARGET_ALREADY_EXISTS"
fi
grep -Eq 'HTTP 404|Not Found' "$API_ERR" || die "fixture_remote_absence_unproven"

EVIDENCE="/Users/Shared/ply-team-t1-bootstrap-$(date -u '+%Y%m%dT%H%M%SZ').log"
exec > >(tee "$EVIDENCE") 2>&1
printf 'timestamp=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'user=%s\nuid=%s\nrepo=%s\ndest=%s\n' \
  "$(id -un)" "$(id -u)" "$REPO" "$DEST"

mkdir -p "$(dirname "$DEST")"
render_tree "$DEST"
git -C "$DEST" init -b main
git -C "$DEST" add --all
git -C "$DEST" commit -m "chore: seed disposable T-1 fixture"
"$DEST/scripts/verify.sh"

gh repo create "$REPO" --private --source "$DEST" --remote origin --push

ISSUE_BODY=$'Disposable T-1 validation record. No production work or owner data.\n\n<!-- atelier:notes -->\nRemote sentinel for reconcile and expired patch observation.\n<!-- /atelier:notes -->'
gh issue create \
  --repo "$REPO" \
  --title "T-1 fixture: remote reconcile sentinel" \
  --body "$ISSUE_BODY"

git -C "$DEST" switch -c "$OVERLAP_BRANCH"
printf '%s\n' 'T-1 overlap sentinel on open PR.' > "$DEST/fixture/overlap.txt"
git -C "$DEST" add fixture/overlap.txt
git -C "$DEST" commit -m "test: add overlap advisory sentinel"
git -C "$DEST" push -u origin "$OVERLAP_BRANCH"
PR_URL="$(gh pr create \
  --repo "$REPO" \
  --base main \
  --head "$OVERLAP_BRANCH" \
  --title "T-1 fixture: overlap advisory sentinel" \
  --body "Disposable T-1 overlap fixture; do not merge during validation.")"
git -C "$DEST" switch main

gh repo view "$REPO" --json nameWithOwner,visibility,defaultBranchRef \
  | jq -e '
      .nameWithOwner == "MatteoB-adv/ply-team-gate-t1-fixture" and
      .visibility == "PRIVATE" and
      .defaultBranchRef.name == "main"
    ' >/dev/null || die "remote_repository_shape"

gh issue list --repo "$REPO" --state all --limit 100 \
  --json title,state,assignees,labels \
  | jq -e '
      length == 1 and
      .[0].title == "T-1 fixture: remote reconcile sentinel" and
      .[0].state == "OPEN" and
      (.[0].assignees | length) == 0 and
      (.[0].labels | length) == 0
    ' >/dev/null || die "remote_issue_shape"

gh pr view "$PR_URL" \
  --json title,state,isDraft,headRefName,baseRefName,reviewRequests,files \
  | jq -e '
      .title == "T-1 fixture: overlap advisory sentinel" and
      .state == "OPEN" and
      .isDraft == false and
      .headRefName == "ply-t1/overlap-pr" and
      .baseRefName == "main" and
      (.reviewRequests | length) == 0 and
      (.files | length) == 1 and
      .files[0].path == "fixture/overlap.txt"
    ' >/dev/null || die "remote_pull_request_shape"

gh label list --repo "$REPO" --limit 100 --json name \
  | jq -e 'all(.[]; (.name | startswith("status:")) | not)' >/dev/null \
  || die "status_labels_precreated"

[[ ! -e "$APP_DATA" ]] || die "app_data_created_before_pending_import"
mkdir -p "$APP_DATA"
QUEUE_TMP="$(mktemp "$APP_DATA/pending_imports.json.tmp.XXXXXX")"
jq -n --arg cwd "$DEST" '[$cwd]' > "$QUEUE_TMP"
mv "$QUEUE_TMP" "$QUEUE"
[[ ! -e "$APP_DATA/license.json" ]] || die "license_present_after_bootstrap"
[[ ! -e "$APP_DATA/workspaces.json" ]] || die "workspace_present_before_import"

printf 'main_commit=%s\n' "$(git -C "$DEST" rev-parse HEAD)"
printf 'overlap_pr=%s\n' "$PR_URL"
printf 'pending_import=%s\n' "$QUEUE"
printf 'evidence=%s\n' "$EVIDENCE"
printf 'status=BOOTSTRAP_COMPLETE\n'
