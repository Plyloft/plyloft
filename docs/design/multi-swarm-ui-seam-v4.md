# Multi-swarm UI seam — design (4th architect, v1.5.12 retry)

**Status:** Design only. No code. Implementation gated on Matteo's sign-off.
**Author:** architect (Swarm leg `f7e21a62`, single-role `design` template, v1.5.12).
**Prior designs (cal-v121-a1 redundant tick-loop on coordinator-feature):**
- `docs/design/multi-swarm-ui-seam.md` — leg `1cad0b45`, recommends chip strip
- `docs/design/multi-swarm-ui-seam/DESIGN.md` — leg `97dc211e`, recommends chip strip
- `docs/design/multiswarm-ui-seam.md` — leg `5bb0c56a`, **rebuts both: enriched `<select>` in v1, chip strip deferred to v2**

This is the fourth pass. The prior three did the heavy lifting; this doc takes a position on which one to ship and why, then narrows scope so an implementation leg has a single, unambiguous target.

## TL;DR — endorse the rebuttal (third design), with sharper framing

**Ship the enriched `<select>` from leg `5bb0c56a` (`docs/design/multiswarm-ui-seam.md`). Do not ship the chip strip in v1.**

The chip-strip designs are good designs **for a different system** — one where multiple swarms can run concurrently in a workspace. That system does not exist today. The backend rejects starting a second swarm whenever any other is `Running` or `Suspended` (`src-tauri/src/swarms.rs:507-525`, `swarms.rs:590-604`). The 3-builder fan-out in `coordinator-feature` parallelizes *legs inside one swarm*, not swarms (`swarm_templates.rs:207-219`; surfaced in the body via `CoordinatorLanesView`, not in the picker).

Therefore, in the actual world the picker has to address:
- `activeSwarms.length` is always 0 or 1.
- The chip strip degenerates to "1 chip + `Recent (N) ▾` popover" — i.e., a slightly fancier dropdown wearing extra components, extra contrast/affordance work, an overflow strategy, and ~120-200 LOC of net new UI.
- The enriched `<select>` (with `<optgroup>` Active/Recent + identity line above + denser per-row labels) covers the same ground in ~40 LOC of edits to existing UI.

