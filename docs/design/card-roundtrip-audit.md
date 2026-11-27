# Card-detail round-trip audit (Cycle H phase 1)

**Owner:** v1.27.0, Cycle H phase 1.
**Scope:** every action that can be initiated from `src/components/CardDetailPanel.tsx`. For each, this doc records the persistence target, the card-side observable surface, and the round-trip gap (if any).

The intent is **not** to fix every gap in v1.27.0 — H-2 fixes the most acute one (dismiss-vs-routing). Other gaps are captured in `# Findings` as candidate downstream kanban cards. None of them are pre-declared as Cycle H phases.

---

## TL;DR

The card detail panel is Atelier's primary lever for shaping a card's lifecycle (intake, dispatch, verify, ship, promote, attach, delete) and its primary signal-receiver for system-driven progress on those levers. v1.26.0 added the first **passive in-card banner** (`LinkedBrainstormBanner`) to surface a brainstorm whose result lands far away (Swarms tab → mailbox → Promote). Before propagating that pattern further, this audit:

1. Enumerates every CardDetailPanel-initiated action and confirms each one has a card-side observable proportional to its weight.
2. Identifies the actions where the user can't tell from the card alone that anything happened (the round-trip gap class).
3. Defines a tight signal-lane budget so banners don't accrete into a wall of yellow.

The most acute finding, listed first below, is that **v1.26.0's banner dismiss button silently destroyed the durable card↔brainstorm routing** by writing `linkedBrainstormId: null` — even though that field is the cross-restart fallback `PromoteButton` uses to find the card. H-2 fixes that by introducing a separate FE-only `dismissedBanners` field.

---

## 1. Action inventory

Every row is an action the user can initiate from `CardDetailPanel.tsx`. "Card-side observable" describes what the user can see on the card itself once the action completes (no Swarms-tab/Now-popover round-trip required). "Gap" is non-empty when there is no observable, or when the observable is misleading.

