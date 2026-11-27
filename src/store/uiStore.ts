import { create } from "zustand";
import { SET_UP_LABEL, SET_UP_PAGE, SET_UP_ROW } from "../lib/projectSetup";
import type { ToastAction } from "./toastStore";
import { useSettings } from "./settingsStore";
import { useLibrary } from "./libraryStore";
import { useWorkspaces } from "./workspaceStore";
import { libraryLinkTarget } from "../lib/settingsNav";
import type { LibraryPage, ScopeFilter } from "../lib/librarySkills";
import {
  SIDEBAR_OVERLAY_BELOW,
  sidebarLayoutOf,
  withSidebarLayout,
} from "../lib/sidebarLayout";
import { openOnOf, type SidebarLayout } from "../lib/settingsShape";
import { loopbackUrl } from "../lib/tryAddress";
import type { HistoryFilter, HistoryTab } from "../lib/historyView";

export type BrowserMode = "localhost" | "generic";
/** UX-3.6: what ⌘K searches — commands, file names, text in files, or the
 *  history of sessions (cards, runs, transcripts, snapshots, brainstorms). */
export type PaletteScope = "commands" | "files" | "text" | "history";

/** 1.174.0 (DR3): what the Release sheet is opened on. `areaId`: the area
 *  (null: the workspace's, without areas); absent, the sheet asks which area
 *  when two or more have something to release, else opens the one that
 *  has. `cardIds`: the ready cards to tick (absent: every ready card of the
 *  area). */
export interface ReleaseSheetAsk {
  workspaceId: string;
  areaId?: string | null;
  cardIds?: readonly string[];
}
/**
 * v1.67.0 (UX revamp step 3a): the center stage's mode. "terminals" is
 * today's tile grid (the default — the landing flip is step 4, behind a
 * per-user flag); board/code/inbox re-host existing surfaces in the
 * center. Per-workspace, session-only. The tile grid is ALWAYS mounted
 * and CSS-hidden when another mode is active — PTYs never die to a mode
 * switch (decision card #2).
 */
/** v1.80.0 (Part 2 P2-2): + "activity" — telemetry's disclosure home. Like
 *  inbox it renders global content; it becomes a true global view (not a
 *  per-ws mode) in P2-4 when the nav shell lands. */
/** GH #95 (ADR 0005): + "knowledge" — the pinned right panel is retired and
 *  Knowledge is a temporary sidebar entry under the modes until the Library
 *  replaces it. No ⌘⌥ digit of its own (⌘⌥1–5 are unchanged); ⌘⇧E opens it. */
/** GH #96 (ADR 0005, BOARDS.md §1 and §3): + "library" — the Library replaces
 *  the temporary Knowledge entry. `Instructions · Skills · Notes` across the
 *  four scopes, with ⌘⌥6 and the sidebar entry `Library`. `knowledge` is gone:
 *  every deep link that opened it — ⌘⇧E and the palette's entry — opens the
 *  Library's Notes page (`openLibraryPage`). */
/** QoL 11.3: a History item with no card to open. */
export type HistorySheetTarget =
  | { kind: "run"; workspaceId: string; runId: string }
  | { kind: "brainstorm"; workspaceId: string; swarmId: string };

export type CenterMode =
  | "terminals"
  | "board"
  | "code"
  | "inbox"
  | "activity"
  | "library";

/**
 * v1.71.0 (step 5b-1): the one way to land on a center mode from
 * anywhere — sets the mode AND makes the center Panel visible (it is
 * gated by `gridVisible`, which would otherwise leave the mode switch
 * invisible). Every retired-tab caller (board/editor/dashboard jumps)
 * routes through here.
 */
export function openCenterMode(wsId: string, mode: CenterMode): void {
  const s = useUi.getState();
  s.setCenterMode(wsId, mode);
  if (!s.gridVisible) s.setGridVisible(true);
}

/**
 * U12: a press that goes to a mode from the sidebar, the shortcut or the
 * palette. Pressed for the Board on a card page, it lands on the Board, as the
 * page's crumb does; `openCenterMode` alone would do nothing there, because
 * the card page is the Board's mode. The card stays selected from elsewhere,
 * so Code → Board comes back to the card.
 */
export function goToCenterMode(wsId: string, mode: CenterMode): void {
  const s = useUi.getState();
  if (mode === "board" && effectiveCenterMode(s.centerMode, wsId) === "board" && s.selectedCardId[wsId]) {
    s.selectCard(wsId, null);
  }
  openCenterMode(wsId, mode);
}

/**
 * GH #96: land on the Library, on one of its pages. The one way in from
 * outside — ⌘⇧E and the palette — so nothing has to know how the Library
 * stores where it is.
 *
 * UX-9.5 retired the Notes page. `notes` is still accepted — ⌘⇧E and the
 * palette's old entry name it — and opens the Library where it was, on the
 * page it last showed: the notes themselves stay on disk, untouched.
 *
 * `scope` lands on the Skills list filtered to one scope: Settings › Members
 * and library links to the team's skills with it (UX-9.5).
 *
 * All in the same tick: review 1 found the page behind an awaited dynamic
 * import, so ⌘⇧E flashed one page before another. `libraryStore` imports only
 * `lib/librarySkills`, which imports no store, so a static import here is
 * cycle-free.
 */