The minimum-blast-radius shape is the dropdown-with-grouping. Ship that. The chip-strip designs become the implementation reference *if and when* the backend gate is deliberately lifted (not "watch usage and decide later" — a paired decision: lift the gate AND ship the chip strip, in one PR, because the picker without the gate change is solving a problem that doesn't exist).

The non-obvious points (where prior designs hedged or disagreed):

1. **The seam was framed wrong.** The user brief says "v1.5+ tasks generate more parallel swarm work — especially via coordinator-feature with its 3-builder fan-outs." That sentence is the trap. Coordinator fan-out is not multi-swarm; it's multi-leg-in-one-swarm. Two of the three priors took the framing at face value and produced UI for a parallelism that the backend forbids. The third caught it; this design ratifies that catch.

2. **The "v2 trigger" should be pinned to a backend change, not a usage signal.** The third design says either (a) lift the gate, or (b) recent-swarm count climbs past ~15. (b) is wrong as a chip-strip trigger — a long Recent list is solved by adding filter/search to the dropdown, not by a chip strip whose chips show *non-terminal* swarms. So the only real trigger is the gate change.

3. **The user brief contains a factual error worth flagging back.** It says "existing workspaces have a flat `swarms[]` array" implying on-disk persistence. There is no workspace-level swarm index on disk; persistence is one `state.json` per swarm at `<config_dir>/swarms/<id>/state.json`, and `list_by_workspace` is a runtime filter over the in-memory cache (`swarms.rs:30-32`, `swarms.rs:459-466`). Anyone reading the brief and going looking for a migration target will not find one.

4. **`activeSwarmId` rules should be codified now even though the UI stays simple.** Three rules (per leg `1cad0b45`, which I agree with): elect on refresh, yank on start, don't yank on terminal-transition. The third codifies the implicit-today behavior that wasn't a problem before but will be a real choice if/when the gate is lifted.

---

## 1. State shape

**Recommendation: keep `swarms: Swarm[]` flat. Derive `{active, recent}` partitioning in the `SwarmTab` body via `useMemo`. No `pinnedIds`, no `swarmOrder`, no slice split.**

All three priors agree, and nothing in the codebase argues against it. `docs/PATTERNS.md` forbids `.filter()` inside zustand selectors (fresh-array-identity stampede); `useMemo` in the component body is the blessed pattern.

`activeSwarmId` semantics — adopt the three rules from leg `1cad0b45`:
1. On `refresh`: elect `first running ?? first ?? null`. Unchanged from today.
2. On `start`: new swarm becomes active. Unchanged from today.
3. On status transition `running → terminal` of the active swarm: **leave focus on it**. Implicit today (because `refreshSwarm` doesn't move focus); make it an explicit invariant by leaving `refreshSwarm` as-is and adding a one-line comment naming the rule. No code change, just a doc-of-record so a future maintainer doesn't "fix" it by auto-jumping.

Persisting `activeSwarmId` across app restart (via `localStorage`) is a polish item that only matters once the gate is lifted and N>1 in-flight swarms exist. **Defer.**

## 2. Migration

**Zero migration. No persisted-schema bump. PPVP Tier 2 not triggered.**

The `swarms[]` array exists only in `swarmStore.byWorkspace[id].swarms`, hydrated from `swarmList(workspaceId)` on every refresh. There is nothing on disk at workspace granularity to migrate. `Swarm.schema_version` (`SCHEMA_V1 = 1`) stays put.

If the brief's mention of "existing workspaces persist a flat swarms[] array" was intentional shorthand for the in-memory store, the answer is the same — the in-memory shape stays exactly as it is. If it was a misread of the persistence model, this design flags the misread.

## 3. UI affordance — enriched `<select>`

**Replace the row-2 `<select>` block in `SwarmHeader.tsx` with a `<optgroup>`-grouped version (Active / Recent). Add a one-line identity line above the dropdown showing the active swarm's status pill + template + truncated goal. Densify `labelForSwarm` to template + relative time + 50-char goal snippet.**

Layout (from leg `5bb0c56a`, lightly tightened):

```
┌────────────────────────────────────────────────────────────────────────┐
│ Swarm  [▶ running] 12m 3s  iter 1/3      Templates ⚙ Export +New Abort │ ← row 1
├────────────────────────────────────────────────────────────────────────┤
│ ▶ feature · "add /api/healthz endpoint with dashboard tile"            │ ← row 2 NEW
│ ┌──────────────────────────────────────────────────────────────────┐   │   identity
│ │ Active                                                           │   │   line +
│ │   ▶ feature · 12m ago · "add /api/healthz endpoint with…"        │   │   grouped
│ │ Recent (12)                                                      │   │   <select>
│ │   ✓ refactor · 3h ago · "consolidate cache layer"                │   │
│ │   ✗ ux-audit · 1d ago · "review onboarding flow"                 │   │
│ │   …                                                              │   │
│ └──────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

Hide condition stays as today: row 2 omitted when `swarms.length <= 1`. Single-swarm case is byte-identical to v1.5.x.

### Why this and not the chip strip (in v1)

- **The chip strip's load-bearing affordance is "active chip vs inactive chip read as switcher."** Leg `1cad0b45` correctly notes that this needs filled-background contrast, not a `*` marker. That's a real piece of design work — and it's needed only when there's >1 chip to choose between, which under the current backend gate is never.
- **The chip strip's overflow strategy is non-trivial.** Open Q4 in leg `1cad0b45` is "what if 5+ concurrent running swarms?" — that question is unanswerable today because the answer can only be ≤1.
- **The chip strip's leg-count badge / unread-entries badge / per-chip context menu follow-ups all assume parallel monitoring.** They are unwarranted scope today.
- **The dropdown's `<optgroup>` keyboard-navigation falls out for free.** The chip strip needs explicit focus-ring / arrow-key handling.

### Why this and not the augmented dropdown plus a chip strip behind a flag

Adding both is the worst-of-both: ships chip-strip code paid for now, gated by a flag that may never flip. If the gate is lifted, the chip-strip designs are already written and ready to land then; do that as one coordinated PR, not as ambient buildup.

### Coordinator-feature interaction

A `Dispatching` coordinator-mode swarm is one row in the dropdown (its swarm-wide status is `running`). The per-leg breakdown stays in the swarm body via `CoordinatorLanesView` (`SwarmTab.tsx:638-702`). No leg-count badge. The live mailbox subscription (`swarmStore.ts:258-288`) keeps row labels' status glyphs current without additional wiring.

## 4. Cross-swarm operations

**Bulk abort and side-by-side compare are both OUT for v1.**

- **Bulk abort** is meaningless under the current backend gate (at most one bulk-abortable target exists, and the existing per-swarm Abort already covers it). Reasoning is identical to all three prior designs.
- **Side-by-side compare** duplicates the entire body renderer (lanes/strip + mailbox + metrics + bindings) into a split layout that breaks at typical right-panel widths. `swarmExport` already produces per-swarm Markdown; `diff swarm-a.md swarm-b.md` is the v1 substitute. Wait for a concrete user workflow.

**The most useful next-step cross-swarm op is `swarm_delete` (per-row "Delete" affordance).** The recent list is the load-bearing UX problem; pruning individual stale terminal swarms is the natural next move. It needs a new IPC and lifecycle for mailbox + snapshot-dir cleanup — separate seam, separate design. **Out of scope for the picker, in scope for the next architect leg if/when this lands.**

## 5. Open questions

1. **(Blocking the v1 vs v2 split.) Is the backend one-swarm-per-workspace gate going to be lifted?** If yes (and within near horizon), the right shape might be to ship gate-lift + chip strip together rather than dropdown-now + chip-strip-later. If no (or not soon), enriched dropdown is the strict superset. **Needs Matteo's call before the implementation leg.** This is the question the prior three designs danced around.

2. **`swarm_delete` IPC.** Most useful follow-up after a better picker. Needs its own architect pass — touches `swarms.rs`, IPC, mailbox cleanup, snapshot dir cleanup, frontend confirm modal. Non-blocking for the picker.

3. **Realistic recent-swarm growth rate per workspace.** The dropdown stops being scannable past ~15-20 entries; a popover with filter/search is the next move at that scale. Need calibration data — telemetry or a self-report from Matteo. **Worth confirming before implementation;** the answer determines whether v1.5.13 ships the dropdown as designed or adds a search box.

4. **Persisting `activeSwarmId` across app restart** via `localStorage`. Cheap; only matters once N>1. Defer until the gate decision in Q1 lands.

5. **Notification on a backgrounded swarm reaching terminal.** Cross-cutting, not picker-specific. Mailbox event stream provides the trigger. Defer.

6. **`labelForSwarm` densification specifics.** Today: `glyph + locale-date + goal-snippet`. Proposed: `glyph + template-id + relative-time + goal-snippet`. Concrete examples in the implementation leg; minor.

7. **Three redundant designs already exist on disk.** This design adds a fourth file. Worth a follow-up cleanup once Matteo picks: archive the rejected designs into `docs/design/_archive/` and keep one canonical `multi-swarm-ui-seam.md` to avoid future architect legs reading stale rationale. Non-blocking.

---

## File touchpoints (anticipated)

| File | Change |
|---|---|
| `src/components/SwarmHeader.tsx` | Replace L120-133 `<select>` block with `<optgroup>`-grouped version. Add identity line above row 2. Tighten `labelForSwarm`. ~30-40 LOC. |
| `src/components/SwarmTab.tsx` | Add `activeSwarms` / `recentSwarms` `useMemo` derivations; pass to `SwarmHeader`. ~10 LOC. |
| `src/App.css` | New `.swarm-identity-line` style. ~10 LOC. Optional polish on the `<select>` chevron. |
| `src/store/swarmStore.ts` | UNCHANGED. (Add a one-line comment in `refreshSwarm` codifying rule 3 — "active swarm reaching terminal status doesn't move focus" — for invariant clarity.) |
| `src-tauri/src/swarms.rs` | UNCHANGED. |
| IPC | UNCHANGED. |

**~50 LOC total.** ~1/4 of the chip-strip designs' LOC budget. Zero Rust touch. Zero IPC change. Zero schema diff. Zero PPVP Tier 2 obligation.

## Verification posture

- **PPVP Tier 1** (`./scripts/ppvp.sh`): must stay 7/7. Pure-render change; no PTY, no IPC, no persistence touched.
- **PPVP Tier 1.5**: covers the React-mount-loop class. `useMemo` derivations in the component body match the existing pattern.
- **PPVP Tier 2**: NOT triggered. No persisted-schema fields added.
- **Manual Tier 4** (the implementation leg's checklist):
  1. Single-swarm workspace: row 2 absent.
  2. 1 running + 0 terminal: row 2 shows identity line + dropdown with Active group only (1 row).
  3. 1 running + 12 terminal: dropdown with Active (1 row) + Recent (12 rows). Keyboard nav works.
  4. 0 running + 1 suspended + 5 terminal: Active group shows the suspended swarm with `⏸` glyph; Recent absorbs the rest.
  5. Coordinator-feature swarm in `Dispatching`: one Active row with `▶` glyph; lanes view inside the swarm body unchanged.
  6. Live event flips a non-active swarm `running → done`: row migrates from Active group to Recent group on the next `refreshSwarm`.
  7. Pick a different swarm from the dropdown: body swaps; lanes/strip + mailbox + metrics + bindings re-render.

## Convergence / divergence with the three priors

- **Convergent with all three:** flat `swarms[]`, derive in component body, no schema migration, three-rule `activeSwarmId` semantics, bulk abort and side-by-side compare both out, `swarm_delete` as highest-value follow-up.
- **Convergent with leg `5bb0c56a` (and divergent from `1cad0b45` / `97dc211e`):** enriched dropdown in v1, chip strip deferred. This design's only meaningful contribution beyond `5bb0c56a` is to **sharpen the v2 trigger to "the backend gate is lifted, period"** (rather than "or recent-swarm count climbs"), and to **flag that the chip strip and the gate change should ship as one PR** rather than chip-strip-now-gate-later.
- **Divergent from leg `5bb0c56a` only in tone:** that design says "if Matteo confirms the framing, I switch sides immediately." This design takes the position more firmly: the framing in the user brief is wrong as written, and the implementation leg should not pretend otherwise.

If Matteo reads this and decides he *does* want concurrent in-flight swarms in a workspace, the right next step is a follow-up architect pass on the backend gate (PTY-count limits, Max-plan parallel-session interaction, semantic conflicts on shared file paths). The chip-strip designs are then the implementation reference for the UI half. Until that decision, **enriched dropdown is the v1 ship.**
