import { fixRoundCheckOn } from "../lib/fixRoundCheck";
import { permissionsQuestionShown } from "../lib/tutorial/tourPanel";
import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import { fsListDir, kanbanLoad, projectTryCommandGet, type KanbanCard } from "../ipc";
import { cardLiveFrom, cardLiveSourcesNow, type CardLiveSources } from "../hooks/useCardLive";
import { isUndecided } from "../lib/buildBoth";
import { effectiveBuilderVendor } from "../lib/cardPage";
import { presentCard } from "../lib/cardPresentation";
import { shipItGoesToGitHub } from "../lib/shipVia";
import { platform } from "../lib/platform";
import type { TutorialProgress } from "../lib/settingsShape";
import { STEP, TUTORIAL_SINCE, type ChapterId, type TourAnchor, type TourNav } from "../lib/tutorial/manifest";
import {
  buildTutorialSnapshot,
  cardGone,
  cardKey,
  currentChapter,
  projectHasSourceFiles,
  completeStep,
  endTour,
  isDone,
  isSkipped,
  observeTour,
  pauseTour,
  resumeTour,
  skipChapter,
  skipStep,
  startFullTour,
  startOver,
  startTourFromSetup,
  tourResumable,
  tourRunning,
  tourWorkspace,
  tourView,
  unskipStep,
  withTourCard,
  type TourCardPresentation,
  type TutorialSnapshot,
} from "../lib/tutorial/tutorialEngine";
import { sheetStart } from "../lib/tryPanel";
import { tryRowState } from "../lib/tryCommand";
import { vendorReadiness } from "../lib/vendorReadiness";
import { useAccount } from "./accountStore";
import { useBuilder } from "./builderStore";
import { useBuilderWaiting } from "./builderWaitingStore";
import { useCardFacts } from "./cardFactsStore";
import { useDoctor } from "./doctorStore";
import { startGuidedFirstCard } from "./firstCardGuideStore";
import { useSetup } from "./setupStore";
import { useKanban } from "./kanbanStore";
import { useLibrary } from "./libraryStore";
import { useSettings } from "./settingsStore";
import { newCardBuilderVendor } from "../lib/settingsShape";
import { useTiles } from "./tileStore";
import { useTryRuns } from "./tryRunStore";
import { effectiveCenterMode, openCardStep, openCenterMode, openLibraryPage, useUi } from "./uiStore";
import { useWorkMode } from "./workModeStore";
import { useWorkspaces } from "./workspaceStore";
import { useAreas } from "./areaStore";
import { pickerShown } from "../lib/areaPicker";

/**
 * Getting started (TUTORIAL_SPEC §7): the tour's detection. One subscription
 * reads the stores into a `TutorialSnapshot` (`lib/tutorial/tutorialEngine.ts`)
 * on every change and writes what `observeTour` returns — steps done, B3's
 * card — through `useSettings.getState().update` (whole-file atomic replace).
 * It does nothing unless a full tour is started and not ended.
 *
 * App starts it (TU-4), beside `startFirstCardGuideSubscription`. The same
 * look publishes the snapshot the Guide panel and the coach-mark draw from
 * (`useTutorialRuntime.snapshot`), so the panel never builds one in render.
 */

type TutorialRuntime = {
  /** §7: the tour card just went (deleted, or its workspace removed); B3
   *  says *That card is gone* until a new card is taken. In memory only. */
  cardGone: boolean;
  /** The stores as the tour reads them, while a full tour runs; null
   *  otherwise. Written by the subscription, never in render. */
  snapshot: TutorialSnapshot | null;
  /**
   * TU-4 (§9): the panel was opened in this launch. Quitting is an implicit
   * pause, so a launch shows only the sidebar row (not the open panel; no
   * pill, 1.174.0 D3b) until Resume or
   * Help › Getting started: the record is not written for it.
   */
  panelOpen: boolean;
  /** Where the keyboard goes after an explicit open, pause or resume
   *  (§10): the panel's heading or the sidebar row's Resume, so focus is
   *  never dropped with the surface that held it. Bumped per request. */
  focusRequest: { to: "panel" | "sidebar"; n: number } | null;
  /**
   * TU-4 Mac walk (§9): the step *Do it now* was last pressed on. It is the
   * current step — the one the panel shows and the coach-mark points at —
   * until it is done or skipped again, even B6/B7 or a step whose moment is
   * gone (`tourView`'s `focus`). In memory only: a launch goes back to the
   * first step to do.
   */
  focus: string | null;
  /**
   * TU-7 (§3.1): the chapter picked under *More, when you're ready* (or the
   * base chapter picked back). In memory only: a launch shows the base
   * chapter (`currentChapter`); the list says how far each one got.
   */
  chapter: ChapterId | null;
};

export const useTutorialRuntime = create<TutorialRuntime>(() => ({
  cardGone: false,
  snapshot: null,
  panelOpen: false,
  focusRequest: null,
  focus: null,
  chapter: null,
}));