export function openLibraryPage(
  wsId: string,
  page: LibraryPage | "notes",
  scope?: ScopeFilter,
): void {
  // GH #152: the workspace first. Every Library page draws one repository's
  // library, and the host that draws it is the active workspace's, so landing on
  // a page of a workspace nobody is looking at showed nothing until the member
  // switched by hand.
  //
  // The answer is not read here (review 2): every caller passes a workspace it is
  // looking at or holds a live record of, and the one path that could carry a
  // deleted id — `openSettingsSection`'s Library redirect — filters it before
  // calling. So there is nothing to decide with it at this level.
  activateWorkspace(wsId);
  if (page !== "notes") useLibrary.getState().setPage(wsId, page);
  if (scope) useLibrary.getState().setScope(wsId, scope);
  openCenterMode(wsId, "library");
}

/**
 * Try it TI-3 (docs/try-it/TRY_IT_SPEC.md §3.2): Code, with the localhost
 * preview strip open on `address` (a Try session's found address,
 * `http://localhost:5173/`). False, and nothing changes, for an address off
 * loopback, an https one (Open in browser instead) or a workspace that is
 * gone. Same tick, like `openLibraryPage`: the
 * workspace first, then its preview target and strip, then the mode. The
 * editor is not touched — Code's host stays mounted (AGENTS.md).
 */
export function openCodePreview(wsId: string, address: string): boolean {
  // The preview loads this machine's loopback only, normalised; a workspace
  // that is gone has no Code to open.
  const url = previewableUrl(address);
  if (!url) return false;
  if (!activateWorkspace(wsId)) return false;
  setCodePreviewAddress(wsId, url);
  openCenterMode(wsId, "code");
  return true;
}

/** The address as the preview loads it: loopback, normalised, and not
 *  https — a dev server's certificate is self-signed, which the embedded
 *  preview cannot accept (the caller offers Open in browser). */
function previewableUrl(address: string): string | null {
  const url = loopbackUrl(address);
  return url && !url.startsWith("https:") ? url : null;
}

/**
 * Try it TI-5: `openCodePreview` without moving the person — the strip of
 * `wsId`'s Code set up on `address` (target, mode, open) for when they look
 * at it; the workspace and its mode stay as they are. False, and nothing
 * changes, for an address the preview can't load or a workspace that is gone.
 */
export function setCodePreviewAddress(wsId: string, address: string): boolean {
  const url = previewableUrl(address);
  if (!url) return false;
  if (!useWorkspaces.getState().workspaces.some((w) => w.id === wsId)) return false;
  const s = useUi.getState();
  s.setCodePreviewTarget(wsId, url);
  s.setBrowserMode(wsId, "localhost");
  s.setCodePreviewOpen(wsId, true);
  return true;
}

/** `Set up` on a start or a Ship refused because `wsId` was never set up
 *  (`lib/projectSetup.ts`): Build and release, on its Re-detect row. */
export function openProjectSetUp(wsId: string): void {
  useUi.getState().openSettingsSection(SET_UP_PAGE, { workspaceId: wsId, row: SET_UP_ROW });
}

/** The same, as a toast's action: it stays until dismissed. */
export function setUpAction(wsId: string): ToastAction {
  return { label: SET_UP_LABEL, onClick: () => openProjectSetUp(wsId) };
}

/** n16: `Change` on the toast after a start set `wsId` up on its own —
 *  where the branch it builds from is changed. 1.174.0 (DS2, scene 15): the
 *  link names the row as it was (Build and release › Integration branch),
 *  so it lands on Shipping's Cards go to and the page says the row moved
 *  (`MOVED_ROWS`). */
export const CHANGE_SET_UP_ROW = "Integration branch";
export function changeSetUpAction(wsId: string): ToastAction {
  return {
    label: "Change",
    onClick: () =>
      useUi.getState().openSettingsSection(SET_UP_PAGE, { workspaceId: wsId, row: CHANGE_SET_UP_ROW }),
  };
}

/**
 * GH #151: open a card on one of its lifecycle steps — the workspace first
 * (GH #152), then the card's lifecycle over the board, then the step. What an
 * error's `Show` does when its block lives on a card (the Ship step's refusal).
 *
 * A workspace that is gone opens nothing: the card is keyed to it, and
 * selecting it on whatever else is active would open no card at all.
 */
export function openCardStep(
  wsId: string,
  cardId: string,
  step: import("../lib/cardLifecycle").CardStep,
): void {
  if (!activateWorkspace(wsId)) return;
  const ui = useUi.getState();
  ui.selectCard(wsId, cardId, true);
  ui.setCardStep(cardId, step);
}

/**
 * Switch to a workspace the way the switcher does — also what a row of the
 * sidebar's stack of other workspaces does. A workspace nobody has chosen a
 * mode for this session opens where Settings says (`effectiveCenterMode`:
 * the Inbox by default); one left on a global view (Inbox, History) by an
 * earlier choice returns to its Board — choosing it is asking for its
 * content (UX-4.3).
 */
export function switchToWorkspace(wsId: string): void {
  // GH #152: a workspace that is gone (removed while its row was on screen)
  // is left alone, not put into `activeId`.
  if (!activateWorkspace(wsId)) return;
  const ui = useUi.getState();
  const chosen = ui.centerMode[wsId];
  if (chosen === "inbox" || chosen === "activity") ui.setCenterMode(wsId, "board");
}

