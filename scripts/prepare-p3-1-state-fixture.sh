#!/usr/bin/env bash
# Prepare deterministic P3-1 presentation-state cards in a disposable repo.
#
# This is an external, offline fixture writer. Ply must be fully quit because
# its in-memory stores would otherwise overwrite these atomic disk edits.
set -euo pipefail

usage() {
  echo "Usage: $0 <disposable-workspace-id>" >&2
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ $# -eq 1 ]] || {
  usage
  exit 2
}

WORKSPACE_ID=$1
[[ "$WORKSPACE_ID" =~ ^[A-Za-z0-9-]+$ ]] ||
  fail "workspace id contains unsupported characters"

for tool in jq git mktemp shasum; do
  command -v "$tool" >/dev/null 2>&1 || fail "required command is missing: $tool"
done

TEST_MODE=0
if [[ -n "${PLY_P3_1_FIXTURE_CONFIG_ROOT:-}" ]]; then
  [[ "${PLY_P3_1_FIXTURE_TEST:-0}" == "1" ]] ||
    fail "custom config roots are test-only"
  case "$PLY_P3_1_FIXTURE_CONFIG_ROOT" in
    /private/tmp/ply-p3-1-script-test.* | /tmp/ply-p3-1-script-test.* | \
      /private/tmp/ply-p3-2-script-test.* | /tmp/ply-p3-2-script-test.*) ;;
    *) fail "test config root must be a dedicated /private/tmp fixture" ;;
  esac
  CONFIG_ROOT=$PLY_P3_1_FIXTURE_CONFIG_ROOT
  TEST_MODE=1
else
  CONFIG_ROOT="${HOME}/Library/Application Support/com.mbadv.ply"
fi

if [[ "$TEST_MODE" == "0" ]] &&
  { pgrep -f '/[A]pplications/(Ply|Plyloft)[.]app/Contents/MacOS/(atelier|Ply|Plyloft)' >/dev/null 2>&1 ||
    pgrep -f '/src-tauri/target/(debug|release)/atelier' >/dev/null 2>&1; }; then
  fail "Ply or Plyloft is running. Quit it with Cmd-Q before preparing persisted fixture state."
fi

WORKSPACES_FILE="$CONFIG_ROOT/workspaces.json"
SETTINGS_FILE="$CONFIG_ROOT/settings.json"
BOARD_FILE="$CONFIG_ROOT/kanban/workspaces/$WORKSPACE_ID.json"
REVIEWS_FILE="$CONFIG_ROOT/reviews/state.json"
SWARMS_DIR="$CONFIG_ROOT/swarms"

[[ -f "$WORKSPACES_FILE" ]] || fail "workspace registry not found"
[[ -f "$BOARD_FILE" ]] || fail "workspace board not found"

MATCH_COUNT=$(jq --arg id "$WORKSPACE_ID" \
  '[.workspaces[]? | select(.id == $id)] | length' "$WORKSPACES_FILE")
[[ "$MATCH_COUNT" == "1" ]] || fail "workspace id must resolve exactly once"

WORKSPACE_CWD=$(jq -er --arg id "$WORKSPACE_ID" \
  '.workspaces[] | select(.id == $id) | .cwd' "$WORKSPACES_FILE")
[[ -d "$WORKSPACE_CWD" ]] || fail "workspace directory does not exist: $WORKSPACE_CWD"
WORKSPACE_CWD=$(cd "$WORKSPACE_CWD" && pwd -P)
case "$WORKSPACE_CWD" in
  /private/tmp/ply-p3-1-* | /tmp/ply-p3-1-*) ;;
  *) fail "refusing non-disposable workspace path: $WORKSPACE_CWD" ;;
esac

git -C "$WORKSPACE_CWD" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  fail "fixture workspace is not a Git repository"
[[ "$(git -C "$WORKSPACE_CWD" branch --show-current)" == "main" ]] ||
  fail "fixture repository must be on main"
[[ -z "$(git -C "$WORKSPACE_CWD" status --short)" ]] ||
  fail "fixture repository must be clean before preparation"

AUTO_RESUME=false
if [[ -f "$SETTINGS_FILE" ]]; then
  AUTO_RESUME=$(jq -r '.behavior.autoResumeSuspended // false' "$SETTINGS_FILE")
