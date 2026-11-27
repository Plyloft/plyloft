#!/usr/bin/env bash
set -euo pipefail

assertion_failed() {
  printf 'condition=assertion_line_%s\nstatus=FIXTURE_CONTRACT_MISMATCH\n' "$1" >&2
  exit 1
}

ROOT=$(mktemp -d /private/tmp/ply-p3-1-script-test.XXXXXX)
trap 'rm -rf "$ROOT"' EXIT
CONFIG_ROOT="$ROOT/config"
REPO="$ROOT/ply-p3-1-fixture"
WORKSPACE_ID="p3-self-check-test-workspace"

mkdir -p "$CONFIG_ROOT/kanban/workspaces" "$REPO"
git -C "$REPO" init -q -b main
printf '%s\n' "fixture" >"$REPO/README.md"
git -C "$REPO" add -- README.md
git -C "$REPO" \
  -c user.name="Ply fixture" \
  -c user.email="fixture@local.invalid" \
  commit -q -m "test: initialize fixture"

jq -n --arg id "$WORKSPACE_ID" --arg cwd "$REPO" '{
  schemaVersion: 1,
  workspaces: [{id: $id, name: "ply-p3-1-test", cwd: $cwd}]
}' >"$CONFIG_ROOT/workspaces.json"
jq -n '{behavior: {autoResumeSuspended: false}}' >"$CONFIG_ROOT/settings.json"
jq -n --arg id "$WORKSPACE_ID" '{
  version: 8,
  cards: [{
    id: "anchor-card",
    workspaceId: $id,
    title: "Anchor",
    columnId: "todo",
    createdAt: 1,
    updatedAt: 1
  }]
}' >"$CONFIG_ROOT/kanban/workspaces/$WORKSPACE_ID.json"

run_fixture() {
  PLY_P3_1_FIXTURE_TEST=1 \
    PLY_P3_1_FIXTURE_CONFIG_ROOT="$CONFIG_ROOT" \
    ./scripts/prepare-p3-1-state-fixture.sh "$WORKSPACE_ID"
}

# Simulate interruption after a reserved worktree was created but before its
# path reached the Kanban JSON. The next preparation must recover it.
git -C "$REPO" worktree add -q -b "ply/p3-self-check/no-changes" \
  "$REPO.p3-self-check-worktrees/no-changes" main
run_fixture >/dev/null

# A completed installed walk lands the ready-to-ship branch into main. The
# next preparation must still create a fresh change instead of exiting at
# `git commit` with an already-identical fixture file.
git -C "$REPO" \
  -c user.name="Ply fixture" \
  -c user.email="fixture@local.invalid" \
  merge -q --no-ff "ply/p3-self-check/ready-to-ship" \
  -m "test: simulate shipped fixture"

run_fixture >/dev/null

BOARD="$CONFIG_ROOT/kanban/workspaces/$WORKSPACE_ID.json"
REVIEWS="$CONFIG_ROOT/reviews/state.json"
SWARM="$CONFIG_ROOT/swarms/p3-self-check-suspended-$WORKSPACE_ID/state.json"

jq -e '
  ([.cards[] | select(.id | startswith("p3-self-check-seeded-"))] | length) == 14
  and ([.cards[].id] | unique | length) == (.cards | length)
  and any(.cards[]; .id == "p3-self-check-seeded-paused"
    and .linkedSwarmId != null)
  and any(.cards[]; .id == "p3-self-check-seeded-queued"
    and .columnId == "in_progress"
    and .swarmTemplateId == "feature"
    and .linkedSwarmId == null)
  and any(.cards[]; .id == "p3-self-check-seeded-ready-to-ship"
    and .worktreePath != null
    and .branchName != null)
' "$BOARD" >/dev/null

jq -e '
  [.records[] | select(.id | startswith("p3-self-check-review-"))] | length == 1
' "$REVIEWS" >/dev/null

jq -e '
  .status == "suspended"
  and .kind == "card"
  and .workspaceId == "p3-self-check-test-workspace"
' "$SWARM" >/dev/null

# GH #104: the post-ship lesson proposals are retired (ADR 0005). The fixture
# writes none, and nothing reads `memory/proposals` any more.
[[ ! -e "$CONFIG_ROOT/memory/proposals" ]] || assertion_failed "$LINENO"

for state in no-changes ready-to-ship review-stale; do
  [[ -d "$REPO.p3-self-check-worktrees/$state" ]] || assertion_failed "$LINENO"
done

echo "P3-1 fixture preparation contract ✓"
