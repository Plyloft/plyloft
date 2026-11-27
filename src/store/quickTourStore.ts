import { create } from "zustand";
import { shipReadyTotalNow } from "./shipReadyHooks";
import { isSkillCard } from "../lib/skillCards";
import { tourRunning } from "../lib/tutorial/tutorialEngine";
import {
  quickMarks,
  sectionOnScreen,
  tipSeen,
  tipsOn,
  withSectionSeen,
  withTips,
  type QuickCard,
  type QuickMark,
  type QuickNav,
  type TipSection,
} from "../lib/tutorial/quickTour";
import { startQuickTour as recordQuickTour } from "../lib/tutorial/tutorialEngine";
import { useKanban } from "./kanbanStore";
import { useSettings } from "./settingsStore";
import { setupIsOpen, useSetup } from "./setupStore";
import { beforeGuideOpens, holdTourObservationWhile, recheckTour, writeTutorial } from "./tutorialStore";
import { effectiveCenterMode, openCenterMode, useUi, type CenterMode } from "./uiStore";
import { useWorkMode } from "./workModeStore";
import { useWorkspaces } from "./workspaceStore";

/**
 * Getting started TU-6 (TUTORIAL_SPEC §6.4, §6.5): the Quick tour and the
 * first-visit tips, in memory. Only two things are written to the record
 * (`writeTutorial`, spread): the Quick tour's `path`, and each section whose
 * tip was shown (`seenSections`) — plus the tips switch when Help flips it.
 *
 * The Quick tour moves the page only through the tour's helpers (§4.2) and a
 * card's page through `selectCard`; nothing is pressed. When it ends on the
 * page it last put on screen, it puts back the one it started from, so a
 * minute's look leaves the member where they were.
 */

/** Where the member was when the Quick tour started, and where it last put
 *  them (to know whether they moved on their own since). */
type View = {
  workspaceId: string | null;
  mode: CenterMode | null;
  cardId: string | null;
  allSkills: boolean;
  gridVisible: boolean;
};

type QuickRun = {
  marks: QuickMark[];
  index: number;
  origin: View;
  /** What the last mark's navigation left on screen. */
  left: View | null;
  /** Bumped per mark, so the coach-mark's Next takes the keyboard again. */
  shown: number;
};

type QuickTourRuntime = {
  quick: QuickRun | null;
  /** The first-visit tip on screen now (§6.5). */
  tip: TipSection | null;
};

export const useQuickTour = create<QuickTourRuntime>(() => ({ quick: null, tip: null }));

holdTourObservationWhile(() => useQuickTour.getState().quick != null);
// One guide at a time: the full tour opened or resumed from anywhere — Help,
// the sidebar row, Setup's Start the tour — ends the Quick tour.
// A first-visit tip goes too (Challenger round 2).
beforeGuideOpens(() => {
  endQuickTour();
  useQuickTour.setState({ tip: null });
});

/** The sections a mark explains: seen there, their tip does not repeat it. */
const TIP_OF_MARK: Partial<Record<QuickMark["id"], TipSection>> = {
  terminals: "terminals",
  code: "code",
  library: "library",
  inbox: "inbox",
  "all-skills": "all-skills",
};

function viewNow(): View {
  const ws = useWorkspaces.getState().activeId;
  const ui = useUi.getState();
  return {
    workspaceId: ws,
    mode: ws ? effectiveCenterMode(ui.centerMode, ws) : null,
    cardId: ws ? (ui.selectedCardId[ws] ?? null) : null,
    allSkills: ui.allSkillsOpen,
    gridVisible: ui.gridVisible,
  };
}

const sameView = (a: View, b: View) =>
  a.workspaceId === b.workspaceId &&
  a.mode === b.mode &&
  a.cardId === b.cardId &&
  a.allSkills === b.allSkills &&
  a.gridVisible === b.gridVisible;

/** The card a card's-page mark opens: the newest ordinary card of the active
 *  workspace's Board, if it has one (§6.4). */
function quickCard(): QuickCard | null {
  const ws = useWorkspaces.getState().activeId;
  if (!ws) return null;
  const board = useKanban.getState().byWorkspace[ws];
  if (!board?.loaded) return null;
  let best: (typeof board.cards)[number] | null = null;
  for (const c of board.cards) {
    if (c.archived || c.prReview || isSkillCard(c)) continue;
    if (!best || c.createdAt > best.createdAt) best = c;
  }
  return best ? { workspaceId: ws, cardId: best.id } : null;
}

/** The card, if it is still on its Board: a card deleted meanwhile is not
 *  selected again. */
function cardStill(ws: string, cardId: string | null): string | null {
  if (!cardId) return null;
  return useKanban.getState().byWorkspace[ws]?.cards.some((c) => c.id === cardId) ? cardId : null;
}

function navigate(nav: QuickNav | undefined, origin: View): void {
  // The workspace on screen — never the full tour's own (`tourNavigate`
  // reads the record's), which may be another project (Challenger).
  const ws = useWorkspaces.getState().activeId;
  // A card the previous mark opened is put back as it was: the Board is not
  // left showing it after the tour.
  if (ws && ws === origin.workspaceId) {
    const ui = useUi.getState();
    const card = cardStill(ws, origin.cardId);
    if ((ui.selectedCardId[ws] ?? null) !== card) ui.selectCard(ws, card, false);
  }
  if (!nav || !ws) return;
  if ("openCard" in nav) {
    if (nav.openCard.workspaceId === ws) useUi.getState().selectCard(ws, nav.openCard.cardId, true);
    return;
  }
  if (!("mode" in nav)) return;
  // The Board mark from a card's page: the Board itself, not the card.
  if (nav.mode === "board" && useUi.getState().selectedCardId[ws]) useUi.getState().selectCard(ws, null, false);
  openCenterMode(ws, nav.mode);
}

