#!/usr/bin/env bash
set -euo pipefail

assertion_failed() {
  printf 'condition=assertion_line_%s\nstatus=FIXTURE_CONTRACT_MISMATCH\n' "$1" >&2
  exit 1
}

ROOT=$(mktemp -d /private/tmp/ply-p3-2-script-test.XXXXXX)
REPO=$(mktemp -d /private/tmp/ply-p3-1-p3-2-test.XXXXXX)
BOOT_ROOT=$(mktemp -d /private/tmp/ply-p3-2-script-test.XXXXXX)
BOOT_CWD=""
cleanup() {
  rm -rf "$ROOT" "$REPO" "$REPO.p3-self-check-worktrees" "$REPO.p3-2-provenance" "$BOOT_ROOT"
  if [[ -n "$BOOT_CWD" ]]; then
    rm -rf "$BOOT_CWD" "$BOOT_CWD.p3-self-check-worktrees" "$BOOT_CWD.p3-2-provenance"
  fi
}
trap cleanup EXIT
CONFIG_ROOT="$ROOT/config"
WORKSPACE_ID="p3-2-test-workspace"

mkdir -p "$CONFIG_ROOT/kanban/workspaces" "$REPO"
git -C "$REPO" init -q -b main
printf '%s\n' fixture >"$REPO/README.md"
git -C "$REPO" add -- README.md
git -C "$REPO" -c user.name="Ply fixture" -c user.email="fixture@local.invalid" \
  commit -q -m "test: initialize fixture"

jq -n --arg id "$WORKSPACE_ID" --arg cwd "$REPO" '{
  schemaVersion: 1,
  workspaces: [{id: $id, name: "P3-2 test", cwd: $cwd, kanbanSyncMode: "local"}]
}' >"$CONFIG_ROOT/workspaces.json"
jq -n '{behavior: {autoResumeSuspended: false}, identity: {userEmail: "fixture@example.invalid"}}' \
  >"$CONFIG_ROOT/settings.json"
jq -n --arg id "$WORKSPACE_ID" '{
  version: 8,
  cards: [{id: "anchor-card", workspaceId: $id, title: "3-1 walk anchor", columnId: "todo", createdAt: 1, updatedAt: 1}]
}' >"$CONFIG_ROOT/kanban/workspaces/$WORKSPACE_ID.json"

PLY_P3_2_FIXTURE_TEST=1 PLY_P3_2_FIXTURE_CONFIG_ROOT="$CONFIG_ROOT" \
  ./scripts/prepare-p3-2-board-fixture.sh "$WORKSPACE_ID" >/dev/null

BOARD="$CONFIG_ROOT/kanban/workspaces/$WORKSPACE_ID.json"
PROVENANCE_ID="p3-2-provenance-$WORKSPACE_ID"
PROVENANCE_BOARD="$CONFIG_ROOT/kanban/workspaces/$PROVENANCE_ID.json"

jq -e '
  ([.cards[] | select(.id | startswith("p3-2-seeded-"))] | length) == 6
  and any(.cards[]; .id == "p3-self-check-seeded-failed" and .columnId == "in_progress")
  and any(.cards[]; .id == "p3-2-seeded-aborted" and .lastRunStatus == "aborted")
  and any(.cards[]; .id == "p3-2-seeded-rate-limited" and .lastRunStatus == "rate_limited")
  and any(.cards[]; .id == "p3-2-seeded-stopped" and .columnId == "in_progress" and .shipStatus == "unshipped")
  and any(.cards[]; .id == "p3-2-seeded-manual-complete" and .columnId == "complete")
  and any(.cards[]; .id == "p3-2-seeded-merged" and .reviewStatus == "merged")
' "$BOARD" >/dev/null

jq -e '.users["fixture@example.invalid"]["failed:p3-2-seeded-aborted:manual"] != null' \
  "$CONFIG_ROOT/inbox/seen.json" >/dev/null
jq -e --arg id "$PROVENANCE_ID" '
  [.workspaces[] | select(.id == $id and .kanbanSyncMode == "githubIssues")] | length == 1
' "$CONFIG_ROOT/workspaces.json" >/dev/null
jq -e '
  [.cards[].ghIssueNumber] == [null, 197]
  and all(.cards[]; .workspaceId == "p3-2-provenance-p3-2-test-workspace")
' "$PROVENANCE_BOARD" >/dev/null

# Re-running is idempotent: fixture ids, provenance workspace, and seen receipt
# remain unique while the underlying P3-1 worktree setup refreshes safely.
PLY_P3_2_FIXTURE_TEST=1 PLY_P3_2_FIXTURE_CONFIG_ROOT="$CONFIG_ROOT" \
  ./scripts/prepare-p3-2-board-fixture.sh "$WORKSPACE_ID" >/dev/null
jq -e '
  ([.cards[].id] | length) == ([.cards[].id] | unique | length)
  and ([.cards[] | select(.id | startswith("p3-2-seeded-"))] | length) == 6
' "$BOARD" >/dev/null
jq -e --arg id "$PROVENANCE_ID" '[.workspaces[] | select(.id == $id)] | length == 1' \
  "$CONFIG_ROOT/workspaces.json" >/dev/null

# With no prior disposable workspace, the production entry point bootstraps
# its own Git repository, atomic Board file, and registered walk workspace.
BOOT_CONFIG="$BOOT_ROOT/config"
BOOT_SOURCE="$BOOT_ROOT/non-disposable-source"
mkdir -p "$BOOT_CONFIG/kanban/workspaces" "$BOOT_SOURCE"
jq -n --arg cwd "$BOOT_SOURCE" '{
  schemaVersion: 1,
  workspaces: [{id: "ordinary-workspace", name: "Ordinary", cwd: $cwd, kanbanSyncMode: "local"}]
}' >"$BOOT_CONFIG/workspaces.json"
jq -n '{behavior: {autoResumeSuspended: false}}' >"$BOOT_CONFIG/settings.json"
PLY_P3_2_FIXTURE_TEST=1 PLY_P3_2_FIXTURE_CONFIG_ROOT="$BOOT_CONFIG" \
  ./scripts/prepare-p3-2-board-fixture.sh >/dev/null
BOOT_CWD=$(jq -er '.workspaces[] | select(.name == "P3-2 Board walk") | .cwd' \
  "$BOOT_CONFIG/workspaces.json")
BOOT_ID=$(jq -er '.workspaces[] | select(.name == "P3-2 Board walk") | .id' \
  "$BOOT_CONFIG/workspaces.json")
[[ -d "$BOOT_CWD/.git" ]] || assertion_failed "$LINENO"
case "$BOOT_CWD" in
  /private/tmp/ply-p3-1-p3-2.* | /tmp/ply-p3-1-p3-2.*) ;;
  *) echo "bootstrap escaped its disposable root" >&2; exit 1 ;;
esac
jq -e --arg id "$BOOT_ID" '
  any(.cards[]; .id == "p3-2-walk-anchor" and .workspaceId == $id)
  and ([.cards[] | select(.id | startswith("p3-2-seeded-"))] | length == 6)
' "$BOOT_CONFIG/kanban/workspaces/$BOOT_ID.json" >/dev/null

echo "P3-2 fixture preparation contract ✓"