function requestFocus(to: "panel" | "sidebar"): void {
  const n = (useTutorialRuntime.getState().focusRequest?.n ?? 0) + 1;
  useTutorialRuntime.setState({ focusRequest: { to, n } });
}

const tutorialOf = (): TutorialProgress | null => useSettings.getState().settings.onboarding?.tutorial ?? null;

/** Write the tour's record: `next` is applied to the record as it is at the
 *  time of the write, spread — never rebuilt (TU-1). */
export function writeTutorial(next: (cur: TutorialProgress | null) => TutorialProgress | null): Promise<unknown> {
  return useSettings.getState().update((cur) => {
    const before = cur.onboarding?.tutorial ?? null;
    const after = next(before);
    if (after === before) return cur;
    return { ...cur, onboarding: { ...cur.onboarding, tutorial: after } };
  });
}

/** The card page's presentation of a card, from the stores as they are. */
function presenter(src: CardLiveSources): (card: KanbanCard) => TourCardPresentation {
  return (card) => {
    const tip = src.reviewTips?.get(`${card.workspaceId}::${card.id}`) ?? null;
    const live = cardLiveFrom(src, card, tip);
    const p = presentCard(card, live);
    return {
      state: p.state,
      rule: p.rule,
      session: live.session,
      vendor: card.builder?.vendor ?? effectiveBuilderVendor(src.builder.vendorPref[card.id], card, src.builderDefault),
      shipMode: p.action.shipMode ?? null,
      // G1: where Ship it goes, as the card page resolves it.
      shipItToGitHub: live.outcome ? shipItGoesToGitHub(live.workspace.shipVia, live.outcome.prOffered) : null,
      // The Now box draws `presentation` (CardDetailPanel `statePresentation`).
      primary: p.presentation.actionId,
      undecidedBuildBoth: isUndecided(card),
      waiting: p.waiting ?? null,
    };
  };
}

// ── What the tour reads besides the stores (TU-5) ─────────────────────────
// In memory, for this launch only.

/** D25: whether each workspace has source files (`projectHasSourceFiles`
 *  over `fs_list_dir`, a few folders at most), read once per launch when B3
 *  shows there. */
const emptyByWorkspace = new Map<string, boolean>();
/** Asked once per launch, whatever the answer (a failed walk is not asked
 *  again in a loop). */
const emptyAsked = new Set<string>();
/** TU-7 Mac walk (K3): whether each project reads as a plain website (the
 *  Settings row's `tryRowState` over `project_try_command_get`), read once
 *  per launch when the Code chapter is shown there. Try it in <project> is
 *  offered only with a start command, so its sheet never says it for K3. */
const staticByWorkspace = new Map<string, boolean>();
const staticAsked = new Set<string>();
/** §6.3: cards whose How to start your app sheet was seen open; B11: cards
 *  whose Try it was seen Running. */
const sheetSeen = new Set<string>();
const triedCards = new Set<string>();
/** TU-5 Mac walk (B9, §6.3): cards whose sheet's Open index.html opened the
 *  page, and cards the sheet called a plain website. */
const openedCards = new Set<string>();
const staticCards = new Set<string>();
/** TU-5 Mac walk (§11): the guided first card's board, read once from the
 *  disk when its project's board is not loaded (B3's *Continue with*). */
let guidedBoard: { workspaceId: string; cards: readonly KanbanCard[] | null } | null = null;
let guidedAsked: string | null = null;
/** §3.1 (Challenger): when this launch first saw each Builder session (its
 *  PTY id). A resumed session keeps the card's first `builder.startedAt`
 *  (`builder.rs` resume), so after a quit, or a session closed and resumed,
 *  the live line counts from here instead. */
const sessionSeen = new Map<string, number>();
/** A session first seen this long after the card's start is a later one. */
const SESSION_GRACE_MS = 2 * 60_000;

function buildStart(card: KanbanCard): number | null {
  const started = card.builder?.startedAt ? card.builder.startedAt : null;
  const pty = card.builder?.ptyId;
  if (started == null || !pty) return started;
  let seen = sessionSeen.get(pty);
  if (seen == null) {
    seen = Date.now();
    sessionSeen.set(pty, seen);
  }
  return seen - started > SESSION_GRACE_MS ? seen : started;
}


