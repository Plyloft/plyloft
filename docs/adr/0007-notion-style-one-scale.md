# ADR 0007 — Notion style everywhere, one scale

**Status:** accepted, 2026-09-24. Interview with the owner on 2026-09-23;
the Ply Design System v2 approved the next day. The owner is not fully sold on
violet as the default accent; the presets (cyan, magenta, sunset) carry a value
per theme, so changing the default later is a token change.

## Context

ADR 0004 gave Ply one UX language and migrated Settings and the Library to
it. It kept a second tier for work surfaces: 13 px base, 22/26 px controls,
radius 4, "two densities, never mixed" (PRINCIPLES §4). The 2026-09-23 audit
found the split had become two products in one window:

- App.css: 431 of 503 font sizes are px literals (16 distinct, most 10–12 px);
  244 of 245 radii literal; about 1% of spacing tokenised; 342 colour literals.
- The page tier (ux.css) is fully tokenised; the work tier is not.
- Tokens used but never defined (`--accent`, `--font-mono`, `--text`,
  `--signal-empty-fg`) silently drop accent presets and void.
- 36 unicode glyphs and 13 emoji serve as icons, with collisions.
- Light theme `--muted`, `--warn`, `--ok` fail AA on the panel.

## Decision

1. **One scale, Notion baseline.** A single token set (type, spacing, radius,
   shadow, motion) for the whole app. UI text is 14–16 px; nothing below
   11 px. Terminals, the editor and diffs are dense islands inside calm pages,
   not a separate tier. PRINCIPLES §4 is rewritten accordingly.
2. **Icons:** Lucide line icons (1.5 stroke) for navigation, scopes, actions
   and states. Unicode only for key caps, `·`, `…` and the tile kind
   character. User-chosen workspace emoji stay as page icons.
3. **Colour:** failure is amber; `--danger` marks destructive actions only.
   All text meets WCAG AA in light, dark and void. Accent presets carry a
   value per theme plus an on-accent ink. The terminal ANSI palette follows
   the theme.
4. **Type conventions:** sentence-case labels (no uppercase eyebrows), weight
   ceiling 600, body line-height 1.5.
5. **Sequence:** the Ply Design System changes first, each surface gets an
   approved design board, then code — surface by surface, as with Settings.

## Specification

The Ply Design System v2 (the owner's Design System artifact, published
2026-09-24, "v2 proposed — one scale (C1)") holds the values: type styles
`display` 30 · `title` 24 · `heading` 20 · `subheading` 16 · `body` 15 ·
`ui` 14 · `small` 13 · `caption` 12 · `mono` 13; spacing 2–48 px; radii
4 · 6 · 10 · 14; rows 32 / 44 px; controls 26 / 30 px. Colours were measured
per theme: every text ink ≥ 4.5:1 on `term-bg`, `bg`, `panel-bg` and `raised`
(light `muted` 0.66 alpha, `claude-accent` #7c3aed, `warn` #a0460a, `ok`
#166534, `danger` #c81e1e); text on accent, preset and danger fills uses
`on-accent`, `on-accent-preset`, `on-danger` (≥ 5.2:1); `border-control` and
the focus ring ≥ 3:1. Presets carry a value per theme (light cyan #0e7490,
magenta #be185d, sunset #b93d0b).

## Consequences

- Board columns hold about 30% fewer cards; the plan adds a List view and a
  collapsed Done column to compensate.
- The work-tier class families (`.cbtn` work variant, `modal-card`, the
  sidebar's 9–12 px rows) are retired as their surfaces migrate; old token
  names are aliased during the transition.
- ux-check gains an undefined-token rule and its colour-literal baseline
  ratchets to zero by the end of the plan.

## Notes

- **2026-10-01 — the wide card page (SP-1).** The owner approved the layout
  board for the card page on a wide window: below ~1000 px of page width (the
  board's figure was approximate; the code uses 1200 px so the session's
  column is never under ~560 px) the page stays the one column; above it, column 1 keeps the title, Properties,
  Now, What you want, Activity and the plan, and column 2 holds the one open
  slot section. A layout change only, on the same scale and tokens; still
  one scroll (docs/ux-language/PATTERNS.md, Wide card page). Phase 2, also
  approved: the result on the left and its diff on the right, open together
  — the one pair excepted from "one section at a time".