function show(run: QuickRun, index: number): void {
  const mark = run.marks[index];
  navigate(mark.navigate, run.origin);
  useQuickTour.setState({ quick: { ...run, index, left: viewNow(), shown: run.shown + 1 }, tip: null });
  const section = TIP_OF_MARK[mark.id];
  if (section) void markTipSeen(section).catch(() => {});
}

/**
 * Help › Take a 1-minute tour, Setup's Ready on "I use them regularly"
 * (§2, §3.3). The full tour's panel stands aside while it runs (one guide at
 * a time); the record keeps only that this was the tour last started.
 * Started again while it runs, it starts over from the first mark and still
 * goes back to where the member first was.
 */
export function startQuickTour(): void {
  const running = useQuickTour.getState().quick;
  const origin = running?.origin ?? viewNow();
  const marks = quickMarks({
    card: quickCard(),
    team: useWorkMode.getState().mode !== "solo",
    shipReady: shipReadyTotalNow(),
  });
  show({ marks, index: 0, origin, left: null, shown: running?.shown ?? 0 }, 0);
  void writeTutorial((cur) => (cur?.path === "quick" ? cur : recordQuickTour(cur))).catch(() => {});
}

/** Next: the following mark; the last one's Done ends the tour. */
export function nextQuickMark(): void {
  const run = useQuickTour.getState().quick;
  if (!run) return;
  if (run.index + 1 >= run.marks.length) endQuickTour();
  else show(run, run.index + 1);
}

/**
 * Done and Close: back where the member started, unless they went somewhere
 * of their own meanwhile. Esc (`restore: false`) leaves the page as it is,
 * the keyboard on the control the mark pointed at (§10).
 */
export function endQuickTour({ restore = true }: { restore?: boolean } = {}): void {
  const run = useQuickTour.getState().quick;
  if (!run) return;
  const { origin, left } = run;
  const ws = useWorkspaces.getState().activeId;
  if (restore && left && sameView(left, viewNow()) && origin.workspaceId && ws === origin.workspaceId) {
    const ui = useUi.getState();
    ui.selectCard(ws, cardStill(ws, origin.cardId), false);
    if (origin.mode) openCenterMode(ws, origin.mode);
    if (origin.allSkills) ui.setAllSkillsOpen(true);
    // The centre stage hidden at the start is hidden again (each mark's
    // `openCenterMode` shows it).
    if (!origin.gridVisible) ui.setGridVisible(false);
  }
  // The page put back is not the member opening a section: no tip for it
  // (the subscription sees the restore while the tour still runs).
  lastSection = sectionNow();
  useQuickTour.setState({ quick: null });
  // The full tour looks again now, not at the next unrelated change.
  recheckTour();
}

// ── First-visit tips (§6.5) ──────────────────────────────────────────────

/** Help › Tips when I open a section. */
export function setTourTips(on: boolean): Promise<unknown> {
  if (!on) useQuickTour.setState({ tip: null });
  return writeTutorial((cur) => (cur?.tips === on ? cur : withTips(cur, on)));
}

/** Got it, Esc: the tip goes. It was recorded as seen when it showed. */
export function dismissTip(): void {
  useQuickTour.setState({ tip: null });
}

/** The tip of `section` is on screen: it never shows again. */
export function markTipSeen(section: TipSection): Promise<unknown> {
  return writeTutorial((cur) => (tipSeen(cur, section) ? cur : withSectionSeen(cur, section)));
}

let tipsStarted = false;
let tipStops: (() => void)[] = [];
/** The section the last look saw: a tip shows when it changes to a section
 *  (the member opening it), never for the one the app launched on. */
let lastSection: TipSection | null | undefined;

function sectionNow(): TipSection | null {
  const ws = useWorkspaces.getState().activeId;
  const ui = useUi.getState();
  return ws ? sectionOnScreen(effectiveCenterMode(ui.centerMode, ws), ui.allSkillsOpen) : null;
}

function lookForTip(): void {
  const settings = useSettings.getState();
  const ws = useWorkspaces.getState();
  if (!settings.loaded || !ws.loaded) return;
  const section = sectionNow();
  const before = lastSection;
  lastSection = section;
  const state = useQuickTour.getState();
  if (state.tip && state.tip !== section) useQuickTour.setState({ tip: null });
  // The first look is where the app opened: nobody opened it.
  if (before === undefined || section === before || section == null) return;
  const record = settings.settings.onboarding?.tutorial ?? null;
  if (!tipsOn(record, settings.settings.onboarding?.level ?? null)) return;
  if (tipSeen(record, section)) return;
  // §6.5: no tour under way — the full tour (paused too) or the Quick tour —
  // and nothing over the shell (Setup, Sign in).
  if (tourRunning(record) || state.quick || setupIsOpen()) return;
  useQuickTour.setState({ tip: section });
}

/** Follow the section on screen (§6.5). Idempotent. */
export function startTourTipsSubscription(): void {
  if (tipsStarted) return;
  tipsStarted = true;
  tipStops.push(
    useUi.subscribe(lookForTip),
    useWorkspaces.subscribe(lookForTip),
    useSettings.subscribe(lookForTip),
    useSetup.subscribe(lookForTip),
  );
  lookForTip();
}

/** Tests: forget the Quick tour, the tip and the subscription. */
export function stopQuickTourForTests(): void {
  for (const stop of tipStops) stop();
  tipStops = [];
  tipsStarted = false;
  lastSection = undefined;
  useQuickTour.setState({ quick: null, tip: null });
}
