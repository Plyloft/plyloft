# Getting started — the interactive tutorial (spec)

Status: **approved by the owner** 2026-10-20 (D16, with D13–D15). Docs only; no app code until
Skills hub H10 has merged (DECISIONS, coordination). Sources:
INTERVIEW, DECISIONS D1–D12,
ONBOARDING_SPEC (Setup, §14 guided first
card), [PRINCIPLES](../ux-language/PRINCIPLES.md),
[BOARDS](../ux-language/boards/BOARDS.md), `docs/ux-language/tokens.json`.

Before building, merge main into the branch and re-check §5 (the map) and
every label in §6 against the app: labels named here were read on
2026-10-20 from main `37644e49`.

Mockups (light, dark, Windows): (not published)
(private until the owner shares it).

## Contents

1. Goals, non-goals, persona
2. What exists and what changes
3. The shape: Guide panel, coach-marks, Help menu
4. The content model (one manifest)
5. The map the tutorial explains
6. The path: chapters and steps
7. Detection: how a step knows it is done
8. Persisted state and migration
9. Pause, skip, resume, reopen, start over
10. Accessibility
11. Edge cases
12. Keeping it current (every release)
13. Measurement (local only)
14. SAAS_READINESS five-point review
15. Implementation cards
16. Open points

---

## 1. Goals, non-goals, persona

### Goals

1. **A new vibe-coder ships their own first card without help**, in their own
   project, and knows why each section exists.
2. Answer the four questions the first user asked (INTERVIEW):
   **Board or Terminals?**, **what do I write in a card?**, **how do I see the
   result?**, **what is Code for?** Each one is a step, not a footnote.
3. **Extremely guided, multi-step, interactive** (D2): every step points at
   the real control, says what to do in one sentence, and waits for the app to
   change. It never presses anything for the user (D8).
4. **Stop and resume at any moment**, across quits and updates (D2).
5. **Grows with the app** (D3, D11): a new section gets its step by adding
   entries to one manifest, and the gate fails if it is forgotten.

### Non-goals

- Not a second Setup: tools, sign-in, Git, GitHub and the first project stay
  in Setup. The tutorial sends the user there when something is missing.
- No AI use the user did not choose: no `claude -p`, no hidden sessions. A
  step that starts an AI says so first (D8).
- No telemetry; nothing leaves the machine (D9, SAAS point 4).
- No demo project in this spec (D4 chose the real project). The "safe
  example" README card covers users without an idea (D5).
- No product change to how the result is previewed: that is the separate
  **Try it** card (D12, §15 TU-X). The tutorial explains today's real route.

### Persona

Primary: the vibe-coder (`docs/UX_BRIEF.md`) — thinks in outcomes, knows
GitHub's green merge button, avoids the terminal. Secondary: the experienced
developer, served by the short Quick tour (D7) and progressive disclosure.
All four platforms × AI cases are first-class (D1): Mac or Windows, Claude or
Codex, one AI or both.

---

## 2. What exists and what changes

