/**
 * Getting started TU-3 (docs/tutorial/TUTORIAL_SPEC.md §12.1 (1)): every
 * place the app can take you, and what the tour says about it. Each
 * destination is in some step's `covers`, or planned for a chapter that has
 * no steps yet (TU-7), or in `NOT_A_TOUR_STEP` with a reason — the pattern
 * of `NOT_A_FIELD` (settingsFields.ts). `src/test/tutorialCoverage.test.tsx`
 * holds it, so a new mode, sidebar row, Library page, Settings page or card
 * section cannot ship without its line here or its step.
 *
 * Pure data, no React, no DOM.
 */
import type { CenterMode } from "../../store/uiStore.ts";
import { LIBRARY_PAGES, type LibraryPage } from "../librarySkills.ts";
import { ALL_ENTRIES } from "../settingsNav.ts";
import { CARD_PAGE_PARTS } from "../cardLifecycle.ts";
import { NAV_DESTINATIONS } from "../sidebarNav.ts";
import type { BoardPage, ChapterId, CoverageKey, LibrarySection } from "./manifest.ts";

/** Every centre mode. The type below fails to compile when the union in
 *  uiStore.ts gains a mode this list does not have. */
export const CENTER_MODES = [
  "terminals",
  "board",
  "code",
  "inbox",
  "activity",
  "library",
] as const satisfies readonly CenterMode[];
type MissingMode = Exclude<CenterMode, (typeof CENTER_MODES)[number]>;
const everyModeListed: [MissingMode] extends [never] ? true : MissingMode = true;
void everyModeListed;

/** The same for the Library's pages: `LIBRARY_PAGES` is what its page column
 *  and compact row draw, so a page added to the union and not to the list
 *  fails to compile here, and one added to both is a destination below. */
type MissingLibraryPage = Exclude<LibraryPage, (typeof LIBRARY_PAGES)[number]>;
const everyLibraryPageListed: [MissingLibraryPage] extends [never] ? true : MissingLibraryPage = true;
void everyLibraryPageListed;

/** 1.173.0 (D2): the Board ⋯'s pages — How this goes live. */
export const BOARD_PAGES = ["go-live"] as const satisfies readonly BoardPage[];
type MissingBoardPage = Exclude<BoardPage, (typeof BOARD_PAGES)[number]>;
const everyBoardPageListed: [MissingBoardPage] extends [never] ? true : MissingBoardPage = true;
void everyBoardPageListed;

/** 1.174.0 (X3): Library › Skills' own sections that are a place — My library. */
export const LIBRARY_SECTIONS = ["my-library"] as const satisfies readonly LibrarySection[];
type MissingLibrarySection = Exclude<LibrarySection, (typeof LIBRARY_SECTIONS)[number]>;
const everyLibrarySectionListed: [MissingLibrarySection] extends [never] ? true : MissingLibrarySection = true;
void everyLibrarySectionListed;

/** The destinations, as `covers` names them, in the order §5 maps them. */
export function tourDestinations(): CoverageKey[] {
  const keys: CoverageKey[] = [
    ...CENTER_MODES.map((m) => `mode:${m}` as const),
    ...NAV_DESTINATIONS.map((d) => d.covers),
    ...LIBRARY_PAGES.map((p) => `library:${p}` as const),
    ...LIBRARY_SECTIONS.map((p) => `library-section:${p}` as const),
    ...ALL_ENTRIES.map((e) => `settings:${e.id}` as const),
    ...CARD_PAGE_PARTS.map((p) => `card:${p}` as const),
    ...BOARD_PAGES.map((p) => `board:${p}` as const),
  ];
  return [...new Set(keys)];
}

/**
 * Explained by an optional chapter that has no steps yet (§6.6). The test
 * fails once that chapter has steps and the destination is still here: the
 * chapter's step lists it in `covers` instead. Empty since TU-7 wrote every
 * optional chapter; a later chapter (or a new destination it will explain)
 * may use it while its steps are being written.
 */
export const PLANNED_IN_CHAPTER: Partial<Record<CoverageKey, ChapterId>> = {};

/** Never a step of its own, and why (§12.1 (1)). */
export const NOT_A_TOUR_STEP: Partial<Record<CoverageKey, string>> = {
  "card:diff":
    "The changes opens from the Review's See the changes (and from Now's on a card with changes requested); B9 brings the person to the Review, and reading a diff line by line is not a step of learning the loop.",
  "settings:appearance": "A Settings page: G2 shows Settings and where Setup lives, not each page.",
  "settings:claude-codex":
    "A Settings page (AI and models): G2 shows Settings, and G3 (a second AI) goes through Setup's AI step, not this page.",
  "settings:notifications": "A Settings page: G2 shows Settings and where Setup lives, not each page.",
  "settings:dictation": "A Settings page: G2 shows Settings and where Setup lives, not each page.",
  "settings:general": "A Settings page: G2 shows Settings and where Setup lives, not each page.",
  "settings:build-release":
    "A Settings page (Building and checking): G2 shows Settings and where Setup lives, not each page.",
  "settings:shipping":
    "1.174.0: a Settings page that gathers a card's path after the build (where cards go, How Ship it ships, fixing checks, what runs after a release, card branches, the releases) — a first card ships with the defaults, which the ship step's own words explain; the guide's Settings › Cards › Shipping covers it.",
  "settings:areas":
    "A Settings page reached from the area picker's Edit areas… and the Board's two-products notice, which settings.area-picker explains; a repository with one product never needs it.",
  "settings:board-worktrees":
    "A Settings page (Cards' copies): G2 shows Settings and where Setup lives, not each page.",
  "settings:plan":
    "The plan page is where the team plan is bought; the tour never has a sales step.",
  "settings:profile-licence": "The Plyloft account page: nothing to learn for a first card.",
  "board:go-live":
    "1.173.0: How this goes live, from the Board's ⋯ — read only, and empty on most projects (no Railway, no GitHub checks); the Ship step's When it merges shows the same facts where they matter, and the guide's How a change goes live explains both.",
  "library-section:my-library":
    "1.174.0: My library in a project's Library › Skills is read-only and empty for most people; it only shows what All skills manages, and the all-skills.my-library step already explains My library where it is made and changed.",
  "settings:diagnostics":
    "For support: Copy tutorial report lives here (TU-8, §13) and the guide says so, and 1.176.0 R6's Repair of Claude Code and Codex opens from its Repair group; a mending page, not part of learning the loop, so no step needs it.",
};
