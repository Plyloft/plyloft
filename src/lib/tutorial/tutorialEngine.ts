/**
 * Getting started (docs/tutorial/TUTORIAL_SPEC.md §7, §9, §11): the engine.
 * Pure — no store, no IPC, no DOM — so node runs `src/lib/tutorialEngine.test.ts`.
 * `store/tutorialStore.ts` builds the snapshot from the stores and writes
 * what `observeTour` returns.
 *
 * - Detection is **state, never clicks** (the guided first card's model): a
 *   step is done when its `done(snapshot)` holds. Every step that holds is
 *   recorded when observed, not only the current one (§7).
 * - The current step is the first in path order that is neither done nor
 *   skipped — passing over the steps that never block (B6, B7: offered while
 *   the build runs) and the ones whose moment is gone (`passed`) — except
 *   that an explicit *Do it now* (`focus`) wins until that step is done or
 *   skipped again, B6/B7 and passed steps included (TU-4 Mac walk).
 * - A step about where you are (`visit`: B2, B6, B7) counts out of order
 *   only when it becomes true while the tour runs (`before` → now), never
 *   the place the tour (re)started in; as the current step it counts as it
 *   is (TU-4 Mac walk: Start over on the Board kept B2 done).
 * - Card-bound steps (B4–B10) watch the tour card only. A card deleted (once
 *   the disk says so) or its workspace removed sends the tour back to B3.
 * - The tour has a workspace only once it has a card (`tourWorkspace`):
 *   before that, B2 and B3 count in the active workspace, wherever the user
 *   is now (TU-5 walk: a tour begun in one project, resumed in another).
 * - Every reducer spreads the record (and its maps): keys and step ids a
 *   newer app wrote survive (TU-1, `settings.rs::TutorialProgress.extra`).
 */
import type { CardPresentationState, KanbanCard } from "../../ipc.ts";
import type { CardPageSection, CardPrimaryActionId } from "../cardLifecycle.ts";
import type { LibraryPage } from "../librarySkills.ts";
import type { PresentationRule, SessionFacts } from "../cardPresentation.ts";
import type { BuilderWaitingState } from "../needsYou.ts";
import type { ShipMode } from "../shipVia.ts";
import type { Platform } from "../platform.ts";
import type { AgentVendor } from "../roleModels.ts";
import type { SetupLevel, TutorialProgress, WorkMode } from "../settingsShape.ts";
import type { CenterMode, PaletteScope } from "../../store/uiStore.ts";
import type { TryPhase } from "../tryPanel.ts";
import { cardShippedOrPrOpen } from "../cardLifecycle.ts";
import { FIRST_CARD_TITLE, guidedTaskUnedited, guideStage, tourStartApplies, type GuideStage } from "../firstCardGuide.ts";
import { isSkillCard } from "../skillCards.ts";
import { PROJECT_TRY_ID } from "../tryTile.ts";
import { tryItOffered, tryRunKey } from "../tryPanel.ts";
import {
  ALL_STEPS,
  BRIEF_MIN_CHARS,
  CARD_PRIMARY_FOR,
  CHAPTERS,
  STEP,
  followsActive,
  type AskKind,
  type ChapterId,
  type TutorialStep,
  type WaitReason,
} from "./manifest.ts";

// ── The snapshot (§7) ────────────────────────────────────────────────────

/** The tour card, as the card page presents it. */
export interface TourCardFacts {
  id: string;
  workspaceId: string;
  title: string;
  /** `CardPresentationState`, as every surface reads it. */
  state: CardPresentationState;
  rule: PresentationRule;
  /** `firstCardGuide.ts`'s row for the state. */
  stage: GuideStage;
  /** 0 nothing started, 1 building, 2 checked or changes asked, 3 ready to
   *  ship, 4 landed (or its pull request open); null while it is stopped. */
  rank: number | null;
  /** A Builder has worked on it at some point. */
  started: boolean;
  /** The saved brief (`notes`), trimmed. */
  briefLength: number;
  /** Shipped, or its pull request merged (`cardShippedOrPrOpen`). */
  landed: boolean;
  /** Shipped as a pull request that is still open (§11). */
  prOpen: boolean;
  /** G1 Challenger (10): that pull request merges by itself once its checks
   *  pass (`pr.autoMerge`, read from GitHub). */
  prAutoMerge?: boolean;
  /** 1.171.0 A3: that merge is Plyloft's own (`pr.plyloftAutoMerge`), made
   *  only while Plyloft is open. */
  plyloftMerges?: boolean;
  /** 1.175.0 F5 round 2: a fix round on it is checked by itself. */
  checksByItself?: boolean;
  /** How Ship it ships it, when the card page knows. */
  shipsAs: "merge" | "pr" | null;
  /** The card offers Try it (TRY_IT_SPEC §3.1). */
  tryOffered: boolean;
  /** Its Try it panel says Running (`data-ply-try-phase="running"`). */
  tryRunning: boolean;
  /** B5b: what holds its session (`session-block` / `builder-waiting`). */
  asks: AskKind | null;
  /** The usage limit's reset, when known. */
  resetsAt: string | null;
  /** Who builds it: its session's vendor once started, else its choice. */
  vendor: AgentVendor;
  /** What the Now box's primary (`card-primary`) does now; null unknown. */
  primary: CardPrimaryActionId | null;
  /** TU-5 (§3.1): when its Builder session started (ms), for the live
   *  line's minutes; null before any. */
  buildStartedAt: number | null;
  /** TU-5: *In line* — waiting for a free slot, not worked on yet. */
  queued: boolean;
  /** TU-5 Mac walk: its Builder is really at work now — building, not in
   *  line, not done with its turn (`builder-waiting` stopped) and not held
   *  by a question, a trust or bypass prompt or the usage limit. The live
   *  line and B6/B7's line say *building* only then. Not while Finish and
   *  check is under way (`finishing`). */
  building: boolean;
  /** TU-5 Mac re-walk: Finish and check is under way on it — the Builder's
   *  self-check (ADR 0006: "The Builder is checking its own work"), or the
   *  save and the checks' hand-off ("Saving and checking…"). The card still
   *  says Working then, but nobody is building and the press is made. */
  finishing: FinishingPhase | null;
  /** TU-5 (B9): its Try it, as the card's Try it panel says it (any lane):
   *  running wins; null when it was never pressed in this launch. */
  tryPhase: TryPhase | null;
  /** TU-5 (§6.3): Try it can't start the app — it said Couldn't start, or
   *  the How to start your app sheet was closed with nothing saved. */
  tryFallback: boolean;
  /** TU-5 Mac walk (B9): the How to start your app sheet's *Open index.html*
   *  showed its page in the browser in this launch — the user saw it. */
  tryOpened: boolean;
  /** TU-5 Mac walk (§6.3): the sheet said *This looks like a plain website*
   *  for this card in this launch. */
  staticSite: boolean;
  /** TU-5: the guided first card, its task unedited, while its guide runs:
   *  its page says how its Builder asks (`guidedStartSentence`). */
  guidedUnedited: boolean;
  /** QoL 7.4 (D10): the recorded tour card starts bounded
   *  (`firstCardGuide.ts::tourStartApplies`): its page says the sentence,
   *  and B5 keeps a short note (the line under What you want: leave it). */
  tourBounded?: boolean;
}

