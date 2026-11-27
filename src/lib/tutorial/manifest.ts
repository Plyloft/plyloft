/**
 * Getting started (docs/tutorial/TUTORIAL_SPEC.md §4, §6): the one manifest.
 * Pure data and the types it is made of — no React, no store, no IPC — so
 * node runs its tests (`src/lib/tutorialEngine.test.ts`).
 *
 * Copy is written once, in Mac words (*this Mac*, `⌘`), and goes through
 * `machineWords` / `formatKeys` (`lib/platform.ts`) where it is drawn, as the
 * rest of the app does. `{ai}` stands for the tour card's Builder (`Claude`
 * or `Codex`, `stepCopy`), as `firstCardGuide.ts` names it.
 *
 * Step ids are stable forever: a newer app's ids survive in the record
 * (TU-1), and an id removed here is simply ignored. `since` is the version
 * that added a step or last changed its meaning (not a typo fix).
 */
import type { CenterMode } from "../../store/uiStore.ts";
import type { LibraryPage } from "../librarySkills.ts";
import type { CardPagePart, CardPrimaryActionId, CardStep } from "../cardLifecycle.ts";
import type { EntryId } from "../settingsNav.ts";
import type { AgentVendor } from "../roleModels.ts";
import type { TutorialSnapshot } from "./tutorialEngine.ts";

// ── Types (§4.1) ─────────────────────────────────────────────────────────

/** §6.1's chapters. `new` is generated (TU-8); the others are written here. */
export type ChapterId =
  | "base"
  | "inbox-history"
  | "talk"
  | "terminals"
  | "code"
  | "library"
  | "all-skills"
  | "ship-batch"
  | "team"
  | "settings-search";

/**
 * §4.3: a `data-ply-tour="…"` id, rendered on exactly one visible element.
 * The list is the contract TU-3's render test checks
 * (`src/test/tutorialCoverage.test.tsx`).
 *
 * "Visible" (TU-3): every warmed workspace keeps its hosts mounted and hides
 * the inactive ones (AGENTS.md), so an anchor inside a per-workspace host —
 * Terminals' New, Code's More, the card page's — is in the DOM once per
 * warmed host. Exactly one of them is on screen; `findTourAnchor`
 * (`tourAnchors.ts`) is the one way to look an anchor up, and it skips the
 * hidden hosts. Inside one host, and everywhere outside them (the sidebar),
 * the attribute is on one element only.
 */
export const TOUR_ANCHORS = [
  "nav-board",
  "nav-code",
  "nav-terminals",
  "nav-library",
  "nav-inbox",
  "nav-history",
  "nav-all-skills",
  "nav-search",
  "ship-batch",
  "help",
  "board-new-card",
  "card-brief",
  "card-primary",
  "card-tab-chat",
  "card-plan-two-ais",
  "card-review",
  "card-try-it",
  "card-more",
  "terminals-new",
  // 1.173.0 A3: New › In a new copy… (the menu item).
  "terminals-new-copy",
  // 1.173.0 B2: the area picker under the workspace's name (2+ areas).
  "sidebar-area",
  // 1.173.0 E3: the Next improvement section above the Board.
  "board-next-improvement",
  "terminals-card-sessions",
  "code-more",
  "library-tabs",
  "settings",
] as const;

export type TourAnchor = (typeof TOUR_ANCHORS)[number];

/**
 * Anchors whose control is not built yet, with the card that builds it. The
 * coverage test lets them be missing, and fails once one renders while still
 * listed here, so the card that builds it moves it out.
 */
export const PENDING_ANCHORS: Partial<Record<TourAnchor, string>> = {
  // Empty since TU-4 built the Help menu (§3.3), the last one listed.
};

/**
 * §4.2: where a step's control is, as one of the existing helpers. Closed,
 * so the tour can never mount or unmount a view on its own (AGENTS.md: hosts
 * are hidden, never unmounted). Executed by `store/tutorialStore.ts::tourNavigate`:
 * - `{ mode }` → `openCenterMode(tourWorkspace, mode)`;
 * - `{ libraryPage }` → `openLibraryPage`;
 * - `{ card: "tour-card", step? }` → `selectCard` / `openCardStep`;
 * - `{ allSkills: true }` → `setAllSkillsOpen(true)`;
 * - `{ settings }` → `openSettingsSection`;
 * - `{ setup: "ai" }` → `useSetup.getState().openSetup("rerun", "ai")`;
 * - `{ workspace: "tour" }` → `useWorkspaces.getState().setActive`.
 *
 * TU-7: an optional chapter's step follows the active workspace
 * (`followsActive`), so its mode and Library page open there.
 */
export type TourNav =
  | { mode: CenterMode }
  | { libraryPage: LibraryPage }
  | { card: "tour-card"; step?: CardStep }
  /** TU-7: the card open in the active workspace, else the tour card, else
   *  the Board (where the person opens one): `selectCard` / `openCenterMode`.
   *  `unbuilt` (1.172.0 walk, E1): the step's control is only on a card not
   *  built yet — a shipped or built card open here is passed over for one
   *  that is (the tour card, else the Board's first). */
  | { card: "any"; unbuilt?: true }
  | { allSkills: true }
  | { settings: EntryId }
  /** TU-7 (G3, D17): Setup's AI step, `openSetup("rerun", "ai")`. */
  | { setup: "ai" }
  | { workspace: "tour" };

/** §7: whether a step is done, from the snapshot alone. */
export type DonePredicate = (snapshot: TutorialSnapshot) => boolean;

/**
 * §12.1: a destination a step explains — a centre mode, a sidebar entry, a
 * Library page, a Settings page, a card-page section, a page the Board's ⋯
 * opens (1.173.0). The lists it is checked against are in `coverage.ts`.
 */
export type CoverageKey =
  | `mode:${CenterMode}`
  | `nav:${string}`
  | `library:${LibraryPage}`
  | `settings:${EntryId}`
  | `card:${CardPagePart}`
  | `board:${BoardPage}`
  | `library-section:${LibrarySection}`;

/** 1.174.0 (X3): a section of Library › Skills that is a place of its own —
 *  My library, read-only, opening All skills (`coverage.ts` lists them). */
export type LibrarySection = "my-library";

/** 1.173.0 (D2): the pages the Board's ⋯ opens as a destination of their
 *  own (`coverage.ts` lists them). */
export type BoardPage = "go-live";

/**
 * How a step moves on:
 * - `action`: the app changes (`done`), never a press of the tour's;
 * - `explain`: only the panel's own button (Start / Next) marks it;
 * - `interrupt`: shown while the state holds, never recorded (B5b);
 * - `checklist`: the panel's own list, no coach-marks (B11).
 */
/** `question` (1.175.0 F4): a question the panel asks once, under "That's
 *  the loop" — never the step the tour points at, never counted, never a
 *  row; done when its answer is recorded (`done`). */
export type StepKind = "action" | "explain" | "interrupt" | "checklist" | "question";

export interface StepCopy {
  title: string;
  body: string;
  why?: string;
  /** TU-5: lines drawn under the body, in order (B3's starter titles, B5's
   *  note under the button). Mac words, `{ai}` filled. */
  notes?: string[];
  /** TU-5: B3's starter titles in a new, empty project (D25). */
  examples?: readonly string[];
  /** TU-7: the body on a machine with one AI ready (ONBOARDING_SPEC §13.4). */
  oneAi?: string;
}

