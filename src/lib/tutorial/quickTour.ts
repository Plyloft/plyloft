/**
 * Getting started TU-6 (docs/tutorial/TUTORIAL_SPEC.md §6.4, §6.5): the
 * Quick tour and the first-visit tips. Pure — no React, no store, no DOM —
 * so node runs its tests (`src/lib/tutorialQuick.test.ts`).
 *
 * - The Quick tour (D7, the "I use them regularly" level): explain-only
 *   coach-marks with Next, no waiting on actions. Board → a card's page (an
 *   existing card if there is one, else the Board's New card) → Terminals →
 *   Code → Library → (team: the team's library) → Inbox → All skills → Ship
 *   in a batch → Help. Nine marks, ten in a team; about a minute.
 * - A first-visit tip (D6, D15): the first time a section opens, while no
 *   tour is under way and *Tips when I open a section* is on, one coach-mark
 *   with Got it. Each section's tip shows once (`seenSections`).
 *
 * Copy is in Mac words and goes through `machineWords` where it is drawn.
 */
import type { CenterMode } from "../../store/uiStore.ts";
import type { SetupLevel, TutorialProgress } from "../settingsShape.ts";
import type { TourAnchor, TourNav } from "./manifest.ts";

// ── The Quick tour (§6.4) ────────────────────────────────────────────────

export type QuickMarkId =
  | "board"
  | "card"
  | "terminals"
  | "code"
  | "library"
  | "team"
  | "inbox"
  | "all-skills"
  | "ship-batch"
  | "help";

/** Where a mark's control is: one of the tour's own helpers (§4.2), or an
 *  existing card's page. */
export type QuickNav = TourNav | { openCard: { workspaceId: string; cardId: string } };

export interface QuickMark {
  id: QuickMarkId;
  anchor: TourAnchor;
  /** Brought on screen when the mark shows; none for a sidebar row that is
   *  always there. */
  navigate?: QuickNav;
  title: string;
  body: string;
}

/** The last mark's Next. */
export const QUICK_DONE_LABEL = "Done";
/** Every mark but the last: leave the Quick tour. */
export const QUICK_CLOSE_LABEL = "Close";
/** The Quick tour's last line (§6.4). */
export const QUICK_LAST_BODY = "The full tour is in Help › Getting started.";
/** 1.171.0 E3 (owner D5): with fewer than two cards ready the row
 *  isn't there, and the docked mark says why. */
export const QUICK_FEW_READY_LINE = "It isn't there now: it shows when two or more cards are ready to ship.";

const COPY: Record<QuickMarkId, { title: string; body: string }> = {
  board: {
    title: "The Board",
    body: "Each card is one result you want. You write it, the Builder makes it in its own copy of your project, the Reviewer, a second AI, checks it, and you ship it.",
  },
  card: {
    title: "A card's page",
    body: "The steps run from Start build to Finish and check, the result and Ship it. The box at the top says what comes next, and this button does it.",
  },
  terminals: {
    title: "Terminals",
    body: "Sessions of your own, outside any card: a shell, Claude, Codex or a chat. A card's sessions are listed under Terminals in the sidebar.",
  },
  code: {
    title: "Code",
    body: "Your project's own files, to read or change yourself. More for Code has the preview of your app.",
  },
  library: {
    title: "The Library",
    body: "Skills, instructions and knowledge the AIs use in this project: from the repository, your team, this Mac and Plyloft.",
  },
  team: {
    title: "Your team",
    body: "The skills your team shares are in the Library too, and they keep themselves up to date. Members and the team's workspaces are in Settings.",
  },
  inbox: {
    title: "Inbox",
    body: "Everything waiting for you: cards that need you, scripts waiting for your OK, and things that were refused.",
  },
  "all-skills": {
    title: "All skills",
    body: "Every skill of every project in one place, with where each copy came from and which ones have an update.",
  },
  "ship-batch": {
    title: "Release a version",
    // 1.171.0 E3 (owner D5): two or more cards. 1.173.0 (F2): Release N….
    // 1.174.0 (DR6): a release takes what is on main too.
    body: "When two or more cards are ready, Release N cards… shows in the sidebar, above Settings: one version with everything on main and the cards you tick.",
  },
  help: {
    title: "Help",
    body: `Shortcuts, the user guide and this tour again. ${QUICK_LAST_BODY}`,
  },
};

/** The card a card's-page mark opens: the newest card the Board shows. */
export interface QuickCard {
  workspaceId: string;
  cardId: string;
}

/**
 * The marks, in order, for this Mac now. `card`: an existing card to open
 * (else the mark is the Board's New card). `team`: team mode (solo users
 * never see team marks, D7; unknown mode shows them, OB-9).
 */