/** TU-5 (B11, D24): the second card's checklist, from its state. */
export interface SecondCardFacts {
  id: string;
  workspaceId: string;
  ticks: { title: boolean; brief: boolean; started: boolean; checked: boolean; tried: boolean; shipped: boolean };
}

/** TU-7: the active workspace, as the optional chapters read it — they
 *  follow where the person is, not the tour card (`followsActive`). */
export interface HereFacts {
  /** Its name, for K3's *Try it in lyra*. */
  workspaceName: string | null;
  /** Its tiles, by kind (T1). */
  tiles: Readonly<Record<string, number>>;
  /** The Library page it shows (L1, L3). */
  libraryPage: LibraryPage | null;
  /** Code's localhost preview is open (K2). */
  previewOpen: boolean;
  /** Try it in <project> says Running there (K3). */
  projectTryRunning: boolean;
  /** Try it in <project>'s How to start your app sheet opened index.html
   *  there in this launch (tryRunStore's `indexOpened`, the project's key):
   *  a plain website seen, K3 done as B9 is. */
  projectTryOpened: boolean;
  /** The project is a plain website (K3 explain-only, in its words): its
   *  start-command read says so, or that sheet called it one. */
  projectStaticSite: boolean;
  /** The card page open over its Board, and its open section (P1). */
  openCard: { id: string; section: CardPageSection | null } | null;
  /** 1.173.0 (B2): it has two areas or more — the area picker shows. */
  areas?: boolean;
}

export interface TutorialSnapshot {
  platform: Platform;
  level: SetupLevel | null;
  /** Unknown (null) shows everything (OB-9). */
  workMode: WorkMode | null;
  plan: { teamAllowed: boolean } | null;
  /** The workspace list has loaded. */
  workspacesLoaded: boolean;
  workspaceCount: number;
  activeWorkspaceId: string | null;
  /** The tour card's workspace once B3 has a card (`tourWorkspace`), else
   *  the active one. */
  tourWorkspaceId: string | null;
  tourWorkspaceName: string | null;
  /** The effective centre mode of the active workspace. */
  mode: CenterMode | null;
  overlays: { allSkills: boolean; shipBatch: boolean; settings: boolean };
  /** Which AIs can run here. */
  ai: Record<AgentVendor, boolean>;
  /** TU-5 Windows walk: Settings' default Builder (`behavior.builderVendor`),
   *  the AI a card made now would start with. */
  defaultBuilder: AgentVendor | null;
  /** The tour workspace's tiles, by kind. */
  tiles: Readonly<Record<string, number>>;
  /** The tour card, or the card B3 adopts now (`adopt`). */
  tourCard: TourCardFacts | null;
  /** B3 found the card: the record does not name it yet. */
  adopt: { workspaceId: string; cardId: string } | null;
  /** The record's card is not where it should be: its workspace is gone
   *  (final), or the loaded board lacks it (ask the disk first, §7). */
  tourCardGone: "workspace" | "board" | null;
  /** B11: once the tour card has shipped, another card made since the tour
   *  started has shipped too (or has its pull request open). */
  secondCardLanded: boolean;
  /** 1.175.0 F4: the tour's permissions question was answered or closed
   *  (`onboarding.builderPermissionsAsked`). */
  builderPermissionsAsked: boolean;
  /** F4: Settings' default for new cards (`behavior.builderPermissions`),
   *  for the question's "New cards do this now". */
  builderPermissions: "editsCopy" | "asks" | "neverAsks";
  /** TU-5 (B11): the newest ordinary card made since the start that is not
   *  the tour card, once the tour card has shipped. */
  secondCard: SecondCardFacts | null;
  /** TU-5 (B3, D25): the tour workspace (the active one before a card) has
   *  no source files yet (only a README, a licence or nothing); null while
   *  not read. */
  emptyProject: boolean | null;
  /** TU-5 (B3, §11): the guided first card under way (not the tour card):
   *  *Continue with "Describe this project in the README"*. */
  guidedCard: { workspaceId: string; cardId: string; title: string | null } | null;
  /** TU-5 (B3, Challenger): *Use a safe example* is offered where Setup
   *  would offer the guided first card — no record yet, or one dismissed.
   *  A guided card that shipped is not made a second time (its record would
   *  be overwritten). */
  safeExampleOffered: boolean;
  /** TU-7: the active workspace (the optional chapters). */
  here: HereFacts;
  /** TU-7: Search's palette is open, on this scope (G1, K1); null closed. */
  palette: PaletteScope | null;
  /** TU-5 Mac walk: the tour card's page is on screen — its workspace
   *  active, the Board with that card open, no overlay over it. */
  tourCardOpen: boolean;
}

/** What the card page says about one card (`presentCard` + `cardLiveFrom`). */
export interface TourCardPresentation {
  state: CardPresentationState;
  rule: PresentationRule;
  session: Pick<SessionFacts, "block" | "state"> | null;
  vendor: AgentVendor;
  shipMode?: ShipMode | null;
  /** Where Ship it goes, resolved as the card page resolves it
   *  (`shipItGoesToGitHub`): true on GitHub, false here; null unknown. */
  shipItToGitHub?: boolean | null;
  /** Build with both, no build picked yet (`isUndecided`). */
  undecidedBuildBoth?: boolean;
  /** The Now box's primary action (`presentCard(...).action.id`). */
  primary?: CardPrimaryActionId | null;
  /** `builder-waiting`'s state (`presentCard(...).waiting`): `stopped` is
   *  the Builder done with its turn (B8's moment), not a question. */
  waiting?: BuilderWaitingState | null;
}

export interface Board {
  loaded: boolean;
  cards: readonly KanbanCard[];
}

/** Plain inputs, read from the stores by the caller. */
/** TU-5 Mac re-walk: the phase of a Finish and check under way. */
export type FinishingPhase = "self-check" | "saving";