export interface TutorialStep {
  /** Stable forever: "base.new-card". */
  id: string;
  chapter: ChapterId;
  /** The app version that added it or last changed its meaning. */
  since: string;
  /** Who sees it. TU-7: `ai: "one"` — only while exactly one AI is ready
   *  (G3, D17: shown only while one AI is missing). */
  audience?: {
    level?: "guided" | "fast";
    mode?: "solo" | "team";
    plan?: "team";
    ai?: "one";
    /** 1.173.0 (B2): only where the active workspace has two areas or more
     *  (the area picker shows). */
    areas?: true;
  };
  /** The control it points at; none for panel-only steps. */
  anchor?: TourAnchor;
  /** Which existing helper brings `anchor` on screen. */
  navigate?: TourNav;
  done: DonePredicate;
  /** Shows the subscription sentence before the action (D8). */
  startsAi?: boolean;
  /** Plain English, Mac words, `{ai}` for the Builder. */
  copy: StepCopy;
  covers?: CoverageKey[];
  kind: StepKind;
  /** §6.2: counted in "4 of 10" (B1–B10). */
  counted: boolean;
  /** §7: watches the tour card only (B4–B10, B5b). */
  cardBound?: boolean;
  /** §6.2: offered while the build runs, never the step the tour waits on
   *  (B6, B7): the tour moves past it to the next one, and it stays "to do". */
  aside?: boolean;
  /** Done by being somewhere (a mode), not by making something (B2, B6,
   *  B7). Out of order it counts only when it becomes true while the tour
   *  runs — never the place the tour (re)started in (`observeTour`). */
  visit?: boolean;
}

/** The next release: the version the base chapter ships in. */
export const TUTORIAL_SINCE = "1.167.0";

// ── The base chapter (§6.2) ──────────────────────────────────────────────

export const STEP = {
  howItWorks: "base.how-it-works",
  openBoard: "base.open-board",
  newCard: "base.new-card",
  brief: "base.brief",
  startBuild: "base.start-build",
  aiAsks: "base.ai-asks",
  watchTerminals: "base.watch-terminals",
  whatCodeIs: "base.what-code-is",
  finishCheck: "base.finish-check",
  tryIt: "base.try-it",
  ship: "base.ship",
  permissions: "base.permissions",
  secondCard: "base.second-card",
} as const;

/** B4: the brief is long enough to build from (saved, trimmed). */
export const BRIEF_MIN_CHARS = 40;

/**
 * How far the tour card has come, from its stage (`firstCardGuide.ts`'s
 * table): 0 nothing started, 1 building, 2 checked (or the Challenger asked
 * for changes), 3 ready to ship, 4 landed. A stopped card keeps no rank of
 * its own (null): it neither does nor undoes a step.
 */
const rank = (s: TutorialSnapshot): number | null => s.tourCard?.rank ?? null;
const inTour = (s: TutorialSnapshot, mode: CenterMode): boolean =>
  s.tourWorkspaceId != null && s.activeWorkspaceId === s.tourWorkspaceId && s.mode === mode;
const started = (s: TutorialSnapshot): boolean => s.tourCard?.started === true;

export const BASE_STEPS: readonly TutorialStep[] = [
  {
    id: STEP.howItWorks,
    chapter: "base",
    since: TUTORIAL_SINCE,
    kind: "explain",
    counted: true,
    done: () => false,
    copy: {
      title: "How Plyloft works",
      body:
        "You describe a result as a card. An AI, the Builder, makes it in its own copy of your project, so your files stay as they are. A second AI, the Reviewer, checks the work. You read the result and ship it.",
      why:
        "Board or Terminals? Use a card on the Board when you want something built and checked. Use a session in Terminals when you just want to talk to {ai} or try a command.",
    },
  },
  {
    id: STEP.openBoard,
    chapter: "base",
    since: TUTORIAL_SINCE,
    kind: "action",
    counted: true,
    anchor: "nav-board",
    navigate: { mode: "board" },
    covers: ["mode:board"],
    visit: true,
    done: (s) => inTour(s, "board"),
    copy: { title: "Open the Board", body: "The Board holds your cards, from the idea to shipped." },
  },
  {
    id: STEP.newCard,
    chapter: "base",
    since: TUTORIAL_SINCE,
    kind: "action",
    counted: true,
    anchor: "board-new-card",
    navigate: { mode: "board" },
    done: (s) => s.tourCard != null,
    copy: {
      title: "Write your idea as a card",
      body: "Give it a short title: what you want to have when it's done, like \"Add a contact form\".",
    },
  },
  {
    id: STEP.brief,
    chapter: "base",
    // 1.172.0 (C1): What you want is right under Now on a card not built
    // yet, in the card's Brief.
    since: "1.172.0",
    kind: "action",
    counted: true,
    cardBound: true,
    anchor: "card-brief",
    navigate: { card: "tour-card", step: "intake" },
    done: (s) => (s.tourCard?.briefLength ?? 0) >= BRIEF_MIN_CHARS,
    copy: {
      title: "Say what you want",
      body:
        "Write it as if to a person: the result, how you'll know it works, and anything that must not change. Plain words are fine.",
      why:
        "A good card is one result you could check in a few minutes. Bigger ideas: make several cards, or choose Plan it first beside Start build (chapter \"Talk before you build\").",
    },
  },
  {
    id: STEP.startBuild,
    chapter: "base",
    // 1.171.0 (D1): its note names the card's Permissions choice.
    // 1.175.0 F9 (owner I1): the note names it for each AI.
    since: "1.175.0",
    kind: "action",
    counted: true,
    cardBound: true,
    startsAi: true,
    anchor: "card-primary",
    navigate: { card: "tour-card" },
    done: (s) => (rank(s) ?? 0) >= 1 || started(s),
    copy: {
      title: "Start the build",
      body:
        "This starts {ai} with your own subscription, in its own copy of your project. Nothing changes in your files on this Mac until you ship it.",
    },
  },
  {
    id: STEP.aiAsks,
    chapter: "base",
    // 1.171.0 C2 (CF8): the session words ("Asks you something").
    since: "1.171.0",
    kind: "interrupt",
    counted: false,
    cardBound: true,
    anchor: "card-primary",
    navigate: { card: "tour-card" },
    covers: ["card:run"],
    // Never recorded: it is shown while the card's session holds it.
    done: (s) => s.tourCard?.asks == null,
    copy: {
      title: "When {ai} asks you something",
      body: "{ai} asks you something. Press Open the Builder, read its question and answer there.",
    },
  },
  {
    id: STEP.watchTerminals,
    chapter: "base",
    since: TUTORIAL_SINCE,
    kind: "action",
    counted: true,
    cardBound: true,
    aside: true,
    anchor: "nav-terminals",
    navigate: { mode: "terminals" },
    covers: ["mode:terminals"],
    visit: true,
    done: (s) => started(s) && inTour(s, "terminals"),
    copy: {
      title: "Watch it work (optional)",
      body:
        "Your card's session is here, under Terminals. You can read along or answer if it asks something. You don't have to watch.",
    },
  },
  {
    id: STEP.whatCodeIs,
    chapter: "base",
    since: TUTORIAL_SINCE,
    kind: "action",
    counted: true,
    cardBound: true,
    aside: true,
    anchor: "nav-code",
    navigate: { mode: "code" },
    covers: ["mode:code"],
    visit: true,
    done: (s) => started(s) && inTour(s, "code"),
    copy: {
      title: "What Code is for",
      body:
        "Code shows your project's files, so you can read or change one yourself. The Builder works in its own copy: its changes show here after you ship.",
    },
  },
  {
    id: STEP.finishCheck,
    chapter: "base",
    // 1.171.0 C2 (CF3, owner D10): the wait after the press is explained.
    // 1.175.0 F9: its guide text names the wait's new words.
    since: "1.175.0",
    kind: "action",
    counted: true,
    cardBound: true,
    anchor: "card-primary",
    navigate: { card: "tour-card" },
    covers: ["card:outcome"],
    done: (s) => (rank(s) ?? 0) >= 2,
    copy: {
      title: "When it's finished, check it",
      body:
        "When {ai} says it's done, press Finish and check. {ai} re-reads its own work, then Plyloft saves it, runs your project's checks and the Reviewer reviews it. The card says what is happening and for how long; you can leave it.",
    },
  },
  {
    id: STEP.tryIt,
    chapter: "base",
    // 1.172.0 (C2; CP-3): on a card Ready to ship Try it is the Review's;
    // Take me there opens it.
    since: "1.172.0",
    kind: "action",
    counted: true,
    cardBound: true,
    anchor: "card-try-it",
    navigate: { card: "tour-card", step: "outcome" },
    // TU-5 Mac walk: a plain website's Open index.html shows it too.
    done: (s) => s.tourCard?.tryRunning === true || s.tourCard?.tryOpened === true,
    copy: {
      title: "See it running",
      body: "See it running: press Try it in the card's Review. Plyloft starts your app in the card's copy and shows it here.",
      why:
        "The first time, Plyloft asks how your app starts and suggests the command it found. Nothing in your project changes. If it says Couldn't start, the last lines your app printed are under Details: tell the Builder what went wrong.",
    },
  },
  {
    id: STEP.ship,
    chapter: "base",
    // 1.171.0 A3: its copy while Ship it's way isn't known, and its done
    // line where Plyloft merges. 1.174.0 E11 (G12): its why says what the
    // coverage of board:go-live cites, When it merges above Ship it.
    since: "1.174.0",
    kind: "action",
    counted: true,
    cardBound: true,
    anchor: "card-primary",
    navigate: { card: "tour-card", step: "ship" },
    covers: ["card:ship"],
    done: (s) => s.tourCard?.landed === true || s.tourCard?.prOpen === true,
    copy: {
      title: "Ship it",
      body: "Ship it puts the change into your project on this Mac.",
      why: "Above Ship it, When it merges says what changes online, when Plyloft can read where your project is hosted.",
    },
  },
  {
    // 1.175.0 F4 (UX-4, owner I1): after the first card, how the Builder
    // works on the next ones. The panel's own question (`tourPanel`), no
    // anchor and no destination; answered once, or closed.
    id: STEP.permissions,
    chapter: "base",
    since: "1.175.0",
    kind: "question",
    counted: false,
    done: (s) => s.builderPermissionsAsked,
    copy: {
      title: "How should {ai} work on your next cards?",
      body: "You can change it in Settings › Cards › AI and models, and on any card before Start build.",
    },
  },
  {
    id: STEP.secondCard,
    chapter: "base",
    since: TUTORIAL_SINCE,
    kind: "checklist",
    counted: false,
    done: (s) => s.secondCardLanded,
    copy: {
      title: "Try one more card on your own",
      body: "This time without the tour's pointers: the list ticks itself as your card moves.",
    },
  },
];