function noteTryRuns(): void {
  const tryState = useTryRuns.getState();
  const sheet = tryState.sheet;
  if (sheet) {
    // Save and try under way: the sheet closes onto a start, not unsaved
    // (Challenger: the fallback flashed between the save and the start).
    const key = cardKey(sheet.card.workspaceId, sheet.card.id);
    if (sheet.busy) sheetSeen.delete(key);
    else sheetSeen.add(key);
    if (sheet.view && sheetStart(sheet.view).kind === "staticSite") staticCards.add(key);
  }
  for (const [key, run] of Object.entries(tryState.runs)) {
    if (run?.phase !== "running") continue;
    const [ws, card] = key.split("\u0000");
    if (ws && card) triedCards.add(cardKey(ws, card));
  }
  // B9 (TU-5 Mac walk): a plain website opened is a card tried, too.
  for (const key of Object.keys(tryState.indexOpened ?? {})) {
    const [ws, card] = key.split("\u0000");
    if (!ws || !card) continue;
    openedCards.add(cardKey(ws, card));
    triedCards.add(cardKey(ws, card));
  }
}

/** The snapshot, from the stores now. */
export function tutorialSnapshotNow(): TutorialSnapshot {
  const settings = useSettings.getState().settings;
  const ws = useWorkspaces.getState();
  const ui = useUi.getState();
  const record = settings.onboarding?.tutorial ?? null;
  const gates = useAccount.getState().gates;
  const readiness = vendorReadiness(useDoctor.getState().report);
  // Before a card: the active workspace (TU-5, `tourWorkspace`). B3's
  // adoption may move it to the card's; the empty-project look and the
  // tiles read where the tour is now.
  const tourWs = tourWorkspace(record, { loaded: ws.loaded, list: ws.workspaces }, ws.activeId).workspaceId;
  const tiles: Record<string, number> = {};
  for (const t of (tourWs ? useTiles.getState().byWorkspace[tourWs]?.tiles : undefined) ?? []) {
    tiles[t.kind] = (tiles[t.kind] ?? 0) + 1;
  }
  const guided = settings.onboarding?.firstCard ?? null;
  // TU-7: the active workspace, for the optional chapters.
  const activeId = ws.activeId;
  const hereTiles: Record<string, number> = {};
  for (const t of (activeId ? useTiles.getState().byWorkspace[activeId]?.tiles : undefined) ?? []) {
    hereTiles[t.kind] = (hereTiles[t.kind] ?? 0) + 1;
  }
  const openCardId = activeId ? (ui.selectedCardId[activeId] ?? null) : null;
  const cardShown = openCardId != null && activeId != null && effectiveCenterMode(ui.centerMode, activeId) === "board";
  return buildTutorialSnapshot({
    record,
    platform: platform(),
    level: settings.onboarding?.level ?? null,
    workMode: useWorkMode.getState().mode,
    plan: gates ? { teamAllowed: gates.teamAllowed } : null,
    workspaces: { loaded: ws.loaded, list: ws.workspaces },
    activeWorkspaceId: ws.activeId,
    mode: ws.activeId ? effectiveCenterMode(ui.centerMode, ws.activeId) : null,
    overlays: { allSkills: ui.allSkillsOpen, shipBatch: ui.releaseSheet !== null, settings: ui.settingsOverlayOpen },
    ai: { claude: readiness.claude.ready, codex: readiness.codex.ready },
    defaultBuilder: settings.behavior ? newCardBuilderVendor(settings.behavior) : null,
    builderPermissionsAsked: settings.onboarding?.builderPermissionsAsked === true,
    builderPermissions: settings.behavior?.builderPermissions ?? "asks",
    tiles,
    boards: useKanban.getState().byWorkspace,
    present: presenter(cardLiveSourcesNow()),
    tryRuns: useTryRuns.getState().runs,
    guidedCard: guided,
    trySheet: (() => {
      const sheet = useTryRuns.getState().sheet;
      return sheet ? { workspaceId: sheet.card.workspaceId, cardId: sheet.card.id } : null;
    })(),
    trySheetSeen: sheetSeen,
    tried: triedCards,
    tryOpened: openedCards,
    staticSites: staticCards,
    openCardId,
    guidedBoard,
    emptyProject: tourWs ? (emptyByWorkspace.get(tourWs) ?? null) : null,
    buildStart,
    here: {
      tiles: hereTiles,
      libraryPage: activeId ? (useLibrary.getState().byWorkspace[activeId]?.page ?? "skills") : null,
      previewOpen: activeId ? Boolean(ui.codePreviewOpen[activeId]) : false,
      openCard: cardShown ? { id: openCardId, section: ui.cardStep[openCardId] ?? null } : null,
      staticSite: activeId ? staticByWorkspace.get(activeId) === true : false,
      areas: activeId ? pickerShown(useAreas.getState().views[activeId]) : false,
    },
    palette: ui.palette.open ? ui.palette.scope : null,
    // TU-5 Mac re-walk: Finish and check under way (`finishingNow`'s facts).
    finishing: (c) => {
      const b = useBuilder.getState();
      return b.selfCheck[c.id] ? "self-check" : b.doneBusy[c.id] ? "saving" : null;
    },
    // 1.175.0 F5 round 2: the tour's line follows the card's "After a fix round".
    checksByItself: (c) => fixRoundCheckOn(c, useSettings.getState().settings.behavior.checkFixRoundsByItself !== false),
  });
}