export interface SnapshotInput {
  record: TutorialProgress | null | undefined;
  platform: Platform;
  level: SetupLevel | null;
  workMode: WorkMode | null;
  plan: TutorialSnapshot["plan"];
  workspaces: { loaded: boolean; list: readonly { id: string; name: string }[] };
  activeWorkspaceId: string | null;
  /** The active workspace's effective mode (`effectiveCenterMode`). */
  mode: CenterMode | null;
  overlays: TutorialSnapshot["overlays"];
  ai: Record<AgentVendor, boolean>;
  defaultBuilder?: AgentVendor | null;
  /** F4: `onboarding.builderPermissionsAsked`; absent: false. */
  builderPermissionsAsked?: boolean;
  /** F4: `behavior.builderPermissions`; absent: "asks". */
  builderPermissions?: "editsCopy" | "asks" | "neverAsks";
  tiles?: Readonly<Record<string, number>>;
  boards: Readonly<Record<string, Board | undefined>>;
  present: (card: KanbanCard) => TourCardPresentation;
  tryRuns: Readonly<Record<string, { phase: TryPhase } | undefined>>;
  /** The guided first card's record (`onboarding.firstCard`). */
  guidedCard?: {
    workspaceId: string;
    cardId: string;
    startedAt?: string | null;
    endedAt?: string | null;
    /** `shipped` | `dismissed` (`FirstCardGuide.outcome`). */
    outcome?: string | null;
  } | null;
  /** TU-5 (§3.1, Challenger): when the tour card's current Builder session
   *  began, for the live line's minutes. A resumed session (after a quit, or
   *  a closed one in this launch) keeps the card's first `startedAt`; the
   *  store says when it first saw this session instead. Absent: the card's
   *  `builder.startedAt`. */
  buildStart?: (card: KanbanCard) => number | null;
  /** TU-5: the How to start your app sheet is open for this card. */
  trySheet?: { workspaceId: string; cardId: string } | null;
  /** TU-5: cards (`workspaceId::cardId`) whose sheet was seen open in this
   *  launch, and cards whose Try it was seen Running (B11's tick). */
  trySheetSeen?: ReadonlySet<string>;
  tried?: ReadonlySet<string>;
  /** TU-5 Mac walk (B9, §6.3): cards whose sheet's *Open index.html* opened
   *  the page in this launch, and cards the sheet called a plain website. */
  tryOpened?: ReadonlySet<string>;
  staticSites?: ReadonlySet<string>;
  /** TU-5 Mac walk: the card open in the active workspace's centre
   *  (`selectedCardId`), if any. */
  openCardId?: string | null;
  /** TU-5 Mac walk (§11): the guided first card's board read from the disk
   *  (`kanban_load`) when it is not loaded in the Board store — its title,
   *  or that it is gone; `cards` null: the read failed, so whether the card
   *  is there is not known and it is not offered (Challenger). */
  guidedBoard?: { workspaceId: string; cards: readonly KanbanCard[] | null } | null;
  /** TU-5 (D25): the tour workspace has no source files; null unknown. */
  emptyProject?: boolean | null;
  /** TU-7: the active workspace's facts the optional chapters read; absent
   *  reads as nothing there. Its name and Try it in <project> come from
   *  `workspaces` and `tryRuns`. */
  here?: Partial<Pick<HereFacts, "tiles" | "libraryPage" | "previewOpen" | "openCard" | "areas">> & {
    /** TU-7 Mac walk (K3): the active project reads as a plain website — no
     *  start command saved and an index.html found (`tryRowState` of
     *  `project_try_command_get`, the Settings row's own reading). */
    staticSite?: boolean;
  };
  /** TU-7: Search's palette, when open. */
  palette?: PaletteScope | null;
  /** TU-5 Mac re-walk: Finish and check under way on a card
   *  (`builderStore`'s `selfCheck`, then `doneBusy`); absent: none. */
  finishing?: (card: KanbanCard) => FinishingPhase | null;
  /** 1.175.0 F5 round 2: whether this card checks a fix round by itself
   *  (`fixRoundCheck.ts::fixRoundCheckOn`); absent: it does (the default). */
  checksByItself?: (card: KanbanCard) => boolean;
}

const NO_TILES: Readonly<Record<string, number>> = {};

/** TU-7 (K3): Try it in <project> says Running in `workspaceId` — the
 *  workspace's own Try session (`PROJECT_TRY_ID`), any lane. */
export function projectTryRunning(tryRuns: SnapshotInput["tryRuns"], workspaceId: string | null): boolean {
  if (!workspaceId) return false;
  const prefix = tryRunKey(workspaceId, PROJECT_TRY_ID, null);
  return Object.entries(tryRuns).some(([key, run]) => key.startsWith(prefix) && run?.phase === "running");
}

/** D25: what counts as a source file for an empty project — anything but a
 *  README, a licence and the like (the walk lists no dotfiles at all). */
const NOT_SOURCE = /^(readme|license|licence|copying|changelog)(\.[\w.-]+)?$/i;
export function hasSourceFiles(paths: readonly string[]): boolean {
  return paths.some((p) => !NOT_SOURCE.test(p.split("/").pop() ?? p));
}

/** One entry of a folder listing (`fs_list_dir`'s `DirEntry`). */
export interface ProbeEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink?: boolean;
}

/** D25 (Challenger): how many folders the empty-project look reads at most.
 *  A new project has a handful; a real one shows a source file in its first
 *  folder or two. Never the whole tree (the 186 GB watcher walk, 2026-10-13). */
export const EMPTY_PROBE_DIRS = 24;

/** Folders the look never enters: build output and package caches (the
 *  file walker's own skip list, `files.rs`). Hidden ones are not listed. */
const PROBE_SKIP = new Set(["node_modules", "target", "dist", "build", "__pycache__"]);

/**
 * D25: whether the project at `root` has a source file — anything but a
 * README, a licence or a changelog — looking folder by folder (breadth
 * first) and stopping at the first one found. More folders than
 * `EMPTY_PROBE_DIRS` is plenty: not empty. Null when `root` can't be read.
 */
export async function projectHasSourceFiles(
  root: string,
  list: (dir: string) => Promise<readonly ProbeEntry[]>,
  budget: number = EMPTY_PROBE_DIRS,
): Promise<boolean | null> {
  const queue = [root];
  let reads = 0;
  while (queue.length > 0) {
    if (reads >= budget) return true;
    const dir = queue.shift()!;
    let entries: readonly ProbeEntry[];
    try {
      entries = await list(dir);
    } catch {
      if (dir === root) return null;
      continue;
    } finally {
      reads += 1;
    }
    if (!Array.isArray(entries)) {
      if (dir === root) return null;
      continue;
    }
    for (const e of entries) {
      if (e.isSymlink || e.name.startsWith(".")) continue;
      if (!e.isDir) {
        if (!NOT_SOURCE.test(e.name)) return true;
      } else if (!PROBE_SKIP.has(e.name)) {
        queue.push(e.path);
      }
    }
  }
  return false;
}

/** A card's key in `trySheetSeen` / `tried`. */
export const cardKey = (workspaceId: string, cardId: string): string => `${workspaceId}::${cardId}`;

const RANK: Record<GuideStage, number | null> = {
  brief: 0,
  ready: 0,
  running: 1,
  checks: 2,
  changes: 2,
  ship: 3,
  shipped: 4,
  stopped: null,
};

function isoMs(at: string | null | undefined): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

function asksOf(p: TourCardPresentation): AskKind | null {
  // `stopped`: its turn is over and Finish and check is the primary — B8,
  // not a question (TU-5).
  if (p.rule === "builder-waiting") return p.waiting === "stopped" ? null : "waiting";
  if (p.rule !== "session-block") return null;
  const block = p.session?.block;
  if (!block) return "waiting";
  return block.kind;
}