// ── The base chapter's other words (§6.2, §6.3, §11) ─────────────────────

/** B10, when the workspace ships as a pull request. */
export const SHIP_PR_BODY = "Ship it opens a pull request on GitHub and merges it when the checks pass.";
/** B10 done with a pull request still open (§11), that doesn't merge by itself. */
export const SHIP_PR_OPEN_LINE = "Merge it on GitHub when you're ready.";
/** G1 Challenger (10): B10 done with a pull request that merges by itself.
 *  1.171.0 A3: neutral — GitHub's auto-merge or Plyloft's own. */
export const SHIP_PR_AUTO_MERGE_LINE = "It merges when the checks pass.";
/** 1.171.0 A3: the merge is Plyloft's own (`PrStatus.plyloftAutoMerge`): it
 *  happens only while Plyloft is open. */
export const SHIP_PR_PLYLOFT_MERGE_LINE = "Plyloft merges it when the checks pass — keep Plyloft open.";
/** 1.171.0 A3: B10 while the card page hasn't said yet where Ship it goes
 *  (`shipsAs: null`) — true either way. */
export const SHIP_UNKNOWN_BODY =
  "Ship it puts the change into your project: on GitHub when the project is there, otherwise on this Mac.";
/** After B10, with the optional chapters listed below it (TU-7). */
export const LOOP_DONE_COPY: StepCopy = {
  title: "That's the loop",
  body: "Describe, build, check, ship. Pick a chapter below, or come back to it from Help.",
};
/** 1.175.0 F4: "That's the loop" while the permissions question is open
 *  under it — the whole sentence comes back after the answer. */
export const LOOP_DONE_SHORT_BODY = "Describe, build, check, ship.";
/** F4: the question's words, per AI (`tourPanel::permissionsQuestion`). */
export const PERMISSIONS_QUESTION = {
  claude: {
    lede: "On this first card Claude changed files in the card's copy without asking. New cards start with Claude's own permission setting.",
    keep: "Plyloft adds nothing: Claude follows its own permission setting on this Mac. Unless you changed it, Claude asks before each change.",
    use: "Claude changes files only in the card's copy, as it did here. Commands may still ask. Your project changes only when you press Ship it.",
  },
  codex: {
    lede: "On this first card Codex changed files in the card's copy without asking. New cards start by asking first.",
    keep: "Codex stops for your OK before it changes a file or runs a command that changes anything.",
    use: "Codex changes files only in the card's copy, as it did here. Using the internet, or files outside the copy, still asks.",
  },
  now: "New cards do this now",
  keepLabel: "Keep this",
  useLabel: "Use this",
} as const;
/** F4: the line after the answer. */
export const PERMISSIONS_ANSWERED = (label: string) =>
  `New cards: ${label}. Change it in Settings › Cards › AI and models › How the Builder asks you.`;
/** After B10 while the base chapter is the only one: no chapter below to
 *  pick (TU-4 Mac walk). */
export const LOOP_DONE_ALONE_BODY = "Describe, build, check, ship. Help › Getting started brings the tour back.";
/** B5, under the button. 1.171.0 (D1): the card's Permissions choice
 *  replaced the "Build without asking" toggle. 1.175.0 F9 (owner I1): one
 *  name per AI for the default — with Claude, Plyloft adds nothing to
 *  Claude's own setting. Codex: `START_BUILD_NOTE_CODEX`. */
export const START_BUILD_NOTE =
  "The line under What you want says how Claude works. With Uses Claude's own setting, Claude follows its own permission setting on this Mac: unless you changed it, it asks in its session before it changes anything.";
export const START_BUILD_NOTE_CODEX =
  "The line under What you want says how Codex works. With Asks before every change, it asks in its session before it changes anything.";
/** QoL 7.4 (D10): B5 on the tour's own card, which starts bounded (its page
 *  says how in one sentence, and its Permissions shows Edits its copy
 *  without asking): leave it as it is. */