/**
 * TU-5: the reads a step needs that no store holds — whether the project has source files yet (B3). Each answers once and
 * schedules another look; none is retried in a loop.
 */
function readsForStep(snap: TutorialSnapshot): void {
  const record = tutorialOf();
  // K3 (TU-7 Mac walk): the Code chapter shown — is this project a plain
  // website? Once per project per launch; a failed read is not asked again.
  const active = snap.activeWorkspaceId;
  if (active && !staticAsked.has(active) && currentChapter(record, snap, useTutorialRuntime.getState().chapter) === "code") {
    staticAsked.add(active);
    void projectTryCommandGet(active)
      .then(
        (view) => {
          staticByWorkspace.set(active, tryRowState(view ?? null).kind === "staticSite");
        },
        () => {},
      )
      .finally(schedule);
  }
  const step = tourView(record, snap, { focus: useTutorialRuntime.getState().focus }).step?.id ?? null;
  if (step !== STEP.newCard && step !== STEP.startBuild) return;
  // §11 (TU-5 Mac walk): the guided card under way in a project whose board
  // is not loaded — read once, so *Continue with* names it, or goes if the
  // card is gone.
  const g = useSettings.getState().settings.onboarding?.firstCard ?? null;
  // Only for a project the list still has (one removed is gone: no read).
  const known = useWorkspaces.getState().workspaces.some((w) => w.id === g?.workspaceId);
  if (step === STEP.newCard && g && !g.endedAt && known && !useKanban.getState().byWorkspace[g.workspaceId]?.loaded) {
    const ask = `${g.workspaceId}::${g.cardId}`;
    if (guidedAsked !== ask) {
      guidedAsked = ask;
      guidedBoard = null;
      // Once: a failed read is not tried again in this launch, and its card
      // is not offered (`buildTutorialSnapshot`).
      void kanbanLoad(g.workspaceId)
        .then(
          (cards) => {
            guidedBoard = { workspaceId: g.workspaceId, cards: Array.isArray(cards) ? cards : null };
          },
          () => {
            guidedBoard = { workspaceId: g.workspaceId, cards: null };
          },
        )
        .finally(schedule);
    }
  }
  const ws = snap.tourWorkspaceId;
  if (step !== STEP.newCard || !ws || emptyAsked.has(ws)) return;
  const cwd = useWorkspaces.getState().workspaces.find((w) => w.id === ws)?.cwd;
  if (!cwd) return;
  emptyAsked.add(ws);
  // Folder by folder, a few at most, stopping at the first source file
  // (Challenger: never a walk of the whole tree on the main thread).
  void projectHasSourceFiles(cwd, (dir) => fsListDir(dir))
    .then(
      (has) => {
        if (has !== null) emptyByWorkspace.set(ws, !has);
      },
      () => {},
    )
    .finally(schedule);
}

/**
 * §4.2: bring a step's control on screen through the existing helpers only.
 * Nothing is pressed and no view is mounted or unmounted. False when there
 * is nowhere to go (no tour workspace, no tour card).
 *
 * `active` (TU-7): an optional chapter's step — its mode and Library page
 * open in the active workspace, wherever the tour card is (`followsActive`).
 */
