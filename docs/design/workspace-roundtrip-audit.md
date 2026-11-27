# Workspace round-trip audit (Cycle I phase 1)

**Owner:** v1.28.0, Cycle I phase 1.
**Scope:** every action initiated above the card level — Swarms-tab toolbar, NowPopover (⚡ flight deck), WorkspaceDashboard, delete-card cascade. For each, this doc records the persistence target, the **workspace-side observable**, and the round-trip gap (if any).

This is the symmetric move to H-1 (`docs/design/card-roundtrip-audit.md`). H-1 carved out workspace-level surfaces and orphaned-state cleanup as Cycle I candidates in its § 3; this doc enumerates them and defines a **cleanup budget** the way H-1 defined the signal-lane budget.

H-1's intent — *every action initiated from CardDetailPanel must have a card-side observable proportional to its weight* — is preserved verbatim here, one scope level up: *every action initiated above the card level must have a workspace-side observable, and every piece of persisted state must outlive its owner predictably or be cleaned up on owner-deletion.*

---

## TL;DR

The Swarms tab is Atelier's only workspace-level surface that aggregates state across cards (mailboxes, swarm runs, brainstorm completions). Today it shows the **active swarm** in detail but offers no peripheral signal for cross-card activity — a user who finishes a brainstorm on card A and immediately switches to card B can't tell from the Swarms tab that A's brainstorm produced anything. v1.29.0 (Cycle I-3) closes that with a workspace pulse.

Separately, **deleted cards leave persistent debris**: brainstorm-mailbox dirs and snapshot dirs that the card created but did not own. v1.28.0 (Cycle I-2) introduces both a per-delete cascade (`kanban_swarm_gc_card` IPC) and a launch-time orphan sweep (`gc_orphan_swarm_dirs`) — defense-in-depth mirroring the snapshots GC pattern from v1.17.0.

The cycle also dedupes `write_atomic_json` (byte-identical in three call sites + an open-coded variant in a fourth) into a single canonical `src-tauri/src/atomic.rs`. Hard Rule #3 (atomic writes) is now load-bearing in one place instead of four.

---

## 1. Action / surface inventory

Every row is something the user can initiate or observe at the workspace level (not card-detail-scoped — those are in H-1). "Workspace-side observable" describes what surfaces on the active workspace's panel(s) without requiring the user to know which specific card produced the activity.