/** How the card ships, by where it goes. G1: Ship it on GitHub opens a pull
 *  request too; Ship it that lands here (no GitHub, or the project set to
 *  Only on this Mac) is a local merge. */
function shipsAsOf(p: TourCardPresentation, prOpen: boolean): "merge" | "pr" | null {
  if (prOpen || p.shipMode === "pr" || p.shipMode === "pr_only") return "pr";
  if (p.shipMode === "merge_live") return "merge";
  if (p.shipMode === "ship_it") return p.shipItToGitHub === true ? "pr" : p.shipItToGitHub === false ? "merge" : null;
  return null;
}

/** The facts of one card for the tour. */
export function tourCardFacts(
  card: KanbanCard,
  p: TourCardPresentation,
  tryRuns: SnapshotInput["tryRuns"],
  more: Pick<SnapshotInput, "trySheet" | "trySheetSeen" | "guidedCard" | "buildStart" | "tryOpened" | "staticSites" | "finishing" | "checksByItself"> = {},
): TourCardFacts {
  const landed = cardShippedOrPrOpen(card);
  const prOpen = Boolean(card.prUrl) && card.pr?.state === "open";
  const stage = landed ? "shipped" : guideStage(p.state);
  const rank = landed || prOpen ? 4 : RANK[stage];
  // Every lane of the card's copy: `tryRunKey` with no lane is the prefix.
  const prefix = tryRunKey(card.workspaceId, card.id, null);
  const phases = Object.entries(tryRuns)
    .filter(([key, run]) => key.startsWith(prefix) && run != null)
    .map(([, run]) => run!.phase);
  const tryRunning = phases.includes("running");
  const tryPhase: TryPhase | null = tryRunning ? "running" : (phases[0] ?? null);
  const key = cardKey(card.workspaceId, card.id);
  const sheetOpen = more.trySheet?.workspaceId === card.workspaceId && more.trySheet.cardId === card.id;
  const sheetClosedUnsaved = !sheetOpen && (more.trySheetSeen?.has(key) ?? false) && (tryPhase == null || tryPhase === "stopped");
  const guide = more.guidedCard;
  const guidedUnedited =
    guide != null && !guide.endedAt && guide.cardId === card.id && guide.workspaceId === card.workspaceId &&
    guidedTaskUnedited(card) && !card.buildBoth && !card.prReview;
  const block = p.session?.block;
  const asks = asksOf(p);
  const tryOpened = more.tryOpened?.has(key) ?? false;
  // Only on a card still at work: once its checks run (or it landed) its
  // own state says so.
  const finishing = stage === "running" && !landed && !prOpen ? (more.finishing?.(card) ?? null) : null;
  return {
    id: card.id,
    workspaceId: card.workspaceId,
    title: card.title,
    state: p.state,
    rule: p.rule,
    stage,
    rank,
    started: (rank ?? 0) >= 1 || card.builder != null || card.lastRunStatus != null,
    briefLength: (card.notes ?? "").trim().length,
    landed,
    prOpen,
    prAutoMerge: prOpen && (card.pr?.autoMerge === true || card.pr?.plyloftAutoMerge === true),
    plyloftMerges: prOpen && card.pr?.plyloftAutoMerge === true,
    checksByItself: more.checksByItself ? more.checksByItself(card) : true,
    shipsAs: shipsAsOf(p, prOpen),
    tryOffered: tryItOffered(card, p.state, p.undecidedBuildBoth ?? false),
    tryRunning,
    asks,
    resetsAt: block?.kind === "usageLimit" ? block.resetsAt : null,
    vendor: p.vendor,
    primary: p.primary ?? null,
    buildStartedAt: more.buildStart ? more.buildStart(card) : card.builder?.startedAt ? card.builder.startedAt : null,
    queued: p.state === "queued",
    building:
      stage === "running" && !landed && !prOpen && p.state !== "queued" && asks == null && p.rule !== "builder-waiting" &&
      finishing == null,
    finishing,
    tryPhase,
    tryFallback: !tryOpened && (tryPhase === "failed" || sheetClosedUnsaved),
    tryOpened,
    staticSite: more.staticSites?.has(key) ?? false,
    guidedUnedited,
  };
}

/** A card B3 may take: an ordinary card, not archived, made since `since`. */
function adoptable(card: KanbanCard, since: number): boolean {
  return card.createdAt >= since && !card.archived && !card.prReview && !isSkillCard(card);
}

/**
 * The card B3 takes: the guided first card when it was made for this tour
 * (its own workspace may be another one), else the first card made in the
 * tour workspace since the tour started.
 */
function findAdoption(
  input: SnapshotInput,
  tourWs: string | null,
  since: number,
): { workspaceId: string; card: KanbanCard } | null {
  const guided = input.guidedCard;
  if (guided && !guided.endedAt && (isoMs(guided.startedAt) ?? -1) >= since) {
    const card = input.boards[guided.workspaceId]?.cards.find((c) => c.id === guided.cardId);
    if (card) return { workspaceId: guided.workspaceId, card };
  }
  const scan = tourWs ? [tourWs] : Object.keys(input.boards);
  let best: { workspaceId: string; card: KanbanCard } | null = null;
  for (const ws of scan) {
    const board = input.boards[ws];
    if (!board?.loaded) continue;
    for (const card of board.cards) {
      if (!adoptable(card, since)) continue;
      if (!best || card.createdAt < best.card.createdAt) best = { workspaceId: ws, card };
    }
  }
  return best;
}

/**
 * TU-5 (§7, §8.1): the workspace the tour is bound to — its card's, once B3
 * has one (`workspaceId` with `cardId`). Before a card the tour belongs to
 * no workspace and follows the active one: B2 and B3 count there, B3 takes
 * a card made there and the empty-project look read it. A
 * record that names a workspace without a card (one written before TU-5,
 * or by Start over then) is read the same way. A card's workspace the
 * loaded list no longer has is gone (the card with it, §7): the active one
 * stands in.
 */
export function tourWorkspace(
  record: Pick<TutorialProgress, "workspaceId" | "cardId"> | null | undefined,
  workspaces: { loaded: boolean; list: readonly { id: string }[] },
  activeWorkspaceId: string | null,
): { workspaceId: string | null; bound: boolean; gone: boolean } {
  const ws = record?.cardId ? (record.workspaceId ?? null) : null;
  if (!ws) return { workspaceId: activeWorkspaceId, bound: false, gone: false };
  const gone = workspaces.loaded && !workspaces.list.some((w) => w.id === ws);
  return gone ? { workspaceId: activeWorkspaceId, bound: false, gone: true } : { workspaceId: ws, bound: true, gone: false };
}