export function tourNavigate(nav: TourNav, opts: { active?: boolean } = {}): boolean {
  const record = tutorialOf();
  const ws = useWorkspaces.getState();
  // The tour card's workspace, else the active one (the snapshot's rule).
  const bound = tourWorkspace(record, { loaded: ws.loaded, list: ws.workspaces }, ws.activeId);
  const wsId = opts.active ? ws.activeId : bound.workspaceId;
  if ("setup" in nav) {
    useSetup.getState().openSetup("rerun", nav.setup);
    return true;
  }
  if ("card" in nav && nav.card === "any") {
    // TU-7: the card open here, else the tour card where it is, else the
    // Board, where the person opens one. `unbuilt` (1.172.0 walk, E1): only
    // a card not built yet shows the step's control — a shipped card open
    // here gives way to one that isn't built (never a silent no-op).
    const here = ws.activeId;
    if (!here) return false;
    const fits = nav.unbuilt ? unbuiltCard : () => true;
    const board = useKanban.getState().byWorkspace;
    const cardIn = (wsId: string, id: string) => board[wsId]?.cards.find((c) => c.id === id) ?? null;
    const selected = useUi.getState().selectedCardId[here] ?? null;
    const openCard = selected ? cardIn(here, selected) : null;
    const open = selected && (!nav.unbuilt || (openCard && fits(openCard))) ? selected : null;
    const tourCard = bound.bound && bound.workspaceId && record?.cardId ? cardIn(bound.workspaceId, record.cardId) : null;
    const tourFits = Boolean(bound.bound && bound.workspaceId && record?.cardId) && (!nav.unbuilt || (tourCard && fits(tourCard)));
    const other = nav.unbuilt && !open && !tourFits ? (board[here]?.cards.find((c) => fits(c)) ?? null) : null;
    if (open) {
      openCenterMode(here, "board");
      useUi.getState().selectCard(here, open, true);
    } else if (tourFits && bound.workspaceId && record?.cardId) {
      void useWorkspaces.getState().setActive(bound.workspaceId).catch(() => {});
      useUi.getState().selectCard(bound.workspaceId, record.cardId, true);
      openCenterMode(bound.workspaceId, "board");
    } else if (other) {
      openCenterMode(here, "board");
      useUi.getState().selectCard(here, other.id, true);
    } else {
      // No card to open: the Board, where the person opens one. The step's
      // control is not there yet, so this is no missing anchor (§11); the
      // panel says so (`takeMeThereNowhere`).
      if (selected) useUi.getState().selectCard(here, null, false);
      openCenterMode(here, "board");
      return false;
    }
    return true;
  }
  if ("mode" in nav) {
    if (!wsId) return false;
    // TU-4 re-walk: from a card page, Take me there to the Board must leave
    // the card (as the palette's New card does), or the Board stays hidden.
    if (nav.mode === "board") useUi.getState().selectCard(wsId, null, false);
    openCenterMode(wsId, nav.mode);
    return true;
  }
  if ("libraryPage" in nav) {
    if (!wsId) return false;
    openLibraryPage(wsId, nav.libraryPage);
    return true;
  }
  if ("card" in nav && nav.card === "tour-card") {
    // The tour card, in a workspace the list still has (after Ship it a
    // removed one is not sent back to B3, so the record may still name it).
    if (!bound.bound || !bound.workspaceId || !record?.cardId) return false;
    if (nav.step) openCardStep(bound.workspaceId, record.cardId, nav.step);
    else {
      void useWorkspaces.getState().setActive(bound.workspaceId).catch(() => {});
      useUi.getState().selectCard(bound.workspaceId, record.cardId, true);
    }
    return true;
  }
  if ("allSkills" in nav) {
    useUi.getState().setAllSkillsOpen(true);
    return true;
  }
  if ("settings" in nav) {
    useUi.getState().openSettingsSection(nav.settings);
    return true;
  }
  // Take me there: the tour card's workspace (before a card there is
  // nowhere else to be).
  if (!bound.bound || !bound.workspaceId) return false;
  void useWorkspaces.getState().setActive(bound.workspaceId).catch(() => {});
  return true;
}

/** 1.172.0 walk (E1): a card the step's control shows on when it must be
 *  one not built yet — a draft or a ready card, not archived, not a pull
 *  request review (the card page's Plan it first ▾). */
function unbuiltCard(card: KanbanCard): boolean {
  if (card.archived || card.prReview) return false;
  const state = presenter(cardLiveSourcesNow())(card).state;
  return state === "draft" || state === "ready";
}

let started = false;
let stops: (() => void)[] = [];
let busy = false;
let queued = false;
/** The board list a disk read already answered for (the card was there, or
 *  the read failed): not asked again until the list changes. */
let answered: readonly KanbanCard[] | null = null;
/** The snapshot the running tour was last looked at with: a step about
 *  where you are (B2, B6, B7) counts out of order only when it changes
 *  after it (`observeTour`'s `before`). Forgotten when the tour starts over. */
let lastSeen: { startedAt: string | null | undefined; snap: TutorialSnapshot } | null = null;

/** TU-6: while the Quick tour moves the page (its marks open the Board,
 *  Terminals, …), nothing it shows is the member going there: the full
 *  tour does not look, and looks afresh after it (`lastSeen` forgotten).
 *  Set by `quickTourStore.ts`, which imports this module. */
let observationHeld: () => boolean = () => false;
export function holdTourObservationWhile(held: () => boolean): void {
  observationHeld = held;
}
/** TU-6: the hold is over — look now (Challenger: a step that came true
 *  during the minute was otherwise seen only at the next change). */
export function recheckTour(): void {
  schedule();
}
/** TU-6: called before the full tour's panel opens (Help › Getting started,
 *  Resume): the Quick tour gives way. Set by `quickTourStore.ts`. */
let guideOpening: () => void = () => {};
export function beforeGuideOpens(fn: () => void): void {
  guideOpening = fn;
}

const sameTour = (a: TutorialProgress | null, b: TutorialProgress) =>
  a !== null && tourRunning(a) && a.startedAt === b.startedAt && a.cardId === b.cardId && a.workspaceId === b.workspaceId;

