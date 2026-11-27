# Cycle — Outcome screen (design doc)

> Execution design for the Outcome screen cycle in
> `~/.claude/plans/what-i-want-to-noble-hedgehog.md`. Read that plan's Cycle 1
> section first. Ships as **v1.31.0** — together with the already-built per-hunk
> Review surface, which becomes this cycle's developer-disclosure layer.

## Goal

One post-swarm screen a non-developer can act on — *did it work*, not *is the
code right*. A vibe coder reviews **outcomes**: what was asked, whether an AI
reviewer approved it, whether automated checks pass — then **Ship it** or
**send it back**. Full developer depth (per-hunk diff, verify steps, ship
options) sits one click away via **progressive disclosure** — no mode toggle.

## Resolved open questions

1. **Plain-language summary source.** `verify_intent` has *no production
   writer* — treat it as always empty. The outcome screen's "what happened"
   = the card's own goal (what the user asked) + a **diff-derived change line**
   (`N files: +x ~y -z`, from `card_review_diff` data) + the reviewer's
   `critique`. A dedicated artifact `summary` field is an optional later
   refinement — **not** MVP; it would mean a swarm-prompt change (calibration
   risk). MVP uses only data that already exists.
2. **Reviewer verdict.** The `reviewer` leg's artifact carries `verdict`
   (`approve`/`reject`) + `critique` (prose). Surface both. Templates with no
   reviewer leg (`ux-audit`, `design`, `review-followup`, coordinator pools
   without a reviewer dispatch) → the screen shows "no AI review on this run"
   and leans on verify + the change line.
3. **"Ship it" default = local merge.** Works offline, no GitHub dependency.
   PR is the explicit alternative inside the disclosure (Phase 3).
4. **No verify pipeline configured.** Many customer projects have none. The
   screen shows "No automated checks set up for this project" + leans on the
   reviewer verdict, and nudges configuring verify (seeds onboarding, Cycle 2).

## Phase plan

### Phase 0 — already built (repositioned, no rework)

The per-hunk Review surface — `CardReviewPanel`, `git.rs`, `review.rs`, the four
review IPCs, `ConflictBanner`, rate-limit state, the `review-followup` template,
the `Swarm.cwd` isolation fix — is **the developer-disclosure layer**. No code
changes; it stops being the default surface.

### Phase 1 — lifecycle cleanups

- **Auto-run verify on swarm completion.** In `on_swarm_run_done`'s card-kind
  terminal path (next to the existing queue-pump / review-clear), enqueue a
  verify job. **Critical:** verify must run in the card's **worktree**
  (`card.worktree_path`) — the swarm's changes are there, unmerged — not
  `workspace.cwd`. `VerifyRegistry::enqueue` currently hardcodes
  `repo_root = ws.cwd`; extend it (or `VerifyRequest`) to accept an optional
  repo-root override and pass the worktree. Skip when the card has no worktree
  or no verify pipeline configured.
- **"Ready for you" card state.** A swarm-done card auto-moves to the Complete
  column but isn't done — it awaits review. Keep the 3-column board (no 4th
  column). Add a clear **card-state pill** — "Ready for you" on a swarm-done,
  unshipped, unmerged card; driven by existing fields (`linked_swarm_id`
  terminal + `review_status != Merged` + `ship_status != Shipped`). Pure FE
  derivation, no schema change.
- **Inline intake offer.** When a card dragged Todo→In Progress is too thin
  (e.g. no `notes`/`knowledge`/`dispatch_prompt`, short title), surface an
  inline "Want me to ask a few questions first?" prompt instead of requiring
  the user to know to click "Confirm intake" beforehand. FE-only — reuses the
  existing intake flow; just changes when it's offered.

### Phase 2 — the outcome screen (vibe default)