/** The snapshot, from plain inputs. */
export function buildTutorialSnapshot(input: SnapshotInput): TutorialSnapshot {
  const record = input.record ?? null;
  const bound = tourWorkspace(record, input.workspaces, input.activeWorkspaceId);
  const recordWsGone = bound.gone;
  let tourWs = bound.workspaceId;
  const since = isoMs(record?.startedAt);

  let tourCard: TourCardFacts | null = null;
  let adopt: TutorialSnapshot["adopt"] = null;
  let gone: TutorialSnapshot["tourCardGone"] = null;
  const cardId = record?.cardId ?? null;
  // Once Ship it is recorded the loop is complete: a card deleted after that
  // (or its workspace removed) takes nothing back (§7 is about the steps
  // still to come).
  const shipDone = record?.done?.[STEP.ship] != null;
  if (cardId && record?.workspaceId) {
    const ws = record.workspaceId;
    if (recordWsGone) {
      gone = shipDone ? null : "workspace";
    } else {
      const board = input.boards[ws];
      const card = board?.cards.find((c) => c.id === cardId);
      if (card) {
        tourCard = tourCardFacts(card, input.present(card), input.tryRuns, input);
        // QoL 7.4 (D10): the recorded tour card starts in the bounded mode
        // while the tour is still on it, by the same test the start uses.
        if (tourStartApplies(record, ws, card, false)) tourCard = { ...tourCard, tourBounded: true };
      } else if (board?.loaded && !shipDone) gone = "board";
    }
  } else if (!cardId && since != null) {
    const found = findAdoption(input, tourWs, since);
    if (found) {
      adopt = { workspaceId: found.workspaceId, cardId: found.card.id };
      tourCard = tourCardFacts(found.card, input.present(found.card), input.tryRuns, input);
      // The card taken binds the tour to its workspace (the guided card's
      // may be another one).
      tourWs = found.workspaceId;
    }
  }
  const tourWsName = input.workspaces.list.find((w) => w.id === tourWs)?.name ?? null;

  // B11: once the tour card has shipped (as the card reads now, or as the
  // record says — the card may have been deleted since), another ordinary
  // card made since the start that has shipped too, B10's rule (a pull
  // request open counts, §11). Which of the two shipped first is not asked.
  let secondCardLanded = false;
  let secondCard: SecondCardFacts | null = null;
  const tourShipped = shipDone || tourCard?.landed === true || tourCard?.prOpen === true;
  const isTourCard = (c: KanbanCard) =>
    (tourCard != null && c.id === tourCard.id && c.workspaceId === tourCard.workspaceId) ||
    (cardId != null && c.id === cardId && c.workspaceId === record?.workspaceId);
  if (since != null && tourShipped) {
    // B11's checklist follows the newest ordinary card made since the start.
    let newest: KanbanCard | null = null;
    for (const board of Object.values(input.boards)) {
      if (!board?.loaded) continue;
      for (const c of board.cards) {
        if (isTourCard(c) || !adoptable(c, since)) continue;
        if (!newest || c.createdAt > newest.createdAt) newest = c;
      }
    }
    if (newest) {
      const f = tourCardFacts(newest, input.present(newest), input.tryRuns, input);
      const shipped = f.landed || f.prOpen;
      secondCard = {
        id: newest.id,
        workspaceId: newest.workspaceId,
        ticks: {
          title: newest.title.trim().length > 0,
          brief: f.briefLength >= BRIEF_MIN_CHARS || f.started,
          started: f.started,
          checked: (f.rank ?? 0) >= 2,
          tried: f.tryRunning || (input.tried?.has(cardKey(newest.workspaceId, newest.id)) ?? false),
          shipped,
        },
      };
    }
    for (const board of Object.values(input.boards)) {
      if (!board?.loaded) continue;
      if (
        board.cards.some(
          (c) =>
            !isTourCard(c) &&
            c.createdAt >= since &&
            !c.prReview &&
            !isSkillCard(c) &&
            (cardShippedOrPrOpen(c) || (Boolean(c.prUrl) && c.pr?.state === "open")),
        )
      ) {
        secondCardLanded = true;
        break;
      }
    }
  }

  // §11: the guided first card under way, not the tour card — B3's
  // *Continue with "Describe this project in the README"*.
  // TU-5 Mac walk: its board may not be loaded (its project not opened in
  // this launch): then the disk read stands in, and before that read the
  // offer is made in general words (`title` null). A card known gone is not
  // offered; the safe example is, as for no guide at all.
  let guidedCard: TutorialSnapshot["guidedCard"] = null;
  let guidedGone = false;
  const g = input.guidedCard;
  if (g && !g.endedAt && !(tourCard && tourCard.id === g.cardId && tourCard.workspaceId === g.workspaceId)) {
    const stored = input.boards[g.workspaceId];
    const read = input.guidedBoard?.workspaceId === g.workspaceId ? input.guidedBoard : null;
    const board = stored?.loaded ? stored : read?.cards ? { loaded: true, cards: read.cards } : null;
    const wsKnown = !input.workspaces.loaded || input.workspaces.list.some((w) => w.id === g.workspaceId);
    if (!wsKnown) {
      guidedGone = true;
    } else if (!board && read) {
      // Its board couldn't be read: not offered, and not a second README
      // card either (it may well be there).
    } else if (board) {
      const found = board.cards.find((c) => c.id === g.cardId);
      if (found && !cardShippedOrPrOpen(found) && !found.archived) {
        guidedCard = { workspaceId: g.workspaceId, cardId: g.cardId, title: found.title || FIRST_CARD_TITLE };
      } else if (!found) {
        guidedGone = true;
      }
    } else {
      guidedCard = { workspaceId: g.workspaceId, cardId: g.cardId, title: null };
    }
  }
  const tourCardOpen =
    tourCard != null &&
    input.activeWorkspaceId === tourCard.workspaceId &&
    input.mode === "board" &&
    input.openCardId === tourCard.id &&
    !input.overlays.allSkills &&
    !input.overlays.settings &&
    !input.overlays.shipBatch;

  return {
    platform: input.platform,
    level: input.level,
    workMode: input.workMode,
    plan: input.plan,
    workspacesLoaded: input.workspaces.loaded,
    workspaceCount: input.workspaces.list.length,
    activeWorkspaceId: input.activeWorkspaceId,
    tourWorkspaceId: tourWs,
    tourWorkspaceName: tourWsName,
    mode: input.mode,
    overlays: input.overlays,
    ai: input.ai,
    defaultBuilder: input.defaultBuilder ?? null,
    tiles: input.tiles ?? {},
    tourCard,
    adopt,
    tourCardGone: gone,
    secondCardLanded,
    builderPermissionsAsked: input.builderPermissionsAsked ?? false,
    builderPermissions: input.builderPermissions ?? "asks",
    secondCard,
    emptyProject: input.emptyProject ?? null,
    guidedCard,
    safeExampleOffered:
      !g || (Boolean(g.endedAt) && g.outcome === "dismissed") || (guidedGone && g.outcome !== "shipped"),
    tourCardOpen,
    here: {
      workspaceName: input.workspaces.list.find((w) => w.id === input.activeWorkspaceId)?.name ?? null,
      tiles: input.here?.tiles ?? NO_TILES,
      libraryPage: input.here?.libraryPage ?? null,
      previewOpen: input.here?.previewOpen ?? false,
      projectTryRunning: projectTryRunning(input.tryRuns, input.activeWorkspaceId),
      projectTryOpened: input.activeWorkspaceId
        ? (input.tryOpened?.has(cardKey(input.activeWorkspaceId, PROJECT_TRY_ID)) ?? false)
        : false,
      projectStaticSite: input.activeWorkspaceId
        ? input.here?.staticSite === true ||
          (input.staticSites?.has(cardKey(input.activeWorkspaceId, PROJECT_TRY_ID)) ?? false)
        : false,
      openCard: input.here?.openCard ?? null,
      areas: input.here?.areas ?? false,
    },
    palette: input.palette ?? null,
  };
}