// 1.175.0 F10: before the first build the line under What you want says
// how the Builder works (no facts line yet), and the tour's card leaves it.
export const TOUR_BOUNDED_NOTE = "The line under What you want says how {ai} works: leave it as it is.";
/** B6 and B7, while the build runs. */
export const WHILE_BUILDING_LINE = "While {ai} works: two things worth seeing";
/** B3's panel link (the guided first card, §2). */
export const SAFE_EXAMPLE_LINK = "No idea yet? Use a safe example";
/** B3 in a new, empty project (D25): the coach-mark's body, with the starter
 *  titles listed under it instead of the contact-form example. */
export const STARTER_BODY = "Give it a short title: what you want to have when it's done. For example:";
/** B3 in a new, empty project (D25). */
export const STARTER_TITLES = [
  "Create a one-page website for …",
  "Make a to-do list app",
  "Add a README that says what this project is for",
] as const;
/** B3 when the guided README card already exists (old user, §11). */
export const CONTINUE_GUIDED_LINK = "Continue with \"{title}\"";
/** The same, before its title is known (its project's board not read yet). */
export const CONTINUE_GUIDED_GENERIC = "Continue with your guided first card";
/** B11's checklist, in order. */
export const SECOND_CARD_CHECKLIST = [
  "Title",
  "What you want",
  "Start build",
  "Finish and check",
  "Try it",
  "Ship it",
] as const;
export type ChecklistItem = (typeof SECOND_CARD_CHECKLIST)[number];
/** B11: the one-line hint behind each row's Hint (D24). */
export const SECOND_CARD_HINTS: Record<ChecklistItem, string> = {
  Title: "On the Board, press New card and write what you want to have when it's done.",
  "What you want": "Open the card and write the result, how you'll know it works, and what must not change.",
  "Start build": "Press Start build on the card. {ai} works in its own copy of your project.",
  "Finish and check": "When {ai} says it's done, press Finish and check on the card.",
  "Try it": "Press Try it on the card to see your app running from the card's copy.",
  "Ship it": "Read the result and press Ship it.",
};
/** B11, offered after B10 (D24). */
export const SECOND_CARD_OFFER = "Try one more card on your own.";
/** B11 done: the tour goes quiet (§3.4). */
export const SECOND_CARD_DONE = "Two cards shipped. The tour is done; Help › Getting started brings it back.";

/** B5b's words, by what holds the session (§6.2, D22). */
export type AskKind = "trust" | "waiting" | "usageLimit" | "bypass";
export const ASK_COPY: Record<AskKind, string> = {
  trust:
    // 1.171.0 D2 (PLAN §10): once for this project, not once per card.
    "{ai} asks whether you trust this folder, once for this project. It's your project's copy for this card: answer Yes in the session to let it work.",
  waiting:
    "{ai} asks you something. Press Open the Builder, read its question and answer there. \"Yes\" lets it go on; you can say no and tell it what to do instead.",
  usageLimit:
    "Your {ai} plan reached its limit for now. The session says when it resets; then type \"continue\" there. Nothing is lost.",
  bypass: "{ai} shows a warning before working without asking. Read it and choose in the session.",
};
/** B5b's title, by kind (the mockups' NeedsYou board). */
export const ASK_TITLE: Record<AskKind, string> = {
  trust: "{ai} asks whether you trust this folder",
  waiting: "{ai} asks you something",
  usageLimit: "Your plan needs a short break",
  bypass: "{ai} asks before working without asking",
};
/** B5b's last line (existing rule: Plyloft never answers for the user). */
export const ASK_NEVER_ANSWERS = "Plyloft never answers for you.";

/** D8: a step that starts an AI says first that it uses the member's own
 *  subscription. B5's body says so itself; a later `startsAi` step whose
 *  body does not gets this line first (`stepCopy`). */
export const SUBSCRIPTION_LINE = "This uses your own {ai} subscription.";

/** §3.1, §11: the panel's live line while the tour card's Builder works. */
export const LIVE_COPY = {
  /** "Claude is working · 3 min" (1.171.0 C2: the session word). */
  building: "{ai} is working",
  /** TU-5 Mac re-walk: Finish and check pressed, the Builder's self-check —
   *  the card's own words (1.175.0 F9: *Claude is re-reading its work*). */
  selfCheck: "{ai} is re-reading its work",
  /** …then the save and the checks' hand-off: Finish and check's own busy
   *  words (`cardLifecycle.ts::FINISH_BUSY_LABEL`). */
  saving: "Saving and checking…",
  /** §11: the usage limit, when its reset is known. */
  /** 1.171.0 C2 (CF8): the fifth session word, as the card says it. */
  pausedUntil: "Paused · your plan's limit resets at {time}",
  paused: "Paused · your plan's limit resets soon",
  /** The card waits for a free slot (`queued`, *In line*). */
  queued: "In line: it starts when a slot is free",
} as const;

/** §2: Setup's Ready, "I'm new to this" (D6). */
export const TOUR_OFFER_LABEL = "Start the tour";
export const TOUR_RESUME_LABEL = "Resume the tour";
/** 1.176.3: says what the tour is, by the name Help gives it (Getting
 *  started), and where it is picked up again. */
export function tourOfferSentence(project: string | null): string {
  return `The Getting started tour points at the real buttons while you build your first card in ${project?.trim() || "your project"}. It never presses anything for you. Stop whenever you like; Help › Getting started picks it up again.`;
}
/** Ready's other way out while the tour leads. */
export function tourNotNowLabel(project: string | null): string {
  return project?.trim() ? `Not now, open ${project.trim()}` : "Not now, go to Plyloft";
}
/** §2: Ready, "I use them regularly" (D7): the Quick tour's link (TU-6). */
export const QUICK_TOUR_LINK = "Take a 1-minute tour";
/** TU-6: the sentence under it. */
export const QUICK_TOUR_SENTENCE = "A quick look at each part of Plyloft, one pointer at a time. Nothing is pressed for you.";
/** TU-6: where it is later (Challenger: not Getting started, the full tour). */
export const QUICK_TOUR_LATER = "Later: Help (?) at the bottom of the sidebar › Take a 1-minute tour.";

/** §9, §11: the steps that need Setup send the user there. */
export const FINISH_SETUP_LABEL = "Finish setup";

/**
 * What the panel says while the tour waits on something that is not the
 * step's own action (§7, §9, §11). Plain sentences; `{ai}`, `{title}` and
 * `{workspace}` are filled where drawn.
 */
export type WaitReason =
  | "no-workspace"
  | "card-gone"
  | "other-workspace"
  | "ai-not-ready"
  | "changes-requested"
  | "changes-requested-press"
  | "stopped"
  | "no-card"
  | "brief-first"
  | "build-not-started"
  | "still-building"
  | "checking"
  | "queued"
  | "try-not-yet"
  | "not-checked";