| # | Action / surface | Trigger | Persistence target | Workspace-side observable | Gap |
|---|---|---|---|---|---|
| 1 | **Start swarm (from Swarms tab toolbar)** | `SwarmTab.tsx` "Start swarm" → `swarm_start` IPC | `<config_dir>/swarms/<id>/state.json` + `mailbox.jsonl`; `Swarm.kind = Adhoc` | Active swarm selector updates; SwarmHeader status pill renders; mailbox tail starts | None — explicit user action with immediate inline feedback. |
| 2 | **Cross-card brainstorm completion** | brainstorm reaches terminal state; `swarmStore::maybePushBrainstormCompletionToast` | swarm record flips `endedAt`; mailbox appended | **Toast** fires once on completion (real-time signal). If the user wasn't looking, the toast is gone. | **Closed by I-3.** New `SwarmsTabWorkspacePulse` summarizes recently-finished brainstorms (30-min window) for catch-up signal. |
| 3 | **NowPopover ⚡ flight deck (cross-workspace)** | toolbar ⚡ button → `useLiveRuns` joins tile/agent/kanban/workspace stores | None (read-only aggregation) | Popover lists every live agent-run / swarm leg across workspaces; click jumps. | None — G1 (v1.22.0) closed this. |
| 4 | **WorkspaceDashboard aggregations** | Dashboard right-tab → `WorkspaceDashboard.tsx` flattens card.shipHistory / verifyHistory / intakeHistory + cost rollup | None (read-only aggregation) | Four sections: recent ships, recent verify, cost rollup, recent intakes. | None — E5 (v1.20.0) closed this. |
| 5 | **Delete card** | `CardDetailPanel.tsx::onDelete` → `kanbanStore.removeCard` → kanban save + `kanbanAttachmentGcCard` IPC | Card removed from kanban JSON; attachments dir reaped; **mailbox + swarm dirs NOT reaped** (pre-v1.28.0); snapshot dirs reaped only at next launch via `gc_orphans` | Card disappears from kanban; toast confirms. **No observable that the cascade ran (or didn't).** | **Closed by I-2.** New `kanban_swarm_gc_card` IPC per delete + launch-time `gc_orphan_swarm_dirs` sweep. Cascade refuses running swarms, Adhoc, and still-referenced ids — the actionable case (running swarm) surfaces in the delete-confirm dialog so the user can opt into aborting first. |
| 6 | **Mailbox tail (live)** | `SwarmTab.tsx` → `MailboxFeed` subscribes to `swarm://mailbox` event | mailbox JSONL appended; cache updated | Inline rows render as they arrive (active swarm only). | None — works as designed. Cross-card aggregation is row #2's territory. |
| 7 | **Swarm export** | Swarms-tab toolbar "Export" → `swarm_export` IPC + save dialog | None (read-only) | File saved; toast confirms. | None. |
| 8 | **Reseed role-binding presets** | Swarms-tab toolbar → confirmation dialog → `reseed_presets` IPC | `<config_dir>/role_bindings.json` overwritten | Confirmation dialog before; toast after. | None. |
| 9 | **Adhoc swarm completion** | Adhoc swarm reaches terminal state | swarm record flips `endedAt`; mailbox appended | SwarmHeader status pill updates; no toast (toast is brainstorm-only). | Soft. Audit Finding #1 below — captured for future, not closed here. |
| 10 | **Workspace switch (warmed-host)** | Workspace tab click | None | Right-panel hosts toggle via `.right-tabs-host` visibility; SwarmTab stays mounted per-workspace; pulse re-evaluates from the new workspace's slice. | None — the pulse honors the warmed-host pattern by being scoped per-workspace via `useRecentlyFinishedSwarms(workspaceId)`. |

---

## 2. Cleanup budget (where state goes when its owner is deleted)

H-1 defined a **signal-lane budget** for banners (max 2 visible + `+(n) hidden` collapse). The workspace-level analog is a **cleanup budget**: when state lives under `<config_dir>/` and can outlive its owner (mailboxes, snapshots, attachments, intake transcripts), name where the cascade goes and what the launch-time reconcile catches.

**Three persistence stores have orphan-survivability today:**

| Store | Path | Owner | Per-delete cleanup | Launch-time reconcile |
|---|---|---|---|---|
| Attachments | `<config_dir>/attachments/<ws>/<card>/` | Card | `kanban_attachment_gc_card` (v1.10.0) | None — relies on per-delete only |
| Snapshots | `<config_dir>/snapshots/<runId>/` | Run (via card.run_history) | None | `SnapshotsStore::gc_orphans` at launch (v1.17.0) |
| Swarms | `<config_dir>/swarms/<id>/` | Card (when `kind != Adhoc`) or User (when `Adhoc`) | **`kanban_swarm_gc_card`** (v1.28.0, **new**) | **`SwarmRegistry::gc_orphan_swarm_dirs`** at launch (v1.28.0, **new**) |

**Defense-in-depth rule for new stores:** when adding a new persisted store with orphan-survivability, write **both** the per-delete cascade IPC AND the launch-time orphan sweep. The per-delete path is the fast cleanup; the launch-time sweep catches anything the event path missed (FE crash mid-delete, IPC failure, manual file move). Snapshots had the launch path only and survived; swarms had neither and accumulated cruft for a year.

**Adhoc carveout pattern:** when a store has *user-initiated-but-unowned* entries (e.g. Adhoc swarms started from the Swarms-tab toolbar), the classifier must carve them out of every GC predicate. Don't make them rely on appearing in the live set — by definition they're not in any owner's reference list.

**Conservative-on-unclassifiable rule:** when the classifier can't read or parse an entry (corrupt JSON, missing schema), **keep it**, log a `warn!`, and surface in telemetry. Silent data loss on a schema bump is much worse than a stale orphan. `gc_orphan_swarm_dirs` follows this; the snapshots GC predates the rule but is naturally compatible (its predicate is "is the runId in this set", which fails closed).

**v1.28.0 first-launch behavior:** Atelier installations carrying card deletions from v1.27.x and earlier will sweep accumulated orphan swarm dirs on first v1.28.0 launch. Expect a one-time burst of `swarms: gc_orphan_swarm_dirs pruned N orphan dir(s)` log lines. This is intended cleanup, not a bug.

**Explicitly deferred decisions (do NOT decide in v1.28.0):**

- **Workspace deletion cascade.** If a workspace itself is deleted, its swarms / snapshots / attachments orphan en masse. Not in scope — workspace deletion is a separate path that lives in `WorkspaceStore`, not the card cleanup story. The launch-time sweep will eventually reclaim them on a future relaunch.
- **Per-delete snapshot cleanup.** Snapshots already have a launch-time GC; adding a per-delete IPC for snapshots would be theme-creep. Revisit if a user complaint surfaces about disk usage between launches.
- **Intake-transcript orphans on card delete.** `card.intakeHistory[].transcriptPath` points at files under `<config_dir>/intake_transcripts/`. The current behavior is the same as pre-I-2 swarms (no cascade). Capture only — see Finding #2.

---

## 3. Out of scope (Cycle J+ candidates, not this audit)

These surfaces have their own round-trip stories and are explicitly **not** audited here so the I-1 boundary is auditable as "workspace-level surfaces above CardDetailPanel only":

- **Cross-workspace observability beyond ⚡.** The flight deck (G1, v1.22.0) shows live runs cross-workspace; aggregating *completions* cross-workspace (e.g. "3 brainstorms finished across all workspaces in the last hour") isn't a Cycle I question.
- **Cost-aware live burn-rate meter.** Deferred from Cycle G, still deferred — workspace dashboard already shows weekly rollup.
- **Right-tab simplification round 2.** G3 trimmed 11 → 8. If 8 still feels dense, that's a future cycle, not Cycle I.
- **Pipeline / multi-step orchestration visualization.** Belongs to the deferred claudeclaw harness, not Cycle I.

---

## 4. Findings

Each finding is a self-contained gap worth a downstream kanban card. Findings #1–#2 are deferred; the load-bearing fixes (`SignalBanner` decision, workspace pulse) ship as parts of I-2 / I-3.

### Finding #1 — Adhoc swarm completion has no workspace-level signal

**Symptom:** when an Adhoc swarm finishes, the SwarmHeader status pill updates but no toast or pulse fires. The brainstorm-completion toast (`swarmStore::maybePushBrainstormCompletionToast`) is gated on `kind === "brainstorm"`; Adhoc swarms — including the v1.21.2 `claude-codex-debate` flow when started outside the Brainstorm modal — produce no peripheral notification.

**Why it's a soft gap:** Adhoc swarms are user-initiated from the Swarms tab toolbar, so the user is presumably watching when they fire. The signal-when-you-need-it case is brainstorms launched from cards (you launch, switch contexts, want to know when it's done).