// ── Reading the record ───────────────────────────────────────────────────

/** A full tour is under way: started and not ended. A paused tour still is. */
export function tourRunning(record: TutorialProgress | null | undefined): record is TutorialProgress {
  return Boolean(record?.startedAt) && !record?.endedAt;
}

/** TU-5 (§2): a full tour under way on this card — the guided first card's
 *  callout stands aside (one guide at a time). */
export function tourOnCard(record: TutorialProgress | null | undefined, workspaceId: string, cardId: string): boolean {
  return tourRunning(record) && record.cardId === cardId && record.workspaceId === workspaceId;
}

export function isDone(record: TutorialProgress | null | undefined, id: string): boolean {
  return record?.done?.[id] != null;
}

export function isSkipped(record: TutorialProgress | null | undefined, id: string): boolean {
  return record?.skipped?.[id] != null;
}

/** §4.1 audience: unknown solo/team shows everything (OB-9). */
export function stepApplies(step: TutorialStep, s: TutorialSnapshot): boolean {
  const a = step.audience;
  if (!a) return true;
  if (a.level && s.level && a.level !== s.level) return false;
  if (a.mode && s.workMode && a.mode !== s.workMode) return false;
  if (a.plan === "team" && s.plan && !s.plan.teamAllowed) return false;
  // G3 (D17): only while one AI is missing — not with both, and not with
  // none (Setup's own business).
  if (a.ai === "one" && s.ai.claude === s.ai.codex) return false;
  // 1.173.0 (B2): the area picker's step, only where the picker shows.
  if (a.areas && !s.here?.areas) return false;
  return true;
}

/** The step's moment is gone: it is not the one the tour waits on, though
 *  it stays "to do" in the list (B4 once the build began, B9 once shipped). */
function passed(step: TutorialStep, s: TutorialSnapshot, record: TutorialProgress | null | undefined): boolean {
  // Ship it recorded: every card step left is past (the card may be gone).
  if (step.cardBound && step.id !== STEP.ship && isDone(record, STEP.ship)) return true;
  const card = s.tourCard;
  if (!card) return false;
  if (step.id === STEP.brief) return card.started;
  if (step.id === STEP.tryIt) return card.landed || card.prOpen;
  return false;
}

/** B6/B7: offered beside the current step while the build runs. */
function asideOffered(s: TutorialSnapshot): boolean {
  return s.tourCard?.stage === "running";
}

export interface TourView {
  /** The step the tour waits on; null when the chapter is complete. */
  step: TutorialStep | null;
  /** B5b, shown over everything while the card's session is held. */
  interrupt: { step: TutorialStep; kind: AskKind; resetsAt: string | null } | null;
  /** B6/B7 offered now (while the build runs). */
  aside: TutorialStep[];
  /** What the step waits on other than its own action. */
  wait: WaitReason | null;
  /** "4 of 10": the counted steps done, and how many there are. */
  doneCount: number;
  total: number;
}

/** The steps of a chapter that apply here, in path order. */
export function chapterSteps(chapter: ChapterId, s: TutorialSnapshot): TutorialStep[] {
  return ALL_STEPS.filter((st) => st.chapter === chapter && stepApplies(st, s));
}

/**
 * Where the tour is (§7, §9, §11). `cardGone`: the store just sent the tour
 * back to B3 because its card is gone (said once, in memory). `focus`: the
 * step *Do it now* was last pressed on (in memory); it is the current step
 * while it is still to do — neither done nor skipped — even a step offered
 * beside the current one (B6, B7) or one whose moment is gone.
 */
export function tourView(
  record: TutorialProgress | null | undefined,
  s: TutorialSnapshot,
  opts: { chapter?: ChapterId; cardGone?: boolean; focus?: string | null } = {},
): TourView {
  const steps = chapterSteps(opts.chapter ?? "base", s);
  const counted = steps.filter((st) => st.counted);
  const doneCount = counted.filter((st) => isDone(record, st.id)).length;
  const open = (st: TutorialStep) => !isDone(record, st.id) && !isSkipped(record, st.id);

  const focused = opts.focus
    ? steps.find(
        (st) =>
          st.id === opts.focus && st.kind !== "interrupt" && st.kind !== "checklist" && st.kind !== "question" && open(st),
      )
    : undefined;
  // F4: a question is the panel's own, never the step the tour points at.
  const step =
    focused ??
    steps.find((st) => st.kind !== "interrupt" && st.kind !== "question" && !st.aside && open(st) && !passed(st, s, record)) ??
    null;
  const aside = asideOffered(s) ? steps.filter((st) => st.aside && open(st) && st !== step) : [];

  const card = s.tourCard;
  // B5b holds the tour card's session whichever chapter is shown (TU-7).
  const ask = ALL_STEPS.find((st) => st.kind === "interrupt" && stepApplies(st, s));
  const interrupt =
    tourRunning(record) && ask && card?.asks ? { step: ask, kind: card.asks, resetsAt: card.resetsAt } : null;

  return { step, interrupt, aside, wait: step ? waitFor(step, s, opts.cardGone ?? false, record?.cardId != null) : null, doneCount, total: counted.length };
}