/**
 * Make `wsId` the active workspace, unless it already is (GH #152).
 *
 * Nothing is awaited and nothing needs to be: `setActive` flips `activeId`
 * synchronously and fires `workspace_set_active` without awaiting it, so a
 * caller may go straight on to set that workspace's page in the same tick.
 * Warming a cold workspace rides the existing staged-mount path, exactly as the
 * Inbox row's own jump does (`inboxStore.open`).
 *
 * Already-active is left alone rather than re-set: a redundant `setActive` would
 * still write the backend's active-workspace record for no change.
 *
 * A workspace that is **gone** is left alone too (review 1): a toast can outlive
 * the workspace its refusal was raised for, and `setActive` would then put an id
 * nothing can render into `activeId` — and persist it — leaving the shell with no
 * active workspace at all. Nothing is activated, and the section still opens for
 * whatever is active, which is the pre-#152 behaviour rather than a broken shell.
 *
 * Returns whether `wsId` is a workspace that can be shown — true when it is now
 * active or already was, false when it is gone. Callers that go on to key
 * something to the id must read this (review 2): a caller that used the id anyway
 * would point the Library at a workspace with no host, and nothing would open.
 */
function activateWorkspace(wsId: string): boolean {
  const workspaces = useWorkspaces.getState();
  if (workspaces.activeId === wsId) return true;
  if (!workspaces.workspaces.some((w) => w.id === wsId)) return false;
  void workspaces.setActive(wsId);
  return true;
}

/**
 * The mode a workspace shows when its `centerMode` hasn't been touched this
 * session. UX-4.3 (C4): the "Open on" setting — the Inbox unless the person
 * chose Board or Terminals (Settings › Appearance › Window); at launch every
 * workspace is untouched, so Ply opens there. Reads the settings store
 * lazily so there's no import cycle and no subscription — a launch-surface
 * decision, not live-reactive state.
 *
 * With no workspace at all the stage shows "Open a project", which the
 * global Inbox would hide, so that case lands on the Board's empty state.
 */
export function effectiveCenterMode(
  modes: Record<string, CenterMode>,
  wsId: string | null,
): CenterMode {
  if (wsId && modes[wsId]) return modes[wsId];
  // Static import is cycle-safe: settingsStore has no uiStore import.
  const openOn = openOnOf(useSettings.getState().settings.behavior);
  if (!wsId && openOn === "inbox") return "board";
  return openOn;
}
/**
 * v1.7.0: "card" is a per-workspace card-detail surface for the kanban
 * intake conversation (and, in v2, post-swarm in_review). Clicking a card
 * in the Kanban tab activates this tab and sets `selectedCardId`.
 */
/** v1.23.0 (Cycle G3): trimmed from 11 → 8 tabs.
 *  - `browser` demoted to a preview inside Code mode.
 *  - `run` folded into the G1 toolbar flight deck.
 *  - `worktrees` folded into the Project tab as a sub-section.
 *
 *  See `src-tauri/src/workspace.rs::KNOWN_RIGHT_TABS` for the backend filter
 *  that strips pre-trim values from persisted `pinnedRightTabs`. */
/** v1.71.0 (UX revamp step 5b-1): `editor` / `kanban` / `dashboard` /
 *  `inbox` RETIRED — they folded into their center stage modes (Code /
 *  Board / Inbox·Code-preview / Inbox). Persisted `pinnedRightTabs`
 *  entries are dropped by the `KNOWN_RIGHT_TABS` sanitizer in
 *  `src-tauri/src/workspace.rs` on load. */
/** v1.76.0 (STEP6 D7): `card` RETIRED — the lifecycle owns the center
 *  stage (`.center-card-host` in NewWorkspaceShell, visible over the
 *  Board when a card is open). One mounted card host only: keeping the
 *  right-tab too would double-mount the intake xterm. */
/** GH #95 (ADR 0005): the right panel itself is RETIRED — nothing renders
 *  a right tab. The key survives only as the element type of the persisted
 *  `Workspace.pinnedRightTabs`, which old files still decode (sanitized in
 *  workspace.rs) and the shell ignores. */
/** v1.81.0 (Part 2 P2-3, Q1): the right panel is kept and anchored by
 *  Knowledge — swarm/agents/project retired (PART2.md Q1 table: SwarmTab
 *  split → brainstorm-start on the Board, templates+agent CRUD in
 *  Settings, run history in Activity; the project tab's contents were
 *  re-homed across Part 1/2 — project config still ships via the gate's
 *  own flows). Persisted pins sanitize via workspace.rs KNOWN_RIGHT_TABS. */
export type RightTabKey = "knowledge";

/** v1.23.0 (Cycle G3): no FE migration needed for the per-workspace
 *  `rightTab` map — it is session-only (zustand store without persist
 *  middleware), so a new session starts with `{}` and falls back to
 *  "editor" on every read. The PERSISTED migration concern is
 *  `Workspace.pinnedRightTabs`, which lives in `workspaces.json` and
 *  is sanitized by `KNOWN_RIGHT_TABS` filtering in
 *  `src-tauri/src/workspace.rs` on load. */

