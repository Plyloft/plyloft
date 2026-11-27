# Snapshot → Kanban knowledge seam (design)

**Role:** architect-snapshot-knowledge-seam (run `8b6b2564`)
**Owner globs:** `docs/design/snapshot-knowledge-seam.md`, `.atelier/swarm/8b6b2564-…/architect-snapshot-knowledge-seam/**`
**Scope:** how a card progressing through agent + swarm runs should accumulate a running summary of "what this card actually shipped," sourced from the existing `changes.json` snapshot manifests.

---

## TL;DR — recommendation up front

Lead with the argued opinion, then defend.

1. **Split the field.** Add a system-managed `card.runHistory: Vec<RunHistoryEntry>` next to the user-authored `card.knowledge: Option<String>`. Don't stuff structured data into the existing string field. The "user typed into knowledge while a run completed" question dissolves at the schema layer.
2. **Append, capped.** FIFO at 10 entries / ~16 KB serialized; per-entry capped at 25 paths. Replace would destroy the only state that justifies the feature.
3. **Pointer, not duplicate.** Each entry carries counts (added/modified/removed), workspace-relative paths, run id, status, completion timestamp. **No `before`/`after` content.** That's the only realistic secret-exfiltration vector, and the bytes already live in `changes.json` behind file-system permissions — duplicating them into the much-more-visible kanban field is a privacy regression.
4. **Bypass: per-card flag, default ON.** `card.disableRunHistory: Option<bool>`. Per-workspace and per-run alternatives are worse defaults.
5. **Hook fires in the existing frontend listener** (`kanbanStore.ts::startKanbanSubscriptions`), not the backend exit listener. The frontend already does the card↔run reverse-lookup; piggybacking there avoids threading `card_id` through the backend run record. New IPC `snapshot_summarize(runId)` and `kanban_append_run_history(...)` keep summarization (truncation, redaction, test surface) in Rust.
6. **Feed back into next prompt — but terse.** When `kanbanStore.moveCard` builds the prompt it joins `[title, notes, knowledge, formatRunHistoryForPrompt(runHistory)]`. That closes the "what did we already ship" loop without bloating context. Per-card flag also gates this path.

The pushback this displaces is "just append markdown sentinel-bracketed inside `card.knowledge`." Simpler today, miserable in a year. See §2 Q3.

---

## 1. Background — what already exists

| Concern | Current state | Source |
|---|---|---|
| Snapshot capture | `SnapshotsStore::capture_before` walks cwd before `pty_spawn`. `compute_changes_with_globs` writes diff manifest after exit. | `snapshots.rs:113-267` |
| Manifest path | `<config_dir>/snapshots/<runId>/changes.json` (NOT `<cwd>/.atelier/swarm/<runId>/changes.json`). | `snapshots.rs:99-109` |
| Manifest read IPC | `snapshot_get_changes(runId) -> Option<ChangesManifest>` | `commands.rs` |
| Run completion | `compute_changes_with_globs` (best-effort, logs+continues on err) → persist run record → emit `agent://run-done`. | `agents.rs:1267, 1316, 1337` |
| Card ↔ run linkage | `card.linkedRunId`, `card.linkedSwarmId` set in `kanbanStore.moveCard`. | `kanban.rs:53,65`; `kanbanStore.ts:264-274` |
| Knowledge field | `card.knowledge: Option<String>` (v0.8.0; user-edited textarea). | `kanban.rs:48`; `KanbanBoard.tsx:217-345` |
| Prompt build | `kanbanStore.moveCard` joins `[title, notes, knowledge].filter(present).join("\n\n")`. CLAUDE.md flags this as a no-touch invariant. | `kanbanStore.ts:227-230` |
| Run-done listener | `kanbanStore.ts:298-358` — already does `card.linkedRunId === e.runId` reverse-lookup; already best-effort. | — |
| Swarm terminal listener | `kanbanStore.ts:338-357` — fires on mailbox `terminate`; already aggregates per-card. | — |

**Path correction worth flagging.** The goal-text says diffs live at `<cwd>/.atelier/swarm/<runId>/changes.json`. They don't. That cwd path holds **role artifacts** (scout/architect output JSON), not diffs. The diff manifest lives at `<config_dir>/snapshots/<runId>/changes.json` and is read via `SnapshotsStore::read_changes`. Builder must wire to the latter; this misreading would silently produce empty summaries.

---

## 2. The six decisions