function waitFor(step: TutorialStep, s: TutorialSnapshot, cardGone: boolean, named: boolean): WaitReason | null {
  // TU-7: an optional chapter's step is wherever the person is. It needs a
  // workspace only to open one of its places (All skills, Search, Settings
  // and Setup work with none).
  if (followsActive(step)) {
    const nav = step.navigate;
    const inWorkspace = nav != null && ("mode" in nav || "libraryPage" in nav || "card" in nav);
    return inWorkspace && s.workspacesLoaded && s.workspaceCount === 0 ? "no-workspace" : null;
  }
  if (s.workspacesLoaded && s.workspaceCount === 0) return "no-workspace";
  // B2/B3 count where the tour is (§6.2): before a card that is the active
  // workspace, so this waits only once a card binds the tour elsewhere (a
  // step done again with *Do it now*). Elsewhere, Take me there.
  if (!step.cardBound && step.navigate && "mode" in step.navigate && s.tourWorkspaceId && s.activeWorkspaceId !== s.tourWorkspaceId) {
    return "other-workspace";
  }
  if (step.id === STEP.newCard) {
    if (cardGone) return "card-gone";
    return null;
  }
  const card = s.tourCard;
  if (!step.cardBound) return null;
  // A card step made current with no card yet (B3 skipped, Do it now). A
  // card the record names whose board has not loaded yet is not "no card".
  if (!card) return named ? null : "no-card";
  if (s.activeWorkspaceId !== card.workspaceId) return "other-workspace";
  if (step.id === STEP.startBuild && !card.started && !s.ai[card.vendor]) return "ai-not-ready";
  if (card.landed || card.prOpen) return null;
  if (card.stage === "changes") return card.checksByItself === false ? "changes-requested-press" : "changes-requested";
  if (card.stage === "stopped") return "stopped";
  // TU-4 Mac walk: what comes first, by the card's own state — never a
  // pointer at a button that says something else.
  // 1.171.0 C1 (CF5, Challenger 4): a card with only its title shows Start
  // build — B5 points at it; only a card still being planned waits.
  if (step.id === STEP.startBuild)
    return card.stage === "brief" && !card.started && card.primary !== "start-build" ? "brief-first" : null;
  if (AFTER_BUILD.has(step.id) && !card.started) return "build-not-started";
  // TU-4 walk: a card in line is not being worked on yet (primary See the
  // queue): it waits for a slot, not for the Builder.
  if (step.id === STEP.finishCheck && card.queued) return "queued";
  // TU-5 Mac walk: held by a question, a prompt or the usage limit, B5b
  // says what to do; "still working" would say the opposite.
  if (step.id === STEP.finishCheck && card.asks != null) return null;
  // TU-5 Mac re-walk: Finish and check was pressed — its self-check or its
  // save runs; B8 says so, never "press Finish and check" again.
  if (step.id === STEP.finishCheck && card.finishing != null) return "checking";
  if (step.id === STEP.finishCheck && card.stage === "running" && card.primary != null && card.primary !== "finish-and-check") {
    return "still-building";
  }
  // §6.2 B9: shown once the card offers Try it.
  if (step.id === STEP.tryIt && !card.tryOffered && (card.rank ?? 0) >= 2) return "try-not-yet";
  if (step.id === STEP.ship && (card.rank ?? 0) < 3) return "not-checked";
  return null;
}

/** The steps that need the build to have begun (B6–B10). */
const AFTER_BUILD: ReadonlySet<string> = new Set([
  STEP.watchTerminals,
  STEP.whatCodeIs,
  STEP.finishCheck,
  STEP.tryIt,
  STEP.ship,
]);

/**
 * The coach-mark may point at the step's control as it is now: always, but
 * for `card-primary`, whose words follow the card's state — then only while
 * it is the action the step asks for (`CARD_PRIMARY_FOR`). An unknown
 * primary (null) is not held against it.
 */
export function pointable(step: TutorialStep, s: TutorialSnapshot): boolean {
  if (step.anchor !== "card-primary") return true;
  const want = CARD_PRIMARY_FOR[step.id];
  const primary = s.tourCard?.primary ?? null;
  if (!want || primary == null) return true;
  return want.includes(primary);
}

/**
 * The earlier snapshot knew where the user was for this step: the workspaces
 * had loaded, a mode was shown, and (a card step) the tour card was read. A
 * fact that only looks new because the stores were still loading — the
 * Board open at launch, its card's board read later — is not the user going
 * there (TU-4 Mac walk Challenger: a relaunch on the Board marked B2).
 */
function placeKnown(before: TutorialSnapshot, step: TutorialStep): boolean {
  if (!before.workspacesLoaded || before.activeWorkspaceId == null || before.mode == null) return false;
  return !step.cardBound || before.tourCard != null;
}

// ── Reducers over the record (§9) ────────────────────────────────────────
// Each returns a new record, spread from the old one; never rebuilt.

type Progress = TutorialProgress;
const base = (r: Progress | null | undefined): Progress => ({ ...(r ?? {}) });

/** A workspace named without a card binds nothing (`tourWorkspace`): it is
 *  dropped rather than kept (TU-5). */
const unboundWorkspace = (cur: Progress): Partial<Progress> =>
  !cur.cardId && cur.workspaceId != null ? { workspaceId: null } : {};

/**
 * Start the full tour (Help › Getting started, Ready's *Resume the tour*).
 * A tour under way just shows again; an ended one is reopened where it was
 * (End is reversible, §9). The first start records `startedVersion` (§12.2).
 * No workspace is recorded: the tour follows the active one until B3 takes
 * a card (`tourWorkspace`), and keeps the card's once it has one.
 */
export function startFullTour(r: Progress | null | undefined, at: { now: string; version: string }): Progress {
  const cur = base(r);
  if (cur.startedAt) {
    return { ...cur, path: "full", paused: false, endedAt: null, ...unboundWorkspace(cur) };
  }
  return {
    ...cur,
    startedAt: at.now,
    startedVersion: cur.startedVersion ?? at.version,
    path: "full",
    ...unboundWorkspace(cur),
    paused: false,
    endedAt: null,
  };
}

/**
 * TU-5 (§2, §9): Ready offers *Resume the tour* — rather than *Start the
 * tour* — only for a tour under way that has got somewhere: a card taken,
 * or a step past B1 done or skipped. Anything less starts afresh.
 */
export function tourResumable(r: Progress | null | undefined): boolean {
  if (!tourRunning(r)) return false;
  if (r.cardId) return true;
  const past = (m: Record<string, string> | undefined) => Object.keys(m ?? {}).some((id) => id !== STEP.howItWorks);
  return past(r.done) || past(r.skipped);
}

/**
 * TU-5 (§2): Ready's tour button, in Setup's project (Ready makes it the
 * active one first). *Resume the tour* (`tourResumable`) carries on where
 * it is — a card under way in another project stays there (its steps say
 * *This step is in …*). *Start the tour* starts from B1: a first start, or
 * Start over of a record that has not got anywhere or has ended — never a
 * reopened tour bound to an earlier project.
 */
export function startTourFromSetup(r: Progress | null | undefined, at: { now: string; version: string }): Progress {
  if (tourResumable(r) || !r?.startedAt) return startFullTour(r, at);
  return startOver(r, at.now);
}

/** The 1-minute tour: it records only which tour was last started. */
export function startQuickTour(r: Progress | null | undefined): Progress {
  return { ...base(r), path: "quick" };
}

export function pauseTour(r: Progress | null | undefined): Progress {
  return { ...base(r), paused: true };
}

export function resumeTour(r: Progress | null | undefined): Progress {
  return { ...base(r), paused: false };
}

/** *End the tour*: reversible, so no confirm (§9). */
export function endTour(r: Progress | null | undefined, now: string): Progress {
  const cur = base(r);
  return cur.endedAt ? cur : { ...cur, endedAt: now, paused: false };
}

/** An explain step's Next (B1's Start), or any step marked by hand. The
 *  first time is kept. */
export function completeStep(r: Progress | null | undefined, id: string, now: string): Progress {
  const cur = base(r);
  if (cur.done?.[id] != null) return cur;
  return { ...cur, done: { ...cur.done, [id]: now } };
}