interface UiStore {
  /**
   * Skills hub H7 (R4): All skills is open — the first app-level centre
   * page. Drawn over the per-workspace hosts, which stay mounted (hidden by
   * visibility); choosing any mode or workspace closes it. Session-only.
   */
  allSkillsOpen: boolean;
  setAllSkillsOpen: (open: boolean) => void;
  browserMode: Record<string, BrowserMode>;
  /** Try it TI-3: per workspace, Code's localhost preview strip is open.
   *  Session-only, like `centerMode` (this store does not persist). */
  codePreviewOpen: Record<string, true>;
  setCodePreviewOpen: (wsId: string, open: boolean) => void;
  /** Try it TI-3: per workspace, the address the strip boots on (a Try
   *  session's found address), set by `openCodePreview`. Session-only. The
   *  nonce changes on every set, so asking again for the same address boots
   *  the strip on it again, wherever the person had moved it. */
  codePreviewTarget: Record<string, CodePreviewTarget>;
  setCodePreviewTarget: (wsId: string, address: string | null) => void;
  // v0.5.0 — new shell state (workspace-scoped where it makes sense)
  leftPanelOpen: boolean;
  gridVisible: boolean;
  /**
   * v1.7.0: per-workspace selected card id. v1.76.0 (STEP6 D6): this IS
   * the "card open in the center" state — non-null shows the lifecycle
   * over the Board (decision card #09: open-card state is session state
   * that survives mode flips and workspace switches); null closes it.
   */
  selectedCardId: Record<string, string | null>;
  /**
   * v1.14.0: per-(workspace, sub-section) expand state. Key shape is
   * `${wsId}:${section}`. Session-only — does NOT persist across
   * launches; default state for every section is collapsed.
   *
   * v1.47.0: retired — the v1.40.0 three-section collapsible model in
   * the detail pane was replaced by always-visible RUNNING + NEXT UP
   * strips. No other surface read this field; safe to drop the type +
   * default + setter. Comment kept for archaeology only; field below
   * is deliberately absent.
   */
  /**
   * Per-card inline-notes expand state on the Kanban board. Keyed by
   * cardId (cardIds are globally unique UUIDs, no need to nest by
   * workspace). Session-only — default is collapsed everywhere on
   * each new session, matching `selectedCardId`'s persistence
   * boundary. Lives in useUi rather than the persisted KanbanCard
   * schema because expansion is viewer state, not card identity.
   */
  expandedCards: Record<string, true>;
  /**
   * v1.66.0 (UX revamp step 2): per-card manual stepper override, keyed
   * by cardId (globally-unique UUIDs). `undefined` ⇒ the panel shows the
   * DERIVED step (`cardLifecycle.deriveCardStep`). Session-only — the
   * lifecycle position itself is derived from persisted card fields, so
   * a fresh session lands on the right step with zero stored state
   * (decision card #9's "open card = session state" is satisfied by
   * this + selectedCardId + the always-mounted card host).
   */
  cardStep: Record<string, import("../lib/cardLifecycle").CardPageSection>;
  /** CL-11: per card, the review whose verdict opened "The result" by
   *  itself and that the person then hid (or left for another section) —
   *  it stays closed for that review. Session-only. */
  resultSetAside: Record<string, string>;
  setResultSetAside: (cardId: string, reviewKey: string) => void;
  /** SP-1 phase 2: per card, "The diff" is open beside "The result" — the
   *  one pair of card sections open together. It holds only while the
   *  result is the open step: `setCardStep` to anything else (or null)
   *  closes it. Session-only. */
  cardDiffOpen: Record<string, true>;
  /** Open the result and its diff together ("See the diff"). */
  openCardDiff: (cardId: string) => void;
  /** Close the diff; the result stays open. */
  closeCardDiff: (cardId: string) => void;
  /** 1.172.0 (C3; CP-8): per card, the Builder's session is open with the
   *  Review — the second pair of card sections open together (findings and
   *  the Builder seen at once). It holds only while the Review is the open
   *  step and its diff is closed: `setCardStep` (to anything) and
   *  `openCardDiff` close it. Session-only. */
  cardSessionWithReview: Record<string, true>;
  /** Open the Review and the session together. */
  openReviewWithSession: (cardId: string) => void;
  /** 1.172.0 (C3 follow-up): open the card's Builder session from outside
   *  the card (the Inbox, a notification's Show) — beside the Review when
   *  the Review is open (its diff closed), else by itself. */
  openCardSession: (cardId: string) => void;
  /** v1.67.0 (step 3a): per-workspace center-stage mode. Missing key ⇒
   *  "terminals" (today's behavior — flip-the-default is step 4). */
  centerMode: Record<string, CenterMode>;
  /** UX-3.6: the one search surface (⌘K) and the scope it shows — ⌘P opens
   *  it on files, ⌘⇧F on text in files, ⌘⇧H on session history. It replaced
   *  Quick Open, the search modal and the history search modal. */
  palette: { open: boolean; scope: PaletteScope; query?: string };
  /** v1.73.0 (step 5b-3): Settings lives in the shell — an overlay over
   *  the main window. The second WebView window is gone. */
  settingsOverlayOpen: boolean;
  /** v1.79.0 (Part 2 P2-1): one-shot deep-link into a Settings section
   *  (e.g. the sidebar Kanban badge → "kanban"). SettingsApp consumes it
   *  on open and clears it; null = open on the default section. */
  settingsSection: string | null;
  /** GH #107: the row that deep link asks Settings to scroll to and mark, as
   *  the label the person reads (`Verify pipeline`). One-shot, consumed with
   *  the section; the mark itself is transient and nothing stores it. */
  settingsRow: string | null;
  /** The deep link's row takes the focus (`SectionTarget.focus`). */
  settingsRowFocus: boolean;
  /** ADR 0006 (third card): a checklist class drafted from a late finding,
   *  waiting for Settings › Build & release to open its editor with it.
   *  Nothing is added until the person presses Save there. */
  checklistDraft: ChecklistDraft | null;
  /** CL-5: the review round whose findings the card's review section is
   *  narrowed to, by card id — set by a round's "See its findings" in
   *  Activity, with the finding ids the round stored. Applies only while the
   *  card's latest review is `reviewId`, so a newer review is never shown
   *  narrowed. Session-only; cleared when the card page closes. */
  reviewRoundFilter: Record<string, ReviewRoundFilter>;
  setReviewRoundFilter: (cardId: string, filter: ReviewRoundFilter | null) => void;
  /** CL-6: a one-shot ask to bring a Challenger finding into view — on the
   *  review diff ("Show on the diff" in the findings list) or in the list
   *  ("Show in the findings list" on the diff). Consumed by its target. */
  findingFocus: FindingFocus | null;
  /** Asks (stamped now; unclaimed ones expire after
   *  `FINDING_FOCUS_TTL_MS`), or clears with null. */
  focusFinding: (focus: Omit<FindingFocus, "at"> | null) => void;
  /** CL-6: the findings the card's review diff shows on its lines, by card
   *  id: the list offers "Show on the diff" for these. Session-only. */
  diffAnchorIds: Record<string, string[]>;
  setDiffAnchorIds: (cardId: string, ids: string[] | null) => void;
  /** CL-6: how many findings lists of each card are on screen: the diff
   *  offers "Show in the findings list" while one is. Session-only. */
  findingLists: Record<string, number>;
  countFindingList: (cardId: string, delta: 1 | -1) => void;
  /** 1.174.0 (DR3): the one Release sheet — every Release… (the Board's ⋯
   *  and header, the sidebar's Release N…, ⌘K, a card's ⋯ › Release…, How
   *  this goes live) opens it, drawn once by App. Session-only. */
  releaseSheet: ReleaseSheetAsk | null;
  setReleaseSheet: (ask: ReleaseSheetAsk | null) => void;
  /** 1.174.0 (DS8): a one-shot ask for a workspace's Board to do what its
   *  ⋯ menu's entry does (Settings search's Elsewhere results). */
  boardAsk: { workspaceId: string; what: "go-live" | "release"; at: number } | null;
  askBoard: (workspaceId: string, what: "go-live" | "release") => void;
  clearBoardAsk: () => void;
  /** UX-3.3: a one-shot ask for the sidebar's workspace switcher to open
   *  with this workspace's name in edit (⌘K "Rename workspace"). */
  renameWorkspaceRequest: string | null;
  /** The sidebar's "N more workspaces" row asks the switcher to open.
   *  One-shot, consumed by the switcher. */
  switcherOpenRequest: boolean;
  requestSwitcherOpen: (open: boolean) => void;
  /**
   * The sidebar's stack of other workspaces: which rows are expanded to list
   * their sessions, by workspace id, and whether the stack shows more than
   * its first five. Session-only, like `expandedCards` — viewer state that
   * starts collapsed each launch (PATTERNS: sub-section state is not
   * persisted), and the rows themselves come and go with the work.
   */
  stackExpanded: Record<string, true>;
  toggleStackExpanded: (wsId: string, expanded?: boolean) => void;
  stackShowAll: boolean;
  setStackShowAll: (all: boolean) => void;
  /** When each workspace was last the active one, this session — the
   *  stack's recency. Stamped on entering and on leaving (below). */
  workspaceActiveAt: Record<string, number>;
  /** QoL 11.1: History's tab and filter — one History, whichever
   *  workspace shows it; ⌘⇧H's session hits land on it. Session-only. */
  historyView: { tab: HistoryTab; fromSearch?: boolean } & HistoryFilter;
  /** A person's own change (`fromSearch` false). ⌘⇧H's session hit passes
   *  `fromSearch: true`; the next ordinary open of History then starts from
   *  the plain view again (Challenger 9). */
  setHistoryView: (patch: Partial<{ tab: HistoryTab; fromSearch: boolean } & HistoryFilter>) => void;
  /** QoL 11.3: what a History row or a ⌘⇧H hit opens when it has no card —
   *  a run's output (and its saved changes), or a brainstorm's mailbox. */
  historySheet: HistorySheetTarget | null;
  openHistorySheet: (target: HistorySheetTarget | null) => void;
  /** UX-3.7: the ⌘/ keyboard shortcuts sheet. Session-only. */
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
  /** UX-3.4: below a 1000 px window the sidebar leaves the layout and opens
   *  over the stage; this is whether it is open. Session-only. */
  sidebarOverlayOpen: boolean;
  setSidebarOverlayOpen: (open: boolean) => void;
  requestWorkspaceRename: (workspaceId: string | null) => void;
  setBrowserMode: (wsId: string, mode: BrowserMode) => void;
  setLeftPanelOpen: (open: boolean) => void;
  setGridVisible: (open: boolean) => void;
  /** v1.7.0: select a card. v1.76.0: `openBoard` (default true) also
   *  lands the center stage on Board mode, where the open card renders
   *  as the full-width lifecycle. Pass false to set selection state
   *  without navigating (e.g. PromoteButton — the card is then open the
   *  next time the user visits the Board, per decision card #09). */
  selectCard: (wsId: string, cardId: string | null, openBoard?: boolean) => void;
  /** Toggle inline expand on a kanban card's notes preview. */
  toggleCardExpanded: (cardId: string) => void;
  /** v1.66.0: set (or clear with null) the per-card stepper override. */
  setCardStep: (
    cardId: string,
    step: import("../lib/cardLifecycle").CardPageSection | null,
  ) => void;
  /** v1.67.0: set the center-stage mode for a workspace. */
  setCenterMode: (wsId: string, mode: CenterMode) => void;
  /** Open ⌘K on a scope (or switch the open one to it). */
  /** `query`: what the field opens with (QoL 1.168 G2: Settings' "Search
   *  the whole app" carries what was typed there). */
  openPalette: (scope?: PaletteScope, query?: string) => void;
  closePalette: () => void;
  setSettingsOverlayOpen: (open: boolean) => void;
  openSettingsSection: (section: string, target?: SectionTarget) => void;
  consumeSettingsSection: () => void;
  /** Open Settings › Build & release with `draft` in the class editor. */
  openChecklistDraft: (draft: ChecklistDraft) => void;
  consumeChecklistDraft: () => void;
}

