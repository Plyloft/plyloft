# Patterns

The catalogue a page surface is built from. Names in `code` are the components
and classes of the layer in `src/components/ux/`; nothing else may lay out a
migrated page. Sizes are the ones the approved boards fixed ([boards/BOARDS.md](boards/BOARDS.md)).

## 1. Tokens (one scale, ADR 0007)

The Ply Design System v2 is the source: `docs/ux-language/tokens.json` is its
copy, and `scripts/tokens-css.mjs --write` generates the token block of
`src/App.css` from it (`src/lib/designTokens.test.ts` fails on drift). Change
the design system first, copy its `tokens.json`, regenerate.

| Tokens | Values | Use |
|---|---|---|
| `--type-display` · `title` · `heading` · `subheading` | 30 · 24 · 20 · 16 px, 600 (`-lh`, `-weight` beside each) | Card title · page name · section · group, sheet title, board column |
| `--type-body` · `ui` · `small` · `caption` · `mono` | 15 · 14 · 13 · 12 (500) · 13 px | Reading text · chrome default · hints, metadata · section labels in sentence case, counts · machine text |
| `--space-2xs … 3xl` | 2 · 4 · 8 · 12 · 16 · 24 · 32 · 48 px | Every spacing |
| `--radius-sm` · `md` · `lg` · `xl` · `pill` | 4 · 6 · 10 · 14 · 999 px | Chips · controls, cards · groups, popovers, columns · sheets, Settings · dots, switch |
| `--row-compact` · `--row-comfortable` | 32 · 44 px | Sidebar, menus, lists · pages, Inbox, Settings |
| `--control-sm` · `--control-md` | 26 · 30 px | Controls inside a card or tile header · every other control |
| `--icon-sm` · `--icon-md` · `--icon-stroke` | 14 · 16 px · 1.5 | Lucide icons |
| `--shadow-popover` · `sheet` · `toast` | per theme (a hairline on void) | Only what floats |
| `--dur-fast` · `base` · `pulse`, `--ease-out` | 80 ms · 140 ms · 1.4 s | Hover reveals · opening · the running dot |
| `--focus-w` · `--focus-offset` | 2 · 2 px, `--claude-accent` | The keyboard focus ring |

Colours, per theme (light · dark · void), all text ≥ 4.5:1 on every surface:
surfaces `--term-bg` → `--bg` → `--panel-bg` → `--raised`; inks `--fg`,
`--muted`; `--hover`, `--selected`; `--border`, `--border-strong`,
`--border-control` (≥ 3:1); `--claude-accent` with `--on-accent`; presets
`--accent-violet|cyan|magenta|sunset` with `--on-accent-preset`
(`[data-accent]` swaps them in); `--ok`, `--warn` (failure is amber);
`--danger`, `--on-danger`, `--danger-wash` (destruction only); the run-state
family `--signal-running|done|aborted|empty-fg|bg`; `--scrim`. A migrated file
holds no colour literal.

**Legacy names** still in use keep working: `--tab-active-bg` → `--selected`,
`--page-on-accent` → `--on-accent`, `--page-shadow-*` → the shadows,
`--page-backdrop` → `--scrim`. The work sizes `--text-2xs … surface-lg` keep
their old values until each surface moves to `--type-*` in its cycle (C3–C9);
new code uses `--type-*`. The page layer moved in C9 (UX-9.2): the page sizes
`--page-title … eyebrow` are gone, and `ux.css` draws page titles in
`--type-title`, section headings in `--type-subheading`, row labels in
`--type-body`, controls in `--type-ui`, hints in `--type-small` and every
former eyebrow (a navigation group, an error part, a flow's step line, a
menu heading) in `--type-caption` 12/500 muted, sentence case, no tracking.
Nothing on the page layer is uppercase.

## 2. Page anatomy

```
┌ nav (by scope) ─┬─ page ───────────────────────────────────────────┐
│ search          │  ▢ This Mac                  (scope line)        │
│                 │  Page title                                      │
│ ▢ This Mac      │  One sentence: what this page is for.            │
│   Appearance    │                                                  │
│   …             │  Section heading                          count  │
│ ▢ This repos…   │  ──────────────────────────────────────────────  │
│   …             │  row                                             │
│ ▢ Team          │  ──────────────────────────────────────────────  │
│   …             │  row                                             │
│ ▢ Account       │                                                  │
│   …             │  Section heading                                 │
└─────────────────┴──────────────────────────────────── publish bar ─┘
```

- `Page` — one scroll for the whole page; no region inside it scrolls on its
  own, whatever its length. The column is centred, `--page-column` wide.
  The card page is the one page with a second column (SP-1, below): above
  1200 px of its own width (a container query on its `.ux-page`, never the
  window) — still one scroll.
- `PageHeader` — the scope line, the title, one sentence. Nothing else.
- `Section` — a heading (`--type-subheading` 16), an optional count on the
  right, then groups.
- `Group` — rows on the page ground under a hairline, separated by hairlines
  (UX-9.2, "fewer boxes, more type"). A group holds rows of one kind. Only the
  `EmptyState` and the `DangerZone` keep a rounded box. A group is a table: its rows
  share one action column (§3, "Tidy tables").