**Candidate close:** if user testing surfaces "I didn't notice my codex-debate finished," extend the toast predicate to fire on Adhoc completions too. Defer; revisit if a complaint arrives. Not predeclared as a Cycle I phase.

### Finding #2 — Intake-transcript files not GC'd on card delete

**Symptom:** `card.intakeHistory[].transcriptPath` points at files under `<config_dir>/intake_transcripts/`. When the owning card is deleted, the transcript files remain. Same class as pre-I-2 swarm dirs.

**Why deferred:** intake transcripts are smaller than swarm dirs (typically <50 KB) and far fewer per card (cap of 10 per card.intakeHistory, FIFO). The disk-usage impact is much smaller than swarms / snapshots, so the urgency is lower.

**Candidate close:** extend `kanbanStore::removeCard` to also call a new `kanban_intake_gc_card` IPC, mirroring the swarm cascade. Same pattern, smaller stakes. Defer until disk-usage feedback surfaces.

### Finding #3 — `SignalBanner` extraction deferred (again)

**Symptom:** H-1 punted `SignalBanner` extraction as "premature single-caller abstraction." I-3 was the natural moment to revisit when a second caller (workspace pulse) emerged — but the shapes diverge meaningfully:

| Concern | `LinkedBrainstormBanner` (card) | Workspace pulse |
|---|---|---|
| Scope | Single linked entity | Aggregated N entities |
| Dismiss | Persistent (schema field, FIFO 16) | Session-only or none |
| Click target | Single swarm → open | List of N → expand-then-pick |
| Render gate | `dismissedBanners` + linkage | Time window + count > 0 |
| Tone variants | 4 (running/done/aborted/empty) | 1–2 |