/**
 * Which workspace a Settings deep link is about (GH #152).
 *
 * Settings › This workspace draws the **active** workspace's own block, and so
 * does every Library page, so a link raised for another workspace has to say
 * which one or it lands on a page that shows nothing. Optional: a link raised on
 * the workspace the member is looking at needs nothing, and the app-wide pages
 * (Build & release, Dictation, …) are about no workspace at all.
 */
export interface CodePreviewTarget {
  address: string;
  nonce: number;
}

export interface SectionTarget {
  workspaceId?: string;
  /**
   * GH #107: the row Settings scrolls to and marks, as the words the person
   * reads (`Verify pipeline`). A row whose label is drawn twice on one page —
   * `Builder` under Claude and under Codex — is named by its section too,
   * `Claude › Builder` (`settingsSearch.ts`'s `rowToken`).
   */
  row?: string;
  /** 1.176.1 walk: a "Fix" or "Open the setting" — the row's field takes the
   *  focus, not the Settings dialog. */
  focus?: boolean;
}

export interface ChecklistDraft {
  workspaceId: string;
  name: string;
  sentence: string;
  /** The finding it came from ("F7"), for the editor's line. */
  findingId: string;
}

/** CL-6: which finding to bring into view, and where. */
export interface FindingFocus {
  cardId: string;
  findingId: string;
  to: "diff" | "list";
  /** When it was asked (ms): an older ask than the TTL is ignored. */
  at: number;
}