export function quickMarks(ctx: {
  card: QuickCard | null;
  team: boolean;
  /** The cards Ship batch would take now (unknown: nothing said). */
  shipReady?: number | null;
}): QuickMark[] {
  const mark = (id: QuickMarkId, anchor: TourAnchor, navigate?: QuickNav): QuickMark => ({
    id,
    anchor,
    ...(navigate ? { navigate } : {}),
    ...COPY[id],
  });
  const marks: QuickMark[] = [
    mark("board", "nav-board", { mode: "board" }),
    ctx.card
      ? mark("card", "card-primary", { openCard: ctx.card })
      : {
          ...mark("card", "board-new-card", { mode: "board" }),
          title: "New card",
          body: "A card starts here: a short title for what you want, then a few sentences on its page about the result.",
        },
    mark("terminals", "terminals-new", { mode: "terminals" }),
    mark("code", "code-more", { mode: "code" }),
    mark("library", "library-tabs", { mode: "library" }),
  ];
  if (ctx.team) marks.push(mark("team", "library-tabs", { mode: "library" }));
  marks.push(mark("inbox", "nav-inbox"), mark("all-skills", "nav-all-skills"));
  const batch = mark("ship-batch", "ship-batch");
  const batchLine = ctx.shipReady != null && ctx.shipReady < 2 ? QUICK_FEW_READY_LINE : null;
  marks.push(batchLine ? { ...batch, body: `${batch.body} ${batchLine}` } : batch, mark("help", "help"));
  return marks;
}

// ── First-visit tips (§6.5) ──────────────────────────────────────────────

/** The sections that have a first-visit tip, as `seenSections` keeps them.
 *  The Board and a card's page are the full tour's own (its base chapter). */
export type TipSection = "terminals" | "code" | "library" | "inbox" | "history" | "all-skills";

export const TIP_SECTIONS: readonly TipSection[] = ["terminals", "code", "library", "inbox", "history", "all-skills"];

export interface SectionTip {
  section: TipSection;
  anchor: TourAnchor;
  title: string;
  body: string;
}

/** Got it: the tip goes, and it does not come back for that section. */
export const TIP_GOT_IT_LABEL = "Got it";

/**
 * A section's tip: the Quick tour's words for it, so there is one text per
 * section. TU-7 (§6.6) gives each section's chapter its steps; the tip then
 * adds *Show me the rest*, which opens that chapter in the panel.
 */
export function sectionTip(section: TipSection): SectionTip {
  switch (section) {
    case "terminals":
      return { section, anchor: "terminals-new", ...COPY.terminals };
    case "code":
      return { section, anchor: "code-more", ...COPY.code };
    case "library":
      return { section, anchor: "library-tabs", ...COPY.library };
    case "inbox":
      return { section, anchor: "nav-inbox", ...COPY.inbox };
    case "history":
      return { section, anchor: "nav-history", title: "History", body: "Cards you've shipped, with what changed." };
    case "all-skills":
      return { section, anchor: "nav-all-skills", ...COPY["all-skills"] };
  }
}

const SECTION_OF_MODE: Partial<Record<CenterMode, TipSection>> = {
  terminals: "terminals",
  code: "code",
  library: "library",
  inbox: "inbox",
  activity: "history",
};

/** The section on screen: All skills over everything, else the mode's. */
export function sectionOnScreen(mode: CenterMode | null, allSkillsOpen: boolean): TipSection | null {
  if (allSkillsOpen) return "all-skills";
  return mode ? (SECTION_OF_MODE[mode] ?? null) : null;
}

/** *Tips when I open a section*: the switch, else the level's default — on
 *  for step by step, off for just the essentials (D15) and when the level
 *  was never asked. */
export function tipsOn(record: TutorialProgress | null | undefined, level: SetupLevel | null | undefined): boolean {
  if (typeof record?.tips === "boolean") return record.tips;
  return level === "guided";
}

export function tipSeen(record: TutorialProgress | null | undefined, section: TipSection): boolean {
  return Array.isArray(record?.seenSections) && record.seenSections.includes(section);
}

/** The switch flipped (Help › Tips when I open a section). Spread, never
 *  rebuilt (TU-1). */
export function withTips(r: TutorialProgress | null | undefined, on: boolean): TutorialProgress {
  return { ...(r ?? {}), tips: on };
}

/** The tip of `section` was shown: it does not show again. Sections this
 *  build does not know stay. */
export function withSectionSeen(r: TutorialProgress | null | undefined, section: TipSection): TutorialProgress {
  const cur = r ?? {};
  const seen = Array.isArray(cur.seenSections) ? cur.seenSections : [];
  if (seen.includes(section)) return cur;
  return { ...cur, seenSections: [...seen, section] };
}
