#!/usr/bin/env bash
# Prepare the installed P3-2 Board-hierarchy walk in disposable workspaces.
#
# This is an external, offline fixture writer. Ply must be fully quit because
# its in-memory stores would otherwise overwrite these atomic disk edits.
set -euo pipefail

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

for tool in jq git mktemp shasum; do
  command -v "$tool" >/dev/null 2>&1 || fail "required command is missing: $tool"
done

TEST_MODE=0
if [[ -n "${PLY_P3_2_FIXTURE_CONFIG_ROOT:-}" ]]; then
  [[ "${PLY_P3_2_FIXTURE_TEST:-0}" == "1" ]] || fail "custom config roots are test-only"
  case "$PLY_P3_2_FIXTURE_CONFIG_ROOT" in
    /private/tmp/ply-p3-2-script-test.* | /tmp/ply-p3-2-script-test.*) ;;
    *) fail "test config root must be a dedicated /private/tmp fixture" ;;
  esac
  CONFIG_ROOT=$PLY_P3_2_FIXTURE_CONFIG_ROOT
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
[[ -f "$WORKSPACES_FILE" ]] || fail "workspace registry not found"

atomic_install() {
  local source=$1 target=$2 target_dir tmp
  target_dir=$(dirname "$target")
  mkdir -p "$target_dir"
  tmp=$(mktemp "$target.tmp.XXXXXX")
  cp "$source" "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$target"
}

find_default_workspace_id() {
  local newest_id="" newest_mtime=-1 id cwd board mtime
  while IFS=$'\t' read -r id cwd; do
    case "$cwd" in
      /private/tmp/ply-p3-1-* | /tmp/ply-p3-1-*) ;;
      *) continue ;;
    esac
    board="$CONFIG_ROOT/kanban/workspaces/$id.json"
    [[ -f "$board" ]] || continue
    jq -e 'any(.cards[]?; .title == "3-1 walk anchor")' "$board" >/dev/null || continue
    mtime=$(stat -f '%m' "$board" 2>/dev/null || echo 0)
    if (( mtime > newest_mtime )); then
      newest_id=$id
      newest_mtime=$mtime
    fi
  done < <(jq -r '.workspaces[]? | [.id, .cwd] | @tsv' "$WORKSPACES_FILE")
  [[ -n "$newest_id" ]] || return 1
  printf '%s\n' "$newest_id"
}

bootstrap_default_workspace() {
  local attempt_id workspace_id workspace_cwd board_file workspaces_tmp board_tmp
  attempt_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  workspace_id="p3-2-walk-${attempt_id//[^A-Za-z0-9-]/-}"
  workspace_cwd=$(mktemp -d /private/tmp/ply-p3-1-p3-2.XXXXXX)
  board_file="$CONFIG_ROOT/kanban/workspaces/$workspace_id.json"

  git -C "$workspace_cwd" init -q -b main
  printf '%s\n' "P3-2 installed Board walk" >"$workspace_cwd/README.md"
  git -C "$workspace_cwd" add -- README.md
  git -C "$workspace_cwd" -c user.name="Ply fixture" -c user.email="fixture@local.invalid" \
    commit -q -m "test: initialize P3-2 installed fixture"

  workspaces_tmp=$(mktemp /private/tmp/ply-p3-2-bootstrap-workspaces.XXXXXX)
  jq --arg id "$workspace_id" --arg cwd "$workspace_cwd" '
    (.workspaces[0] // {}) as $source
    | .workspaces += [
        ($source
          | .id = $id
          | .name = "P3-2 Board walk"
          | .cwd = $cwd
          | .kanbanSyncMode = "local"
          | .githubOwnerRepo = null)
      ]
  ' "$WORKSPACES_FILE" >"$workspaces_tmp"
  jq -e --arg id "$workspace_id" --arg cwd "$workspace_cwd" '
    [.workspaces[] | select(.id == $id and .cwd == $cwd and .kanbanSyncMode == "local")] | length == 1
  ' "$workspaces_tmp" >/dev/null || fail "generated bootstrap workspace failed validation"

  board_tmp=$(mktemp /private/tmp/ply-p3-2-bootstrap-board.XXXXXX)
  jq -n --arg id "$workspace_id" --argjson now "$(( $(date +%s) * 1000 ))" '{
    version: 8,
    cards: [{
      id: "p3-2-walk-anchor",
      workspaceId: $id,
      title: "3-1 walk anchor",
      columnId: "todo",
      createdAt: $now,
      updatedAt: $now
    }]
  }' >"$board_tmp"

  # Publish the board before the workspace record: a crash between the two
  # leaves an unreferenced disposable file, never a visible broken workspace.
  atomic_install "$board_tmp" "$board_file"
  atomic_install "$workspaces_tmp" "$WORKSPACES_FILE"
  rm -f "$board_tmp" "$workspaces_tmp"
  printf '%s\n' "$workspace_id"
}