**`ScopeBadge`** — since UX-9.2 a line, not a badge: the scope's Lucide icon
(`thisMac`, `repository`, `team`; Ply has none) and its name in
`--type-small` muted above the title. A surface can name its places itself
(`ScopeLabelProvider`): Settings says its navigation group's name — `Look
and feel`, `Cards`, `Project`, `Team`, `Setup and account`, with the project
after it on a page that edits the project (`Cards · notes-app`) — so the line
above a page title always agrees with the group the page is in.

**`ScopeMark`** (1.174.0, D6) — where a Settings section's rows are kept, right
of its title (`Section scope`): a grey icon and one of five shapes from
`uxScope.ts::scopeWords` — *on this Mac*, *shared with the project*, *on this
Mac until you share the project*, *shared with the team*, *your Plyloft
account* (*this PC* on Windows). A section never mixes two; a project section
says whether the project shares its setup (`scope="repository" shared`).

A page has one scope. When the same page serves two (Build & release on a
repo with or without a shared definition) the badge changes, not the layout. A
list page that shows every scope at once (the Library's Skills) has no
badge of its own: its sections carry the scope, and one on the header would claim
the page belonged to a single one (GH #96).

## 3. Rows

`Row` is the unit of every page. Left: label, and under it one hint line.
Right: the control or the value, then at most one action and a `MoreMenu`.

| Kind | Right side | Example |
|---|---|---|
| Toggle | switch | Notify when an agent finishes |
| Choice | select | Theme |
| Text | input, saves on blur or Enter | PATH override |
| Value | text + chevron, opens a sub-page or flow | Version files · 5 files › |
| Item | chips + one action + `MoreMenu` | a skill, a team workspace |
| Procedure | status words + one action | Agent instructions · only CLAUDE.md · Set up |

Rules:

- The label never gives way: when the right side does not fit it wraps below
  the label, full width. A name is never truncated to nothing.
- At most one action per row, named by its outcome (`Publish`, `Compare`,
  `Set up`), and none when there is nothing to do: an item at rest shows only
  the `MoreMenu` (⋯) and the chevron. Never two buttons side by side.
- An item row shows name, one line of description, and chips for facts that
  matter at a glance (scope, which CLIs it reaches). Its detail opens as a
  sub-page, not as an expansion in the list.
- A long list gets a filter field above the group once it passes 12 rows.
- A disabled control says why in its hint line, not only in a tooltip.
- A row may carry **two controls** when they are one decision about one
  subject (a role's model and its reasoning effort). Never a control plus an
  action.

**Tidy tables** (A0, owner 2026-10-31). A `Group` is a table, and its rows
share its columns: main · value · action · more (⋯ and the chevron).

- **One action column per table.** Every action button stretches to the
  column, so all are as wide as the widest one and share one right edge.
- **Fixed ⋯ slot.** ⋯ is always last, one square; once any row of the table
  has one (or a chevron), every row keeps the slot.
- **Values and actions in separate columns.** Status words and controls go
  in the row's children, never in `action`; a row with no button never
  shifts the others — its value or control stays flush right, across the
  action column, whose width comes from the actions alone — and a row with
  nothing on its side lets its label take the row.
- **One action.** One button in `action`; anything else goes in ⋯.
- **A row a mouse press opens** (1.174.0, A5: an Inbox row and its card)
  takes `onPress`: the one action stays the keyboard's way in, with no
  chevron. `onOpen` is for a row whose label is the way in. A row seen and
  no longer asking takes `muted` (its label in `--muted`, never opacity).
- **One button size per table.** No `size="sm"` beside normal buttons in one
  `Group`; no width, min-width, max-width or padding on a row's button, inline
  or by a class. Icon buttons are all the same square.
- **The whole table wraps together.** When the columns leave less than 260 px
  of label, every row at once puts its value on a line under the label, then
  its action and ⋯ (`useTidyTable` decides for the table, never a row).
- **The tables of one `Section` share their button width** (1.176.3, owner
  2026-11-23): every `Section` wraps its tables in `TidyColumns`, so all
  action buttons in a section are as wide as its widest and end at one right
  edge. Only that: the ⋯ slot stays each table's own (a chevron in one table
  never reserves a slot in the next), and nothing is shared across sections
  or with a `Sheet`.
- **Vertical alignment.** Each cell is one control tall and centred on the
  label's first line, however long the hint.
- **Labels short and alike.** At most two words and one verb (`Open`, `Bring
  in`, `Remove`); the rest goes in the hint.

Use `Row` in a `Group` and nothing else: no custom button widths, no raw
`<button>` in `action`. `src/lib/tidyRows.test.ts` enforces it (a baseline
that only goes down). A row outside a `Group` (a sheet, a flow) keeps the
single-row layout above.

## 4. Status, errors, Details

- `StatusLine` — one sentence with a run-state colour dot: what is true now
  ("Shared from `staging`, last changed by Matteo 2 hours ago").
- Errors follow one shape: **what happened · what was left untouched · what
  to do**, with up to two actions (one per way out), then `Details` with the
  raw output. A destructive way out moves things to the Trash, never deletes. Example: "Local staging can't
  be updated. `SKILL.md` here differs from the one on staging; nothing was
  changed. Publish your version or delete the local copy."
- `Details` — a disclosure, closed by default, holding paths, SHAs, commands
  and raw tool output in `--page-mono`. It is the only place they appear
  first-hand.
- **A GitHub read that needs a sign-in** (N14 walk F16). When a read's raw
  errors come down to "the GitHub CLI isn't signed in" (gh's `gh auth login`,
  "not logged into any GitHub hosts") or "Git couldn't sign in to GitHub"
  (`GIT_AUTH_WORDS`, GCM on Windows), the status says it in **one plain line**
  — "The GitHub CLI isn't signed in on this Mac, so Plyloft can't read the
  team." — with **one action** to Setup › GitHub for pull requests (`Sign in to
  GitHub`; `Open GitHub setup` for the git case; none over SSH), and the raw
  messages behind `Show details`. The classification is `lib/ghTrouble.ts`
  (gh signed out outranks the git case it causes; GitHub refusing gh's token —
  HTTP 401 Bad credentials — says the sign-in "has expired or was revoked",
  same action; errors neither explains, a 404, still show as they are); the
  drawing is `GhTroubleStatus`. Any surface whose raw error may be one of these uses both.
- Toasts confirm and offer Undo; they never carry the only copy of an error
  that needs action — that stays on the page as a `StatusLine`.
- **Where a whole operation's refusal lives** (GH #151, the owner's decision).
  When a refusal stops a whole operation the member pressed — Ship or Land
  refused because local `<branch>` can't be fast-forwarded — its block lives on
  the **surface of that operation**: the card's **Ship step**, for the card
  pressed (a batch: each of its cards). The toast (`announceError`) says what
  stopped — `Ship stopped: local staging can't be updated — nothing was
  changed.` · `Show` — and `Show` opens the card on that step. The block is the
  same one Sync draws (`LocalBranchBlock`, `on="card-ship"`), from the same
  report (items, paths, git's output, the folder flags), with the same two ways
  out; it adds only what stopped and "Then ship again." It goes when the
  refusal does — a Trash or Sync that clears it, or the next Ship of that card
  that gets past the fast-forward check (an attempt that never reached it — a
  PR, a verify still owed — leaves it). The Ship step announces it once: while
  it holds the block, a Sync that meets the same refusal refreshes it silently,
  and one that meets a different refusal says so in Sync's words on Sync's
  page. The refusal is one condition of the checkout, so the Library or
  Worktrees page still draws it too, as it would after a Sync, and only Sync or
  the Trash — which report the fast-forward itself — take that down. A
  refusal met by a background pass with no press behind it (Sync, a card
  start) stays on the page of the thing refused.
- **The dense error block** (GH #150) — *a declared deviation, on no board,
  pending the owner's Tier 4.* Under the two densities of the old PRINCIPLES §4
  (replaced by one scale, ADR 0007; the dense variant folds into the one
  ErrorBlock in C2), an error on a **work surface** is drawn at the card's density:
  `ErrorBlock density="dense"` (class `ux-error--dense`). Same structure,
  words, ≤ 2 ways out and bounded `Details`; only the measures change, each to
  a token the card already draws with — none is new:

  | Measure | Page (`ux-error`) | Dense (`ux-error--dense`) |
  |---|---|---|
  | Title, sentence | `--type-body` 15 / `--type-body-lh` 24 | `--text-md` 13 / `--type-small-lh` 18 |
  | Part label | `--type-caption` 12, sentence case | `--text-xs` 11 (the card's section label) |
  | Padding | `--page-space-lg` 16 | `--inset-x` 12 |
  | Radius | `--radius-group` 10 | `--radius-menu` 8 (the card's blocks) |
  | Margin above | `--page-space-lg` 16 | 0 — the surface's own gap places it |
  | Between parts | `--page-space-md` 12 | `--page-space-sm` 8 |
  | Actions, Details above | `--page-space-lg` 16 | `--page-space-md` 12 |
  | Under the output (`Open full log`) | `--page-space-md` 12 | `--page-space-sm` 8 |
  | `Details` pad · radius | `--page-space-md` `--page-space-lg` · `--radius-group` | `--page-space-sm` `--inset-x` · `--radius-menu` |
  | Dot, title gap, sentence gap, bounded output | 8 · 8 · 4 · 280 | unchanged |

  The spacings step one down the 4 · 8 · 12 · 16 scale, to the 12 / 8 / 4 the
  card's own panels space by. Buttons need no change: outside a `Page` or the
  Settings surface the `.cbtn` is already the work-surface control. Drawn
  dense: the card's Verify failure (`VerifyFailureBlock`), a timed-out or
  stalled run's `What the steps reported` (`VerifyStepOutput`, class
  `ux-error-details--dense`), the Ship step's refusal (`LocalBranchBlock
  on="card-ship"`; the same component stays `page` on the Library and
  Worktrees), and the Ship step's unpublished release (GH #222,
  `UnpublishedReleaseBlock`). Every page keeps the default. `uxError.test.ts` lists the files
  that use it and holds its values to those tokens.

## 5. Saving and publishing

- **This Mac** — every control saves as it changes. A toast offers **Undo**
  for a few seconds. Each page ends with "Reset this page to defaults". No
  Save, no Discard.
- **Repository / Team** — controls edit in place and mark the row as changed.
  The `PublishBar` rises from the bottom: "2 changes · reach everyone who
  opens this repo" — **Review** lists old → new per field, **Publish to
  staging** makes one commit, **Discard** drops them. While a publish waits
  (offline, a pull request) the bar says so and the rows keep their mark.
- **Read-only** — when the account can't write, the page says it once in a
  `StatusLine` under the header, controls show values without affordances,
  and each row's hint names who set it and when.

## 6. Procedures and flows

A `ProcedureRow` states the current condition and offers the one step that
changes it. The step opens a `Flow`: a focused surface (same shell, no
navigation) with what will change, a comparison when files are rewritten,
and a single confirming action. When it ends the row tells the new condition
and the flow is gone. The Dependency Doctor, the move to `AGENTS.md`, adoption
and licence entry are procedures.

**Shown where it opens** (N14 walk F6). A flow, plan or refusal that opens or
fills in on a page in answer to a press is brought into view — smoothly,
instantly under `prefers-reduced-motion` — and its heading takes focus
(`useReveal` / `revealElement` in the layer; a heading gets `tabIndex -1` and
draws no ring). A flow whose first field has `autoFocus` only scrolls. A line
that only has to be seen (a seat refusal under a list) scrolls `nearest`
without moving focus. Sheets are modal and need none of this.

## 7. The rest

- `EmptyState` — one sentence on what belongs here and the action that
  creates the first one.
- `DangerZone` — the last group of a page, separated, each row naming what is
  lost ("Reset all settings on this Mac").
- `DuplicateNotice` — on an item that also exists at another scope: "Also in
  Team" with **Compare**.
- `AvailabilityChips` — only the CLIs a skill reaches are drawn. When a whole
  section reaches one CLI, the section says so once ("All 34 reach Claude
  only.") beside **Make all available to both**; the row's menu has "Make
  available to both".
- `Segmented` — two to four exclusive choices, all visible (the Library's
  `Instructions | Skills` at a narrow centre, `Claude | Codex` in Claude
  and Codex). More than that is a `Select`.
- `ChangedMark` — a row changed and not yet published: no edge (E4, owner
  2026-10-28): the numbered badge before the label, the control's border in
  `--fg`, and the hint "Changed here, not published yet — was …" in ink.
  Never colour alone.
- `SearchResults` — what a search field on top of a navigation found (GH #107,
  BOARDS.md §6): "Results for model", the count in words, then one group per
  scope with the scope named, and one result per row — the label, the path it
  lives at ("This Mac › Claude and Codex › Claude") and the value it holds now in
  mono. A match found only in that value ranks last and says why ("mentions
  model in its command"). While the field holds text the results are drawn in
  the page area, full width, one row each under a hairline, with the
  navigation still beside them; the page stays mounted underneath, hidden
  (UX-9.4). Opening a result, or choosing a page in the navigation, clears the
  field. Landing marks the row: an ink outline and the words
  "Found here" beside the label, both gone after two seconds — no colour, no
  flash, and nothing stored.

### The state words (one vocabulary, QoL 1.168 block 8, owner D13)

One word per state, the same on every surface — the Board, the List, the
Inbox, the sidebar, the stack, the switcher, notifications and toasts.
`scripts/ux-check.mjs` refuses the retired forms (§9).

| Word | Means | Never |
|---|---|---|
| **Needs you** | The person must act: answer, decide, read a result, fix a failure, resume, ship. | A draft; a card nobody started; a session nobody typed into. |
| **Not started** | A card nobody has started: a draft, a brief ready to start. Its own Board column; out of every "needs you" count. | — |
| **Working** | Claude, Codex, a run or the checks are doing something now (the Board column, the Inbox group, the stack's "3 working", a tile's "Working for 12s"). | "Running" for an AI's work. |
| **On hold** | Nothing runs and nothing is asked of the person: in line for a free slot, paused, held by a card it depends on or by a teammate, a pull request open on GitHub. The Board column (its id stays `waiting`). | "Waiting" or "Queued" as the column's name. |
| **Ready** | An AI tile at its prompt with nothing asked; a card's *Ready to start* / *Ready to ship*. | — |
| **Running** | Only a program: a shell tile's process, one check step. | The Inbox's group, a card's AI. |
| **Failed** | A run or the checks failed. | — |
| *waiting for you* | Only ever "for you": "Claude is waiting for your answer". A progress phrase that says for what ("Waiting for the payment…") is plain English. | "Waiting" alone as a state, a column or a count ("3 waiting"); the switcher says "3 need you". |
| **Open session** | Opens a Claude or Codex session that is still running — the Inbox, the card, Resume…, History › Sessions. | "Show it", "Show" for a session. |
| **Resume** | Brings back a session that ended. | — |

## 8. Surfaces

- **Settings** — a large modal, resizable, its size remembered on This Mac;
  default about 1100 × 90 % of the window, least 820 × 560. Opened with ⌘,
  and by deep links; Esc closes — a flow first, then the search field, then the
  surface. Navigation by scope with a search field on top (⌘F focuses it).
  Below 900 px wide the navigation collapses to a menu in the header and the
  field goes with it. Settings reopens on the page it was on when it last
  closed (`settings.json` › `windows.settingsPage`, UX-9.4).
  - **Navigation (C9, UX-9.3; by task since 1.174.0, D8 b)** — five groups,
    each named in sentence case with its icon: **Look and feel** (Appearance ·
    Editor and terminals · Notifications · Dictation), **Cards** (AI and models
    · Building and checking · Shipping), **Project** (General · Areas · Cards'
    copies), **Team** (Members and library), **Setup and account** (Setup ·
    Diagnostics · Plan · Profile). The ids did not change (`claude-codex`,
    `build-release`, `board-worktrees`). Every entry is always shown, with two
    exceptions (onboarding C3):
    - **The Team group** is hidden in solo mode (Account › Setup › Work with
      a team off; onboarding §10, OB-9).
    - **The Licence part** is hidden whenever no key is stored on this Mac,
      in either mode, while teams are free (onboarding D15, OB-8); the entry
      is then named **Profile** (`settingsNav.entryWords`). With a key stored
      it is drawn in solo mode too.

    A page with nothing to show says so on the page. In solo mode a link to a
    Team page — or, with no key stored, to the Licence part or its key flow —
    opens Account › Setup with `Work with a team` marked *Found here* and a
    status line saying why (`settingsNav.linkHiddenInSolo`), and the search
    and ⌘K leave those pages and rows out. In team mode a link to the key
    flow (`licence-key`) still opens it, the only way to paste a key while
    the part is hidden. The line above a page's title is its
    group's name and icon, set once by the router (`ScopeLabelProvider`), so a
    page can never claim a group it is not in. Where each section's rows are
    kept is its `ScopeMark`, never the group's name.
  - **Merged pages** — a thin page joins a fuller one: as sections (Startup's
    `Window` on Appearance, Reset as Diagnostics' danger zone), or as a *part*
    under its own `--type-heading` title, lede and status line (`MergedPage`:
    Worktrees on Cards' copies; `PartsOf`: Board on General, under its rows).
    A part's flow takes the whole page while it is up. Notifications, a part
    of Claude and Codex until 1.174.0, is a page again under the same id. Every old id —
    an entry, a merged page, a sectioned-Settings section, a retired page —
    still opens the page that holds it (`settingsNav.ts::settingsLinkTarget`),
    and a search for a merged page's name finds that page.
- **Library** — a centre mode beside Board, Code and Terminals. Left: scopes
  and kinds (Instructions, Skills; UX-9.5 retired Notes, whose notes stay on
  disk). Right: the list, then the item as
  a sub-page. Text is edited in Code; the Library reads, compares, publishes,
  promotes.
- **Shell** (C3, the Shell board) — the window's title bar is an overlay:
  the traffic lights sit over the sidebar's top strip, which drags the window
  (a double-click zooms), as does every screen header. The sidebar is 240 px
  (200–320, remembered on this Mac; ⌘\ hides it; below 1000 px it floats
  over the stage): the workspace switcher, Search · Inbox · History, the
  workspace's Board · Code · Terminals · Library under its name, then the
  foot — status rows (a dot, one sentence, one action word: "Ply 1.150 is
  available · Install", "git isn't installed · Fix", "Draining for ship ·
  Cancel"), "Ship N in a batch" when the Ship batch has cards, Settings. Nothing
  floats over the window as a banner. Every mode opens with `ModeHeader`
  (`ScreenHeader` plus the sidebar button). ⌘K is the one search surface,
  its scopes Commands · Files (⌘P) · In files (⌘⇧F) · History (⌘⇧H); ⌘/
  lists every shortcut from `src/lib/shortcuts.ts`, the list the key handler
  matches with.
- **Terminals** (C8, the Terminals board) — two header controls: **New ▾**
  (Shell ⌘T, Claude ⌘⇧T, Codex ⌘⇧X, Codex chat, Several sessions at once…; `MenuButton`,
  shortcuts at the row's end) and the ⋯ (Close all completed, the layout
  presets, Back to the Board). A tile header is 28 px: the mono kind glyph
  (`$` `--shell-accent`, `✦` `--claude-accent`, `◆`/`◈` `--codex-accent`),
  the label (`--type-small`; the cwd is its title), then the status on the
  right as a dot and words — one pure place, `lib/tileStatusLine.ts`:
  running `--signal-running` (pulsing dot), "Starting…" until a session's
  first Ready, Ready as words, an error end ("Ended · error code 1",
  "Stopped unexpectedly") `--signal-aborted`, "Ended" or "Ended with
  Ctrl-C" muted (the code in words in the tooltip) beside a quiet Restart —
  or, for Claude and Codex, Continue and Start fresh (QoL 1.168). A
  working PTY tile with no output for `IDLE_WARNING_MS` (10 minutes) reads
  "No output for 10m" in `--warn` until output resumes. Rename,
  expand/restore and close are `Icon` buttons that appear on hover and stay
  while the tile has focus; dictation is "Listening" with a dot. The tile,
  the pane, its search and command blocks are `components/terminals.css`, on
  tokens only; xterm's ANSI palette is per theme (`lib/xtermTheme.ts`),
  readable on `--term-bg`.
- **Code** (C8) — the header names the open file: its folders after
  `Workspace › Code`, its name as the title, the absolute path only in the
  title's tooltip; Preview is the one action. Editor tabs close from a real
  `Icon` button; the file tree's rows take the keyboard (↑ ↓, Enter, → ←).
  A file Code cannot open as text (binary, over 5 MB, not UTF-8) opens a
  page in its tab — "Ply can't open this file here", the reason in words,
  Reveal in Finder (`fs_reveal_in_workspace`, inside the workspace only) —
  never an error toast; ⌘S there writes nothing. `lib/openInEditor.ts` is
  the one way a workspace file is read into a tab.
- **Inbox** (C4, the Inbox board) — a page in the 880 px column under
  `ModeHeader` (Mark all seen, Refresh in the `⋯`). One sentence sums it up
  ("3 things need you, 1 failed, 2 are running." / "Nothing needs you."),
  then only the groups that have something — Needs you · Failed · Running ·
  Scheduled — each a `Section` with its count over a `Group` of rows at least 44 px tall
  split by hairlines: state dot, workspace chip, title over a detail of up
  to two lines (clamped; its full text is the line's tooltip and describes
  the row's buttons, N19), when, and **one** action (Review, See what failed, Open session, Copy link, Fix with the Builder; a chevron
  when there is nothing to decide). A review with a P1 open says so in the
  detail line, "1 serious issue · changes requested", in 600 and `--fg` —
  weight, never a colour or a notification (CL-3); the card's result names
  that finding first in an info `Callout`, "Serious issue · <title>" ("From
  the last review · …" once commits came after it). The P1 tag stays inside
  the findings list. A group shows 12 rows, then "Show all
  N". Seen rows stay, their title in `--muted`. Ships are never rows: one
  quiet line, "N shipped this week · History", opens History.
  - **One attention signal (UX-4.4)** — a Claude or Codex session idle at
    its prompt (a tile, or a card's Builder) is a Needs you row, first:
    "Claude is waiting for your answer" · "In “<tile or card>”", Open
    session. The sidebar's Inbox count is the one number for what needs you
    — unseen Needs you and Failed items plus waiting sessions
    (`lib/needsYou.ts`); the switcher splits the same sum by workspace and
    the dock shows it, and the page's sentence splits it into "N things
    need you" (unseen Needs you items and waiting sessions) and "N failed"
    (unseen Failed items) — seen rows stay on the page but count nowhere
    (`attentionCounts`); the Needs you and Failed section headers say the
    same two numbers. A waiting session is one whose card still has it: a
    session closed, ended or replaced is no row (`builderSessionGone`).
    QoL 1.168 (D7): a tile waits when it asks (a decision, trust, bypass,
    a Codex approval: "Claude is waiting for your answer") or after a
    finished turn not seen yet ("Claude finished · see what it did", in the
    Inbox, the stack and the notification); a seen turn
    and a fresh tile are no row, and a usage limit is a row in `--muted`
    that counts nowhere (the stack's grey "limit" item, never working). What is on screen is seen: a card's page marks its
    rows, the Terminals in front mark their tiles' turns. No surface counts
    attention any other way.
- **History** (C4, UX-4.5) — the sidebar's History entry (the centre mode
  keeps its id, `activity`): `ModeHeader` "History", a one-line lede, the
  numbers as a `Properties` facts block (runs, checks passed, shipped,
  spent, typical run, spend by workspace — what the Inbox footer and the
  Activity tiles showed), then a `ListView` across workspaces: Title ·
  Workspace · Result (`StateWord`) · Cost when known · When. A row with a
  card opens it; one without is plain text (`ListView`'s `canOpen`). No
  stat tiles, no uppercase.
- **Board** (C5, the Board board) — four columns **by attention**, derived
  from each card's lifecycle state on every render
  (`boardSemantics.ts::STATE_ATTENTION_COLUMN`; the persisted `columnId` is
  not migrated): **Needs you** (result or ready to
  ship, checks failed, stopped, changes requested, review out of date — only
  what asks the person to act), **Not started** (draft, ready to start; owner
  D13, QoL 1.168), **Working** (planning, running, checks, Challenger
  reviewing, shipping), **On hold** (in line, paused, held by a blocker that
  has not shipped or by a teammate, a pull request open on GitHub; its id is
  still `waiting`), **Done**
  (shipped; and **Closed**, GH #243 — a card in Complete that never ran, has
  no checks on record and never landed, as GitHub sync leaves a card whose
  issue was closed: history, with an empty dot, and no Inbox row). Precedence when two apply: Needs you > Failed > Working >
  On hold — Failed lands in Needs you, also from Not started. Headings are `--type-subheading` with
  a count. A card is raised, `--radius-md`, its 14 px title wrapping to three
  lines, then one fact line: `StateWord` and at most one fact (`6m`, `v1.150`,
  `#42`); no branch or provenance on the card. **Drag** only reorders within a
  column (`boardOrder`) or archives (on Done or the archive row); across
  columns it is refused with why — a drag never starts, stops or ships.
  Delete and archive leave at once with **Undo** for 8 s and are written when
  it ends; a move's Undo puts the order back. The header: Board | List ·
  Find a card (`/` or ⌘F) · filter (Needs you, state, Builder — combined) ·
  Ship N (when N > 0) · New card · ⋯ (Discuss, Sync). The List
  (`BoardList`) is the same filtered cards grouped by the same columns:
  Title · Status · Builder · Checks · Updated, sortable, with Ship selected.
  CL-9: on the List only, a muted "Group by" then `Segmented` "Group the
  list" — **By attention** (the columns) | **By stage** (To do · In progress ·
  In review · Ready to ship · Finished, from the lifecycle state; an open pull
  request and a verified result are Ready to ship; Finished, not "Done",
  which is an Attention word), remembered per workspace on this Mac. By
  stage adds a sortable Attention column (dot + Needs you / Working /
  Waiting / Done); within each stage what needs the person stays first,
  whatever column the rows are sorted by.
  Done shows the latest ten and "Show all N"; a card shipped more than 14
  days ago is archived on its own (not on a read-only board), and Restore in
  the archive brings it back for good.