/** *Skip this step*. */
export function skipStep(r: Progress | null | undefined, id: string, now: string): Progress {
  const cur = base(r);
  if (cur.skipped?.[id] != null || cur.done?.[id] != null) return cur;
  return { ...cur, skipped: { ...cur.skipped, [id]: now } };
}

/** *Skipped · Do it now*: the step is to do again. */
export function unskipStep(r: Progress | null | undefined, id: string): Progress {
  const cur = base(r);
  if (cur.skipped?.[id] == null) return cur;
  const skipped = { ...cur.skipped };
  delete skipped[id];
  return { ...cur, skipped };
}

/** *Skip chapter*: every step of it not done or skipped yet. */
export function skipChapter(r: Progress | null | undefined, chapter: ChapterId, now: string): Progress {
  const cur = base(r);
  const skipped = { ...cur.skipped };
  for (const st of ALL_STEPS) {
    if (st.chapter !== chapter || st.kind === "interrupt") continue;
    if (cur.done?.[st.id] != null || skipped[st.id] != null) continue;
    skipped[st.id] = now;
  }
  return { ...cur, skipped };
}

/**
 * *Start over*: done, skipped, the card, its workspace and the end go; the
 * version seen, the tips switch, the sections seen and the version started
 * on stay. The tour starts again now, in the active workspace (TU-5), so B3
 * looks for a card made from now on, not the old one.
 */
export function startOver(r: Progress | null | undefined, now: string): Progress {
  return {
    ...base(r),
    done: {},
    skipped: {},
    cardId: null,
    workspaceId: null,
    endedAt: null,
    paused: false,
    startedAt: now,
    path: "full",
  };
}

/** B3's card (a new card, the safe example, or *Use that card*). */
export function withTourCard(r: Progress | null | undefined, workspaceId: string, cardId: string): Progress {
  return { ...base(r), workspaceId, cardId };
}

/** The steps that belong to the tour card, B3 included: what a card gone
 *  takes back. */
const CARD_STEPS: ReadonlySet<string> = new Set([
  STEP.newCard,
  ...ALL_STEPS.filter((st) => st.cardBound).map((st) => st.id),
]);

/**
 * The tour card is gone (deleted, or its workspace removed): back to B3
 * (§7). The card's steps are to do again; the others, and every id this
 * build doesn't know, stay. Its workspace goes with it, whether the card
 * or the workspace was removed: B3 follows the active workspace again
 * (TU-5).
 */
export function cardGone(r: Progress | null | undefined): Progress {
  const cur = base(r);
  const keep = (m: Record<string, string> | undefined) =>
    Object.fromEntries(Object.entries(m ?? {}).filter(([id]) => !CARD_STEPS.has(id)));
  return {
    ...cur,
    cardId: null,
    workspaceId: null,
    done: keep(cur.done),
    skipped: keep(cur.skipped),
  };
}

/**
 * What the snapshot changes in the record, or null for nothing: B3's card
 * adopted, and every step whose `done` holds recorded (out of order too).
 * Explain steps wait for their button; B5b is never recorded. No-op unless
 * a tour is running.
 */
export function observeTour(
  r: Progress | null | undefined,
  s: TutorialSnapshot,
  now: string,
  opts: {
    /** The snapshot this tour was last looked at with (same `startedAt`);
     *  null for the first look since it started, started over or launched. */
    before?: TutorialSnapshot | null;
    /** *Do it now*'s step (in memory), as `tourView` takes it. */
    focus?: string | null;
    /** TU-7: the chapter the panel shows (`currentChapter`); its current
     *  step counts as it is, as the base chapter's does. */
    chapter?: ChapterId | null;
  } = {},
): Progress | null {
  if (!r || !tourRunning(r)) return null;
  let next: Progress = r;
  if (s.adopt && !r.cardId) next = withTourCard(next, s.adopt.workspaceId, s.adopt.cardId);
  const done: Record<string, string> = { ...next.done };
  const currents = new Set<string>();
  const baseCurrent = tourView(r, s, { focus: opts.focus }).step?.id;
  if (baseCurrent) currents.add(baseCurrent);
  if (opts.chapter && opts.chapter !== "base") {
    const shown = tourView(r, s, { chapter: opts.chapter, focus: opts.focus }).step?.id;
    if (shown) currents.add(shown);
  }
  const before = opts.before ?? null;
  let marked = false;
  for (const st of ALL_STEPS) {
    if (st.kind === "explain" || st.kind === "interrupt") continue;
    if (done[st.id] != null || !stepApplies(st, s)) continue;
    if (st.cardBound && !s.tourCard) continue;
    // TU-7: an optional chapter's step counts only while its chapter is
    // shown — opening the Inbox during the first card is not the Inbox
    // chapter begun, and a chapter is never Done unread.
    if (followsActive(st) && st.chapter !== opts.chapter) continue;
    // Where you are counts out of order only as a fresh change (§7, TU-4).
    if (st.visit && !currents.has(st.id) && !(before != null && placeKnown(before, st) && !st.done(before))) continue;
    if (st.done(s)) {
      done[st.id] = now;
      marked = true;
    }
  }
  if (marked) next = { ...next, done };
  return next === r ? null : next;
}

// ── Chapters (§6.1, TU-7) ────────────────────────────────────────────────

export interface ChapterProgress {
  id: ChapterId;
  title: string;
  /** Its steps that apply here (the team chapter has none in solo). */
  total: number;
  done: number;
  /** Done or skipped. */
  closed: number;
  /** Every step done or skipped. */
  complete: boolean;
}

/** How far a chapter has come, from the record (B5b and B11 aside: the
 *  base chapter counts its ten). */
export function chapterProgress(
  record: TutorialProgress | null | undefined,
  s: TutorialSnapshot,
  chapter: ChapterId,
): ChapterProgress {
  const c = CHAPTERS.find((ch) => ch.id === chapter);
  const steps = chapterSteps(chapter, s).filter((st) => st.counted);
  const done = steps.filter((st) => isDone(record, st.id)).length;
  const closed = steps.filter((st) => isDone(record, st.id) || isSkipped(record, st.id)).length;
  return { id: chapter, title: c?.title ?? chapter, total: steps.length, done, closed, complete: closed === steps.length };
}

/** The optional chapters that apply here, in §6.1's order (the team chapter
 *  only in team mode, or while the mode is unknown). */
export function optionalChapters(s: TutorialSnapshot): ChapterId[] {
  return CHAPTERS.filter((c) => c.id !== "base" && chapterSteps(c.id, s).length > 0).map((c) => c.id);
}

/**
 * TU-7 (§3.1, §9): the chapter the panel shows — the one the person picked
 * (in memory), while it applies here; else the base chapter. A launch shows
 * the base chapter, the list below it saying how far each chapter got
 * (*1 of 3*): the panel never moves to a chapter on its own.
 */
export function currentChapter(
  _record: TutorialProgress | null | undefined,
  s: TutorialSnapshot,
  chosen: ChapterId | null | undefined,
): ChapterId {
  if (chosen && (chosen === "base" || optionalChapters(s).includes(chosen))) return chosen;
  return "base";
}