[[ $# -le 1 ]] || fail "Usage: $0 [disposable-workspace-id]"
if [[ $# -eq 1 ]]; then
  WORKSPACE_ID=$1
elif WORKSPACE_ID=$(find_default_workspace_id); then
  :
else
  WORKSPACE_ID=$(bootstrap_default_workspace)
fi
[[ "$WORKSPACE_ID" =~ ^[A-Za-z0-9-]+$ ]] || fail "workspace id contains unsupported characters"

MATCH_COUNT=$(jq --arg id "$WORKSPACE_ID" '[.workspaces[]? | select(.id == $id)] | length' "$WORKSPACES_FILE")
[[ "$MATCH_COUNT" == "1" ]] || fail "workspace id must resolve exactly once"
WORKSPACE_CWD=$(jq -er --arg id "$WORKSPACE_ID" '.workspaces[] | select(.id == $id) | .cwd' "$WORKSPACES_FILE")
[[ -d "$WORKSPACE_CWD" ]] || fail "workspace directory does not exist: $WORKSPACE_CWD"
WORKSPACE_CWD=$(cd "$WORKSPACE_CWD" && pwd -P)
case "$WORKSPACE_CWD" in
  /private/tmp/ply-p3-1-* | /tmp/ply-p3-1-*) ;;
  *) fail "refusing non-disposable workspace path: $WORKSPACE_CWD" ;;
esac

if [[ "$TEST_MODE" == "1" ]]; then
  PLY_P3_1_FIXTURE_TEST=1 \
    PLY_P3_1_FIXTURE_CONFIG_ROOT="$CONFIG_ROOT" \
    ./scripts/prepare-p3-1-state-fixture.sh "$WORKSPACE_ID" >/dev/null
else
  ./scripts/prepare-p3-1-state-fixture.sh "$WORKSPACE_ID" >/dev/null
fi

BOARD_FILE="$CONFIG_ROOT/kanban/workspaces/$WORKSPACE_ID.json"
SEEN_FILE="$CONFIG_ROOT/inbox/seen.json"
NOW_MS=$(( $(date +%s) * 1000 ))
HEAD_SHA=$(git -C "$WORKSPACE_CWD" rev-parse HEAD)

BOARD_TMP=$(mktemp /private/tmp/ply-p3-2-board.XXXXXX)
jq \
  --arg workspaceId "$WORKSPACE_ID" \
  --arg head "$HEAD_SHA" \
  --argjson now "$NOW_MS" '
  def fresh($base; $id; $title; $column):
    $base
    | .id = $id
    | .workspaceId = $workspaceId
    | .title = $title
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

  [.cards[] | select((.id | startswith("p3-2-seeded-")) | not)] as $kept
  | $kept[0] as $base
  | .cards = (
      [$kept[] | if .id == "p3-self-check-seeded-failed" then .columnId = "in_progress" else . end]
      + [
        (fresh($base; "p3-2-seeded-aborted"; "P3-2 outcome: aborted"; "in_progress")
          | .lastRunStatus = "aborted"),
        (fresh($base; "p3-2-seeded-rate-limited"; "P3-2 outcome: rate-limited"; "in_progress")
          | .lastRunStatus = "rate_limited"),
        (fresh($base; "p3-2-seeded-stopped"; "P3-2 drag: stopped work"; "in_progress")
          | .lastRunStatus = "failed"),
        (fresh($base; "p3-2-seeded-manual-complete"; "P3-2 review: manual Complete"; "complete")),
        (fresh($base; "p3-2-seeded-merged"; "P3-2 done: merged"; "complete")
          | .reviewStatus = "merged" | .commitSha = $head),
        (fresh($base; "p3-2-seeded-github"; "P3-2 provenance: GitHub issue"; "todo")
          | .ghIssueNumber = 197 | .syncPending = true)
      ]
    )
  ' "$BOARD_FILE" >"$BOARD_TMP"
jq -e '
  .version == 8
  and ([.cards[] | select(.id | startswith("p3-2-seeded-"))] | length == 6)
  and any(.cards[]; .id == "p3-self-check-seeded-failed" and .columnId == "in_progress")
  and any(.cards[]; .id == "p3-2-seeded-manual-complete" and .columnId == "complete" and .shipStatus == "unshipped")
  and any(.cards[]; .id == "p3-2-seeded-merged" and .reviewStatus == "merged")
' "$BOARD_TMP" >/dev/null || fail "generated P3-2 board fixture failed validation"
atomic_install "$BOARD_TMP" "$BOARD_FILE"
rm -f "$BOARD_TMP"

# Preserve a stable already-seen receipt so reopening Board/Inbox can prove
# that the P3-2 projection does not manufacture a fresh event id.
USER_KEY=local
if [[ -f "$SETTINGS_FILE" ]]; then
  USER_KEY=$(jq -r '.identity.userEmail // "local" | select(length > 0)' "$SETTINGS_FILE")
  USER_KEY=${USER_KEY:-local}
fi
SEEN_SOURCE=$SEEN_FILE
if [[ ! -f "$SEEN_FILE" ]]; then
  SEEN_SOURCE=$(mktemp /private/tmp/ply-p3-2-seen-source.XXXXXX)
  printf '%s\n' '{"schemaVersion":1,"users":{}}' >"$SEEN_SOURCE"
fi
SEEN_TMP=$(mktemp /private/tmp/ply-p3-2-seen.XXXXXX)
jq --arg user "$USER_KEY" --argjson now "$NOW_MS" '
  .schemaVersion = 1
  | .users = (.users // {})
  | .users[$user] = (.users[$user] // {})
  | .users[$user]["failed:p3-2-seeded-aborted:manual"] =
      (.users[$user]["failed:p3-2-seeded-aborted:manual"] // $now)
' "$SEEN_SOURCE" >"$SEEN_TMP"
atomic_install "$SEEN_TMP" "$SEEN_FILE"
rm -f "$SEEN_TMP"
[[ "$SEEN_SOURCE" == "$SEEN_FILE" ]] || rm -f "$SEEN_SOURCE"

# “Local only” is only truthful on a GitHub-backed board. Without a Team key
# such a board is intentionally read-only, so provenance gets its own tiny
# disposable workspace instead of weakening the interactive local fixture.
PROVENANCE_ID="p3-2-provenance-$WORKSPACE_ID"
PROVENANCE_CWD="$WORKSPACE_CWD.p3-2-provenance"
PROVENANCE_BOARD="$CONFIG_ROOT/kanban/workspaces/$PROVENANCE_ID.json"
if [[ ! -d "$PROVENANCE_CWD/.git" ]]; then
  mkdir -p "$PROVENANCE_CWD"
  git -C "$PROVENANCE_CWD" init -q -b main
  printf '%s\n' "P3-2 provenance fixture" >"$PROVENANCE_CWD/README.md"
  git -C "$PROVENANCE_CWD" add -- README.md
  git -C "$PROVENANCE_CWD" -c user.name="Ply fixture" -c user.email="fixture@local.invalid" \
    commit -q -m "test: initialize P3-2 provenance fixture"
fi

WORKSPACES_TMP=$(mktemp /private/tmp/ply-p3-2-workspaces.XXXXXX)
jq \
  --arg sourceId "$WORKSPACE_ID" \
  --arg id "$PROVENANCE_ID" \
  --arg cwd "$PROVENANCE_CWD" '
  [.workspaces[] | select(.id != $id)] as $without
  | (.workspaces[] | select(.id == $sourceId)) as $source
  | .workspaces = ($without + [
      ($source
        | .id = $id
        | .name = "P3-2 provenance (read-only)"
        | .cwd = $cwd
        | .kanbanSyncMode = "githubIssues"
        | .githubOwnerRepo = null)
    ])
' "$WORKSPACES_FILE" >"$WORKSPACES_TMP"
jq -e --arg id "$PROVENANCE_ID" --arg cwd "$PROVENANCE_CWD" '
  [.workspaces[] | select(.id == $id and .cwd == $cwd and .kanbanSyncMode == "githubIssues")] | length == 1
' "$WORKSPACES_TMP" >/dev/null || fail "generated provenance workspace failed validation"
atomic_install "$WORKSPACES_TMP" "$WORKSPACES_FILE"
rm -f "$WORKSPACES_TMP"

PROVENANCE_TMP=$(mktemp /private/tmp/ply-p3-2-provenance-board.XXXXXX)
jq -n --arg id "$PROVENANCE_ID" --argjson now "$NOW_MS" '{
  version: 8,
  cards: [
    {
      id: "p3-2-provenance-local", workspaceId: $id,
      title: "P3-2 provenance: local-only card", columnId: "todo",
      ghIssueNumber: null, syncPending: false, archived: false,
      createdAt: $now, updatedAt: $now
    },
    {
      id: "p3-2-provenance-issue", workspaceId: $id,
      title: "P3-2 provenance: GitHub issue", columnId: "todo",
      ghIssueNumber: 197, syncPending: true, archived: false,
      createdAt: $now, updatedAt: $now
    }
  ]
}' >"$PROVENANCE_TMP"
atomic_install "$PROVENANCE_TMP" "$PROVENANCE_BOARD"
rm -f "$PROVENANCE_TMP"

echo "✓ Prepared P3-2 Board fixture"
echo "  Interactive workspace: $WORKSPACE_ID"
echo "  Provenance workspace:  $PROVENANCE_ID"
echo "  Seen receipt user:      $USER_KEY"
echo "  Next: reopen Ply; inspect the read-only provenance workspace, then run the interaction walk in the P3-1 fixture workspace."