- **Card** (C6, the Card board) — the opened card is a page over the Board
  (`CardDetailPanel`, one warmed host per workspace): `ModeHeader` with
  `Workspace › Board › <title>` (Board leads back), the title in `display`
  30 px, edited in place, and a `⋯`; then, in the 720 px column (two
  columns on a wide page, see **Wide card page** below),
  `Properties` — Status (`StateWord`), Builder, Checks, Challenger (CL-1:
  the vendor and its word, "Codex · nothing blocking"; "Claude · same vendor ·
  …" with one AI set up, "Claude · same vendor (Codex unavailable) · …" when
  the other was unavailable; never the model), Issue (`#n`
  in mono; a click copies its link, Ply opens no browser) — with branch,
  base, worktree, snapshots and model ids under **Technical details**. The
  state is said once: the Status property and the **Now** callout
  (`CardStateHeader`, `Callout kind="now"`), whose title, helper and one
  primary action come from `cardLifecycle.ts::CARD_STATE_PRESENTATION`, with
  at most one quiet alternative (Not right, Accept the Builder's pushback,
  Conclude intake, Ship anyway; Follow up on a shipped card, N19 — also in
  the ⋯ — which makes a new linked To do card: "Follows up <title>" in its
  Properties, "Followed up by “<title>”" in the shipped card's Activity). **Who is working** (CL-7,
  `lib/sessionActor.ts`): while a live session attached here builds, or the
  Challenger reviews, the title names the actor, its state and how long —
  "Claude · building · 4m", "Claude · waiting for you" at its prompt,
  "Codex · reviewing · 2m" — with the dot that matches; a session this
  window can't read keeps the plain state, Plyloft's own phases (checks,
  shipping) keep their words, and the live region announces the plain
  state, never the clock. Build with both names each build ("Claude ·
  building · 4m. Codex · waiting for you."), and SP-3 draws both builds
  as cards under Now from the start (`BuildBothCards`): while one builds,
  its card says what its session is doing, when it started, **Open
  session** (that build's terminal, in the session section) and **Build
  done**; once both are done the same cards carry the comparison and the
  Picks. The terminals stay in the session section, the one not shown
  laid out and hidden as a closed section. The sidebar's Builder rows say
  the same words under the card's name; the Board keeps "Working · 6m". A Ship primary is a split button, **Ship it
  ▾** (`SplitButton`), whose menu holds Ship as a PR. Then **What you want**
  (the brief, editable), then **Activity** — a `Timeline` built from what the
  card records (`lib/cardPage.ts::cardTimeline`: created, planned, build
  started, snapshots, checks, the review, ships, archive and restore), one
  link each. CL-5: each review round the card keeps is its own row, "Round 2
  · Codex · nothing blocking · 2 closed" (amber for changes requested or
  couldn't see enough, green for nothing blocking), whose "See its findings"
  opens the review narrowed to the findings that round stored (raised,
  closed or still open in it) with "Show all findings"; past four rounds the
  older ones fold into "N earlier review rounds · Show them" (focus moves to
  the first revealed round). Rounds the card has no record of are a muted
  line, "Rounds 1–4 weren't recorded", never a silent jump; when the
  findings ledger started over, "The findings of earlier rounds are no
  longer kept" and the older rounds have no link. Cards from before CL-5
  show their latest review alone. The `⋯` holds everything else: Plan again,
  Build with the Builder instead (a Todo card that still carries an agent;
  G4 took the runner pickers and Brainstorm), the follow-up ships, run history, Release…, Archive (with
  Undo) and Delete card…; the body has no destructive action.
  - **Sections that stay mounted** — the intake conversation, the Builder
    (or swarm) session, the result (`OutcomeScreen`: the review — under its
    verdict the skills it followed as neutral `.cchip--outline` chips after
    "Followed", what each asked behind Details (CL-2) — checks, one
    "Overlapping edits" callout (`.ux-conflict`, the warning icon), **See
    the diff**; Not right and Ship as a PR with Merge when checks pass only when
    the Now callout does not already offer them (SP-2: ready to ship, Now's
    "Not right" opens the result's form and its Ship ▾ holds the pull
    request; result ready and nothing changed keep Ship as a PR in the
    result, "Working with a team?" in its title), **The diff** (SP-1 phase
    2: `CardReviewPanel` — the hunks, the findings anchored on their lines,
    line comments, the round switch, Accept/Reject — moved out of the
    result into its own section, mounted while the result has a diff) and
    Shipping (receipts and a stopped
    ship's block) are `CardSection`s: always mounted, shown when opened —
    the session and the conversation by the Now action (`Open session`,
    `Open the conversation`), the rest by a Timeline link; one at a time,
    none by default (`uiStore.cardStep`; the Inbox's `Open session` opens
    the session) — with one pair: the result and its diff open together
    (`uiStore.cardDiffOpen`, held only while the result is the open step;
    any other step, or Hide on the result, closes the diff). "See the
    diff" in the result, Activity's "See the diff", Checks' "See the
    result" and a finding's "Show on the diff" open the pair; the diff's
    own Hide (or "Hide the diff") closes it alone. Closed, a section has no height and its body keeps its
    laid-out size, invisible and inert, so a terminal keeps its PTY, its
    scrollback and its grid. A finished intake reads as plain text (its plan
    and transcript, `IntakePlan`); a live one is the terminal — Ply keeps no
    transcript while it runs, nor of the Builder, whose callout says what the
    session reports in words (started, last output, at its prompt, files
    changed).
  - **Wide card page** (SP-1, layout board approved 2026-10-01) — below
    1200 px of page width the page is the one 720 px column above. Above
    it (`@container ply-card-page (min-width: 1200px)` in `ux.css`; the
    board's ~1000 was approximate — 1200 keeps column 2, the session, at
    ~560 px or more) the
    body is a grid: column 1, 560 px, keeps the title, Properties, Now
    (with the Build-with-both cards under it, still side by side: they
    stack only below 520 px), What you want, Activity,
    the plan and the Details; column 2 holds the one open slot section —
    the conversation, the session, the result, the shipping — at its top.
    CSS only: no section changes parent, so a terminal is the same element
    in both layouts and only its width changes. All four slot sections
    share column 2's area, the closed ones laid out there invisible, so a
    session opens at the width it already has. The conversation and the
    session are sticky while column 1 scrolls only on a window at least
    860 px tall (`@media (min-height: 860px)`), where the whole section
    fits: the Builder's terminal is the window's height less 340 px, never
    under 480, so on a shorter window a stuck session would hide its own
    end. The result, the diff and the shipping are never sticky, for the
    same reason. Nothing in either column scrolls on
    its own; the page keeps its one scroll and its stable gutter. The
    Release flow over the card stays at `--page-column`, the body laid out
    behind it at full width. Phase 2: with the result and its diff open
    together (`data-ply-card-pair` on the body), the result moves to column
    1 under Now — What you want, the Activity, the plan and the Details
    follow it there (`order`) — and the diff takes column 2 beside it. On a
    narrow page the diff reads after the result, as it did inside it.
    In both, "The diff" grows with the page: its hunks have no height of
    their own (CL-6's 320 px hunk box, which predates SP-1, stays only
    where the diff is folded inside the result's "See the diff"); a long
    line still scrolls sideways inside its hunk, never the page.
    Accepted trade-off: in that pair view only, the keyboard's focus order
    is the page's (What you want and the Activity before the result) while
    the result is drawn above them; moving the result in the JSX would
    remount `OutcomeScreen` (its Ship runner, the line-comment drafts) and
    change the narrow reading order. While the result is refetched (after
    a build, a review) the diff keeps its last offer, so the pair does not
    reflow and the diff panel stays mounted; only a loaded result without
    a diff closes it.
  - **Release** (UX-6.7; 1.174.0 DR3) — `⋯ › Release…` opens the one
    Release sheet (`ReleaseSheet`, the same one every Release… opens) on the
    card's area with the card ticked: what's in it (the cards on the branch
    since the last tag, the other changes folded), the ready cards not there
    yet, the version (patch first), how far it goes (`ChoiceList`), one
    summary line, what holds it back in sentences, and under Technical
    details the release branch, the tag, the checks and Release without
    checks. Focus on Cancel, one filled button with the real tag; the card's
    page stays as it is under the sheet.
  - **Errors** (UX-6.8) — every error the card shows is an `ErrorBlock`
    (dense), its words in `lib/cardPage.ts`: a press that failed, planning
    that could not start or stopped, a Builder press
    (`builderStore.errorByCard`), a Ship from the result, a diff or
    transcript that could not load. Raw text is only under Details; a toast
    says it happened and carries the raw reason to Copy.
- **Dependencies** (C7) — a card waits for other cards of its workspace
  (`blockedBy`, `lib/cardDependencies.ts`, mirrored by `kanban.rs`). Until
  every blocker has landed (shipped or merged; an archived or deleted one
  holds no one), a card that has not started (a draft or ready card in Todo)
  is **held**: the Now callout says "Blocked" and what it waits for, its Plan
  or Start stays, off, with "Starts when “<title>” ships." (the backend
  refuses the same start in `intake_start`, `builder_start` and the advance),
  it sits in **Waiting**, and the Board card's one fact line and the List's
  Status say "Blocked by #n" (or the title) with the `blockedBy` icon. When
  the last blocker ships it is back in **Needs you**, "Ready to start" —
  nothing starts it. The card page's properties say **Blocked by** (each
  blocker a link, a way to stop waiting, and Add — a picker searching this
  workspace's cards, never the card itself, an archived card, one chosen or
  one that would close a cycle) and **Blocks** (the cards that wait for it,
  as links). A cycle is refused when it is written, with nothing saved; a
  delete takes the card out of every Blocked by.
- Nothing is pinned to the right of the centre.

## 9. The component layer and the check

`src/components/ux/` exports the components named above; their classes are
prefixed `ux-`. `.cbtn`, `.cicon` and `.cchip` (v1.78) stay the buttons and
chips and are restyled by the page tokens inside a `Page`.

`docs/ux-language/migrated.json` lists the files that have moved to the
language. `scripts/ux-check.mjs`, a step of `scripts/ppvp.sh`:

- **fails** when a migrated `.tsx` uses a `className` outside `ux-*`, `cbtn*`,
  `cicon*`, `cchip*`, or a raw `<button>`/`<input>`/`<select>` instead of the
  layer's; and when the CSS of the `ux-` layer holds a colour literal or a
  spacing that is not a token;
- **counts**, for the rest of the app, button families, panel families and
  colour literals, prints the three numbers and fails if any of them rose
  since the committed baseline;
- **counts per file** (UX P-D1, `docs/plans/UX_P1.md` point 6) the
  developer words in visible copy — worktree, snapshot, origin, stash,
  rebase, fast-forward, PATH, CLI, sandbox, SHA, HEAD, diff, Build done,
  and since QoL 1.168 block 8 hunk, swarm (a *multi-AI run*), vendor (*AI*),
  intake (*planning conversation*), upstream, checkout (*your project
  folder*, *the card's copy*; a payment page is *the payment page*),
  Un-ignore (*Let Git see it*), plugin, manifest (*the team's member list*),
  prune, cleanupPeriodDays, OSC 133, an exit code ("exit 1"; the code goes
  behind Details or reads "code 1"), "into main" (*into your project*), a
  severity code (P1 → *Serious*, P2 → *Should fix*, P3 → *Minor*) and
  "Waiting" alone as a state (the state words, §7), and since 1.174.0 (B3)
  the Reviewer's other names ("second AI's review", "a second AI checks",
  "second pass" everywhere, and "second opinion" everywhere except Next
  improvement's own files and the glossary — it is Next improvement's word
  for its separate pass, owner D11), "Verify" as the name of a step (*your
  checks*; the verb with its object is English), "repo" (*repository*; not
  `gh repo …`, a `-s repo` scope or an `owner/repo`) and "uncommitted"
  (*changes that aren't saved*). These seven are read in every string with
  a space in it, not only at copy positions (agent prompts, `details` and
  the technical surfaces still aren't read) —
  and the raw caught errors shown inline (`setError(String(e))`,
  `` hint: `…${e}` ``, `{String(e)}` in JSX), and fails when a file's count
  rises, unless the total does not rise (a move between files); a fall or
  a move fails until `--write-baseline` records it in the same change, and
  so does a new `ux-allow` marker (counted per file, so each one shows in
  the baseline's diff). Copy is
  JSX text, the values of the copy props and keys (`label`, `title`,
  `hint`, `body`, `happened`, `todo`, `footnote`, any `…Label`/`…Title`/
  `…Note`, …), `notify(kind, title, body)`'s title and body, a
  `machineWords(…)` argument, `…_LABEL`/`…_WORDS`/`…_MESSAGE`/… constants,
  any other UPPER_SNAKE constant that is a sentence (not a `…_MARKER`), and
  the strings returned by functions named `…Line`, `…Words`, `…Message`, …;
  a template's `${…}` code is never read. Allowed: a
  `details`/`copyText` value, a `<Details>` child (not its `summary`), a `[Plyloft]` message to
  the agent, a `…_PROMPT`/`…_BRIEF_FOR_AGENT` constant, the files and
  functions in `docs/ux-language/technical-surfaces.json`, and a line marked
  `// ux-allow: <reason>` (at its end, or alone on the line above). Pull
  request, branch and commit stay plain words. `--list` prints every hit;
  `--write-baseline` never raises a count.
  **The gap (QoL 1.168 block 8, Challenger M4):** a string in `src/lib` or
  `src/store` reaches the person without the checker reading it when it is
  returned by a function whose name doesn't say copy (`builderFact`'s "A
  swarm"), or passed as a plain argument (`counted(n, "swarm", "swarms")`).
  Reading every literal there would also read ids, events and log lines
  (`"intake-live"`, `"board-worktrees"`, `console.error` prefixes), so it
  isn't done; a copy function gets a copy name, and a review of new words
  covers these two shapes by hand.
  **A new banned word (B3, 1.174.0)** starts from today's hits:
  `ux-baseline.json` lists the words its counts were taken with
  (`jargonWords`), the run names a word it doesn't list, and
  `--write-baseline` records that word's hits once — a known word still may
  never rise, and a word taken out in the same write as a new one is
  recorded is refused (a rename would carry the old word's hits over). The
  write is all or nothing: `migrated.json` and the baseline are written
  only when the registry has no problem and no count is refused. The hits are then fixed card by card, with the owner's text.
- **error toasts** (B3, 1.174.0; UX audit G10) — every object literal in a
  `pushToast(…)` call (a ternary's branches each) whose `kind` can be
  `"error"`, with a `title` and neither a `body` nor an `action`, is
  counted per file (`bareErrorToasts`) by the same ratchet: an error toast
  says what happened and what to do next. A toast passed by name or built
  with a spread is not judged;
- **agent words** (B3, 1.174.0; UX audit G3, G19) — the Reviewer's old name,
  "Challenger", in any string literal of `src/` (not JSX text: that is copy,
  above) or of `src-tauri/src` and its crates (not test modules or
  `*_tests.rs`), counted per file (`agentWords`) by the same ratchet. A
  prompt says "You are the Reviewer"; the lines left are the ones that read
  text saved before the rename (`reviewer_words`, the old pull request
  line). Lower-case ids (`challenger-reviewing`, `claude.challenger`) are
  never counted.

A file is added to `migrated.json` by the card that migrates it, never removed.

**Every component is registered (VC-6, 1.174.0).** Each `.tsx` under
`src/components` (not the layer, not a test) is in exactly one of
`migrated.json`'s three lists, or ux-check fails and says which list to use:

- `files` — it passes the strict rules above and is held to them. A file
  renamed or moved keeps its entry, changed to the new path;
- `pending` — `{ "file": problems }`, a file that doesn't pass yet, with its
  count of problems under the strict rules. The count may only go down: a
  new problem fails. `--write-baseline` records a fall and moves a file that
  reaches 0 to `files`; it never adds a file or raises a count. The ratchet
  holds the count, not the list: fixing one problem while adding another
  keeps the count and passes. A file renamed or moved keeps its entry and
  count, changed to the new path;
- `legacy` — the closed list of the files there before the ratchet. Nothing
  is added to it: `ux-baseline.json` keeps the list as `legacyComponents`,
  which `--write-baseline` only shrinks, and a `legacy` entry it doesn't hold
  fails. A file leaves it for `files` when it is migrated; a legacy file
  renamed or moved goes to `pending` under its new path, with the count
  ux-check prints for it.

A new component therefore goes in `files`, or in `pending` with the count
ux-check prints for it.

## 10. One-scale primitives (UX-2.3, ADR 0007)

The Design System v2's proposals, in `src/components/ux/Screen.tsx` and
`ListView.tsx`. They are built on `--type-*`, `--space-*` and `--radius-*` and
are the only way to draw these things on a surface that has moved to the one
scale.

- **`ScreenHeader`** — the top of every screen in the stage: `crumbs`
  (Workspace › Mode; the last one is the screen and never a link), `title`
  (`size="display"` on a card page), and `actions`: at most one primary and a
  `⋯`. It replaces per-mode toolbars.
- **`Properties`** — up to eight facts under a title, label left in `--muted`,
  value right; a state value is a `StateWord`. A branch or SHA is a property
  only inside `Details`.
- **`StateWord`** — a run-state dot and its word; `live` pulses the dot.
  Never colour alone.
- **`Callout`** — `now` (what is happening and the one action), `info`,
  `warn` (announced; amber is failure), `danger` (only before destroying
  something). One sentence, one helper line, one primary action.
- **`Timeline`** — events oldest first: a state dot, the sentence, the time,
  and at most one link into the thing that did it.
- **`Popover`** — a panel under its trigger; a click outside or Esc (first,
  before the surface under it) closes it.
- **`Flow`** — the focused procedure, with its step line in sentence case
  (`step="Align · 1 step"`). Replaces the hand-assembled `ux-flow-*` markup as
  each flow moves.
- **`StepList`** and **`ProgressBar`** (OB-4, `Steps.tsx`) — a guided
  procedure's numbered steps as a `nav` (the current one `aria-current="step"`,
  each with its `StateWord` or nothing yet) and its progress as a thin
  `progressbar` in the accent. Setup (`SetupOverlay`) is the one user: a
  full-window surface over the shell (`ux-setup`), never instead of it.
- **`ListView`** — compact rows under a sortable header, optional groups
  (`Needs you · 2`) and selection (a checkbox on hover, kept once checked);
  the primary column wraps to two lines and opens the row.
- A confirmation is `Sheet size="confirm"` (`ConfirmDialog` is its thin
  wrapper; a destructive confirm is the one filled `--danger` button,
  `ux-danger-fill`, in `--on-danger`); a menu is `MoreMenu`/`MenuList`.
  Every modal is a `Sheet` (UX-10.1): `review` for a list of changes or a
  short form (Ship batch, a tile layout), `wide` for a workbench
  (the independent discussion). `canDismiss` keeps it up while a press runs;
  `initialFocusRef` names what takes focus. A destructive confirm (a filled
  `--danger` button anywhere in its foot) opens with focus on Cancel, the
  safe choice, so Enter never destroys by accident; a confirm that loses
  nothing may focus its confirming button. Its body text is `ux-sheet-text`,
  `ux-sheet-hint` (muted), `ux-sheet-alert` (a refusal, amber) and
  `ux-sheet-check` (a checkbox line). There is no `modal-card`.