function check(): void {
  if (!started || busy) return;
  if (observationHeld()) {
    lastSeen = null;
    return;
  }
  const record = tutorialOf();
  if (!tourRunning(record)) {
    lastSeen = null;
    // Do it now belongs to the tour it was pressed in: an end by any path
    // (End, a reset record) forgets it, so a later start begins at B1. The
    // chapter picked goes with it (TU-7).
    const rt = useTutorialRuntime.getState();
    if (rt.focus != null || rt.chapter != null) useTutorialRuntime.setState({ focus: null, chapter: null });
    return;
  }
  const snap = tutorialSnapshotNow();
  const now = new Date().toISOString();
  const before = lastSeen && lastSeen.startedAt === record.startedAt ? lastSeen.snap : null;
  lastSeen = { startedAt: record.startedAt, snap };
  // Do it now holds until its step is done or skipped again.
  const focus = useTutorialRuntime.getState().focus;
  if (focus && (isDone(record, focus) || isSkipped(record, focus))) useTutorialRuntime.setState({ focus: null });
  const focusNow = useTutorialRuntime.getState().focus;

  if (snap.tourCardGone) {
    const board = record.workspaceId ? useKanban.getState().byWorkspace[record.workspaceId] : undefined;
    if (snap.tourCardGone === "board" && board?.cards === answered) return;
    busy = true;
    // The Board store's list alone is not proof (a failed read leaves it
    // empty; a stale reload can land after the card was made): only a
    // successful read of the disk without it sends the tour back to B3.
    const confirmed: Promise<boolean> =
      snap.tourCardGone === "workspace"
        ? Promise.resolve(true)
        : kanbanLoad(record.workspaceId ?? "").then(
            (cards) => {
              const gone = Array.isArray(cards) && !cards.some((c) => c.id === record.cardId);
              if (!gone) answered = board?.cards ?? null;
              return gone;
            },
            () => {
              answered = board?.cards ?? null;
              return false;
            },
          );
    void confirmed
      .then((gone) => {
        if (!gone || !sameTour(tutorialOf(), record)) return;
        useTutorialRuntime.setState({ cardGone: true, focus: null });
        return writeTutorial((cur) =>
          cur && sameTour(cur, record) ? cardGone(cur) : cur,
        );
      })
      .then(settled, failed);
    return;
  }

  // TU-7: the chapter the panel shows; its current step counts as it is.
  const chapter = currentChapter(record, snap, useTutorialRuntime.getState().chapter);
  const next = observeTour(record, snap, now, { before, focus: focusNow, chapter });
  if (!next) return;
  if (next.cardId && useTutorialRuntime.getState().cardGone) useTutorialRuntime.setState({ cardGone: false });
  busy = true;
  // Applied to the record as it is then, if it is still the tour the
  // snapshot was read for (no Start over, no other card since).
  const same = (cur: TutorialProgress | null) =>
    cur !== null && tourRunning(cur) && cur.startedAt === record.startedAt && cur.cardId === record.cardId;
  void writeTutorial((cur) => (same(cur) ? (observeTour(cur, snap, now, { before, focus: focusNow, chapter }) ?? cur) : cur)).then(
    settled,
    failed,
  );
}

/** A write landed: a change seen while it was under way is looked at again. */
function settled(): void {
  busy = false;
  schedule();
}

/** A write failed: said, and not retried until the stores change again (a
 *  refused save must not spin). */
function failed(e: unknown): void {
  busy = false;
  console.warn("tutorial: not saved", e);
}

/** The snapshot for the panel and the coach-mark: while a full tour runs,
 *  and only once it changes reference (the panel's own reads are cheap). */
function publish(): void {
  if (!started) return;
  noteTryRuns();
  const snapshot = tourRunning(tutorialOf()) ? tutorialSnapshotNow() : null;
  if (snapshot) readsForStep(snapshot);
  const cur = useTutorialRuntime.getState().snapshot;
  if (snapshot === null && cur === null) return;
  useTutorialRuntime.setState({ snapshot });
}

/** Many stores change in one tick: one look per tick. */
function schedule(): void {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    publish();
    check();
  });
}

/** Follow the stores the tour reads (§7). Idempotent; no-op unless a tour
 *  is started and not ended. */
export function startTutorialSubscription(): void {
  if (started) return;
  started = true;
  stops.push(
    useSettings.subscribe(schedule),
    useKanban.subscribe(schedule),
    useWorkspaces.subscribe(schedule),
    useUi.subscribe(schedule),
    useBuilder.subscribe(schedule),
    useBuilderWaiting.subscribe(schedule),
    useCardFacts.subscribe(schedule),
    useTryRuns.subscribe(schedule),
    useAccount.subscribe(schedule),
    useDoctor.subscribe(schedule),
    useWorkMode.subscribe(schedule),
    // TU-7: the optional chapters read the active workspace's sessions
    // (T1) and Library page (L1, L3). Only a change of those is looked at:
    // a tile's output stamps and a Library filter being typed are not.
    useTiles.subscribe(whenChanged(tileKinds)),
    useLibrary.subscribe(whenChanged(libraryPages)),
    // 1.173.0 (B2): the area picker's step shows only with two areas.
    useAreas.subscribe(whenChanged(areaPickers)),
  );
  schedule();
}