| # | Action | Trigger (file:line approx) | Persistence target | Card-side observable | Gap |
|---|---|---|---|---|---|
| 1 | **Confirm intake** | `CardDetailPanel.tsx` (intake "Apply" button → `intakeStore.applyIntakeDraft`) | `kanban_apply_intake` writes `Card.dispatch_prompt`, `intake_status = Ready`, appends `IntakeRecord` to `intake_history` (with `applied: true`) | "Intake ready" pill replaces the active intake area; dispatch prompt becomes editable; intake-history tab shows the new record | None — the inline pill is the in-card signal; intake history disclosure surfaces the persisted record. |
| 2 | **Conclude intake** (`__CONCLUDE_INTAKE__` sentinel) | `IntakeConversation.tsx`; sends the sentinel into the intake PTY → `intake_conclude` IPC | `intake_conclude` is a marker that flushes the conversation; the apply step (#1) is what actually writes durable state | Status text in the IntakeConversation panel only — no card-level signal | Minor. The "Apply" step (#1) is what materializes durable state, so the conclude sentinel is a sub-step of Apply. Not a true gap. |
| 3 | **Cancel intake** | `CardDetailPanel.tsx` → `intakeStore.cancelIntake` → `intake_cancel` IPC | Sets `intake_status = None`; appends `IntakeRecord` with `applied: false` | Intake panel collapses; intake-history disclosure gains a `cancelled` record | None. |
| 4 | **Brainstorm launch** | `CardDetailPanel.tsx` → opens `BrainstormModal` → `swarms.swarm_start` + `kanban_update_card` writes `linked_brainstorm_id` | `Card.linked_brainstorm_id` (kanban.rs); swarm state in `SwarmRegistry` | `LinkedBrainstormBanner` renders in the panel (v1.26.0) | **Fixed in v1.26.0** for the running/complete states. ⚠ v1.26.0 also added a `✕` dismiss whose handler clears `linkedBrainstormId`, which destroys the cross-restart routing PromoteButton depends on. **See Finding #1 / H-2.** |
| 5 | **Move Todo → In Progress (oneshot or swarm dispatch)** | `kanbanStore.ts::moveCard` invoked from `KanbanBoard` or the swarm-template confirmation flow | Writes `linked_run_id` or `linked_swarm_id`; resets `lastRunStatus`; persists card via `kanban_save` | Card moves columns; "running" badge appears; on completion, `run_history` entry appended; `lastRunStatus` toggles success/failed | None — running badge + run_history disclosure cover the full lifecycle. |
| 6 | **Verify** | `CardDetailPanel.tsx` → `verifyRunCard` IPC → `verify.rs` pipeline | `Card.verify_status`, `verify_history` append | "Verify: ✓/✗" badge updates; verify-history disclosure shows steps | None. |
| 7 | **Ship now (single-card)** | `CardDetailPanel.tsx` Ship button → `ship.rs` pipeline | `Card.ship_status = Shipped`; `ship_history` append; `commit_sha`, `shipped_version` | "Shipped vX.Y.Z" badge replaces the Ship button; ship-history disclosure shows the entry | None. |
| 8 | **Ship batch (toolbar)** | `KanbanBoard.tsx` toolbar (not strictly card-detail-initiated, but observable from the card) | Same as #7, batched | Same as #7 — but only the cards included in the batch get the badge | None for in-batch cards. |
| 9 | **Promote-to-knowledge** (from SwarmTab → mailbox row → Promote) | `PromoteButton.tsx` → `kanbanStore.updateCard(cardId, { knowledge: appended })` | `Card.knowledge` (appended w/ provenance prefix) | Knowledge textarea now contains the promoted block; v1.25.1 also auto-`selectCard`s the card so the Card tab lands right | **Soft gap.** When the user is in the Swarms tab when Promote fires, the in-card receipt is invisible until they switch tabs. `LinkedBrainstormBanner` (v1.26.0) is the inbound signal for "there's a brainstorm with promotable artifacts" — but there is no outbound "you just promoted X items here" pulse on the card row. See Finding #4. |
| 10 | **Add attachment** | `CardDetailPanel.tsx` → `attachment_add` IPC | `Card.attachments` append; bytes under `<app_config>/attachments/<ws>/<card>/` | Attachment chip + (image) thumbnail in the panel | None. |
| 11 | **Delete card** | `CardDetailPanel.tsx` → `kanban_delete_card` IPC | Removes the card from `KanbanFile.cards`; attachments not deleted by design (kept under config dir until manually cleared) | Panel closes; card disappears from the column | **Soft gap.** Orphaned brainstorm-mailboxes and snapshot directories survive deletion — out of scope for this audit (see § Out of scope). |

---

## 2. Signal-lane budget (between Notes and Knowledge)

The strip of vertical space between the Notes textarea and the Knowledge / context textarea is the **signal lane** — `LinkedBrainstormBanner` is the first occupant (v1.26.0). Without a budget this turns into a wall of yellow as more banners ship.

**Budget for v1.27.0+:**

- **Max 2 visible banners at once**, stacked vertically.
- **If a third+ banner would render**, collapse to a `+(n) hidden` pill where `n = total - 2`. Pill click opens a popover listing the hidden banners in the same order they would have stacked.
- **`dismissedBanners` is respected first** — dismissed banners do not count toward the 2-visible total and do not appear in the `+(n) hidden` count.

**Explicitly deferred decisions (do NOT decide in v1.27.0):**

- **Priority ordering between competing banners** — there is currently only one banner kind, so a single-element list trivially "wins". The first cycle that introduces a second banner kind must decide priority.
- **Dismissed-banner restoration UX** — `dismissedBanners` is forward-only in H-2. When a second banner kind ships, a "show dismissed" affordance may or may not be warranted; defer.
- **Exact pill placement, popover anchor, focus management** — defer until banner #2 forces the question.
- **`SignalBanner` component extraction** — defer until ≥2 callers exist with shape parity (icon + label-as-button + dismiss). Premature extraction would freeze a shape we don't yet understand. Same anti-speculation logic that left `KanbanCard.archived` as a `bool` rather than an enum until a second-state need showed up.

The single-banner case (today) is unaffected by the budget — `LinkedBrainstormBanner` renders inline at `CardDetailPanel.tsx:395`, no pill needed.

---

## 3. Out of scope (Cycle I candidates, not this audit)

These workspace- and dashboard-level surfaces have their own round-trip stories. They are explicitly **not** audited here so the H-1 boundary is auditable as "card-detail panel only":

- **Swarms-tab cross-card pulse / activity.** "I see N brainstorms across all cards finished recently" is a workspace-level question; CardDetailPanel only ever shows one card.
- **Orphaned mailboxes whose owning card was deleted.** Cleanup policy is a workspace concern (see Finding #5 — capture only, no proposed fix).
- **NowPopover / dashboard aggregations.** ⚡ flight deck and similar pulses live in `NowPopover`, not the card detail panel.
- **External GitHub PR / commit links from `ship_history`.** Cross-card historical surfaces aren't card-detail surfaces.

---

## 4. Findings

Each finding is a self-contained gap worth its own downstream kanban card. Finding #1 is H-2 (this same release).

### Finding #1 — Banner dismiss destroys the cross-restart routing (FIX in H-2)

**Symptom:** `LinkedBrainstormBanner`'s ✕ dismiss handler at `CardDetailPanel.tsx:1190-1195` calls `useKanban.getState().updateCard(cardId, { linkedBrainstormId: null })`. That field is the durable card↔brainstorm pointer. Clearing it removes the banner *and* the `PromoteButton.useLinkedCardId` fallback at `PromoteButton.tsx:142` that uses `card.linkedBrainstormId === swarmId` to find the card across an app restart (when the in-memory `linkedCardId[swarmId]` map is empty).

**Impact:** after dismissing the banner and restarting Atelier, Promote-to-knowledge on the same brainstorm's mailbox falls back to "no card linked" → cannot append. Silent feature regression.

**Closing approach (H-2):**

- New FE-only field `dismissed_banners: Vec<String>` on `Card`, format `"<kind>:<id>"`, FIFO-capped at 16, `#[serde(default)]`.
- Schema bump v6 → v7 (no-op migration; mirrors v5 → v6 `linked_brainstorm_id`).
- Banner render gate consults `dismissedBanners.includes("brainstorm:" + linkedBrainstormId)`.
- Dismiss writes `dismissedBanners`, **not** `linkedBrainstormId`. Routing survives.
- Dismiss button title changes from the misleading "Promote auto-routing will be cleared" to "Hide this banner".

### Finding #2 — Conclude intake has no card-level observable

**Symptom:** the `__CONCLUDE_INTAKE__` sentinel only flushes the conversation; nothing on the card visibly changes until the user clicks Apply (#1). The conversation panel has its own status, but a user who scrolls away mid-intake won't see that conclusion happened.

**Why it's a soft gap, not a bug:** Apply is the durable action; conclude is a sub-step. Worth surfacing only if user testing surfaces confusion. Defer; revisit if intake UX is touched again.

**Candidate close:** none scheduled. Capture only.

### Finding #3 — Verify-running pulse vs. verify-failed banner

**Symptom:** verify status is shown as a small badge near the Ship button. While verify is running, the user has no inline notice; if it fails, they only see "✗" until they click into verify history.

**Why it matters:** verify is the gate before Ship; a quiet failure is the only state where the user actively needs more in-panel signal.

**Candidate close:** future "verify failed — open report" banner in the signal lane (subject to the 2-banner budget). Defer until the second banner kind is genuinely needed. Not predeclared as a Cycle H phase.

### Finding #4 — Promote-to-knowledge has no outbound card-side pulse

**Symptom:** when the user promotes an artifact from the Swarms tab, the Knowledge field receives the append, but the Card tab gives no visible "freshly added" cue. v1.25.1's `selectCard` ensures the *correct* card is selected when they switch back; it doesn't draw their attention to *what's new*.

**Closing approach (future card):** brief highlight on the appended Knowledge block (CSS animation), OR a transient toast scoped to the card. Decision deferred.

### Finding #5 — Delete card orphans brainstorm-mailboxes and snapshot directories

**Symptom:** `kanban_delete_card` removes the card row but does not GC `swarms`-side state nor `<config_dir>/snapshots/<runId>/` directories the card produced.

**Out-of-scope here:** out-of-scope per § 3 (workspace-level cleanup story). Recorded only so a future Cycle I cleanup pass has a starting list.

### Finding #6 — `linked_run_id` overwrite on dispatch from a card with a still-running prior run

**Symptom:** `kanbanStore.moveCard` will overwrite `linked_run_id` when a new run is dispatched, even if the previous run hasn't completed yet. The previous run continues in the agents tab but the card's "currently running" pointer no longer matches reality.

**Mitigation today:** the UI hides the dispatch button while `lastRunStatus === "running"`, so this is hard to reach. But not impossible (e.g. agent process never reports, FE thinks it's idle, user re-dispatches).

**Candidate close:** check `linked_run_id`-with-an-active-PTY before allowing dispatch. Defer; not a Cycle H phase.

---

## 5. Verification surface

After H-2, the following invariants are checkable from a fresh Atelier launch:

1. Launching a brainstorm from a card writes `card.linkedBrainstormId`. ✓ unchanged by H-2.
2. Dismissing the banner adds `"brainstorm:<swarmId>"` to `card.dismissedBanners`. **New in H-2.**
3. Restarting Atelier and reopening the card: banner stays hidden (persistence). **New in H-2.**
4. Restarting Atelier and clicking Promote in the Swarms tab on the same brainstorm: `PromoteButton.useLinkedCardId` resolves via `linkedBrainstormId` fallback; append + toast hit the original card. **Preserved by H-2.** (Pre-H-2 this would silently fail.)
5. `card.dismissedBanners` stays ≤ 16 entries under repeated dismissals (FIFO cap). **New in H-2.**

Tier 4 manual walk for H-2 covers all five. See PR description for the run summary.
