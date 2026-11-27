# ADR 0004 — One UX language, enforced in migrated surfaces

**Status:** accepted, 2026-09-17. Interview with the owner the same day.

## Context

Settings grew by accretion: a window folded into a 760×620 modal (v1.73),
then one panel appended per team-sharing rung. By v1.131.0 the Settings
components used 12 button class families, about 17 panel and row families
and 41 hard-coded colours, against a shared component layer (`.cbtn`,
`.cchip`, v1.78) that most of them never adopted. The Tier 4 of #82 found
three defects in one morning, all layout: skill names squeezed to nothing, a
list clipped after three rows, a button cut off. The type scale runs from 10
to 13 px and the code has no spacing or radius tokens. Builders on the mini
invent a new class family for each panel because nothing stops them.

Alternatives considered: a written style guide alone (nothing enforces it);
a big-bang restyle of the whole app (terminals, board and cards change at
once; one enormous Tier 4); a warning-only check (how the 12 families
happened); Settings as a full-page centre mode (the owner chose a large
resizable modal: Settings is a place you visit briefly).

## Decision

Ply gets one UX language in three layers: a page of principles, a catalogue
of patterns (page, section, grouped rows, field, where actions go, status
and error lines, one-off procedures as a status row that opens a dedicated
flow), and a component layer in code that is the only easy way to build a
screen. The reference is Notion's page anatomy with macOS Settings rows.
Words come first and technical truth (paths, SHAs, raw tool output) sits
behind a disclosure, in Settings too.

New type, spacing and radius tokens are introduced and applied surface by
surface, Settings and the Library first, then the board and the card. Two
styles coexist for some versions. A check in PPVP fails when a migrated file
introduces a button, panel or row class outside the catalogue or a
hard-coded colour; the rest of the app is only counted, and the count must
fall.

One scope vocabulary names where anything lives, across the app: **Ply**,
**Team**, **Repository**, **This Mac** (see `CONTEXT.md`). Settings is
organised by it. Settings of This Mac save as they change, with Undo;
changes to the Repository are edited in place and published together from a
bar that says they reach everyone.

## Consequences

- A PPVP step can fail a card over a CSS class. That is the point; the
  catalogue must therefore be complete enough that the right way is also the
  short way.
- Mixed old and new pages ship for a while. Each card is released as it
  lands; nothing waits behind a switch.
- "Personal" and "Shared" leave the interface as scope labels.
- Screens are approved on Claude Design boards before they are built.