/** CL-6: how long an ask to show a finding waits to be claimed. */
export const FINDING_FOCUS_TTL_MS = 1000;

/** CL-6: an ask still in time to be claimed. */
export function findingFocusLive(focus: FindingFocus | null, now = Date.now()): focus is FindingFocus {
  return focus != null && now - focus.at <= FINDING_FOCUS_TTL_MS;
}

/** CL-5: a round's findings, as "See its findings" asked for them. */
export interface ReviewRoundFilter {
  round: number;
  ids: string[];
  reviewId: string | null;
}

/** The record without `key` — the same object when it has none. */
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export const useUi = create<UiStore>((set, get) => ({
  browserMode: {},
  codePreviewOpen: {},
  setCodePreviewOpen: (wsId, open) =>
    set((state) => {
      if (open === Boolean(state.codePreviewOpen[wsId])) return state;
      const next = { ...state.codePreviewOpen };
      if (open) next[wsId] = true;
      else delete next[wsId];
      return { codePreviewOpen: next };
    }),
  codePreviewTarget: {},
  setCodePreviewTarget: (wsId, address) =>
    set((state) => {
      const cur = state.codePreviewTarget[wsId];
      if (!address && !cur) return state;
      const next = { ...state.codePreviewTarget };
      if (address) next[wsId] = { address, nonce: (cur?.nonce ?? 0) + 1 };
      else delete next[wsId];
      return { codePreviewTarget: next };
    }),
  leftPanelOpen: true,
  gridVisible: true,
  selectedCardId: {},
  expandedCards: {},
  cardStep: {},
  resultSetAside: {},
  cardDiffOpen: {},
  cardSessionWithReview: {},
  openCardDiff: (cardId) =>
    set((state) => ({
      cardStep: { ...state.cardStep, [cardId]: "outcome" },
      cardDiffOpen: state.cardDiffOpen[cardId]
        ? state.cardDiffOpen
        : { ...state.cardDiffOpen, [cardId]: true },
      // C3: the diff takes the session's place beside the Review.
      cardSessionWithReview: withoutKey(state.cardSessionWithReview, cardId),
    })),
  openCardSession: (cardId) => {
    const state = get();
    if (state.cardStep[cardId] === "outcome" && !state.cardDiffOpen[cardId]) state.openReviewWithSession(cardId);
    else state.setCardStep(cardId, "run");
  },
  openReviewWithSession: (cardId) =>
    set((state) => ({
      cardStep: { ...state.cardStep, [cardId]: "outcome" },
      cardDiffOpen: withoutKey(state.cardDiffOpen, cardId),
      cardSessionWithReview: state.cardSessionWithReview[cardId]
        ? state.cardSessionWithReview
        : { ...state.cardSessionWithReview, [cardId]: true },
    })),
  closeCardDiff: (cardId) =>
    set((state) => {
      if (!state.cardDiffOpen[cardId]) return state;
      const next = { ...state.cardDiffOpen };
      delete next[cardId];
      return { cardDiffOpen: next };
    }),
  setResultSetAside: (cardId, reviewKey) =>
    set((state) =>
      state.resultSetAside[cardId] === reviewKey
        ? state
        : { resultSetAside: { ...state.resultSetAside, [cardId]: reviewKey } },
    ),
  centerMode: {},
  palette: { open: false, scope: "commands" },
  settingsOverlayOpen: false,
  settingsSection: null,
  settingsRow: null,
  settingsRowFocus: false,
  checklistDraft: null,
  reviewRoundFilter: {},
  setReviewRoundFilter: (cardId, filter) =>
    set((s) => {
      if (!filter && !(cardId in s.reviewRoundFilter)) return s;
      const next = { ...s.reviewRoundFilter };
      if (filter) next[cardId] = filter;
      else delete next[cardId];
      return { reviewRoundFilter: next };
    }),
  findingFocus: null,
  focusFinding: (focus) => {
    if (!focus) {
      set({ findingFocus: null });
      return;
    }
    const ask: FindingFocus = { ...focus, at: Date.now() };
    // SP-1 phase 2: "Show on the diff" opens the diff beside the result in
    // the same update, so the finding's anchor is laid out (not in a
    // closed, inert section) when it claims the ask.
    set((state) =>
      focus.to === "diff"
        ? {
            findingFocus: ask,
            cardStep: { ...state.cardStep, [focus.cardId]: "outcome" },
            cardDiffOpen: { ...state.cardDiffOpen, [focus.cardId]: true },
            cardSessionWithReview: withoutKey(state.cardSessionWithReview, focus.cardId),
          }
        : { findingFocus: ask },
    );
    // The asker's own expiry: an ask nothing claimed in time is dropped, so
    // a list or diff mounted later never takes the focus for it.
    setTimeout(() => {
      if (useUi.getState().findingFocus === ask) useUi.getState().focusFinding(null);
    }, FINDING_FOCUS_TTL_MS);
  },
  diffAnchorIds: {},
  setDiffAnchorIds: (cardId, ids) =>
    set((s) => {
      const next = { ...s.diffAnchorIds };
      if (ids && ids.length > 0) next[cardId] = ids;
      else if (cardId in next) delete next[cardId];
      else return s;
      return { diffAnchorIds: next };
    }),
  findingLists: {},
  countFindingList: (cardId, delta) =>
    set((s) => {
      const count = Math.max(0, (s.findingLists[cardId] ?? 0) + delta);
      const next = { ...s.findingLists };
      if (count > 0) next[cardId] = count;
      else delete next[cardId];
      return { findingLists: next };
    }),
  releaseSheet: null,
  setReleaseSheet: (releaseSheet) => set({ releaseSheet }),
  boardAsk: null,
  askBoard: (workspaceId, what) => set({ boardAsk: { workspaceId, what, at: Date.now() } }),
  clearBoardAsk: () => set({ boardAsk: null }),
  allSkillsOpen: false,
  setAllSkillsOpen: (open) => set((state) => (state.allSkillsOpen === open ? state : { allSkillsOpen: open })),
  renameWorkspaceRequest: null,
  switcherOpenRequest: false,
  requestSwitcherOpen: (open) => set({ switcherOpenRequest: open }),
  stackExpanded: {},
  toggleStackExpanded: (wsId, expanded) =>
    set((state) => {
      const on = expanded ?? !state.stackExpanded[wsId];
      if (on === Boolean(state.stackExpanded[wsId])) return state;
      const next = { ...state.stackExpanded };
      if (on) next[wsId] = true;
      else delete next[wsId];
      return { stackExpanded: next };
    }),
  stackShowAll: false,
  setStackShowAll: (all) => set({ stackShowAll: all }),
  workspaceActiveAt: {},
  historyView: { tab: "runs", workspaceId: null, text: "" },
  setHistoryView: (patch) => set((s) => ({ historyView: { ...s.historyView, fromSearch: false, ...patch } })),
  historySheet: null,
  openHistorySheet: (target) => set({ historySheet: target }),
  shortcutsOpen: false,
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  sidebarOverlayOpen: false,
  setSidebarOverlayOpen: (open) => set({ sidebarOverlayOpen: open }),
  requestWorkspaceRename: (workspaceId) => set({ renameWorkspaceRequest: workspaceId }),
  setBrowserMode: (wsId, mode) =>
    set((state) => ({
      browserMode: { ...state.browserMode, [wsId]: mode },
    })),
  setLeftPanelOpen: (open) => set({ leftPanelOpen: open }),
  setGridVisible: (open) => set({ gridVisible: open }),
  selectCard: (wsId, cardId, openBoard = true) => {
    set((state) => ({
      selectedCardId: { ...state.selectedCardId, [wsId]: cardId },
    }));
    // v1.76.0 (STEP6 D7): the card right-tab is retired — opening a
    // card means landing the center stage on Board mode, where the
    // `.center-card-host` renders the lifecycle over the board.
    if (openBoard && cardId !== null) {
      openCenterMode(wsId, "board");
    }
  },
  toggleCardExpanded: (cardId) =>
    set((state) => {
      const next = { ...state.expandedCards };
      if (next[cardId]) delete next[cardId];
      else next[cardId] = true;
      return { expandedCards: next };
    }),
  setCardStep: (cardId, step) =>
    set((state) => {
      const next = { ...state.cardStep };
      if (step === null) delete next[cardId];
      else next[cardId] = step;
      // SP-1 phase 2: one section at a time, but for the result and its
      // diff — any other step (or none) closes the diff. C3: and for the
      // Review with the session, which only `openReviewWithSession` opens.
      const session = withoutKey(state.cardSessionWithReview, cardId);
      if (step === "outcome" || !state.cardDiffOpen[cardId]) return { cardStep: next, cardSessionWithReview: session };
      const diff = { ...state.cardDiffOpen };
      delete diff[cardId];
      return { cardStep: next, cardDiffOpen: diff, cardSessionWithReview: session };
    }),
  // Skills hub H7: choosing a mode is leaving All skills, from wherever
  // the choice came (the sidebar, a shortcut, a toast's Show).
  setCenterMode: (wsId, mode) =>
    set((state) => ({
      centerMode: { ...state.centerMode, [wsId]: mode },
      // Challenger 9: a ⌘⇧H session hit's filter lasts until History is
      // opened the ordinary way again.
      ...(mode === "activity" && state.historyView.fromSearch
        ? { historyView: { tab: "runs" as const, workspaceId: null, text: "" } }
        : {}),
      allSkillsOpen: false,
    })),
  openPalette: (scope = "commands", query) =>
    set({ palette: { open: true, scope, ...(query ? { query } : {}) } }),
  closePalette: () =>
    set((state) => ({ palette: { open: false, scope: state.palette.scope } })),
  setSettingsOverlayOpen: (open) =>
    set(
      open
        ? { settingsOverlayOpen: true }
        : {
            settingsOverlayOpen: false,
            settingsSection: null,
            settingsRow: null,
            checklistDraft: null,
          },
    ),
  openSettingsSection: (section, target) => {
    // GH #152: the workspace the link is about comes before the section. The
    // block `Show` leads to is drawn for the active workspace, so a refusal
    // raised for another one used to open a page with nothing on it.
    const wanted = target?.workspaceId ?? null;
    // Review 2: `false` when the named workspace is gone, and the link is then
    // treated exactly as one that named none. Preferring `wanted` regardless
    // would key the Library page to a workspace the guard had just refused to
    // activate — no host draws it, so nothing would open at all.
    const live = wanted != null && activateWorkspace(wanted);
    // GH #96: `agent-instructions` and `skills` are the Library's pages now, so
    // a link that names one opens the Library rather than a Settings page about
    // something else (review 1). Without an active workspace there is no
    // Library to open, and Settings' own fallback still answers.
    const page = libraryLinkTarget(section);
    const active = live ? wanted : useWorkspaces.getState().activeId;
    if (page && active) {
      openLibraryPage(active, page);
      return;
    }
    set({
      settingsOverlayOpen: true,
      settingsSection: section,
      settingsRow: target?.row ?? null,
      settingsRowFocus: target?.focus === true,
    });
  },
  consumeSettingsSection: () => set({ settingsSection: null, settingsRow: null, settingsRowFocus: false }),
  openChecklistDraft: (draft) =>
    set({ checklistDraft: draft, settingsOverlayOpen: true, settingsSection: "build-release" }),
  consumeChecklistDraft: () => set({ checklistDraft: null }),
}));

