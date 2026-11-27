// Getting started TU-3 (docs/tutorial/TUTORIAL_SPEC.md §4.3, §12.1): the
// sidebar's nav, as one list. `WorkspaceSidebar` draws every `shell-nav-item`
// row from it (its words, its icon, its tour anchor), and the tutorial's
// coverage test reads it: a row added to the sidebar without an entry here
// has no anchor and fails the test, and an entry here that no tour step
// covers (or `NOT_A_TOUR_STEP` names) fails it too. Pure data, no React.
//
// Not listed, on purpose: the switcher and the other workspaces' rows (a
// workspace, not a destination), the live session rows under Terminals (a
// session; their list carries `terminals-card-sessions`), and the status rows
// (a fact, shown only while it holds).

import type { CenterMode } from "../store/uiStore.ts";
import type { IconName } from "../components/ux/Icon.tsx";
import type { CoverageKey, TourAnchor } from "./tutorial/manifest.ts";

export type NavDestinationId =
  | "search"
  | "inbox"
  | "history"
  | "all-skills"
  | "board"
  | "code"
  | "terminals"
  | "library"
  | "ship-batch"
  | "settings";

export interface NavDestination {
  id: NavDestinationId;
  /** Where the row sits (WorkspaceSidebar's top-to-bottom map). */
  section: "app" | "workspace" | "foot";
  /** The row's words; Ship batch draws its own count ("Release 2 cards…"). */
  label: string;
  icon: IconName;
  /** Its `data-ply-tour` (§4.3). */
  tour: TourAnchor;
  /** What a tour step lists in `covers` to explain it (§12.1). A mode row is
   *  its centre mode. */
  covers: CoverageKey;
  /** The centre mode it opens, for the workspace's rows. */
  mode?: CenterMode;
}

export const NAV_DESTINATIONS = [
  { id: "search", section: "app", label: "Search", icon: "search", tour: "nav-search", covers: "nav:search" },
  { id: "inbox", section: "app", label: "Inbox", icon: "inbox", tour: "nav-inbox", covers: "mode:inbox", mode: "inbox" },
  {
    id: "history",
    section: "app",
    label: "History",
    icon: "history",
    tour: "nav-history",
    covers: "mode:activity",
    mode: "activity",
  },
  {
    id: "all-skills",
    section: "app",
    label: "All skills",
    icon: "allSkills",
    tour: "nav-all-skills",
    covers: "nav:all-skills",
  },
  { id: "board", section: "workspace", label: "Board", icon: "board", tour: "nav-board", covers: "mode:board", mode: "board" },
  { id: "code", section: "workspace", label: "Code", icon: "code", tour: "nav-code", covers: "mode:code", mode: "code" },
  {
    id: "terminals",
    section: "workspace",
    label: "Terminals",
    icon: "terminals",
    tour: "nav-terminals",
    covers: "mode:terminals",
    mode: "terminals",
  },
  {
    id: "library",
    section: "workspace",
    label: "Library",
    icon: "library",
    tour: "nav-library",
    covers: "mode:library",
    mode: "library",
  },
  {
    id: "ship-batch",
    section: "foot",
    // 1.173.0 (F2): a batch is a release; the row says "Release N cards…".
    label: "Release several cards",
    icon: "shipBatch",
    tour: "ship-batch",
    covers: "nav:ship-batch",
  },
  { id: "settings", section: "foot", label: "Settings", icon: "settings", tour: "settings", covers: "nav:settings" },
] as const satisfies readonly NavDestination[];

export function navDestination(id: NavDestinationId): NavDestination {
  return NAV_DESTINATIONS.find((d) => d.id === id)!;
}