- **New IPC `card_outcome(workspace_id, card_id) -> CardOutcome`** — aggregates:
  the card goal, the linked swarm's terminal status, the reviewer verdict +
  critique (scan the swarm's run artifacts for the reviewer leg), the change
  line (file count + kind counts from `git::diff_hunks`), and the latest verify
  result (`VerifyRegistry`/`verify_status`). One call, everything the screen
  needs. Pure read-side aggregation.
- **New `OutcomeScreen.tsx`** — mounts in `CardDetailPanel`, replacing the
  direct `CardReviewPanel` mount as the default. Renders:
  - "What you asked for" — the card goal.
  - Reviewer verdict — ✓ approved / ⚠ flagged + the `critique` prose, or "no AI
    review on this run".
  - Verify result — ✓ checks pass / ✗ failed (step summary), or "no checks
    configured" + nudge.
  - The change line.
  - **Actions:** "Ship it" · "Not right — tell them what's wrong".
  - **Progressive-disclosure `<details>` "Show developer details"** — renders
    the existing `CardReviewPanel` (per-hunk accept/reject) + `VerifyPanel`
    (step detail) + ship options. Existing components, just nested.
- "Not right" opens the reject-with-feedback flow framed as *describe the
  problem* — one textarea, not per-hunk. Backend reuses
  `card_review_request_changes` (a whole-card rejection = one synthetic
  rejection carrying the user's prose, no hunk).

### Phase 3 — "Ship it" (folds in the former Cycle 2)

- **`ReleaseKind::GithubPr`** + `gh` probe in `shell_env.rs` +
  `ShipEntry.pr_url`. "Ship it" → local squash-merge (the default);
  the disclosure exposes "Open a PR instead" → `git push` + `gh pr create`,
  with a local-merge fallback when there's no remote / `gh` is absent.
- Amend the CLAUDE.md "no git push UI" hard rule; keep Atelier-self-ship
  isolated in `ship.rs`. The release gate skips its own squash-merge when the
  worktree is already merged (`branch_name` cleared / `review_status: Merged`).

### Phase 4 — deferred

"See it running" (build/preview the worktree) — a feature on its own; the
screen works without it.

## Data model

- No new persisted fields for the MVP. The "Ready for you" pill is FE-derived;
  `CardOutcome` is a transient IPC payload; Phase 3 adds `ShipEntry.pr_url`
  (`#[serde(default)]`, Tier 2 test) + `ReleaseKind::GithubPr`.
- `VerifyRequest` gains an optional repo-root override (or `enqueue` resolves
  the card's worktree) — internal, no schema bump.

## Edge cases

- Swarm still running → outcome screen shows "working…", no actions (mirrors
  `CardReviewPanel`'s existing gate).
- No reviewer leg / no verify pipeline → graceful "not available" states, never
  a hard error.
- Verify runs in the worktree; if the worktree is gone, skip with a logged
  warning (best-effort, never blocks swarm completion).
- A coordinator swarm: the reviewer verdict may be one of several leg
  artifacts — scan all `run_ids`, take the last reviewer-role artifact.

## Test plan

- Tier 1: `./scripts/ppvp.sh` 7/7.
- Tier 2 (`cargo test --lib`): `ShipEntry`/`ReleaseKind` migration; a
  pure-function test for the change-line / outcome-aggregation helper.
- Tier 4: run a card swarm → outcome screen shows goal + reviewer verdict +
  auto-verify result → expand developer details → confirm the hunk view is
  intact → "Ship it" lands the card → "Not right" dispatches a follow-up.
  Thin-card drag → intake offered inline. Swarm-done card → "Ready for you"
  pill.

## Increment order

Phase 1 (auto-verify → Ready pill → inline intake) → Phase 2 (`card_outcome`
IPC → `OutcomeScreen`) → Phase 3 (PR pipeline → hard-rule amendment) → verify,
Tier 4, ship v1.31.0, update `docs/STATUS.md`.

Cross-cutting: `SAAS_READINESS.md` 5-point checklist; atomic writes; PPVP 7/7;
hard rules intact except the documented no-push amendment.