/**
 * UX-3.4: remember the sidebar's layout on this Mac — only the sidebar key,
 * applied to the settings as they are when the write runs, so a preference
 * saved meanwhile is never undone. Nothing is written before the settings
 * have loaded: the queue would otherwise send the defaults over the file.
 */
export function saveSidebarLayout(next: SidebarLayout): void {
  const settings = useSettings.getState();
  if (!settings.loaded) return;
  void settings
    .update((latest) => withSidebarLayout(latest, next))
    .catch((e) => console.warn("sidebar layout not saved:", e));
}

/** UX-3.4: ⌘\ and the stage header's sidebar button. Hides or shows the
 *  docked sidebar (remembered); below 1000 px opens or closes the overlay. */
export function toggleSidebar(): void {
  if (window.innerWidth < SIDEBAR_OVERLAY_BELOW) {
    const ui = useUi.getState();
    ui.setSidebarOverlayOpen(!ui.sidebarOverlayOpen);
    return;
  }
  const current = sidebarLayoutOf(useSettings.getState().settings.windows);
  saveSidebarLayout({ ...current, collapsed: !current.collapsed });
}

/** The stack's recency: a workspace is stamped when it becomes active and
 *  again when it is left, whatever switched it (the switcher, ⌘1–9, a jump
 *  from the Inbox or the stack). Session-only, like the rest of this store. */
useWorkspaces.subscribe((next, prev) => {
  if (next.activeId === prev.activeId) return;
  const now = Date.now();
  const stamps: Record<string, number> = {};
  if (prev.activeId) stamps[prev.activeId] = now;
  if (next.activeId) stamps[next.activeId] = now;
  useUi.setState((s) => ({ workspaceActiveAt: { ...s.workspaceActiveAt, ...stamps } }));
});
