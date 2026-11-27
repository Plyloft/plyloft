# Swarm — v1.0 design

Multi-agent orchestration for Atelier. Codename **Swarm**. A swarm is a goal-directed group of role-bound agents that hand work between each other inside one workspace.

This is the v1.0 spec. It composes onto the existing single-agent runtime in `agents.rs`; nothing in that module is replaced. Implementation increments live in §16.

## 1. Goals & non-goals

**Goal.** Ship one end-to-end swarm template — `scout → build → review` with build↔review loopback — usable from the existing kanban and a new Swarm tab. Drag a card to In Progress and watch three agents coordinate to close it. That is the headline feature.

**Non-goals (deferred to v1.1+).**

- Custom user-defined templates and a swarm builder UI
- Manually assembled swarms (no template, just a mailbox + roles)
- A `claude`-driven coordinator (LLM picks who runs next)
- Cross-workspace swarms
- Parallel within-swarm execution (the v1.0 template is sequential)
- Resumable-across-crash swarms
- Per-template config overrides (`max_iterations` etc. are constants in v1.0)
- Hard cost-USD caps (Max-plan auth makes per-token USD informational only)
- File-stomping mutexes (sequential template means no concurrent writers in v1.0)

## 2. Definitions

| Term | Meaning |
|---|---|
| **Swarm** | A persistent, named, goal-directed run of a swarm template. Has a state, a mailbox, and one or more agent runs linked to it. |
| **Swarm template** | A static description of role names + transitions + role prompts. v1.0 ships one template constant in `swarms.rs`. |
| **Role** | A named slot in the template (`scout`, `builder`, `reviewer`). Bound to exactly one `AgentConfig` at swarm creation time. |
| **Mailbox** | The append-only JSONL log of swarm events. Derived from run lifecycle — agents do not write to it. |
| **Handoff payload** | The bytes prepended to role B's prompt when role A finishes: A's parsed transcript + summary of A's file changes + A's structured artifact (if any). |
| **Artifact** | Optional `<cwd>/.atelier/swarm/<runId>/artifact.json` produced by an agent (e.g. reviewer's verdict). Read by atelier post-exit. |
| **State machine** | The Rust-side FSM that owns transitions between roles. v1.0's only template encodes a 5-state FSM. |

## 3. Hard rules carried forward

| Hard rule (CLAUDE.md) | How Swarm respects it |
|---|---|
| **#1 No SDK with API key** | Every swarm-spawned agent run uses the existing `AgentRegistry::start_run` (`agents.rs:813`), which spawns `claude` via `PtyRegistry::spawn`. The coordinator is a Rust state machine, not an API client. |
| **#2 PATH probe** | Inherited automatically — swarm runs go through `start_run`, which already injects `shell_env::get().path` into the PTY. |
| **#3 Atomic writes** | New persisted files (`swarms/<id>/state.json`) use the existing `agents::write_atomic_json` helper. Mailbox JSONL appends use `OpenOptions::append + sync_all` — JSONL doesn't need atomic-rename per line because each line is self-contained. |
| **#4 Kill all on exit** | `SwarmRegistry::kill_all` is invoked from `lib.rs:240-249`'s `RunEvent::ExitRequested` handler **before** `AgentRegistry::kill_all` so swarm state goes to `aborted` first, then in-flight runs go to `killed`, then PTYs die. |
| **#5 Window close hides** | No interaction. |
| **#6 `dragDropEnabled: false`** | The Swarm tab uses HTML5 drag for any reordering (none in v1.0). |

## 4. Architecture overview

```
src-tauri/src/
├── agents.rs        # unchanged behavior; additive (see §10)
├── swarms.rs        # NEW. SwarmRegistry, SwarmTemplate, FSM, mailbox writer
├── kanban.rs        # KanbanCard gains optional swarm_template_id, linkedSwarmId
├── settings.rs      # BehaviorSettings gains notify_on_swarm_done
├── commands.rs      # +6 IPC commands for swarms
├── lib.rs           # starts swarm registry; calls kill_all on shutdown
└── snapshots.rs     # unchanged

src/
├── components/
│   ├── SwarmTab.tsx       # NEW. 8th RightTabs tab (between Kanban and Dashboard)
│   ├── SwarmStartModal.tsx # NEW. Tab-driven start UI (template + goal)
│   ├── KanbanCardView.tsx  # extended: card popover gets a swarm-template picker
│   └── Tile.tsx            # extended: swarm-spawn header chip + abort-warning close confirm
├── store/swarmStore.ts    # NEW zustand slice, follows agentStore.ts shape
└── ipc.ts                 # +6 typed wrappers
```

The state machine lives entirely in `swarms.rs`. It listens to `agent://run-done` (the same event the chain trigger at `agents.rs:1454` uses) but filters by `swarm_id` instead of agent-finished trigger. When a swarm-scoped run finishes, the listener:

1. Looks up the swarm record.
2. Reads the agent's optional artifact JSON (post-`compute_changes` hook).
3. Asks the template "given current state + this run's outcome, what's the next state?".
4. If the answer is "fire role X", builds the handoff payload and calls `AgentRegistry::start_run(...)` with `swarm_id: Some(id)`.
5. Appends a mailbox entry.
6. If the answer is "terminate", flips swarm status, fires the swarm-completion notification, and unsubscribes.

## 5. Data model & persistence

### 5.1 New types (Rust)

```text
SwarmTemplate {
  id: &'static str,           // "scout-build-review"
  label: &'static str,
  roles: &'static [RoleSpec],
  initial_state: SwarmState,
  max_iterations: u32,         // 3
  max_wall_seconds: u32,       // 1800
}

RoleSpec {
  name: &'static str,          // "scout" | "builder" | "reviewer"
  preset_id: &'static str,
  expects_artifact: bool,      // reviewer = true
}

Swarm {
  id: String,
  workspace_id: String,
  template_id: String,
  goal: String,                // user-supplied or card-derived
  status: SwarmStatus,         // running | done | failed | aborted | timed_out | max_iter
  state: SwarmState,           // current FSM state
  iteration: u32,              // bumped each time builder fires after first
  role_bindings: HashMap<String, String>,  // role name → AgentConfig id
  run_ids: Vec<String>,        // every AgentRun spawned by this swarm, in order
  started_at: u64,
  ended_at: Option<u64>,
  end_reason: Option<String>,
}

SwarmState (enum):
  PendingScout
  PendingBuild { scout_run_id: String }
  PendingReview { scout_run_id: String, build_run_id: String }
  Done | Failed | Aborted | TimedOut | MaxIter
  // PendingReview carries scout_run_id (not in the original plan): the build↔
  // review loopback restores it when re-firing builder. End-reason text lives
  // on `Swarm.end_reason`, not on the state enum.
```

### 5.2 Persisted layout

```
~/Library/Application Support/com.matteo.atelier/
└── swarms/
    └── <swarm_id>/
        ├── state.json          # full Swarm record, atomic-written on every transition
        └── mailbox.jsonl       # append-only event log
```

Mailbox line shape (one JSON object per line, `\n`-terminated):

```text
{ id, ts, swarm_id, kind, role?, run_id?, body? }
```

`kind` ∈ `created | dispatch | report | artifact | terminate | suspend | resume`. The emitter writes:

- `created` once at swarm start (carries `goal`)
- `dispatch` before each `start_run` call (carries `role`)
- `report` after each `agent://run-done` (see §7 for embedded run summary)
- `artifact` if a run produced `artifact.json` (carries the parsed object)
- `terminate` once at swarm end (carries `end_reason`)
- `suspend` once per Cmd-Q (`RunEvent::ExitRequested`) while a swarm is `Running`, recording which role/run was airborne so Resume knows what to re-fire (carries `{in_flight_role, in_flight_run_id}`) (v1.1.0)
- `resume` once per Resume-button click that flips a `Suspended` swarm back to `Running`, recording the role being re-fired and the cumulative wall-time spent suspended (carries `{from_role, suspended_seconds}`) (v1.1.0)

### 5.3 Schema additions to existing types

| File | Field | Type | Rule |
|---|---|---|---|
| `agents.rs::AgentRun` | `swarm_id` | `Option<String>` | `serde(default)`. Set by `start_run` when called with the new optional `swarm_id` param. Surfaced in run cards as a `swarm: <name>` chip. |
| `agents.rs::AgentRun` | `swarm_artifact` | `Option<serde_json::Value>` | `serde(default)`. Populated post-exit if `<cwd>/.atelier/swarm/<runId>/artifact.json` exists and parses. |
| `agents.rs::AgentConfig` | `preset_id` | `Option<String>` | `serde(default)`. Stable string set on swarm-seeded role configs (`"scout"` / `"builder"` / `"reviewer"`). State machine binds by this. |
| `agents.rs::AgentTrigger` | `Swarm` | new variant | Adds a fourth variant to the enum at `agents.rs:59-63`. Preserves all existing trigger semantics. |
| `kanban.rs::KanbanCard` | `swarm_template_id` | `Option<String>` | `serde(default)`. When set, card-driven runs go through the swarm path instead of the single-agent path. |
| `kanban.rs::KanbanCard` | `linked_swarm_id` | `Option<String>` | `serde(default)`. Mirrors `linked_run_id` for the swarm path. |
| `settings.rs::BehaviorSettings` | `notify_on_swarm_done` | `Option<bool>` | `serde(default)` → `Some(true)`. Surfaced in Settings → Behavior. |

All additive. Tier 2 fixture tests required for each (drop alongside the existing v0.6.0 / v0.9.0 / v0.11.0 fixtures).

## 6. State machine & lifecycle

### 6.1 Template: `scout-build-review`

```
[create]
  ↓
PendingScout
  ↓ (scout run completes, status=done)
PendingBuild { scout_run_id }
  ↓ (builder run completes, status=done)
PendingReview { build_run_id }
  ↓ (reviewer run completes, status=done)
  artifact.verdict =
    ├─ "approve"  → Done
    ├─ "reject"   → if iteration < max_iterations: PendingBuild { ... } (iteration++)
    │                else: MaxIter
    └─ missing/malformed → Failed { reason: "no verdict" }

Any run with status ∈ {error, killed} from any state → Failed { reason: "<role> failed: <error>" }
Wall-time exceeded → TimedOut (state machine checks at every transition + every 30s tick)
```

The state machine is a pure function `(state, run_outcome) → next_state` with all branching on `(role, status, artifact)`. Unit-testable in isolation; no I/O.

### 6.2 Lifecycle

1. **Create.** Caller (kanban move OR Swarm tab Start button) calls `swarm_start(workspaceId, templateId, goal)`. Pre-flight: `SwarmRegistry::active_in_workspace(workspaceId)` rejects with `"A swarm is already running in this workspace. Wait for it to finish or abort it."` if any swarm has `status: running` — v1.0 enforces strict one-swarm-per-workspace and relaxes to N-per-workspace in v1.1+ once UI selection is designed. Cwd validation: verify `workspace.cwd` exists and is readable before any record is written, preventing orphan swarm records when the directory is gone.
2. **Seed presets.** `SwarmRegistry::ensure_presets(workspaceId)` checks for the three role-preset AgentConfigs (workspace-scoped, names `Scout (swarm)` / `Builder (swarm)` / `Reviewer (swarm)`). Missing ones are auto-created via `AgentRegistry::create_agent` from a `pub const SCOUT_PRESET: AgentConfigSeed` (etc.) defined in `swarms.rs`. The user can later edit them in the Agents tab.
3. **Bind.** Build `role_bindings` from the seeded preset IDs. Persist `state.json`. Append `created` mailbox entry.
4. **Fire scout.** Build initial prompt = `goal`. Call `AgentRegistry::start_run(... promptOverride: Some(goal), swarm_id: Some(swarmId), trigger: AgentTrigger::Swarm)`. Append `dispatch` mailbox entry. Push `runId` to `run_ids`.
5. **Listen.** State-machine listener reacts to `agent://run-done` filtered by `swarm_id`. On each completion: read run record + artifact (if any), append `report` (and `artifact` if present) entries, ask the FSM, fire next or terminate.
6. **Terminate.** Flip status, append `terminate` entry, fire one native macOS notification, drop the listener.

### 6.3 Listener idempotency

The state-machine listener early-returns when `swarm.status != running`. Two race windows make this load-bearing:

- **Abort vs. natural completion.** User clicks Abort just as a role's run finishes. Without the guard, the listener processes `done`, transitions to the next state, and overwrites the just-set `Aborted` status.
- **Wall-time tick vs. exit.** The 30s tick (§6.4) kills the in-flight run and flips status to `TimedOut`. The killed run's exit listener fires moments later. Without the guard, the listener tries to transition out of a terminal state.

Implementation: lock the swarm record, check `status == running`, then read-modify-write under the same lock. Tested via `state_machine_idempotent_on_terminal_states`.

### 6.4 Wall-time enforcement

Two paths to keep latency low:

- **At every transition.** Cheap; piggybacks on the existing event listener.
- **Periodic poll** in the existing 30-second `start_scheduler` tick at `agents.rs:1279-1284`. A `swarm_registry.tick()` call scans active swarms for `now - started_at > max_wall_seconds`, kills the in-flight run via `agent_run_kill`, sets status `TimedOut`. Reuse, don't replicate.

### 6.5 Kanban auto-advance mapping

When a card-driven swarm terminates, the card's column changes per the table below. Mirrors the existing single-agent v0.7.x flow (success → In Review with ✓; failure → back to In Progress with ✗) but adds three new terminal states the swarm can produce.

| Swarm terminal status | Card moves to | Badge |
|---|---|---|
| `Done` (reviewer approved) | Complete | ✓ |
| `MaxIter` (loopback exhausted) | In Review | ⚠ — needs human eyes |
| `Failed` (run errored, missing verdict, etc.) | back to In Progress | ✗ |
| `TimedOut` | In Review | ⏱ — paused; user decides |
| `Aborted` (user-clicked) | no auto-move | — |

The card's `lastRunStatus` field (already on `KanbanCard` in v0.11.0 for the orphan-reconcile path) carries the swarm terminal status string; `linkedSwarmId` replaces `linkedRunId` when a swarm is the entry point. Both fields stay populated for orphan reconciliation (cf. `KanbanStore::reconcile_orphan_runs` in v0.11.0).

## 7. Mailbox semantics

Strictly **derived** from run lifecycle. Agents do not write to the mailbox directly. The Swarm tab renders the mailbox JSONL as the canonical "what happened" feed.

**Reading.** Streamed line-by-line from `mailbox.jsonl` via a new `swarm_mailbox_read(swarmId, fromOffset)` IPC. The Swarm tab tails it the same way `AgentRunView` tails transcripts.

**Partial-line resilience.** Append-only JSONL means a process kill mid-write can leave a malformed final line. The reader splits on `\n`, attempts `serde_json::from_slice` on each line, and **silently skips lines that fail to parse** (logging at debug level). This is the same defensive posture as the `StreamParserState::feed` unparseable-line passthrough (`agents.rs:172-178`).

**Writing.** Only `swarms.rs` writes. Append + `sync_all`. No locking — single writer per swarm (the state machine listener serializes its own work).

**Dedup.** Not needed in v1.0. Each run completion fires the listener exactly once.

**`report` entry self-containment.** When a run completes, the `report` mailbox entry embeds a snapshot of the run summary at that moment: `{ run_id, role, status, started_at, ended_at, exit_code, bytes_written, usage, model, total_cost_usd, files_changed_count }`. This makes the swarm history self-contained even after run-history pruning (v0.8.0 D4) deletes the underlying `<runId>.json` and `<runId>.log`. The Swarm tab reads aggregate metrics from the mailbox, not the runs. The "click to view full transcript" link gracefully degrades to "transcript no longer available (run pruned)".

## 8. Handoff payload construction

When the state machine fires role B after role A finishes, B's `promptOverride` is built as:

```
<goal>

# Previous step: <A.role>

## Transcript
<contents of <A.runId>.log, parsed assistant text only>

## Files changed
- M src/foo.rs
- A docs/bar.md
- D temp.txt
(... up to the cap; truncated marker if exceeded)

## Structured output
<pretty-printed A.swarm_artifact, if present>
```

**Truncation.** The parsed transcript is capped at 32 KB by default (constant in `swarms.rs`). Tail-truncation with a `[truncated N bytes]` marker. Files-changed list is cap-by-count (50), not bytes. Artifact is included verbatim.

**Loopback case.** When reviewer rejects → builder fires again, the prompt grows: B sees the original goal + scout's output + previous build's output + reviewer's critique. Each iteration's prompt is rebuilt from scratch from the run history; nothing is preserved across iterations except what lives in the workspace.

**Older claude CLI fallback.** When `shell_env::get().supports_stream_json()` is false (the user is on a pre-1.0.0 claude CLI; cf. v0.11.0 version detection), runs spawn in plain-text mode and the `<runId>.log` contains raw PTY bytes including ANSI escape codes and stderr noise. The handoff payload's "Transcript" section pastes those bytes verbatim — degraded readability but functional. The artifact contract is unaffected (artifact lives on disk, separate from the transcript). The Swarm tab's role-status strip surfaces a small badge `stream-json unavailable; consider claude self-update` when this path is active. Identical behavior to single-agent runs in v0.11.0; no new fallback logic needed.

## 9. Role provisioning & artifact contract

### 9.1 Pre-baked role presets

Three constants in `swarms.rs`:

```text
SCOUT_PRESET — system prompt instructs claude to read the codebase, propose a plan,
  write `<cwd>/.atelier/swarm/<runId>/artifact.json` with shape:
  { plan: string, files_to_modify: string[], rationale: string }

BUILDER_PRESET — system prompt instructs claude to implement the plan, modifying
  files directly (no artifact required). The snapshot system catches the diff.

REVIEWER_PRESET — system prompt instructs claude to review the diff and write
  `<cwd>/.atelier/swarm/<runId>/artifact.json` with shape:
  { verdict: "approve" | "reject", critique: string, blocking_issues?: string[] }
```

Each preset becomes a workspace-scoped `AgentConfig` (`agents.rs::AgentScope::Workspace`) on first use in that workspace via `AgentRegistry::create_agent`. They appear in the Agents tab with the standard ⋯ edit menu — the user can tune system prompts, allowed tools, etc. The state machine binds by `preset_id`.

**Seeded-preset friction.** The seeding path is one-shot per workspace: `ensure_presets` (`swarms.rs:975`) runs on the first swarm invocation in that workspace and writes the role-preset bodies — the constants `SCOUT_NAME` / `SCOUT_SYSTEM_PROMPT`, `BUILDER_NAME` / `BUILDER_SYSTEM_PROMPT`, `REVIEWER_NAME` / `REVIEWER_SYSTEM_PROMPT` at `swarms.rs:861-895` — into workspace-scoped `AgentConfig` JSON. After that, the workspace's copies are independent of the binary. Tuning the constants in `swarms.rs` and rebuilding only affects workspaces that have **not yet** seeded; every already-seeded workspace keeps its old copy until reseeded.

**Resolved post-v1.0 (cal #9):** the IPC `swarm_reseed_presets(workspaceId)` (`swarms.rs:1065`, calling `reseed_presets_with_registry` at `swarms.rs:1016`) re-applies the binary preset bodies onto the seeded `AgentConfig`s by `preset_id` match. Wholesale overwrite from the binary defaults; before each overwrite, the prior `system_prompt` and `prompt_template` are captured into a new optional `previous_version: Option<PreviousAgentVersion>` field on `AgentConfig` (`agents.rs:123`, additive, `serde(default)`) so user edits to those two fields are recoverable from disk. Reseed is idempotent: repeating it overwrites `previous_version` rather than stacking history. Surfaced as a "Reset role prompts" button in `SwarmTab.tsx` (both empty-state and `SwarmHeader` placements) gated by a `ConfirmDialog`. **v1.5.10 expansion:** the iteration target widened from the v1.0 trio (`scout` / `builder` / `reviewer`) to `ALL_ROLE_IDS` — all 7 role-preset IDs (adds `architect`, `ux-reviewer`, `refactorer`, `coordinator`). Without this, every prompt edit during v1.2.1 calibration would have required manual JSON file deletion. Limitation: `previous_version` only captures `system_prompt` + `prompt_template`. Non-prompt edits to seeded role configs (`allowed_tools`, `schedule`, `triggers`, `tags`, `notify_on_done`, `name`, `description`) are reset wholesale and not recoverable — **decided not to widen** (v1.0.1 close-out finding #2): the realistic friction surface is `allowed_tools`; calibration produced zero evidence anyone edits it on seeded role configs. YAGNI; revisit if a real bug report shows lost edits.

### 9.2 Artifact discovery

In `agents.rs`'s exit listener (currently `agents.rs:1104-1170`), **after** the existing `compute_changes` call at `agents.rs:1163`:

```text
if run.swarm_id.is_some() {
    let artifact_path = cwd.join(".atelier/swarm").join(&run.id).join("artifact.json");
    if let Ok(bytes) = fs::read(&artifact_path) {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            run.swarm_artifact = Some(value);
        } else {
            log warn "swarm artifact for {run_id} is not valid JSON"
        }
    }
}
// persist run record (existing logic)
```

Best-effort: missing or malformed artifact does not abort the run itself. The state-machine layer interprets "no artifact when expected" as `Failed { reason: "no verdict" }` — this is the only failure mode introduced by the artifact contract.

The role's system prompt is the contract. Prompts include an explicit "Before you finish, write your verdict to `<cwd>/.atelier/swarm/<runId>/artifact.json`" instruction with a literal example. The `runId` is templated into the prompt at handoff time so claude knows the exact path.

### 9.3 `.atelier/swarm/` directory hygiene

`<cwd>/.atelier/` is already in atelier's `NOISY_NAMES` exclusion list (per `docs/ARCHITECTURE.md`), so:

- The file watcher does not fire on artifact writes (no `fs://changed` echo).
- The snapshot system (`snapshots.rs::capture_before` / `compute_changes`) does not include `.atelier/` files in diffs.
- Quick Open (`fs_list_files_recursive`) skips it.

**Git-ignore.** Atelier does not auto-edit user `.gitignore` files. The first time a swarm runs in a workspace whose project root has a `.gitignore` that does not exclude `.atelier/`, atelier surfaces a one-time toast: `Swarm writes intermediate state to .atelier/swarm/. Add .atelier/ to .gitignore?` with a single-click "Add it" button that appends the line atomically. User can dismiss; toast is not shown again for that workspace (tracked via a workspace-level `gitignoreToastShown` flag, mirroring `atelier:v0.5.0-toast-shown` in localStorage).

**Cleanup.** When run-history pruning (`AgentRegistry::prune_runs`, v0.8.0 D4) deletes a run record, also delete `<cwd>/.atelier/swarm/<runId>/` if it exists. Best-effort; failure logs but does not block pruning. The retention rule for swarm artifact dirs is therefore identical to run-history retention — no separate setting needed.

### 9.4 Runtime context inherited by role agents

**Claude Code auto-load applies.** Each role agent runs as a `claude` CLI subprocess (via `pty_registry.spawn`) with the workspace cwd. This means it auto-loads everything Claude Code reads in that cwd: `<cwd>/CLAUDE.md` (project instructions), `<cwd>/.claude/CLAUDE.md` (local overrides), and `~/.claude/projects/<encoded-cwd>/memory/MEMORY.md` (the auto-memory feature, populated by prior Claude Code interactive sessions in the same workspace). Atelier does not currently set any flag that would suppress these.

**Observed behavior during the v1.0.0 calibration:** scout cites `CLAUDE.md` "Things to avoid suggesting" when rejecting out-of-scope cards (cal #6, code-signing probe); builder appeals to project memory in justification text (cal #5, parallelism probe), which reviewer flagged as a weaker form of argument than code-level facts.

**Net assessment: this is a feature, not a leak.** It gives role agents project context for free, which materially improved decision quality on the failure-probe cards. Two caveats worth knowing: (1) memory is written during interactive Claude Code sessions, so prior conversations can shape later swarm runs in the same workspace — useful when building up calibration context, but worth being aware of when tracing why a role reasoned a particular way; (2) cross-workspace swarms (deferred v1.1+, §17 #4) would see different memory per workspace, which is a design constraint for that future feature.

## 10. Concurrency & inflight guard

### 10.1 Modification to `AgentRegistry::inflight`

Today: `inflight: Arc<Mutex<HashSet<String>>>` keyed on `agent_id` (`agents.rs:324`). Skip-only policy.

Change: re-key on `(Option<String>, String) = (swarm_id, agent_id)`. Backward compatible:

- Manual ▶ click and existing scheduled/event triggers pass `swarm_id: None`. The set behaves identically — same agent twice still collides.
- Swarm-spawned runs pass `swarm_id: Some(swarmId)`. Agent X can run inside swarm A *and* simultaneously be triggered by manual click (None) — they have distinct keys.
- Within one swarm, an agent still cannot double-fire (same key collides).

The `InflightGuard` at `agents.rs:330-356` adapts trivially: change the stored key from `String` to `(Option<String>, String)`. Error message at `agents.rs:832-835` updated to mention swarm context when applicable.

Tier 2 test: legacy run records (no `swarm_id` field) load with `swarm_id: None` via `serde(default)`.

### 10.2 No within-swarm parallelism in v1.0

The hardcoded template is sequential. Parallel-scout / two-headed-reviewer templates would need distinct AgentConfigs per instance under the per-`(swarm, agent)` key — that's a v1.1 problem. The lock structure is forward-compatible with overlap policies but doesn't enable them yet.

### 10.3 `AgentFinished` chain trigger skips swarm-spawned source runs

The chain-trigger handler at `agents.rs:1454-1515` fires `AgentTriggerEvent::AgentFinished { agent_id }` when a matching agent's run completes with `status: done`. If a user has a chain trigger configured against (say) the builder preset from a non-swarm context, every swarm iteration's builder completion would fire that chain — creating runs the user did not ask for, possibly across many workspaces.

Fix: the chain handler early-returns when the source run has `swarm_id.is_some()`. One-line check: `if source_run.swarm_id.is_some() { return; }` before the cooldown + dispatch loop.

### 10.4 `InflightGuard` release ordering invariant

The state-machine listener subscribes to `agent://run-done` and may immediately call `start_run` for the next role (loopback case: same builder twice in a row). The next `start_run` will check `inflight` and reject if the previous run's slot hasn't been released yet.

**Invariant:** in the existing exit listener (`agents.rs:1104-1170`), `InflightGuard::Drop` (slot release) happens **before** `app.emit("agent://run-done", ...)`. The current code already has this order; v1.0 does not change it. Tested via `inflight_released_before_run_done_event`.

## 11. Termination & error policy

### 11.1 Stop conditions

| Condition | Status | Mailbox `terminate.body` |
|---|---|---|
| Reviewer approves | `Done` | `"approved by reviewer"` |
| `iteration >= max_iterations (3)` | `MaxIter` | `"reached max_iterations (3)"` |
| `now - started_at >= max_wall_seconds (1800)` | `TimedOut` | `"exceeded max_wall_seconds (1800)"` |
| Any swarm run finishes with `error` or `killed` | `Failed` | `"<role> run failed: <error>"` |
| Reviewer artifact missing/malformed | `Failed` | `"reviewer produced no verdict"` |
| User clicks Abort in Swarm tab | `Aborted` | `"user aborted"` |
| App quit (Cmd-Q) | `Aborted` (post-restart reconcile) | `"orphaned by app exit"` |

**No cost-USD cap.** Atelier authenticates via Max-plan subscription, so per-token USD figures from stream-json's `result` event are estimates of "what API pricing would be" rather than actual user cost. Surfacing it in the Swarm tab is fine; gating on it would mislead. `max_iterations` + `max_wall_seconds` together provide a deterministic upper bound on resource use.

### 11.2 Manual abort

The Swarm tab exposes an "Abort swarm" button when `status === 'running'`. Click → `swarm_abort(swarmId)` IPC → `SwarmRegistry::abort` flips status to `Aborted`, calls `agent_run_kill` on any in-flight run, appends `terminate` mailbox entry. Mirrors `agent_run_kill` semantics — `Aborted` is preserved over the subsequent `killed` exit.

### 11.3 Start-time guards

`swarm_start` rejects with a clear, user-facing error in three cases:

| Case | Error message |
|---|---|
| Another swarm already `running` in this workspace | `"A swarm is already running in this workspace. Wait for it to finish or abort it."` |
| Workspace `cwd` does not exist or is unreadable | `"Workspace cwd '<path>' is not accessible."` |
| Card-driven start: card has both `agentConfigId` and `swarmTemplateId` set | Should not happen — the picker UI mutually excludes them (see §16 S8). Defensive: backend prefers `swarmTemplateId` and ignores `agentConfigId` for that move. |

**Card UI mutual exclusion.** In the kanban card popover, attaching a swarm template auto-clears `agentConfigId` and disables the agent picker with a tooltip "Swarm template overrides agent attachment". Likewise selecting an agent clears `swarmTemplateId`. Backed by a small invariant comment in `kanbanStore.ts` near the existing `moveCard` prompt construction (`kanbanStore.ts:219-222`).

## 12. Observability — Swarm tab

### 12.1 Surface

8th tab in `RightTabs.tsx`, between Kanban and Dashboard. One `SwarmTab` instance per warmed workspace (warmed-host pattern, per `docs/PATTERNS.md`).

Layout (top → bottom):

1. **Header.** Swarm name + template badge + status pill (`running` pulses) + abort button (if running). Iteration counter ("iteration 2 of 3") rendered prominently next to the status pill — surfaces the loopback state at a glance.
2. **Goal.** Read-only quote of the swarm's `goal`.
3. **Role status strip.** Three chips (scout / builder / reviewer): each shows the latest run's status (`pending` / `running` / `done` / `error` / `killed`), elapsed/duration, and a click-to-jump to the run's transcript via the existing `RunDetailContent` fallback (`RightTabs.tsx::RunDetailContent`, post-v0.9.1 fix). Builder chip carries a subscript "(iteration N)" when N > 1.
4. **Mailbox feed.** Live tail of `mailbox.jsonl`. Each entry rendered with a kind icon and a relative timestamp. Lazy-paginates older entries. Subscribes via a new `swarm://mailbox` event emitted by `SwarmRegistry::append_mailbox`.
5. **Aggregate metrics.** Total tokens (sum of `usage.input_tokens + usage.output_tokens` across `run_ids`), total estimated cost (sum of `total_cost_usd`), iteration count, elapsed.

### 12.2 Tile-grid integration

Swarm-spawned runs render as tiles in the tile grid like any agent run, with two UX adjustments:

- **Header chip.** `Tile.tsx`'s header gets a small `swarm: <name>` chip (uses the same color token as the swarm template badge in the Swarm tab). Distinguishes a swarm-spawned tile from an ad-hoc agent-run tile at a glance.
- **Close confirmation.** When `closeTile` is called on a swarm-spawned tile (`tile.runId && run.swarm_id`), the existing confirm dialog body changes from "Kill this run?" to "**Closing this tile will abort the swarm.** The current step (<role>) and the swarm itself will both be marked aborted. Continue?". Discards the tile only after confirm.

Both changes live in `src/components/Tile.tsx`. The swarm name is resolved via `swarmStore.byWorkspace[wsId]` keyed on `run.swarm_id`.

### 12.3 Selectors and re-render safety

Per `docs/PATTERNS.md`:

- Module-scoped `EMPTY_RUNS` / `EMPTY_MAILBOX` fallbacks for any `?? []`.
- Don't `.slice()` / `.filter()` / `.map()` inside selectors — derive in the component body.
- Aggregate metrics computed in a `useMemo` keyed on `swarm.run_ids.length` + `mailbox.length` (both stable primitive proxies for change).
- One `SwarmTab` per warmed workspace, hidden via `.hidden` CSS class on inactive ones.

### 12.4 Empty state

When no swarm exists for the workspace: copy explaining the v1.0 template, a "Start scout-build-review" button that opens `SwarmStartModal`.

## 13. Notification policy

Existing per-agent `notify_on_done` (v0.4.0, surfaced via `lib/agentNotifier.ts`) is bypassed when `run.swarm_id.is_some()`. The notifier's existing handler reads the run record on `agent://run-done` — adds an early-return: `if (run.swarmId) return;`.

`SwarmRegistry` fires its own native macOS notification once per swarm completion via the existing `tauri-plugin-notification` path:

> **Swarm done — scout-build-review**
> Approved by reviewer · 5 runs · 2 iterations · ~12k tokens · 4m 23s

`Failed` / `TimedOut` / `MaxIter` / `Aborted` get the same notification with appropriate body. Suppressed on `Aborted` when triggered by Cmd-Q (the app is quitting; no point notifying).

**Settings gating.** The swarm-completion notification fires only when **both** of:

- Existing global `behavior.notifyOnAgentDone: bool` (v0.4.0, default `true`) is true. Reusing the existing toggle keeps the user mental model simple — one setting controls "do I want desktop notifications at all" — and avoids a noisy two-toggle UX.
- New `behavior.notifyOnSwarmDone: bool` (default `true`) — additive `serde(default)` field on `BehaviorSettings`. Lets a user keep single-agent notifications on while silencing swarm-completion pings (or vice versa). Surfaces in Settings → Behavior next to the existing notification toggle.

## 14. Crash recovery

Mirror `AgentRegistry::reconcile_orphans` (called from `lib.rs:143`).

`SwarmRegistry::reconcile_orphans()` runs at startup **after** `AgentRegistry::reconcile_orphans()` (so it can correlate killed runs to swarms): scans `<config_dir>/swarms/*/state.json`, any swarm with `status: running` is rewritten to `Aborted` with `end_reason: "orphaned by app exit"`. Mailbox gets a final `terminate` entry. The associated runs are already reconciled to `killed` by the agent registry pass.

No resurrection: the next click in the Swarm tab starts a *new* swarm. Resumability is a v1.1+ design problem (idempotent message delivery, partial-stream-json handling, etc.).

## 15. Tests

### 15.1 Backend (`cargo test --lib`)

| Module | Test name | Coverage |
|---|---|---|
| `swarms.rs` | `state_machine_scout_to_build_to_review_done` | Happy path: scout done → build done → review approves → Done |
| `swarms.rs` | `state_machine_loopback_until_max_iterations` | Reviewer rejects 3× → MaxIter |
| `swarms.rs` | `state_machine_aborts_on_run_error` | Builder errors → Failed |
| `swarms.rs` | `state_machine_aborts_on_missing_artifact` | Reviewer done but no `artifact.json` → Failed |
| `swarms.rs` | `state_machine_times_out` | `now - started_at > max_wall` → TimedOut |
| `swarms.rs` | `state_machine_idempotent_on_terminal_states` | Listener no-ops when `swarm.status != running`; abort race + timeout race |
| `swarms.rs` | `mailbox_append_creates_jsonl` | Each entry on its own line, parses round-trip |
| `swarms.rs` | `mailbox_read_skips_partial_last_line` | Append `{ "id": 1 }\n{ "id": 2,\n` (truncated last line); read returns one entry, logs debug for the partial |
| `swarms.rs` | `mailbox_report_carries_run_summary` | Pruning a `<runId>.json` after swarm completes; mailbox `report` entry still has status, bytes, usage |
| `swarms.rs` | `reconcile_orphans_marks_running_as_aborted` | Mirrors `agents::reconcile_orphans` test |
| `swarms.rs` | `swarm_start_rejects_when_another_running_in_workspace` | Two `swarm_start` calls for same workspace; second returns the user-facing error |
| `swarms.rs` | `swarm_start_rejects_when_cwd_missing` | Cwd validation guard |
| `agents.rs` | `inflight_key_is_swarm_aware` | `(None, "x")` and `(Some("s1"), "x")` don't collide; `(Some("s1"), "x")` twice does |
| `agents.rs` | `legacy_agent_run_loads_without_swarm_id` | Tier 2 fixture: pre-v1.0 JSON `swarm_id` defaults to None |
| `agents.rs` | `swarm_artifact_read_post_exit` | Mock `artifact.json`, exit listener picks it up |
| `agents.rs` | `swarm_artifact_malformed_logs_warn` | Best-effort: malformed JSON → run.swarm_artifact = None, warn logged |
| `agents.rs` | `chain_trigger_skips_swarm_spawned_runs` | Plant chain trigger on agent X; fire X with `swarm_id: Some(...)`; chained agent does not start |
| `agents.rs` | `inflight_released_before_run_done_event` | Within `agent://run-done` handler, recursive `start_run` for same `(swarm_id, agent_id)` succeeds |
| `agents.rs` | `prune_runs_also_deletes_swarm_artifact_dir` | When `prune_runs` removes a `<runId>.json`, `<cwd>/.atelier/swarm/<runId>/` is also removed (best-effort) |
| `kanban.rs` | `legacy_card_loads_without_swarm_template_id` | Tier 2 fixture: pre-v1.0 card |
| `kanban.rs` | `card_with_both_agent_and_swarm_template_uses_swarm` | Backend defensive: prefers `swarm_template_id` over `agent_config_id` for that move |
| `settings.rs` | `legacy_settings_loads_with_notify_on_swarm_done_default_true` | Tier 2 fixture: pre-v1.0 settings.json missing the new field |

Target: ~22 new backend tests. Total: ~97 (was 75 in v0.11.0).

### 15.2 Frontend (Tier 3 pure-function tests)

| Function | Test |
|---|---|
| `buildHandoffPayload(swarm, prevRun, transcriptText, changes, artifact)` | Truncation at 32 KB, files-changed cap, missing-artifact path, loopback iteration carries critique |
| `swarmFsm(state, outcome)` | State-machine transitions verified outside Rust as a JS port (or via WASM exposure later). v1.0: just exercise `buildHandoffPayload`. |

### 15.3 PPVP Tier 4 (manual)

1. Create a swarm-attached card, drag Todo → In Progress, watch all three roles fire and the card auto-advance per the §6.5 mapping.
2. Reject in reviewer (manually edit reviewer's prompt to always reject) — confirm loopback fires, then MaxIter after 3 iterations; card advances to In Review with ⚠.
3. Cmd-Q mid-swarm → relaunch → confirm swarm reconciled to Aborted; in-flight run reconciled to killed; card stays in place (no auto-move on Aborted).
4. Tab-driven Start → same flow without the kanban.
5. Try `swarm_start` while another swarm is running in the same workspace → confirm rejection toast.
6. Close a swarm-spawned tile via the tile's × button → confirm the abort warning copy fires; confirm Yes → swarm goes to Aborted.
7. Edit `.gitignore` removal: in a workspace with a `.gitignore` that doesn't list `.atelier/`, start a swarm → confirm one-time toast appears with "Add it" button; click Add → confirm `.atelier/` line appended; start a second swarm → toast does NOT reappear.
8. PPVP Tier 1 + 1.5 stays 7/7.

## 16. v1.0 implementation increments

The implementation session lands these as separate commits in order. Each is independently verifiable.

1. **S1 — Schema additions.** Add `swarm_id`, `swarm_artifact` to `AgentRun`; `swarm_template_id` and `linked_swarm_id` to `KanbanCard`; `Swarm` variant to `AgentTrigger`; `notify_on_swarm_done` to `BehaviorSettings`. Tier 2 fixture tests for each. No behavior change yet.
2. **S2 — Inflight key change + chain-trigger skip.** Re-key `inflight` to `(Option<String>, String)`. Update `InflightGuard`, error message. Add the `swarm_id.is_some()` early-return in the chain-trigger handler. Tests: new collision behavior + chain skip.
3. **S3 — `SwarmRegistry` skeleton.** Module + `state.json` persistence + mailbox JSONL writer (with partial-line-resilient reader) + `reconcile_orphans` + `swarm_start` guards (active-swarm-in-workspace, cwd existence). Wire into `lib.rs` setup + shutdown (before agent-registry kill_all on exit). Tests: orphan reconcile, mailbox round-trip, partial-line skip, start guards.
4. **S4 — State machine + post-exit artifact read + idempotency.** Pure FSM; artifact-read in the `agents.rs` exit listener; integration with `start_run(... swarm_id: Some(...))`; listener early-return on terminal swarm status. Mailbox `report` entries embed run summary. Inflight-release-ordering test. State-machine unit tests pass.
5. **S5 — IPC surface.** `swarm_start`, `swarm_get`, `swarm_list`, `swarm_abort`, `swarm_mailbox_read`, `swarm_subscribe_mailbox`. Typed wrappers in `ipc.ts`. No UI yet.
6. **S6 — Role presets seeding.** `SwarmRegistry::ensure_presets` + the three `pub const` preset bodies. Add `preset_id: Option<String>` to `AgentConfig`. Verify Agents tab renders the three seeded entries.
7. **S7 — Swarm tab UI + tile-grid integration.** New `SwarmTab.tsx` + `swarmStore.ts` + `SwarmStartModal.tsx`. RightTabs gets the 8th tab. Warmed-host pattern. Iteration counter rendered in header. `Tile.tsx` gets the `swarm: <name>` chip and the abort-warning close-confirm copy. No card path yet.
8. **S8 — Card-driven entry + mutual exclusion + auto-advance mapping.** Card popover gets the swarm-template picker that mutually excludes the existing agent picker. `kanbanStore.moveCard` branches on `swarm_template_id` to call `swarm_start` instead of `agent_run_start`. Implement the §6.5 column mapping for each terminal swarm status. Includes the `.gitignore` first-time toast and the `.atelier/` git-ignore detection.
9. **S9 — Notification policy + pruning hook.** `lib/agentNotifier.ts` early-return for swarm runs; `SwarmRegistry` fires the swarm-completion notification gated on `notifyOnAgentDone && notifyOnSwarmDone`. `AgentRegistry::prune_runs` extended to also remove `<cwd>/.atelier/swarm/<runId>/` for pruned runs (best-effort).
10. **S10 — End-to-end PPVP Tier 4.** Walk all 8 manual scenarios in §15.3.

## 17. Deferred to v1.1+

Ranked by anticipated value:

1. **Custom templates + builder UI.** New `swarm_templates.json` (mirrors `templates.json`). Swarm tab gets a template editor.
2. **Claude-as-coordinator.** A new role kind that reads the mailbox + emits explicit dispatches via `<cwd>/.atelier/swarm/dispatch.json`. The mailbox primitive is already in place — it just needs an explicit-write path.
3. **Within-swarm parallelism.** Two-headed reviewer, parallel scouts. The per-`(swarm, agent)` lock already supports it via distinct AgentConfigs; needs UI for parallel role specs and a join/synchronization step in the FSM.
4. **Cross-workspace swarms.** A swarm spans repos. Needs swarm state outside the per-workspace tree and a top-level UI placement.
5. **Resumable swarms.** Idempotent message delivery, partial-stream-json detection, mailbox replay.
6. **Hard cost-USD caps** if Atelier ever supports an API-key auth path (it doesn't today and isn't planned).
7. **File-stomping mutexes.** Only matters once parallelism lands.

## 18. Open questions / risks

- **Prompt-engineering risk on the artifact contract.** Reviewer must reliably write a parseable JSON verdict. Mitigation: explicit instruction with a literal example in the system prompt, default-to-Failed on miss. v1.1 could add a transcript-fallback parser.
- **Run-history pruning interaction.** A swarm with 7+ runs could be partially pruned by aggressive retention settings. Mitigated by self-contained `report` mailbox entries (§7) and the rule "pruning skips runs whose `swarm_id` references a swarm in `running` state". The "click to view full transcript" link gracefully degrades for pruned-but-completed runs.
- **Mailbox file growth.** Bounded in practice (≤ ~20 entries per swarm at v1.0 limits) but unbounded across many swarms. v1.1 may need a per-swarm cap or a global retention pass alongside `swarms/` directory pruning.
- **Notification fatigue.** v1.0 enforces one swarm per workspace, but a user with N workspaces can have N concurrent swarms; if all finish within minutes, that's N pings. Acceptable; revisit if it bites.
- **The "scout produces a useless plan" failure mode.** Builder will run on a bad plan and the reviewer will reject it. Loopback consumes iterations even though the root cause is upstream. Mitigation: scout's preset prompt is conservative; v1.1 could let reviewer dispatch *back to scout* (currently the FSM only goes back to builder).
- **Empty assistant response from a role.** Claude returns a refusal or no-op, exit code 0, no file changes, no artifact. State machine treats it as a `done` outcome. For builder: reviewer fires on an empty diff, vacuously approves or rejects. For scout: builder fires with an empty plan in the handoff, likely produces nothing. Loopback eventually exhausts. Not a v1.0 blocker but worth surfacing in the role-status strip ("scout finished with no output" hint when transcript bytes < 100).
- **Older claude CLI degraded mode.** If `supports_stream_json()` is false, the handoff payload's transcript section pastes raw PTY bytes (ANSI codes, stderr). Quality degrades but the flow works. Surfaced in the Swarm tab via a small "stream-json unavailable" badge. v1.0 ships as-is; the user is encouraged to `claude self-update`.
- **Pre-flight check coverage gap.** `swarm_start` validates active-swarm + cwd-exists, but does NOT validate that the role-preset AgentConfigs are well-formed (e.g., user could edit the seeded scout to have an empty system prompt). The existing `agents.rs:start_run` pre-flight (`agents.rs:813-961`) catches empty prompts and returns a clear error per v0.7.4 — that error surfaces as the swarm's first run failing, which transitions the FSM to `Failed { reason: "scout failed: ..." }`. Acceptable; not perfect.

## 19. v1.2.0 — Custom templates + role library

v1.2 generalizes the v1.0 hardcoded scout-build-review chain into a data-driven `SwarmTemplate` shape that the FSM consumes. The legacy `template_id: String` field on `Swarm` finally has meaning beyond a label: it picks which role chain runs.

### 19.1 Data model

```rust
RoleStep {
  role: RoleId,                          // "scout", "ux-reviewer", etc.
  expects_artifact: bool,                // true for reviewer-class steps
  on_reject_jump_to: Option<usize>,      // step index for loopback; None = terminal
}

SwarmTemplate {
  schema_version: u32,                    // = 1
  id: TemplateId,                         // builtin id (e.g. "feature", "design") or user UUID
  label, description: String,
  steps: Vec<RoleStep>,
  max_iterations: u32,                    // default 3, range 1-10
  max_wall_seconds: u64,                  // default 1800, range 60-7200
  builtin: bool,                          // true for the 6 ships-with templates (v1.5.12)
  coordinator: bool,                      // v1.3.0: true if the steps array is a role pool
                                          // for a coordinator-mode template
  created_at, updated_at: i64,
}

WorkspaceRoleBindings {
  workspace_id: String,
  bindings: HashMap<RoleId, AgentConfigId>, // per-workspace role -> agent map
}
```

### 19.2 Persistence

- **Built-in templates** live in code (`swarm_templates::builtin_templates()`). Synthesized in-memory on every `list_all()` call. Not persisted. v1.1 → v1.2 upgrade requires zero migration writes.
- **User-defined templates** persist to `<config_dir>/swarm_templates.json` (single global file). Atomic write via tempfile + rename per Hard Rule #3.
- **Role bindings** persist per-workspace at `<config_dir>/swarms/role_bindings/<workspace_id>.json`.

### 19.3 Role library (6 ships-with presets)

| Role ID | System prompt focus | Artifact |
|---|---|---|
| `scout` | tactical plan: which files | plan / files / rationale |
| `architect` | architectural decision | decision / rationale / open_questions |
| `builder` | implement the plan | none (diff is output) |
| `refactorer` | improve without changing behavior | none |
| `reviewer` | code-quality verdict | verdict / critique / blocking_issues |
| `ux-reviewer` | UX-only verdict | verdict / critique / ux_issues |

Library is **fixed in v1.2** — no role editor. Adding a 7th custom role waits for v1.3 alongside the Coordinator role (their UI surfaces overlap).

### 19.4 Built-in templates (6 shipped — current as of v1.5.12)

| Template | Steps | Loopback | Caps |
|---|---|---|---|
| `feature` | scout → builder → reviewer | reviewer reject → builder | iter 3, wall 1800 |
| `refactor` | scout → refactorer → reviewer | reviewer reject → refactorer | iter 3, wall 1800 |
| `bugfix` | scout → builder → reviewer | reviewer reject → builder | iter **2**, wall 1800 |
| `coordinator-feature` (v1.5.1) | role pool: [scout, architect, builder, reviewer]; coordinator picks each tick | n/a (coordinator emits `done: true`) | iter 5, wall 1800 |
| `ux-audit` (v1.5.11 single-role) | ux-reviewer | none — `on_reject_jump_to: None` makes the FSM ignore verdict; both verdicts terminate Done | iter **1**, wall **600** |
| `design` (v1.5.12 single-role) | architect | none — same single-role pattern as `ux-audit` | iter **1**, wall **600** |

`feature` is the v1.0 scout-build-review chain renamed. `bugfix` differs from `feature` only in iteration cap, included to prove per-template caps work end-to-end.

**Single-role templates (`ux-audit`, `design`) — calibration finding from v1.2.1:** build-and-review templates are the wrong shape for verdict-only goals (audit, design). When a multi-step template's terminal verdict gate doesn't fire (because the goal forbids the implementing role), the FSM monotonically converges on MaxIter. The original `ux-audit` (`[scout, builder, ux-reviewer]` with reject-loopback to builder) and the architect-via-coordinator-feature path both burned ~$5–$8 / 20–25 min on futile loopbacks before being collapsed to the single-role shape. The single-role shape makes the verdict-emitting role's output the deliverable, not a gate. See `docs/CALIBRATION.md` Run #17 (ux-audit) and Run #20 (architect-via-coordinator-feature) for the surfacing data.

### 19.5 FSM generalization

Replaces `SwarmState::PendingScout / PendingBuild / PendingReview` with a single `PendingStep { idx, role, prior_run_ids }`. Custom `Deserialize` maps the legacy v1.0/v1.1 tags into `PendingStep` at load time (one-release alias; remove in v1.3). The `role` field is a small deviation from the original design — carrying it on `PendingStep` lets `suspend_for_orphan` / `swarm_resume` stay self-contained without threading a `SwarmTemplatesStore` handle through the registry API.

`next_fsm_state(template, current_state, iteration, outcome) -> FsmTransition` reads:
- `step.role` to validate the just-completed run's role matches expectation
- `step.expects_artifact` AND `step.on_reject_jump_to.is_some()` to decide whether to gate on a verdict (informational artifacts like scout's plan are NOT gates — only reviewer-class steps with a loopback target check verdict)
- `template.max_iterations` for the loopback cap
- `template.max_wall_seconds` for the v1.1.1 wall-time enforcement

### 19.6 Template-id resolution

`resolve_template_or_fallback(store, id)` redirects the legacy `"scout-build-review"` to `"feature"` and falls back to `"feature"` for any unrecognized id. The orchestrator-level `swarm_start` calls this and **stores the resolved id** on the new swarm — new swarms always have a v1.2-shape `template_id`. Older state.json records still get redirected at read time. Permanent shim, not a one-shot migration.

### 19.7 Binding flow

`swarm_start` reads `RoleBindingsStore.get(workspace_id)`. For each role in the template:
- existing binding → use it
- missing → call `ensure_role_preset(role)` (auto-seed an `AgentConfig` from `role_preset_seed`), persist via `set_binding` so future swarms in this workspace re-use it

Explicit non-empty `role_bindings` passed to `swarm_start` bypass the store entirely. Used by tests + the bindings-panel "save all" flow which calls `RoleBindingsStore::replace` directly.

### 19.8 IPC surface

Ten new commands:
- `swarm_templates_list / get / create / update / delete / fork`
- `role_bindings_get / set / replace / remove`

`swarm_templates_list` returns builtins + user-defined merged in one list (the `builtin: bool` flag distinguishes them). Update / delete on a builtin id rejects with a friendly error; the editor offers Fork instead.

### 19.9 UI surface

- **SwarmStartModal** — template dropdown populated from the store, defaults to `feature`, shows description + chain preview + iter/wall caps.
- **KanbanBoard** — per-card swarm-template select dynamic, populated from the same store. Cards still carrying the legacy `"scout-build-review"` id render as `feature` in the picker (without rewriting the persisted card).
- **SwarmTab** — header gets a Templates ⚙ button alongside Reset role prompts. Empty-state and active-swarm views both render the inline `RoleBindingsPanel`.
- **SwarmTemplateEditorModal** — list of builtins (read-only, Forkable) + user-defined templates (Edit / Fork / Delete). Edit pane: label / description / ordered steps with per-step role + expects-artifact + on-reject-jump-to dropdowns / max iterations / max wall-time.
- **RoleBindingsPanel** — collapsed-by-default `<details>` block showing the 6-role library as a table with per-role agent dropdowns + Save / Reset.

### 19.10 Backward compatibility

- v1.1 `state.json` records with `template_id: "scout-build-review"` and `state.kind: "pending_scout"` (or build/review) deserialize cleanly via the custom `Deserialize` impl on `SwarmState`. Resume continues to work.
- Existing seeded `AgentConfig`s with `preset_id ∈ {"scout","builder","reviewer"}` are picked up by `RoleBindingsStore` lazily on first read per workspace (no migration write at upgrade time).
- Existing kanban cards with `swarmTemplateId: "scout-build-review"` render as `feature` in the picker; the orchestrator-level redirect handles their execution.

### 19.11 Open implementation choices (v1.2 baked in; revisit in v1.3+)

- **Role library is fixed** — extensibility deferred.
- **Templates global, not per-workspace** — single `<config_dir>/swarm_templates.json`.
- **Legacy template_id redirect: permanent shim**, not a one-shot migration.
- **State enum migration: serde aliases**, not state.json rewrite.
- **Bindings UI: inline panel** in SwarmTab, not a new sub-tab.
- **Role on `PendingStep`**: deviation from the design doc, preserved for self-contained suspend/resume paths.
