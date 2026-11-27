#!/usr/bin/env bash
set -euo pipefail

assertion_failed() {
  printf 'condition=assertion_line_%s\nstatus=FIXTURE_CONTRACT_MISMATCH\n' "$1" >&2
  exit 1
}

ROOT=$(mktemp -d /private/tmp/ply-p3-3-script-test.XXXXXX)
REPO=$(mktemp -d /private/tmp/ply-p3-1-p3-3-test.XXXXXX)
BAD_REPO=$(mktemp -d /private/tmp/ply-p3-3-nondisposable.XXXXXX)
cleanup() {
  rm -rf "$ROOT" "$REPO" "$BAD_REPO"
}
trap cleanup EXIT

CONFIG_ROOT="$ROOT/config"
WORKSPACE_ID="p3-3-test-workspace"
mkdir -p "$CONFIG_ROOT/kanban/workspaces" "$CONFIG_ROOT/discussions" "$REPO"
git -C "$REPO" init -q -b main
printf '%s\n' fixture >"$REPO/README.md"
git -C "$REPO" add -- README.md
git -C "$REPO" -c user.name="Ply fixture" -c user.email="fixture@local.invalid" \
  commit -q -m "test: initialize P3-3 fixture"

jq -n --arg id "$WORKSPACE_ID" --arg cwd "$REPO" --arg bad "$BAD_REPO" '{
  schemaVersion: 1,
  workspaces: [
    {id: $id, name: "P3-3 test", cwd: $cwd, kanbanSyncMode: "local"},
    {id: "ordinary-workspace", name: "Ordinary", cwd: $bad, kanbanSyncMode: "local"}
  ]
}' >"$CONFIG_ROOT/workspaces.json"
jq -n --arg id "$WORKSPACE_ID" '{
  version: 8,
  cards: [{id: "anchor-card", workspaceId: $id, title: "3-1 walk anchor", columnId: "todo", createdAt: 1, updatedAt: 1}]
}' >"$CONFIG_ROOT/kanban/workspaces/$WORKSPACE_ID.json"
jq -n '{schemaVersion: 1, records: [{id: "sentinel", custom: {preserve: true}}]}' \
  >"$CONFIG_ROOT/discussions/state.json"

PLY_P3_3_FIXTURE_TEST=1 PLY_P3_3_FIXTURE_CONFIG_ROOT="$CONFIG_ROOT" \
  ./scripts/prepare-p3-3-discussion-fixture.sh "$WORKSPACE_ID" >/dev/null

STATE="$CONFIG_ROOT/discussions/state.json"
jq -e '
  . as $state
  | $state.records[0] == {id: "sentinel", custom: {preserve: true}}
  and ([$state.records[] | select(.id | startswith("p3-3-fixture-"))] | length) == 6
  and ([$state.records[].id] | length) == ([$state.records[].id] | unique | length)
  and ([$state.records[] | select(.id == "p3-3-fixture-completed") | .disagreementLedger[] | select(.id == "p3-3-d2")] | length) == 1
  and any($state.records[]; .id == "p3-3-fixture-failed" and ([.legs[] | select(.status == "failed")] | length) == 1)
' "$STATE" >/dev/null

FIRST_FIXTURES=$(jq -S '[.records[] | select(.id | startswith("p3-3-fixture-")) | walk(if type == "object" then del(.startedAt, .updatedAt, .endedAt) else . end)]' "$STATE")
PLY_P3_3_FIXTURE_TEST=1 PLY_P3_3_FIXTURE_CONFIG_ROOT="$CONFIG_ROOT" \
  ./scripts/prepare-p3-3-discussion-fixture.sh "$WORKSPACE_ID" >/dev/null
SECOND_FIXTURES=$(jq -S '[.records[] | select(.id | startswith("p3-3-fixture-")) | walk(if type == "object" then del(.startedAt, .updatedAt, .endedAt) else . end)]' "$STATE")
[[ "$FIRST_FIXTURES" == "$SECOND_FIXTURES" ]] || assertion_failed "$LINENO"
jq -e '
  . as $state
  | ([$state.records[] | select(.id == "sentinel")] | length) == 1
  and ([$state.records[] | select(.id | startswith("p3-3-fixture-"))] | length) == 6
  and ([$state.records[].id] | length) == ([$state.records[].id] | unique | length)
' "$STATE" >/dev/null

if PLY_P3_3_FIXTURE_TEST=1 PLY_P3_3_FIXTURE_CONFIG_ROOT="$CONFIG_ROOT" \
  ./scripts/prepare-p3-3-discussion-fixture.sh ordinary-workspace >/dev/null 2>&1; then
  echo "non-disposable workspace was accepted" >&2
  exit 1
fi

echo "P3-3 Discussion fixture preparation contract ✓"