/** A listener that schedules a look only when `sig` of the store changes. */
function whenChanged<S>(sig: (state: S) => string): (state: S) => void {
  let last: string | null = null;
  return (state) => {
    const next = sig(state);
    if (next === last) return;
    last = next;
    schedule();
  };
}

const tileKinds = (s: ReturnType<typeof useTiles.getState>): string =>
  Object.entries(s.byWorkspace)
    .map(([ws, w]) => `${ws}:${(w?.tiles ?? []).map((t) => t.kind).join(",")}`)
    .join("|");

const libraryPages = (s: ReturnType<typeof useLibrary.getState>): string =>
  Object.entries(s.byWorkspace)
    .map(([ws, l]) => `${ws}:${l?.page ?? ""}`)
    .join("|");

const areaPickers = (s: ReturnType<typeof useAreas.getState>): string =>
  Object.entries(s.views)
    .filter(([, view]) => pickerShown(view))
    .map(([ws]) => ws)
    .join("|");

/** TU-7 (§3.1): show a chapter's steps — an optional one from *More, when
 *  you're ready*, or the base chapter again. Do it now belongs to the
 *  chapter it was pressed in. */
export function chooseTourChapter(chapter: ChapterId): void {
  useTutorialRuntime.setState({ chapter, focus: null });
  requestFocus("panel");
  schedule();
}

// ── The panel's actions (§9) ─────────────────────────────────────────────
// Each writes the record through `writeTutorial` (spread, never rebuilt).

const nowIso = () => new Date().toISOString();

async function appVersion(): Promise<string> {
  // Off the app (tests, a stubbed smoke) there is no version: the release
  // the tour shipped in stands for it.
  const v = await getVersion().catch(() => null);
  return typeof v === "string" && v ? v : TUTORIAL_SINCE;
}

/** The one way the Guide panel opens (Help › Getting started, Ready's tour
 *  button, Resume): anything the panel must do first on every open goes
 *  here, so a new entry point cannot miss it. */
function showGuidePanel(): void {
  // TU-6: one guide at a time — the Quick tour and a tip give way.
  guideOpening();
  useTutorialRuntime.setState({ panelOpen: true });
  requestFocus("panel");
}

/**
 * Help › Getting started (§3.3, §9): open the Guide panel. A tour under way
 * resumes where it is; an ended one is reopened where it was (End is
 * reversible); none yet starts now. Until B3 takes a card the tour follows
 * the active workspace (TU-5, `tourWorkspace`).
 */
export async function openGuide(): Promise<void> {
  const version = await appVersion();
  const now = nowIso();
  showGuidePanel();
  await writeTutorial((cur) => resumeTour(startFullTour(cur, { now, version })));
}

/**
 * Ready's *Start the tour* / *Resume the tour* (§2, TU-5), once Setup has
 * made its project the active one: a tour that has got somewhere resumes
 * (`tourResumable`, its card's project kept); anything else starts from
 * B1 in Setup's project (`startTourFromSetup`).
 */
export async function startGuideFromSetup(): Promise<void> {
  const version = await appVersion();
  const now = nowIso();
  showGuidePanel();
  if (!tourResumable(tutorialOf())) {
    // A fresh start, as Start over: B1, 0 of 10 (`lastSeen` and Do it now
    // belong to the old start).
    useTutorialRuntime.setState({ cardGone: false, focus: null, chapter: null });
    lastSeen = null;
  }
  await writeTutorial((cur) => resumeTour(startTourFromSetup(cur, { now, version })));
}

/** Pause (the panel's header): only the sidebar row, its Resume focused
 *  (1.174.0, D3b: no pill). */
export function pauseGuide(): Promise<unknown> {
  // F4: the permissions question closed without an answer isn't asked again.
  const open = permissionsQuestionOpen();
  useTutorialRuntime.setState({ panelOpen: false });
  requestFocus("sidebar");
  return Promise.all([
    open ? answerPermissionsQuestion(false) : Promise.resolve(),
    writeTutorial((cur) => (tourRunning(cur) ? pauseTour(cur) : cur)),
  ]);
}

/** 1.175.0 F4: the tour's permissions question is on screen now. */
function permissionsQuestionOpen(): boolean {
  const snap = useTutorialRuntime.getState().snapshot ?? tutorialSnapshotNow();
  return permissionsQuestionShown(tutorialOf(), snap);
}

/** 1.175.0 F4: the answer. "Use this" writes Settings' default for new cards
 *  (`behavior.builderPermissions = "editsCopy"`, the existing field); "Keep
 *  this" — and closing the panel — only record that it was asked. */
export function answerPermissionsQuestion(use: boolean): Promise<unknown> {
  return useSettings.getState().update((cur) => ({
    ...cur,
    onboarding: { ...cur.onboarding, builderPermissionsAsked: true },
    ...(use ? { behavior: { ...cur.behavior, builderPermissions: "editsCopy" as const } } : {}),
  }));
}

