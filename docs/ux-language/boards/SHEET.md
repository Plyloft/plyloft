# Token sheet and component sheet

Source: `Sheet - tokens and components` in the Claude Design project, read
2026-09-17. The tokens as CSS, ready to import, are in
`docs/ux-revamp/ds-refresh/tokens/page.css`. The measure lines are copied verbatim from the sheet (`h` height ·
`pad` padding · `r` radius · `15/600` size/weight · `/.30` shadow alpha).
Where a token name here differs from the sheet's, the name here wins and the
reason is given.

## Tokens

| Token | Value | Note |
|---|---|---|
| `--page-title` | 24 / 600 · line 30 · `--fg` | |
| `--page-section` | 17 / 600 · line 24 · `--fg` | |
| `--page-body` | 15 / 400 · line 22 · `--fg` | row labels use line 20 |
| `--page-control` | 14 / 400 | buttons, selects, navigation entries |
| `--page-hint` | 13 / 400 · line 18 · `--muted` | status lines use line 20 |
| `--page-mono` | 13 mono | paths, SHAs, counts |
| `--page-eyebrow` | 11 / 600 · tracking 0.06em · uppercase | navigation groups, the parts of an error |
| `--page-space-xs … 3xl` | 4 · 8 · 12 · 16 · 24 · 32 · 48 | the sheet numbers them 1–7; named by size here because the older design system owns `--space-1 … 12` |
| `--radius-control` / `--radius-menu` / `--radius-group` / `--radius-surface` | 6 / 8 / 10 / 14 | |
| `--row-min` | 44 | padding included |
| `--ctl-page` | 30 | every page control: button, select, field, segmented, icon button (small button 24–26) |
| `--page-column` / `--page-column-wide` | 720 / 880 | settings pages / list pages |
| `--focus-w` · `--focus-offset` | 2 px · 1 px | colour `--claude-accent` |
| `--danger` | `#ef4444` light · `#f87171` dark and void | destructive actions and their confirmations only; never marks state |

Spacing as used: row padding `12 16` · gap inside a row `8`, between its two
sides `16` · label to hint `4` · a section heading `32` below the previous
group and `12` above its own · page padding `32 24 48`. Borders: `--border`
1 px hairline, `--border-strong` 1 px emphasised, 2 px `--fg` for the changed
mark.

**Signal colours on a page** appear only as an 8 px dot in a `StatusLine` or on
a diagnostic row, and as the border of an `ErrorBlock` or `DangerZone` — never
as a fill, a diff background or decoration. Dark and void keep the four
meanings with lighter ink (`#818cf8` · `#4ade80` · `#fbbf24`).

**Focus.** `outline: 2px solid var(--claude-accent); outline-offset: 1px`,
outside the control so it never moves the layout; 2 px because 1 px vanishes
on violet over `#1c1c1e`; void gets cyan through the token. The switch takes
offset 2 (at 1 the ring touches its 11 px corner). A row that opens a sub-page
takes the ring on the whole row with offset −2, inside the group. Every
control shows it in light, dark and void.

**Primary button ink**: `#fff` in light, `--bg` in dark and void (white on the
lighter dark-theme accents fails contrast).

## Scope glyphs

`P` Ply · `◇` Team · `▤` Repository · `▪` This Mac — 13 px mono `--muted`,
before the scope name. The badge is a line above the title, never a band.

## Components — measures

