# PPVP — Post-Production Verification Protocol

After every feature lands (and before declaring it "done" in `STATUS.md` or bumping the version), run this protocol. It exists because Atelier has no JavaScript test framework or CI — verification is the safety net.

## Scope and repeat checks

Documentation-only and copy-only edits use focused inspection; they do not
require this application build suite. Executable/configuration changes receive
checks appropriate to their behavior, and every application feature retains
this protocol plus applicable schema, PTY, and UI evidence. Size or reversibility
does not waive a required feature check.

After checks pass, repeat or broaden them only when subsequent edits, failures,
or unresolved concerns invalidate the evidence. Repair failures caused by the
current change. Report unrelated pre-existing failures without silently expanding
the task or reverting another person's work. A required gate that remains red
still prevents feature acceptance; report the limitation accurately.

### Plans of several cards: checks in blocks (owner, 2026-10-21)

The goal is not fewer checks but less time spent on them. In a plan of several
cards (a feature built card by card):

- **Every card:** Builder, Challenger, and the focused checks it touches (tsc,
  its tests, ux-check, the pure contracts). The checks a hard rule ties to the
  change stay at the card that makes it: a PTY change's Max-auth tile and
  exit/orphan check, a new persisted field's migration test (Tier 2).
- **Every block** — three or four cards, or at most half a day of work, closed
  at a natural milestone of the plan: one full gate (`./scripts/ppvp.sh` and
  `npx vitest run`), one Plyloft Test build per platform, one Tier 4 walk on
  the Mac and one in the Windows VM, with a single step list split by card so
  every finding names its card, and **one PR**.
- **A heavy phase** — one that later cards build on: PTYs and agents,
  persisted state, or a shared engine — gets its own gate and walks before the
  next cards start, sized to its complexity. The plan names these phases at
  its start; the owner may change them.
- **Owner-only steps** (trust prompts, VoiceOver/Narrator, a real AI's
  permission question) are grouped into one session while the owner is there.

A single feature outside such a plan keeps the per-feature gate and walks.

## TL;DR

```
./scripts/ppvp.sh
```

The normal no-dev-server run must report **9/9**. That covers Tier 1,
repository-owned TypeScript and shell pure-contract tests, the UX language
check, and Tier 1.5
(runtime React-mount smoke). Tiers 2–4 add schema, feature-specific helper,
and installed UI evidence when applicable.

---

## Tier 1 — Automated build/type/unit gate (must always pass)

Run by `scripts/ppvp.sh`:

1. **Sidecar preparation + `cargo check --workspace --all-targets`** — Builds the ignored target-suffixed `ply-mcp` input first, then checks every Rust crate and target, including the Tauri host and bundled sidecar.
2. **`cargo test --workspace --lib`** — All workspace library tests pass. The pre-workspace Phase 1A baseline was **737 Tauri library tests**; extraction may redistribute tests between crates but the workspace total must not shrink. New backend code MUST come with new tests if it adds non-trivial logic; the count should grow, not shrink.
   **Bundled Plyloft skills (owner check)** runs right after it as its own
   step: `ply_skills::tests::the_bundled_skills_pass_the_owner_check` and its
   two neighbours validate every `src-tauri/resources/ply-skills/*/`
   (frontmatter `name` = directory, `description` present with a trigger
   sentence starting "Use " and ≤ 1024 characters, each skill ≤ 16 KB, no
   Plyloft-internal terms, no absolute paths). The three tests are named
   `--exact` and the step fails unless all three ran. The owner and the
   review habit are in ADR 0005's amendments.
