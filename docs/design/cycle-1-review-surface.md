# Cycle 1 — Review surface (design doc)

> Execution-level design for Cycle 1 of the roadmap in
> `~/.claude/plans/what-i-want-to-noble-hedgehog.md`. Read that plan's Cycle 1
> section first — this doc resolves the deferred specifics: struct shapes, IPC
> signatures, the follow-up-swarm mechanism, rate-limit detection, and the
> frontend rendering. Target version: **v1.31.0**.

## Goal

Turn the read-only post-swarm diff into an interactive surface where a
non-expert can: read a plain-language summary, accept good work, reject bad
work per-hunk with feedback (which dispatches a follow-up swarm into the same
worktree), land accepted work into the local target branch, see cross-swarm
file conflicts, and tell a rate-limited run apart from a real failure.

Scope: **card swarms only** (they have a per-card worktree + branch). Adhoc /
brainstorm swarms keep the read-only snapshot viewer — a stated known
limitation.

## Deviations from the plan (decided here)

1. **No shared `DiffBody` extraction.** `RunChangesPanel` renders a whole-file
   CodeMirror `MergeView` from snapshot before/after strings
   (`RunChangesPanel.tsx:106-148`). The review surface needs **per-hunk**
   controls, which a whole-file MergeView does not afford. The review panel
   gets its own `HunkList` / `HunkView` renderer over unified-diff hunks;
   `RunChangesPanel` is left **untouched** (lower regression risk). The reuse
   is CSS tokens + the CodeMirror dark/light theme setup only.
2. **`git.rs` consolidates three helpers, not two.** `worktrees.rs` has its own
   private `run_git`; `ship.rs` has `git_run` / `git_capture`. The new
   `git.rs` absorbs all three so there is one git shell-out implementation.

## Data model

### Rust (`src-tauri/src/`)

New module `review.rs` owns the review types; the card fields live in
`kanban.rs`.

```
// review.rs — diff types (returned by card_review_diff)
struct ReviewDiff {
    card_id: String,
    base_branch: String,        // the target branch the worktree forked from
    card_branch: String,
    files: Vec<ReviewFileDiff>,
    generated_at: i64,
}
struct ReviewFileDiff {
    path: String,
    old_path: Option<String>,   // Some only for renames
    kind: ReviewChangeKind,     // Added | Modified | Removed | Renamed
    hunks: Vec<ReviewHunk>,
}
struct ReviewHunk {
    header: String,             // raw "@@ -a,b +c,d @@ ..." line — stable-ish id
    old_start: u32, old_lines: u32,
    new_start: u32, new_lines: u32,
    body: String,               // raw unified-diff text of the hunk (the +/-/ context lines)
}

// review.rs — request_changes input / merge result
struct ReviewRejection { path: String, hunk_header: String, feedback: String }
struct ReviewMergeResult { merged: bool, conflicting_paths: Vec<String> }
```

```
// kanban.rs — new KanbanCard fields, both #[serde(default)]
review_status: Option<ReviewStatus>,        // None = not yet reviewed
review_decisions: Vec<ReviewDecision>,

enum ReviewStatus { Pending, ChangesRequested, ConflictBlocked, Merged }   // snake_case
struct ReviewDecision {
    path: String,
    hunk_header: String,
    status: ReviewDecisionStatus,   // Accepted | Rejected
    feedback: Option<String>,       // Some only when Rejected
}
```

`review_decisions` is the persisted per-hunk verdict set so a half-finished
review survives a card-panel close / app restart. It is **cleared** whenever a
follow-up swarm linked to the card reaches a terminal state (the diff has
changed — old hunk headers are stale). Cleared in `on_swarm_run_done` on the
card-kind terminal path, next to the existing `run_history` append.

### TypeScript (`src/ipc.ts`)

Mirror every struct above (camelCase). `ReviewStatus` /
`ReviewDecisionStatus` as string-literal unions.

### Migration

All new fields are `#[serde(default)]` — the serde default *is* the migration,
no `schema_version` bump. Legacy cards load with `review_status: None`,
`review_decisions: []`. **Tier 2 test** in `kanban.rs` tests: a pre-v1.31 card
JSON (no review fields) deserializes with the defaults; round-trips clean.

## The git layer — `src-tauri/src/git.rs`

Mechanical extraction, no behavior change:

- `run(repo: &Path, args: &[&str]) -> Result<(), String>` — from `ship.rs::git_run`.
- `capture(repo: &Path, args: &[&str]) -> Result<String, String>` — from `ship.rs::git_capture`.
- `worktrees.rs::run_git` call sites repoint to `git::run` / a capturing variant.

New function:

- `diff_hunks(repo: &Path, base: &str, head: &str) -> Result<Vec<ReviewFileDiff>, String>`
  — runs `git diff --no-color <base>...<head>` (three-dot: changes `head`
  introduced since the merge-base, i.e. exactly the card's work), parses the
  unified-diff output into `ReviewFileDiff` / `ReviewHunk`. Parser splits on
  `diff --git`, reads `new file mode` / `deleted file mode` / `rename` markers
  for `kind`, splits hunks on `@@`. **Pure function over a diff string** — a
  `parse_unified_diff(&str)` inner fn is the unit-tested seam (Tier 2: feed a
  known diff blob, assert file/hunk/kind breakdown).

## IPC surface (`src-tauri/src/commands.rs`, registered in `generate_handler!`)

```
card_review_diff(workspace_id, card_id) -> Result<ReviewDiff, String>
```
Resolves the card; errors friendly+specific if `worktree_path` is `None`
("this card has no worktree yet"), the dir is gone, or the card is still
queued. Calls `commit_pending_in_worktree` (idempotent — `worktrees.rs:297`)
to flush the swarm's uncommitted edits *and new files* onto the branch, then
`git::diff_hunks(worktree, base_branch, card_branch)`. Empty `files` vec is the
"swarm changed nothing" state (rendered, not an error).

```
card_review_request_changes(workspace_id, card_id, rejections: Vec<ReviewRejection>)
    -> Result<String, String>   // returns the new swarm id
```
Builds the follow-up prompt (below), dispatches the adaptive follow-up swarm
with `cwd_override = worktree_path`, `SwarmKind::Card`. Re-points the card's
`linked_swarm_id` to the new swarm; sets `review_status = ChangesRequested`.
Persists the `rejections` into `review_decisions` (status `Rejected`).

```
card_review_merge(workspace_id, card_id) -> Result<ReviewMergeResult, String>
```
Calls `squash_merge_into_workspace` (`worktrees.rs:340`, already errors on
conflict). On success: commits the squashed index on the target branch
(reusing the ship-pipeline commit shape, message `Land card: <title>`), sets
`review_status = Merged`, returns `{ merged: true, [] }`. On conflict: aborts
the merge (`git merge --abort`), sets `review_status = ConflictBlocked`,
returns `{ merged: false, conflicting_paths }` parsed from
`git diff --name-only --diff-filter=U`. **Never half-merges.** Does not prune
the worktree (Cycle 2's PR path may need the branch) and does not bump
versions.

```
workspace_worktree_overlaps(workspace_id) -> Result<Vec<Overlap>, String>
```
For every active or unmerged card swarm in the workspace, `git diff
--name-only <current target tip>...<card_branch>`; computes pairwise file-set
intersections; returns `[{ path, card_a, card_b }]`. Diffing against the
*current* target tip (not the original fork point) keeps it correct after
another card lands. Pure read-side aggregation — no FSM interaction.

## The follow-up swarm

**Adaptive template choice** (per the locked decision "Match the original"):

- Look up the card's `swarm_template_id` and resolve the template.
- If the template runs in **coordinator mode** (`coordinator: true` — see
  `swarm_templates.rs`), **reuse it**: the coordinator can scope a small
  feedback pass itself.
- Otherwise dispatch a new lightweight builtin **`review-followup`** template:
  a single `builder` `RoleStep`, bound to the same `AgentConfig` the card's
  original swarm used. Add it to `swarm_templates.rs::builtin_templates()`.

**Follow-up prompt** (the swarm goal):

```
# Review feedback

A reviewer reviewed your changes in this worktree and rejected the items
below. Address each one, then stop. Do not revert or re-touch changes that
were not rejected.

## Rejected change 1 — <path>
<hunk.body>

Reviewer feedback: <feedback>

## Rejected change 2 — <path>
...
```

The follow-up runs in the *same worktree* so it sees the current state and
appends commits to the card branch. On its terminal completion,
`on_swarm_run_done` clears `review_decisions` (stale) and the user re-reviews.

## Rate-limit-aware run state

`ClaudeStreamParser` (`agents.rs:349`) has no rate-limit signal today.

- Add `throttled: bool` to `AgentRun`, `#[serde(default)]`.
- In the parser's end-of-run path, scan the `result` event error field and
  captured stderr for rate-limit markers — case-insensitive `rate limit`,
  `rate_limit`, `overloaded`, `429`. **Documented brittle heuristic** — CLI
  wording can change; acceptable for v1, revisit if it misfires.
- Add `LastRunStatus::RateLimited` (`kanban.rs:164`), TS union member, kanban
  badge glyph + neutral-grey tone (mirror the v1.30.0 `Aborted` addition).
- Swarm→card mapping (`swarms.rs:~4515`): a swarm that ended `Failed` whose
  final leg's run is `throttled` maps to `RateLimited` instead of `Failed`.
- `card_is_queue_eligible` (`kanban.rs`) already excludes only `Failed` — a
  `RateLimited` card therefore stays queue-eligible and the v1.30.0 pump
  auto-retries it. Accept retry-thrash risk for v1 (cap of 3 bounds the blast
  radius); a backoff is a later refinement.
- **Tier 2 test:** legacy `AgentRun` JSON without `throttled` deserializes.

## Frontend

### `CardReviewPanel.tsx` — mounted inside `CardDetailPanel`

No new top-level tab. Renders one of four states, derived from the card +
linked-swarm status the panel already has in store:

| State | Condition | Render |
|-------|-----------|--------|
| still-running | linked swarm Running/Suspended | "Swarm still working…" placeholder, no actions |
| empty-diff | `card_review_diff` → `files: []` | "This swarm changed nothing." |
| conflict-blocked | `review_status == ConflictBlocked` | conflict notice + the conflicting paths + "Retry merge" |
| reviewable | otherwise | the diff + per-hunk controls |

Reviewable layout:
- **Plain-language summary header** — render the swarm's final result artifact
  (already parsed post-run; no new `claude` call) as a one-paragraph lede.
- **Permission-visibility line** — a small read-only line stating the
  permission posture the swarm's `claude` runs spawn with. *Open item: confirm
  in implementation what flags swarm runs actually pass (`agents.rs` /
  `swarms.rs` spawn path); if none, state the effective default.*
- **`HunkList`** — files → `HunkView` per hunk: the unified-diff body styled
  per line (`+` green / `-` red / context neutral, reusing `.run-changes-*`
  tone), with **Accept** / **Reject** buttons. Reject expands a feedback
  textarea. Hunk verdicts seed/update `review_decisions` (persisted via the
  existing `kanbanStore.updateCard` path).
- **Footer** — "Request changes (N)" (N = rejected hunks) →
  `card_review_request_changes`; "Merge to `<base>`" → `card_review_merge`,
  enabled only when zero hunks are Rejected. (Cycle 2 turns this into a split
  "Merge locally | Ship as PR".)

### `ConflictBanner.tsx`

Mounted in `CardDetailPanel` and the Swarm tab. Consumes
`workspace_worktree_overlaps`; refetched on review-panel open, on queue-pump,
and after any `card_review_merge` (a landed card shifts every other card's
base). Warn-only in Cycle 1 — lists "Card A and Card B both edit `<path>`".
Reuses the `--signal-aborted-*` CSS tone family.

## Edge cases (resolved)

- **Review of a still-running swarm** — gated by the still-running state; no
  actions until the linked swarm is terminal.
- **`card_review_merge` real conflict** — `ConflictBlocked` + paths, no
  half-merge, worktree intact, "Retry merge" available after the user resolves.
- **Stale decisions** — cleared on follow-up swarm terminal completion.
- **Already-shipped legacy cards** — the panel renders only when the linked
  swarm is terminal AND `ship_status != Shipped`, so pre-upgrade shipped cards
  never re-enter review.
- **Empty diff** — explicit state, Merge disabled.
- **Worktree missing / card queued** — friendly, specific IPC errors.

## Test plan

- **Tier 1:** `./scripts/ppvp.sh` stays 7/7.
- **Tier 2 (`cargo test --lib`):** `parse_unified_diff` over a known blob;
  card schema migration (no review fields → defaults); `AgentRun` migration
  (no `throttled`); swarm→card mapping for a throttled-failed swarm →
  `RateLimited`.
- **Tier 4 walk:** run a card swarm → open `CardReviewPanel` → reject a hunk
  with feedback → adaptive follow-up swarm dispatches into the *same* worktree
  → decisions clear on its completion → re-review → accept all → Merge →
  branch landed on the target branch. Two card swarms on one file →
  `ConflictBanner` shows; land one → other's banner re-evaluates. Force a
  rate-limit → card reads "Rate-limited", stays queue-eligible. Force a merge
  conflict → `ConflictBlocked`, no half-merge.

## Increment order

Matches the Cycle 1 task list:
1. `git.rs` extraction + `diff_hunks` (+ parser test).
2. Card review schema fields + migration test.
3. `card_review_diff` IPC.
4. `card_review_request_changes` IPC + `review-followup` builtin template.
5. `card_review_merge` IPC.
6. `workspace_worktree_overlaps` IPC.
7. Rate-limit detection + `LastRunStatus::RateLimited` + migration test.
8. `CardReviewPanel` + `HunkList`/`HunkView`.
9. `ConflictBanner`.
10. Verify (Tier 1/2/4), update `docs/STATUS.md`, ship v1.31.0.

Hard rules: PTY model untouched; atomic writes for the new card fields
(`kanbanStore` already canonical); new IPCs auto-allowed via `generate_handler!`;
no Tauri capability change. `SAAS_READINESS.md` 5-point checklist applies —
notably the friendly-error principle on every new shell-out.