export const WAIT_COPY: Record<WaitReason, string> = {
  "no-workspace": "Add your project first",
  "card-gone": "That card is gone. Start another one.",
  "other-workspace": "This step is in {workspace}",
  "ai-not-ready": "{ai} isn't ready yet",
  "changes-requested":
    "The Reviewer asked for changes and the Builder has them. When it's done, Plyloft checks the fixes by itself.",
  // 1.175.0 F5 round 2: a card set to "Waits for me" — the line before 1.175.
  "changes-requested-press":
    "The Reviewer asked for changes and the Builder has them. When it's done, press Finish and check again.",
  stopped: "Something stopped. The box on the card says what and what to do; the tour waits.",
  // TU-4 Mac walk: a card step made current before the card is where it
  // needs to be (a step skipped, or Do it now on a later one). The panel says
  // what comes first; the coach-mark waits, never pointing at a button that
  // says something else.
  "no-card": "Write your idea as a card first",
  "brief-first": "Finish planning first, then start the build",
  "build-not-started": "Start the build first",
  "still-building": "{ai} is still working. When it says it's finished, Finish and check shows on the card",
  // TU-5 Mac re-walk: Finish and check was pressed and its self-check or
  // save runs — no second press asked for.
  checking: "Finish and check is under way. Then Plyloft runs your checks and the Reviewer reviews the work",
  // TU-4 walk: a card in line (*In line*, primary See the queue) is not
  // being worked on yet.
  queued: "Your card is in line: {ai} starts on it when a slot is free. Finish and check comes after that",
  "try-not-yet": "Try it shows on the card once it has changes to try",
  "not-checked": "Ship it shows once the work is built and checked",
};

/**
 * The card page's primary (`card-primary`) changes its words with the card's
 * state: the steps that point at it point only while it is the action they
 * ask for (TU-4 Mac walk: B8 must never point at Start build).
 */
export const CARD_PRIMARY_FOR: Readonly<Record<string, readonly CardPrimaryActionId[]>> = {
  [STEP.startBuild]: ["start-build", "start-work"],
  [STEP.aiAsks]: ["inspect-run"],
  [STEP.finishCheck]: ["finish-and-check"],
  [STEP.ship]: ["ship"],
};

/** §6.3: the fallback when Try it can't start the app. */
export const TRY_FALLBACK = {
  beforeShip:
    "Open ⋯ on the card and choose \"Open a terminal in the card's copy\". Start your app there the way you usually do. Then open More for Code › Show your running app, choose Web page and type the address it prints.",
  /** Behind Details. */
  beforeShipDetails: "For many web projects the command is npm run dev, and it prints the address with its port.",
  afterShip:
    "Your change is in your project. Start your app the way you usually do; More for Code › Show your running app finds it on the common ports.",
  /** TU-5 Mac walk: a plain website — nothing to start, the page opens. */
  staticBeforeShip:
    "This is a plain website: press Try it on the card and choose Open index.html. It opens in your browser; nothing is started.",
  staticAfterShip: "Your change is in your project. Open its index.html in your browser to see it.",
  /** G1 Challenger (10): Try it in <project> with the tour card's pull
   *  request still open — the change isn't in the project here yet. */
  afterPrShip:
    "Your change reaches your project once GitHub has merged it and your project is up to date. Then start your app the way you usually do; More for Code › Show your running app finds it on the common ports.",
} as const;

// ── The optional chapters (§6.6, TU-7) ───────────────────────────────────
// Each follows the active workspace (`followsActive`): a chapter is about
// a part of the app, wherever the person is, not about the tour card. A
// step that asks for a place (`visit`) counts there; a step with nothing to
// do is `explain`, done by Next (§7). All of them count in their chapter's
// "1 of 3".

/** The release the optional chapters ship in; the Skills hub's sections
 *  (H8–H10: Copy to…, Where it's on and Personalize…, My library) with them. */
export const CHAPTERS_SINCE = "1.167.0";

export const OPT = {
  inbox: "inbox.open",
  inboxEveryProject: "inbox.every-project",
  history: "inbox.history",
  chat: "talk.chat",
  planTwoAis: "talk.plan-two-ais",
  whichTalk: "talk.which",
  nextImprovement: "talk.next-improvement",
  terminalsNew: "terminals.new",
  terminalsLayouts: "terminals.layouts",
  terminalsNewCopy: "terminals.new-copy",
  commandBlocks: "terminals.command-blocks",
  codeFiles: "code.files",
  codePreview: "code.preview",
  codeTryProject: "code.try-project",
  librarySkills: "library.skills",
  libraryInstall: "library.install",
  libraryInstructions: "library.instructions",
  allSkills: "all-skills.open",
  copyTo: "all-skills.copy-to",
  plyloftSkills: "all-skills.plyloft",
  myLibrary: "all-skills.my-library",
  shipBatch: "ship-batch.row",
  shipBatchWhat: "ship-batch.what",
  teamLibrary: "team.library",
  teamWorkspaces: "team.workspaces",
  teamInvite: "team.invite",
  search: "settings.search",
  settings: "settings.open",
  secondAi: "settings.second-ai",
  areaPicker: "settings.area-picker",
} as const;

/** The active workspace shows `mode` (not All skills over it). */
const here = (s: TutorialSnapshot, mode: CenterMode): boolean =>
  s.activeWorkspaceId != null && s.mode === mode && !s.overlays.allSkills;
/** The sessions a person opens from New (not a card's Builder). */
const SESSION_KINDS = ["shell", "claude", "codex", "codex-chat"] as const;
const sessionsHere = (s: TutorialSnapshot): number =>
  SESSION_KINDS.reduce((n, kind) => n + (s.here.tiles[kind] ?? 0), 0);

/** An optional chapter's step: counted in its chapter, since TU-7's release. */
function opt(step: Omit<TutorialStep, "since" | "counted"> & { since?: string }): TutorialStep {
  return { since: CHAPTERS_SINCE, counted: true, ...step };
}

/** Explain-only: done by Next, never by the app's state (§7). */
const byNext: DonePredicate = () => false;

export const INBOX_HISTORY_STEPS: readonly TutorialStep[] = [
  opt({
    id: OPT.inbox,
    chapter: "inbox-history",
    kind: "action",
    visit: true,
    anchor: "nav-inbox",
    navigate: { mode: "inbox" },
    covers: ["mode:inbox"],
    done: (s) => here(s, "inbox"),
    // 1.173.0 (F1): Needs you reads as the Board; News is cleared apart.
    // 1.174.0 (TX8, T48): "scripts waiting for your OK".
    since: "1.174.0",
    copy: {
      title: "Open the Inbox",
      body:
        "Everything waiting for you is here. Needs you shows each card as the Board does, with its state and its one press; scripts waiting for your OK and things that were refused are there too. News sits below, and Clear the news clears it on its own.",
    },
  }),
  opt({
    id: OPT.inboxEveryProject,
    chapter: "inbox-history",
    kind: "explain",
    anchor: "nav-inbox",
    navigate: { mode: "inbox" },
    done: byNext,
    // 1.173.0 (F1): one count everywhere.
    since: "1.173.0",
    copy: {
      title: "One Inbox for every project",
      body:
        "Each row names its project, so nothing waits unseen in a project you're not looking at. The number beside Inbox counts what needs you, the same number as Needs you here and, for its cards, on the Board.",
      why:
        "The project switcher at the top of the sidebar splits that number by project, and each project's Board shows its own cards.",
    },
  }),
  opt({
    id: OPT.history,
    chapter: "inbox-history",
    // Terminals block P5: History › Sessions; QoL 11.1: History's tabs.
    since: "1.168.0",
    kind: "action",
    visit: true,
    anchor: "nav-history",
    navigate: { mode: "activity" },
    covers: ["mode:activity"],
    done: (s) => here(s, "activity"),
    copy: {
      title: "Open History",
      body:
        "What ran, shipped and was checked in every workspace, in tabs: Runs (with the Builder's rounds), Ships, Checks, Sessions and Discussions, with a Workspace and a text filter. Sessions lists the Claude and Codex sessions you opened in Terminals, with Resume to pick one up again.",
    },
  }),
];

