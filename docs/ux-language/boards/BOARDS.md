# Approved boards — build specification

Source: Claude Design project "Ply Design System update"
(`d5437019-9e3f-41cb-a10c-ac8f84abaa6a`), read 2026-09-17, approved by the
owner the same day. Three files: `Ply Shell - kit`, `Board 1 - Settings
Repository Build and release`, `Board 2 - The Library Skills`, `Board 3 - The
Library a skill`, `Board 4 - Errors procedures and This Mac` (3 and 4 read and
reviewed with the owner on 2026-09-17; §4–§5 record the boards **as
corrected** by that review, and say where they differ from the drawing).

This file is what a Builder works from: every number and string below is
copied from the boards. Where the boards and this file disagree with
[PATTERNS.md](../PATTERNS.md), PATTERNS.md has been corrected to match.

## 0. Values the boards fixed

| What | Value |
|---|---|
| Page title | 24 px / 600 / line 30 |
| Page lede | 15 px / line 22, `--muted`, 8 px under the title |
| Section heading | 17 px / 600; margin 32 px above, 12 px below; count on the right 13 px `--muted` |
| Row label | 15 px / line 20 |
| Row hint | 13 px / line 18, `--muted`, 4 px under the label |
| Controls, buttons, nav entries | 14 px |
| Status line, footnotes | 13 px / line 20 |
| Eyebrow (nav group, "Workspaces") | 11 px, uppercase, tracking 0.06em, `--muted` |
| Chip text | 11 px |
| Mono | `ui-monospace, 'SF Mono', Menlo, monospace`, 13 px (15 px / 600 for a skill's name) |
| Spacing | 4 · 8 · 12 · 16 · 24 · 32 · 48 px, nothing else |
| Radius | 6 px controls and chips · 8 px menus and segmented controls · 10 px groups · 14 px surfaces |
| Control height | 30 px (buttons, selects, search); small button 24 px; icon button 30 × 30 |
| Chip | height 18 px, padding 0 6 px, radius 6 px |
| Toggle | 38 × 22 px, radius 11; on: `--claude-accent` track, 18 px white knob right; off: `--panel-bg` track with `--border-strong` border, 16 px `--border-strong` knob left |
| Row | padding 12 px 16 px, min-height 44 px, `align-items:flex-start`, `flex-wrap:wrap`, gap 16 px; left part `flex:1 1 260px` (Settings) / `1 1 320px` (Library); rows separated by `1px solid var(--border)` |
| Group | `--raised` background, `1px solid var(--border)`, radius 10 px |
| Reading column | 720 px (Settings), 880 px (Library); padding 32 px 24 px 48 px; centred |
| Surface shadow | `0 8px 32px rgba(0,0,0,0.30)`; menu shadow `0 12px 48px rgba(0,0,0,0.35)` |
| Backdrop | `rgba(0,0,0,0.42)` |
| Running dot | 8 px, `--signal-running-fg`, pulse 1.4 s ease-in-out (opacity 1 → .4) |

Colours are the existing tokens only. Themes light, dark and void; accent
presets keep retinting `--claude-accent`.

## 1. The shell (kit)

- Title bar 32 px: workspace name 600, version in mono `--muted`. **No modes
  in it.**
- Sidebar 240 px, `--panel-bg`, right hairline. Padding 12 px 8 px.
  - Eyebrow `Workspaces`.
  - Active workspace row: 18 px rounded-4 colour tile with its initial, name
    600, `--tab-active-bg` (no left bar — E4, owner 2026-10-28).
  - Under it, indented 8 px, the modes, 14 px, padding 6 px 8 px, radius 6:
    `Inbox` (count pill: `--claude-accent` fill, white 11 px / 600, 18 px
    high) · `Board` · `Code` · `Terminals` (count in mono `--muted`) ·
    `Library`. The active mode is 600 on `--tab-active-bg`.
  - **Live sessions** sit under `Terminals`, indented a further 12 px: one row
    per session, 8 px state dot (running pulses, done, empty) then the name,
    13 px / line 18: `Card #88 · rollback tests`, `Card #87 · deploy notes`,
    and a plain shell in mono `--muted`: `zsh`. A click opens that session.
    CL-7: a Builder row has a second line, caption `--muted`, saying who is
    working — `Claude · building · 4m`, `Claude · waiting for you`,
    `Codex · reviewing · 2m` — and a build of a card built by both is a row of
    its own (`Card #88 · rollback tests · Codex's build`). A session that
    asks you something has the amber dot and its second line in the asks
    colour, weight 500 — no edge and no box on the row; the session(s) of
    the card open in the centre (both builds of a card built by both), or
    the tile expanded on Terminals, are the only rows on `--selected` (E4,
    owner 2026-10-28).
  - Other workspaces below, 12 px gap, `--muted`.
  - Footer, top hairline, padding 8 px: `Ship batch` (raised button, count in
    mono) and `Settings` with `⌘,`.
- The centre runs from the sidebar to the right edge of the window. **The
  Live rail and the right-hand panel are gone.**
- *As built (Skills hub H7):* the app section above the workspace reads
  `Search` · `Inbox` · `History` · `All skills` (Lucide `layers`). `All skills`
  carries a **muted** count (mono `--muted`, like `Terminals`), never the
  accent pill — that stays the Inbox's. It is enabled with no workspace open.
  While it is open no workspace mode is selected. §3a.

## 2. Settings (Board 1)

**Surface.** A modal over the app on the backdrop. Default 1100 × 800, least
820 × 560, resizable, size remembered on This Mac. Radius 14, border
`--border-strong`, surface shadow. Header 44 px on `--panel-bg`: `Settings`
15 px / 600; right: `⌘,` and a 26 px `✕`. Esc closes.

**Navigation.** 240 px column, `--panel-bg`. On top a search field (30 px,
`⌕`, placeholder `Search settings`). Groups 24 px apart, each an eyebrow and
entries of 14 px, padding 8 px, radius 6. Active entry: 600, `--tab-active-bg`
(no left bar — E4, owner 2026-10-28). At 820 wide the column is replaced by a
button in the header showing the current group (`Repository ▾`) that opens the
same list as a menu.

The board's entry list was illustrative. The real one:

| Group | Entries |
|---|---|
| This Mac | Appearance · Terminals & shell · Editor · Builds & runs · Notifications · Startup · Dictation |
| This workspace | Board (only when the repository does not set it) · Worktrees |
| Repository | General · Build & release |
| Team & account | Team · Licence · Profile |
| Advanced | Diagnostics · Reset (GH #171 retired Agents, Role bindings and Swarm templates; a link to one lands on Builds & runs and says so) |

*Corrected (GH #120):* Agents is always shown — scheduled, event and intake
agents run without swarms. A link to an entry its condition hides opens the
nearest shown entry, whose status line says what is hidden and where to
switch it on.

Until the Library ships, `Agent instructions` and `Skills` stay reachable as
two temporary entries at the end of **Repository**.

**Page header.** Scope badge, then title, lede, status line.
- Badge: inline, 24 px high, padding 0 8 px, `--raised`, `1px
  --border-strong`, radius 6, 12 px under it. Content: a mono glyph `▤` in
  `--muted`, the scope 13 px / 600, then ` · everyone who opens this repo`
  13 px `--muted`.
- Title `Build & release`. Lede: `How agents build, verify and ship this
  repository. Everyone who opens it gets these settings.`
- Status line, 16 px under the lede: done dot + `Shared from staging, last
  changed by MatteoB-adv 12 hours ago.` (branch in mono `--fg`).

**Groups and rows.**
- `Shared definition` · `4 settings`
  - `Integration branch` — hint `Shared changes are published here.` — select
    showing `staging` in mono.
  - `Verify pipeline` — hint `None — Verify is skipped.` — select `None`.
  - `After a release, run` (was Install script) — hint `None — nothing is built or installed after a release.` — select
    `None`.
  - `Version files` — hint `Bumped together on every release —
    frontend/package.json and 4 more.` — value `5 files ›` (opens a sub-page).
- `Build cache` · `2 settings`
  - `Shared build cache` — hint `Agents reuse one install of the dependencies
    for this repository.` — toggle.
  - `Extra cache paths` — hint `None — only the dependency folders are
    shared.` — value `None ›`.
- `Detection`
  - `Read the repository again` — hint `Looks for version files and scripts as
    they are today. Nothing reaches anyone until you publish.` — button
    `Re-detect`.

**Changed, not published.** The row gains no edge (E4, owner 2026-10-28); a
numbered badge before the label (18 px, `1px solid --fg`, radius 6, 11 px /
600); the control's border turns `--fg`; the hint becomes `Changed here, not
published yet — was none.` (old value in mono `--fg`), and for the toggle
`Changed here, not published yet — was on. Every agent will install its own
dependencies.` No colour carries the meaning.

**Publish bar.** Sticky at the bottom of the page, `--raised`, top border
`--border-strong`, padding 12 px 24 px. Left: `2 changes · reach everyone who
opens this repo` (15 px) and under it one 24 px chip per change (`1 Verify
pipeline`, `2 Shared build cache`) that scrolls to its row. Right: `Discard`
(text button, `--muted`) · `Review` (secondary) · `Publish to staging`
(primary: `--claude-accent` fill, white). 48 px of space is added under the
page so the bar never covers the last row.

**Review sheet.** Centred over the modal on the backdrop, max 640 px, radius
14. Title `Review 2 changes`; `Publishing makes one commit on staging.
Everyone who opens this repository gets them.` One card per change: the label,
`none → npm run verify` (old struck through, `--muted`; new in mono), and the
consequence in words (`Verify will run before anything ships.` / `Every agent
will install the dependencies itself. First runs get slower.`). Then a closed
`▸ Details`. Footer on `--panel-bg`: `One commit · .atelier/workspace.json`,
`Back`, `Publish to staging`.

**Read-only.** Status line with an empty dot: `You can read this page.
Changing it needs write access to MatteoB-adv/lyra-jun-2025. Ask
MatteoB-adv.` Selects and toggles become plain text (`staging`, `None`, `On`),
chevrons disappear, `Re-detect` is text at 45 % opacity with the hint `Needs
write access — the result would have to be published.` Under the last group:
`Every setting on this page was set by MatteoB-adv on 17 Sep 2026.` When
authors differ, that line gives way to a per-row hint.

## 3. The Library › Skills (Board 2)

**Layout.** Centre mode. At a wide window a 220 px inner column (right
hairline, padding 16 px 12 px) holds two eyebrow groups: `Library` —
`Instructions` · `Skills` · `Notes`; `Scope` — `All 104` · `Repository 34` ·
`Team 1` · `This Mac 65` · `Ply 4` (counts in mono `--muted`). When the centre
is narrow (window 1180) the column goes and the same choices sit under the
lede as a segmented control (`Instructions | Skills | Notes`, 13 px, radius 8)
and a select `All scopes 104 ▾`.

**Page.** Title `Skills`. Lede: `What the agents know how to do. Each one
lives somewhere — in this repository, in the team library, on this Mac, or in
Ply itself.` Filter field: `Filter 104 skills by name or description`.
*Corrected (GH #96 review 1):* the drawing measured it at 32 px, which
contradicts §0's control height of 30 px; 30 px is the value, as it is for every
other field on a page.
One scroll for all 104 rows.

*As built (group B decision §3, 2026-09-30):* a small `New skill…` button
shares the filter's line. It opens a `Flow` (`New skill · 1 step`) asking a
name (lowercase letters, digits, hyphens; unique in the repository) and a
one-line description (`Use when…`), then writes the same `SKILL.md` into
`.claude/skills/<name>` and `.agents/skills/<name>` in the checkout —
nothing committed — and opens Claude's copy in Code. A gitignored root
refuses the flow and offers `Un-ignore`.

**Sections, in this order**, each a heading with `count · scope meaning` on
the right:

1. `In this repository` — `34 skills · everyone who opens this repository`
   (cold read 2026-10-19: every count names `skill`/`skills`). Under the
   heading, once: `All 34 reach Claude only.` + small button `Make all
   available to both`.
2. `In the team library` — `1 · every team workspace`.
3. `Comes with Ply` — `4 skills · in sessions Plyloft starts`. Rows are a plain 15 px name,
   a hint and a toggle: `Write a good card brief` — `Turns a rough idea into a
   brief an agent can work from.` · `Verify before saying done` — `Makes an
   agent check its own work before it reports back.` · `Answer the
   Challenger` — `How the Builder replies when the Challenger pushes back.` ·
   `Release and status notes` — `Writes the release note and the status line
   the same way every time.`
4. `On this Mac` — `65 skills · only here`, with the line `Yours alone. Ply
   reads them but does not change them — share one with your team from its
   row.` Each row's one action is `Share with Team…` (`Share…` when this Mac
   can't write the team library; `Promote` in solo mode), shown on hover or
   focus.

**Skill row.** Name in mono 15 px / 600, then chips; the description's first
sentence as the hint. Right: at most one action, the `⋯` icon button, a `›`
that opens the skill. A repository skill at rest has **no** primary action.
Availability: only the lit chip is drawn (`Claude`: `--signal-empty-bg` fill,
`--signal-empty-border`, `--muted` text); a CLI the skill does not reach has
no chip.

**Row menu** (260 px, `--panel-bg`, radius 8, menu shadow, entries 14 px,
padding 8 px 10 px): `Open in Code` · `Update on staging` · `Make available to
both` · `Promote to Team` · — · `Remove from staging`.
*As built:* `Remove from staging…` — it reaches every colleague, so it asks
first (a destructive confirm, as `Remove from Team…` does). *Walk follow-ups
2026-10-19:* opened where it would be cut off — a skill page's `⋯` at the
panel's left edge, a row's at the bottom of the window — the menu opens
rightwards from the trigger, or above it (measured again when the window is
resized or a list scrolls while it is open; with no room for all of it on
either side, it scrolls inside the room it has); an entry's reason line is
its accessible description.
*As built (owner, 2026-10-19; R15):* `Publish to staging` / `Update on
staging` of a copy that brings a new or changed script, or a file that is not
text, opens the scripts sheet first: eyebrow `Publish`, heading `deploy brings
a new or changed script` (or `… a new or changed file that is not text`), the
lede `Publishing puts a new or changed script on staging at once, with no card
to review it. Everyone who works on this repository gets it. Agents may run
the script when they use the skill.`, every file with its size and *new /
changed / unchanged*, then `Cancel` / `OK, publish`. A text-only publish goes
at once, as before.

**Transient states.**
- Duplicate: outline chip `Also in Team` / `Also in this repository`, action
  `Compare`.
- Publishing: under the hint a pulsing running dot + `Publishing to
  staging…`, in ink (no left bar since E4, owner 2026-10-28).
- In a pull request: aborted-colour dot + `Waiting in pull request
  #412 — it reaches everyone once that is merged.`, action `Open pull request`.
- Removed upstream: row at 60 % opacity, name struck through, hint `Removed on
  staging by MatteoB-adv 2 hours ago. Your copy here is the last one.`, action
  `Keep on this Mac`.

## 3a. All skills (Skills hub H7, mockup `plans/skills-hub-mockups/all-skills.html`)

**Layout.** App-level centre page, drawn over the workspace hosts (they stay
mounted, hidden). Header crumbs `All workspaces › All skills`. 880 px column.
Title `All skills`; lede `Every skill this Mac can see — in your repositories,
the team library, on this Mac, and in Plyloft — and where each one is used.`
Filter `Filter 148 skills by name or description` + small `Read again`
(`Reading…` while it reads). Under it, one line of controls: the segmented
`All 148 | Repositories 96 | Team 22 | This Mac 17 | Plyloft 4` (a scope with
none is left out, Repositories always shown; `My library` with H10),
the select `Any state · Needs a look · Update available · Modified here ·
Both changed · Removed upstream · Not linked · Changed recently`, the button
`Workspaces: All 12 workspaces ▾` (a check list; `Every workspace` clears it)
and the select `Reaches`: `Claude or Codex · Claude only · Codex only · Both`.
Then a status line: `12 workspaces · 1 folder not found · read 4 min ago`
(`reading 3…` while it reads), and the team library's problem when it has one
(`The team library is switched off on this Mac.`).

**Groups**, headed with `N skills` on the right: `In repositories` · `In the
team library` · `On this Mac` · `Comes with Plyloft`. 50 rows each, then
`Show all · 12 more`.

**Row** (64 px, one line of hint, ellipsis): mono name, chips — outline scope
chip `Repository · lyra` / `Team · acme` / `This Mac` / `Plyloft`, the lit CLI
chips, `3 updates` on a team row, `Linked · update available` on a linked copy
— and a `›`. Hint: the description's first sentence, then what applies, `·`
between: `Linked to the team library · update available`, `Its scripts wait
for your OK`, `Claude and Codex copies differ`, `Codex copy in the old
.codex/skills`, `Too many files to index`, `Off on this Mac`, `from the
checkout`, `Reading…`, and Used in: `Used in 5: acme-web (linked · up to date)
· astra (linked · update available) · site (same name, differs) · 2 more`;
a Plyloft row `Used in every session Plyloft starts`; a library row nobody
copied `Used in no repository`. A folder not found: hint `Folder not found ·
/Volumes/Other/astra`, name `--muted`, left out of counts. The active row
(keyboard) has the `--hover` fill and, while the list has focus, the accent
ring. Empty: `No skill matches these filters.` / `No skills on this Mac yet.`

**A skill, read through the hub.** `All skills` back link, the name as title,
the description as lede, a status line of the row's notes. Properties:
`Where`, `Reaches` (`Claude and Codex`), `Linked to` (`the team library ·
update available`), `Folder` (mono). Strong button `Open in its workspace` (a
library skill: `Open in the Library`). Section `Used in` (`5 workspaces`; a
Plyloft skill `every session Plyloft starts`) with one row per copy:
`lyra (linked · update available)`, `site (same name, differs)`, `ops (same
content, not linked)`, the row itself `acme-web (here)`; hint its repository.
None: `Only here.` / `No repository on this Mac has it.`

**Keys.** The caret is in the filter on open (⌘F or `/` again); ↓ into the
list; ↑ ↓ Home End; Enter opens; Esc: a skill → the list, the list or an empty
filter → the mode you came from.

**Copy to… (Skills hub H8, mockup `skill-used-in.html` 2b).** A small
`Copy to…` button on a row (left of its chevron; not in the list's keyboard
order — Enter opens the skill, whose page has it beside `Open in its
workspace`) and in a Library row's `⋯` (a repository copy in the checkout, a
team skill, this Mac's own; never a Plyloft skill — that is Personalize). It
opens a flow over the page: eyebrow `Copy to…`, title `Copy deploy-notes to…`,
lede `From astra. Each workspace gets a linked copy through its own card, so
you see the change before it ships.` A check list of every other workspace
(`lyra · acme/lyra`), each with its note: `Doesn't have it yet.` · `Has the
same deploy-notes, not linked. Its card only links it to astra.` · `Has a
different deploy-notes. Its card would replace it and link it.` · refused and
off with the reason (`lyra already has it, linked to astra.`, `astra-2 is the
same repository as astra.`, `… isn't a git repository …`, `… already on its
way …`). Under it a status line: **What reaches where.** `lyra gets
deploy-notes for Claude and Codex once card “Skill: copy deploy-notes from
astra” ships. Everyone who opens acme/lyra gets it from then on; sessions
already open keep what they have.` (two or more: `… each get a card …`), plus
`The link is kept on this Mac only: …` when it is. Buttons `Cancel` /
`Create 2 cards`. A copy that brings a script shows the scripts sheet first
(`Copy`, `OK, copy`). One toast: `2 cards made` with `Open lyra`. A linked
row's chip reads `Linked · up to date`, or `Linked on this Mac · …`; Used in
names a copy's origin `astra (where it was copied from)`. *(Challenger)* A
workspace that already has exactly the copy, when the link is kept on this
Mac only, reads `Has the same scratch, not linked. It is linked to notes on
this Mac at once: no card needed.`; picked, the status line says `lyra is
linked at once: it has this version already.`, the button reads `Link it`
(or `Create N cards` for the others) and the toast `Linked in lyra`. Esc
closes the scripts sheet back to the picker, then the picker back to where it
was opened, wherever the keyboard is; the picker takes the keyboard when it
opens (Tab goes on to its list).

### 3b. My library (Skills hub H10, mockup `plans/skills-hub-mockups/my-library.html`)

*As built.* The lede now names `My library` among the places. A section
`My library` sits under the status line while the scope is `All` or `My
library`; its rows are the group `In My library` (scope chip `My library`).

- **None on this computer.** Hint `Keep your own skills in a private
  repository on your GitHub account. They reach your sessions on every Mac you
  use, as mine:<name>.` Buttons `Create My library` (strong, `Pro` mark on
  Free), `Use one you have…` (quiet, `Pro` mark). When GitHub already has
  `<login>/plyloft-skills` with the library layout: the line `Your My library
  <repo> is on GitHub — use it on this Mac.` and a strong `Use it on this Mac`
  first.
- **Create sheet** (a flow in place of the section): eyebrow `My library · 1
  step`, title `Create My library`, lede `My library keeps your own skills in a
  private repository on your GitHub account, so they reach your sessions on
  every Mac you sign in to. Plyloft creates <login>/<name> (private).`; the
  select `GitHub account` when gh has more than one signed in; mono field
  `Repository name` (`plyloft-skills`) with the hint `<login>/<name> ·
  Private. You can rename it; Plyloft only needs the library layout inside.`;
  the choice `Start empty` / `Start with skills from this Mac` (`Copies the
  ones you pick. Your folders on this Mac stay as they are.`) with a check
  list; the status line *what reaches where* (`… as mine:sql-style and
  mine:my-review, for Claude and Codex. On another computer, choose “Use it on
  this Mac”. Nobody else can read it.`); the footnote `Copies you link into
  shared repositories name this repository.` (§14 Q28); `Cancel` · `Create on
  GitHub`. Refused for the `repo` permission: `Grant it` beside, running
  `gh auth refresh` in the guided terminal — only when the chosen account is
  gh's active one (gh refreshes no other); for another account the hint
  `GitHub's permission refresh works on gh's active account, and <login>
  isn't it. In Terminal: gh auth switch -h github.com -u <login>, then gh auth
  refresh -h github.com -s repo, then gh auth switch -h github.com -u
  <active>. Then try again.`; refused because the name is a My
  library already: `Use it on this Mac` beside.
- **Used here.** The count `<repo> · 9 skills · your sessions on every Mac`;
  the line `Updated 4 minutes ago` / `Last updated … · offline` / `… ·
  couldn't update` / `… · <login> isn't signed in on this Mac` (with the hint
  `My library uses the GitHub account <login>, which isn't signed in on this
  Mac. Sign it in in Setup's GitHub step; your sessions keep the last copy
  meanwhile.`) / `… · Pro plan needed to keep it current`; small `Read it
  again` (Pro) and quiet `Stop using it on this Mac` (a destructive confirm:
  the copy to the Trash / Recycle Bin, sessions get no `mine:` skills, GitHub
  and the copies in repositories untouched). Beside a team plugin named
  `mine`: `Your team library has a plugin called mine, so sessions get My
  library as mine-<login>:<name>.`
- **Gone** (mockup 6b): the line `Last updated … · not reachable` and a warn
  callout `Your My library <repo> isn't reachable with the GitHub account
  <login> any more. Your sessions still get the copy from 3 days ago.` (GitHub
  says 404 for a deleted private repository and for one the account can't
  read, so the words name neither — R16) with `Create it again` (strong, Pro)
  · `Point to another repository…` (Pro) · `Stop using it on this Mac`.
- **A copy linked to My library on a computer that doesn't use it:** `Linked
  to <owner>'s My library — not available on this Mac`.
- **Add to My library toasts** (Windows walk): `<skill> is in My library. New
  sessions get it as mine:<skill>.`; a skill that brings a script: `<skill> is
  in My library. It brings a script, so new sessions on this Mac get it as
  mine:<skill> once you say OK — Review it on its page.`; on a Mac, a skill
  too long for Windows adds the body `` `<skill>`: Path too long for Windows —
  its file `<file>` would be N characters long in a PC's sessions, past
  Windows' 240. Shorten the skill's folder or file names. `` — on Windows the
  same words refuse it (`… Nothing was published.`).
- **Rows** (team and My library): `Path too long for Windows · sessions on
  this PC don't get it` in the hint line where this computer's snapshots leave
  it out. A My library row's Used in joins its linked copies: `lyra (linked ·
  up to date)`.
- **A skill's hub page.** A row of this Mac or of a repository: `Add to My
  library` (Pro mark); with none yet, `Create My library to add it`. When the
  other computer published the skill since this one last did, the page shows
  the compare instead: eyebrow `Compare · <skill>`, title `<skill> changed on
  another computer and on this Mac`, the files with `both` / `only this Mac` /
  `only the other computer`, three columns (`Before · the version both
  started from` — absent, and said, when this computer never published it —,
  `The other computer's (in My library now)`, `This Mac's`), the choice `Keep
  this Mac's` / `Keep the other's`, `Close`. A My library row: `Install in
  <workspace>` (a skill card, as a team Install); one whose script waits:
  `Needs your OK · it brings a script. …` and `Review` (the H6a sheet, worded
  *in My library*).

## 4. The Library › a skill (Board 3)

Reached from a row's `›`; `← Skills` (14 px `--muted`, 24 px above the badge)
goes back. Same column as the list (880 px).

**Header.** Scope badge; the name in mono 24 px / 600; the whole description
as the lede; then a fact line, 13 px `--muted`, items separated by `·`: a
chip `Reaches Claude only` (20 px high, empty-state fill and border) · `Last
changed by MatteoB-adv 7 weeks ago` · `1 file`.

**Actions.** One primary `Edit in Code` (accent fill) and the `⋯` icon button
(`Update on staging` · `Make available to both` · `Promote to Team` · —·
`Remove from staging`). *The line of text listing the menu beside the button
is a designer's annotation; it is not built.*

**Sections.** `Its files` (count on the right): one Value row per file — name
in mono, hint `What the agent reads before it deploys — 84 lines.`, `›` opens
it in Code. `What it tells the agent`: the `SKILL.md` rendered as reading text
in a `--raised` group with 24 px padding (headings 17 / 15 px 600, body 15 px /
line 24, numbered steps with `--muted` numerals) — never as code. Last, a
`Details` disclosure: the path and `staging · a3f9c21 · MatteoB-adv ·
2026-07-30 14:12` in mono `--muted`.

**Duplicate (state B) — corrected.** The boards said "The repository one wins
here". Nothing wins: both reach the agents (decision of 2026-09-17). The notice
(a `--raised` block, `--border-strong`, radius 10, padding 12 px 16 px, under
the fact line) reads: `Also in Team` — `Both reach the agents: this one as
deploy, the team's as team:deploy.` — action `Compare`. Compare opens below the
actions: heading `The two versions, side by side`, two groups (`Repository · in
use here · 84 lines`, `Team · every team workspace · 79 lines`), mono 13 px /
line 20 with line numbers; a differing line carries the `--diff-line-bg`
wash (a faint ink tint; no left bar since E4, owner 2026-10-28) and a
mark in a 12 px column: `≠` changed (on both
sides), `+` only here. A line that exists on one side only is `+` on that side
and a neutral blank on the other: no mark, no number, no text, no bar or
shading, and left out of the screen-reader reading (the `+` side keeps its
"only here"); never a `−` `(nothing here)` row drawn as a deletion opposite a
pure addition, nor the mirror for a pure removal (owner, 2026-10-20; every
Compare shares this). Under it one sentence that says the
differences in words. Actions: `Keep both` (primary; silences the notice for
this pair **on This Mac** until either copy changes) · `Remove from staging` ·
`Promote this one to Team`. ("Use the Team one here" is `Remove from staging`
under its true name.) *As built:* `Remove from staging…`, with the row menu's
confirm. *Walk follow-ups 2026-10-19:* when the Promote shares the copy
committed on the branch rather than the checkout's shown here, the group reads
`Repository · this checkout's copy`, the row's note (`… Replace in Team shares
the copy committed on staging; your local changes aren't included.`) sits
under the sentence, and the button is the row menu's own label (`Replace in
Team…`). Its confirm (and the row menu's) says the same instead of "pushes
your version": `… Replace in Team shares the copy committed on staging; your
local changes aren't included. Replacing it pushes that copy to everyone on
the team.`

**Improvement proposal (state C).** A block above the header, `--raised`,
`--border-strong`, radius 10, padding 16 px: an outlined eyebrow chip
`Improvement proposal`, then `from the Challenger · 2 hours ago` (`from your
correction · 2 hours ago` when the lesson's source is the human's own
correction); the reason
(`After card #88: three rounds with the Challenger over missing rollback
tests.`); the change in words (`The change asks the deploy skill to check that
a rollback test exists before it pushes, and to stop and say so when one is
missing. Four lines are added; nothing is removed.`); then the diff in a
`--panel-bg` group (header: file name in mono, `4 lines added`; mono 13 px /
line 20, line numbers, added lines with the `+` mark and the
**`--diff-line-bg`** wash, as Compare draws one (no bar since E4). *The boards tinted added lines with
`--signal-done-bg`; run-state colours are not decoration, so the neutral
treatment of Compare is used.* Actions: `Approve and publish` (primary) ·
`Dismiss` · `Publishing reaches everyone who opens this repo.` The same
proposal elsewhere: in the Inbox `A skill wants to change — deploy` / `After
card #88 · LYRA - Jun 2025`; in the card's Ship step `One skill change is
waiting — deploy · Review`. Both carry an accent dot and open this page.

Rules fixed with the owner: the **Challenger** writes the proposal (a short
read-only pass after a card that met friction, at most one per card); it may
target **only the repository's skills and instructions** — when the trouble
sits in a personal, Team or Ply skill it says so in words and suggests bringing
a copy into the repository.

**A personal skill (state D).** Badge `This Mac · only here` (glyph `▪`); fact
line `Reaches Claude only · Yours · not shared with anyone · 1 file`; a status
line with an empty dot: `Ply reads it but does not change it. Promote it to put
it in the team library or in this repository, where others get it too.` One
action, `Promote`, and beside it `Nothing else can be done from here — the file
lives on this Mac.` The rendered text ends with `Read-only here: to change it,
open the file on this Mac.` `Details` holds the path and `Reveal in Finder`.

**Narrow centre (state E).** The inner column goes, as on Board 2; the page is
otherwise the same, and the two Compare groups stack under 760 px of column.

## 5. Errors, procedures and This Mac (Board 4)

**The error shape.** On the page it concerns, under the header: a `--raised`
block, border `--signal-aborted-border`, radius 10, padding 16 px; an 8 px
aborted dot; the title 15 px / 600 (`Local staging can't be updated.`); then
three parts, each an 11 px eyebrow and a 15 px / line 22 sentence, 12 px apart:
`What happened` — `.claude/skills/deploy/SKILL.md here differs from the one on
staging.` · `What was left untouched` — `Nothing was changed — not your copy,
not the one on staging.` · `What to do` — `Publish your version, or move the
local copy to the Trash and take the one on staging.` Up to **two** actions,
one per way out: `Publish your version` (primary) and `Move the local copy to
Trash` (secondary; asks once, the file goes to the macOS Trash, then the branch
is brought up to date). *The boards said "Delete the local copy"; the owner
chose the Trash.* Then `Details`, open here, with the tool's own output in
mono. The toast (`--raised`, `--border-strong`, radius 10, shadow `0 4px 16px
rgba(0,0,0,0.18)`, padding 12 px 16 px, bottom centre) only says it happened
and leads to the page — `Local staging can't be updated — nothing was changed.`
· `Show` — and never carries the only copy of something that needs doing.

**Offline (Settings › Repository › Build & release).** Header status line:
`Shared from staging. You're offline, so Ply can't read or write it right
now.` with an empty dot. A change **already published here and queued** keeps
its mark with the hint `Changed here, not published yet — was none. It works on
this Mac already.` (a draft not yet published never says that). A row that
needs the repository says why: `Integration branch` — `Can't be changed while
offline — Ply needs the repository to read the branches.` The publish bar in
its waiting form: empty dot, `Waiting to publish — you're offline`, `1 change is
kept here and works on this Mac. Ply will publish it to staging when the
connection is back.`, with `Discard`, `Review` and an inert `Publish to
staging`.

**A procedure (Library › Instructions).** Page lede: `What every agent reads
before it starts, wherever it runs.` Section `In this repository` · `everyone
who opens this repo`: a Value row `CLAUDE.md` — `The house rules for this
repository — 212 lines.` `›`; and the Procedure row `Agent instructions` —
`Only CLAUDE.md — Codex reads nothing here.` — `Set up`. Afterwards the same
row reads `Shared through AGENTS.md — both CLIs read the same file.` with a `›`
and no action: the procedure goes quiet. *Added to the drawing:* a section `On
this Mac` · `only here`, read-only, with the personal instruction files.

**The flow.** A surface of its own in the centre (max 720 px, `--panel-bg`,
radius 14, surface shadow), no navigation around it: eyebrow `Set up · 1 step`;
title `Let both CLIs read the same instructions`; `Ply will put the
instructions in AGENTS.md, which both Claude and Codex read, and leave one line
in CLAUDE.md pointing at it. Nothing is deleted.`; `Before · CLAUDE.md` and
`After · CLAUDE.md` side by side (first lines, `… 209 more lines`, `+
@AGENTS.md`, `The 212 lines move to AGENTS.md, unchanged.`); `What changes on
disk` — `+ AGENTS.md (new, 212 lines)` · `~ CLAUDE.md (1 line, an import)`;
`Reaches everyone who opens this repo, after you publish.`; `Cancel` · `Set up`
(primary). Instruction files travel on the shared channel **without ever
overriding**: a direct commit when the file has not changed upstream since the
edit began, otherwise a pull request (owner, 2026-09-17).

**Settings › This Mac › Builds & runs.** Badge `This Mac · only here`; lede
`Which model does the work on this Mac, and how much it thinks before it
answers. Saved as you change it.` Section `Who builds`: `Builder vendor` — `The
CLI that picks up cards. The other one stays available for the Challenger.` —
a segmented control `Claude | Codex`. Sections `Claude` and `Codex`, `2 roles`
each: rows `Builder` and `Challenger` with their hints (`Does the work on the
card.` / `Pushes back on the Builder before anything ships.` / `Used when Codex
is the builder vendor.` / `A second opinion from the other vendor.`). *Corrected
from the drawing:* the model control is a field you can type in or pick from,
first choice `CLI default` (Ply cannot list a vendor's models); `Effort` exists
for **Codex only** — the Claude CLI has no such flag. Section `Runs`: `Pick up
where a run left off` — `After a crash or a restart, Ply resumes the run instead
of starting again.` — toggle; `Keep run history for` — `Older runs and their
output are deleted from this Mac.` — `30 days`. Last group: `Reset this page to
defaults` — `Models, effort, auto-resume and retention go back to how Ply
ships.` — `Reset`. After a change the toast: `Challenger effort set to high on
this Mac.` · `Undo` (26 px button).

**Settings › Advanced › Diagnostics.** Lede `What Ply needs on this Mac, and
whether it is there. Each line offers the one step that fixes it.` Section
`What Ply needs` · `2 of 3 ready`, Procedure rows: `claude` — `Found and signed
in. Nothing to do.` — `Ready` (text); `gh` — `Found, but not signed in — pull
requests can't be opened from here.` — `Sign in`; `Tile shell` — `/bin/bash has
no paste mode, so pasting into a tile can garble long text.` — `Choose zsh`.
A step Ply can take itself it takes (choosing zsh); one that needs the person
opens a shell tile with the command running (`gh auth login`) and the row
refreshes when the check turns good. Section `If you need to show someone`:
`Reveal log folder` — `Opens the folder in Finder. Nothing is sent anywhere.` —
`Reveal`. Then `Details`.

**Empty state and danger zone.** Library › Notes with nothing in it: `Things
you want the agents to remember about this work.` / `No notes in this
repository yet. A note reaches everyone who opens it.` / `Write the first
note`. Settings › Advanced › Reset: a group bordered
`--signal-aborted-border`; row `Reset all settings on this Mac` — `Appearance,
models, notifications and window sizes go back to how Ply ships. Your
workspaces, cards and skills are untouched.` — `Reset` (text `--danger`,
transparent, same border). *The drawing's second row, "Forget this Mac's run
history", is a feature nobody asked for and is not built.*

**New token.** `--danger: #ef4444` (the literal appears 13 times in today's
CSS).

## 6. The remaining pages (Board 5)

Read 2026-09-17; recorded **as corrected** in review. Measures are those of
[SHEET.md](SHEET.md).

**Settings › Repository › General.** Lede `What this workspace is called, how
it looks, and where its cards come from.` Status line as on Build & release.
Rows: `Name` — `What everyone who opens this repository sees in the sidebar.` —
text field; `Accent colour` — `The colour of this workspace's chip in the
sidebar, for everyone who opens it.` — four 26 px circles (violet, cyan, magenta,
sunset), the selected one ringed **and named beside it** (`Violet`) so the
choice does not rest on seeing the colour; `Board` — `Where the cards come
from. Set when the workspace was opened; changing it would orphan every card.`
— value `GitHub Issues · MatteoB-adv/lyra-jun-2025`, no control.

**Version files** (sub-page of Build & release, `← Build & release`). Lede `The
files whose version number is bumped together on every release. Ply found them
by reading the repository; you can correct the list.` Group `Bumped on every
release` · `4 of 5 kept`: one row per file — path in mono, hint with its kind
in words (`npm package · the React app`, `Python module · the API`, `Python
config · the version the app shows`), `⋯` (Remove). A removed file **keeps its
place**, struck through, with the changed mark and number, hint `Removed here,
not published yet — it has no version of its own.` and `Put back`; it goes when
the change is published. Below: `Add a file` — `Anything with a version number
Ply should keep in step.` — `Choose a file`. The publish bar counts these
changes like any other.

**Leaving a draft.** A confirmation over the page: `Leave with 2 changes nobody
else has?` — *corrected:* `Verify pipeline and Shared build cache are changed
on this page only. Nobody gets them — this Mac included — until you publish.`
(the drawing said they already "work on this Mac"; a draft is applied nowhere
until Publish) — then the two changes old → new. Buttons: `Discard` alone on
the left (quiet), `Stay` and `Publish to staging` (primary) on the right: the
destructive way out sits away from the two safe ones.

**Promote** (a flow). Eyebrow `Promote · 1 step`; `Where should
embedded-captions go?`; `It lives on this Mac today, so only you can use it.
Your copy stays where it is either way.` Two choices as selectable rows: `This
repository` — `Everyone who opens MatteoB-adv/lyra-jun-2025 gets it. One commit
on staging.`; `Team` — `Every workspace of your team, in every repository.
Reaches the other Macs after their next refresh.` Then `What happens next` in
words, the reach line, `Cancel` · `Promote`. When the name is taken the flow
shows the error shape (`Team already has a skill called embedded-captions` —
what happened / left untouched / what to do), a text field with a proposed
name (`embedded-captions-vertical`), `Compare the two`, and `Promote as
embedded-captions-vertical`.

**Library › Notes.** Lede `Things you want the agents to remember. Each note
lives somewhere, and reaches whoever that place reaches.` Filter `Filter 6
notes`. Sections by scope like Skills; a note row is its title (15 px, not
mono), its first sentence, `author · age` for shared ones, `⋯` and `›`;
personal notes have the one action `Promote`. A note open: `← Notes`, badge,
title, status line, the text as reading text, `Details`. *Corrected:* the
drawing's `Edit in Code` becomes **`Edit`**, opening the small title-and-text
form notes have today — a note is not a file people keep in their checkout,
and notes get no new investment (ADR 0005).

**Search in Settings.** The field holds `model` with `✕`. The page shows
`Results for model` — `Five settings, grouped by what they reach. The path says
where you will land.` Results grouped under a scope badge line; each is a row:
the setting's label, then `This Mac › Builds & runs › Claude · claude-opus-5`
(path, then the current value in mono), `›`. A match in a current value ranks
last and says why (`mentions model in its command`). Landing: the row gets an
ink outline and the words `Found here` beside its label for two seconds —
no colour, no flash.

**A Ply skill.** `← Skills`, badge `Ply · comes with the app`, the name as a
plain title (not mono), the description, fact line `Claude` `Codex` chips ·
`Ships with Ply`. Group `On this Mac`: `Use this skill` — `Switched on for
every workspace on this Mac. Other Macs decide for themselves.` — toggle. Then
the rendered text and `Details`. *Corrected:* the closing line reads `This
skill comes with Ply and can't be edited. To change how it works here, write
your own in this repository and switch this one off.` (the drawing promised
"yours will be used instead"; no copy wins over another).
*Skills hub H9 (R9; mockup 7, as built):* the row's hint is `v1.155.0 ·
Changed in 1.155.0: <summary>` (a skill still at its first version: `v1.152.0
· <first sentence>`), and a row a level above this Mac decides carries a second
line: `Off in this workspace (set in acme/web (.atelier/workspace.json)).`, `Off
in this workspace: acme/web has its own card-brief, personalized from
Plyloft.` or `Off for the team — set by matteo, in every workspace on this
Mac.` The row's toggle stays this
Mac's switch. The page's fact line adds `v1.155.0`, a `Personalize…` button
sits under it, and two status lines follow the header: `Changed in 1.155.0:
<summary>.` and `Earlier: 1.152.0 — first version.` The `On this Mac` group
becomes **`Where it's on`** (count `In acme-web: on|off`, note `The workspace's
choice wins, then the team's, then this Mac's. A change reaches the next
session; one already open keeps what it started with.`): `In acme-web` with
`Follow | On | Off` (*No choice here — follows the team, then this Mac.* / *Off
— set in acme/web (.atelier/workspace.json).* / *Off — acme/web has its own
card-brief, personalized from Plyloft. Choose On to use both.*, plus *A choice
here reaches everyone who opens acme/web.* or, read-only, *Only people who can
push to acme/web change it.*); `acme's team default` (Team mark) — *No team
choice — follows this Mac. Only matteo can switch it off for the team.* /
*Off — set by matteo for the team, in every workspace on this
Mac.* — a toggle a
member may press and is answered *Only matteo can switch Plyloft's card-brief
off for the team. You are signed in to GitHub as ana.*; `On this Mac` — *On —
used where neither the workspace nor the team decides.* The closing line now
reads `This skill comes with Plyloft and can't be edited. To change how it
works here, Personalize it: your own copy switches this one off where it
applies.` **Personalize** is a flow (`Personalize · 1 step`, *Where should
your own card-brief live?*): `This repository` (a card; *Make the card*) or
`The team library` (only with a team, never in solo mode; a member reads who
switches Plyloft's off and that the fork reaches sessions next to it until
then; the toast offers `Ask matteo`, which copies a sentence).

**Ship a card, with things open.** Header `← Board`, `#88`, `Done · 4m 12s`,
the card's title, `Three things want your attention before this ships.` Group
`Before it ships`, one row each, at most the actions shown:
- `A skill wants to change` — `After three rounds with the Challenger, deploy
  would ask for a rollback test before pushing.` — `Review`.
- `The last commit was not reviewed` — `The Challenger saw the work up to
  7c1d40e. One commit came after it — a0b9f32, 3 files.` — `Review again` ·
  `Ship anyway`, with `Details`.
- *Replaced:* the drawing's third row (`One change is waiting to publish`) is
  not a reason to hold a card. The third is the overlap advisory Ply already
  has: `Another card touches the same files` — `#87 also changes
  .claude/skills/deploy/SKILL.md.` — `Compare`.
Then group `Ship`: `Ship to staging` — `Commit, tag, and close the card. Three
things above are still open.` — `Ship`. With nothing open the step is that one
row alone: `Reviewed by the Challenger · verify passed · nothing waiting.` — no
warnings, no empty section.