**Decision:** keep them separate. Share only the CSS tone vocabulary by extracting `--brainstorm-done` / `--brainstorm-aborted` / etc. to `:root` custom properties (value-preserving — same colors, just hoisted). When a third banner-shaped surface appears with parity-compatible shape, extract then. Same anti-speculation discipline that left `archived` as a `bool` rather than an enum until a second-state need surfaced.

**Trigger to revisit:** any new banner-shaped surface that (a) has both a render-gate and a dismiss affordance, (b) targets a single entity, (c) renders a tone variant. If two of three match, extract. Workspace pulse misses on (a) — its render gate is time-windowed not dismiss-tracked — and (b) — it aggregates, not single-entity.

### Finding #4 — Pulse only fires when SwarmTab is mounted

**Symptom:** The workspace pulse (I-3) lives inside `SwarmTab.tsx`. If the user never visits the Swarms tab, no pulse renders even after recent brainstorm completions. The completion **toast** (`swarmStore::maybePushBrainstormCompletionToast`) is the real-time signal that fires regardless of mounted state.

**Why it's by design:** the pulse is the *catch-up* surface, not the *real-time* signal. The toast is real-time; the pulse picks up after a context switch. Splitting the responsibilities prevents double-signaling.

**Documented, not closed.** This finding exists to anchor future questions like "should the pulse fire on the Workspace dashboard too?" — answer: probably not, because then it competes with the toast for the same user attention.

---

## 5. Verification surface

After v1.28.0 (I-1 + I-2), the following invariants are checkable from a fresh Atelier launch:

1. Deleting a card with a linked brainstorm (terminal) removes the swarm dir from `<config_dir>/swarms/`. ✓ New in v1.28.0.
2. Deleting a card with a linked **running** brainstorm: cascade refuses, log warns, dir stays. FE delete dialog surfaces the question. ✓ New in v1.28.0.
3. Manually orphaning a swarm dir + relaunching: launch-time sweep prunes it, logs `pruned N orphan dir(s)`. ✓ New in v1.28.0.
4. Adhoc swarms survive both the per-delete cascade and the launch-time sweep. ✓ Asserted by `gc_orphan_swarm_dirs_preserves_adhoc_kind`.
5. Archived / Legacy cards contribute their `linkedBrainstormId` / `linkedSwarmId` to the live set; their linked swarms survive the launch-time sweep. ✓ Tier 4 walk step #7.
6. Corrupt `state.json` in an orphan-candidate dir → dir kept conservatively. ✓ Asserted by `gc_orphan_swarm_dirs_keeps_corrupt_state_conservatively`.
7. Agent-typo'd artifact filename → `read_swarm_artifact` fallback rescues. ✓ Asserted by `read_swarm_artifact_fallback_single_typo`.

After v1.29.0 (I-3), the following additional invariants are checkable:

8. A brainstorm finishing within the last 30 minutes surfaces in the Swarms-tab workspace pulse. ✓ Pure-function predicate test.
9. Adhoc swarms do NOT appear in the pulse (it filters `kind === "brainstorm" || kind === "card"`).
10. The pulse ages out after 30 minutes via the 60s heartbeat. ✓ Wall-clock test.

Tier 4 manual walk for v1.28.0 covers all of 1–7; for v1.29.0, all of 8–10. See plan file / STATUS.md for the per-version run summary.