export const TALK_STEPS: readonly TutorialStep[] = [
  opt({
    id: OPT.chat,
    chapter: "talk",
    kind: "action",
    // 1.171.0 (E1): the button is Ask about this card, and the Builder
    // never sees what is said there. 1.175.0 F10: it names Send to the
    // Builder.
    since: "1.175.0",
    anchor: "card-tab-chat",
    navigate: { card: "any" },
    covers: ["card:chat"],
    done: (s) => s.here.openCard?.section === "chat",
    copy: {
      title: "Talk about a card",
      body:
        "Open a card and press Ask about this card. Talk about the card with {ai}, and attach a screenshot, a PDF or a Word file. It only talks: it changes nothing, and the Builder doesn't see it. To change the work, press Send to the Builder.",
    },
  }),
  opt({
    id: OPT.planTwoAis,
    chapter: "talk",
    kind: "explain",
    // 1.172.0 (C1): it is in Plan it first, beside Start build.
    since: "1.172.0",
    startsAi: true,
    anchor: "card-plan-two-ais",
    navigate: { card: "any", unbuilt: true },
    covers: ["card:plan"],
    done: byNext,
    copy: {
      title: "Plan with two AIs",
      body:
        "On a card that isn't built yet, Plan it first beside Start build has Plan with two AIs: one AI writes a plan and the other questions it, before the build. Good for bigger ideas.",
      oneAi:
        "On a card that isn't built yet, Plan it first beside Start build has Plan with two AIs: {ai} writes a plan in one session and questions it in another, before the build. Both views come from {ai}, in two separate sessions with different roles.",
      why: "You decide at the end: take the plan into the card, ask for another round, or stop.",
    },
  }),
  opt({
    id: OPT.whichTalk,
    chapter: "talk",
    // 1.171.0 (E1): Chat is Ask about this card. 1.172.0 (C1): planning is
    // in Plan it first.
    since: "1.172.0",
    kind: "explain",
    covers: ["card:intake"],
    done: byNext,
    copy: {
      title: "Ask, plan or build?",
      body:
        "Ask about this card to ask about it or show a picture. Plan it first, then Plan it with {ai}, to work out together what the card should say; Plan with two AIs when the idea is big or unclear. Start build when you know what you want.",
    },
  }),
  // 1.173.0 (E3): Next improvement, above the Board — ideas the AI found.
  // 1.174.0 (A6, D2c): it shows by itself after the first shipped card;
  // before that, Take me there opens it (TutorialLayer).
  opt({
    id: OPT.nextImprovement,
    chapter: "talk",
    since: "1.174.0",
    kind: "explain",
    anchor: "board-next-improvement",
    navigate: { mode: "board" },
    done: byNext,
    copy: {
      title: "Next improvement: ideas, one at a time",
      body:
        "Above the Board, Next improvement asks {ai} for the changes worth making, often one, sometimes none, each with what it saw. A second opinion sets aside ideas that only add. Each idea is one row with Make it a card; Change it… and Don't propose this… are under its Details. Nothing changes until a card is built and shipped.",
      why: "Write the direction first: who it is for and what better means here. A round takes a few minutes and uses your own plan, like a card does; it starts only when you press.",
    },
  }),
];

export const TERMINALS_STEPS: readonly TutorialStep[] = [
  opt({
    id: OPT.terminalsNew,
    chapter: "terminals",
    // Terminals block P4: New › Resume…. 1.174.0 E6: New's new order.
    since: "1.174.0",
    kind: "action",
    startsAi: true,
    anchor: "terminals-new",
    navigate: { mode: "terminals" },
    done: (s) => here(s, "terminals") && sessionsHere(s) > 0,
    copy: {
      title: "Open a session",
      body:
        "New opens a session with Claude, Codex, a shell for your own commands or Codex chat, in your project's own folder. The AI ones use your own subscription. New › Resume… picks up an earlier Claude or Codex conversation of the project in a new session.",
      why: "A session here is just you and the AI or the shell: nothing is built or checked. For work you want checked and shipped, make a card on the Board.",
    },
  }),
  opt({
    id: OPT.terminalsLayouts,
    chapter: "terminals",
    kind: "explain",
    anchor: "terminals-new",
    navigate: { mode: "terminals" },
    done: byNext,
    copy: {
      title: "Arrange your sessions",
      body:
        "Once a session is open, More for Terminals (the ⋯ beside New) › Layout sets how they share the page: Auto, Single tile, Split (1×2), Quad (2×2) or Six (2×3). New › Several sessions at once… opens a set of them together.",
    },
  }),
  opt({
    id: OPT.terminalsNewCopy,
    chapter: "terminals",
    // 1.173.0 A3: a terminal in its own copy, and Terminals › Copies. The
    // item is in New's menu, so the coach-mark points at New (as Layouts'
    // Several sessions at once… does); the item carries terminals-new-copy.
    since: "1.178.0",
    kind: "explain",
    anchor: "terminals-new",
    navigate: { mode: "terminals" },
    done: byNext,
    copy: {
      title: "Work in a copy",
      body:
        "New › In a new copy… opens a session in its own copy of the project, started from your main branch on GitHub, so it doesn't touch your project folder or the other sessions. Terminals › Copies lists them: Make it a card to have it checked and shipped, Open a pull request, or Throw away.",
      why: "A copy isn't a card: nobody reviews it until you make it one.",
    },
  }),
  opt({
    id: OPT.commandBlocks,
    chapter: "terminals",
    kind: "explain",
    navigate: { settings: "editor-terminals" },
    covers: ["settings:editor-terminals"],
    done: byNext,
    copy: {
      title: "Command blocks (optional)",
      body: "Plyloft can show a shell's output one command at a time. It's off until you turn it on.",
      why:
        "Settings › Look and feel › Editor and terminals › Command blocks › Mark where each command starts and ends. It's experimental, and it needs a short snippet in your shell's own profile, which Plyloft shows once it's on.",
    },
  }),
];

export const CODE_STEPS: readonly TutorialStep[] = [
  opt({
    id: OPT.codeFiles,
    chapter: "code",
    kind: "action",
    anchor: "nav-code",
    navigate: { mode: "code" },
    done: (s) => s.palette === "files",
    // 1.174.0 E10 (T12): "Go to file" everywhere.
    since: "1.174.0",
    copy: {
      title: "Go to file",
      body:
        "Code shows your project's own files. Press ⌘P, or Go to file… in More for Code, and type part of a file's name to open it.",
    },
  }),
  opt({
    id: OPT.codePreview,
    chapter: "code",
    kind: "action",
    visit: true,
    anchor: "code-more",
    navigate: { mode: "code" },
    done: (s) => here(s, "code") && s.here.previewOpen,
    // 1.174.0 E10 (T13): Show your running app.
    since: "1.174.0",
    copy: {
      title: "See your app in Code",
      body:
        "More for Code › Show your running app shows a page your app serves on this Mac. A running Try it is listed first.",
    },
  }),
  opt({
    id: OPT.codeTryProject,
    chapter: "code",
    kind: "action",
    navigate: { mode: "code" },
    // TU-5 Challenger: the same sheet as B9 — a plain website's Open
    // index.html is the project seen, too.
    done: (s) => s.here.projectTryRunning || s.here.projectTryOpened,
    copy: {
      title: "Try it in your project",
      body:
        "Your change is in your project once it ships. Try it in {project}, on the Ship receipt or the Shipped toast, starts your app in the project's own folder and shows it here, in Code's preview.",
      why: "Nothing to try yet? Skip this step: it waits for your next ship.",
    },
  }),
];