fi
[[ "$AUTO_RESUME" == "false" ]] ||
  fail "disable Settings > Behavior > Auto-resume suspended work before seeding queued/paused states"

jq -e '.version <= 8 and (.cards | type == "array")' "$BOARD_FILE" >/dev/null ||
  fail "unsupported or corrupt Kanban file"
BASE_CARD_COUNT=$(jq '[.cards[] | select((.id | startswith("p3-self-check-seeded-")) | not)] | length' "$BOARD_FILE")
[[ "$BASE_CARD_COUNT" -ge 1 ]] || fail "the disposable board needs one non-seeded anchor card"

ATTEMPT_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_DIR="/private/tmp/ply-p3-1-fixture-backup-$WORKSPACE_ID-$ATTEMPT_ID"
mkdir -p "$BACKUP_DIR"
cp "$BOARD_FILE" "$BACKUP_DIR/kanban.json"
[[ ! -f "$REVIEWS_FILE" ]] || cp "$REVIEWS_FILE" "$BACKUP_DIR/reviews.json"

atomic_install() {
  local source=$1
  local target=$2
  local target_dir tmp
  target_dir=$(dirname "$target")
  mkdir -p "$target_dir"
  tmp=$(mktemp "$target.tmp.XXXXXX")
  cp "$source" "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$target"
}