### Q1 — Append vs. replace

**Decision: APPEND.** Each completed run pushes one entry. List is FIFO-trimmed at 10 entries OR ~16 KB serialized JSON, whichever bites first.

Rejected:
- *Replace per run.* Destroys lifecycle state. A card can iterate 3–5 times (swarm `max_iter=3`, plus user reruns); the value is precisely the shape of progression.
- *Append unbounded.* `kanban_load` is a render hot path; workspace JSON file size grows without bound. 16 KB matches `snapshots.rs::MAX_FILE_BYTES` for symmetry.

### Q2 — Format

**Decision: typed structured records, never round-trip-parsed markdown.** Storage shape is JSON; UI does the rendering once.

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunHistoryEntry {
    pub schema_version: u32,         // 1
    pub run_id: String,
    pub swarm_id: Option<String>,    // populated for swarm-spawned card runs
    pub completed_at: i64,           // unix ms
    pub status: String,              // "success" | "failed" | "killed" | "max_iter" | "timed_out"
    pub summary: ChangeSummary,
    pub truncated: bool,             // mirrors manifest.truncated
    pub collisions: u32,             // mirrors manifest.swarm_collisions; 0 for non-coordinator
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSummary {
    pub added: u32,
    pub modified: u32,
    pub removed: u32,
    pub paths: Vec<String>,          // workspace-relative; capped at 25; lex-sorted
    pub paths_omitted: u32,          // count over the cap
}
```

Rejected:
- *Fenced JSON inside markdown inside `card.knowledge`.* Sentinel-search is fiddly; user typing inside the blob corrupts it; one missed call site = JSON visible in the textarea. The only thing worse than YAML is YAML embedded in markdown embedded in JSON.
- *Plain markdown sections in `card.knowledge` separated by `<!-- atelier:run-history -->`.* Workable with a regex but every UI/IPC touch becomes a parse-and-rebuild dance. Splitting at the schema layer (Q4) is cheaper.
- *Line-prefixed log entries.* Terse but unsearchable; forces UI to render plaintext when we want clickable file paths.

### Q3 — User-edit collision

**Decision: not applicable by construction.** Splitting (Q4) means user prose lives in `card.knowledge` and system content lives in `card.runHistory`. Different fields; concurrent edits to one cannot clobber the other.

The residual concern is two run-done events for the same card landing close together. Two mitigations:

1. **All system writes go through one IPC**, `kanban_append_run_history(workspace_id, card_id, entry)`, which does load → push → trim → atomic save under the existing `KanbanStore::cache` mutex. No new lock surface; no JS race window.
2. **Idempotent on `runId`.** Pushing the same `runId` twice is a no-op. Cheap insurance against double-fire (e.g., the orchestrator's listener firing alongside the kanban listener).

Rejected:
- *Sentinel boundary inside one field* — single missed call site, user sees system JSON inside their own notes textarea. Recurring tax for no benefit.

### Q4 — Storage shape

**Decision: split.** Add `pub run_history: Vec<RunHistoryEntry>` to `KanbanCard` with `#[serde(default)]`. Keep `knowledge: Option<String>` exactly as today.

**Migration story** (mirrors `kanban.rs:332-392`):

- **No schema-version bump.** `KANBAN_SCHEMA_VERSION` stays at `1`. The new field is additive and optional, identical to how `knowledge`, `swarm_template_id`, `linked_swarm_id` were added. Loader pattern in `kanban.rs:121-138` already accepts unknown extra fields and `serde(default)`s missing ones.
- **New Tier 2 schema-migration test required** (CLAUDE.md Tier 2 rule applies):

  ```rust
  #[test]
  fn pre_v1_x_card_loads_without_run_history() {
      // Cards serialized before this change had no runHistory field.
      // Must round-trip with run_history defaulting to empty Vec.
      let json = br#"{
          "version": 1,
          "cards": [{
              "id": "c1", "workspaceId": "ws", "title": "legacy",
              "knowledge": "user prose",
              "columnId": "in_progress",
              "createdAt": 100, "updatedAt": 200
          }]
      }"#;
      // … fs::write + store.load + assert cards[0].run_history.is_empty()
  }
  ```

- `kanban_save` round-trips the full struct already; no IPC change needed for saves.

**Prompt-side join.** When `kanbanStore.moveCard` builds the prompt, it gets one new concatenation: a compact textual rendering of `card.runHistory` produced by `formatRunHistoryForPrompt(runHistory)`. The render format is deliberately different from the storage format — terser, no JSON keys, no run ids — because they aren't round-tripped. Example render for the prompt:

```
Prior runs on this card:
  • 2026-05-06 14:20Z — success — modified 2 files (src/api/health.rs, src/api/mod.rs)
  • 2026-05-06 14:34Z — success — added 1, modified 2 (docs/health.md, src/api/health.rs, tests/health.rs)
```

This closes the loop the goal asks about: yes, run history feeds back into the next prompt, but only its terse form. The per-card opt-out also disables this prompt-side join.

Rejected:
- *Stuff JSON-in-markdown into `card.knowledge`.* See Q2/Q3. Single-string ergonomics tempting; collision and parsing ergonomics awful.

### Q5 — Bypass

**Decision: per-card flag, default ON.** New optional field `card.disableRunHistory: Option<bool>`. Toggle next to "Add knowledge / context" in `KanbanBoard.tsx`.

Rejected:
- *Per-workspace setting.* Wrong-direction default — users with sensitive cards in an otherwise-public workspace would have to remember to opt out before the *first* run, and the opt-out wouldn't be visible at the card level where the sensitivity actually lives.
- *Per-run flag.* Clutters the dispatch UI for a setting that's almost always sticky-per-card. Runs are ephemeral; cards are not.

**Open**: a global `settings.json` kill-switch (`behavior.runHistorySync: bool`)? Not in v1. Per-card flag plus an empty `runHistory` is sufficient opt-out. Add only when a user asks.

### Q6 — Privacy / size caps

**Per-entry caps:**
- 25 paths max. Selection over-cap: deterministic — sort lexicographically (matches `snapshots.rs:242` ordering), keep first 25, set `paths_omitted` to the count discarded. Path-weighting alternatives (by size, by extension) rejected — undermotivated complexity, and "interesting" surrogates can hide rather than reveal what shipped.
- ~2 KB serialized JSON per entry as a soft cap; if an individual entry exceeds it (long path list), drop paths from the tail until under cap.
- `truncated: bool` mirrors the source manifest.

**Per-card caps:**
- 10 entries OR ~16 KB serialized total. FIFO trim (drop oldest) when either bites.

**Path hashing:** none. Workspace-relative paths are short by design (cwd doesn't appear in them). Hashing them defeats the "what shipped" purpose and offers little — the same paths are visible in the editor and the file tree anyway.

**Diff content:** **never embedded.** This is the load-bearing privacy decision. `before` and `after` strings can carry credentials, PII, customer data, half-redacted tokens. They already exist in `changes.json` behind `<config_dir>/snapshots/...` file-system permissions; promoting them into `card.runHistory` (rendered in the kanban UI, possibly in tooltips, possibly in a future workspace export) is a category-error. Path-and-counts only.

**Binary diffs / large files:** already filtered upstream by `snapshots.rs::looks_binary` and `MAX_FILE_BYTES = 100 KB`. Nothing to do at this layer; `summary.paths` will simply not include filtered files because `changes.json` doesn't either.

---

## 3. Worked examples

**After 1 oneshot run** ("Add /healthz endpoint"):

```json
{
  "id": "card_42",
  "title": "Add /healthz endpoint",
  "notes": "Mount on the existing axum router.",
  "knowledge": "We agreed not to introduce a new router.",
  "runHistory": [{
    "schemaVersion": 1,
    "runId": "run-7c1f",
    "swarmId": null,
    "completedAt": 1746556800000,
    "status": "success",
    "summary": {
      "added": 1, "modified": 1, "removed": 0,
      "paths": ["src/api/health.rs", "src/api/mod.rs"],
      "pathsOmitted": 0
    },
    "truncated": false,
    "collisions": 0
  }]
}
```

**After 3 runs** (one oneshot, one swarm, one swarm rerun):

```json
{
  "id": "card_42",
  "title": "Add /healthz endpoint",
  "knowledge": "We agreed not to introduce a new router.",
  "runHistory": [
    { "schemaVersion": 1, "runId": "run-7c1f", "swarmId": null, "completedAt": 1746556800000, "status": "success",
      "summary": { "added": 1, "modified": 1, "removed": 0,
                   "paths": ["src/api/health.rs", "src/api/mod.rs"], "pathsOmitted": 0 },
      "truncated": false, "collisions": 0 },
    { "schemaVersion": 1, "runId": "swarm-9a02", "swarmId": "swarm-9a02", "completedAt": 1746557400000, "status": "success",
      "summary": { "added": 0, "modified": 3, "removed": 0,
                   "paths": ["src/api/health.rs", "src/api/mod.rs", "tests/health.rs"], "pathsOmitted": 0 },
      "truncated": false, "collisions": 0 },
    { "schemaVersion": 1, "runId": "swarm-b170", "swarmId": "swarm-b170", "completedAt": 1746558200000, "status": "max_iter",
      "summary": { "added": 1, "modified": 2, "removed": 0,
                   "paths": ["docs/health.md", "src/api/health.rs", "tests/health.rs"], "pathsOmitted": 0 },
      "truncated": false, "collisions": 0 }
  ]
}
```

One entry per swarm (not per leg). Per-leg detail already lives in the Swarm tab; flattening at the card level keeps the kanban surface readable. The swarm summary unions per-leg manifests' file sets and sums add/mod/rm counts.

**User edits `knowledge` while a swarm completes:**

| t | Event |
|---|---|
| t₀ | User opens card editor, types into the knowledge textarea |
| t₁ | Swarm finishes; backend emits `swarm://terminate` |
| t₂ | Frontend listener (kanbanStore) receives terminate; calls `snapshot_summarize_swarm(swarmId)` then `kanban_append_run_history(...)` |
| t₃ | Backend `kanban_append_run_history` takes the cache mutex, loads the *latest* on-disk card (which already includes the user's typed knowledge if they hit save), pushes the entry to `runHistory`, atomic-rename, returns |
| t₄ | User finishes typing, hits save → `kanban_save_card` writes the user-edited card back, but the card it loaded for editing is now stale w.r.t. `runHistory` |

The collision is real but bounded. Two ways to land it cleanly:

- **(a) Defer the editor read of `runHistory`.** The card-edit form binds only `knowledge` (and `notes`, `title`, etc. as today). On save, the form sends a *partial patch* (`{knowledge, notes, title, …}`) via `updateCard`, never sending `runHistory`. Backend merges the patch into the latest on-disk card. No collision.
- **(b) Save full struct + version compare.** More machinery; unnecessary if (a) is in place.

The design picks **(a)**. Frontend `updateCard` already takes `Partial<KanbanCard>`; we just need `kanban_update_card` (or whichever IPC backs it) to merge rather than replace. Builder must verify this — see open question §6.

---

## 4. Data flow sketch

```
┌──────────────────────────────────────────────────────────────────┐
│  Backend (Rust)                                                  │
│                                                                  │
│  agents.rs::on_pty_exit                                          │
│    └─► snaps.compute_changes_with_globs()                        │
│         writes <config_dir>/snapshots/<runId>/changes.json       │
│    └─► persist run record                                        │
│    └─► app.emit("agent://run-done", payload)                     │
│                                                                  │
│  swarms.rs::on_swarm_run_done                                    │
│    └─► (existing FSM advance)                                    │
│    └─► (on terminal) emit swarm://mailbox kind=terminate         │
└──────────────────────────────────────────────────────────────────┘
              │                                   │
              ▼                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Frontend (kanbanStore.ts::startKanbanSubscriptions)             │
│                                                                  │
│  onAgentRunDone:                                                 │
│    1. (existing) reverse-lookup card by linkedRunId              │
│    2. (existing) advance column / update lastRunStatus           │
│    3. NEW: if !card.disableRunHistory:                           │
│         entry = await snapshot_summarize(runId)        ┌────────┐│
│         if entry: await kanban_append_run_history(…)──►│ Rust   ││
│                                                        │  IPC   ││
│  onSwarmMailbox kind=terminate:                        └────────┘│
│    1. (existing) reverse-lookup card by linkedSwarmId            │
│    2. (existing) apply terminal status → column                  │
│    3. NEW: if !card.disableRunHistory:                           │
│         entry = await snapshot_summarize_swarm(swarmId)          │
│         if entry: await kanban_append_run_history(…)             │
└──────────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Backend (Rust) — new IPC handlers in commands.rs                │
│                                                                  │
│  snapshot_summarize(run_id):                                     │
│    SnapshotsStore::read_changes(run_id)                          │
│    → cap paths at 25 (lex sort)                                  │
│    → drop before/after content                                   │
│    → return Option<RunHistoryEntry>                              │
│                                                                  │
│  snapshot_summarize_swarm(swarm_id):                             │
│    SwarmStore::get(swarm_id) → run_ids                           │
│    for each run_id: SnapshotsStore::read_changes(...)            │
│    → union path set, sum counts, max(truncated), sum collisions  │
│    → cap paths at 25                                             │
│    → return Option<RunHistoryEntry>                              │
│                                                                  │
│  kanban_append_run_history(workspace_id, card_id, entry):        │
│    KanbanStore::cache.lock()                                     │
│    load(workspace_id) → cards                                    │
│    locate card by id                                             │
│    if entry.run_id already in card.run_history: return Ok(())    │
│    push, FIFO-trim to 10 entries / 16 KB                         │
│    save(workspace_id, cards) — atomic tempfile + rename          │
│    drop lock                                                     │
└──────────────────────────────────────────────────────────────────┘
```

**Hard Rule #3 compliance.** All `card.runHistory` mutations land via `KanbanStore::save`, which already does tempfile + rename. No new write path; no new atomic-write surface to audit.

**`byWorkspace[wsId]` keying.** `KanbanStore` is already keyed per-workspace by file path; the new IPC takes `workspace_id` and operates within one file. No cross-workspace state.

---

## 5. Tests required (CLAUDE.md Tier 2 + Tier 1)

- `kanban::tests::pre_v1_x_card_loads_without_run_history` — additive-field migration (Tier 2, mirrors existing patterns).
- `kanban::tests::pre_v1_x_card_loads_without_disable_run_history` — same shape, the bypass flag.
- `kanban::tests::append_run_history_is_idempotent_on_run_id` — push twice, length stays 1.
- `kanban::tests::append_run_history_trims_fifo_on_count_cap` — 11th push drops the oldest.
- `kanban::tests::append_run_history_trims_fifo_on_byte_cap` — fabricated large entries; verify size-driven trim.
- `snapshots::tests::summarize_caps_paths_at_25` — synthetic 50-change manifest → 25 paths + `paths_omitted: 25`.
- `snapshots::tests::summarize_does_not_embed_before_or_after` — guard the privacy invariant explicitly.
- `snapshots::tests::summarize_swarm_unions_leg_paths` — three fake legs, deduped path set, summed counts.
- `kanban::tests::update_card_partial_patch_does_not_clobber_run_history` — guards the §3 collision case.

---

## 6. Open questions for the user

1. **Does `updateCard` already merge as a partial patch?** Section 3 collision handling depends on it. If today's IPC replaces the whole card struct on save, Builder must change it to merge — small but non-trivial.
2. **Backfill on app start?** If Atelier crashed between `compute_changes` and the frontend listener firing, the manifest is on disk but no entry was written. Should startup walk `linkedRunId` for every card and best-effort backfill? My instinct: skip in v1, revisit if drift is reported. Risks resurrecting summaries for runs the user has long since manually moved past.
3. **Per-role swarm breakdown.** A swarm has named roles; the design flattens them into one entry. Adding `per_role: HashMap<String, ChangeSummary>` is cheap on storage but adds UI surface. Worth it, or YAGNI?
4. **Coordinator collision badge on the kanban card.** When `summary.collisions > 0`, do we want a visible badge on the card itself (not just the Swarm tab mailbox)? Storage already carries the count; the UI surfacing is unscoped here.
5. **Global `settings.json` kill-switch?** Per-card flag is the v1 design. Add `behavior.runHistorySync: bool` only when a user asks. (My recommendation: not yet.)
6. **Prompt-side join opt-in.** Section 2 Q4 has the next run consume prior `runHistory` via `formatRunHistoryForPrompt`. This is a behavior change visible inside the agent's context window — should it ship enabled, or behind a per-card / per-template opt-in for the first version?
7. **Status of "killed" / "max_iter".** Should those statuses still write a `runHistory` entry? The design says yes (preserves "this card had a run; it failed/timed-out" for the next iteration). Confirm the call.

---

## 7. What this doc is NOT

- Not a builder plan. Concrete file-level edits, IPC wiring, and the cargo-test scaffolding go to the Scout/Builder roles.
- Not a UX spec for how `card.runHistory` renders inside the kanban editor. The storage shape is decided; the visual treatment is downstream.
- Not a swarm-template change. Coordinator-feature and the sequential templates emit `changes.json` already; nothing in the swarm orchestration layer needs to change for this seam.