| Exists | Change |
|---|---|
| Setup (`SetupOverlay`, `setupSteps.ts`), level `onboarding.level` = `guided` / `fast` | None to the steps. **Ready** changes its offer (below). |
| Ready offers *Try a guided first card* (guided level) | Guided level: primary becomes **Start the tour** (D6), sentence (1.176.3) *The Getting started tour points at the real buttons while you build your first card in <project>. It never presses anything for you. Stop whenever you like; Help › Getting started picks it up again.* and the other button *Not now, open <project>* The guided first card stays reachable inside the tour (step B3 *Use a safe example*) and from Settings › Account › Setup. Fast level: a quiet link **Take a 1-minute tour** (D7). TU-5: *Start the tour* is the footer's primary once nothing required is missing (a project whose only gap is the settings Ready read counts, as for the guided card), else a quiet button in the body; the press saves those detected settings first, closes Setup and opens the panel in Setup's project without opening the Board (B2 is the tour's). The fast level keeps today's quiet guided-card button until TU-6 builds the Quick tour and its link. |
| Guided first card: README card + `FirstCardGuide` callout + `guided_permission_mode` | Kept as the safe example (D5). While the tour runs on that card, the tour's coach-marks speak and the `FirstCardGuide` callout is **not rendered** (one guide at a time). The `firstCard` record and the permission rule are unchanged. Outside the tour the callout works as today. |
| `Popover`, `Callout`, `Sheet`, `useDialogFocus`, `useEscapeFirst`, `useReveal`, `pushToast` | Reused. One new component pair: `GuidePanel` and `CoachMark` (§3), built from these. |
| Navigation: `openCenterMode`, `openLibraryPage`, `openCardStep`, `selectCard`, `setAllSkillsOpen`, `setShipBatchOpen`, `openSettingsSection`, `useWorkspaces.setActive` | The tour navigates **only** through these (AGENTS.md UI invariants: hosts are hidden, never unmounted; the editor container stays mounted). |
| No stable anchors on sidebar items | New `data-ply-tour="<anchor-id>"` attributes on the elements the tour points at (§4.3). |
| No Help entry | New **Help** menu (`?`) in the sidebar foot (§3.3). |
| No "What's new" | Help › **New in this version**: each release's highlights (§12.2; owner, 2026-10-21 — it was a chapter driven by `since`). |
| No consent/telemetry | None added. Local counts + *Copy tutorial report* (§13). |

---

## 3. The shape

### 3.1 The Guide panel (the persistent checklist)

- A **non-modal panel docked at the bottom right of the centre**, 320 px wide,
  `--raised` background, `radius-lg`, `shadow-popover`. It never covers the
  sidebar and never blocks the page: the user acts on the real app around it.
- Header: **Getting started** · progress in mono (`4 of 10`) · `Pause`
  (collapses) · `⋯` (Skip chapter, Start over, End the tour).
- Body: the chapter list. The current chapter is open and shows its steps:
  done `✓` (green dot + word *Done*), skipped (muted *Skipped*), current
  (accent), to do (muted). Optional chapters are listed under **More, when
  you're ready**, each with its length (*3 steps*).
- The current step shows its **one-sentence instruction** and two buttons:
  **Show me** (moves the coach-mark onto the control again, scrolls it into
  view with `revealElement`; presses nothing) and **Skip this step**.
- While the Builder works, the panel shows a live line: *Claude is building ·
  3 min* (indigo running dot), so a slow build has a visible owner and
  something to do next (INTERVIEW: "too slow"). The minutes count from the
  session's own start: a session resumed after a quit (or closed and resumed)
  keeps the card's first `builder.startedAt`, so the tour counts from when
  this launch first saw that session (TU-5 Challenger). The line follows the
  card's real state (TU-5 Mac walk): *building* only while the Builder works;
  no line once its turn is over (*Builder stopped*) or while a question, a
  trust or bypass prompt holds it (B5b says what to do); *Paused until …*
  for the usage limit. B6/B7's *While Claude works* shows only while it does,
  and B8 never says *still working* while the session is held.
- A card step (B4–B10, B5b) while the tour card's page is not on screen
  offers **Take me there** to the card, whatever the step waits on (TU-5 Mac
  walk: B8 after Resume on the Inbox). The coach-mark points at a
  card-page control only on the tour card's own page.
- The panel stands clear of the step's control (it docks at the bottom left
  when the control is where it docks, B5b's Open the Builder included) and of a
  field being written in — the empty Board's *What do you want to build?*,
  the card's What you want: it ends below such a field over its column, its
  list scrolling (TU-5 Mac walk).
- **Collapsed** (Pause): the panel goes and only the sidebar row stays
  (§3.4), its Resume focused; no pill (1.174.0, D3b). The same after a
  launch, when the panel is closed.
- **Under a sheet** (TU-4 walk, TU-5): a sheet drawn inside the card's page
  (Try it's *How to start your app*, with *Save and try*) sits in that
  page's own layer, under the panel; while any modal is up the panel and
  coach-mark stand aside, as they do under Setup.
- **Where it sits** (TU-4 Mac walk): in Code, the panel docks
  above the editor's status bar (its Wrap), never on it. In a short window
  (≤ 820 px high) the panel is at most half the window high and its list
  scrolls on its own, the current step kept in view.

### 3.2 The coach-mark (pointing at the real control)

- A `Popover` anchored to the `data-ply-tour` element, with a **2 px accent
  ring** around the target (no scrim: the page stays usable, D8). The ring has
  a non-colour cue too: the popover's arrow touches it, and the popover's first
  line names the control (*The New card button*). The arrow's tip lands on
  the ring's line (`COACH_GAP`, `tourPanel.ts`).
- Placement: right, left, below, above — of the sides that fit the window,
  the one that covers least of the other controls near the target and the
  Guide panel (`nearbyControls`), the earlier on a tie: a free side always
  wins (a header button's coach-mark goes below rather than over its
  neighbour). When every side covers something, the least covered.
- `card-primary` is the Now box's primary, whose words follow the card's
  state: a step points at it only while it is the action the step asks for
  (`CARD_PRIMARY_FOR`: B5 Start build, B5b Open the Builder, B8 Finish and check,
  B10 Ship it). Otherwise the coach-mark waits and the panel says what comes
  first (`WAIT_COPY`: *Start the build first*, *Finish planning first, then start
  the build* (1.171.0: a title-only card starts), *Claude is still working…*, *Ship it shows once the
  work is built and checked*, *Write your idea as a card first*).
- Content: `Step 3 of 10` (mono, muted) · title (600) · one or two sentences ·
  optional *Why?* disclosure (the longer explanation, collapsed) · footer
  `Skip this step` (quiet) — the primary action is always the **real control**,
  never a button in the coach-mark. Only "explain" steps (no action needed) get
  a **Next** button.
- The INTERVIEW said the Guide callout went unseen: the coach-mark sits on the
  control itself, the ring is the only accent-coloured outline on screen, and
  on each new step it appears with a 140 ms fade (none under reduced motion).
- When the target is not on screen (another mode, a closed menu), the
  coach-mark is replaced by the panel's instruction plus **Take me there**,
  which calls the step's `navigate` (§4.2). Menus are never opened for the
  user: the step points at the menu button and says what to pick.

### 3.3 The Help menu (`?`)

A sidebar row, **? Help** (the icon and the word, like Board or Settings), at the bottom of the navigation above the foot's line; since 1.169.0 (C9) — it was a `?` icon button left of Settings. The New dot sits at the row's end; the menu opens from the row. Its accessible name is "Help".
Menu items:

- **Getting started** — opens the Guide panel (resumes, or offers the start).
- **Take a 1-minute tour** — the Quick tour (§6.4).
- **New in this version** — the installed version's highlights, with an accent dot until they are opened (§12.2).
- **Tips when I open a section** — toggle (first-visit tips, §6.5).
- **Keyboard shortcuts** — existing `setShortcutsOpen`.
- **User guide** — opens `https://www.plyloft.com/docs/` in the browser (D14; the page comes with Skills hub H11).
- **Get help** (D23) — a sheet: *Tell us what happened. Plyloft adds a short
  report: app version, this Mac or PC, your AI's status and where the tour
  is. No project names, code or text.* **Email support** opens a new email to
  `support@plyloft.com` (confirmed, D28) with the report in
  the body; **Copy the report** for any other channel. Nothing is sent by
  Plyloft itself.

**As built (TU-8).** Help's order: Getting started · Take a 1-minute tour ·
Tips when I open a section · New in this version · Keyboard shortcuts · User
guide · Get help. Get help is a confirm-size sheet: the sentence above (*this
Mac* → *this PC* on Windows), the report behind *What the report says*,
**Copy the report** (the keyboard starts there) and **Email support**: the
backend's `open_support_mail` hands `mailto:support@plyloft.com?…` to the
system's mail app (the webview does not hand `mailto:` over itself, TU-8
Challenger) and refuses any other address and anything but a subject and a
body (no `cc`, `bcc` or attachment). The sheet stays open either way and
always shows the address (*Or write to support@plyloft.com…*): on a Mac the
open answers as soon as it starts, so a Mail app with no account still leaves
the way to write; when the system refuses, a toast says so. *Nothing is sent
by Plyloft itself.* The mail app it starts is the member's, like the browser
a link opens: it outlives Plyloft on purpose (AGENTS.md rule 4 is about
Plyloft's own children — sessions, runs). On Windows, ShellExecute makes it a
child of Plyloft's process, so the app tester's orphan check lists it after a
quit (TU-8 VM walk: the new Outlook, `olk.exe`); that is expected, not a leak.

### 3.4 Sidebar row

While a tour is started and not ended, a status row in the foot (same pattern
and slot as `SetupFinishRow`; the Setup row wins when both apply):
*Getting started · 4 of 10* · `Resume`. While the panel is open it shows the
count with no Resume (1.174.0: one Resume, one place). It goes quiet once B11
is done or skipped (`tourQuiet`; PRINCIPLES 6: nothing permanent for something
occasional) — not when the base chapter ends at B10: with no pill (1.174.0,
owner), the row is where a paused B11 resumes. Drawn on two
lines (*Getting started*, then *4 of 10 · Resume*) so the count is never cut
off at the sidebar's width; it reads as one sentence (TU-4 Mac walk).

### 3.5 Settings

Settings › Account › Setup gains a **Getting started** group: *Resume the
tour* / *Start over*, *Take a 1-minute tour*, *Tips when I open a section*
(toggle, same field as §3.3), *Copy tutorial report* lives in Diagnostics
(§13). Search terms in `settingsIndex.ts`: tutorial, tour, help, getting
started, guide. D17 adds: codex, chatgpt, connect, sign in, second AI
(to the Setup AI step and Settings › This Mac › Claude and Codex).

**As built (TU-8).** Account › Setup › **Getting started**, after Setup: the
*Getting started tour* row (*Start the tour*, or *Resume the tour* while one
is under way, and *Start over* once one was started), *Take a 1-minute tour*
(Start) and *Tips when I open a section* (a switch on `onboarding.tutorial.tips`,
its default the level's). An ended tour is *Resume the tour* (it reopens
where it was, §9). Settings closes, and gives the keyboard back, before the
tour shows (two frames, as Setup's Ready).
Diagnostics › *If you need to show someone* › **Copy tutorial report**. The
search terms are on the Setup page and its three rows, and D17's on the Setup
page and Claude and Codex.

---

## 4. The content model

### 4.1 One manifest

`src/lib/tutorial/manifest.ts` — pure data, no React. Chapters hold steps:

```ts
type TutorialStep = {
  id: string;                 // stable forever: "base.new-card"
  chapter: ChapterId;         // "base" | "inbox-history" | ...
  since: string;              // app version that added or last changed it: "1.170.0"
  audience?: { level?: "guided" | "fast"; mode?: "solo" | "team"; plan?: "pro" | "team" };
  anchor?: TourAnchor;        // data-ply-tour id, or none for panel-only steps
  navigate?: TourNav;         // which existing helper brings the anchor on screen
  done: DonePredicate;        // pure function over a TutorialSnapshot (§7)
  startsAi?: boolean;         // shows the subscription sentence before the action (D8)
  copy: { title: string; body: string; why?: string }; // plain English; "this Mac", ⌘ written once
  covers?: CoverageKey[];     // which destinations it explains (§12.1)
};
```

- Copy is written with Mac words and passed through `machineWords` /
  `formatKeys` at render (`src/lib/platform.ts`), the same as the rest of the
  app. AI words come from the card's Builder vendor (`Claude` / `Codex`), as
  `firstCardGuide.ts` already does.
- `since` is bumped when a step's meaning changes, not for a typo.

### 4.2 Navigation

`TourNav` is a closed union mapped to existing helpers, so the tour can never
mount or unmount a view on its own:

`{ mode: CenterMode }` → `openCenterMode(wsId, mode)` · `{ libraryPage }` →
`openLibraryPage` · `{ card: "tour-card", step? }` → `selectCard` /
`openCardStep` · `{ allSkills: true }` → `setAllSkillsOpen(true)` ·
`{ settings: section }` → `openSettingsSection` · `{ workspace: "tour" }` →
`useWorkspaces.getState().setActive`.

### 4.3 Anchors

A `TourAnchor` is a string id rendered as `data-ply-tour="…"` on exactly one
visible element. The list is exported from the manifest; a Tier 3 test renders
each owning component and asserts the attribute exists (§12.1), and the
release walk asserts each anchor is found on screen (D11). First set:
`nav-board`, `nav-code`, `nav-terminals`, `nav-library`, `nav-inbox`,
`nav-history`, `nav-all-skills`, `nav-search`, `ship-batch`, `help`,
`board-new-card`, `card-brief`, `card-primary` (the Now box's primary action;
it already has `data-ply-primary-action-id`), `card-tab-chat`,
`card-plan-two-ais`, `card-review`, `card-try-it` (the Now box's **Try it**,
TRY_IT_SPEC §3.1; it exists, `TRY_IT_TOUR` in `src/lib/tryPanel.ts`),
`card-more`, `terminals-new`,
`terminals-card-sessions`, `code-more`, `library-tabs`, `settings`.

**Where they are (TU-3).** Sidebar (`WorkspaceSidebar`, drawn once): the
`nav-*` rows, `ship-batch` (the *Ship N in a batch* row, shown only while the
batch has cards), `settings`, and `terminals-card-sessions` on the live
session list indented under Terminals (the one list of card sessions drawn
whatever the Terminals page holds). Board header: `board-new-card` (the
header's New card, not the empty Board's). Card page (`CardDetailPanel`,
`CardStateHeader`): `card-brief` (the *What you want* field), `card-primary`
(Now's primary, beside `data-ply-primary-action-id`), `card-try-it` (Try it, `TRY_IT_TOUR`, typed as a `TourAnchor`: Now's where
Now has it, else the Review's — 1.172.0 C2, on a card Ready to ship),
`card-tab-chat` (*Ask about this card*), `card-plan-two-ais` (*Plan it first
▾*, beside Start build on a card not built yet, which holds *Plan with two
AIs* — 1.172.0 C1), `card-more` (the card's `⋯`),
`card-review` (*Review*, `REVIEW_SECTION_TITLE` — *What shipped* once the card shipped — the section holding the Challenger's review;
closed, it is off screen and the step's `navigate` opens it). Terminals:
`terminals-new` (`New ▾`). Code: `code-more` (*More for Code*). Library:
`library-tabs` (the page column, or the compact row in a narrow centre; never
both). Sidebar foot: `help` (the Help menu's `?`, TU-4). `PENDING_ANCHORS`
is empty since TU-4; an anchor listed there may be missing, and the coverage
test fails once it renders while still listed.

**"Exactly one visible element" (TU-3).** Every warmed workspace keeps its
hosts mounted and hides the inactive ones (`.hidden`), so an anchor inside a
per-workspace host (Terminals, Code, Library, the card page) is in the DOM
once per warmed workspace. The rule is: one element per anchor within any one
host, and outside the hosts (the sidebar) one in the document; of all the
matches, exactly one is on screen. `findTourAnchor` (`src/lib/tutorial/tourAnchors.ts`)
is the one lookup the coach-mark and the release walk use: it skips `.hidden`
hosts, `[inert]` and `aria-hidden` layers (closed card sections, the card
behind Release…, the shell under Setup and Sign in) and the stage under All
skills; it skips what is under the topmost modal (`aria-modal`: Settings,
Search, a sheet over the card) or under the sidebar overlay, so the tour's own
panel and coach-mark are never `aria-modal`; and in the app it asks the
browser's `checkVisibility`, or, in a WebKit without it (the app runs from
macOS 11), the element's box and computed visibility. Not on screen means
`null`: the coach-mark falls back to the panel's instruction and Take me
there (§3.2).

---

## 5. The map the tutorial explains

(From the brief §5, checked against main `37644e49`; the Skills hub lane
confirms the sidebar does not change through H10.)

- **Sidebar, app section:** Search · Inbox · History · All skills (muted count).
- **Workspace modes:** Inbox · Board · Code · Terminals (live sessions
  indented) · Library (Skills / Instructions; TU-7: Knowledge and Notes are
  retired).
- **Foot:** Finish/status rows · *Ship N in a batch* · Help (new) · Settings (⌘,).
- **Card page:** steps Start build → Finish and check → Review → Ship it; the
  Now box; *What you want*; Chat tab; Plan with two AIs; More (`⋯`) with *Open
  a terminal in the card's copy*.
- **Terminals:** `New ▾` (shell, Claude, Codex, Codex chat, layouts Single /
  Split / Quad), card sessions, Command blocks (option).
- **Code:** the project's files (the workspace's own folder, not a card's
  copy), Jump to file, `More for Code › Show localhost preview`.
- **From the Skills hub (on main, 1.167.0):** Copy to… in All skills (H8),
  "Where it's on" and Personalize… on a Plyloft skill's page (H9), My
  library as a section at the top of All skills (H10). Their steps (A2–A4)
  have `since` = 1.167.0 (TU-7).

---

## 6. The path

### 6.1 Chapters

| Chapter | Who sees it | Steps | Length |
|---|---|---|---|
| **Base: your first card** | everyone on the full tour | B1–B10 | ~10 min + the build |
| Inbox and History | everyone | I1–I3 | 1 min |
| Talk before you build: Chat and Plan with two AIs | everyone | P1–P3 | 2 min |
| Terminals in depth | everyone | T1–T3 | 2 min |
| Code and the preview | everyone | K1–K3 | 2 min |
| Library: skills and instructions | everyone | L1–L3 | 2 min |
| All skills | everyone | A1–A4 | 1 min |
| Ship several cards at once | everyone | S1–S2 | 1 min |
| Your team | **team mode only** (D7) | M1–M3 | 2 min |
| Settings and search | everyone (G3 only while one AI is missing) | G1–G3 | 1–2 min |
| *(New in this version is Help's sheet of each release's highlights, §12.2 — not a chapter)* | — | — | — |

### 6.2 The base chapter

Each row: section · what is highlighted · what the user does · how it is
detected (§7) · English copy. Mac words shown; Windows renders through
`machineWords`/`formatKeys` (`⌘` → `Ctrl`, *this Mac* → *this PC*).

| # | Section | Highlight | User does | Done when | Copy (title — body) |
|---|---|---|---|---|---|
| B1 | Guide panel | — | Reads, presses **Start** | `Start` pressed (panel-local) | **How Plyloft works** — *You describe a result as a card. An AI, the Builder, makes it in its own copy of your project, so your files stay as they are. A second AI, the Challenger, checks the work. You read the result and ship it.* Why?: *Board or Terminals? Use a card on the Board when you want something built and checked. Use a session in Terminals when you just want to talk to Claude or try a command.* |
| B2 | Sidebar | `nav-board` | Opens Board | effective mode = `board` in the tour workspace (the active one before a card, §7) | **Open the Board** — *The Board holds your cards, from the idea to shipped.* |
| B3 | Board | `board-new-card` | Creates a card with their idea's title, **or** presses *Use a safe example* in the panel | a card created in the active workspace after `startedAt` (its id becomes `tourCardId`, its workspace the tour's, §7), or the guided first card created | **Write your idea as a card** — *Give it a short title: what you want to have when it's done, like "Add a contact form".* Panel link: *No idea yet? Use a safe example* (creates the README card, §2). New, empty project (no source files): the coach-mark offers three starter titles instead — *Create a one-page website for …*, *Make a to-do list app*, *Add a README that says what this project is for* (D25). |
| B4 | Card page | `card-brief` | Writes *What you want* | brief has ≥ 40 characters (saved) | **Say what you want** — *Write it as if to a person: the result, how you'll know it works, and anything that must not change. Plain words are fine.* Why?: *A good card is one result you could check in a few minutes. Bigger ideas: make several cards, or use Plan with two AIs first (chapter "Talk before you build").* |
| B5 | Card page | `card-primary` (Start build) | Presses **Start build** (leaves Build without asking off) | card state = running / queued | **Start the build** — *This starts Claude with your own subscription, in its own copy of your project. Nothing changes in your files on this Mac until you ship it.* Below the button: *Leave "Build without asking" off: Claude then asks in its session before anything risky.* (Plyloft has no permission menu: with the toggle off it passes no permission flag and Claude Code's own default applies, which on current versions is its auto mode, D30.) Codex: same words with Codex. |
| B6 | Sidebar → Terminals | `nav-terminals`, then `terminals-card-sessions` | Opens Terminals | mode = `terminals` while the card runs | **Watch it work (optional)** — *Your card's session is here, under Terminals. You can read along or answer if it asks something. You don't have to watch.* |
| B7 | Sidebar → Code | `nav-code` | Opens Code | mode = `code` | **What Code is for** — *Code shows your project's files, so you can read or change one yourself. The Builder works in its own copy: its changes show here after you ship.* |
| B8 | Card page | `card-primary` (Finish and check) | When the Builder says it's done, presses **Finish and check** | state = checks / Challenger reviewing / ready to ship | **When it's finished, check it** — *When Claude says it's done, press Finish and check. Plyloft saves the work, runs your project's checks and the Challenger reviews it.* Panel live line while waiting. |
| B9 | Card page | `card-try-it` | Presses **Try it** (answers *How to start your app* the first time: **Save and try**) | the card's Try it panel says *Running* (`data-ply-try-phase="running"`), or a plain website's **Open index.html** opened it (TU-5 Mac walk), or Skip | **See it running** — *See it running: press Try it. Plyloft starts your app in the card's copy and shows it here.* Why?: *The first time, Plyloft asks how your app starts and suggests the command it found. Nothing in your project changes. If it says Couldn't start, the last lines your app printed are under Details: tell the Builder what went wrong.* Skip, or a project Try it can't start: the fallback, §6.3. Shown once the card offers Try it (ready to ship, changes requested, checks done; changes requested → see §11). |
| B10 | Card page | `card-primary` (Ship it) | Presses **Ship it** | `shipStatus = shipped` or `reviewStatus = merged` (same rule as `guideAfterBoard`) | **Ship it** — *Ship it puts the change into main on this Mac* (PR workspace: *opens a pull request on GitHub*). After: **That's the loop** — *Describe, build, check, ship. Pick a chapter below, or come back to it from Help.* (Before TU-7 wrote the optional chapters: *Describe, build, check, ship. Help › Getting started brings the tour back.*) |

B6 and B7 are offered **while the build runs** and the panel says so (*While
Claude works: two things worth seeing*). If the build ends first, they stay
available as "to do" and the tour moves to B8; they never block.

**B5b — When the AI asks you something (D22, interrupt step).** Not counted in
the 10; shown whenever the tour card's presentation rule is `session-block`
(folder trust, Bypass Permissions warning, usage limit) or `builder-waiting`
(`cardPresentation.ts`, the states the Now box already shows). The coach-mark
points at the Now box's **Open the Builder** and says, by kind:

- trust — *Claude asks whether you trust this folder, once for this project.
  It's your project's copy for this card: answer Yes in the session to let it
  work.* (1.171.0 D2: a Yes in a card's copy covers the whole project.)
- permission / waiting — *Claude is waiting for your answer. Open the session,
  read its question and answer there. "Yes" lets it go on; you can say no and
  tell it what to do instead.*
- usage limit — *Your Claude plan reached its limit for now. The session says
  when it resets; then type "continue" there. Nothing is lost.*
- bypass warning — *Claude shows a warning before working without asking.
  Read it and choose in the session.*

Plyloft never answers for the user (existing rule). Done when the state
clears. A Builder whose turn is over (`builder-waiting` in its *stopped*
state, primary Finish and check) is B8's moment, not a question (TU-5). Outside the tour the same text shows once as a first-time tip
(§6.5). Codex words follow the vendor.

**B11 — Your second card, on your own (D24).** After B10 the panel offers
*Try one more card on your own.* No coach-marks: the panel shows only the
checklist (title → what you want → Start build → Finish and check → Try it →
Ship it), ticking itself from the card's state, with one-line hints on
request (**Hint**). Done when a second card ships; then the panel goes quiet
(§3.4). This is the fade-out the first user lacked. The checklist follows
the newest ordinary card made since the tour started that is not the tour
card, whatever it was made for: a draft made for an optional chapter (P1's
card to Chat on) is a new card like any other, so it ticks *Title*, and only
its ship would do B11 (TU-7 Mac walk: the simpler rule; the checklist is
shown with the base chapter only).

### 6.3 "How do I try it?" — the fallback when Try it can't start the app

Try it (TU-X, [TRY_IT_SPEC](../try-it/TRY_IT_SPEC.md)) is B9's action and
K3's. This text remains only as the fallback: shown under B9 when the user
skips it, or when the project has no start command and the user closed the
*How to start your app* sheet, and in K3 for a project Try it can't start.

- *Before shipping:* *Open ⋯ on the card and choose "Open a terminal in the
  card's copy". Start your app there the way you usually do (for many web
  projects: `npm run dev`). Then open More for Code › Show localhost preview,
  choose Web page and type the address it prints.* The command and the port
  live behind **Details**.
- *After shipping:* *Your change is in your project. Start your app the way
  you usually do; More for Code › Show localhost preview finds it on the common
  ports.*
- *A plain website* (the sheet said *This looks like a plain website*; TU-5
  Mac walk): nothing is started, so no terminal and no localhost preview.
  Before shipping: *This is a plain website: press Try it on the card and
  choose Open index.html. It opens in your browser; nothing is started.*
  After: *Your change is in your project. Open its index.html in your
  browser to see it.* The sheet's **Open index.html** itself completes B9:
  the user saw the result.

### 6.4 The Quick tour (fast level, D7)

Explain-only coach-marks with **Next**, no waiting on actions: Board → card
page anatomy (on an existing card if any, else the Board) → Terminals →
Code → Library → Inbox → All skills → Ship batch → Help. Nine marks, about a
minute. Last mark: *The full tour is in Help › Getting started.* Team users get
one extra mark on the team rows.

**As built (TU-6).** `src/lib/tutorial/quickTour.ts` (the marks, pure),
`store/quickTourStore.ts` (in memory), `components/tutorial/QuickTourLayer.tsx`.
- Started from Help › *Take a 1-minute tour* and from Ready on *I use them
  regularly*: a quiet *Take a 1-minute tour* there takes the place of the
  guided first card (which stays in the full tour's B3; a guided card under
  way keeps its *Open the guided first card*). Setup closes first.
- The marks, each the coach-mark with **Next** (**Done** on the last) and
  **Close**: the Board row → a card's page (the newest ordinary card of the
  active workspace, its main button; no card: the Board's New card) →
  Terminals' New → More for Code → the Library's pages → *(team, or an
  unknown mode: the team's library, on the Library's pages)* → the Inbox row
  → the All skills row → the Ship in a batch row → Help. The team mark is the Library's: the sidebar has no team
  row to point at.
- The page moves only through `openCenterMode` and `selectCard`, in the
  workspace on screen (never the full tour's own, which may be another
  project); nothing is pressed. A card opened by mark 2 is put back as it was before
  mark 3. When it ends on the page it last put on screen it puts back the
  page it started from (mode, card, All skills); if the member went somewhere
  of their own meanwhile, it leaves them there.
- A control not on screen (Ship in a batch with nothing to ship, a mode with
  no project) shows the same words docked where the Guide panel sits, after
  400 ms.
- Keyboard (§10): unlike the full tour, Next takes the focus on each mark —
  Next is the only thing to do; the focus moving into each new mark says its
  name, so there is no live region for it. Done and Close put the page back
  (mode, card, All skills, the centre stage shown or hidden) and the
  keyboard on Help, or on the button that shows the sidebar when it is
  folded away; Esc closes the tour and leaves the page as it is, the
  keyboard on the control (a docked mark: on Help). Started again while it runs, it starts over and
  still goes back to where the member first was.
- While a modal is up (Search, Settings, a sheet) the marks stand aside and
  never take its keyboard; the mark comes back when it closes.
- One guide at a time: the full tour's panel and coach-mark stand aside while
  it runs and come back as they were; opening or resuming the full tour from
  anywhere (Help, the sidebar row, Setup's Start the tour) ends it
  and puts away a first-visit tip (`beforeGuideOpens`). The full
  tour does not look while it runs (`holdTourObservationWhile`), so the Board
  it opens is not B2, and it looks again as it ends (`recheckTour`).
- The record: `path: "quick"` only (no `startedAt`: no full tour starts), and
  the sections it showed in `seenSections`, so their tips do not repeat it.

### 6.5 First-visit tips (D6)

When a section listed in §12.1 opens for the first time **and** no tour is
running **and** *Tips when I open a section* is on (default on for `guided`,
off for `fast`, D15), its chapter's first step shows as a single coach-mark with
**Show me the rest** (opens that chapter in the panel) and **Got it**. Seen
sections are remembered (§8); each tip shows once.

**As built (TU-6).**
- Sections with a tip: Terminals, Code, Library, Inbox, History and All
  skills (`TIP_SECTIONS`). The Board and a card's page are the base
  chapter's, which is the full tour itself.
- Until TU-7 writes the optional chapters there is no chapter step to show:
  a tip uses the Quick tour's words for its section (History has its own,
  §6.6's I3), on the same control, and has **Got it** only. TU-7 adds **Show
  me the rest** with the chapters.
- A tip shows when the section on screen changes to it (the member opening
  it, a workspace switch onto it included): never for the one the app opened
  on, nor for the page the Quick tour puts back. Not while a full tour is started
  and not ended (paused too), the Quick tour runs, Setup or Sign in is up, or
  a sheet is open. It never takes the keyboard: it is said politely (its
  title and words) a frame after it shows; Got it puts the keyboard on the
  control. It is written to `seenSections` once it is on screen (a tip
  whose control never showed has not been shown).
- The switch: Help › *Tips when I open a section* (a checkbox item; it
  writes `tips`). Unset, it follows the level: on for step by step, off for
  just the essentials and when the level was never asked. The Settings
  group (§3.5) is TU-8's.
- §11's old user (no new nags): a tip is neither a toast nor a tour start,
  so the level's default applies to them too; one tip per section, once.

### 6.6 Optional chapters (outline; final copy in TU-7)

- **I — Inbox and History:** I1 Inbox (*Everything waiting for you: cards
  that need you, OKs for scripts, things that were refused.*) · I2 per-workspace
  Inbox vs the app Inbox · I3 History (*Cards you've shipped, with what
  changed.*).
- **P — Talk before you build:** P1 Chat tab (*Talk about the card with Claude
  or Codex, attach a screenshot, a PDF or a Word file. Chat only talks; it
  changes nothing.*) · P2 Plan with two AIs (*One AI writes a plan, the other
  questions it, before the build. Good for bigger ideas.*; `startsAi`) · P3
  when to use which. One-AI machines: words follow ONBOARDING_SPEC §13.4,
  checked at build.
- **T — Terminals in depth:** T1 `New ▾` (shell, Claude, Codex, Codex chat;
  `startsAi` on the AI ones) · T2 layouts Single / Split / Quad · T3 Command
  blocks (option, behind *Why?*).
- **K — Code and the preview:** K1 files and Jump to file (`formatKeys`) · K2
  More › Show localhost preview (a running Try it is listed first) · K3
  after Ship, **Try it in <project>** on the Ship receipt or the *Shipped*
  toast (TRY_IT_SPEC §3.2): *Your change is in your project now. Try it in
  lyra starts your app in the project's own folder and shows it here, in
  Code's preview.* Done when the strip above the preview says *Running*, or
  when its *How to start your app* sheet's **Open index.html** opened a plain
  website (as B9; tryRunStore's `indexOpened` under the project's key), or
  Skip; §6.3 as the fallback, in a plain website's words when the sheet
  called the project one. **A plain website** (TU-7 Mac walk): Try it in
  <project> is offered only with a start command, so its sheet never opens
  there; the tour reads the project's start command once per launch when
  the Code chapter is shown (`project_try_command_get` through `tryRowState`,
  the Settings row's own reading: no command saved and an index.html found).
  K3 is then explain-only (Next) and says *lyra is a plain website, so there
  is nothing to start. Open its index.html in your browser to see it.*
- **L — Library:** L1 Skills (*Instructions the AI can follow for a kind of
  task. They come from this repository, your team, this Mac and Plyloft.*) ·
  L2 Install / Update / Link · L3 Instructions. (TU-7: L4 Knowledge is gone —
  the Library has only Instructions and Skills; the team's library is named
  in L1's words, which read the same solo and in a team.)
- **A — All skills:** A1 every skill of every workspace · A2 Copy to… · A3
  Plyloft's own skills: Where it's on and Personalize…, on the skill's
  Library page (All skills › the skill › *Open in the Library*) · A4 My
  library;
  A2–A4 `since` = 1.167.0, the Skills hub's release.
- **S — Ship several cards:** S1 *Ship N in a batch* (explain-only) · S2 what a batch does.
- **M — Your team** (team mode): M1 the shared skill library · M2 shared
  workspaces (*Clone and add* is on the row of a team workspace this Mac
  doesn't have yet; *Register* on one whose checkout is here but not added;
  one already added says *Open here*) · M3 invites.
- **G — Settings and search:** G1 Search (⌘K / Ctrl+K via `shortcutKeys`) ·
  G2 Settings sections and where Setup lives.
  · G3 **Add a second AI** (D17): *Plyloft works with one AI. With both
  Claude and Codex, one builds and the other reviews.* Highlight: the Setup
  row in Settings › Account; **Take me there** opens Setup's AI step
  (`openSetup("rerun", "ai")`); done when both AIs read Ready (or Skip). Shown
  only while one AI is missing. Also offered as a single coach-mark after the
  base chapter's B10 when only one AI is ready.

**As built (TU-7).** Step ids are `<chapter>.<name>` (`inbox.open`,
`talk.chat`, `settings.second-ai`, …; `manifest.ts::OPT`), each with its
`<!-- tour:… -->` marker in the guide text. Every optional step follows the
**active** workspace (`followsActive`): its mode, Library page and card open
there and it never says *This step is in …*; it waits only for a workspace
when its place is in one (*Add your project first*). Each counts in its own
chapter (*1 of 3*). Action steps are done by the app's state — I1 the Inbox
open, I3 History, P1 a card's Chat open, T1 a session in Terminals, K1 Jump
to file open (⌘P), K2 Code's localhost preview open, K3 Try it in <project>
*Running* (or its sheet's Open index.html; explain-only on a plain website), L1/L3 the Library on Skills / Instructions, A1 All skills open,
G1 Search open, G2 Settings open, G3 both AIs Ready. Steps with nothing to do
are explain (Next, with Show me or Take me there): I2, P2 (it says the
subscription first; on one AI, §13.4's *Both views come from …*), P3, T2,
T3, L2, A2–A4, S1–S2 and M1–M3 (Settings pages keep no state
the tour reads, and the panel stands aside while Settings is up). K1 is
*Jump to file*, the words Code itself shows (the Code opener and *More for
Code › Jump to file…*; *Go to a file* is only the shortcut list's name for
⌘P). The panel lists the other
chapters under *More, when you're ready* with their length (*3 steps*,
*1 of 3*, *Done*); the chapter picked is in memory, and a launch shows the
base chapter again (the panel never moves to a chapter on its own). An
optional step counts only while its chapter is shown: opening the Inbox
during the first card is not the Inbox chapter begun, and a chapter is never
*Done* unread. Skip chapter skips the rest of the chapter shown. G3's offer
after B10 is a note in the panel (not a coach-mark): *Add a second AI* opens
Setup's AI step and *Not now* skips G3, so it is offered once. The team
chapter follows `useSolo()` (§11): absent in solo, listed while the mode is
still unknown. No anchor was added: the steps point at §4.3's set, or are
panel-only. A card-bound step (B4–B10, B5b) points only on the tour card's
page; an optional step with a card anchor (P1 Chat, P2 Plan with two AIs)
points on whatever card page is open in the active workspace, and on none
while none is (TU-7 Mac walk).

---

## 7. Detection

- Same model as the guided first card: **state, never clicks**. A pure
  `tutorialEngine.ts` evaluates `done(snapshot)` for the current step on every
  change of the stores it reads (`useUi`, `useKanban`, `useWorkspaces`,
  `useSettings`, the tile store, `useAccount.gates`, `useWorkMode`), through
  one subscription started in `App.tsx` beside `startFirstCardGuideSubscription`.
- `TutorialSnapshot` = tour workspace id, effective centre mode, All skills /
  Ship batch / Settings open, the tour card (state via the existing
  `CardPresentationState`, brief length), tile counts per kind, plan gates,
  solo/team, level, platform.
- A step done out of order is recorded when observed (any step whose `done`
  holds is marked, not only the current one); the current step is the first
  not done and not skipped in path order — except that an explicit **Do it
  now** wins until that step is done or skipped again, even B6/B7 (offered
  beside the current step) and a step whose moment is gone (in memory: a
  launch goes back to the first step to do; Start over, End, the card
  confirmed gone, or the tour no longer running forget it).
- A step about **where you are** (B2, B6, B7: `visit`, a mode) counts out of
  order only when it becomes true while the tour runs — the place the tour
  started or started over in is not the user doing it, nor the place the
  app opens in at launch (a fact seen only as the workspaces, the mode or
  the tour card's board load). As the current step it counts as it is (on
  the Board when B1 is done: B2 done). Terminals already open when the build
  starts is a change (B6 counts); a relaunch onto Terminals mid-build is not
  (B6 stays to do and never blocks).
- **The tour workspace** (TU-5 walk) is the tour card's workspace once B3 has
  taken a card; before that the tour belongs to no workspace and follows the
  **active** one, wherever the user is now: B2 and B3 count there, B3 takes a
  card made there, and the empty-project look (D25)
  reads there. So a tour begun in one project and resumed, reopened from Help
  or started over in another starts in the one on screen; *This step is in
  lyra* · **Take me there** is only ever about the tour card's workspace (a
  card step, or a B2 done again with *Do it now* after a card). The guided
  first card made for the tour binds it to the guided card's workspace.
- Card-bound steps (B4–B10) watch `tourCardId` only. A card deleted, or its
  workspace removed, returns the tour to B3 with *That card is gone. Start
  another one.* (same on-disk confirmation as `guideAfterBoard`); the card's
  workspace goes with it, so B3 follows the active workspace again. After
  Ship it is recorded nothing is taken back, and B11's second card may be
  made in any workspace (unchanged).
- Explain-only steps are done by **Next**.

---

## 8. Persisted state and migration

### 8.1 Field

`settings.onboarding.tutorial` (new), TS in `settingsShape.ts` +
`DEFAULT_SETTINGS`, Rust `TutorialProgress` in `OnboardingSettings`
(`settings.rs`), every field `#[serde(default, skip_serializing_if =
"Option::is_none", deserialize_with = "lenient_opt")]`:

| Field | Type | Meaning |
|---|---|---|
| `startedAt` | ISO string? | full tour started |
| `path` | `"full"` \| `"quick"`? | which tour was last started |
| `workspaceId` | string? | the tour card's workspace, set with `cardId` by B3; unset before a card (the tour follows the active workspace, §7). Read only together with `cardId`: an older record that names a workspace with no card is read as unset, and the next start or Start over drops it |
| `cardId` | string? | `tourCardId` (B3) |
| `done` | map stepId → ISO | steps done, with when |
| `skipped` | map stepId → ISO | steps skipped |
| `paused` | bool? | panel collapsed |
| `endedAt` | ISO? | *End the tour* pressed |
| `seenVersion` | string? | last version whose New-in steps were seen |
| `tips` | bool? | first-visit tips; unset = level default |
| `seenSections` | string[] | first-visit tips already shown |

- Maps keyed by step id keep **unknown ids** untouched (a newer app's steps
  survive an older app's save; an id removed from the manifest is ignored).
- Settings is per Mac/PC; the tour is per machine. Not synced to the team.
- Written through `useSettings.getState().update` (whole-file atomic replace,
  Hard rule 3); `resetAllOnThisMac` keeps `onboarding` (unchanged).
- `settingsFields.ts`: `onboarding.tutorial.tips` is a real field (Settings
  toggle); the rest go in `NOT_A_FIELD`.

### 8.2 Tests (PPVP Tier 2)

On the model of `pre_v153_onboarding_loads_without_setup_state`:

1. A pre-tutorial `settings.json` fixture (copy of the current release's real
   shape) loads with `tutorial` unset and every other key unchanged.
2. An untouched save rewrites the onboarding block byte-identical.
3. Every tutorial key round-trips (Rust and TS).
4. Bad values (wrong types, non-ISO strings, unknown `path`) read as unset;
   unknown step ids in `done`/`skipped` survive a round-trip.
5. `settingsFields.test.ts` passes with the new leaves.

---

## 9. Pause, skip, resume, reopen, start over

- **Pause** (panel header): collapse to the sidebar row (no pill since
  1.174.0). Quitting the app is an implicit pause; the next launch shows the
  row (not the open panel) so it never jumps at the user.
- **Resume:** sidebar row, Help › Getting started, Settings. Resumes at
  the first step not done/skipped, re-evaluating `done` first.
- **Skip this step** / **Skip chapter** (`⋯`): recorded in `skipped`; skipped
  steps show *Skipped · Do it now*.
- **End the tour** (`⋯`): sets `endedAt`; the row goes; Help still
  offers *Getting started* (*Start again*). Reversible, so no confirm sheet
  (PRINCIPLES 7).
- **Start over:** clears `done`, `skipped`, `cardId` and its `workspaceId`,
  `endedAt`; keeps `seenVersion`, `tips`, `seenSections`. A real restart:
  *0 of 10*, B1, in the active workspace — the Board already open does not
  mark B2 (§7, where you are).
- **Ready's tour button** (§2, TU-5 walk) runs in Setup's project, which it
  makes the active one first. It reads **Resume the tour** only for a tour
  under way (paused counts) that has got somewhere: a card taken, or a step
  past B1 done or skipped. Resume carries on where it is: before a card, in
  Setup's project; with a card under way in another project, there (its
  steps say *This step is in …*). Otherwise it reads **Start the tour** and
  starts from B1 in Setup's project: a first start, or a Start over of a
  tour that never got past B1 or has ended (an ended tour is not reopened on
  its old card from Ready; Help › Getting started still reopens it where it
  was).
- **Setup open:** the app is `inert` behind Setup; the tour hides and returns
  when Setup closes. B-steps that need Setup (no AI, no project) send the user
  there with `openSetup("rerun", step)`.
- **Another workspace:** the panel stays; card-bound steps show *This step is
  in lyra* · **Take me there** (`setActive`). Before a card there is no
  other workspace: B2 and B3 follow the active one (§7).

---

## 10. Accessibility

- **Panel:** `role="region"` `aria-label="Getting started"`; not a dialog, no
  focus trap; reachable by Tab from the page end and by the Help menu. Step
  changes announced in a polite live region (*Step 4 of 10: Say what you want*).
- **Coach-mark:** `role="dialog"` `aria-modal="false"`, `aria-labelledby`
  title, `aria-describedby` body; the target gets `aria-describedby` pointing
  at the coach-mark while it is shown, so a screen reader landing on the real
  control hears the instruction. Focus is **not** moved into the coach-mark on
  appear (the user's focus stays where it was); `Show me` moves focus to the
  target. Esc hides the current coach-mark (`useEscapeFirst`, below open
  menus and sheets), never ends the tour.
- **Keyboard:** every panel action is a button; menus follow `MenuList`.
- **Contrast:** ring = `--claude-accent` (light `#7c3aed` on `#f6f6f7`, dark
  `#a78bfa` on `#1c1c1e`, both ≥ 3:1 for non-text); text on `--raised` uses
  `--fg` / `--muted`. Checked in light, dark and void.
- **Motion:** fade only; nothing pulses; `prefers-reduced-motion` → no fade.
- **Sizes:** 14 px UI, nothing under 12 px, 30 px controls (BOARDS §0).
  *Why?* is one step below the body it follows, muted: 12 px under the
  panel's 13 px step text, 13 px under the coach-mark's 14 px body (TU-4 Mac
  walk: at 15 px it read larger than the step).

---

## 11. Edge cases

| Case | Behaviour |
|---|---|
| No workspace | B2 becomes *Add your project first* → `openSetup("rerun","project")`. |
| AI not ready / signed out | B5 shows *Claude isn't ready yet* + **Finish setup** (Setup AI step); the step waits. Codex-only: all words say Codex. |
| Both AIs | Words name the card's Builder; *Build with both* is mentioned only under *Why?* |
| An agent already running on another card | Fine; the tour's card is its own, and every plan builds cards in parallel (1.178.0: the Free plan's one-card limit is gone). |
| Solo / team | Team chapter and team rows only when `useSolo()` is false; unknown mode shows everything (existing rule). |
| Free / Team | Every individual feature is free: no step carries a plan mark. Only the team steps depend on the plan. |
| Changes requested (Challenger) | B9 waits; panel: *The Challenger asked for changes and the Builder has them. When it's done, press Finish and check again.* (firstCardGuide wording). |
| Usage limit (Claude Pro) / Codex limit | B5b usage-limit words; the panel's live line says *Paused until 15:40* when `resetsAt` is known. |
| AI asks for trust / permission mid-build | B5b (D22). |
| New, empty project | B3 starter titles (D25); Try it asks how to start once something exists. TU-5: "empty" is read once per launch when B3 shows: no file but a README, a licence or a changelog. The look reads one folder at a time (`fs_list_dir`), at most 24, skips build output and package folders, and stops at the first source file; more folders than that is "not empty" (Challenger: never a walk of the whole tree on the main thread). |
| Stopped / failed | Panel: *Something stopped. The box on the card says what and what to do; the tour waits.* |
| Ship as pull request | B10 words for PR; done on `reviewStatus = merged` *or* the card has an open pull request (`card.prUrl` set, `pr.state = "open"`, as `cardLifecycle.ts` reads it) — the loop is complete once the PR exists; the panel says *Merge it on GitHub when you're ready.*, or *GitHub merges it when the checks pass.* when the pull request merges by itself (`pr.autoMerge`, G1) |
| Guided README card already exists (old user) | B3 offers *Continue with "Describe this project in the README"*. Its project's board not loaded (TU-5 Mac walk): *Continue with your guided first card* until the tour reads that board (`kanban_load`, once), then its title; a card gone from it is not offered, and *Use a safe example* is. A board that can't be read: neither is offered, and the read is not tried again in this launch (Challenger). TU-5 (Challenger): *Use a safe example* is offered only where Setup would offer the guided card (no record, or one dismissed); a guided card that shipped is not made again. |
| Old user upgrading (has shipped cards) | No automatic start and no toast (no new nags): the Help dot for New in this version, and the full tour in Help. |
| Anchor missing (renamed UI) | Coach-mark falls back to the panel text + **Take me there**; Diagnostics logs `tour anchor missing: <id>`; the release walk fails (§12). |
| Window hidden (close) / reopened | State is in the store; nothing to do. Cmd-Q / Ctrl+Shift+Q = pause. |
| Windows | `machineWords`, `formatKeys`, *File Explorer* via `platformWord`; walked in the VM (§15). |

---

## 12. Keeping it current (D3, D11)

### 12.1 Coverage test in the gate (vitest)

`src/test/tutorialCoverage.test.tsx` (`.tsx`: vitest collects only those):

1. **Every destination has a step or a written exemption.** Destinations =
   the `CenterMode` union, the sidebar's nav items (exported as one
   `NAV_DESTINATIONS` list from the sidebar module, which the sidebar renders
   from), `settingsNav` sections, and card-page sections that carry
   `data-ply-card-section`. Each must appear in some step's `covers` or in
   `NOT_A_TOUR_STEP` with a reason (pattern: `NOT_A_FIELD`).
   TU-3: `NAV_DESTINATIONS` is `src/lib/sidebarNav.ts` (every `shell-nav-item`
   row takes its words, icon and anchor from it); the Library pages
   (`library:<page>`) are destinations too; the card sections are
   `CARD_PAGE_PARTS` (`cardLifecycle.ts`), which types `CardSection`'s name.
   Each list is the app's own: `CENTER_MODES` and `LIBRARY_PAGES` fail to
   compile when their union gains a member they lack, the Settings pages are
   `SETTINGS_NAV`'s entries, and the sidebar test fails when a
   `shell-nav-item` row is drawn that `NAV_DESTINATIONS` does not list.
   The lists are in `src/lib/tutorial/coverage.ts`, with a third way besides
   `covers` and `NOT_A_TOUR_STEP`: `PLANNED_IN_CHAPTER`, a destination an
   optional chapter (§6.6) will explain. It is allowed only while that chapter
   has no steps, so TU-7 moves each one to its step's `covers`.
2. **Every anchor exists:** each `TourAnchor` is rendered by its owning
   component (render test; PATTERNS "render it, do not read its source").
3. **Every step is in the user guide:** `docs/onboarding/USER_GUIDE.md`
   contains `<!-- tour:<step-id> -->` for every step id, and no marker names a
   step that no longer exists.
   TU-9 folded the draft (`docs/tutorial/USER_GUIDE_TOUR.md`, now removed)
   into the guide's *The Getting started tour*, after *Finding your way
   around*; the test and `tutorialEngine.test.ts` read the guide.
4. **Copy passes the language rules:** step copy has no banned words
   (worktree, snapshot, origin, stash, rebase, fast-forward, PATH, CLI,
   sandbox, SHA) outside `why`-Details, matching `ux-check`.
5. **`since` is a valid version ≤ the next release** (same idea as the
   Skills hub `CHANGES.json` check).

### 12.2 New in this version

**Owner, 2026-10-21 (after 1.167.0): each release's highlights.** The
step-based chapter built for TU-8 (steps whose `since` is newer, the tour as
one row in its own release) was empty on every opening after the first. Help
› **New in this version** now shows:

- the **installed version's highlights**: its title and three to five points
  in the site changelog's plain words (`src/lib/releaseHighlights.ts`,
  `RELEASE_HIGHLIGHTS`, newest first, from 1.167.0 on), always, however often
  it is opened;
- under *Since you last looked*, the highlights of the versions between the
  one last looked at (`seenVersion`) and this one, newest first;
- **Full changelog**, `https://www.plyloft.com/changelog` in the browser;
- on a point about a place, its button (*Open All skills*, through the tour's
  helpers, §4.2); on the tour's point, **Start the tour** and **Take a
  1-minute tour**.

The dot on `?` (and the entry's *New*) shows while the installed version's
highlights haven't been opened (`seenVersion` older, or unset: an old user
upgrading). A new install is stamped with its version at start, while
Setup's first run isn't done (`stampNewInstall`), so someone new gets no dot
but still finds the points. A patch release with no entry shows its minor's.
`releaseHighlights.test.ts` (the pure contracts) fails a build whose
`package.json` version has no entry, a release with fewer than three or more
than five points, or internal card numbers in the words. Each step's `since`
stays: the coverage test and the release walk use it.

### 12.3 Rules for every release

- **The release's highlights** (owner, 2026-10-21): the release PR writes the
  version's entry in `src/lib/releaseHighlights.ts` from its STATUS entry (a
  minor release: three to five points; a patch release may reuse its
  minor's); `releaseHighlights.test.ts` fails the gate otherwise
  ([RELEASING](../RELEASING.md), *New in this version*).

- AGENTS.md, *Verification and shipping*: one line — *A change that adds,
  renames or moves a section updates its tutorial steps (`since`), the
  USER_GUIDE markers and copy; the coverage test enforces it.*
- `ply:release-notes` skill: one line to list the release's new or changed
  tour steps. Edited from main **after** Skills hub H9 merges, with its
  `CHANGES.json` entry and history copy (coordination).
- **The user guide is published on the site at every release (D26).** The
  guide's source stays `docs/onboarding/USER_GUIDE.md`; a release step copies
  it to `plyloft.com/docs/` (plyloft-site; built with H11, touched only with
  the owner's go). `release.sh` refuses a release whose guide changed since
  the last published copy unless the site copy is updated (same idea as the
  CHANGES.json check). The site page must exist before the tour ships.
  TU-9: the site copy is `src/content/docs/docs/guide.md` in plyloft-site
  (`/docs/guide/`), made by `scripts/site-guide.mjs`; `release.sh` compares
  it before building with HEAD's guide and needs it committed on the site's
  `main`, and skips the check when there is no site repository (RELEASING, *The user
  guide on the site*). The `ply:release-notes` line is generic, since the
  skill ships to every user (CHANGES.json 1.167.0).
- The release Tier 4 walk includes **"Tour anchors"**: the app-tester runs
  the Quick tour and fails on any coach-mark that falls back (§11).

---

## 13. Measurement (local only, D9)

- From `done`/`skipped` timestamps: steps done, steps skipped, where the tour
  was paused or ended, time from `startedAt` to B10 (first shipped card).
- Settings › Diagnostics › **Copy tutorial report**: copies plain text (app
  version, platform, level, solo/team, plan, path, per-step done/skipped with
  relative minutes). **No** project names, card titles, briefs or paths
  (SAAS point 4). The user chooses to paste it.
- Nothing is sent anywhere. **Get help** (§3.3) puts the same report in an
  email the user sends themselves.

**As built (TU-8).** `tutorialReport` (`whatsNew.ts`): the app version, macOS
or Windows, the level, solo or team, the plan (Free / Team from the
account's gates), whether the full tour is under way, paused or ended, which
tour was last started, each known step done or skipped with its minutes from
the start, steps a newer app recorded counted (never named), the minutes to
the first card shipped with the tour, and how many tips were shown. Never a
workspace or card id, a name, a title or a path (tested). Get help's adds
Claude and Codex ready or not (*not checked yet* before the doctor has
run), and where the tour is (*4 of 10 done, on base.brief*, the step's id).
Copy uses the clipboard; a refused copy says so in a toast. The email carries
the short report (counts of steps done and skipped, not each step), so the
link stays short; Copy carries the whole one.

---

## 14. SAAS_READINESS five-point review

1. **No personal identity:** copy uses generic examples; no owner names,
   paths or machines. ✔
2. **No self-ship coupling:** the tour reads ship state; it never calls the
   self-ship path or `install-local.sh`. ✔
3. **Never assume a tool exists:** AI-dependent steps check readiness and
   route to Setup with plain words. ✔
4. **Customer code stays on the machine:** no telemetry; the report holds no
   content. ✔
5. **A stranger could use it:** written for the primary persona, both OSes,
   both AIs, one or two AIs, solo or team, every plan. ✔

---

## 15. Implementation cards

Build only after Skills hub H10 merges, beside H11; merge main first and
re-check §5. One branch per card (`feat/tutorial-tuN`), Builder → Challenger →
gate (`./scripts/ppvp.sh` 11/11 + `npx vitest run`) → Tier 4 walk on the Mac
**then** in the Windows 11 VM (never in parallel) → PR merge if green. No
release (the owner releases). Shared build dir and test server by turns with
the Skills hub lane.

| Card | Scope | Depends | Acceptance | Checks | Tier 4 walk |
|---|---|---|---|---|---|
| **TU-0 User review of the live version** (D27, moved after the release by D29) | After the owner's release, the first user reviews the real app with USER_CHECK.md's questions; ask "what would you press here?" per screen; record answers in `docs/tutorial/INTERVIEW.md`; fix spec/mockups | — | Every screen understood or changed | Owner + user, no code | N/A — documented |
| **TU-1 State** | §8: `TutorialProgress` Rust + TS, defaults, `settingsFields`, `NOT_A_FIELD` | — | Old files load; untouched round-trip; unknown ids survive | Tier 1, **Tier 2** (§8.2), `cargo test --workspace --lib` focused | N/A (no UI) — documented |
| **TU-2 Engine + manifest** | §4, §7: manifest types, `tutorialEngine.ts` (pure), snapshot, subscription; base chapter data only | TU-1 | Every base step's `done` covered by Tier 3 tests per state (incl. taking another card, PR ship, changes requested, card deleted) | Tier 1, Tier 3 | N/A (no UI) — documented |
| **TU-3 Anchors + coverage test** | §4.3, §12.1: `data-ply-tour` attributes, `NAV_DESTINATIONS`, coverage test, USER_GUIDE markers for the base chapter | TU-2 | Test fails when an anchor or marker is removed (proved once) | Tier 1, Tier 3, ux-check | Visual: sidebar and card unchanged (Mac + Windows) |
| **TU-4 Panel, coach-mark, Help** | §3: `GuidePanel`, `CoachMark`, Help menu, sidebar row, pause/resume, a11y §10 | TU-2, TU-3 | Opening/closing the panel never unmounts a host: terminals keep scrollback, editor keeps its view | Tier 1, **Tier 1.5**, ux-check | Panel + coach-mark in light/dark, keyboard and VoiceOver / Narrator pass |
| **TU-5 Base chapter end to end** | §6.2–6.3 incl. B5b and B11, Ready offer change, FirstCardGuide hidden during the tour, safe example, Setup routing; the live line's minutes (*Claude is building · 3 min*, §3.1) and *Paused until 15:40* (§11), which TU-4 leaves out (its live line names the Builder only) | TU-4 | A fresh user ships their own first card with the tour; README path also works; quit mid-build and resume | Tier 1, Tier 1.5, Tier 3; **PTY rule:** Max-auth Claude tile still passes, exit/orphan check after quitting mid-build | **Full B1–B11** incl. a trust question, a permission question and (simulated) usage limit: Mac + Claude, Windows VM + Codex (+ Codex-only words), PR workspace ship |
| **TU-6 Quick tour + first-visit tips** | §6.4–6.5 | TU-4 | Fast level sees only the offer; tips once per section; toggle works | Tier 1, Tier 3 | Quick tour Mac + Windows; tips on/off |
| **TU-7 Optional chapters** | §6.6 copy + steps (incl. Skills hub H8–H10 sections as merged) | TU-5 | Each chapter completes; team chapter absent in solo | Tier 1, Tier 3, coverage test green | Each chapter once (Mac), team + solo; Windows: T, K, L |
| **TU-8 New in this version, report, Get help** | §12.2, §13, Settings group §3.5, Get help sheet §3.3 | TU-5 | Simulated version bump shows only newer steps; report contains no titles/paths (test). *Since 2026-10-21: the sheet is each release's highlights (§12.2), its test `releaseHighlights.test.ts`.* | Tier 1, Tier 3 | Help dot → chapter → dot gone; Copy report |
| **TU-9 Docs and rules** | USER_GUIDE section (draft on this branch), glossary, site publish step and `release.sh` check (D26, with H11), AGENTS.md line, `ply:release-notes` line (+ CHANGES.json, after H9), STATUS text handed to the Skills hub lane, release-walk "Tour anchors" step in PPVP Tier 4 list | all | Docs match the build | Focused inspection; PPVP | Release walk includes Tour anchors |
| **TU-X Try it** (separate product card, D12; spec: [TRY_IT_SPEC](../try-it/TRY_IT_SPEC.md)) | A *Try it* action on the card: start the project's dev command in the card's copy on its port and open the preview; port probe includes the card block; a "how to try it" line after Ship | — (own spec) | — | own | own |

Order: TU-X (own spec, then build; D13: it ships before or with the
tutorial) · TU-1 → TU-2 → TU-3 → TU-4 → TU-5 → (TU-6, TU-8 in parallel) →
TU-7 → TU-9; after the owner's release, TU-0 (the first user's review, D29) and a **real first-run test** with a new user after TU-5 (D27),
measured with the Copy report. B9 is written against Try it's real action; §6.3 stays only as
the fallback text for a project Try it can't start.

---

## 16. Resolved points

1. Try it: its own card, before or with the tutorial (D13).
2. Help › User guide: `https://www.plyloft.com/docs/` (D14).
3. First-visit tips on the `fast` level: off by default (D15).
