#!/usr/bin/env bash
# Prepare deterministic, non-launching Discussion records for the installed
# P3-3 hierarchy walk. Ply must be fully quit: its in-memory Discussion store
# would otherwise overwrite this atomic disk edit.
set -euo pipefail

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

for tool in jq git mktemp; do
  command -v "$tool" >/dev/null 2>&1 || fail "required command is missing: $tool"
done

TEST_MODE=0
if [[ -n "${PLY_P3_3_FIXTURE_CONFIG_ROOT:-}" ]]; then
  [[ "${PLY_P3_3_FIXTURE_TEST:-0}" == "1" ]] || fail "custom config roots are test-only"
  case "$PLY_P3_3_FIXTURE_CONFIG_ROOT" in
    /private/tmp/ply-p3-3-script-test.* | /tmp/ply-p3-3-script-test.*) ;;
    *) fail "test config root must be a dedicated /private/tmp fixture" ;;
  esac
  CONFIG_ROOT=$PLY_P3_3_FIXTURE_CONFIG_ROOT
  TEST_MODE=1
else
  CONFIG_ROOT="${HOME}/Library/Application Support/com.mbadv.ply"
fi

if [[ "$TEST_MODE" == "0" ]] &&
  { pgrep -f '/[A]pplications/(Ply|Plyloft)[.]app/Contents/MacOS/(atelier|Ply|Plyloft)' >/dev/null 2>&1 ||
    pgrep -f '/src-tauri/target/(debug|release)/atelier' >/dev/null 2>&1; }; then
  fail "Ply or Plyloft is running. Quit it with Cmd-Q before preparing persisted fixture state."
fi