/** TU-7 Mac walk (K3): a plain website has nothing to start, and Try it in
 *  <project> is offered only for a project with a start command, so K3 is
 *  explain-only there (done by Next) and says how to see it. */
export const TRY_PROJECT_STATIC_BODY =
  "Your change is in your project once it ships. {project} is a plain website, so there is nothing to start. Open its index.html in your browser to see it.";

/** K3 as it is shown here: on a plain website (`here.projectStaticSite`),
 *  explain-only with the plain website's words. Same id, so its record and
 *  its place in the chapter are the same. */
export function stepAsShown(step: TutorialStep, s: { here: { projectStaticSite: boolean } }): TutorialStep {
  if (step.id !== OPT.codeTryProject || !s.here.projectStaticSite) return step;
  return { ...step, kind: "explain", done: byNext, copy: { title: step.copy.title, body: TRY_PROJECT_STATIC_BODY } };
}

export const LIBRARY_STEPS: readonly TutorialStep[] = [
  opt({
    id: OPT.librarySkills,
    chapter: "library",
    kind: "action",
    visit: true,
    anchor: "nav-library",
    navigate: { libraryPage: "skills" },
    covers: ["mode:library", "library:skills"],
    done: (s) => here(s, "library") && s.here.libraryPage === "skills",
    copy: {
      title: "Skills",
      body:
        "Skills are written know-how the AI follows for a kind of task. They come from this repository, this Mac and Plyloft, and from your team's library when you work with a team.",
    },
  }),
  opt({
    id: OPT.libraryInstall,
    chapter: "library",
    kind: "explain",
    navigate: { libraryPage: "skills" },
    done: byNext,
    copy: {
      title: "Install, Update, Link",
      body:
        "Install puts a skill into this repository through a card you ship. Update brings a newer version the same way. Link connects a copy made before, so it can be kept up to date.",
    },
  }),
  opt({
    id: OPT.libraryInstructions,
    chapter: "library",
    kind: "action",
    visit: true,
    anchor: "library-tabs",
    navigate: { libraryPage: "instructions" },
    covers: ["library:instructions"],
    done: (s) => here(s, "library") && s.here.libraryPage === "instructions",
    copy: {
      title: "Instructions",
      body:
        "Open Instructions: what every session in this project reads first, such as how the project works and the rules to follow. You can read and change them here.",
    },
  }),
];

export const ALL_SKILLS_STEPS: readonly TutorialStep[] = [
  opt({
    id: OPT.allSkills,
    chapter: "all-skills",
    kind: "action",
    visit: true,
    anchor: "nav-all-skills",
    navigate: { allSkills: true },
    covers: ["nav:all-skills"],
    done: (s) => s.overlays.allSkills,
    copy: {
      title: "Open All skills",
      body:
        "Every skill this Mac can see, in one list: each project's, your team's, My library, this Mac's and Plyloft's, with where each one is used.",
    },
  }),
  opt({
    id: OPT.copyTo,
    chapter: "all-skills",
    kind: "explain",
    navigate: { allSkills: true },
    done: byNext,
    // 1.174.0 E11 (P42, G11): the button is Add to other projects… now.
    since: "1.174.0",
    copy: {
      title: "Add to other projects…",
      body:
        "Add to other projects… puts a copy of a skill into each project you pick. Each copy arrives as a card you ship and remembers where it came from, so it can say Update available later.",
    },
  }),
  opt({
    id: OPT.plyloftSkills,
    chapter: "all-skills",
    kind: "explain",
    navigate: { allSkills: true },
    done: byNext,
    copy: {
      title: "Plyloft's own skills",
      body:
        "Open a skill under Comes with Plyloft, then Open in the Library. Its page there shows its version, Where it's on, where you switch it off for a project or this Mac, and Personalize…, which makes your own version in a repository, through a card.",
    },
  }),
  opt({
    id: OPT.myLibrary,
    chapter: "all-skills",
    kind: "explain",
    navigate: { allSkills: true },
    done: byNext,
    copy: {
      title: "My library",
      body:
        "My library keeps your own skills in a private repository on your GitHub account, and brings them to every computer where you choose Use it on this Mac. Create it at the top of All skills.",
    },
  }),
];

export const SHIP_BATCH_STEPS: readonly TutorialStep[] = [
  opt({
    id: OPT.shipBatch,
    chapter: "ship-batch",
    // 1.171.0 E3 (owner D5): the row shows for two or more cards.
    // 1.173.0 (F2): it reads Release N…, and How this goes live releases too.
    // 1.174.0 (DR6, D1(b)): a release takes what is on main too; the row
    // and every Release… open the one Release sheet. 1.174.1 P3: on All
    // areas, when two have something to release, it asks which one.
    since: "1.178.0",
    kind: "explain",
    anchor: "ship-batch",
    covers: ["nav:ship-batch"],
    done: byNext,
    copy: {
      title: "Release a version",
      body:
        "When two or more cards are ready, choose Release N cards… in the sidebar or Board header. Otherwise, choose Release… from the Board menu. The release includes changes on the area's target branch since its last release, plus the ready cards you select.",
    },
  }),
  opt({
    id: OPT.shipBatchWhat,
    chapter: "ship-batch",
    since: "1.178.0",
    kind: "explain",
    done: byNext,
    copy: {
      title: "What a release takes",
      body:
        "Everything on main since the area's last release — cards shipped with Ship it and other changes — and the ready cards you tick, as one version with its own tag.",
    },
  }),
];

const TEAM: TutorialStep["audience"] = { mode: "team" };

export const TEAM_STEPS: readonly TutorialStep[] = [
  opt({
    id: OPT.teamLibrary,
    chapter: "team",
    kind: "explain",
    audience: TEAM,
    navigate: { settings: "team-workspaces" },
    covers: ["settings:team-workspaces"],
    done: byNext,
    copy: {
      title: "Your team's skill library",
      body:
        "Your team shares one skill library. Every Claude and Codex session Plyloft starts for you gets its skills, and Plyloft keeps it up to date on its own. In the Library, Install puts a copy of one into a project's repository.",
      why: "Settings › Team › Members and library › Library.",
    },
  }),
  opt({
    id: OPT.teamWorkspaces,
    chapter: "team",
    kind: "explain",
    audience: TEAM,
    navigate: { settings: "team-workspaces" },
    done: byNext,
    copy: {
      title: "Team workspaces",
      body:
        "Team workspaces are the projects your team shares. Settings › Team › Members and library lists them under Team workspaces: one this Mac doesn't have yet has Clone and add on its row, one whose folder is already here but not added has Register, and one already in Plyloft says Open here.",
    },
  }),
  opt({
    id: OPT.teamInvite,
    chapter: "team",
    kind: "explain",
    audience: TEAM,
    navigate: { settings: "team-workspaces" },
    done: byNext,
    copy: {
      title: "Invite someone",
      body:
        "The team's owner invites a teammate under Members › Add somebody, on the same page. Each member needs a seat.",
    },
  }),
];