3. **`npx tsc --noEmit`** — Strict TypeScript pass.
4. **Repository pure-contract tests** — Every repository-owned
   `src/lib/*.test.ts` module runs under
   `node --experimental-strip-types`. Imports use explicit `.ts` extensions
   so the same deterministic command works without an implicit `tsx` runner.
   Reviewed shell fixture contracts that mutate only disposable temporary
   roots (`scripts/test-prepare-p3-*.sh`, by glob) run in this same step,
   with the team-init and installer harnesses. The behavioural UI tests
   (`src/**/*.test.tsx`: components rendered under jsdom by vitest against a
   stubbed Tauri layer; GH #172, `docs/PATTERNS.md` "Behavioural UI tests")
   run in this step too, through `scripts/test-ui.sh`, so the step count is
   unchanged. The step is
   `scripts/ppvp-pure-contracts.sh`: every command in it fails the step, and
   `scripts/test-ppvp-pure-contracts.sh` proves a red fixture — or a red UI
   suite — turns it red.
5. **UX language check** (`scripts/ux-check.mjs`, after its own tests in
   `scripts/ux-check.test.mjs`; ADR 0004, `docs/ux-language/PATTERNS.md` §9).
   Strict on the files in `docs/ux-language/migrated.json` and on the `ux-`
   layer in `src/components/ux/`: an off-catalogue `className`, a raw
   `<button>`/`<input>`/`<select>`, a colour literal or a non-token spacing
   fails. For the rest of the app it prints three counts — button families,
   panel families, colour literals — and fails only if one rose above
   `docs/ux-language/ux-baseline.json`. When a count falls, ratchet it down
   with `node scripts/ux-check.mjs --write-baseline` in the same change.
   It also counts, per file, the developer words in visible copy and the raw
   errors shown inline (UX P-D1; `docs/ux-language/PATTERNS.md` §9): a
   file's count may fall, or move to another file while the total does not
   rise, and either is recorded with `--write-baseline` in the same change
   (the step fails until it is); `--write-baseline` refuses to record a
   rise. Each `// ux-allow: <reason>` marker is counted per file too: a new
   one fails until written, so it shows in the baseline's diff. `--list`
   prints every hit and marker. Every `.tsx` under `src/components` is
   registered in `migrated.json` (VC-6, 1.174.0): in `files`, in `pending`
   with its count of problems (which may only go down), or in the closed
   `legacy` list; a new unregistered component fails the step, which says
   where to add it. The step prints its output on a pass too.
6. **`npm run build`** — TypeScript + Vite production build is clean. No type errors. Markdown chunk should still split (`markdown-*.js` separate from main bundle); if it doesn't, the lazy-import got broken. The same step runs `scripts/app-tester/check-no-release.sh --dist dist`: the app tester's dev-only test bridge is off in every release path and absent from the built frontend ([app tester design](app-tester/DESIGN.md)).
7. **Dev-server health probe** — If `tauri dev` is running, every new module file should return HTTP 200 from `http://localhost:1420/`. The script checks the canonical paths.
8. **Version sync** — `package.json` / `Cargo.toml` / `tauri.conf.json` all agree.

If any Tier 1 step fails, the feature is **not** ready. Diagnose and fix failures
caused by the change; report unrelated failures. Do not revert user or other-agent
work. Continue independent authorized work, but do not claim feature acceptance
until the required gate passes.

---

## Tier 1.5 — Runtime React-mount smoke (catches loops Tier 1 misses)

**Why this exists:** during v0.5.0 development, all Tier 1 gates passed cleanly while the app was infinite-looping at startup. The bug was zustand selectors returning fresh `[]` literals — a class of bug that only manifests when React actually mounts and runs the commit phase. Build-and-type checks can't see it. So Tier 1.5 boots the built bundle in headless system Chrome and watches for render-loop errors.

**What it does:**
1. Boots `vite preview` against the `dist/` built in Tier 1 (port 4173).
2. Launches headless system Chrome via `puppeteer-core` (no Chromium download — uses `/Applications/Google Chrome.app/...`).
3. Stubs `window.__TAURI_INTERNALS__.invoke` to return synthetic shapes for `shell_env_info`, `workspace_list` (one synthetic workspace), `settings_get`, `agent_list`, `agent_run_list`, `fs_list_dir`, etc. — so the page mounts without `invoke()` rejections shadowing the real React failures.
4. Holds the page for 3 seconds.
5. Fails on any matched error: `Maximum update depth`, `Too many re-renders`, `Cannot update during render`, `Invalid hook call`, `Rendered more hooks than`, plus minified production codes (`Minified React error #1\d{2}`, with explicit `#(185|300|301|321)` for the render-loop family).
6. Getting started (TU-4): tags every warmed host on the page (the Terminals
   stack and host, the card host, Code's sticky host and its `.cm-editor`, any
   `.xterm`), then opens the Guide panel from Help › Getting started, presses
   Start (the coach-mark on the Board row), Pause, Resume and ⋯ › End the
   tour, and fails (`Tutorial panel failed at …`) if any tagged node was
   unmounted, if the panel or coach-mark is modal, or if the coach-mark took
   focus. Proved red once by keying the shell on the panel's state.
7. Skips gracefully when Chrome or `puppeteer-core` is missing — exit code 2 = infrastructure skip, exit code 1 = real failure.

**Dependency:** `puppeteer-core` is a devDependency (no Chromium download — uses system Chrome). If a teammate runs PPVP on a machine without it, the step skips with a `npm install -D puppeteer-core` hint instead of failing.

**Synthetic stub fixture is part of the test surface.** When a new code path mounts components that depend on a Tauri response that isn't yet stubbed, add it to `scripts/runtime-smoke.mjs` `evaluateOnNewDocument` block. Empty-state mounts don't exercise per-row code paths — the stub returns at least one workspace specifically so `WorkspaceRow` mounts and runs its selectors.

**Verification of the gate itself:** during v0.5.0 development, the bug was deliberately reintroduced after the fix (replacing `EMPTY_TILES` with `[]`) and the smoke was confirmed to detect it (`Runtime smoke ✗ — 1 React error(s): Minified React error #185`, exit 1). When tightening the smoke, do the same — break the code, confirm the smoke fails, restore.

If Tier 1.5 fails, **do not** proceed to Tier 2+ until you've reproduced the smoke locally and identified the offending component. See `docs/PATTERNS.md` for the most likely root causes.

---

## Tier 2 — Schema migration (when adding/changing persisted JSON)

Triggered when you touch any of:
- `AgentConfig` / `AgentRun` (in `src-tauri/src/agents.rs`)
- `Settings` and its sub-structs (in `src-tauri/src/settings.rs`)
- `Workspace` / `WorkspacesFile` (in `src-tauri/src/workspace.rs`)
- `FilesOrderStore` schema

Hard rule: **schema additions MUST be backward-compatible** via `#[serde(default)]` or `#[serde(default = "fn")]`. Old JSON written under v0.3.0 must still load under v0.4.0+ without error.

Verify with a one-off Rust binary that:
1. Constructs the JSON shape that the *previous version* would have written (omit the new fields entirely).
2. `serde_json::from_str::<NewStruct>(prior_json)` — must succeed.
3. Asserts that the new fields hold their `Default` values after parsing.
4. Round-trips a *new-version* JSON with the new fields populated; assert preservation.

Template lives in [examples below](#schema-migration-test-template). Save the test under `src-tauri/src/<file>.rs`'s `#[cfg(test)] mod tests` so it runs every cargo test.

---

## Tier 3 — Helper / pure-function tests (when adding any pure function)

Atelier has no JavaScript test framework. For pure helpers (no DOM, no Tauri
APIs), add a self-contained `src/lib/<name>.test.ts` module that:
1. Imports the helper with an explicit `.ts` extension.
2. Asserts behavior across edge cases.
3. Exits non-zero on failure under
   `node --experimental-strip-types src/lib/<name>.test.ts`.

The PPVP runs every matching TypeScript module plus the explicitly reviewed
shell fixture contracts automatically; a failure cannot become untracked gate
debt.

Historical examples shipped in v0.4.0 (one-off, not in tree):
- `fuzzyScore` — subsequence scoring with bonuses (10 cases)
- `parseTags` — comma-input → trim → dedupe (9 cases)
- `renderMarkdown` + sanitization — output shape + XSS-rejection (14 cases)

For Rust pure functions, add tests directly to the module's `#[cfg(test)] mod tests` block (e.g. `commands.rs` or `agents.rs`) and they get picked up by Tier 1. (The old examples here — `cron_next_fires`, `glob_match`, `parse_cron`, `matches_glob` — were retired with scheduled and triggered agents, GH #171.)

---

## Tier 4 — Manual UI walkthrough (only humans / vision-equipped agents)

### Tier 4 by the app tester (SL-0)

A Tier 4 walk can be run by the `app-walk` skill: the `app-tester` agent drives
"Plyloft Test" (a debug build with the dev-only test bridge, on its own
profile `com.mbadv.ply.test`) and records every step as **passato**,
**fallito**, **passato (solo visivo)** or **non verificabile**, with evidence,
in `~/ply-build/app-walks/<walk>/report.md`
([design](app-tester/DESIGN.md)).

- A report whose outcome is `passato` (no *fallito*, not `invalid`) counts as
  the feature's Tier 4 walk. The owner reviews only the *solo visivo* and *non
  verificabile* steps, and records the sign-off with the report path in the
  card or STATUS entry.
- `invalid` (a claude/codex process started without the owner's ok for that
  walk) or any *fallito* is not a pass.
- Walks that need real agent tiles run only with the owner's per-walk ok.
- The PTY hygiene item below is covered when the walk quits with
  `app_quit` (`via: cmd+q` or `menu`): it lists orphan children, and an
  orphan fails the step.
- Team behaviour can be walked without a second computer: a **team walk** drives
  the owner and a member at once on the Mac, in two instances with their own
  profiles and GitHub accounts ([design](app-tester/DESIGN.md), "Team walks").
  `app_launch` refuses an instance that doesn't answer as its person. The report
  says who did each step. An orphan of either instance fails it, and one never
  quit makes it `incompleto`, which is not a pass. The app's own read-only status
  checks are listed in the report and don't make it `invalid`; anything else does.
  The audit samples, so a process that comes and goes between two looks isn't seen.
- The same steps run with no agent: `scripts/app-tester/team-walk/run.mjs`, with
  the same checks and report, recording each step's duration. It counts as the
  Tier 4 walk of what it covers, on the same terms, and only when its outcome is
  `passato`: `runner-report.md` alone (a dead MCP, a signal) has no outcome and
  isn't a pass. Its default mode proves that the member's Settings re-reads the
  project; only `--unattended` measures how long the board takes to follow on its
  own. `--membership` covers U17, U14, removing the member and their way back; on a
  build without the dev plan's way past the seat it stops before Remove and is
  `fallito`, not a pass. It doesn't exercise server seats
  ([design](app-tester/DESIGN.md)). Afterwards `cleanup.mjs`, a dry run unless `--apply`; `--quit-only` closes
  the two instances and leaves the rest as evidence. A feature's team behaviour
  beyond these steps still needs a team walk of its own.
- Windows entries can be walked the same way in the Parallels Windows VM
  (`target: windows`; the report names the machine). There `via: cmd+q` is
  Ctrl+Shift+Q, and `win_read processes` adds the orphan check for
  claude/codex/ply-mcp across the VM session. Step 6's check also runs in
  `release-windows.yml` on the release `atelier.exe`.


A code-only check cannot tell you whether the feature *feels* right or even renders. Run `npm run tauri dev` and exercise the feature in the live window:

### Per-feature template

For each new feature, before marking it "done":

1. **Happy path** — exercise the primary flow. Click the button, type the input, observe the output.
2. **Empty / loading state** — what shows when there are no agents / no runs / no files / claude binary missing? It should never be a blank box; some explanatory text is required.
3. **Error path** — force the failure mode (deny permission, invalid input, missing dependency). Verify a toast or inline error appears with a useful message.
4. **Keyboard accessibility** — Esc closes modals; Enter submits the obvious primary action; arrow keys navigate lists where relevant.
5. **Theme switching** — toggle System / Light / Dark in Settings; the new UI must not break under either.
6. **Window-state edge cases** — close-via-red-x then re-open via dock click; Cmd-Q then relaunch (state should restore).
7. **PTY hygiene** — for installed Ply, arm
   `./scripts/check-ply-cmdq-cleanup.sh` in an external terminal before
   Cmd-Q. It snapshots the installed app's complete descendant tree, including
   provider commands typed manually in a Ply tile, then requires every armed
   PID to exit inside its bound. Start no new Ply child after arming. A bare
   `pgrep claude` is advisory because unrelated external sessions may exist.
   If a feature spawned PTYs, this is non-negotiable per AGENTS.md hard
   rule #4.

### Every release: Tour anchors (D11)

The release walk includes **Tour anchors** (Getting started,
[TUTORIAL_SPEC](tutorial/TUTORIAL_SPEC.md) §4.3, §11, §12.3), Mac and then
the Windows VM: the owner on the release build, or the app-tester
(`app-walk` skill) on *Plyloft Test* built from the release commit (the
release build has no test bridge):

1. **Help › Take a 1-minute tour** from start to end (**Next**, **Done** on
   the last): each of its marks sits on its control (the ring on the control,
   the arrow touching it). Only a control that is not on screen (Ship in a
   batch with nothing ready to ship) shows its words docked where the Guide
   panel sits; when it ends, the page is back where it started.
2. The base chapter and each optional chapter once (Help › Getting started;
   the Team chapter on a team account): on each step, its coach-mark (and
   **Show me**) lands on its `data-ply-tour` anchor (the list is
   `TOUR_ANCHORS` in `src/lib/tutorial/manifest.ts`).
3. A step whose control isn't on screen shows **Take me there**; after it,
   the coach-mark must find its control.

A coach-mark that falls back to the panel's text after **Take me there**, or a
`tour anchor missing: <id>` line in the app's log, fails the walk: fix the
anchor or the step before releasing. The coverage test proves each anchor is
rendered in tests; only this walk proves it is on screen.

Evidence for the app-tester: the control a coach-mark is on carries its text
as its description (`aria-describedby`, in `ui_snapshot`); `app_state`'s
`log` has no `tour anchor missing:` line at the end; the ring and the arrow
on the control are a screenshot (*passato (solo visivo)*). A step whose
control appears only after a build (Finish and check, Try it, Ship it) needs
real tiles on the walk's sandbox repo, only when the owner allows them;
otherwise check the coach-marks that are reachable, **Skip this step** on the
rest and mark those *non verificabile*.

### v0.4.0 feature-specific checklist

- **Cmd-K palette**: opens with Cmd-K, fuzzy-filters as you type, Enter dispatches, Esc closes, focus restores. Suppressed when a ConfirmDialog is open.
- *(Retired, GH #171: the AgentForm cron preview, chain picker and glob test, the AgentsPanel tag filter and its recent-runs ⟳ — Settings › Agents is gone, and scheduled and triggered agents no longer run.)*
- **Requeue**: Run an agent to completion → click ⟳ Requeue in the AgentRunView header → new run starts.
- **Notifications**: Settings → Behavior → "Send test notification" → macOS Notification Center shows it (first time triggers permission prompt). Then trigger an agent run with main window unfocused (Cmd-Tab away first) → notification fires with `<status> · <duration>`. Suppressed if window focused + manual trigger.
- *(Retired, GH #171: agent export/import went with Settings › Agents.)*
- **Workspace dashboard**: Close all editor tabs → see WorkspaceDashboard with cwd, agents (with badges), live runs (if any), recent runs, localhost ports. Click a port chip → BrowserPane opens in localhost mode.
- **Markdown preview**: Open a `.md` file → click "Preview" in statusbar → rendered HTML. Click "Edit" → CodeMirror back. Edit content → toggle preview again → updated HTML.

### What you can never verify in code review alone

- Visual layout / spacing / theming under both light and dark
- Animation / transition smoothness
- Native notification appearance (title length, body wrapping, icon)
- Keyboard focus actually moving between elements as expected
- Whether xterm renders correctly in resizable splits
- Whether modals stack correctly (e.g., AgentForm above ConfirmDialog)

---

## Schema-migration test template

Save this pattern in the relevant module's `#[cfg(test)] mod tests`:

```rust
#[test]
fn old_json_loads_with_new_field_defaults() {
    // What the v0.X.0 writer produced — no `new_field` in the JSON.
    let prior_json = r#"{
        "schemaVersion": 1,
        "id": "abc",
        ...existing fields only...
    }"#;
    let parsed: AgentConfig = serde_json::from_str(prior_json).expect("must parse");
    assert!(parsed.new_field == Default::default()); // or specific default
    // Old fields preserved
    assert_eq!(parsed.id, "abc");
}

#[test]
fn new_json_preserves_explicit_field() {
    let new_json = r#"{ ..., "newField": "value" }"#;
    let parsed: AgentConfig = serde_json::from_str(new_json).expect("must parse");
    assert_eq!(parsed.new_field, "value");
}
```

---

## When PPVP itself fails

If `cargo test` regresses but you don't see why:
1. Inspect the scoped `git diff` and compare with the pre-change baseline. Preserve unrelated user edits.
2. Check `docs/STATUS.md` for scope boundaries. Repair task-caused regressions within scope; ask before expanding scope and never revert another contributor's changes.
3. The PTY/auth path (`pty.rs::spawn`, `agents.rs::start_run`) is the highest-risk surface; if test failure is downstream of one of those, **stop and verify Max-plan auth still works** before doing anything else (`npm run tauri dev`, spawn a claude pane, confirm no API-key prompt).

---

## What this protocol does NOT cover

- Actual UI rendering correctness (Tier 4 humans only)
- macOS notification permissions (manual: Settings → Behavior → "Send test notification")
- Network/external dependencies (no real claude API is called by tests)
- Performance regressions (no benchmarks in tree)
- Cross-version migration of `<project>/.atelier/agents/` JSON written by another machine — covered by the Tier 2 backward-compat rule but not exercised across machines

---

## Before bumping the version

When you bump 0.4.0 → 0.5.0 (or any minor):
1. PPVP must pass Tier 1 + **Tier 1.5** + Tier 2 + Tier 3 + relevant Tier 4 features, and the release walk's **Tour anchors** (Tier 4 above).
2. Append a `## What ships in v0.X.0` section to `STATUS.md` above the prior version's section. If any post-shipping fixes were needed (a bug that slipped past the per-phase PPVP), document each one in a `### Post-shipping fixes` sub-section: what shipped, root cause, fix, and the gate or rule that now prevents the next instance.
3. Update `ARCHITECTURE.md` file map for any new files.
4. Bump version in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` — all three must agree.
5. Re-run `./scripts/ppvp.sh` after the bump to confirm nothing was missed (including the new pass-count from the unit-test addendum).

---

## Tier 4 — worktree feature (v1.10.x / v1.11.x)

Mandatory walkthrough whenever any code under `src-tauri/src/worktrees.rs`,
the `kanban_card_advance_to_in_progress` IPC, the `worktree_*` IPCs,
the ship-pipeline squash-merge path, or the `WorktreesPanel` /
`CardWorktreeSection` FE components changes.

Run against the installed `/Applications/Plyloft.app` (not `tauri dev`).
Each step's verification is in italics.

### 1. Smoke

Launch Ply. *The title bar reads `Ply`. A claude tile spawns
without an API-key prompt (Hard Rule #1 still holds). The "Worktrees"
tab is visible in the right-tabs strip.*

### 2. Card → InProgress lifecycle

Create a throwaway card titled `Worktree smoke test`. Drag Todo →
InProgress. Open the card detail panel.

*The Worktree section appears with a branch chip
`atelier/card-<short>-worktree-smoke-test` and an absolute path
`<workspace_cwd>/.plyloft-worktrees/<card_id>`. Click Copy: paste
matches the path. Click Reveal: Finder opens with the worktree
selected. `<workspace_cwd>/.plyloft-worktrees/.gitignore` holds `*`,
`<workspace_cwd>/.gitignore` is unchanged and `git -C <workspace_cwd>
status` shows nothing under the root. (A card started before N16 keeps
its `.atelier-worktrees/<card_id>` path.)*

### 3. Worktrees panel

Click the Worktrees right-tab.

*Header reads `Worktrees (1)`. One row shows the card's title (not
just the dir name), the branch chip, the absolute path, and Reveal
+ Delete buttons. Reveal opens Finder.*

### 4. Parallel cards (LYRA scenario)

Create a second card titled `Worktree smoke test 2`. Drag to
InProgress.

*Worktrees panel header reads `Worktrees (2)`. Two distinct rows,
distinct dirs, distinct branches. Both subdirs visible side-by-side
under `.plyloft-worktrees/` in Finder.*

### 5. Agent dispatch lands in the worktree

Attach an agent or a swarm template to one card. Drag the card out
of InProgress and back in (re-fires dispatch).

*The agent's first message (or the Run Detail panel) reports the
worktree path as cwd. `git -C <workspace_cwd> status` is clean of
the card's edits; `git -C <worktree_path> status` shows the
agent's actual changes.*

### 6. Ship via squash-merge

Move the card to Complete. Click Ship now. Check Skip verify.
Click Drain & ship (or Force ship anyway if drain stalls).

*Ship modal closes. New commit on main has the card title in its
subject and includes the card's worktree commits (squash-merged)
plus the version bump. The card's worktree dir is gone from
`.plyloft-worktrees/` and a corresponding entry appears in
`.plyloft-worktrees/.trash/<id>-<unix_ms>/` (a legacy card's in
`.atelier-worktrees/.trash/`). The card's
`worktreePath` and `branchName` are cleared (Worktree section
no longer renders in card detail). Other in-flight cards'
worktrees untouched. The card branch is still there: N18 records it
on the card (`branchCleanup`, with the released commit as its tip)
and deletes it only when the trash entry expires (step 7).*

### 7. Trash GC on launch

Backdate a `.plyloft-worktrees/.trash/<entry>` mtime by more than
7 days (`touch -t $(date -v-8d "+%Y%m%d%H%M") <entry>` on macOS).
Cmd-Q Ply completely. Relaunch.

*The backdated trash entry is silently reaped. Live worktrees
under `.plyloft-worktrees/` are untouched. A legacy
`.atelier-worktrees/` holding no worktree and no trash entry (only an
empty `.trash/`, `.cargo-target`, `.DS_Store`) is gone; one holding
anything else is untouched.*

*N18: the branch of a card shipped in step 6 goes in the same pass
once its record is a week old too (in a disposable workspace, edit the
card's `branchCleanup.since` in its board JSON while Ply is quit): `git
branch --list 'plyloft/card-*'` no longer lists it and the card's
Activity says "Branch <name> deleted (was <sha>)". A branch with a
commit made after the ship stays and is listed in Settings › Board and
worktrees as "Has commits after it shipped — kept"; one checked out in
a terminal stays until it is not. An archived card's branch is asked
about in the Inbox instead (Delete them / Keep them). With "Delete card
branches when their trash expires" off, nothing is deleted.*

### 8. PTY orphan check

Before Cmd-Q, arm `./scripts/check-ply-cmdq-cleanup.sh` in an external
terminal. Start no new Ply children after arming, then Cmd-Q Ply.

*The canonical checker confirms every armed descendant exits within its
bound. A bare `pgrep claude` is advisory: unrelated external sessions may
remain. This verifies Hard Rule #4 without confusing other apps' processes.*

### When this Tier 4 sequence fails

- **Worktree dir doesn't appear**: check `git --version` (worktrees
  need git ≥ 2.5 — not a real concern on macOS).
- **"Branch already exists" error**: inspect the exact branch and worktree first.
  Use a fresh test-card name or obtain explicit approval before deleting an
  identified disposable test branch; never assume its commits are expendable.
- **Ship squash-merge fails on conflicts**: main advanced while the
  card was in flight. Resolve in the worktree's terminal, then retry
  ship.
- **Trash entry not reaped**: confirm the mtime is genuinely older
  than 7 days (`stat -f "%Sm" <entry>`); the GC reads filesystem
  mtime, not the dir name's `<unix_ms>` suffix.

---

## Tier 4 — project_config (v1.12.x)

Mandatory walkthrough whenever any code under `project_config.rs`,
the `project_config_*` IPCs, the ship-pipeline config-loading path,
or the `ProjectConfigPanel` FE component changes.

Run against the installed `/Applications/Plyloft.app` (not
`tauri dev`). The full LYRA-onboarding sequence (which exercises
all of these against a real second project) is at
`/Users/mb/.claude/plans/cycle-d-lyra-walkthrough.md`. The condensed
Tier 4 sequence below is for narrower changes (e.g., a v1.12.x
patch that touches ProjectConfig schema or Ship.rs's config-loading
path without onboarding a new workspace).

### 1. Atelier's bootstrap is intact

Open the **Project** right-tab on the Atelier workspace.

*The config shows `target_branch: main`, three version_files in
canonical order, `install_script: scripts/install-local.sh`,
`verify_script: scripts/ppvp.sh`. Re-detect / Reset buttons
visible.*

If empty: bootstrap regression. Stop and fix.

### 2. Re-detect produces an equivalent proposal

Click **Re-detect**. Compare the proposal to the saved config.

*Every field matches the saved config 1:1.*

If the proposal differs: the deterministic scan has drifted from
`default_atelier_config()`. One or both must change.

### 3. Ship a no-op patch through the gate

Create a throwaway card. Move it through Complete. Click Ship now,
check Skip verify, ship.

*Ship succeeds. Commit on `main` contains version bump in all three
declared version_files (package.json + src-tauri/Cargo.toml +
src-tauri/tauri.conf.json) plus Cargo.lock sync. install-local.sh
spawns and rebuilds.*

If any of the three version files lacks the new version, or
Cargo.lock is stale post-ship: the new
`write_versions_per_config` path has regressed. Bug E (v1.9.x)
returns.

### 4. Per-project ship lock — concurrent ships allowed

Requires a second workspace (use the LYRA walkthrough or any
other git project).

- Ship a card on workspace A.
- Without waiting for A to finish, ship a card on workspace B.

*Workspace B's ship modal does NOT report "ship already in
progress"; both ships overlap.*

Pre-v1.12.4 ship lock was global. Regression here means the
v1.12.4 HashSet-keyed lock got reverted somewhere.

### 5. Reset deletes the workspace subdir

In the Project tab, click Reset. Confirm.

*`<config_dir>/projects/<workspace_id>/` is removed entirely
(check via `ls`). (Intake runs with the built-in prompt either
way: since GH #214 a pre-1.146 `intake.md` there is ignored, so
its removal changes nothing about intake.)*

If only `config.json` got removed but the dir survived: delete is
not invoking `fs::remove_dir_all`.

### When this Tier 4 sequence fails

- **Bootstrap not running for Atelier**: confirm `looks_like_atelier`
  matches the workspace cwd. Mismatched markers between
  `project_config.rs` and `ship.rs` is the usual cause.
- **Ship errors "no project_config"**: bootstrap silently failed at
  launch (check logs at
  `~/Library/Logs/com.mbadv.ply/`). Restart Ply; if
  persistent, file as a v1.13.x bug.
- **Concurrent ships still serialize**: confirm
  `ShipRegistry::in_flight` is `HashSet<String>`, not `bool`.
- **Cargo.lock dirty post-ship**: confirm `read_cargo_package_name`
  reads the actual package name from the project's Cargo.toml,
  not a hardcoded value.

---

## Tier 4 — non-Atelier workspace onboarding (v1.13.x)

Mandatory walkthrough whenever any code under `project_config.rs`'s
detection / writer paths, the `kanban_card_advance_to_in_progress`
worktree-fork-base resolution, or the `ProjectConfigPanel` proposal-
edit UX changes.

The full LYRA-shape walkthrough lives at
`/Users/mb/.claude/plans/cycle-d-lyra-walkthrough.md` (9 steps, with
post-walk findings template). The condensed Tier 4 below is for
narrower v1.13.x patches that don't need a fresh second-workspace
onboarding.

### 1. Atelier still bootstraps + ships unchanged

Run the v1.12.x condensed Tier 4 above (Atelier ship of a no-op
patch through the gate). v1.13.x must NOT regress Atelier's flow.

### 2. Detection surfaces the right candidates for a known shape

In a tempdir or against any non-Atelier project: open Project tab,
click Detect.

*The proposal includes:*
- `target_branch` from `git rev-parse HEAD`
- All known version files at root + `src-tauri/` + depth-1 subdirs
  (skipping noisy dirs like `node_modules`)
- `main.py` and `config/*.py` if they contain a `version=` pattern
- Per-row × button on each version_files entry
- A `notes` line per inferred field

If the proposal misses something or surfaces noise from
`node_modules`/`target`/`.cache`, the depth-1 scan or Python
heuristic has regressed.

### 3. Curate + save produces the curated config on disk

Click × on entries that don't belong. Click Save.

*Header changes from "Proposed config" → onboarded read-only state.
The saved config at `<config_dir>/projects/<workspace_id>/config.json`
contains exactly the curated entries (no removed ones).*

### 4. Worktree forks from project_config.target_branch

Create a card in the workspace, drag to InProgress.

*The created worktree's HEAD == `project_config.target_branch`'s
HEAD.* Verify with:

```bash
git -C <workspace_cwd>/.plyloft-worktrees/<card_id> log --oneline -1
git -C <workspace_cwd> rev-parse <target_branch>
```

The two SHAs must match. If they don't, v1.13.1's fix has
regressed and worktrees are forking from the wrong base — STOP and
DO NOT SHIP any cards from this workspace until fixed.

### 5. Workspace without project_config errors loud on InProgress

Add a fresh workspace, do NOT onboard via Project tab. Try to
drag a card to InProgress.

*Error: "<workspace name> isn't set up for Ply's builds yet, so Ply
doesn't know which branch to work from. Nothing was started. Open Settings ›
This repository › Build and release and press Re-detect, then start the card
again." The toast's `Set up` opens that page.*

If the move silently succeeds with a worktree off `main`, the
v1.13.1 gate has regressed.

### When this Tier 4 sequence fails

- **Detect surfaces `node_modules/foo/package.json`**: noisy-dir
  exclusion broke. Check `NOISY_SUBDIR_NAMES` in
  `project_config.rs`.
- **Detect misses `pyproject.toml`**: confirm it's in
  `direct_candidates`.
- **Worktree branch HEAD differs from target_branch HEAD**: v1.13.1
  regressed. Check `kanban_card_advance_to_in_progress` reads from
  `project_config_store`.
- **PythonModuleVar writer silently no-ops**: confirm
  `variable_name` is set on the entry; the writer should error if
  it's None.

---

## Tier 4 — PushOnly + verify_pipeline (v1.13.4 → v1.13.6)

Mandatory walkthrough whenever any code under `kanban.rs::ReleaseKind`,
`ship.rs`'s push step, `project_config.rs::VerifyKind`, or
`verify.rs::run_pipeline` / `run_config_pipeline` changes.

The full LYRA shape (target_branch=staging + verify_pipeline + ship via
PushOnly) lives at `/Users/mb/.claude/plans/cycle-d-lyra-walkthrough.md`
steps 7a + 7b. The condensed Tier 4 below is for narrower v1.13.x
patches.

### 1. Atelier still verifies + ships unchanged

Open the **Project** right-tab on the Atelier workspace.

*Verify pipeline shows one row: `Script: scripts/ppvp.sh`. (v1.13.5+
shape; pre-v1.13.5 read as `verify_script: scripts/ppvp.sh`.)*

Run a no-op Atelier ship through the gate (Local).

*Verify timeline shows a single `script:scripts/ppvp.sh` row that
passes. Ship completes. The two-row "cargo-test then ppvp-sh"
display is GONE post-v1.13.6 — that's intentional.*

If you see `cargo-test` + `ppvp-sh` separate rows: v1.13.6's
config-driven dispatch isn't firing. Check `verify.rs::run_pipeline`
reads `app.state::<ProjectConfigStore>()` and matches on
`verify_pipeline.is_some()`.

### 2. Proposal card edits verify_pipeline

In a fresh non-Atelier workspace, click Detect.

*Proposal card shows a "Verify pipeline" row with `VerifyPipelineEditor`.
Initial state has 0–1 rows depending on detection. Add bar has a
kind dropdown (Script / Slash command), a path-or-name input, and
(when Slash command is selected) an args input.*

Test:
- Add a Script row with `scripts/foo.sh`. Add a SlashCommand row
  with `/ppvp` and args `--quick --verbose`.
- Click `×` to remove the first row.
- Save.

*The saved config JSON contains exactly the curated Vec<VerifyKind>
in order. SlashCommand entry has `args: ["--quick", "--verbose"]`
(whitespace-split). Empty editor saves as `verifyPipeline: null`.*

If the editor doesn't render, or args don't split on whitespace,
or empty saves write `[]` instead of `null`: regression in
`ProjectConfigPanel.tsx::VerifyPipelineEditor`.

### 3. v1 → v2 migration on load (no manual action required)

Find or synthesize a pre-v1.13.5 config on disk
(`<config_dir>/projects/<workspace_id>/config.json`) with
`schemaVersion: 1` and `verifyScript: "scripts/ppvp.sh"`. Restart
Ply.

*The project's saved-config view shows a 1-element pipeline:
`Script: scripts/ppvp.sh`. The on-disk file post-`set()` has
`schemaVersion: 2` and the new `verifyPipeline` shape; the legacy
`verifyScript` field is gone.*

If the field stays `verifyScript` on disk after a re-save: the
serialize-time `skip_serializing_if = "Option::is_none"` is
broken, OR `get()` isn't clearing the field post-migration.

### 4. PushOnly ship to a remote branch

Requires a non-Atelier project with `target_branch: staging` (or
similar) and a remote `origin`. The condensed test:

- Stage a no-op change in a card on that workspace.
- Open the ship modal. Pick **Tag + push to remote** (PushOnly).
- Ship.

*The ship gate commits, tags, and runs `git push origin <branch>` +
`git push origin <tag>`. The remote shows the new tag and the
branch tip moved.*

Skip-verify check: re-run the same flow with **Skip verify** ON +
PushOnly selected. *PushOnly remains selectable* (Github would be
disabled). The pushed tag carries the `-unverified` suffix.

If PushOnly errors with "skip-verify ships are local-only": the
guard at `ship.rs:~554` was extended to PushOnly accidentally (the
guard should match on `Github` only, per decision H′).

### 5. SlashCommand verify returns a clear stub error (until v1.13.7)

Set a project's `verify_pipeline` to `[SlashCommand { name: "/ppvp" }]`
via the proposal card. Trigger verify on a card.

*Verify finalizes Failed with reason `slash command verify '/ppvp'
not yet implemented (v1.13.7)`.*

If the verify silently passes or the failure reason is empty:
`run_config_pipeline`'s SlashCommand arm has regressed. Once
v1.13.7 lands, this step's expected outcome flips to "verify
runs the slash command and finalizes per the contract".

### When this Tier 4 sequence fails

- **PushOnly radio missing in ship modal**: FE didn't get the
  `ReleaseKind` union update in `ipc.ts`.
- **Migration leaves `verifyScript` on disk**: the
  `skip_serializing_if = is_none` attribute on `verify_script`
  is missing or wrong.
- **Atelier verify suddenly two-step again**: project_config
  bootstrap regressed and didn't write `verify_pipeline` for
  Atelier — `default_atelier_config()` should always produce v2
  shape directly.
- **`bash <path>` fails to find the script**: confirm the
  workspace cwd is the working dir (not the worktree); confirm
  the script path is workspace-relative; confirm shell_quote
  isn't over-quoting safe paths (its tests cover the boundary).
