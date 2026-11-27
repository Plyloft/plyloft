# Ply UX language

One language for every screen of Ply. Decided with the owner on 2026-09-17
([ADR 0004](../adr/0004-one-ux-language-enforced-in-migrated-surfaces.md),
[ADR 0005](../adr/0005-the-library-replaces-knowledge.md)); since 2026-09-24
**one scale, the Notion style everywhere**
([ADR 0007](../adr/0007-notion-style-one-scale.md)): the Ply Design System v2
is the source, [tokens.json](tokens.json) its copy. Vocabulary in
[`CONTEXT.md`](../../CONTEXT.md).

| File | What it holds |
|---|---|
| [PRINCIPLES.md](PRINCIPLES.md) | The seven rules a screen is judged by. One page. |
| [PATTERNS.md](PATTERNS.md) | The catalogue: page anatomy, rows, actions, status, publishing, tokens, the component layer and the PPVP check. |
| REVAMP_PLAN.md | The UX revamp, C0–C10: one scale for every surface. Done in code; the owner's Tier 4 walks pending. |
| [tokens.json](tokens.json) | The Design System v2's tokens; `scripts/tokens-css.mjs` generates `src/App.css`'s token block from it. |
| CLAUDE_DESIGN_BRIEF.md | The 2026-09-17 brief for the first four boards (history; ADR 0007 is current). |
| [boards/BOARDS.md](boards/BOARDS.md) | The approved boards as a build specification: every measure and string. |
| [boards/SHEET.md](boards/SHEET.md) | The token sheet and the component sheet: measures and states of every component. |

**Status.** Shell kit, Board 1 (Settings › Build & release) and Board 2
(Library › Skills) approved 2026-09-17; Boards 3 (a skill) and 4 (errors,
procedures, This Mac) reviewed and corrected with the owner the same day. Code:
step 1 built (GH #93) — page tokens, `src/components/ux/`, `scripts/ux-check.mjs`
with `migrated.json` and `ux-baseline.json`, the Settings shell by scope with
the old panels embedded. Then, out of build order because the pages were the
last raw-JSON editor left, **Settings › Repository** (GH #94): Board 1 and
General built as drawn, with the draft, the `PublishBar`, the Review sheet, the
question asked when a draft is left behind, and the same page in its This-Mac
scope; `SharedDefinitionPanel` and `ProjectConfigPanel` are gone. Build order
(each step ships):

1. Foundations — tokens, component layer, the PPVP check, the Settings shell
   with navigation by scope (old panels embedded unchanged).
2. The Library (instructions, skills, notes; four scopes).
3. Settings pages.
4. Skills available to both CLIs.
5. Ply skills.
6. Improvement proposals.
7. Search in Settings.

Then the board and the card got their own round: the UX revamp
(REVAMP_PLAN.md, ADR 0007), C0–C10, one scale for every
surface. Every modal is a `Sheet`, ux-check's baseline is ratcheted after each
cycle, and the files that pass its strict rules are in `migrated.json`.

The older design system in `docs/ux-revamp/ds-refresh/` is history: ADR 0007
retired its two densities. Terminals, the editor and diffs are dense islands
inside calm pages, on the same tokens.