| Component | Measures |
|---|---|
| ScopeBadge | h 24 · pad 0 8 · gap 8 · r 6 · border 1 --border-strong · bg --raised · glyph 13 mono --muted · scope 13/600 --fg · meaning 13 --muted |
| PageHeader, Section, Group | header: badge · title 24/600 · sentence 15 --muted, 8 below · section: 17/600 + count 13 --muted, 32 above / 12 below · group: bg --raised · border 1 --border · r 10 · rows split by 1 --border |
| Row | min-h 44 · pad 12 16 · label 15/--fg · hint 13/--muted 4 below · right side gap 8 · wraps under the label below ~260 of label space |
| ChangedMark | bar 2 × full row height, --fg · number 18 h, min-w 18, pad 0 4, border 1 --fg, r 6, 11/600 · plus the hint sentence naming the old value · the number matches the jump in the PublishBar |
| StatusLine | dot 8 r 4 · gap 8 · text 13/20 --muted, mono words in --fg |
| AvailabilityChips | h 18 · pad 0 6 · r 6 · 11 · bg --signal-empty-bg · border 1 --signal-empty-border — lit only, never an unlit chip to read |
| DuplicateNotice | a chip in a list row, a block on the item page · border 1 --border-strong · r 10 · pad 12 16 |
| Buttons | h 30 (--ctl-page) · pad 0 12 · r 6 · border 1 · text 14 · primary: bg+border --claude-accent · secondary: bg --panel-bg, border --border-strong · quiet: no border, --muted · danger: border --signal-aborted-border, ink --danger |
| Toggle | 38×22 · r 11 · knob 18 r 9 (16 when off) · pad 2 · on: bg --claude-accent, knob #fff · off: bg --panel-bg, border 1 --border-strong, knob --border-strong |
| Segmented | pad 2 · r 8 · item h 26 pad 0 10 r 6 · selected bg --tab-active-bg 600 |
| Icon button | 30×30 · r 6 · glyph 14 |
| Fields (select, text, search) | h 30 · pad 0 10 (0 8 0 10 with a caret) · r 6 · border 1 --border-strong · bg --panel-bg in a row, --raised on --panel-bg · text 14, mono 13 for paths and commands · caret ▾ 13 --muted · error border --signal-aborted-border + hint · read-only: no box, value only |
| Type-or-choose field | as Text, plus caret · open list: w 260 · bg --panel-bg · border 1 --border-strong · r 8 · shadow 0 12 48 /.35 · item h 34 pad 8 10 r 6 · tick 14 · first item always "CLI default" · footer hint 13 --muted ("Or type the name of any model your CLI accepts.") |
| MoreMenu | the same shell as the open list · divider 1 --border, 4 above and below |
| Details | bg --panel-bg · border 1 --border · r 10 · pad 12 16 · summary 13 --muted with ▸ / ▾ · body 13 mono --muted, 8 below · closed by default |
| PublishBar | sticky bottom · bg --raised · border-top 1 --border-strong · pad 12 24 · gap 24 · sentence 15 · jumps h 24 pad 0 8 r 6 border 1 --border, number 600 --fg · the page reserves 48 at its end |
| Review sheet, confirmation | sheet max-w 640 (confirmation 480–520) · bg --bg · border 1 --border-strong · r 14 · shadow 0 8 32 /.30 · head pad 24 24 16 · body gap 12 · foot pad 16 24, border-top 1 --border, bg --panel-bg · one field per card: old struck --muted → new |
| ErrorBlock | bg --raised · border 1 --signal-aborted-border · r 10 · pad 16 · dot 8 · three parts, each an 11/600 eyebrow + 15/22 sentence, gap 12 · actions 16 below · Details inside, open when the output matters · dense on a work surface: PATTERNS §4 |
| Toast with Undo | bg --raised · border 1 --border-strong · r 10 · shadow 0 4 16 /.18 · pad 12 16 · gap 16 · text 14 · Undo h 26 pad 0 10 r 6 · a few seconds, then gone; never the only place an action lives |
| ProcedureRow | a Row whose right side is one named action |
| Flow | max-w 720 · bg --panel-bg · border 1 --border-strong · r 14 · shadow 0 8 32 /.30 · head 24 24 16 · eyebrow 11/600 · comparison two columns gap 12 · foot 16 24 with one confirming action |
| Improvement proposal | bg --raised · border 1 --border-strong · r 10 · pad 16 · eyebrow chip h 20 pad 0 8 r 6 11/600 · the sentence that explains the change before the diff · diff: bg --panel-bg, r 10, rows 13 mono/20, changed rows --hover + 2 --fg bar + "+ / − / ≠", line numbers w 28 --muted |
| ConfirmSheet | max-w 480–520; one question that names the files or what is lost; the destructive action is the only filled `--danger` button on the page · a destructive one opens with focus on Cancel, so Enter never destroys |
| NoteEditor | a title field and a text field in the page, never a modal · Save disabled until there is a title, with the reason in the foot · on a failed save the group takes `--signal-aborted-border` and the three-part error sits above the foot |
| EmptyState | a group with pad 48 24, one 15 --muted sentence max-w 420, centred, one primary action 16 below |
| DangerZone | the last group of the page, border 1 --signal-aborted-border, each row names what is lost, the action is the danger button |

## States

- **Buttons**: rest · hover · focus · pressed · disabled. Pressed is a fill
  change, never a scale: primary hover `brightness(1.08)`, pressed `0.88`. The
  danger button fills only when pressed or as the confirming action of a
  dialog.
- **Rows**: rest (`--raised`) · hover (a `--hover` wash, **only on rows that
  open something** — a row that just holds a control stays flat, the control
  has its own hover) · focus (whole row, when it opens a sub-page) · disabled
  (the reason in the hint, never only in a tooltip) · changed · read-only (`Set
  by MatteoB-adv on 17 Sep 2026.`, no box) · error (aborted border on the
  control, the hint says what happened and that nothing was changed: `That
  branch no longer exists on the remote. Nothing was changed — pick
  another.`).
- **Fields**: rest · hover · focus (typing) · disabled · error · read-only. The
  search field shows `✕` while it holds text.
- **Menus**: rest, hover, keyboard focus, and a disabled item whose reason
  lives in the row's hint, not in the menu.
- **PublishBar**: changes to publish · `Waiting to publish — you're offline` ·
  `Publishing to staging…` / `The rows keep their mark until it lands.`
- **Confirmation** (e.g. reset): `Reset every setting on this Mac?` … `Cancel`
  · `Reset this Mac` (danger, filled).
