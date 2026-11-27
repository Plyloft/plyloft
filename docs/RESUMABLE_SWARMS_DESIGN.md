# Resumable swarms — v1.1.0 design

Cmd-Q resilience for in-flight swarms. Codename retained: **Swarm**, this is a runtime extension. A swarm that was running when Atelier exited becomes **resumable** instead of being lost.

This is the v1.1.0 spec. It composes on top of the v1.0.1 swarm runtime; nothing in `swarms.rs` is replaced wholesale. Implementation increments live in §15.

## 1. Goals & non-goals

**Goal.** Cmd-Q (or crash) during a swarm produces a `Suspended` state that the user can resume on next launch. Prior role outputs (scout's plan, builder's diff, reviewer's verdict if reached) are reused; only the in-flight role re-fires. From the user's POV: "I quit at 25 minutes in, came back, clicked Resume, swarm picked up where it left off."

**Non-goals (deferred to v1.2+).**

- Resumption across binary upgrades (the seeded role-preset prompts may have changed; resumption against a new prompt body is undefined behavior — flag as risk, don't try to detect).
- Resumption of swarms whose workspace `cwd` was deleted between exit and relaunch (treat as `Failed` with a clear message).
- Resumption of swarms across machines (no machine-id in the swarm record; out of scope).
- Auto-resume on launch (always opt-in via UI button — don't surprise the user with restarted work).
- Mid-role partial-output salvage (we re-fire the in-flight role from scratch; we do not try to "continue" a partial transcript).
- Cross-workspace swarms (still deferred per v1.0 design doc §17 #4).

## 2. Definitions

| Term | Meaning |
|---|---|
| **Suspended** | A swarm whose status was `running` when Atelier exited. Distinguishes from `Aborted` (which now means *only* user-clicked abort). |
| **Resume** | Reattach to a `Suspended` swarm: re-fire the role that was in-flight, advance the FSM as new completions arrive. |
| **Suspended duration** | Wall-clock time the swarm spent in `Suspended` state, excluded from the wall-time cap. |
| **Resumable cutoff** | A staleness guard. Swarms suspended >24h auto-resolve to `Failed { "stale, not resumable" }`. Prevents a swarm from being resumed against a codebase that has drifted significantly. |

## 3. Hard rules carried forward

| Rule (CLAUDE.md / SWARM_DESIGN §3) | How resume respects it |
|---|---|
| **#1 No SDK with API key** | Resumed runs go through `AgentRegistry::start_run` exactly like fresh runs. No API client. |
| **#2 PATH probe** | Inherited automatically — `start_run` injects cached PATH. |
| **#3 Atomic writes** | `state.json` updated via `write_atomic_json` on every transition, including the new `running → suspended → running` transitions. Mailbox JSONL append still uses `OpenOptions::append + sync_all`. |
| **#4 Kill all on exit** | Unchanged. The exit path now writes `Suspended` instead of `Aborted` for `running` swarms (see §5). |
| **#5 Window close hides** | No interaction. |
| **#6 `dragDropEnabled: false`** | Resume button is HTML5 click; no drag involved. |

## 4. Architecture overview

```
src-tauri/src/
├── swarms.rs           # Suspended state + resume entry point + reconcile path changes
├── agents.rs           # No changes. Resumed runs spawn through start_run as usual.
├── commands.rs         # +1 IPC: swarm_resume(swarm_id)
├── lib.rs              # Reconcile path: running → suspended (was: running → aborted)
└── settings.rs         # No changes (resume is not gated by a setting in v1.1.0).

src/
├── components/
│   ├── SwarmTab.tsx    # Suspended-state UI: "Resume" + "Abort permanently" buttons,
│   │                   # banner explaining the swarm was orphaned by app exit.
│   └── SwarmHeader.tsx # Status pill recognizes Suspended; pill copy "suspended — N min ago".
├── store/swarmStore.ts # +1 method: resumeSwarm(swarmId).
└── ipc.ts              # +1 typed wrapper: swarmResume.
```

The state machine extension is small: add a `Suspended` status with a per-swarm `suspended_at` timestamp + `suspended_runs: Vec<{run_id, role}>` indicating which run was in-flight. Resume reads `state.json`, identifies the in-flight role, calls `start_run` with reconstructed handoff payload, and the existing `agent://run-done` listener takes over.

## 5. Data model & persistence

### 5.1 New types / additive fields

```text
SwarmStatus (enum):
  Running
  Done | Failed | Aborted | TimedOut | MaxIter
  Suspended    // NEW

Swarm {
  // ... existing fields unchanged ...
  suspended_at: Option<u64>,        // NEW. Unix ms when status flipped to Suspended.
  suspended_seconds: u64,           // NEW. Cumulative time spent in Suspended state across resumes. Default 0.
  in_flight_role_at_suspend: Option<String>,  // NEW. "scout" | "builder" | "reviewer" — the role whose run was killed by app exit.
}
```

All additive, all `serde(default)`. Tier 2 fixture test required: legacy `state.json` (pre-v1.1.0) loads with these as `None`/`0`/`None`.

### 5.2 Mailbox additions

Two new `kind` values:

```text
{ kind: "suspend",  body: { in_flight_role: string, in_flight_run_id: string } }
{ kind: "resume",   body: { from_role: string, suspended_seconds: u64 } }
```

`suspend` is appended once per Cmd-Q (by `lib.rs`'s exit handler). `resume` is appended once per click of the Resume button.

### 5.3 No new persisted files

Suspended swarms still live at `<config_dir>/swarms/<id>/state.json` + `mailbox.jsonl`. No new on-disk shape.

## 6. State machine & lifecycle

### 6.1 Suspend (Cmd-Q during running swarm)

`RunEvent::ExitRequested` handler (currently `lib.rs:240-249`) calls `SwarmRegistry::kill_all_with_suspend()` instead of `kill_all()`. The new method:

1. For each swarm with `status: Running`:
   - Read the current FSM state to identify the in-flight `(role, run_id)`.
   - Write `status = Suspended`, `suspended_at = now`, `in_flight_role_at_suspend = role`.
   - Append `suspend` mailbox entry with `{ in_flight_role, in_flight_run_id }`.
2. Then proceeds to `AgentRegistry::kill_all` (which marks the in-flight runs as `killed`).
3. Then `PtyRegistry::kill_all`.

The exit listener for the just-killed run still runs (the kill is async + the listener is registered). It must early-return when `swarm.status == Suspended` rather than transitioning the FSM. Same defensive pattern as the existing `swarm.status != running` early-return at SWARM_DESIGN §6.3.

### 6.2 Reconcile (next launch)

`SwarmRegistry::reconcile_orphans()` already runs at startup. The change:

- Old behavior: any swarm with `status: Running` → `Aborted` with `end_reason: "orphaned by app exit"`.
- New behavior: any swarm with `status: Running` → `Suspended` with `end_reason: None`. (Genuine `Aborted` only happens via user-clicked abort.)
- A swarm already at `status: Suspended` whose `suspended_at` is >24h old → `Failed` with `end_reason: "stale, not resumable"` (resumable cutoff).

### 6.3 Resume

`swarm_resume(swarm_id)` IPC:

1. Load `state.json`. Reject if `status != Suspended` (with clear error).
2. Compute `suspended_seconds += now - suspended_at`. Persist.
3. Identify the in-flight role from `in_flight_role_at_suspend`.
4. Reconstruct the handoff payload by reading prior runs (same `build_handoff_payload` logic as a fresh fire — no special path).
5. Call `AgentRegistry::start_run(... swarm_id: Some(...), promptOverride: <handoff>, trigger: AgentTrigger::Swarm)`.
6. Push the new `run_id` to `swarm.run_ids`.
7. Write `status = Running`, clear `suspended_at` and `in_flight_role_at_suspend`.
8. Append `resume` mailbox entry.

The existing `agent://run-done` listener handles the rest exactly as for a fresh swarm.

### 6.4 Wall-time clock policy

The wall-time cap is `now - started_at > MAX_WALL_SECONDS`. With suspension, `started_at` is unchanged but the user may have been away for hours. **Decision: subtract `suspended_seconds` from the elapsed calculation.**

```text
elapsed = (now - started_at) - suspended_seconds
if elapsed > MAX_WALL_SECONDS: TimedOut
```

So a swarm that ran for 25 min, was suspended for 8 hours, then resumed, has 5 min left on its wall-time budget when it resumes. Same lock as if Cmd-Q had never happened. Test in §13.

### 6.5 Resumable cutoff

24h is the staleness threshold. Past that, the codebase has likely drifted enough that resuming would produce a builder diff against an inconsistent state. Better to fail the swarm and let the user re-run from scratch.

`reconcile_orphans` enforces the cutoff. Suspended swarms <24h old stay `Suspended`; >24h flip to `Failed`.

## 7. Idempotency

Resume can be clicked multiple times if a crash happens during the resumed run. Each click:

- Reads current `state.json` (fresh, post-prior-resume state).
- Increments `suspended_seconds` by the new gap.
- Fires a new run, appends `resume` mailbox entry.
- If the prior resumed run's exit listener fires *after* the second resume's `start_run` call, the listener early-returns because `swarm.in_flight_role_at_suspend` is now `None` (cleared by step 7 above) — but the in-flight run's role doesn't match the FSM state's expected role for the next transition. Add a defense: the listener checks that the just-finished run's `id` is the *latest* `run_id` in `swarm.run_ids` for that role; if not, it's stale, drop the event silently.

## 8. Run-history pruning interaction

`AgentRegistry::prune_runs` already skips runs whose `swarm_id` references a swarm in `running` state. Add `Suspended` to that list. **Without this guard, a 23-hour-suspended swarm could have its scout transcript pruned, making resume impossible.**

The guard is: read each run's `swarm_id`; look up swarm status; skip if status ∈ `{ Running, Suspended }`.

## 9. UI changes

### 9.1 Status pill in `SwarmHeader`

Add a `Suspended` variant to the pill: muted-yellow chip, copy "suspended — N min ago" (relative time from `suspended_at`).

### 9.2 Resume / Abort UI in `SwarmTab`

When the active swarm is `Suspended`:

- Replace the "Abort swarm" button (which only shows for running swarms) with two buttons:
  - **Resume** (primary) → calls `swarmResume(swarmId)`. On success, status flips to running and the existing live-tail UI takes over.
  - **Abort permanently** (secondary) → calls existing `swarmAbort` IPC, status flips to `Aborted`, no resumption possible.
- Banner above the role status strip: *"This swarm was suspended by app exit at \<time\>. Resume to continue, or abort permanently."*

### 9.3 Kanban card status

A Suspended swarm's linked card should show a paused-state badge (⏸) — distinct from the running ⚡, the success ✓, the failure ✗, the timed-out ⏱. Map the new status in `kanbanStore`'s status-to-badge function.

## 10. Notification policy

`SwarmRegistry::fire_completion_notification` only fires on terminal states. Suspended is not terminal; no notification on suspend. **Add:** a one-time notification on resume completion (i.e., when a resumed swarm reaches `Done` / `Failed` / `MaxIter` / `TimedOut`). Body includes "(resumed)" suffix so the user knows this completion came from a previously-suspended run.

Gated on the existing `notify_on_agent_done && notify_on_swarm_done`. No new setting.

## 11. Concurrency

A workspace already enforces "one running swarm at a time" (per SWARM_DESIGN §6.1 R2). Extend this to: **a workspace cannot start a fresh swarm while it has a Suspended swarm.** The user must Resume or Abort permanently first.

`swarm_start` rejection error: *"This workspace has a suspended swarm from \<time\>. Resume or abort it before starting a new one."*

## 12. Open questions / risks

- **What if the binary changed between suspend and resume?** Specifically: SCOUT_SYSTEM_PROMPT was edited in `swarms.rs` and the binary was rebuilt. The seeded `AgentConfig` still has the old prompt (per SWARM_DESIGN §9.1). Resume uses the seeded `AgentConfig`. So in practice: the role agent runs with the prompt that was seeded at swarm creation, regardless of binary changes. **This is correct behavior** — predictable, not surprising.
- **What if the user manually edited the seeded role config (e.g., changed Scout's allowedTools) between suspend and resume?** Same as above — the resume uses the workspace-scoped AgentConfig as it currently is. The user's edit takes effect. Documented as expected behavior, not a bug.
- **What if `<runId>.log` for a prior role was pruned between suspend and resume?** The §8 guard prevents this for runs of `Running` / `Suspended` swarms. A pre-existing pruned run (from a *different* swarm referenced by handoff) is impossible because handoff only references runs of the same swarm.
- **What if the workspace cwd was deleted?** Resume calls `start_run` which has cwd validation (`agents.rs` pre-flight). The resume errors out with a clear message. No corrupt state.
- **Race between exit handler and run completion.** Cmd-Q happens at the exact moment the in-flight run finishes. The run's exit listener and the suspend handler both touch `state.json`. **Mitigation:** the exit handler takes the swarm registry lock before mutating; the listener also takes the lock. Whichever wins, the result is consistent (either suspend wins → run gets killed but its completion mailbox entry is dropped; or completion wins → swarm advances normally and exit handler sees `status: Running` for a different role, suspends that). Add a test for this race.

## 13. Tests

### 13.1 Backend (`cargo test --lib`)

| Module | Test name | Coverage |
|---|---|---|
| `swarms.rs` | `reconcile_orphans_marks_running_as_suspended` | Replaces existing `…_as_aborted` test; behavior change. |
| `swarms.rs` | `reconcile_orphans_fails_stale_suspended_swarms` | Suspended >24h → Failed. |
| `swarms.rs` | `swarm_resume_happy_path_re_fires_in_flight_role` | Suspended at PendingBuild → resume → builder fires → reaches Done. |
| `swarms.rs` | `swarm_resume_rejects_non_suspended` | Resume on Running / Done / Aborted → clear error. |
| `swarms.rs` | `swarm_resume_increments_suspended_seconds` | suspended_seconds accumulates correctly across multiple suspend/resume cycles. |
| `swarms.rs` | `wall_time_check_subtracts_suspended_seconds` | A 25-min run + 8h suspension + 5 min resumed → no TimedOut. |
| `swarms.rs` | `wall_time_check_fires_on_total_active_time` | A 25-min run + 8h suspension + 10 min resumed → TimedOut. |
| `swarms.rs` | `swarm_start_rejects_when_suspended_in_workspace` | Cannot start fresh while Suspended exists. |
| `swarms.rs` | `legacy_swarm_state_loads_with_new_fields_default` | Tier 2: pre-v1.1.0 `state.json` loads with `suspended_at: None`, `suspended_seconds: 0`, `in_flight_role_at_suspend: None`. |
| `swarms.rs` | `stale_run_done_event_dropped_after_resume` | Race: prior run's exit fires after second resume → listener drops it. |
| `swarms.rs` | `mailbox_carries_suspend_and_resume_kinds` | Round-trip the new entry shapes. |
| `agents.rs` | `prune_runs_skips_suspended_swarm_runs` | Pruning guard extension. |

Target: ~12 new backend tests. Total: 121 → 133.

### 13.2 PPVP Tier 4 (manual)

1. Start a swarm. Wait until builder is firing (mailbox shows `dispatch builder`). **Cmd-Q** Atelier. Confirm via `pgrep` no orphan claudes.
2. Relaunch Atelier. Open swarm tab. Confirm: status pill reads "suspended — N min ago"; banner reads "This swarm was suspended by app exit"; two buttons: Resume / Abort permanently.
3. Click **Resume**. Confirm: status flips to running; mailbox shows `resume` entry; builder re-fires (new run id appears in `runIds`); swarm proceeds normally to terminal state.
4. Repeat once more (start fresh swarm → Cmd-Q during reviewer → relaunch → Resume → reviewer re-fires → reaches verdict). Confirms suspend at all three role boundaries works.
5. **Stale test:** manually edit a `state.json`'s `suspended_at` to be 48h ago, relaunch, confirm reconcile flips it to `Failed { "stale, not resumable" }` and the swarm tab shows it as failed.
6. **Race test:** start a swarm, Cmd-Q at the exact second the in-flight run completes (race window ~50ms). Relaunch, confirm state is consistent (either suspended-at-next-role or completed-cleanly). Hard to repro; if not seen in 5 attempts, accept.

## 14. Notification + Run Detail UX

- **Run Detail tab:** for runs whose `swarm_id` references a `Suspended` swarm, show a banner "This run was killed by app exit. The parent swarm is suspended; resume from the Swarm tab."
- **Aggregate metrics in Swarm tab:** suspended swarms are excluded from "active runs" counts but included in "total swarms ever started" if such a metric is later added.

## 15. Implementation increments

Each is a separate commit. Each independently verifiable.

1. **R1 — Schema additions.** Add `Suspended` to `SwarmStatus`, `suspended_at` / `suspended_seconds` / `in_flight_role_at_suspend` to `Swarm`. Tier 2 fixture test for legacy load. No behavior change yet.
2. **R2 — Reconcile path change.** `reconcile_orphans` rewrites `Running` → `Suspended` instead of `Aborted`. Stale-cutoff (>24h) flips `Suspended` → `Failed`. Tests for both.
3. **R3 — Suspend on Cmd-Q.** `lib.rs` `RunEvent::ExitRequested` calls new `SwarmRegistry::kill_all_with_suspend()` which writes `Suspended` and appends `suspend` mailbox entry before tearing down PTYs. Defensive early-return in the in-flight run's exit listener when status is already `Suspended`.
4. **R4 — Resume IPC + frontend wrapper.** `swarm_resume(swarm_id)` end-to-end. State validation, payload reconstruction, `start_run` call, mailbox `resume` append. Tests for happy path, rejections, idempotent re-resume.
5. **R5 — Wall-time policy.** `suspended_seconds` subtraction in the wall-time check. Tests pin both pass and fail boundaries.
6. **R6 — Pruning guard extension.** `prune_runs` skips runs of `Running` and `Suspended` swarms. Tests for both.
7. **R7 — Concurrency rule.** `swarm_start` rejects when a `Suspended` swarm exists in the workspace. Test.
8. **R8 — UI.** `SwarmTab` Suspended state with banner + Resume/Abort buttons. `SwarmHeader` status pill. `kanbanStore` paused-state badge mapping.
9. **R9 — Notification.** Resume-completion notification with "(resumed)" suffix.
10. **R10 — End-to-end PPVP Tier 4.** Walk all 6 manual scenarios from §13.2.

## 16. Deferred to v1.2+

- **Auto-resume on launch.** v1.1.0 always requires a click. Future: a per-swarm "auto-resume" preference in BehaviorSettings.
- **Mid-role partial-output salvage.** Don't try to "continue" a partial transcript; always re-fire fresh. Future work: detect that the killed run produced a complete artifact even though it didn't emit a `result` event, and mark it `done` instead of `killed`.
- **Resumption across binary upgrades.** Out of scope for v1.1.0 — resume uses the seeded `AgentConfig`'s prompt regardless of binary changes. If the user wants the new binary's prompts, they reseed via `swarm_reseed_presets` (v1.0.1) and start a fresh swarm.
- **Cross-machine resume.** The workspace-scoped state is local to the machine. No.

## 17. Out of scope for v1.1.0 entirely

Same as v1.0.0 deferred list (§17 in SWARM_DESIGN.md): custom templates, claude-as-coordinator, within-swarm parallelism, cross-workspace swarms, hard cost-USD caps, file-stomping mutexes.