remove_old_fixture_worktrees() {
  local expected_root="$WORKSPACE_CWD.p3-self-check-worktrees"
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    case "$path" in
      "$expected_root"/*)
        git -C "$WORKSPACE_CWD" worktree remove --force "$path" >/dev/null 2>&1 || true
        ;;
      *) fail "existing seeded card points outside the fixture worktree root: $path" ;;
    esac
  done < <(jq -r '
    .cards[]
    | select(.id | startswith("p3-self-check-seeded-"))
    | .worktreePath // empty
  ' "$BOARD_FILE")
  # Also recover a previous preparation that stopped after `git worktree add`
  # but before the Kanban file could publish those paths.
  for path in \
    "$expected_root/no-changes" \
    "$expected_root/ready-to-ship" \
    "$expected_root/review-stale"; do
    [[ ! -e "$path" ]] ||
      git -C "$WORKSPACE_CWD" worktree remove --force "$path" >/dev/null 2>&1 ||
      fail "could not recover reserved fixture worktree: $path"
  done
  git -C "$WORKSPACE_CWD" worktree prune
}

remove_old_fixture_worktrees

BRANCH_PREFIX="ply/p3-self-check"
for branch in \
  "$BRANCH_PREFIX/no-changes" \
  "$BRANCH_PREFIX/ready-to-ship" \
  "$BRANCH_PREFIX/review-stale"; do
  if git -C "$WORKSPACE_CWD" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$WORKSPACE_CWD" branch -D "$branch" >/dev/null
  fi
done

WORKTREE_ROOT="$WORKSPACE_CWD.p3-self-check-worktrees"
mkdir -p "$WORKTREE_ROOT"
NO_CHANGES_WT="$WORKTREE_ROOT/no-changes"
READY_TO_SHIP_WT="$WORKTREE_ROOT/ready-to-ship"
REVIEW_STALE_WT="$WORKTREE_ROOT/review-stale"

git -C "$WORKSPACE_CWD" worktree add -q -b "$BRANCH_PREFIX/no-changes" \
  "$NO_CHANGES_WT" main
git -C "$WORKSPACE_CWD" worktree add -q -b "$BRANCH_PREFIX/ready-to-ship" \
  "$READY_TO_SHIP_WT" main
git -C "$WORKSPACE_CWD" worktree add -q -b "$BRANCH_PREFIX/review-stale" \
  "$REVIEW_STALE_WT" main

printf '%s\n' "P3-1 ready-to-ship fixture $ATTEMPT_ID" \
  >"$READY_TO_SHIP_WT/p3-self-check-change.txt"
git -C "$READY_TO_SHIP_WT" add -- p3-self-check-change.txt
git -C "$READY_TO_SHIP_WT" \
  -c user.name="Ply fixture" \
  -c user.email="fixture@local.invalid" \
  commit -q -m "test: prepare ready-to-ship presentation"

NOW_MS=$(( $(date +%s) * 1000 ))
HEAD_SHA=$(git -C "$WORKSPACE_CWD" rev-parse HEAD)
STALE_REVISION=0000000000000000000000000000000000000000
SUSPENDED_SWARM_ID="p3-self-check-suspended-$WORKSPACE_ID"

BOARD_TMP=$(mktemp /private/tmp/ply-p3-1-board.XXXXXX)
jq \
  --arg workspaceId "$WORKSPACE_ID" \
  --arg noChangesWt "$NO_CHANGES_WT" \
  --arg noChangesBranch "$BRANCH_PREFIX/no-changes" \
  --arg readyWt "$READY_TO_SHIP_WT" \
  --arg readyBranch "$BRANCH_PREFIX/ready-to-ship" \
  --arg reviewWt "$REVIEW_STALE_WT" \
  --arg reviewBranch "$BRANCH_PREFIX/review-stale" \
  --arg suspendedSwarmId "$SUSPENDED_SWARM_ID" \
  --arg head "$HEAD_SHA" \
  --argjson now "$NOW_MS" '
  def fresh($base; $state; $column):
    $base
    | .id = ("p3-self-check-seeded-" + $state)
    | .workspaceId = $workspaceId
    | .title = ("P3-1 state: " + $state)
    | .notes = null
    | .knowledge = null
    | .columnId = $column
    | .agentConfigId = null
    | .linkedRunId = null
    | .lastRunStatus = null
    | .swarmTemplateId = null
    | .linkedSwarmId = null
    | .linkedBrainstormId = null
    | .dismissedBanners = []
    | .runHistory = []
    | .suppressRunHistory = false
    | .dispatchPrompt = null
    | .dispatchPromptEditedAt = null
    | .intakeStatus = "none"
    | .intakeHistory = []
    | .archived = false
    | .verifyIntent = null
    | .verifyStatus = "none"
    | .verifyHistory = []
    | .shipStatus = "unshipped"
    | .shipHistory = []
    | .commitSha = null
    | .shippedVersion = null
    | .attachments = []
    | .worktreePath = null
    | .branchName = null
    | .reviewStatus = null
    | .reviewDecisions = []
    | .prUrl = null
    | .parentCardId = null
    | .ghIssueNumber = null
    | .syncPending = false
    | .ghRawRemainder = null
    | .author = null
    | .lastEditedBy = null
    | .createdAt = $now
    | .updatedAt = $now;

  [.cards[] | select((.id | startswith("p3-self-check-seeded-")) | not)] as $kept
  | $kept[0] as $base
  | .cards = ($kept + [
      (fresh($base; "archived"; "complete") | .archived = true),
      (fresh($base; "shipped"; "complete")
        | .shipStatus = "shipped" | .commitSha = $head),
      (fresh($base; "running"; "in_progress") | .lastRunStatus = "running"),
      (fresh($base; "paused"; "in_progress")
        | .linkedSwarmId = $suspendedSwarmId),
      (fresh($base; "queued"; "in_progress")
        | .swarmTemplateId = "feature"),
      (fresh($base; "checking"; "complete") | .verifyStatus = "running"),
      (fresh($base; "verify-failed"; "complete") | .verifyStatus = "failed"),
      (fresh($base; "failed"; "complete") | .lastRunStatus = "failed"),
      (fresh($base; "review-stale"; "complete")
        | .lastRunStatus = "success"
        | .worktreePath = $reviewWt
        | .branchName = $reviewBranch),
      (fresh($base; "no-changes"; "complete")
        | .lastRunStatus = "success"
        | .worktreePath = $noChangesWt
        | .branchName = $noChangesBranch),
      (fresh($base; "ready-to-ship"; "complete")
        | .lastRunStatus = "success"
        | .worktreePath = $readyWt
        | .branchName = $readyBranch),
      (fresh($base; "result-ready"; "complete") | .lastRunStatus = "success"),
      (fresh($base; "ready"; "todo") | .intakeStatus = "ready"),
      (fresh($base; "draft"; "todo"))
    ])
  ' "$BOARD_FILE" >"$BOARD_TMP"
jq -e --arg workspaceId "$WORKSPACE_ID" '
  .version == 8
  and ([.cards[] | select(.id | startswith("p3-self-check-seeded-"))] | length == 14)
  and all(.cards[]; .workspaceId == $workspaceId)
' "$BOARD_TMP" >/dev/null || fail "generated Kanban fixture failed validation"
atomic_install "$BOARD_TMP" "$BOARD_FILE"
rm -f "$BOARD_TMP"

mkdir -p "$(dirname "$REVIEWS_FILE")"
REVIEWS_SOURCE=$REVIEWS_FILE
if [[ ! -f "$REVIEWS_FILE" ]]; then
  REVIEWS_SOURCE=$(mktemp /private/tmp/ply-p3-1-reviews-source.XXXXXX)
  printf '%s\n' '{"schemaVersion":1,"records":[]}' >"$REVIEWS_SOURCE"
fi
REVIEWS_TMP=$(mktemp /private/tmp/ply-p3-1-reviews.XXXXXX)
jq \
  --arg workspaceId "$WORKSPACE_ID" \
  --arg cardId "p3-self-check-seeded-review-stale" \
  --arg branch "$BRANCH_PREFIX/review-stale" \
  --arg sourceWt "$REVIEW_STALE_WT" \
  --arg reviewed "$STALE_REVISION" \
  --arg base "$HEAD_SHA" \
  --argjson now "$NOW_MS" '
  .schemaVersion = 1
  | .records = (
      [.records[]? | select((.id | startswith("p3-self-check-review-")) | not)]
      + [{
          schemaVersion: 1,
          id: ("p3-self-check-review-" + $workspaceId),
          workspaceId: $workspaceId,
          cardId: $cardId,
          provider: "codex",
          capability: "os-sandboxed",
          capabilityProof: "external fixture: intentionally stale revision",
          providerExecutable: "fixture",
          providerVersion: "fixture",
          baseRevision: $base,
          reviewedRevision: $reviewed,
          endRevision: $reviewed,
          branchName: $branch,
          sourceWorktree: $sourceWt,
          isolatedWorktree: "",
          sourceDirtyPaths: [],
          dirtyPathsTruncated: false,
          status: "completed",
          artifact: "Fixture review artifact",
          exitCode: 0,
          timedOut: false,
          writeEscaped: false,
          error: null,
          diagnostics: [],
          startedAt: $now,
          endedAt: $now
        }]
    )
  ' "$REVIEWS_SOURCE" >"$REVIEWS_TMP"
atomic_install "$REVIEWS_TMP" "$REVIEWS_FILE"
rm -f "$REVIEWS_TMP"
[[ "$REVIEWS_SOURCE" == "$REVIEWS_FILE" ]] || rm -f "$REVIEWS_SOURCE"

# GH #104: the three post-ship lesson-proposal states are retired with the
# feature (ADR 0005); nothing reads `memory/proposals` any more.

SUSPENDED_DIR="$SWARMS_DIR/$SUSPENDED_SWARM_ID"
mkdir -p "$SUSPENDED_DIR"
SUSPENDED_TMP=$(mktemp /private/tmp/ply-p3-1-swarm.XXXXXX)
jq -n \
  --arg id "$SUSPENDED_SWARM_ID" \
  --arg workspaceId "$WORKSPACE_ID" \
  --arg cwd "$WORKSPACE_CWD" \
  --argjson now "$NOW_MS" '
  {
    schemaVersion: 1,
    id: $id,
    workspaceId: $workspaceId,
    templateId: "feature",
    goal: "P3-1 paused presentation fixture",
    status: "suspended",
    state: {kind: "pending_step", idx: 0, role: "builder", prior_run_ids: []},
    kind: "card",
    iteration: 0,
    roleBindings: {},
    runIds: [],
    startedAt: $now,
    endedAt: null,
    endReason: null,
    suspendedAt: $now,
    suspendedSeconds: 0,
    inFlightRoleAtSuspend: null,
    inFlightAtSuspend: [],
    cwd: $cwd,
    throttled: false
  }
  ' >"$SUSPENDED_TMP"
atomic_install "$SUSPENDED_TMP" "$SUSPENDED_DIR/state.json"
rm -f "$SUSPENDED_TMP"

echo "✓ Prepared P3-1 state fixture for workspace $WORKSPACE_ID"
echo "  Workspace: $WORKSPACE_CWD"
echo "  Backup:    $BACKUP_DIR"
echo "  Seeded:    14 presentation states"
echo "  Reached:   intake-live and shipping during the installed walk"
echo "  Next: reopen Ply, begin one workspace-scoped observation, and open each seeded card."