[[ $# -le 1 ]] || fail "Usage: $0 [disposable-workspace-id]"

WORKSPACES_FILE="$CONFIG_ROOT/workspaces.json"
DISCUSSIONS_FILE="$CONFIG_ROOT/discussions/state.json"
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

if [[ $# -eq 1 ]]; then
  WORKSPACE_ID=$1
else
  WORKSPACE_ID=$(find_default_workspace_id) ||
    fail "no disposable P3-1/P3-2 workspace with a walk anchor was found"
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

BOARD_FILE="$CONFIG_ROOT/kanban/workspaces/$WORKSPACE_ID.json"
[[ -f "$BOARD_FILE" ]] || fail "workspace Board file not found"
ANCHOR_CARD_ID=$(jq -er '.cards[] | select(.title == "3-1 walk anchor") | .id' "$BOARD_FILE" | head -1)
[[ -n "$ANCHOR_CARD_ID" ]] || fail "walk anchor card not found"
HEAD_SHA=$(git -C "$WORKSPACE_CWD" rev-parse HEAD)
SOURCE_REF=$(git -C "$WORKSPACE_CWD" symbolic-ref --quiet --short HEAD || printf '%s' 'HEAD')
PROJECT_PATH=$(git -C "$WORKSPACE_CWD" rev-parse --absolute-git-dir)
NOW_MS=$(( $(date +%s) * 1000 ))

INPUT_STATE=$(mktemp /private/tmp/ply-p3-3-input.XXXXXX)
OUTPUT_STATE=$(mktemp /private/tmp/ply-p3-3-output.XXXXXX)
trap 'rm -f "$INPUT_STATE" "$OUTPUT_STATE"' EXIT
if [[ -f "$DISCUSSIONS_FILE" ]]; then
  cp "$DISCUSSIONS_FILE" "$INPUT_STATE"
else
  jq -n '{schemaVersion: 1, records: []}' >"$INPUT_STATE"
fi

jq \
  --arg workspaceId "$WORKSPACE_ID" \
  --arg cardId "$ANCHOR_CARD_ID" \
  --arg cwd "$WORKSPACE_CWD" \
  --arg project "$PROJECT_PATH" \
  --arg sourceRef "$SOURCE_REF" \
  --arg head "$HEAD_SHA" \
  --argjson now "$NOW_MS" '
  def participant($provider; $version; $capability): {
    provider: $provider,
    executable: ("/fixture/bin/" + $provider),
    version: $version,
    capability: $capability
  };
  def participants: {
    analysisA: participant("claude"; "fixture-claude"; "harness-enforced"),
    analysisB: participant("codex"; "fixture-codex"; "os-sandboxed"),
    synthesizer: participant("claude"; "fixture-claude"; "harness-enforced")
  };
  def budgets: {
    problemBytes: 16384,
    mechanicalContextBytes: 131072,
    knowledgeContextBytesPerCall: 32768,
    promptBytes: 262144,
    artifactBytes: 32768,
    ledgerEntries: 64,
    ledgerEntryBytes: 1024,
    synthesisOutputBytes: 65536,
    providerTimeoutSeconds: 600
  };
  def source($dirty): {
    project: {displayPath: $project, comparisonKey: ($project | ascii_downcase)},
    displayPath: $cwd,
    sourceRef: $sourceRef,
    baseRevision: null,
    pinnedRevision: $head,
    dirtyPaths: $dirty,
    dirtyPathsTruncated: false
  };
  def attempt($status; $artifact; $unavailable; $error; $started; $ended): {
    number: 1,
    status: $status,
    executable: "/fixture/bin/provider",
    version: "fixture-provider",
    capability: "harness-enforced",
    artifact: $artifact,
    exitCode: (if $status == "completed" then 0 else 1 end),
    timedOut: false,
    writeEscaped: false,
    endRevision: $head,
    unavailable: $unavailable,
    error: $error,
    diagnostics: [],
    startedAt: $started,
    endedAt: $ended
  };
  def leg($kind; $provider; $status; $artifact; $unavailable; $error; $offset):
    ($now + $offset) as $started
    | ($started + 10) as $ended
    | {
        kind: $kind,
        provider: $provider,
        status: $status,
        executable: ("/fixture/bin/" + $provider),
        version: ("fixture-" + $provider),
        capability: (if $provider == "claude" then "harness-enforced" else "os-sandboxed" end),
        attemptCount: (if $status == "pending" then 0 else 1 end),
        promptDigest: (if $status == "pending" then "" else "fixture-prompt-digest" end),
        artifact: $artifact,
        exitCode: (if $status == "pending" or $status == "interrupted" then null elif $status == "completed" then 0 else 1 end),
        timedOut: false,
        writeEscaped: false,
        endRevision: (if $status == "pending" then null else $head end),
        unavailable: $unavailable,
        attemptHistory: (if $status == "pending" then [] else [attempt($status; $artifact; $unavailable; $error; $started; $ended)] end),
        diagnostics: [],
        startedAt: (if $status == "pending" then null else $started end),
        endedAt: (if $status == "pending" then null else $ended end)
      };
  def pending($kind; $provider): leg($kind; $provider; "pending"; null; null; null; 0);
  def completed($kind; $provider; $offset):
    leg($kind; $provider; "completed"; {summary: ($kind + " fixture artifact")}; null; null; $offset);
  def unavailable($kind; $provider; $unavailableKind; $reason; $offset):
    leg($kind; $provider; "interrupted"; null; {kind: $unavailableKind, reason: $reason, resetAt: null}; $reason; $offset);
  def legs($a; $b; $ca; $cb; $s): {
    analysisA: $a,
    analysisB: $b,
    crossReviewA: $ca,
    crossReviewB: $cb,
    synthesis: $s
  };
  def record($suffix; $problem; $status; $phase; $dirty; $legs; $ledger; $result; $ended; $offset): {
    schemaVersion: 1,
    id: ("p3-3-fixture-" + $suffix),
    workspaceId: $workspaceId,
    cardId: $cardId,
    problem: $problem,
    source: source($dirty),
    participants: participants,
    status: $status,
    currentPhase: $phase,
    promptEnvelopeDigest: "p3-3-fixture-envelope",
    promptEnvelope: {
      mechanicalContext: "P3-3 deterministic installed hierarchy fixture",
      problem: $problem,
      source: {baseRevision: null, pinnedRevision: $head, sourceRef: $sourceRef}
    },
    knowledgePolicy: {mode: "live-read-only-mcp", scope: "workspace", digestIncludesResults: false},
    budgets: budgets,
    legs: $legs,
    ledgerReady: ($ledger | length > 0),
    disagreementLedger: $ledger,
    finalResult: $result,
    startedAt: ($now + $offset),
    updatedAt: ($now + $offset),
    endedAt: $ended,
    retentionClass: "discussion"
  };
  def clean_legs:
    legs(
      completed("analysis_a"; "claude"; 10);
      completed("analysis_b"; "codex"; 20);
      completed("cross_review_a"; "claude"; 30);
      completed("cross_review_b"; "codex"; 40);
      completed("synthesis"; "claude"; 50)
    );
  def fixture_records: [
    record(
      "preflight";
      "P3-3 preflight: pinned commit and excluded paths";
      "preparing";
      "preparing";
      ["docs/p3-3-uncommitted-one.md", "src/p3-3-uncommitted-two.ts"];
      legs(pending("analysis_a"; "claude"); pending("analysis_b"; "codex"); pending("cross_review_a"; "claude"); pending("cross_review_b"; "codex"); pending("synthesis"; "claude"));
      [];
      null;
      null;
      600
    ),
    record(
      "completed";
      "P3-3 completed: synthesis and disagreement hierarchy";
      "completed";
      "completed";
      [];
      clean_legs;
      [
        {id: "p3-3-d1", raisedBy: "analysis_a", statement: "Keep the action singular.", rationale: "One action reduces ambiguity.", severity: "medium", evidenceRefs: ["analysis_a"], relatedIds: []},
        {id: "p3-3-d2", raisedBy: "analysis_b", statement: "The fallback remains undecided.", rationale: "The evidence supports two safe choices.", severity: "high", evidenceRefs: ["analysis_b", "cross_review_a"], relatedIds: []}
      ];
      {
        answer: "Lead with the bounded synthesis. Keep every unresolved disagreement visible immediately below it, and put execution receipts behind disclosure.",
        agreements: ["Both providers analyzed the same pinned commit.", "No code mutation was authorized."],
        disagreementResolutions: [
          {disagreementId: "p3-3-d1", disposition: "resolved", rationale: "Use one primary action."},
          {disagreementId: "p3-3-d2", disposition: "unresolved", rationale: "Owner input is still required."}
        ],
        unresolvedQuestions: ["Which fallback should the owner choose?"]
      };
      ($now + 660);
      500
    ),
    record(
      "one-provider-unavailable";
      "P3-3 paused: Codex quota unavailable";
      "paused_provider_unavailable";
      "independent_analyses";
      [];
      legs(completed("analysis_a"; "claude"; 10); unavailable("analysis_b"; "codex"; "quota"; "Codex quota is temporarily unavailable."; 20); pending("cross_review_a"; "claude"); pending("cross_review_b"; "codex"); pending("synthesis"; "claude"));
      [];
      null;
      null;
      400
    ),
    record(
      "dual-provider-unavailable";
      "P3-3 paused: both providers unavailable";
      "paused_provider_unavailable";
      "independent_analyses";
      [];
      legs(unavailable("analysis_a"; "claude"; "authentication"; "Claude authentication needs attention."; 10); unavailable("analysis_b"; "codex"; "quota"; "Codex quota is temporarily unavailable."; 20); pending("cross_review_a"; "claude"); pending("cross_review_b"; "codex"); pending("synthesis"; "claude"));
      [];
      null;
      null;
      300
    ),
    record(
      "interrupted";
      "P3-3 interrupted: resume without replaying analyses";
      "interrupted";
      "cross_reviews";
      [];
      legs(completed("analysis_a"; "claude"; 10); completed("analysis_b"; "codex"; 20); leg("cross_review_a"; "claude"; "interrupted"; null; null; "Interrupted by fixture."; 30); pending("cross_review_b"; "codex"); pending("synthesis"; "claude"));
      [];
      null;
      ($now + 350);
      200
    ),
    record(
      "failed";
      "P3-3 failed: retry only Cross-review B";
      "failed";
      "cross_reviews";
      [];
      legs(completed("analysis_a"; "claude"; 10); completed("analysis_b"; "codex"; 20); completed("cross_review_a"; "claude"; 30); leg("cross_review_b"; "codex"; "failed"; null; null; "Fixture failure in Cross-review B."; 40); pending("synthesis"; "claude"));
      [];
      null;
      ($now + 250);
      100
    )
  ];
  .schemaVersion = 1
  | .records = ([.records[]? | select((.id | startswith("p3-3-fixture-")) | not)] + fixture_records)
  ' "$INPUT_STATE" >"$OUTPUT_STATE"

jq -e --arg workspaceId "$WORKSPACE_ID" --arg cardId "$ANCHOR_CARD_ID" '
  .schemaVersion == 1
  and ([.records[] | select(.id | startswith("p3-3-fixture-"))] | length) == 6
  and all(.records[] | select(.id | startswith("p3-3-fixture-")); .workspaceId == $workspaceId and .cardId == $cardId)
  and any(.records[]; .id == "p3-3-fixture-preflight" and .status == "preparing" and (.source.dirtyPaths | length) == 2)
  and any(.records[]; .id == "p3-3-fixture-completed" and .status == "completed" and (.disagreementLedger | length) == 2)
  and any(.records[]; .id == "p3-3-fixture-one-provider-unavailable" and .legs.analysisB.unavailable.kind == "quota")
  and any(.records[]; .id == "p3-3-fixture-dual-provider-unavailable" and .legs.analysisA.unavailable.kind == "authentication" and .legs.analysisB.unavailable.kind == "quota")
  and any(.records[]; .id == "p3-3-fixture-interrupted" and .status == "interrupted" and .legs.analysisA.status == "completed" and .legs.crossReviewA.status == "interrupted")
  and any(.records[]; .id == "p3-3-fixture-failed" and .status == "failed" and .legs.crossReviewB.status == "failed" and .legs.synthesis.status == "pending")
' "$OUTPUT_STATE" >/dev/null || fail "generated Discussion fixture failed validation"

atomic_install "$OUTPUT_STATE" "$DISCUSSIONS_FILE"

echo "✓ Prepared P3-3 Discussion fixture"
echo "  Workspace: $WORKSPACE_ID"
echo "  Records:   6 deterministic, non-launching presentation states"
echo "  Next: reopen Ply and inspect the Discussion history for the walk anchor card."
