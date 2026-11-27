# Atelier — patterns to follow / footguns to avoid

Short rules with 3-line examples. Read before touching React/zustand code or
adding a new persisted struct field.

## React + zustand

### Never return a fresh empty literal from a zustand selector

`[] !== []` under `Object.is`, so each read flags a "change", which schedules
a re-render, which runs the selector again, which returns yet another `[]`,
which… → Maximum update depth exceeded.

```ts
// ❌ infinite re-render
const tiles = useTiles((s) => s.byWorkspace[wsId]?.tiles ?? []);

// ✅ stable module-scoped fallback
const EMPTY_TILES: Tile[] = [];
const tiles = useTiles((s) => s.byWorkspace[wsId]?.tiles ?? EMPTY_TILES);
```

### Don't `.slice()` / `.filter()` / `.map()` inside a selector

Same family as the previous rule — derived arrays are fresh on every read.

```ts
// ❌ .slice() returns a new array → re-render storm
const recent = useAgents((s) => s.byWorkspace[id]?.runs.slice(0, 8) ?? []);

// ✅ subscribe to the stable parent array; derive in the component body
const allRuns = useAgents((s) => s.byWorkspace[id]?.runs ?? EMPTY_RUNS);
const recent = allRuns.slice(0, 8);
```

### `?? null` for primitives or `find()` results is fine

`null === null`, and `array.find(...)` returns the *same* object reference
when the source array hasn't changed, so the selector value is stable.

```ts
const expandedId = useTiles((s) => s.byWorkspace[wsId]?.expandedTileId ?? null);
const ws = useWorkspaces((s) => s.workspaces.find((w) => w.id === activeId) ?? null);
```

### Don't thread non-memoized derived values into `useCallback` / `useEffect` deps

A `find()` result becomes a new object reference whenever its source array
changes. Threading it into deps churns the callback every render → effects
that depend on the callback churn too → easy infinite loop.

```ts
// ❌ ws is a new ref on every workspaces update → onAddShell churns
const ws = workspaces.find((w) => w.id === activeId);
const onAddShell = useCallback(() => { /* uses ws */ }, [ws, addShellTile]);

// ✅ depend on primitives or pull only what you need
const onAddShell = useCallback(() => { /* invoke with activeId */ }, [activeId, addShellTile]);
```

### Memoize tile-body-shaped components, not their headers

When a parent re-renders 1×/sec for a status timer, the heavy child (xterm,
CodeMirror) shouldn't re-render with it. Wrap the body in `React.memo` keyed
on the props that *actually* change (ptyId / runId), not the whole tile.

```tsx
const TileBody = memo(
  ({ kind, ptyId, runId }: Props) => /* xterm or AgentRunView */,
  (a, b) => a.kind === b.kind && a.ptyId === b.ptyId && a.runId === b.runId,
);
```

### Per-workspace components: render one host per warmed workspace, never gate on `activeId`

If a per-workspace component (xterm, CodeMirror, BrowserPane) only mounts when
`activeId === wsId`, switching workspaces unmounts and **kills the PTY**. Mirror
the v0.5.1 fix: render one host element per warmed workspace inside a `.stack`
container, toggle `.hidden` (visibility hidden + pointer-events none) on inactive
ones. `.tile-grid-host` (v0.5.1) and `.center-card-host` (v1.76.0) follow this
(`.right-tabs-host`, v0.7.0, did too until the panel was retired in GH #95).

```tsx
// ❌ unmounts inactive workspace's PTYs
{activeWs && <TileGrid env={env} workspace={activeWs} />}

// ✅ all warmed workspaces stay mounted; CSS hides inactive ones
<div className="tile-grid-stack">
  {[...warmed].map((id) => {
    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return null;
    const visible = id === activeId;
    return (
      <div key={ws.id} className={`tile-grid-host${visible ? "" : " hidden"}`}>
        <TileGrid env={env} workspace={ws} />
      </div>
    );
  })}
</div>
```

## Toasts

### An error toast says what didn't happen and what to do next (1.174.0, P41)

Every error toast follows one rule (owner, 2026-10-31):

1. **Title:** what didn't happen, as a fact in the past ("The card wasn't
   archived"), never "X failed" and never only a noun.
2. **Body:** what is untouched ("It's still in its column") and what to do
   next ("Try again"), in one or two short sentences. Or an action that does
   it (Try again, Stop again, Show them, Copy the address).
3. **The raw error goes only in `details`** (behind Details › Copy), and the
   body ends with "Details has the reason." when there is one. A toast whose
   body is the address (E10) or whose action does the next step (Stop again)
   does not add it.
4. **The same failure has the same words everywhere.** Every link that didn't
   open is told with `linkDidNotOpen(address, cause)` (`src/lib/linkToast.ts`):
   kind warn, "The link didn't open", the address as its body, Copy the
   address. `node scripts/ux-check.mjs` (`linkToastHits`) fails any
   `openWebLink(…)` whose failure isn't told that way: its chain (through
   `.then`) must end in a `.catch` that calls it — a silent `() => {}` or a
   handler passed by name fails too — or, awaited, the innermost `try`
   around it must catch with it.
5. **Body and title go through `machineWords`** (`toastStore.ts` already does
   it), so "this Mac" reads "this PC" on Windows.
6. **Guard (B3):** an error toast with neither body nor action fails
   `node scripts/ux-check.mjs`, apart from the `bareErrorToasts` baseline in
   `docs/ux-language/ux-baseline.json`; the baseline only goes down. Fix one,
   then run `node scripts/ux-check.mjs --write-baseline`.

```ts
// ❌
pushToast({ kind: "error", title: "Archive failed", details: String(e) });
// ✅
pushToast({
  kind: "error",
  title: "The card wasn't archived",
  body: "It's still in its column. Try again; Details has the reason.",
  details: String(e),
});
```

### A toast raised while a sheet is open sits above it (1.176.1; was X2, 1.174.0)