export const SETTINGS_SEARCH_STEPS: readonly TutorialStep[] = [
  opt({
    id: OPT.search,
    chapter: "settings-search",
    kind: "action",
    anchor: "nav-search",
    covers: ["nav:search"],
    done: (s) => s.palette != null,
    copy: {
      title: "Search everything",
      body: "Search (⌘K) finds commands, files, text in your files and past sessions.",
    },
  }),
  // 1.174.0 (DS1, D8 b): Settings is grouped by task.
  opt({
    id: OPT.settings,
    chapter: "settings-search",
    kind: "action",
    since: "1.174.0",
    visit: true,
    anchor: "settings",
    navigate: { settings: "setup" },
    covers: ["nav:settings", "settings:setup"],
    done: (s) => s.overlays.settings,
    copy: {
      title: "Settings, and where Setup lives",
      body:
        "Settings (⌘,) is grouped by what you want to do: look and feel, cards, the project, your team, and setup and account. Each section says where it's kept. Setup is under Setup and account: open it again to check your AI, GitHub or projects folder.",
    },
  }),
  opt({
    id: OPT.secondAi,
    chapter: "settings-search",
    kind: "action",
    audience: { ai: "one" },
    navigate: { setup: "ai" },
    done: (s) => s.ai.claude && s.ai.codex,
    copy: {
      title: "Add a second AI",
      body: "Plyloft works with one AI. With both Claude and Codex, one builds and the other reviews.",
      why: "Take me there opens Setup's AI step. Sign in with your own Claude or ChatGPT account there; nothing else changes.",
    },
  }),
  // 1.173.0 B2: the area picker shows only with two areas or more, so the
  // step does too (`audience.areas`): in a repository with one product (or
  // none set up) it is not in the chapter at all, and nothing points at a
  // row that isn't there.
  opt({
    id: OPT.areaPicker,
    chapter: "settings-search",
    // 1.174.0 (C10, D6): areas are kept on this Mac until the setup is shared.
    since: "1.174.0",
    kind: "explain",
    audience: { areas: true },
    anchor: "sidebar-area",
    navigate: { mode: "board" },
    done: byNext,
    copy: {
      title: "Areas: one repository, several products",
      body:
        "This repository holds more than one product, so each is an area. Area, under the project's name, picks which one you work on: the Board shows its cards, and new cards and new copies go to it. Each area says where its cards go.",
      why: "Make it this Mac's default to start there every time; each Mac keeps its own default. Edit areas… changes them for everyone who opens this repository, or only on this Mac until you share this project's setup.",
    },
  }),
];

// ── Chapters (§6.1) ──────────────────────────────────────────────────────

export interface Chapter {
  id: ChapterId;
  title: string;
  steps: readonly TutorialStep[];
}

/** The base chapter first; the optional ones in §6.1's order, listed under
 *  *More, when you're ready* (§3.1). */
export const CHAPTERS: readonly Chapter[] = [
  { id: "base", title: "Your first card", steps: BASE_STEPS },
  { id: "inbox-history", title: "Inbox and History", steps: INBOX_HISTORY_STEPS },
  { id: "talk", title: "Talk before you build", steps: TALK_STEPS },
  { id: "terminals", title: "Terminals in depth", steps: TERMINALS_STEPS },
  { id: "code", title: "Code and the preview", steps: CODE_STEPS },
  { id: "library", title: "Library: skills and instructions", steps: LIBRARY_STEPS },
  { id: "all-skills", title: "All skills", steps: ALL_SKILLS_STEPS },
  { id: "ship-batch", title: "Release a version", steps: SHIP_BATCH_STEPS },
  { id: "team", title: "Your team", steps: TEAM_STEPS },
  { id: "settings-search", title: "Settings and search", steps: SETTINGS_SEARCH_STEPS },
];

/** TU-7: a step of an optional chapter follows the active workspace — its
 *  mode, Library page and card open there, and it never says *This step is
 *  in …* (that is the tour card's, §9). */
export function followsActive(step: Pick<TutorialStep, "chapter">): boolean {
  return step.chapter !== "base";
}

/** §3.1: the heading over the optional chapters. */
export const MORE_CHAPTERS_HEADING = "More, when you're ready";
/** An optional chapter done or skipped to its end. */
export const CHAPTER_DONE_COPY: StepCopy = {
  title: "Chapter done",
  body: "Pick another chapter below, or come back to this one from Help.",
};
/** §6.6 G3: after B10, while only one AI is ready, the panel offers it once. */
export const SECOND_AI_OFFER = "Add a second AI";

/** Every step, in path order. */
export const ALL_STEPS: readonly TutorialStep[] = CHAPTERS.flatMap((c) => c.steps);

export function stepById(id: string): TutorialStep | undefined {
  return ALL_STEPS.find((s) => s.id === id);
}

const AI_NAME: Record<AgentVendor, string> = { claude: "Claude", codex: "Codex" };

/** Fill `{ai}` (and any other `{key}` given) in a line. Unknown keys stay. */
export function fillWords(text: string, words: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (all, key: string) => words[key] ?? all);
}

/**
 * A step's words for the tour card's Builder (§4.1). Still in Mac words:
 * the caller passes the result through `machineWords` / `formatKeys`. B10
 * says pull request when the workspace ships as one.
 */
export function stepCopy(
  step: TutorialStep,
  vendor: AgentVendor,
  opts: {
    /** null: not known yet (`SHIP_UNKNOWN_BODY`). */
    shipsAs?: "merge" | "pr" | null;
    /** B3 in a new, empty project: the starter titles (D25). */
    emptyProject?: boolean;
    /** B5 on the unedited guided first card: its page says how it asks
     *  (`guidedStartSentence`), so the toggle's note is left out. */
    guidedStart?: boolean;
    /** QoL 7.4 (D10): B5 on the tour's own bounded card: the short note. */
    tourBounded?: boolean;
    /** TU-7: only one AI is ready here (`copy.oneAi`, ONBOARDING_SPEC §13.4). */
    oneAi?: boolean;
    /** TU-7: the active workspace's name, for `{project}` (K3). */
    project?: string | null;
  } = {},
): StepCopy {
  const words = { ai: AI_NAME[vendor], project: opts.project || "your project" };
  let body =
    step.id !== STEP.ship
      ? step.copy.body
      : opts.shipsAs === "pr"
        ? SHIP_PR_BODY
        : opts.shipsAs === null
          ? SHIP_UNKNOWN_BODY
          : step.copy.body;
  if (opts.oneAi && step.copy.oneAi) body = step.copy.oneAi;
  if (step.id === STEP.newCard && opts.emptyProject) body = STARTER_BODY;
  // D8: an AI is never started before the step says it is the member's own
  // subscription.
  if (step.startsAi && !/subscription/i.test(body)) body = `${SUBSCRIPTION_LINE} ${body}`;
  const notes =
    step.id !== STEP.startBuild || opts.guidedStart
      ? []
      : [fillWords(opts.tourBounded ? TOUR_BOUNDED_NOTE : vendor === "codex" ? START_BUILD_NOTE_CODEX : START_BUILD_NOTE, words)];
  return {
    title: fillWords(step.copy.title, words),
    body: fillWords(body, words),
    ...(step.copy.why ? { why: fillWords(step.copy.why, words) } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    ...(step.id === STEP.newCard && opts.emptyProject ? { examples: STARTER_TITLES } : {}),
  };
}