/** Resume (the sidebar row, Help › Getting started). */
export function resumeGuide(): Promise<unknown> {
  showGuidePanel();
  return writeTutorial((cur) => (tourRunning(cur) && cur.paused ? resumeTour(cur) : cur));
}

/** An explain step's Start / Next. */
export function completeTourStep(id: string): Promise<unknown> {
  const now = nowIso();
  return writeTutorial((cur) => (tourRunning(cur) ? completeStep(cur, id, now) : cur));
}

/** Skip this step. */
export function skipTourStep(id: string): Promise<unknown> {
  const now = nowIso();
  return writeTutorial((cur) => (tourRunning(cur) ? skipStep(cur, id, now) : cur));
}

/** Skipped · Do it now: the step is to do again, and it is the current one
 *  until it is done or skipped (TU-4 Mac walk). */
export function unskipTourStep(id: string): Promise<unknown> {
  useTutorialRuntime.setState({ focus: id });
  return writeTutorial((cur) => (tourRunning(cur) ? unskipStep(cur, id) : cur));
}

/** ⋯ › Skip chapter. */
export function skipTourChapter(chapter: ChapterId): Promise<unknown> {
  const now = nowIso();
  return writeTutorial((cur) => (tourRunning(cur) ? skipChapter(cur, chapter, now) : cur));
}

/** ⋯ › End the tour: reversible, so no confirm (§9). */
export function endGuide(): Promise<unknown> {
  const now = nowIso();
  useTutorialRuntime.setState({ focus: null, chapter: null });
  return writeTutorial((cur) => (tourRunning(cur) ? endTour(cur, now) : cur));
}

/** ⋯ › Start over: done, skipped, the card and the end go (§9). */
export function startGuideOver(): Promise<unknown> {
  const now = nowIso();
  // A real restart: B1, 0 of 10. The Board already open is not B2 done —
  // the next look starts afresh (`lastSeen` belongs to the old start).
  useTutorialRuntime.setState({ cardGone: false, focus: null, chapter: null });
  lastSeen = null;
  return writeTutorial((cur) => (cur ? startOver(cur, now) : cur));
}

/**
 * B3 (§6.2, §11): this card is the tour's — the safe example just made,
 * or the guided card under way (*Continue with*). Its page opens; the steps it already meets
 * (B4, B5) are marked by the next look.
 */
export async function takeTourCard(workspaceId: string, cardId: string): Promise<void> {
  useTutorialRuntime.setState({ cardGone: false, focus: null });
  await writeTutorial((cur) => (tourRunning(cur) ? withTourCard(cur, workspaceId, cardId) : cur));
  await useWorkspaces.getState().setActive(workspaceId).catch(() => {});
  useUi.getState().selectCard(workspaceId, cardId, true);
}

/**
 * B3's *No idea yet? Use a safe example*: the guided first card (§2, D5) —
 * the README card, its record and its permission rule as Setup makes it —
 * in the tour workspace, then the tour's card.
 */
export async function startSafeExample(): Promise<void> {
  const ws = useWorkspaces.getState();
  // B3: no card yet, so the active workspace (`tourWorkspace`).
  const wsId = tourWorkspace(tutorialOf(), { loaded: ws.loaded, list: ws.workspaces }, ws.activeId).workspaceId;
  if (!wsId) return;
  const card = await startGuidedFirstCard(wsId);
  await takeTourCard(wsId, card.id);
}

/** §9, §11: a step that needs Setup (no AI, no project) sends the user
 *  there; the tour hides while Setup is up and comes back when it closes. */
export function tourFinishSetup(step: "ai" | "project"): void {
  useSetup.getState().openSetup("rerun", step);
}

/** §11: anchors already logged as missing in this launch. */
const missingLogged = new Set<TourAnchor>();

/** §11: an anchor not found on screen after Take me there — a renamed or
 *  moved control. Said once per anchor per launch in the app's log
 *  (Diagnostics › Reveal log folder). */
export function logMissingAnchor(anchor: TourAnchor): void {
  if (missingLogged.has(anchor)) return;
  missingLogged.add(anchor);
  void logWarn(`tour anchor missing: ${anchor}`).catch(() => {});
}

/** Tests: forget the subscription. */
export function stopTutorialForTests(): void {
  for (const stop of stops) stop();
  stops = [];
  started = false;
  busy = false;
  queued = false;
  answered = null;
  lastSeen = null;
  emptyByWorkspace.clear();
  emptyAsked.clear();
  sheetSeen.clear();
  triedCards.clear();
  openedCards.clear();
  staticCards.clear();
  staticByWorkspace.clear();
  staticAsked.clear();
  guidedBoard = null;
  guidedAsked = null;
  sessionSeen.clear();
  missingLogged.clear();
  useTutorialRuntime.setState({ focus: null, chapter: null });
}