Every `z-index` is a name on the one scale in `App.css`
(`--z-lift` … `--z-palette`, lowest first); `src/lib/zScale.test.ts` fails on
a literal. Until 1.176.0 a toast kept under every sheet (owner, 2026-10-31),
so a confirmation raised inside a sheet ("Report copied") was drawn under the
backdrop, announced and never seen. ToastStack picks the layer (`toastLayer`):
with any sheet open (`sheetLayerStore`, held by `<Sheet>`) the stack takes
`--z-toast-sheet`, above every sheet (Setup's too), and sits at the top of the
window so it never covers the foot's buttons; it takes no focus and is the
same live region, so it is announced once. A toast raised from inside Settings
(1.176.1 walk 2: whenever Settings is open, whatever raised it) takes `--z-toast-modal`; over Setup or the Sign-in
screen `--z-toast-setup`; otherwise `--z-toast`, under the sidebar's scrim and
Settings. Only the command palette is above `--z-toast-sheet`, and the guard
fails any other layer that is. **Where it sits (1.176.1 walk 3):** with a
sheet open, a toast sits in the window's top-right corner, and only when that
box would meet the sheet does it go above the sheet, else below it, else the
corner over the sheet's title band (`sheetToastPlace`); over Settings it takes the
surface's top right under its title bar, else its foot, whichever misses the
row in use — the row whose control raised it, with that row's notice and
offers — and, when both meet it, the one covering none of that row's buttons
with the smaller overlap (`settingsToastPlace`) — both from real rects, placed again on resize, focus
changes and when an overlay opens, closes or changes height. An Undo toast
lives `UNDO_TOAST_MS` wherever it was raised, and goes when its change is
overtaken. Only a sheet that can be seen counts (`holdSheetWhileVisible`:
one in a hidden, warmed workspace host holds nothing). **Rule: inside a sheet
an action must also be offered in the sheet.** A sheet's keyboard trap leaves
a toast's buttons to the mouse, so a toast raised from a sheet is a
confirmation, never the only way to a press. A new layer takes a name on the scale, never a number.

## Tauri / Rust

### New commands live in their own module, never in `commands.rs` (1.175.0, G3)

`commands.rs` is the largest file in the app and only gets shorter. A new
Tauri command, and any helper it needs, goes in a module of its own named for
the feature (`card_claim.rs`, `leave_issue.rs`, `issue_edit.rs`,
`card_pr_commands.rs`, `deploy_map.rs`), registered in `lib.rs`'s
`invoke_handler`, with a row in `docs/ARCHITECTURE.md`'s module table. Its
window wrapper goes beside the feature in `src/lib/` (`leaveCard.ts`,
`editConflictActions.ts`), not in `src/ipc.ts`. A change that must touch
`commands.rs` (an existing command's wiring) keeps it no longer: move
something of the same feature out in the same change if it needs room.
`file_size_ratchet_tests.rs` holds the ceilings of `commands.rs`, `ipc.ts`
and `CardDetailPanel.tsx`; when a file gets shorter, lower its ceiling to the
new count (plus a margin of a few lines at most) in the same change.

### Every persisted-struct addition needs a v0.4.0 fixture test

The test catches enum-case mismatches and serde-rename typos before they
reach production data. Drop one alongside every new field.

```rust
#[test]
fn loads_v0_4_0_json_without_new_field() {
    let old = br#"{ "id": "x", "name": "demo" }"#;
    let parsed: Workspace = serde_json::from_slice(old).expect("parse");
    assert_eq!(parsed.new_field, None); // #[serde(default)] kicks in
}
```

### Never write a persisted file without tempfile + rename

A partial write — process killed mid-flush, disk full, etc. — corrupts
state. Atomic rename means readers always see one whole version or the other.

```rust
// ✅ tempfile then atomic rename (see WorkspaceStore::save_atomic)
fs::write(&tmp, json)?;
fs::rename(&tmp, &path)?;
```

### One backend process owns dynamic coordination state

Do not add leases, heartbeats, expiry, or sidecar writes while the Tauri
backend is the only coordination writer. Keep the process mutex and atomic
JSON mutation in the host; put versioned types and stateless reads in a shared
crate so MCP cannot drift or mutate.

```rust
// ✅ Tauri owns mutation; ply-collab / ply-mcp only read
let mut state = coordination.inner.state.lock();
mutate(&mut state)?;
save_atomic(&state)?;
```

Startup reconciliation is event-based: persisted active records become
`interrupted`. A timer must not guess that a live process expired, and a
record must never resurrect a PTY.

### Every managed PTY spawn carries a typed intent

Frontend labels are descriptive, not enforcement. The real choke point is
Rust's `PtyRegistry::{spawn, spawn_with_capture, spawn_collect}`; each call
must provide provider, execution kind, attendance, write intent, enforcement,
project relevance, persistence, and retention.

```rust
// ❌ caller relies on a tile label or prompt wording
pty.spawn(program, args, cwd, knowledge)?;

// ✅ backend registration cannot be skipped accidentally
pty.spawn(program, args, cwd, knowledge, SpawnIntent { /* explicit */ })?;
```

Update `scripts/agent-collab/audit-spawn-sites.sh` whenever a managed spawn
route is added. `Unknown + Unattended` is invalid; prompt wording alone never
makes a reviewer read-only.

### Reserve unattended writers in the same atomic transition

Checking for an active writer and creating a later record is a race. For an
exclusive unattended writer, the mutex-owned `starting` record is the
reservation: check the canonical worktree key and atomically persist that
record before child creation. An armed guard makes every pre-transfer failure
terminal.

```rust
// ✅ one transition: validate → check key → append starting → save_atomic
let reservation = coordination.begin(intent, cwd)?;
let child = spawn_child()?;
reservation.mark_spawned(pty_id, process_id)?;
```

Queue entries are intent, not sessions. Do not create an `AgentRun`, snapshot,
transcript, PTY, or `SessionRecord` until queued work acquires admission.
Never detect busy state by matching prose; decode the stable typed busy
envelope.

### Duplicate macOS test bundles are not GUI-isolated by PID focus

System Events can route a global keystroke to the installed app even after a
duplicate test bundle was selected and raised by exact PID. Shared
application/process identity makes `frontmost` an unsafe lifecycle boundary.

```text
❌ raise duplicate bundle by PID, then send global Cmd-Q or coordinate clicks
✅ use backend tests; if teardown is required, terminate the verified disposable
   executable PID and re-check the full process path
```

Never run duplicate-bundle GUI lifecycle automation from the installed Ply
session that owns the current chat.

### Create handoffs after evidence, never before it

An unattended run's PTY exit is too early for a durable receipt. Finalize the
`AgentRun`, compute `changes.json`, load bounded artifacts, then persist the
handoff. The handoff points to the snapshot instead of asking another model
to summarize or duplicating full file contents.

```rust
finalize_run(&run)?;
let changes = snapshots.read_changes(&run.id)?;
coordination.record_handoff_for_run(HandoffInput::from_run(&run, changes))?;
```

### Onboarding scripts hand the app a queue — they never write persisted JSON

`scripts/onboard.sh` must NOT write `workspaces.json` (or any persisted file)
in bash: it would duplicate the schema, drift the moment a field changes, and
bypass `save_atomic` (Hard Rule #3). Instead the script writes a tiny
`pending_imports.json` queue (a JSON array of canonical repo paths); the app
drains it at `.setup` and registers each workspace via `import_default`
(atomic, Rust-side, idempotent by canonical cwd). Same rule for any future
external tool that needs to seed app state.

```bash
# ✅ onboard.sh: queue canonical paths, let Rust own the write
printf '%s\n' "${CLONED_PATHS[@]}" | python3 -c '…json.dumps…' > "$TMP"
mv -f "$TMP" "$APP_SUPPORT/pending_imports.json"   # app drains on next launch
```

### `.atelier/` holds only shared, committed state — never personal run state

`.atelier/library/` (prompts, swarm/user templates) and
`.atelier/workspace_default.json` are committed and reach every teammate, so
they must carry only shared-safe data. Personal run history, snapshots,
identity, and live PTY state stay in `~/Library/Application Support/
com.mbadv.ply/` (per-user). Never write a teammate's email, a run id, or
machine-local paths into anything under `.atelier/`.

One narrow exception applies to human-accepted, evidence-backed Knowledge
promoted through the existing team gate. Its immutable frontmatter may carry
opaque **card**, **run**, **swarm**, **session**, **review-artifact**, and
**discussion-artifact** IDs as historical provenance. These identifiers are
not resumable state. Absolute or machine-local paths, process/PTY IDs,
transcripts, prompts, emails, auth data, provider session tokens, and personal
identity remain forbidden. Promotion must preview the permitted identifier
classes and bounded diff excerpts before committing the Markdown.

### Every PTY spawn site must use the cached PATH

macOS GUI apps don't read `.zshrc`. `shell_env::init()` probes the user's
interactive PATH via `bash -lc` once at startup; every PTY spawn must use
the result. Without this, `claude` resolves to the wrong path or not at all.

```rust
let env = shell_env::get();              // cached at boot
cmd.env_clear();
cmd.env("PATH", &env.path);               // critical
```

### NDJSON line-buffered parsing for streamed PTY output

When you intercept structured streamed output (e.g. a collected Claude
session's transcript, or `codex exec --json`), bytes arrive in arbitrary chunks that may split mid-line. Buffer
across calls; only parse complete lines. Don't try to parse the partial.

```rust
struct StreamParserState { line_buf: Vec<u8>, /* ... */ }

fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
    self.line_buf.extend_from_slice(chunk);
    let mut out = Vec::new();
    while let Some(nl) = self.line_buf.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = self.line_buf.drain(..=nl).collect();
        // trim '\n' / '\r', then serde_json::from_slice on the trimmed slice
        // ...
    }
    out
}
```

See `agents.rs::StreamParserState` (v0.9.0 G1) for the full implementation
including unparseable-line passthrough so claude's banners and stderr survive.

## Verification

### Tier 1 catches build errors; Tier 1.5 catches React mount loops

`cargo check + tsc + npm build` will all pass while the app is infinite-
looping at startup. Tier 1.5 (in `scripts/ppvp.sh`) boots the built bundle
in headless Chrome for 3s and fails if `pageerror` or React's "Maximum
update depth" fires. Run after every selector change.

### Behavioural UI tests: render it, do not read its source (GH #172)

When a card's claim is about what a component *does* — a key it answers, a
toast it raises, a call it never makes — prove it by rendering the component,
not with a regex over its source. Source contracts (`src/lib/*.test.ts`, under
`node --experimental-strip-types`) stay the right tool for pure rules and for
"every page does X" sweeps; three cards in a row (#103, #107, #142) had their
worst review findings exactly where a source shape stood in for behaviour.

- **Where.** `src/test/*.test.tsx`, run by vitest under jsdom
  (`vitest.config.ts`, separate from `vite.config.ts`; `npm run test:ui`, or
  `./scripts/test-ui.sh`). PPVP runs the suite inside the pure-contract step.
  Only `*.test.tsx` is collected, so the node-run `*.test.ts` files never are.
- **The helper.** `renderUi(ui, { fixtures, fakeTimers, withToasts })` from
  `src/test/render.tsx` returns Testing Library's result plus `user`
  (user-event) and `tauri`. `withToasts` renders the real `ToastStack` beside
  the component. `nextFrame()` lets one animation frame pass inside `act` —
  the dialog stack focuses its surface on the next frame, so type after it.
- **The Tauri stub** (`src/test/tauri.ts`) sits under `window.__TAURI_INTERNALS__`
  (via `@tauri-apps/api/mocks`), so every `invoke`/`listen` — `ipc.ts`, a store,
  a plugin — reaches it unchanged; never `vi.mock` an app module to stub IPC.
  `fixtures: { cmd: value | (args) => value }` answers `invoke` (a throwing
  fixture is a refused call); `tauri.calls` / `callsOf(cmd)` record every call;
  `tauri.emit(event, payload)` runs every live `listen` handler, the way a
  Rust `app.emit` would. **It fails closed:** a command with no fixture
  resolves `undefined`, is listed in `tauri.unhandled`, and fails the test in
  setup's `afterEach` — unless the test called `tauri().allowUnhandled()`.
  Give every command the component reaches a fixture.
- **Resets.** `src/test/setup.ts` wraps zustand's `create`, so every store is
  put back to its initial state after each test, and installs a fresh Tauri
  stub before each. A module-level subscription guard would outlive that stub
  and leave the next test's `emit` with no listener, so setup's `afterEach`
  stops it (`stopSettingsSubscriptionForTests`); a new guard of that kind
  gets its own stop, called there. Other module-level state outside a store
  (a `Map` such as the live Undos) lasts for the file; each file gets its own
  module graph.
- **jsdom gaps are handled once, in `setup.ts`** — `navigator.platform` is
  `MacIntel` (so CodeMirror's `Mod` is ⌘), `Range` rects, `ResizeObserver`,
  `matchMedia`, and the `jest` bridge Testing Library needs to drain under
  vitest's fake timers. A test that needs another stub adds it there.
- **Every behavioural test must go red when its behaviour is removed.** Write
  a control beside a refusal (the writable tab that *does* save next to the
  read-only one that does not), and check it once by deleting the guard.

## Swarm orchestration

### Every SwarmStatus / SwarmState addition needs a coverage matrix sweep

When you add a variant to `SwarmStatus` or `SwarmState`, walk these
five touchpoints before declaring the change done:

1. **`abort`** — does it transition the new state to `Aborted` cleanly?
2. **`resume_to_running` / `swarm_resume`** — applicable for non-terminal states only.
3. **`suspend_for_orphan` / `kill_all`** — does it capture the right context for resume?
4. **`derive_role_from_state`** — what role does the orchestrator label a just-finished run with?
5. **FSM exit-arms** — every `next_fsm_state` branch that can produce or consume the new variant.

v1.1 added `Suspended` but missed touchpoint 1 → silent dead "Abort
permanently" button until v1.5.4. v1.3 added `PendingCoordinator` and
`Dispatching` but missed touchpoint 4 → coordinator-mode swarms froze
after tick 1 until v1.5.3. Both bugs were latent across releases
because the unit tests covered the pure FSM in isolation, not the
orchestration layer that bridges to it.

### The orchestration seam (event listener ↔ pure FSM) is the blind spot

`next_fsm_state` is pure and well-tested. `on_swarm_run_done` is the
glue that builds a `RunOutcome` from a Tauri event payload and feeds
it to the FSM, then dispatches side effects (start_run, mailbox writes,
notifications) on the result. Every v1.5.x hotfix was in this seam,
not in the FSM.

When you change anything that touches the seam:

- Pre-RunOutcome lookups (`derive_role_from_state`, instance lookup,
  workspace cwd resolve) — these can early-return and silently kill
  the FSM transition.
- Post-FsmTransition dispatch — both the sequential `Advance + next_role`
  branch AND the post-transition coordinator-mode handler can fire on
  the same transition. Make sure exactly one fires per dispatch
  (set `next_role: None` for any FSM transition that should be handled
  by the coordinator-mode handler).
- Mailbox emission ordering — `instance_done` / `Collision` / `Terminate`
  entries must be appended after the relevant state mutation lands, or
  observers see inconsistent intermediate states.

If you can't write a unit test for it because of Tauri AppHandle
ceremony, write a journal entry in `docs/CALIBRATION.md` walking the
event flow before shipping. Calibration runs are how this seam gets
exercised end-to-end.

## External edits to persisted state while Atelier is running

Atelier's persisted-state stores (kanban, agents, workspaces, prompts,
swarm_templates, settings, etc.) are loaded once at startup into
in-memory caches. Each store re-saves its cache to disk on every user
mutation — drag-card, agent edit, settings change. This means external
file writes have asymmetric durability:

- **Additive new ids survive** until any user-driven save fires. The
  cache merges new entries on next read, OR ignores them until the
  next reload — but does NOT actively overwrite them, because the
  cache writes its own keyed entries, not the whole array. New cards,
  new agents, new prompts written externally will appear after a
  Cmd-Q + relaunch even if the user hasn't touched the UI.
- **Edits to existing ids do NOT survive.** The cache holds the
  pre-edit version of the existing record; any save action (drag,
  edit, etc.) writes the cache back to disk and overwrites the
  external edit. Found by v1.2.1 calibration Run #22 — an external
  rewrite of `card.swarmTemplateId` was clobbered when the user
  dragged the card, because the drag triggered a save with the cache's
  stale `swarmTemplateId` value.

If you need to mid-session change something on an existing record from
the outside (e.g. a rerouting script, a calibration retry that needs a
different template), one of:

1. **Add a fresh additive record** with the new field values and a
   new id. The user pulls the new record by id; the old one stays
   stale on disk but doesn't matter.
2. **Cmd-Q Atelier first** (per Hard Rule #5, only Cmd-Q quits — the
   window-close handler `hide()`s but doesn't unload the cache).
   Then write. Then relaunch.
3. **Use the IPC** if a command exists for the mutation you want
   (`kanban_update_card`, `agent_update`, etc.). The IPC writes
   through the cache so the change is immediately consistent.

Cache-invalidation hooks (file-watching the persisted state) are
explicitly not implemented — the trade-off is simpler reasoning about
in-memory authority at the cost of needing one of these patterns for
external rewrites.

## Kanban: knowledge vs run_history (do not conflate)

`KanbanCard` carries two distinct fields that look superficially similar
but live on opposite sides of the user-vs-system seam. Conflating them
breaks the prompt loop and races user writes against system writes.

- `card.knowledge: Option<String>` — **user-only prompt input.**
  `kanbanStore.moveCard` joins it into the next run's prompt as
  `[card.title, card.notes, card.knowledge].filter(present).join("\n\n")`.
  Never written by any system path.
- `card.run_history: Vec<RunHistoryEntry>` — **system-only receipts.**
  Written exclusively by `KanbanStore::append_run_history` from the PTY
  exit listener (`agents.rs`) and `swarms::on_swarm_run_done`. Never
  injected into a future run's prompt; never user-edited.

If you find yourself wanting to "record what shipped" by appending
markdown into `card.knowledge`, stop. The agent will read its own past
output as instructions on the next rerun, AND the user's save-on-blur
on `knowledge` will race the system's append. Use `run_history` (or add
a new typed system field next to it) and keep prompt input separate from
receipts.

Caps live inside `append_run_history`: 5 entries / 10 paths / 200 chars
per path / 4 KB per serialized entry. FIFO trim drops oldest.

### Snapshot orphans + history pointers

`<config_dir>/snapshots/<runId>/changes.json` outlives both the card
(deleting a card does not cascade) and any future snapshot pruning.
`run_history.run_id` pointers may dangle after either. The "view changes"
link in `KanbanBoard.tsx` handles `Option<None>` from
`snapshot_get_changes` by surfacing a toast — keep that fallback in any
new consumer of the entry.

### Race: user save-on-blur vs exit-listener append

The user's save path (`kanban_save` IPC, full-card replace) and the
exit-listener's append (`KanbanStore::append_run_history`, partial
mutation under the cache mutex) target the same file. The mutex
serializes concurrent appends; the FE listener calls `kanbanLoad`
before applying its column/lastRunStatus patch (`refreshThenPatch` in
`kanbanStore.ts`) so the FE persist can't overwrite a freshly-appended
`run_history`. The user-blur path is still racey on a tight
"type-into-knowledge while a run completes" interleaving — flagged for
Tier-3 manual testing.

### Backend-owned PTY, frontend-attached xterm (v1.7.0 intake)

`Terminal.tsx` spawns its own PTY inside the React component effect and
kills it on unmount. That works for tile-grid panes where the xterm IS
the lifecycle anchor. Intake conversations break that assumption: the
PTY's lifecycle is owned by the backend (`intake_start` spawns,
`intake_apply` / `intake_cancel` kill), and the user may unmount/remount
the xterm by switching between cards or workspaces while the
conversation is still alive.

`IntakeConversation.tsx` is the canonical pattern for that case:

- The component receives a `ptyId` prop (already-spawned by the backend).
  It does NOT call `ptySpawn` and does NOT call `ptyKill` on unmount.
- It attaches via `onPtyData` / `onPtyExit` listeners and forwards user
  input via `ptyWrite`.
- Unmount disposes the xterm + clears subscriptions ONLY. The backend
  still has the PTY in `IntakeRegistry` and the live `pty://data` event
  stream continues; remounting the component (same or new workspace)
  catches up via the next `pty://data` events.
- Re-mounted xterm loses scrollback. Acceptable for v1; v2 could keep
  xterm DOM warmed per workspace if useful.

If you build another panel-embedded REPL surface (e.g. v2 post-swarm
review with diff viewer), follow this split: backend owns the PTY,
frontend just renders + forwards input.

### Schema additions: `#[serde(default)]` over version bumps — except when migrating

The general rule: keep `KANBAN_SCHEMA_VERSION` stable, add new fields
with `#[serde(default)]`, and write a Tier-2 schema-migration test that
loads a card without the new fields and verifies the defaults. The
load path used to treat unknown versions as "ignore this file"
(returning empty cards), so a version bump used to silently destroy any
kanban that hadn't been re-saved.

**v1.9.0 introduced an exception** (`KANBAN_SCHEMA_VERSION = 2`):
the verify-then-ship gate needed to retroactively mark every existing
Complete-column card as `verify_status: Legacy / ship_status: Shipped`
because those cards predated the gate. That's a real cross-state
migration, not a passive default. The load path was extended to handle
v1 → v2 explicitly: parse, mutate, write back as v2. New fields with
`#[serde(default)]` STILL covers most cases (and is cheaper); only bump
the schema when you have a migration that needs to inspect existing
state. When you do bump, the test pattern is in
`kanban.rs::tests::pre_v9_complete_card_migrates_to_legacy_shipped` —
write a v1 fixture, load it, assert the migration ran, assert it
persisted as v2 on disk.

### Nested fields of the shared definition: a new key travels, a new kind stops older builds (1.175.0, C6)

`.atelier/workspace.json` is read and written by every Plyloft version a
team runs at once, and every publish passes the whole file through this
build's types (`workspace_definition::file_text`). Two rules follow.

**A new key inside a value needs no `extra` on its type.** The types that
sit inside the definition (`VersionFileEntry`, `VerifyKind`,
`ReviewChecklistClass`, `ply_skill_switch::Choices`) have no `extra`
map, and must not grow one for this: the publish writes back what the
branch's file holds that the types don't know
(`definition_text::keeping`, fed the branch's own bytes by
`shared_config::prepare`). A value the publish doesn't change is written
as it was; in a list it changes, the items it left alone keep their keys;
an item this computer edited is the types' own. So:

- add the key with `#[serde(default)]` (and `skip_serializing_if` when
  its default must not appear in the file), as for any persisted field;
- never give a new key a meaning an older build breaks by *keeping* it
  beside a value it changed — an older build keeps the key only on a
  value it did not touch;
- the test to keep green is the byte-for-byte one,
  `c6_a_file_1_174_5_wrote_comes_back_byte_for_byte_from_a_rewrite_that_changes_nothing`:
  a file Plyloft wrote and nobody changes comes back identical, and a
  change is one line of diff.

**When the keys are not kept** (1.175.0, C6 round 2). An older build
drops a key it doesn't know from an item it *edited* or *added*, and from
a list whose items it can't match (two items equal in every field it
knows are matched by position first, then in order). It writes its own
text of the whole file — every unknown nested key gone — when the kept
text wouldn't read as exactly the same definition: a key kept under an
old name beside its new one (a serde `alias`), or a list this build's
types shorten or reorder as they read it. That fallback is logged
(`workspace_definition: writing this build's own text of …`) with which
case it was. So a new nested key must never be the only place a fact
lives.

**A new enum variant (a kind of check, of version file, of board) stops
every older build.** Its file no longer parses there (serde's "unknown
variant"); the older build keeps its last good copy, publishes nothing
and says "written by a newer Plyloft … Update Plyloft"
(`Unreadable::newer`, read from the message — no saved field). Add a
variant only when that is acceptable for the release, and say so in the
release note. A kind typed wrong by hand reads the same way (the two
can't be told apart); the Doctor row's detail and the log carry serde's
message, which names the value. A value older builds may ignore belongs in a string field
kept as written (`releaseKind`, `Workspace.shipVia`) or behind
`lenient_opt`, not in an enum.

## v1.9.x ship-gate footguns

The verify-then-ship gate (Phases A–F, v1.9.0) introduced its own family
of footguns. Documented here so the next person to touch this code
doesn't repeat the bootstrap-era bugs.

### Bootstrap installer boundary after the v1.94.0 restart loop

`scripts/install-local.sh` runs only synchronously from an external
interactive terminal. Ply-owned shell markers and installed/local/dev-host
ancestry fail before build, lock, quit, copy, or launch.
`install-local-detached.sh` is permanently retired; do not substitute another
supervisor or detach mechanism.

The loop's immediate cause was `launchctl submit` respawning a short-lived
quit → replace → reopen worker. The deeper failure was replacing an unproven
`nohup` path without first observing why it stopped, while the replacement
operation had no same-build idempotence guard, single-installer lock, staged
verification, recoverable swap, or append-only diagnostic log.

The recovery gate requires an external-Terminal-first workflow, a pre-build
directory lock, exact bundle-fingerprint no-op, verified staging, recoverable
rename swap, and append-only attempt log. Prior-attempt sibling evidence
blocks new builds and is removed only through explicit `--recover-residue`
constructor validation. Any future inside-Ply path must be selected from a
real Cmd-Q survival probe, not inferred from process-tree assumptions.
Installer changes receive a dedicated Tier-4 one-shot/idempotence/recovery
walk; routine PPVP is not sufficient. The first v1.95.0 identity-changing
replacement must close the production §8.4 path before release.

### IPC handlers must NOT block on long-running subprocesses (Bug A)

The original v1.9.0 `ship_card` ran `bash install-local.sh` via
`Command::output()`, which blocks until the child exits. The `tauri build`
step inside takes ~30s-5min, freezing the Tauri main thread. macOS shows
"Atelier not responding" after ~10s and the user thinks the app crashed.

**Rule**: any IPC handler that needs to spawn a process taking more than
~1s must spawn it detached, not synchronously waited. In v1.9.1 the fix
in `ship.rs` was to invoke via `bash -c "nohup bash <script> </dev/null
>/tmp/<log> 2>&1 &"` — the outer bash spawns the inner nohup'd build and
exits, the IPC returns, and the build runs out-of-band. `nohup` ensures
it survives Atelier dying mid-flight.

If you ever change `ship_card` or `ship_batch` to gain feedback on the
build's outcome, do it via Tauri events (`ship://building`, `ship://built`,
`ship://failed`) — never by blocking the IPC thread again.

### Backend kanban mutation → FE must reload before next FE write (Bug B)

Two stores (backend `KanbanStore::cache` + frontend `useKanban`) both
hold per-workspace card vecs. The backend writes during verify
finalization and ship completion. The frontend writes during user
mutations (`updateCard`, `archive`, etc.) — and crucially, the FE write
serializes the entire FE store snapshot to disk via `kanban_save`,
overwriting whatever the backend just wrote.

If the FE store hasn't been refreshed between the backend write and the
FE write, the FE clobbers the backend's update.

**Rule**: after every backend kanban write, the FE must `loadFromDisk(wsId,
true)` (force-reload) before any subsequent FE-side mutation. The v1.9.1
fix wired `verify://done` and `onShipped` to call force-reload. If you
add a new backend code path that mutates kanban (Phase D's QA agent,
Phase A.5's drain coordinator, etc.), wire a corresponding event + FE
listener that triggers the same force-reload.

The cheapest test: write a small fixture that mutates a card on the
backend, then mutates a different field on the FE, then re-loads from
disk and confirms BOTH mutations survived. Without the force-reload,
the FE write clobbers the backend.

### Capturing shell output? Strip ANSI/OSC before persisting (Bug F)

`bash -lc` sources the user's profile (zshrc/bashrc), which usually
includes a shell-integration prelude that emits OSC 133 codes
(`\x1b]133;C\x07` etc.) on every command. These survive into our
captured stdout/stderr and previously got persisted into
`VerifyEntry.summary` and `VerifyStepResult.reason`, rendering as
`]133;C` garbage in the UI and corrupting JSON readability.

**Rule**: any captured shell output destined for persisted JSON or
displayed text must go through `verify::strip_ansi()` first. The
function handles both CSI (`\x1b[...m`) and OSC (`\x1b]...\x07` or
`\x1b]...\x1b\\`) sequences. Unit tests live in
`verify.rs::tests::strip_ansi_*`.

### Multi-file version sync must include Cargo.lock (Bug E)

The ship pipeline syncs the version across `package.json`,
`src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` so the .app's
Info.plist, the npm version, and the Rust binary's version all agree.
Cargo.lock has its own per-package version field that must also be
bumped — otherwise `cargo build` rewrites it post-commit and leaves the
working tree dirty after every ship.

**Rule**: `ship.rs::write_package_version` is the single source of truth
for version sync. If you ever add a new file that pins the version
(e.g., a `pyproject.toml` for a future Python helper), add a
`sync_<name>_version` parallel call there. Cargo.lock's atelier-package
block specifically uses `rewrite_atelier_lock_version` (pure-function,
unit-tested) — don't shell out to `cargo update` from the ship path.

### Tempfile for a shell script must live in the script's expected dir (verify cwd bug)

`scripts/ppvp.sh` and similar scripts compute their working dir from
`$(dirname "${BASH_SOURCE[0]}")`. If we copy the script content to a
generic tempdir like `/tmp/foo.sh`, BASH_SOURCE points at /tmp and the
script's `cd $ROOT` lands at `/`. Every internal `cd src-tauri` then
fails.

**Rule**: when running a captured copy of a repo script (for the
`git show HEAD:` bootstrap pattern in `verify.rs::run_ppvp_from_head`),
write the tempfile under the SAME directory as the original
(`<repo>/scripts/.<name>-<ts>.sh`). The dot-prefix keeps it visually
quiet; cleanup runs after each invocation.

### Git success is not undone by ancillary post-ship work

Once a commit, tag, merge, or push has succeeded, optional follow-up work must
not make the ship return as failed. GH #104 retired the worked example this rule
was written from — the post-ship lesson's evidence capture, whose failures became
a bounded `ShipResult.diagnostics` entry so the card/review stamp and the batch
siblings carried on. The rule stands for the next piece of ancillary post-ship
work: keep its API non-failing, carry its warning where a human will see it, and
never let it reach back into the Git result. A missing `HEAD^` is valid for a
root commit; distinguish it from an unrelated Git failure before using the
empty-tree diff.

### Bootstrap pattern: ship-gate fixes via the broken gate

Historical v1.9.x releases repaired a broken gate by running
`./scripts/install-local.sh` directly from a Ply tile, then processing the
next ship with the new binary. That history is not a current playbook. The
recovered bootstrap installer refuses inside Ply and runs only visibly from
an external interactive terminal.

- See [docs/UPDATING.md § macOS "App Management" prompt during ship](./UPDATING.md#macos-app-management-prompt-during-ship) for why every ship triggers an OS prompt.

## v1.10.x worktree footguns

Captured during the Cycle A + B Tier 4 walkthrough (v1.11.0 → v1.11.2).
Each is a real edge that surfaced; documenting before they re-bite.

### Branch short-id collision when card ids share a timestamp tier

The FE generates card ids as `card-<timestamp36>-<counter>`. Pre-v1.11.3,
`make_branch_name` filtered alphanumerics from the literal id and took
the first 8, which means any two cards created in the same second of
the timestamp produced the same `cardmoxa…` short-id. Branches were
still distinct when titles differed (slug suffix), but two cards with
identical titles would have collided.

**Rule**: id-shape changes that keep a constant prefix (e.g. `card-`,
future `wt-`) MUST be reflected in `make_branch_name`'s prefix-strip
list. The current strip handles `card-` and `card_`. The regression
test `make_branch_name_disambiguates_co_second_card_ids` is the
canonical fixture — extend it when prefixes change.

### The worktree root ignores itself; the user's `.gitignore` is never written

N16: `worktrees::ensure_gitignore(workspace_cwd)` (called by every
worktree create) gives `<workspace_cwd>/.plyloft-worktrees/` a
`.gitignore` of its own holding `*`, the way `.pytest_cache/` does. Git
then ignores the whole root — that file included — and a card worktree
inside it is a checkout of its own, which never reads a parent folder's
ignore file. Builds before N16 appended `.atelier-worktrees/` to the
workspace's tracked `.gitignore`, which left the main checkout dirty
after the first create (Land refuses a tracked edit). Users may have
discarded that line, so a live legacy root gets the same `*` file
(`ensure_root_ignored`, from the trash sweep and from a reattach), and
the sweep writes either root's file again when it is missing or no
longer ignores everything.

**Rule**: never append to, rewrite or commit the user's `.gitignore`
for the worktree root. A root's own file that still ignores everything
is left as it is; a folder or link in its place is left alone and logged.

### Squash-merge conflicts on stale base — no auto-rebase

When `main` advances while a card is in flight (another card
shipped, a manual commit landed, etc.), `git merge --squash <branch>`
in the ship pipeline can hit conflicts. v1.10.3 surfaces the
error verbatim ("squash-merge … failed: <stderr> (resolve in the
worktree, then retry ship)"); the worktree is left intact and the
ship is aborted with no partial state.

**Rule**: don't add `git rebase --autostash` or similar before the
squash-merge unless the failure mode of a half-completed rebase is
also handled. The current behavior — fail loudly, leave the
worktree alive — is the correct lossless default.

### Worktree paths use the literal card id, branch names use the slug

The on-disk dir is `<cwd>/.plyloft-worktrees/<card_id>/` (stable;
a card made before N16 keeps `<cwd>/.atelier-worktrees/<card_id>/`,
unique). The branch is `atelier/card-<short_id>-<slug>` (slug
captured at create time). If the user renames the card after the
worktree exists, the branch keeps the OLD slug — branches are
stable identifiers. The Worktrees panel cross-references the
kanban store to surface the *current* card title, so the rename
is still visible to the user.

**Rule**: never auto-rename a branch when a card title changes.
The on-disk worktree dir is the stable identifier; branch names
are display-only.

**SL-6 exception**: a card built with both has a second worktree at
`<card_id>-b/` on the card's branch name plus `-b` (not
`make_branch_name("<card_id>-b")` — the short id would be the same).
When Codex's build is picked, that stays the card's worktree for
good (a live session can't be moved). So every prune, land, delete
and merged cleanup goes through `worktrees::card_worktree_dir(card_id,
worktree_path)`, never `worktree_path_for_card(card.id)` directly, and
`PruneCandidate` carries that `dir`.

### Lifecycle is column-edge-triggered, not state-resident

`worktrees::ensure_for_card` only fires when the card transitions
Todo → InProgress. If a v1.9.x-or-earlier card was already in
InProgress when v1.10.0 shipped, no worktree gets materialized —
the `worktree_path` field stays `None` (lazy migration). Ship
for that card uses the legacy main-checkout flow. Move it Todo →
InProgress (drag out and back in) to materialize a worktree.

**Rule**: the worktree machinery is opt-in by transition, not
retrofit by load. Existing-state migrations are a separate cycle
(deferred — not Cycle A scope).

### Trash GC happens once at launch, not on a timer

`worktrees::gc_trash` is invoked from `lib.rs` setup against every
workspace cwd. Once the app is running, the `.trash/` dir grows
without bound until the next launch. For users who keep Atelier
open for days at a time, stale worktrees can accumulate. Cycle B
accepted this — the assumption is that real users restart
periodically; if not, a future `cron::worktree_gc_trash` can
schedule a daily sweep.

**Rule**: don't add a timer-driven trash GC inside the running
app without a clear "stop on shutdown" path. Hard Rule #4
(kill PTYs on app exit) is the canonical shutdown-edge
invariant; any trash-GC thread must not outlive
`RunEvent::ExitRequested`.

## v1.12.x project_config footguns

Captured during the Cycle C build of `project_config.rs` +
`ship.rs` refactor (v1.12.0 → v1.12.5). Each is a real edge that
matters for non-Atelier workspaces.

### Atelier bootstrap config must match legacy hardcoded values 1:1

`default_atelier_config()` is a literal mapping of the v1.9.x
hardcoded ship-pipeline values (`target_branch: main`, three
version files in canonical order, `scripts/install-local.sh`,
`scripts/ppvp.sh`). `ship_card` reads this config now —
mismatches between the bootstrap and the legacy code paths
manifest as silent behavior changes for the Atelier workspace.

**Rule**: never edit `default_atelier_config()` to refactor the
Atelier-specific values without simultaneously verifying the
on-disk written file matches what the previous version of
`ship.rs` would have produced. Re-shipping a no-op chore
through the gate is the mandatory smoke check.

### `looks_like_atelier(cwd)` and `resolve_atelier_repo_root` must stay in sync

Both encode the same heuristic ("package.json + src-tauri/ +
scripts/install-local.sh"). The first lives in
`project_config.rs` (used by the launch-time bootstrap to decide
whether to write Atelier's default config); the second lives in
`ship.rs` (used by `ship_audit`'s global pre-flight). Diverging
them means the bootstrap fires for a workspace the audit
doesn't recognize, or vice versa.

**Rule**: when changing one, change the other in the same
commit. The two `cwd.join("package.json").exists()` chains
should be byte-for-byte identical.

### `ship_card` / `ship_batch` require a config — no silent fallback

If a workspace has no `project_config`, ship errors with
"Open Settings › This repository › Build and release and press
Re-detect" (`project_config::not_set_up`, by the workspace's name). This is
intentional — silent fallback to `default_atelier_config()`
would mean a non-Atelier project ships using Atelier paths, which
fails confusingly downstream. Fail loud at the gate instead.

**Rule**: never add a "fall back to defaults" branch in
`ship_card` / `ship_batch` for missing config. The bootstrap
covers Atelier; the FE Detect button covers everything else.
Absence is a configuration error, not a programmer's burden to
paper over.

### Cargo.lock sync must read the package name dynamically

Pre-v1.12.2 the lock-rewriter hardcoded `name = "atelier"`. With
multi-project, this is a footgun — LYRA's lock would never get
synced. v1.12.2 changed `sync_cargo_lock_at` to read
`[package].name` from the Cargo.toml itself.

**Rule**: any future Cargo.toml-or-lock manipulation must
parameterize on the package name read from the Cargo.toml. Don't
hardcode "atelier" anywhere outside of Atelier-specific tests.

### Per-project ship lock must use `is_held_for` for per-workspace UX

`ShipRegistry::is_held()` returns true if *any* workspace has a
ship in flight. Useful for the global "ship in flight" hint in
the audit modal, but wrong for per-workspace pills / button
enablement. Use `is_held_for(workspace_id)` for those.

**Rule**: when surfacing ship state to a per-workspace UI, prefer
`is_held_for(workspace_id)` over `is_held()`. The latter is for
truly app-global signals only.

### Intake reads no prompt override (GH #214)

Intake runs with the built-in `DEFAULT_SYSTEM_PROMPT`
(`IntakeStore::system_prompt`). The pre-1.146 overrides — the global
`<config_dir>/intake/system_prompt.md` (Settings › Agents, retired in
GH #171) and the per-workspace `<config_dir>/projects/<workspace_id>/intake.md`
(v1.12.3; its `intake_*_system_prompt_for` commands had no caller and are
gone) — are no longer read. They are left on disk, never deleted or
rewritten by this change.

**Rule**: a prompt the user can change needs a surface that shows and
resets it; an override nothing can see or reset is not read.

### project_config delete wipes the whole subdir

`ProjectConfigStore::delete(workspace_id)` calls
`fs::remove_dir_all` on
`<config_dir>/projects/<workspace_id>/`, which removes
`config.json` AND `intake.md` AND any future per-workspace
artifacts. The FE Reset button confirms before calling delete.

**Rule**: anything that lands in the per-workspace subdir is
considered deletable on Reset. If a future feature wants
something durable across resets, store it elsewhere (e.g.,
`<config_dir>/projects-archive/<workspace_id>/`).

## v1.13.x project_config + worktree integration footguns

Captured during the Cycle D LYRA-onboarding walkthrough
(v1.13.0 → v1.13.1). The first three are real bugs caught by the
walkthrough; the rest are forward-looking constraints.

### Worktree fork base must read from project_config.target_branch

Pre-v1.13.1, `kanban_card_advance_to_in_progress` hardcoded
`target_branch.unwrap_or_else(|| "main".to_string())`. The FE never
supplied an explicit branch, so every worktree forked from `main`
regardless of the project_config. For Atelier (target IS main)
this was a non-issue; for projects with `target_branch: staging`
(LYRA's case, with staging 69 commits ahead and 3 behind main) it
silently corrupted any squash-merge into staging.

**Rule**: any new code that creates a branch / worktree / ref MUST
read the base from `project_config.target_branch`, not from a
hardcoded default. The same gate that ship.rs (v1.12.2) applies to
"no project_config = error" must apply to lifecycle hooks too —
otherwise non-Atelier projects silently fork from the wrong place.

### `variable_name` is required when `kind == PythonModuleVar`

The schema makes `variable_name` an `Option<String>` because most
kinds don't need it. `PythonModuleVar` does — without it, the
writer doesn't know which Python identifier to find/replace.
`write_versions_per_config` errors loud on the missing field.

**Rule**: when adding a new `VersionFileKind`, decide up front
whether it needs payload. If yes, document the invariant in the
docstring AND error in the writer when the invariant is violated.
Don't silently no-op or fall back — silent failure on a
version-bump path means missed source files in the ship commit.

### Detection is depth-1 only — no recursive scan

`detect_from_filesystem` walks the cwd and depth-1 subdirs
(skipping noisy ones like `node_modules`). Deeper sub-projects
aren't auto-discovered. This is intentional — recursive scanning
would surface every package.json under every nested dependency.

**Rule**: if a user has sub-sub-projects that should be in the
ship config, they edit the JSON manually. Don't be tempted to
deepen the scan — the noise-to-signal cost flips fast. If a
specific common pattern emerges (e.g., monorepos with
`packages/<name>/package.json`), add it as a NAMED candidate in
`detect_version_files`, not as a generic recursive walk.

### `find_var_in_text` word boundaries

The Python module-var scanner checks word boundaries before AND
after the variable name to prevent matching `revision` when
looking for `version`. Implemented inline (no regex crate
dependency).

**Rule**: any future text-based version writer (Python, Ruby,
Go-build-tag, etc.) must use the same word-boundary check.
Substring matching alone is dangerous — too many real version
strings live near similarly-spelled identifiers (`revision`,
`prerelease_version`, etc.).

### `verify_script` was a shell-script path — closed by VerifyKind tagged enum (v1.13.5)

LYRA's verify is `/ppvp` — a Claude Code slash command, not a
shell script. The pre-v1.13.5 `verify_script: Option<String>`
schema treated it as a workspace-relative path. v1.13.5 replaced
the field with `verify_pipeline: Option<Vec<VerifyKind>>` where
`VerifyKind` is a tagged enum (`Script { path }` |
`SlashCommand { name, args }`). v1.13.6 wired `Script` entries
into the runtime pipeline; v1.13.7 will add `SlashCommand`
runtime via a Claude oneshot subprocess.

**Rule**: when adding a new verify shape, add it as a
`VerifyKind` variant, not as a string convention layered onto
the existing variants. The runtime dispatch in
`verify.rs::run_config_pipeline` is the integration point —
extend the match arm there with a third variant if needed.

### `release_kind: Local | Github` was binary — closed by PushOnly variant (v1.13.4)

Pre-v1.13.4 `ReleaseKind` was binary: `Local` (commit + tag
locally, no push) or `Github` (commit + tag + push to origin +
intent to also do GitHub Releases API in Phase F's tauri-updater
pipeline). LYRA wanted "commit + tag + push to origin/staging"
— Railway watches the branch and deploys, no Releases API.
v1.13.4 added `PushOnly` as a third variant doing exactly that.

**Rule**: `Github` is reserved for the future Phase F path
(actual Releases API + updater feed). Don't extend it to cover
deploy-via-push semantics — those go on `PushOnly`. The
`skip_verify` guard in `ship.rs` matches on `Github` only,
deliberately allowing skip-verify pushes for `PushOnly` (decision
H′: Railway-style deploys aren't strictly public).

### Config-driven verify pipeline collapses Atelier's per-step granularity (v1.13.6)

Pre-v1.13.6, Atelier's verify was hardcoded as two separate
steps: cargo-test, then `bash <ppvp.sh from HEAD>`. Post-v1.13.6,
Atelier's bootstrap config has
`verify_pipeline: [Script { "scripts/ppvp.sh" }]`, so the
config-driven path runs ppvp.sh as ONE step. Coverage is
equivalent (ppvp.sh internally runs cargo + npm + tsc +
tauri-build) but the FE timeline drops from two rows to one.

The decision-14 nuance also goes away: pre-v1.13.6 ppvp.sh ran
from the HEAD commit (so a card editing ppvp.sh wouldn't gate
against its own broken edit). The config-driven path runs the
working-tree copy of the script. For most projects this is what
you want; for Atelier it's a behavior change worth knowing.

**Rule**: when adding multi-step verify expression for a project,
prefer multiple `Script` entries in `verify_pipeline` over a
single wrapper script. The FE timeline renders one row per Vec
entry; collapsing into a wrapper is what loses granularity.

### v1 → v2 ProjectConfig migration is in-place rewrite (v1.13.5)

`ProjectConfigStore::get()` mutates the loaded struct: detects
v1 by `schema_version < 2`, translates `verify_script: Some(p)`
to `verify_pipeline: Some([Script { path: p }])`, sets
`verify_script` back to None, bumps `schema_version` to 2. The
disk file is NOT rewritten by `get()` — that happens on the next
`set()` call (the canonical v2 form goes to disk then). The
struct keeps `verify_script: Option<String>` as a deserialize-
preserving field with `#[serde(skip_serializing_if = is_none)]`,
which means after migration the field is always None on disk.

**Rule**: future `ProjectConfig` schema bumps follow the same
pattern — accept the old field as a deserialize-only (or
deserialize-then-translate) field, write the new shape on next
`set()`. Don't force a write-back from `get()` because reading a
config shouldn't have side effects.

### Always validate worktree branch base via the agent's first message

Cycle D Step 6 caught the v1.13.1 bug because the dispatched
ux-reviewer agent reported "branch is clean off `main` with zero
changes" — but the project's `target_branch` was `staging`. That
mismatch was the smoking gun.

**Rule**: when adding new lifecycle hooks for non-Atelier
workspaces, surface the resolved branch base in agent-visible
context (commit message, prompt prelude, file dropped at known
path). The agent's confused output is your strongest debugging
signal because the tests don't run against a real multi-branch
git repo.

## v1.14.x chrome-restructure footguns

> GH #95 (ADR 0005): the right panel is retired. `pinnedRightTabs` is still
> decoded for old files and ignored by the shell; the notes below are history.

### `pinnedRightTabs` is per-workspace, not global

Each `Workspace` owns its own pin order. The default
`[editor, kanban, card]` only applies when the persisted field is
`None`. Don't reach into a shared global selector for "the user's
pin preferences" — pull from the active workspace.

```ts
// ✅
const pinned = ws.pinnedRightTabs ?? DEFAULT_PINNED_RIGHT_TABS;

// ❌ leaks one workspace's preference across the rest
const pinned = useUi((s) => s.globalPinnedRightTabs ?? DEFAULT_PINNED_RIGHT_TABS);
```

### Pinning logic must not unmount tab content

Hard rule: the warmed `right-tabs-host` (one host per warmed
workspace, hidden via `.hidden`) and the `card-tab-host` always-mounted
pattern (v1.8.4) survive across pinning changes. Pinning only changes
which BUTTONS render in the tab bar — the body's mount/hide logic in
`RightTabs.tsx` is unchanged. If you refactor the body to gate on
`pinnedSet.has(tab)`, you'll lose the card-tab xterm scrollback the
moment a user unpins Card. Don't.

### Active-but-unpinned tab → transient slot, never auto-switch

When a user unpins the currently-active tab, keep the active tab as-is
and surface it via the transient slot (italic, leading `·`). Auto-
switching to a different tab on unpin is surprising — the user just
asked to remove the BUTTON, not switch the view. The same goes for
selecting a tab from the `•••` overflow when it isn't pinned: it
becomes the transient slot, not auto-pinned.

### Sub-section state is session-only — do NOT persist

`useUi.expandedSections` (key `${wsId}:${section}`) is intentionally
ephemeral. Persisting it means a user who collapses every section
sees their app open to a useless screen on next launch. Default-
collapsed at app start is the contract. If a future feature wants
sticky section state, bake it into `Workspace` (per-workspace,
schema-migrated) — never into `useUi`.

### Schema-migration test follows the v1.11.x template

The `pre_v14_workspace_loads_without_pinned_right_tabs` test mirrors
`pre_v11_workspace_loads_without_verify_suite`. When you add the
NEXT persisted `Workspace` field, write a `pre_vNN_…` test in the
same shape: write a JSON fixture WITH the previous fields present
but WITHOUT the new field, load via `WorkspaceStore::new`, assert
new field is `None` and existing fields survived. This is Tier 2
PPVP and is the cheap insurance against silently breaking everyone's
saved state.

## v1.15.0 SlashCommand verify footguns

### Never `claude -p`: a SlashCommand check is a collected interactive session

Anthropic announced billing `claude -p` outside the member's plan (Hard
rule 1), so no Plyloft code passes `-p` / `--print` / `--output-format` to
Claude: `claude_session::no_claude_spawn_uses_print_mode` reads every
non-test source, and `pty::refuse_print_mode` refuses such a spawn at the
PTY. `build_claude_slash_argv` builds an unattended writer session
(`claude_session::unattended_writer_args`: `--session-id`, the member's
mode mapped by `writer_mode`, the prompt, `--disallowedTools
AskUserQuestion`), and `spawn_collect` collects it through its transcript.

```rust
// ✅ the interactive TUI, named so its transcript can be found
let argv = crate::claude_session::unattended_writer_args(&prompt, writer_mode(cwd), &[]);

// ❌ refused by the guard test and at the spawn
let argv = vec!["-p".into(), prompt, "--output-format".into(), "stream-json".into()];
```

### Read a collected session from Plyloft's result line only

The session's output is its transcript, then one `claude -p`-shaped
result line Plyloft writes (`claude_session::result_line`). Pass/fail, a
failure's words and a capacity stall come from that line — **never from
the conversation**, which may quote limits and sign-in screens — and a
line marked unclassifiable (`claude_session::unclassifiable`: a turn that
ended without an answer, an unknown screen) is never read as a quota. A
session that ends **without** a result line (Claude exited on its own,
before its turn ended) failed, whatever its exit code.

### `PtyRegistry::spawn_collect` registers in the same map as `spawn`

The synchronous variant uses `self.sessions` so `kill_all` on Cmd-Q
catches an in-flight slash-command verify (Hard Rule #4). If you ever
add another sync PTY caller, use `spawn_collect` — don't reach for
`portable-pty` directly to bypass the registry. Orphans accumulate
silently.

### Script and SlashCommand verify share one card-aware CWD

`VerifyRegistry::enqueue` resolves `job.repo_root` once: it prefers the
card's existing worktree and falls back to `ws.cwd`. Both `Script` and
`SlashCommand` steps run in that same job-level root. If root selection
changes again, change it above the step kinds — don't fork CWD behavior
between Script and SlashCommand.

### Card verification and runner-backed work share one short authorization gate

The persisted `verify_status` / `last_run_status` fields are UI history, not
locks. `VerifyRegistry`, live Agent/Swarm registries, the derived card queue,
and `CardExecutionGate` are the process-local authorities. Every card Agent,
card Swarm, writer-queue admission, review follow-up, and card-queue pump must
use `CardExecutionGate::run_attempt`.

`run_attempt` holds only an RAII attempt marker across provider launch and
card-link publication. Its internal mutex is released before Git, worktree,
PTY, or provider work; the marker must remain alive until `start_run` returns
and the exact run/swarm link is durable. This closes the child-spawn →
live-counter window without serializing launches.

```rust
// ✅ short check/reset/publication, then long work outside the mutex
gate.run_attempt(
    verify, kanban, ws, card, kind, launch, publish_link, rollback_child,
)?;

// ❌ child exists while neither attempt marker nor linked live record exists
let run = launch()?;
gate.begin_attempt(verify, kanban, ws, card, kind)?;
```

Publication failure is not an allowed orphan path. The required rollback
terminates the just-started Agent or Swarm before the RAII marker clears.

`pump_card_queue` is the only nested-lock path and its order is fixed:
`QUEUE_PUMP_LOCK → card-execution gate`. Verification completion clears its
registry authority before waking both the card-swarm pump and single-agent
writer queue. A verified head card remains queue-eligible but does not
head-of-line block independent later cards from using parallel capacity. A
refused post-swarm auto-verify records one bounded, process-local unpaid retry
intent; successful work completion retries it, while a non-Done terminal
outcome clears it. Neither path replays a paid provider action.

## v1.16.0 RunHistory inline diff footguns

### Lazy-fetch swarm legs only on expand — never prefetch the list

`RunHistoryDiff` fetches `swarmGet(entry.swarmId)` inside a `useEffect`
gated on `expanded`-driven mount (the parent `RunHistoryRow` returns
nothing for `expanded === false`, so `RunHistoryDiff` never mounts at
all when the row is collapsed). If you ever refactor to keep the
detail mounted with `display: none`, gate the swarm fetch on a
separate `expanded` prop — otherwise you'll fire one IPC per swarm
aggregate per card on every render of the history list (potentially
dozens at once).

### `RunHistoryAccordion` is shared between KanbanBoard and CardDetailPanel

`KanbanRunHistory.tsx::RunHistoryAccordion` is rendered both inside
the inline kanban card body (`KanbanBoard.tsx`) and inside the
right-tab Card panel (`CardDetailPanel.tsx:543`). Any visual or
behavioral change to it lands in both surfaces simultaneously. The
inline kanban card is space-constrained — keep the diff section's
default-collapsed state and avoid auto-expanding entries on render.

### `RunChangesPanel` handles all empty states; don't re-implement them

The existing `RunChangesPanel` from `AgentRunView` covers loading,
error, null manifest ("No snapshot was captured…"), and empty changes
("No file changes detected") gracefully. New surfaces that consume it
(v1.16.0 added inline kanban history) should NOT add their own
fallback rendering — the panel's empty states are intentionally the
contract for "run had no diff, for any reason." This includes REPL
agent runs (no `capture_before`) and runs from before v0.9.0.

### Per-leg label uses runId head, not leg index alone

`Leg k/N · <runId-head>` is the right label format — the head makes
each panel uniquely identifiable in screenshots / bug reports. Don't
collapse to just `Leg k/N`. Conversely, don't render the full UUID:
the 8-char head balances uniqueness with screen real estate.

## v1.17.0 Cycle E.5 hardening footguns

### `gc_orphans` live-set must include kanban references, not just runs/

`prune_runs(days, max_runs)` (agents.rs) deletes the `agents/runs/<id>.json`
record but leaves the snapshot dir behind. If the user's kanban still
references that runId via `card.run_history[].run_id` or
`card.linked_run_id`, we want to KEEP the snapshot (so the diff viewer
can still surface it). The `lib.rs` call site assembles the live set
from runs/ filenames AND walks every workspace's kanban — both are
needed; runs/ alone would orphan diffs that the user might still
expand from a card history row.

```rust
// ✅ Live set is the union of runs/ + kanban references
let mut live: HashSet<String> = HashSet::new();
for entry in fs::read_dir(runs_dir).flatten() {
    if let Some(stem) = ...strip_suffix(".json") {
        live.insert(stem);
    }
}
for ws_id in workspaces {
    for card in kanban.load(ws_id) {
        live.extend(card.run_history.iter().map(|e| e.run_id.clone()));
        live.extend(card.linked_run_id.iter().cloned());
    }
}
```

### Warmed-workspace LRU: evict via state setter, not effect race

`App.tsx`'s LRU eviction reads `lastActiveAtRef.current` (a `useRef`)
inside the `setWarmed` callback rather than reading `lastActiveAt`
state. React batches state updates; if the timestamp setter runs in
the same effect as the warmed-set update, the warmed-set callback
captures a stale `lastActiveAt` snapshot. The ref-based read path is
synchronous and never stale within a single render cycle.

### Warmed-workspace LRU: PTYs die on unmount, watchers don't

`Terminal.tsx` kills its PTY on unmount (per CLAUDE.md), so evicting a
workspace from `warmed` (which causes the per-workspace components to
unmount via `[...warmed].map`) automatically cleans up its PTYs. But
file watchers don't auto-stop on unmount — the eviction code must
explicitly call `unwatchWorkspace(id)` for the evicted workspace.
Don't assume "removing from warmed" is sufficient cleanup; it covers
PTYs but not watchers (and not LRU tracker entries).

### Active workspace is never evicted — guard the LRU loop

The eviction loop (`for (const id of next)`) must skip `activeId`,
otherwise activating the 9th workspace could evict the workspace we
just activated. The guard is `if (id === activeId) continue;` — easy
to forget; covered by the rule that "the active workspace stays
warmed indefinitely."

### Programmatic Claude TUI submission is two PTY writes

Writing `body + "\r"` in one `PtyRegistry::write` is not equivalent to typing
text and then pressing Enter in Claude's interactive TUI. The CR can be
absorbed as part of the programmatic input without submitting a user turn.
The Intake priming and conclude paths therefore share one contract: write the
body with no CR/LF terminator, wait the bounded render interval, then write one
isolated `b"\r"`. A REPL agent's first prompt (`agents.rs::
type_repl_prompt_when_ready`) follows it too, and like the priming types
nothing until Claude's REPL is ready (`intake::priming_may_write`): text
written at spawn is a type-ahead that lands above the banner and is never
submitted.

```rust
pty.write(id, body.as_bytes())?;
thread::sleep(Duration::from_millis(PRIMING_SUBMIT_DELAY_MS));
pty.write(id, b"\r")?;
```

Do not move the second write to a detached task: cancellation between the two
writes must make the submit failure visible to the explicit caller. Tests
must assert the byte sequence and that a failed body write never sends Enter.

User-facing timeout copy is derived from the same duration constant that owns
the polling bound. Never hand-write a second stale duration in the error.

### Plyloft's text into a live composer never starts with `!` or `/`

Measured 2026-10-15 on Claude Code 2.1.300: composer text, typed or
bracket-pasted, whose very first character is `!` runs as a shell command,
even in the read-only profile (no Bash in `--tools`, Bash disallowed,
`--restricted`, `disableSkillShellExecution`). A leading `/` opens the
slash-command menu. A leading space disables both; that was measured on
Claude only. Codex's TUI has the same two prefixes, and whether a leading
space disables them there is unmeasured (Codex may trim leading whitespace).
A positional argv prompt is not affected.

So every message Plyloft composes into a live Claude or Codex session goes
through the guard: `builderInject.ts::composerSafe` (applied inside
`pasteText`/`pasteBodyBytes`, so every `builderStore.writePaste` caller gets
it) and `agents.rs::repl_prompt_payload` for a REPL agent's first prompt when
Plyloft composed it (`prompt_override`). A space goes in front when the text
after any leading whitespace starts with `!` or `/`; the text is never
trimmed and only its start counts. The member's own text is never altered:
their keystrokes (`writeBuilderInput`, tile `onData`) and an agent's
`prompt_template` (a template of `/review` is meant). No caller sends a slash
command on purpose; one that must would write it without `pasteText`,
explicitly. A new injection path must use these helpers or start from fixed
text (the intake priming starts with `Card title:`, the conclude sentinel is
`__CONCLUDE_INTAKE__`).

The space cannot help when the member's own draft already starts with `!`
(bash mode) or `/`: a paste lands after it. So the Builder's prompt-box
matchers (`matchesClaudePromptIdle`, `matchesCodexPromptBox`) treat such a
draft as not idle (`claudeComposerEscaped`, `codexComposerEscaped`, and the
Codex turn-idle gate `matchesCodexTurnIdle`), and Plyloft's message is held
until the draft is cleared or sent. The held-message valve skips while
`BuilderRuntime.composerEscaped` is set and the terminal shows
`draftHoldNotice` instead (under the terminal and in the card's Now
callout). Read only from the input box's first row: the transcript above
it holds echoed `❯ /compact` lines, an empty box reads back as a bare `❯`,
and a later line of a multi-line draft is plain text. A `/` draft opens a
slash menu of ~30 rows below the box, so the escape check gets an 80-row
read (`CLAUDE_ESCAPE_SCAN_ROWS`) and treats menu rows as a `/` draft. A
scan with no composer in view reports null and the last verdict stands —
or escaped, when the member typed since the last readable scan.

### Intake idle: skip Ready intakes regardless of age

`is_idle_for_cancel(now, last_activity_ms, is_ready)` returns false
when `is_ready` is true. Sentinel-concluded intakes that haven't
been applied yet are awaiting the user's conscious action — auto-
cancelling them would discard the user's `dispatchPrompt`. The
sweeper checks `card.intake_status == Ready` per-tick; if a card has
been Ready for hours and the user is on vacation, the intake stays
alive (and the disk cost is just a JSON draft + a dead PTY entry —
the actual claude process exited at conclude time).

### Intake idle uses millis, not seconds — match `started_at` units

`IntakeSession.started_at` and `last_activity_at` are both set in
millis (via `now_millis()` / the PTY reader's `SystemTime::now()`).
The constant `IDLE_INTAKE_TIMEOUT_MS = 15 * 60 * 1000` and the
helper `is_idle_for_cancel` both work in milliseconds. If you ever
add a seconds-based timer, name it explicitly (`*_SECS`) so the
next reader doesn't accidentally mix units.

### "Idle" sweepers measure last activity, not session start (v1.20.2 / v1.20.3)

When the v1.17.0 idle sweeper shipped, the cutoff was `now -
session.started_at > IDLE_INTAKE_TIMEOUT_MS`. That's a hard
session-duration cap, not idle — any active intake older than 15
min got its PTY killed mid-flight (SIGHUP from dropping the master
fd → claude prints "Resume this session: ..." → exit 129 →
`pty://exit` → FE banner "Intake agent exited unexpectedly (code
129)").

The v1.20.2 hotfix introduced `IntakeSession.last_activity_at:
Arc<AtomicI64>`, stamped by the PTY reader thread on every output
byte. That fixed long, actively-streaming conversations, but missed
the case where claude pauses at an interactive permission prompt:
zero output until the user types, sweeper still fires.

The v1.20.3 hotfix completes it. The activity beacon now lives on
`pty::PtySession.activity` and is stamped by **both** the reader
thread (every successful read) and `PtyRegistry::write` (every
successful user-input write) via a shared `stamp_activity` helper.
Intake registers the beacon; other PTYs leave it `None`. Sweeper
sees real engagement in both directions.

**Rules for any future timeout-based reaper of a PTY-bound feature**:
1. Register the activity beacon on `PtySession` (not a side-table
   keyed by id). Pattern is symmetric with the v1.19.0
   `transcript_buf` capture.
2. Both reader and writer paths stamp via the same helper so units
   and ordering match.
3. Pick a generous timeout (60 min for intake) — "idle" should mean
   "the user genuinely abandoned this," not "the user is thinking."
4. Emit a custom `<feature>://swept` Tauri event before tearing the
   PTY down so the FE can render a soft "auto-cancelled" banner
   instead of the generic crash banner.

## v1.18.0 Cycle E3 starter-pack template footguns

### Template ids are forever — adding is additive, renaming breaks

Each `ProjectConfigTemplate.id` (e.g. `"rust-crate"`) is the
durable contract between the FE picker and `apply_template`.
Renaming an id breaks any UI that's cached its value (the FE select
holds the most recently picked id; if your renamed id doesn't match,
the form silently no-ops). Adding new templates is fine. Re-ordering
the `builtin_templates()` Vec is fine. **Don't rename existing ids.**

### Templates stamp `verify_pipeline`, but the script doesn't have to exist

Each template ships with a default like `Script { path: "scripts/test.sh" }`.
The script doesn't need to exist on disk for the template to apply
— the verify pipeline only runs when the user triggers verify on a
card. If the script is missing, the verify step fails with a clear
"spawn failed" message; the user creates the script (or edits the
config to point elsewhere) and re-verifies. Don't gate template
application on script presence — that pulls onboarding into a
chicken-and-egg loop.

### Apply-template is parallel to Detect, not a replacement

The not-onboarded state in `ProjectConfigPanel` shows BOTH the
Detect button AND the template picker. Detect scans the filesystem
deterministically; templates stamp opinionated defaults. Don't fold
them into a single flow that auto-suggests a template based on
detection — that's a separate (deferred) polish increment. Keep the
two paths visibly distinct so users understand they're choosing
between "tell me about my repo" and "give me a starting point."

### `apply_template` returns the config — don't call `get` again (read by E4 doc; restated)
### (E4 footguns continue below)

## v1.19.0 Cycle E4 intake-history footguns

### Capture transcript on apply/cancel, NOT on conclude

The intake PTY emits bytes after the user types `__CONCLUDE_INTAKE__`
— claude writes the draft JSON, then prints an exit banner. Capturing
the buffer at conclude time misses that tail. The FE drives the
apply/cancel timing (after polling the draft); finalizing in
`intake_apply` / `intake_cancel` ensures the transcript carries the
full conversation.

### `IntakeRecord.transcript_path` is relative to `<config_dir>`

Stored as a forward-slash path like
`intake/transcripts/<wsId>/<cardId>/<intake_id>.log`, NOT an absolute
path. This makes the kanban file portable across environments
(different macOS users have different `<config_dir>` values).
Consumers (FE `IntakeHistorySection`, backend `read_transcript`) join
with the live `config_dir` at read time. Don't store the absolute
path — that would break if Atelier is ever moved between users or
the support directory is renamed.

### Schema migration v4 → v5 is a serde-default no-op

`intake_history` is `#[serde(default)]`, so v4 cards parse cleanly
without an explicit migration step. The v4 → v5 arm in `kanban.rs`
exists only to flip `migrated = true` so the file re-encodes with
the new schema_version. Subsequent loads then take the
`KANBAN_SCHEMA_VERSION` arm directly. Don't try to populate
`intake_history` from the existing `dispatch_prompt` — there's no
historical record to reconstruct (started_at, concluded_at,
transcript_path are all unknown for pre-v5 intakes).

### `PtyRegistry::spawn_with_capture` tees, doesn't replace

The capture buffer is in addition to the existing `pty://data` event
emission, not a replacement. The FE xterm still renders bytes via
events as usual. If you ever change spawn_with_capture to skip
events when capture is set, intake's xterm display goes blank —
both paths must run.

### Transcript ANSI stripping happens at WRITE time, not READ time

`finalize_transcript` calls `strip_ansi` before writing the
transcript file. This keeps the on-disk content human-readable
(plain text, no escape codes) and makes `intake_read_transcript` a
trivial fs::read. If you ever change to "store raw, strip on read",
the FE has to handle stripping (or render escape codes literally,
which looks broken). Keep stripping at write time.

### FIFO eviction must delete the transcript file

`KanbanStore::append_intake_history` deletes the evicted entry's
transcript file from disk before saving the kanban update. Without
that, FIFO would silently leak transcripts (kanban references gone,
but `<config_dir>/intake/transcripts/` keeps growing). Always pair
record-eviction with file-deletion.

### v1.20.1: FE-after-backend reload (Bug B repeated)

`intake_apply` and `intake_cancel` both append an `IntakeRecord` to
the card before returning. The FE caller (`CardDetailPanel`'s
`onConcludeIntake` / `onCancelIntake`) then sets `intakeStatus`
via `updateCard`, which writes the FE's in-memory card copy back
to disk via `kanbanSave`. **That copy doesn't know about the
just-appended IntakeRecord, so it overwrites it with the pre-
append state — silently dropping the new history entry.**

Symptom in v1.20.0: transcript file exists on disk, but
`card.intakeHistory: []`. Looks like the append failed; actually
the FE clobbered it.

Fix: force-reload kanban from disk via
`useKanban.getState().loadFromDisk(workspaceId, true)` BEFORE
calling `updateCard` in both handlers. The v1.9.2 fix for the same
pattern (Bug B) is the precedent — read it before adding any
new "backend mutates kanban + FE updates same card" code path.

## v1.20.0 Cycle E5 dashboard footguns

### Force-reload kanban on dashboard mount

The Dashboard tab aggregates `card.shipHistory` / `verifyHistory` /
`intakeHistory` for its display. Backend mutations from the verify
pipeline (`finalize_pass` / `finalize_fail` writes verify_history)
or the ship pipeline (writes ship_history + sets ship_status) might
not yet be reflected in the FE kanban cache when the user switches
to the Dashboard tab. Calling `loadFromDisk(workspaceId, /*force*/
true)` on mount keeps the dashboard truthful even mid-ship. Don't
trust the FE cache here without forcing.

### Module-scoped fallback for empty-cards selector

The kanban selector uses `s.byWorkspace[workspaceId]?.cards ?? EMPTY_CARDS`
where `EMPTY_CARDS` is a module-scoped const. If you replace it with
an inline `?? []`, every render produces a new array reference,
which breaks zustand's reference-equality short-circuit and
cascades re-renders down the entire dashboard subtree. Same pattern
as elsewhere in the codebase — but easy to forget when adding a
new selector path.

### Cost rollup — Claude reports no cost; REPL has no cost data

`AgentRun.totalCostUsd` is populated only for Codex oneshot runs (priced
from their usage). Claude oneshot runs are interactive sessions collected
through their transcript (never `claude -p`), and the transcript carries
no cost — the member's plan pays — so they have `totalCostUsd: null`, as
REPL-mode runs do. The cost rollup filters them out with `if
(r.totalCostUsd == null) continue;`, and History's "Spent" says "Not
reported for Claude plans" (`historyWords::spentWord`). Don't try to
estimate costs for either — there's no source data.

`apply_template` returns the persisted ProjectConfig (including the
freshly-stamped `created_at` / `updated_at`). The FE caller assigns
this directly to its config state instead of an extra
`projectConfigGet` round-trip. New IPC consumers should follow this
pattern: design write commands to return the resulting state when
the round-trip is otherwise needed.

## v1.20.5 shell-integration footguns

### Never use `trap '…' DEBUG` to emit OSC 133 `C`

Bash's `DEBUG` trap fires **on every simple command**, including
each command sourced during shell startup. If any sourced init runs
an eval chain (conda's `eval "$__conda_setup"` is the canonical
case), the trap emits hundreds of `\e]133;C\a` sequences before the
first interactive prompt — xterm drowns and the tile never shows a
prompt. Use `PS0='\e]133;C\a'…` instead: PS0 fires once per typed
interactive command, which is the actual OSC 133 semantic.

```bash
# ❌ floods on every simple command during init
trap '__atelier_emit_c' DEBUG

# ✅ once per typed interactive command
PS0='\e]133;C\a'"${PS0:-}"
```

Caused the v1.20.4 shell-tile startup hang; fixed in v1.20.5. See
`src-tauri/src/commands.rs::SHELL_INTEGRATION_BASH`.

### Gate shell-integration snippets on `$ATELIER_SHELL_INTEGRATION`

The bash/zsh snippets we ship for users to paste into their
dotfiles must wrap their entire body in
`if [[ -n "$ATELIER_SHELL_INTEGRATION" ]]; then … fi`. The env var
is set by `pty.rs::spawn` and `spawn_with_capture` (NOT by
`spawn_collect`, which runs internal verify slash-commands and
shouldn't have OSC 133 bytes in its captured output).

Two reasons:
1. Outside Atelier — when the user opens Terminal.app or runs a
   non-Atelier subprocess like `codex exec` — the snippet should
   be silent. Without the gate, every shell in the user's session
   emits OSC 133 noise that other tools can't parse.
2. Codex's `shell_snapshot` feature captures the user's
   non-interactive shell env and validates each line. The emit
   function definitions trigger
   `Shell snapshot validation failed: ... \x1b]133: command not found`.
   Gating fixes this for free — codex's snapshot never sees the
   functions because the `if` branch doesn't fire.

When you change either snippet, keep the gate. The unit tests
`shell_integration_bash_uses_ps0_and_env_gate` and
`shell_integration_zsh_has_env_gate` in `commands.rs` pin the
invariant.

## v1.21.x codex integration footguns

### Adding a field to a long-lived struct: `#[serde(default)]` is not enough

Phase 3 added `provider: Option<String>` to `RoleStep` with
`#[serde(default, skip_serializing_if = "Option::is_none")]`. The
serde decoration is correct — legacy JSON without the field
deserializes cleanly to `None`, forward-compat preserved. But the
builder shipped a build break anyway: every existing **struct
literal** in the codebase (`RoleStep { role, expects_artifact,
on_reject_jump_to }`) was now missing the new field, and Rust
struct-literal construction requires every field regardless of
serde defaults. The verify gate caught 18 `E0063: missing field
provider` errors in `builtin_templates()` + test fixtures, including
several inside `swarms.rs` test code that `cargo check --lib` had
missed because it doesn't compile test targets.

```rust
// ❌ broken: serde defaults don't help struct literals
RoleStep { role: "scout".into(), expects_artifact: true, on_reject_jump_to: None }
//                                                                                ^ missing `provider`

// ✅ explicit: add the field to every existing literal
RoleStep { role: "scout".into(), expects_artifact: true, on_reject_jump_to: None, provider: None }
```

When adding a field to a struct that's used in builtins, fixtures,
and tests:

1. Grep for `<StructName> {` across the workspace AND inside `#[cfg(test)]` blocks. `cargo check --lib` alone is not sufficient.
2. Run `cargo check --all-targets` or `cargo test --no-run` to compile test code too — that's what the verify gate runs.
3. Either add the field to every literal explicitly (preferred for clarity), or derive `Default` on the struct and switch literals to `..Default::default()`. The former scales worse, but is what every existing `RoleStep` literal in the file already does, so consistency wins.

Caught in v1.21.1 hotfix after Phase 3 shipped through verify-failed
state. The migration test `role_step_loads_without_provider` covered
deserialization correctly but didn't catch the literal-construction
break — schema migration tests do not exercise struct-literal sites.
See `src-tauri/src/swarm_templates.rs` line 143 onward for the
current pattern; `src-tauri/src/swarms.rs:5323-5337` for test fixtures
that needed the same fix.

### Codex default model must be subscription-compatible

CLAUDE.md Hard Rule #1 (no API-key billing) is usually about
SDKs and `OPENAI_API_KEY` env vars, but it has a subtler form: **the
model name itself can betray you**. Phase 3 hardcoded
`DEFAULT_CODEX_MODEL = "gpt-5-codex"` because that's the documented
model id on OpenAI's developer pages. That model is **API-only** —
when codex runs under ChatGPT-account auth and the argv carries
`-m gpt-5-codex`, OpenAI returns HTTP 400:

```
"The 'gpt-5-codex' model is not supported when using Codex
 with a ChatGPT account."
```

The standalone codex tile (Phase 2, v1.20.9) defaulted to `gpt-5.5`
correctly because codex-cli's interactive TUI picks the
subscription-safe model on the user's behalf. Phase 3's
non-interactive argv builder lost that helping hand and shipped the
wrong default.

**Rule:** any codex argv-builder default must be a model that
codex-cli's TUI itself would pick under subscription auth. As of
v1.21.3 that's `gpt-5.5`. When OpenAI ships new models, the test is:

```bash
codex exec --json -m <candidate-model> "say hello"
```

If it returns a clean `turn.completed`, the model is
subscription-supported. If it returns
`{"type":"error","status":400,"error":{...,"message":"not supported when using Codex with a ChatGPT account"}}`,
it's API-only and Hard Rule #1 forbids it as a default. The
`PROVIDER_PRICES` table may still list API-only models for unit-test
fixtures or a future API-key path; just don't default to them.

See `src-tauri/src/agents.rs::DEFAULT_CODEX_MODEL` for the current
value + doc comment explaining the constraint.

### Manual-hotfix bootstrap is external-Terminal-only

Atelier's in-app ship gate (v1.9.0+) is built around the
agent-run lifecycle: a card has runs → verify gate evaluates the
working tree the runs produced → ship gate commits + bumps versions
+ installs. **There is no UI path for a card that has no agent run.**
The "Verify now" button is gated on run history; no run history
means no verify, means no ship.

This bites when the fix is small enough to apply by hand from outside Atelier.
Use the agent/card path when possible. If the bootstrap is genuinely needed,
run `scripts/install-local.sh` synchronously from an external interactive
terminal; never revive the historical detached instructions from Git history.

What does NOT work, and don't try: creating a card with no swarm
template / no agent config, dragging it to In Progress, hoping
the verify button appears. It won't. The UI gates the verify section
on "card has runs."

Caught during v1.21.3 hotfix to the Phase 4 codex default model.

## v1.32.0 dependency-doctor footguns

### Shelling out to a CLI? Resolve it via `doctor::require`, never assume

`SAAS_READINESS.md` principle #3: every feature that shells out to
`git` / `claude` / `codex` / `gh` must fail with a friendly, specific,
install-pointing message — not a raw `ENOENT` or an opaque
`"binary not found in PATH"`. The shared helper is the pattern:

```rust
// Resolves the absolute path, or returns a message safe to show a
// non-technical user verbatim ("GitHub CLI isn't installed … open
// Settings → Shell and click Check again").
let gh = crate::doctor::require("gh")?;
std::process::Command::new(&gh).args([...]).output()?;
```

Two rules:
1. **Resolve before side effects.** `card_ship`'s PR path calls
   `doctor::require("gh")` *before* `git push`, so a missing CLI can't
   strand a half-pushed branch. Check tools at the top of the handler.
2. **One chokepoint per tool when there is one.** Swarm/agent dispatch
   all funnels through `agents::resolve_binary` — that single function
   routes Claude/Codex through `doctor::require`, so every dispatch
   site inherits the friendly error for free. Don't re-resolve
   `shell_env::get().claude_path` ad-hoc at call sites.

`doctor.rs` is the only home for tool-install knowledge (required-ness,
install commands, docs URLs, version floors). `shell_env.rs` stays a
dumb probe — it reports *what's on PATH*, never *what that means*.
Adding a new external tool = add a probe field in `shell_env.rs` AND a
`ToolStatus` arm in `doctor::build_report` + a `require` match arm.

## v1.33.0 kanban-persistence footguns

### Never persist a kanban board as a whole-file overwrite from the frontend

This is the v1.32.x data-loss bug. The frontend held its own copy of a
workspace board and, on every mutation, sent the **entire card list** to a
`kanban_save` command that blindly overwrote the file. A stale copy — one
loaded before a backend write (run-history append, swarm completion, ship,
queue pump) — silently dropped every card not in it. There is no safe
"merge the whole board": you can't tell "the user deleted this card" from
"this copy never knew about it".

The rule: **every kanban write is a single-card, intent-carrying
operation.** `create_card` / `delete_card` / `patch_card` / `set_run_state`
each do a read-modify-write of *one* card against the live `cache` under
the mutex (`KanbanStore::mutate_card`). A card can only vanish via an
explicit `delete_card` naming its id.

```ts
// ❌ removed in v1.33.0 — overwrites the file from a possibly-stale board
await kanbanSave(workspaceId, ws.cards);

// ✅ field-scoped patch; the backend merges only the named fields
await kanbanCardPatch(workspaceId, cardId, { title, notes });
```

This retires the v1.9.x "Bug B" reload-before-write dance and
`refreshThenPatch`: with field-scoped patches there is nothing to clobber.

### `CardPatch` carries only user-editable fields — never a backend-owned one

`CardPatch` (Rust + TS) deliberately cannot name `run_history`,
`verify_status`, `ship_history`, `review_status`, `worktree_path`,
`attachments`, etc. Those are written only by their dedicated backend
paths. If you must change a run-link field (`linked_run_id`,
`linked_swarm_id`, `last_run_status`) use `RunStatePatch` /
`kanban_card_set_run_state`. Keep the split — it is what makes a frontend
patch structurally incapable of reverting backend state.

### Nullable patch fields need three states — use `double_option`

A patch field must distinguish *absent* (leave the field alone) from
*present `null`* (clear it). A plain `Option<T>` collapses both to `None`.
Rust side: `#[serde(default, deserialize_with = "double_option")]` on an
`Option<Option<T>>`. TS side: omit the key to leave untouched, pass `null`
to clear (JSON drops `undefined`, keeps `null`). Test both paths.

### Frontend kanban mutations: optimistic update → granular IPC → reconcile

Update local state immediately, call the granular command, then replace
the card with the server-authoritative one it returns (`reconcileCard`).
On error, resync via `loadFromDisk(wsId, true)` — now a pure read, safe to
call any time. The backend emits `kanban://changed` after every card
mutation; a debounced listener reloads the workspace so a board open in
another view never goes stale.

## v1.63.0 performance & energy footguns

### Never load WebglAddon on warmed-hidden terminals

Browsers cap live WebGL contexts (~16 per page, oldest silently lost
beyond that). The warmed-host pattern keeps up to 8 workspaces' xterms
**mounted** — load the addon everywhere and context churn breaks rendering
in tiles you can't see. The rule (`Terminal.tsx`): WebGL only while the
terminal's workspace is **active** (`workspaceId` prop + primitive
`activeId === workspaceId` selector); dispose on deactivation (xterm falls
back to the DOM renderer, which is always correct); `onContextLoss` →
dispose, no retry until the next activation flip.

```tsx
// ❌ blows the context cap with 8 warmed workspaces × tiles
term.loadAddon(new WebglAddon());

// ✅ active-workspace-only, loss → DOM fallback (Terminal.tsx WebGL effect)
useEffect(() => { if (!termInst || !wsActive) return; /* load + onContextLoss */ }, [termInst, wsActive]);
```

### rAF doesn't fire while the document is hidden — batched writes need a timeout fallback

Window-close *hides* (Hard Rule #5), and WKWebView stops delivering
`requestAnimationFrame` to hidden documents. Any rAF-batched pipeline
(e.g. `xtermBatch.ts`) must arm a `setTimeout` fallback (50ms) alongside
every rAF — first to fire flushes and cancels the other — or scrollback
silently stops ingesting the moment the window is hidden.

### NSActivity tokens must call `endActivity:` explicitly

Dropping the `Retained<AnyObject>` does NOT end the activity — the
assertion leaks until process exit and App Nap stays disabled forever.
`AppNapToken::drop` calls `endActivity:` via `msg_send!` inside
`catch_unwind` — which is also why `[profile.release]` must keep
`panic = "unwind"`. Acquire/release flows through `app_nap::ActivityGate`
(0→1 acquires; the 30s runtime tick, `agents::runtime_tick`, releases after 60s idle with no
Running swarms) — don't add ad-hoc `begin()` callers.

### `pty://data` is coalesced — consumers must stay chunk-boundary-agnostic

Since v1.63.0 one event can carry many PTY reads (≤64KB), and a fast
stream batches on an 8ms window. Anything consuming `pty://data` (or
`agent://output` downstream) must not assume "one event = one read" or
that message boundaries align with chunk boundaries — buffer until a
delimiter, like the NDJSON stream parsers already do. Also: emit order is
final-data-then-exit (the exit thread waits for stream drain); don't
write consumers that depend on racing ahead of the last batch.

### `app.emit` is fire-and-forget — a bounded channel does NOT backpressure the WebView

Caught live in the v1.63.0 Tier-4 walk: `yes` in a shell tile froze the
whole UI. The reader→emitter `sync_channel` bounds *Rust-side* memory,
but `app.emit` returns immediately — nothing slows the producer down on
behalf of the WebView, whose main thread must JSON-parse every payload
and feed xterm. Coalescing made delivery *more* efficient, so the flood
got worse, not better. The fix is `EmitPacer` in `pty.rs`: cap emitted
throughput (256KB/100ms ≈ 2.5MB/s); when exceeded the emitter sleeps →
channel fills → reader blocks → PTY buffer fills → the child itself
throttles. Rule: any high-frequency Rust→WebView event stream needs an
explicit rate cap — the IPC bridge gives you none.

## v1.64.0 UX-revamp step-0 footguns

### Never remove a variant from a persisted serde enum — legacy-map it at load

`ThemePref::NeonTokyo`/`Synthwave` were retired in v1.64.0 but the enum
variants STAY. `SettingsStore::new` treats any parse error as a corrupt
file: it moves settings.json aside and falls back to defaults — so a
removed variant means one old `"theme": "synthwave"` string silently
resets the user's ENTIRE settings file. The pattern: keep the variant
deserializable, fold it in a `normalize()` called from `load()` AND
`replace()` (a stale frontend can echo old values back), and write a
Tier-2 test that loads an old file through the real store and asserts
both the mapping and that unrelated fields survived
(`v1_64_0_retired_themes_fold_to_dark_plus_accent`). The same rule
applies to every persisted enum: PaneKind, ReloadStrategy, lifecycle
fields.

### xterm theming lives in `src/lib/xtermTheme.ts` — never re-inline theme objects

Pre-1.64 there were three drifting copies (Terminal, IntakeConversation,
AgentRunView) and two of them silently rendered Void as light. Any new
xterm surface imports `xtermThemeFor(theme, accent)`. The background
hexes must stay in sync with the per-theme `--term-bg` in App.css (the
recessed-canvas contract), and `ACCENT_CURSOR` with the `[data-accent]`
hexes. Theme/accent changes must be in the live-react effect deps
(`[theme, accent]`) — the create-effect alone only themes the first
mount.

### New type sizes use the `--text-*` tokens; don't mass-replace old px

The v1.64.0 type tokens (`--text-2xs` … `--text-surface-lg`) are for NEW
surfaces and opportunistic adoption when a rule is already being edited.
A bulk px→token sweep of the ~9,500-line App.css is all risk and no
user-visible payoff — don't do it as a side quest.

## Agent collaboration Phase 4 reviewer footguns

### A read-only reviewer must keep its artifact outside the reviewed tree

A model cannot both be filesystem-read-only and write
`<worktree>/.atelier/.../artifact.json`. Independent reviewers return their
artifact in the provider's final message; the Tauri backend stores it under
the app config directory. The pinned Git worktree contains only the reviewed
commit.

```text
reviewed repo: detached worktree at exact SHA, must remain clean
artifact:     <config>/reviews/state.json, Tauri atomic writer
```

Do not reuse the swarm artifact-file contract for a read-only session.

### Provider flags are not capability evidence

`--sandbox read-only` and `--permission-mode plan` are candidate harnesses,
not proofs. Reviewer eligibility requires the bounded behavioral fixture:
observed sentinel write attempt + explicit denial + absent sentinel + clean
Git tree. Cache the result by canonical executable and exact version; a CLI
update or shell-path change invalidates it. `prompt-only` is visible but never
reviewer-eligible.

### Dirty source and revision drift are separate signals

The review pins the card branch's committed HEAD. Uncommitted source edits
are excluded and listed; they are never auto-committed by review. After the
run, recompute the branch SHA whenever the artifact is read. A moved branch
makes the historical review stale even though its detached tree was clean.

### Capability probes must require structured tool evidence

A provider's final text may repeat tool names, commands, and denial language
without having emitted a tool request. Do not classify that prose as an
observed attempt. Accept a structured `tool_use` / `command_execution` event,
or the narrow Codex fallback where its final event carries the exact OS
denial and sentinel while the independently checked tree stayed clean.

Claude 2.1.219 made this distinction concrete: `plan` mode explains that it
will not attempt a write. The current harness uses `dontAsk`, exposes Bash,
and permission-allows only read/search tools. The real reviewer receives a
Tauri-captured bounded Git diff and has no Bash permission; never replace
that boundary with a shell prefix allowlist.

Version probes likewise parse both stdout and stderr. CLI wrappers can emit a
non-fatal diagnostic on one stream and the version on the other; a parsed
semver is stronger evidence than the wrapper process status alone. Launch
every resolved version command with the same cached effective PATH that found
it: npm wrappers commonly use `#!/usr/bin/env node`, so resolving the wrapper
path while leaving the GUI process PATH unchanged still fails at the shebang.

## Agent collaboration Phase 5 discussion footguns

### A strict boundary failure belongs to the leg that produced it

Cross-review JSON can satisfy its envelope schema but still fail the next
mechanical boundary (for example, one disagreement exceeds the durable
ledger-entry byte cap). Do not leave the discussion globally `running` or
relax the ledger validator. Reject that exact completed leg back to `failed`,
preserve its artifact and attempt history, and let one-click retry replay only
that leg plus still-incomplete downstream dependencies.

```text
analysis A1 ✓  analysis B1 ✓  cross A1 oversized  cross B1 ✓
retry → cross A2 only → synthesis 1
```

Provider prompts state the budget, but Tauri's validator is the authority.
Tune prompts after observed failures; never make model compliance a validity
assumption.

### Pause state is a projection of all five leg records

There is no singular `pausedProvider`. Claude and Codex can both be
unavailable in different incomplete legs. Derive the discussion status and
blocked-provider list from every leg's typed quota/auth evidence each time the
record is read. Resume must skip every completed leg; fake-provider counters
pin this no-replay contract.

### Synthesis prose is not disagreement coverage

The durable ledger is installed mechanically before synthesis. A discussion
may become completed only when the structured synthesis artifact resolves or
explicitly leaves unresolved every ledger ID exactly once. Never infer
coverage from answer prose, and never allow the synthesizer to merge, rename,
truncate, omit, or invent IDs.

### Live Knowledge is outside the sealed independence digest

Initial analyses share a digest over the problem, pinned revision, and
mechanical context. Knowledge is fetched live through each provider's
read-only ephemeral Ply MCP configuration, so retrieval timing/results are
recorded as policy but are not claimed to be byte-identical. Do not silently
add live MCP output to the sealed digest or persist repository `.mcp.json`
files in an attempt to freeze it.

## Agent collaboration Phase 6 generation footguns *(retired)*

GH #104 (ADR 0005) retired the post-ship lesson proposal: `memory/proposals`,
its generation, its IPC and its UI are gone, and existing files are left on disk
unread. Two rules it paid for survive it and apply to the Challenger's
improvement proposal (`src-tauri/src/proposals.rs`) in their own form:

### An unasked-for suggestion is dropped in silence, never retried

A suggestion nobody asked for must not cost anyone a second thought when it
cannot be produced. The improvement-proposal pass has no retry loop, raises no
toast, writes nothing on the card, and never blocks Ship: no provider, a
timeout, an unparsable answer and a diff that does not apply all end at one log
line. The card is still recorded as having had its pass, so a failure cannot
become an unbounded series of them.

### A model proposes content; Ply decides what may be written

The pass may name only files under the repository's `.claude/skills/`, the Codex
`.agents/skills/`, and the root `AGENTS.md` / `CLAUDE.md`. Every path the diff
writes is checked, not only the one it names — a second file smuggled into the
same patch behind an allowed header is how an allow-list is defeated — and the
diff must apply cleanly to the tree it will be published from (`git apply
--check`, read-only) before it is stored at all. Publishing then goes through
the shared channel's **existing** entry points; a proposal never gets a write
path of its own.

## Installed diagnostic receipt footguns

### A typed frontend claim is still not backend evidence

An installed observer may submit only bounded enum/opaque-id facts. Reject
unknown authority fields, validate the exact check-id set and caps, and require
supporting observations for every claimed `passed` check before recomputing
the overall result. A frontend-supplied green status, version, fingerprint,
timestamp, report id, or destination path is never authoritative.

```text
typed observations → backend validation → backend provenance/status → atomic JSON
all-pass + no facts → reject, never a green receipt
```

### GUI provenance stays native; parity makes duplication explicit

The signed GUI must not execute a shell fingerprint helper. Keep its bundle
walk native and off the UI thread; keep the rare external-Terminal installer's
shell implementation. One mandatory adversarial test runs both against the
same `.app` fixture and requires identical manifest bytes and SHA-256 digest.
Any manifest-contract change updates both sides in one commit or fails PPVP.

### An installed observer measures; it never prepares or drives

A diagnostic mounted inside the real app may subscribe to stable store/DOM
facts and call narrow read-only authority IPC. It must not synthesize input,
mutate a product store, mount/resize/write a terminal, or start paid work.
Real product controls or an external disposable fixture prepare the scenario.

```text
real user/product transition → passive pre/post samples → typed report
observer click/dispatchEvent/store mutation → forbidden false evidence
```

Retain the worst fact for a claim. A later safe render or keypress must never
erase an earlier duplicate action, keyboard Ship, remount, or hidden terminal.
Observation caps fail unresolved checks closed. Runtime smoke must mount and
unmount any observer component at least once so a diagnostic selector/render
loop cannot ship merely because the hidden command stayed unopened.

Missing authority is not a value. If the store-side state attribute or a
read-only registry checkpoint is unavailable, retain `null`/a typed authority
failure; never substitute rendered DOM or reinterpret the attempt as
`not_observed`. Pair asynchronous pre/post samples by their opaque transition
id, not by neighboring array positions—two checkpoints can overlap in one
render tick. Diagnostic caps preserve evidence: frontend reducers bound
reasons, backend writers deduplicate/truncate again, and a cap-reached reason
keeps a reserved final slot so the worst session still produces a receipt.

### A continuity check must be falsifiable

Default values cannot prove preservation. A scroll-continuity pass requires a
measurable pre/post pair, an explicit xterm scroll callback, real scrollback,
and a pre-transition viewport above the bottom. Row zero, a never-fired hook,
or hidden zero-size hosts are `not_observed`, never green evidence.

Persisted observation fields that distinguish “zero” from “never observed”
use serde defaults so legacy reports remain readable, plus a Tier-2
legacy/default/current round-trip test. The frontend and backend enforce the
same pass predicate.

## Shared semantic contracts across Rust and TypeScript

### Duplicate implementations consume one fixture, not matching prose

When the same product predicate must exist in Rust and TypeScript, keep its
case matrix in one checked-in JSON fixture. Rust loads it with `include_str!`;
TypeScript imports the same file. Both suites must cover every relevant enum
branch and assert the exact decision and reason.

```text
one fixture with owner-approved expectations
  -> Rust projection test
  -> TypeScript projection test
```

The shared file prevents mechanical drift, but it does not make an expected
value correct by itself. Ambiguous rows are product decisions and must be
recorded beside the contract before both implementations canonize them.

## 1.176.0 CLI repair footguns

### A health question has three answers; "unknown" never blocks

"Does this CLI start?" is *starts*, *fails* or *unknown*. A `--version` that
times out, a folder that can't be read, a probe that wasn't run: all unknown.
Only a certain failure (a missing file, a signal, a wrong architecture, a
refused spawn) offers Repair, blocks a start or says "not starting". Never
turn a timeout into a failure: a slow machine would then show a healthy tool
as broken (`cli_health`, `cli_fresh`, R3).

### An outcome is judged on evidence, not on the exit code

An installer or updater that exits 0 can have changed nothing (R0: Claude's
read-only launcher folder). Judge an update on the version before and after,
compared as numbers, and an install on the tool starting; keep the cause and
the last lines on disk (`setup_outcome`, `setup_last_runs.json`). A run the
person stopped is never recorded as a failure, and it never counts as the
day's try.

### A typed error crosses IPC as a prefix, and the window reads its shape

A refusal the window must act on (Repair, a re-look) is a stable prefix on the
error string (`cli_fresh::UNAVAILABLE_PREFIX`, read by `lib/cliUnavailable.ts`;
`pty_tile_id::PTY_ID_IN_USE`), never a sentence the UI matches by wording.
Anything not typed stays a plain error. Boundaries accept `null`/missing
fields from an older or partial answer and fall back to "unknown".

### A destructive step runs only for the ids the person agreed to

Repair's steps are a closed list on the Rust side; a step's id hashes what it
acts on, and a step that writes and wasn't on the agreed list pauses and asks
again. Removals are one `remove_file` each, on paths re-checked on disk at the
moment (inside the home, never `~/.claude`, `~/.codex` or a sign-in file), and
a password is only ever typed by the person in the sheet's own terminal.
