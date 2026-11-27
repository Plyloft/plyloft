// App root: warms workspaces, wires global IPC/shortcuts, and renders the workspace shell.
import { useCompare } from "./store/compareStore";
import { COMPARE_PASS_EVENT } from "./components/CompareBar";
import { PutOnGithubHost } from "./components/PutOnGithubSheet";
import { sharedFirstToasts, sharingToasts, type SharedFirst, type SharingNote } from "./lib/sharedSetup";
import { useEffect, useRef, useState, startTransition } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { error as logError } from "@tauri-apps/plugin-log";
import { ToastStack } from "./components/ToastStack";
import { ConfirmSheetHost } from "./components/ConfirmSheetHost";
import { RepairSheetHost } from "./components/RepairSheet";
import { SettingConflictHost } from "./components/SettingConflictHost";
import { onDirectionForConflicts, onRefreshForConflicts } from "./store/settingConflictStore";
import { NiDirectionSheetHost } from "./components/NiDirectionSheet";
import { AdoptDirectionSheetHost } from "./components/settings/AdoptDirectionSheet";
import { WindowsCloseSheet } from "./components/WindowsCloseSheet";
import { QuitGuardSheet } from "./components/QuitGuardSheet";
import { FolderChangesSheet } from "./components/FolderChangesSheet";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { runHelpAction } from "./components/tutorial/HelpMenu";
import { LegacyInstallPrompt } from "./components/LegacyInstallPrompt";
import { CommandPalette } from "./components/CommandPalette";
import { NewWorkspaceShell } from "./components/NewWorkspaceShell";
import { SetupOverlay } from "./components/SetupOverlay";
import { useSignedInToast } from "./components/setup/SignInStep";
import { startAccountListeners, startPlanGates } from "./store/accountStore";
import { SettingsOverlay } from "./components/SettingsOverlay";
import { InstalledSelfCheckObserver } from "./components/InstalledSelfCheckObserver";
import { ReleaseSheet } from "./components/ReleaseSheet";
import { linkDidNotOpen } from "./lib/linkToast";
import { useWorkspaces } from "./store/workspaceStore";
import { noteDefinitionRead, readDefinition } from "./store/definitionReadStore";
import { forgetFolderChanges } from "./store/folderChanges";
import { useEditor } from "./store/editorStore";
import { useAgents } from "./store/agentStore";
import {
  useSettings,
  startSettingsSubscription,
} from "./store/settingsStore";
import { useIdentity } from "./store/identityStore";
import { setupIsOpen, useSetup } from "./store/setupStore";
import { closedOnboarding, knownStepId, launchCase, setupAutoOpens, stampsWithoutOpening } from "./lib/setupSteps";
import {
  effectiveCenterMode,
  openCenterMode,
  openLibraryPage,
  toggleSidebar,
  goToCenterMode,
  useUi,
  type CenterMode,
  type PaletteScope,
} from "./store/uiStore";
import { learnKeyboardLayout, matchShortcut, noteTypedKey, type ShortcutId } from "./lib/shortcuts";
import { isQuitChord, isWindows } from "./lib/platform";
import { ShortcutsSheet } from "./components/ShortcutsSheet";
import { HistoryItemSheet } from "./components/HistoryItemSheet";
import { AddProjectSheetHost } from "./components/AddProjectSheet";
import { leavePage } from "./lib/leaveGuard";
import { visibleModalOpen } from "./lib/visibleModal";
import { closeEditorTab, saveActiveFile, saveAllInWorkspace } from "./lib/editorSave";
import { closeTabAction, saveKeyAction } from "./lib/editorKeys";
import { useColorScheme } from "./hooks/useColorScheme";
import { usePageVisible } from "./hooks/usePageVisible";
import { dismissToast, pushToast } from "./store/toastStore";
import { sayProjectListNotice } from "./lib/unreadableNotices";
import { releasedByPollerWords } from "./lib/shipDone";
import { installHeldAfter, useChecksConsent } from "./store/checksConsentStore";
import { InstallConsentSheet } from "./components/InstallConsentSheet";
import {
  watchWorkspace,
  unwatchWorkspace,
  onWindowDrop,
  onWorkspaceActivated,
  onAgentRunDone,
  onAgentRunStarted,
  onWriterQueueChanged,
  onReleasePrReleased,
  openWebLink,
  shipReleaseInstall,
  agentRunGet,
  workspaceDefinitionOpenPullRequest,
  onWorkspaceDefinitionRefreshed,
  onWorkspaceDefinitionEdited,
  onNiDirection,
  onMenuShortcuts,
  onMenuHelp,
} from "./ipc";
import { maybeNotifyRunDone } from "./lib/agentNotifier";
import { createWaitingNotifier } from "./store/waitingNotifier";
import { workspaceHasLiveSession, workspacesToEvict } from "./lib/warmedEviction";
import { startTileSubscriptions, useTiles } from "./store/tileStore";
import { sayUnreadableBoardsAtLaunch, startKanbanSubscriptions, useKanban } from "./store/kanbanStore";
import { startSwarmSubscriptions, useSwarms } from "./store/swarmStore";
import { startInboxSubscriptions, useInbox } from "./store/inboxStore";
import { startSkillsHubSubscriptions } from "./store/skillsHubStore";
import { startAllSkillsSubscriptions } from "./store/allSkillsStore";
import { startBranchCleanupSubscriptions } from "./store/branchCleanupStore";
import { startWorkModeSubscription, useWorkMode } from "./store/workModeStore";
import { feedForMode } from "./lib/inboxView";
import { foldWaitingIntoCardRows, reconcileFeed } from "./lib/inboxReconcile";
import { cardRowsSeenOnScreen, tilesSeenOnScreen } from "./lib/seenOnScreen";
import { onScreenNow } from "./store/onScreen";
import { useTileSeen } from "./store/tileSeenStore";
import { createCardNotifier } from "./store/cardNotifier";
import { flushNotifyGate } from "./store/notifyGate";
import { startNotifyTargets } from "./store/notifyTargetOpen";
import { startSignInReads } from "./store/signInReads";
import { startPrAutoFix } from "./store/prAutoFixStore";
import { startFixRound } from "./store/fixRoundStore";
import { startPrDraftEarly } from "./store/prDraftEarlyStore";
import { startSentToGitHub } from "./store/sentToGitHubStore";
import { cardLiveSourcesNow, liveInboxCards } from "./hooks/useCardLive";
import { waitingCardKeys } from "./hooks/useNeedsYou";
import { startSetupFinishSubscription } from "./store/setupFinishStore";
import { startFirstCardGuideSubscription } from "./store/firstCardGuideStore";
import { startFirstShipWatch } from "./store/firstShipWatch";
import { startTutorialSubscription } from "./store/tutorialStore";
import { TutorialLayer } from "./components/tutorial/TutorialLayer";
import { QuickTourLayer } from "./components/tutorial/QuickTourLayer";
import { HelpSheets } from "./components/tutorial/HelpSheets";
import { startTourTipsSubscription } from "./store/quickTourStore";
import { startHelp } from "./store/helpStore";
import { startTileTitles } from "./store/tileTitles";
import { startBuilderAtDone } from "./store/builderAtDone";
import { startReopenOffers } from "./store/reopenStore";
import { TILE_CHORDS, tileChordAction } from "./lib/tileChords";
import {
  currentTileId,
  focusActivePane,
  focusAdjacentTile,
  openDefaultTile,
  openNewTile,
  openResume,
  requestCloseCurrentTile,
  toggleExpandTile,
} from "./store/tileActions";
import { startProposalSubscriptions } from "./store/proposalStore";
import {
  startCoordinationSubscription,
  useCoordination,
} from "./store/coordinationStore";
import { useLicense } from "./store/licenseStore";
import { startDoctorSubscriptions, useDoctor } from "./store/doctorStore";
import { startCodexUpdateSubscription } from "./lib/codexUpdate";
import { startCliSeenSubscription } from "./lib/cliSeen";
import { attentionCounts, waitingSessions } from "./lib/needsYou";
import { finishingNow, useBuilderWaiting } from "./store/builderWaitingStore";
import { listenForSweptIntakes, pollEndedIntakes, stoppedIntakesNow } from "./store/intakeEnded";
import { followPlanExchanges, usePlanExchange } from "./store/planExchangeStore";
import { requestBoardNewTask } from "./lib/boardCommands";
import {
  DefinitionRefreshScheduler,
  definitionChangeToasts,
  DefinitionStatusTracker,
  publishToasts,
  waitingToastStep,
  withWorkspaceName,
} from "./lib/definitionRefresh";
import { libraryToasts, promotionInvalidations } from "./lib/sharedLibrary";
import { useMemory } from "./store/memoryStore";
import { useLibrary } from "./store/libraryStore";
import { observeLibraryRefusal, useErrorBlocks } from "./store/errorBlockStore";
import { dropEndedBuilderSessions, pollSessionBlocks, useBuilder } from "./store/builderStore";
import { failure, type Failure } from "./lib/failure";
import { FailureText } from "./components/ux/FailureText";
import { Icon } from "./components/ux/Icon";
import { pushErrorToast } from "./lib/errorToast";
import "./App.css";
import "./components/shell.css";

/**
 * v1.17.0 (Cycle E.5): hard cap on warmed-workspace count. When the user
 * activates a workspace that would push `warmed.size` past this cap, the
 * least-recently-active warmed workspace evicts: its file watcher stops
 * and its per-workspace UI components unmount (which kills their xterm
 * PTYs via `Terminal.tsx`'s mount/unmount lifecycle, per CLAUDE.md). The
 * active workspace is never evicted, and neither is one with a live session
 * (`lib/warmedEviction.ts`): when every warmed workspace is live, the set
 * exceeds the cap — memory, rather than someone's running work. Hardcoded for v1; promote to a
 * `BehaviorSetting` later if real users want it tunable.
 */
const WARMED_CAP = 8;

/** UX-3.6: ⌘K / ⌘P toggle the one search surface on their scope; pressed
 *  while it shows another scope, they switch to theirs. */
function togglePalette(scope: PaletteScope) {
  const ui = useUi.getState();
  if (ui.palette.open && ui.palette.scope === scope) ui.closePalette();
  else ui.openPalette(scope);
}

/** One for the app's life: it remembers which sessions were already waiting,
 *  across the badge tick's restarts on a visibility flip. */
const notifyNewlyWaiting = createWaitingNotifier();
/** QoL 1.168 (F3): the same, for the cards that need their person. */
const notifyCardsNeedingYou = createCardNotifier();

/** QoL 1.168 (F6): card rows already sent as seen by the open card page —
 *  the frontend's own rows are not in the store's feed, so its optimistic
 *  stamp misses them until the next refresh. */
const cardRowsSentSeen = new Set<string>();

/** QoL 1.168 (Challenger 4): a run some card is linked to, now or in its
 *  history (a loaded board's). */
function runBelongsToCard(runId: string): boolean {
  for (const board of Object.values(useKanban.getState().byWorkspace)) {
    for (const c of board?.cards ?? []) {
      if (c.linkedRunId === runId || c.runHistory?.some((r) => r.runId === runId)) return true;
    }
  }
  return false;
}

/** WALKFIX-3 (item 4): per workspace, the "Waiting for pull request #N"
 *  toast on screen (`waitingToastStep`). */
const waitingToasts = new Map<string, { number: number; id: string }>();

function App() {
  useColorScheme();
  // v1.63.0: window visibility — drives the dock-badge cadence below.
  const visible = usePageVisible();
  // v1.101.x: the dependency doctor and app shell share one executable
  // snapshot. A successful "Look again" must reveal provider tile actions
  // immediately instead of leaving this tree on its startup-only value.
  const env = useDoctor((s) => s.env);
  const refreshEnv = useDoctor((s) => s.refreshEnv);
  const [error, setError] = useState<Failure | null>(null);
  const [warmed, setWarmed] = useState<Set<string>>(new Set());
  const [installedSelfCheckOpen, setInstalledSelfCheckOpen] = useState(false);
  // v1.17.0 (Cycle E.5): per-workspace last-active timestamp for LRU
  // eviction. Ref-based so the read path inside the warmed setter is
  // never stale (React state batching could otherwise hide a just-set
  // timestamp from the same effect's setWarmed callback).
  const lastActiveAtRef = useRef<Record<string, number>>({});
  // v1.31.0: ids whose agent/kanban/swarm stores have already been loaded.
  // The warmed-refresh effect below uses this to refetch only *newly*-warmed
  // workspaces instead of re-running the IPC fan-out for every warmed
  // workspace on every `warmed`/`workspaces`/`cwdMissing` change (an IPC
  // burst that piled onto the switch). Ids drop out when un-warmed so a
  // re-warm reloads fresh state.
  const refreshedRef = useRef<Set<string>>(new Set());
  // OB-4 review: onboard.sh's one-shot welcome toast waits for the launch
  // decision about Setup, and is dropped when Setup opened — Setup is the
  // welcome then, and the toast would sit over it pointing at a sidebar the
  // person cannot reach. `null` = not answered / not decided yet.
  const welcomePendingRef = useRef<boolean | null>(null);
  const setupOpenedAtLaunchRef = useRef<boolean | null>(null);
  const flushWelcome = useRef(() => {
    const show = welcomePendingRef.current;
    const setupOpened = setupOpenedAtLaunchRef.current;
    if (show === null || setupOpened === null) return;
    welcomePendingRef.current = false;
    if (show && !setupOpened) {
      pushToast({
        kind: "info",
        title: "Welcome — your workspaces are ready",
        body: "Open one from the sidebar to get started.",
      });
    }
  }).current;

  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);
  const cwdMissing = useWorkspaces((s) => s.cwdMissing);
  const refresh = useWorkspaces((s) => s.refresh);

  // Refs for stable access inside the global keydown listener
  const workspacesRef = useRef(workspaces);
  const activeIdRef = useRef(activeId);
  const envRef = useRef(env);
  workspacesRef.current = workspaces;
  activeIdRef.current = activeId;
  envRef.current = env;

  // v1.82.0 (Part 2 P2-4): the sidebar's Search row opens the palette via
  // a custom event; v1.83.0 (P2-5): the Code opener's "Go to file…" does
  // the same for Quick Open. UX-3.6: both land on the one ⌘K surface, on
  // their scope.
  useEffect(() => {
    const onOpenPalette = () => {
      if (!visibleModalOpen()) useUi.getState().openPalette("commands");
    };
    const onOpenQuick = () => {
      if (!visibleModalOpen()) useUi.getState().openPalette("files");
    };
    window.addEventListener("ply:open-palette", onOpenPalette);
    window.addEventListener("ply:open-quickopen", onOpenQuick);
    return () => {
      window.removeEventListener("ply:open-palette", onOpenPalette);
      window.removeEventListener("ply:open-quickopen", onOpenQuick);
    };
  }, []);

  // N14 walk F14: an intake the idle sweeper closed says so wherever its
  // card shows, not only on a card page open at the time.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let gone = false;
    listenForSweptIntakes()
      .then((un) => {
        if (gone) un();
        else unlisten = un;
      })
      .catch(() => {});
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  // Plan with two AIs: every card's open or paused exchange, for the Board,
  // the card's Now and the Inbox — read at launch, then kept by its events.
  useEffect(() => followPlanExchanges(), []);

  useEffect(() => {
    refreshEnv().catch((e) => setError(failure("Plyloft couldn't check which tools are installed.", e)));
    refresh().catch((e) => setError(failure("Plyloft couldn't load your workspaces.", e)));
    useSettings.getState().load().catch(() => {});
    startSettingsSubscription().catch(() => {});
    // v1.49.0 (Team Mode Phase 0): one-time identity fetch. Backend
    // backfilled it from `git config --global user.email` on startup;
    // we just cache the cached value in the React tree for downstream
    // consumers (future PR-claim guards, "Logged in as X" UI).
    void useIdentity.getState().load();
    // v1.61.0 (Phase 5 — onboarding): one-shot welcome toast. The backend
    // `.setup` drain leaves a `welcome_pending` sentinel when
    // scripts/onboard.sh pre-registered workspaces this launch; this command
    // consumes it (returns true at most once). Best-effort — never blocks.
    // OB-4: shown by `flushWelcome` once the launch decision about Setup is
    // made, and only when Setup did not open.
    invoke<boolean>("onboarding_take_welcome")
      .then((show) => {
        welcomePendingRef.current = Boolean(show);
        flushWelcome();
      })
      .catch(() => {});
    // 1.175.0 (R3): a project list that couldn't be read no longer stops
    // the launch; Plyloft starts with no projects and says so once.
    void sayProjectListNotice();
    // Round 4 (T1): and every board whose file couldn't be read, also the
    // board of a project that isn't opened this session.
    void sayUnreadableBoardsAtLaunch();
    // Wire tile lifecycle (agent run-started/done + pty-exit) to the tile store
    // Kanban: subscribe once to agent run-done so cards auto-advance
    // even when their workspace isn't currently active.
    startKanbanSubscriptions();
    startDoctorSubscriptions();
    // 1.176.0 R5: the automatic Codex update's start, end and notice.
    startCodexUpdateSubscription();
    // 1.176.1: a Claude Code or Codex that changed under the person, said once.
    startCliSeenSubscription();
    // v1.0: Swarm — live-tail `swarm://mailbox` events so the Swarm
    // tab updates without polling.
    void startSwarmSubscriptions();
    // v1.65.0 (UX revamp step 1): Inbox feed — startup fetch (sidebar
    // badges need it before the tab is ever opened) + debounced refetch
    // on kanban://changed and agent://run-done.
    startInboxSubscriptions();
    // QoL 1.168 (F5): a click on a notification opens what it is about.
    startNotifyTargets();
    // 1.172.0 B2: a card's "sign in again" clears at once after a sign-in.
    startSignInReads();
    // G7: Fix failing checks by itself follows the cards whose switch is on.
    startPrAutoFix();
    startFixRound();
    startPrDraftEarly();
    startSentToGitHub();
    // Skills hub H2: the team library's "Updated …" record, and the toast a
    // background pull raises when someone else changed a skill.
    startSkillsHubSubscriptions();
    // Skills hub H7: the index's stream; no folder is read at launch.
    startAllSkillsSubscriptions();
    // N18 (M3): the card-branch cleanup's asks count in the sidebar too.
    startBranchCleanupSubscriptions();
    // GH #104: the improvement proposal feeds the Library page, the Inbox row and
    // the card's Ship step, so its one subscription lives here and not in a mode.
    startProposalSubscriptions();
    void startCoordinationSubscription().catch((e) =>
      console.error("startCoordinationSubscription failed:", e),
    );
    // v1.85.0: a stored key, reported by the Licence part (launch G3: it
    // unlocks nothing).
    void useLicense.getState().refresh();
    // Launch A2: the Plyloft account (optional since 1.178.0, A3);
    // `account://changed` (a refresh, a session ended) keeps it current.
    void startAccountListeners().catch((e) => console.error("startAccountListeners failed:", e));
    // Launch G1–G3: the plan gates — team locks —
    // from first paint, and again whenever the account or the team changes
    // (the backend is the actual gate).
    startPlanGates();
    // OB-9 (onboarding §10): solo or team, read once and asked again whenever
    // the settings, the boards or the key move.
    startWorkModeSubscription();
    // OB-15 (onboarding §9.1): the facts behind "Setup isn't finished · Finish"
    // and the header's sidebar dot, read again as they change.
    startSetupFinishSubscription();
    // OB-16 (onboarding §14): the guided first card shipped, or deleted.
    startFirstCardGuideSubscription();
    // 1.174.0 (A6, D2c): the first card shipped on this Mac, so Next
    // improvement shows by itself from then on.
    startFirstShipWatch();
    // Getting started (TUTORIAL_SPEC §7, TU-4): the tour's detection and the
    // snapshot its panel and coach-mark draw from. Idle unless a tour runs.
    startTutorialSubscription();
    // TU-6 (§6.5): the first-visit tips follow the section on screen.
    startTourTipsSubscription();
    // TU-8 (§12.2): the version, and a new install's stamp.
    startHelp();
    // Terminals block P2: Claude/Codex tiles take their conversation's name.
    startTileTitles();
    // QoL 1.168 (block 4, D11): what was open when Plyloft quit, offered.
    startReopenOffers();
    // G11 (1.170.0): a card's Builder session closes at Done (its pull
    // request merged), with Undo.
    startBuilderAtDone();
    startTileSubscriptions(async (runId, agentId, workspaceId) => {
      try {
        const run = await agentRunGet(runId);
        // Look up the agent's display name from agentStore (or fallback to run.agentName)
        const ws = useAgents.getState().byWorkspace[workspaceId];
        const agent = ws?.agents.find((a) => a.id === agentId) ?? null;
        const cwd =
          useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId)
            ?.cwd ?? "";
        return {
          run,
          agentName: agent?.name ?? run.agentName,
          cwd,
        };
      } catch (err) {
        console.error("resolveAgent for tile failed:", err);
        return null;
      }
    }).catch((e) => console.error("startTileSubscriptions failed:", e));
  }, [refresh, refreshEnv]);

  // Track warmed workspaces (per-app-launch) so their state survives switches.
  // v1.17.0 (Cycle E.5): also tracks LRU timestamps and evicts the least-
  // recently-active warmed workspace when warming would push the set past
  // WARMED_CAP.
  useEffect(() => {
    if (!activeId) return;
    lastActiveAtRef.current[activeId] = Date.now();
    // v1.31.0: warming a not-yet-warmed workspace mounts its entire
    // per-workspace subtree (a fresh TileGrid + card host + CodeMirror
    // host + xterm instances) in one React commit — a single large
    // synchronous render that froze the main thread and showed the macOS
    // beachball on the first switch to any workspace. Marking the `warmed`
    // update as a transition lets React render that heavy subtree off the
    // click's critical path (interruptible, time-sliced) instead of in one
    // blocking commit. The urgent `activeId` change still flips the sidebar
    // + skeleton on the click frame; NewWorkspaceShell shows a lightweight
    // skeleton while the transition is in flight (activeId set, not yet in
    // `warmed`). LRU eviction stays inside the same updater.
    startTransition(() => {
      setWarmed((s) => {
        if (s.has(activeId)) return s;
        const next = new Set(s);
        // Never a workspace with a live session: evicting unmounts its
        // hosts, which kills its PTYs. All live → none leaves and the set
        // grows past the cap (lib/warmedEviction.ts).
        const tiles = useTiles.getState().byWorkspace;
        const builders = useBuilder.getState().byCard;
        const evict = workspacesToEvict({
          warmed: next,
          activating: activeId,
          cap: WARMED_CAP,
          lastActiveAt: lastActiveAtRef.current,
          isLive: (id) => workspaceHasLiveSession(id, tiles, builders),
        });
        for (const lruId of evict) {
          next.delete(lruId);
          // Stop the evicted workspace's file watcher. PTYs die naturally
          // when the per-workspace components unmount via the warmed map
          // (Terminal.tsx kills its PTY on unmount, per CLAUDE.md) — which
          // is why a live one is never picked.
          unwatchWorkspace(lruId).catch(() => {});
          forgetFolderChanges(lruId);
          delete lastActiveAtRef.current[lruId];
        }
        next.add(activeId);
        return next;
      });
    });
  }, [activeId]);

  // Start a file-watcher for each newly-warmed workspace
  useEffect(() => {
    for (const id of warmed) {
      const ws = workspaces.find((w) => w.id === id);
      if (!ws) continue;
      if (cwdMissing[id]) continue;
      watchWorkspace(id, ws.cwd).catch(() => {});
    }
  }, [warmed, workspaces, cwdMissing]);

  // GH #79: the shared workspace definition (`.atelier/workspace.json`) is
  // read from the integration branch when a workspace warms and every ten
  // minutes while it stays warmed; Sync and Start build read it in the
  // backend. Whatever a refresh replaced on this Mac is announced. Settings ›
  // Project opening and Team's "Read it again" read it too (definitionReadStore).
  const definitionSchedulerRef = useRef<DefinitionRefreshScheduler | null>(
    null,
  );
  useEffect(() => {
    const scheduler = new DefinitionRefreshScheduler((id, moment) => {
      void readDefinition(id, moment, { quiet: true });
    });
    definitionSchedulerRef.current = scheduler;
    // Last Doctor-relevant status seen per workspace: an error fixed back to
    // the last good values, or pending edits published, change no field.
    const status = new DefinitionStatusTracker();
    const unlisten = onWorkspaceDefinitionRefreshed((report) => {
      noteDefinitionRead(report);
      // 1.173.0 walk: every warmed workspace refreshes, so the toasts say
      // which one when more than one is open.
      const open = useWorkspaces.getState().workspaces;
      const named = <T extends { title: string }>(toasts: T[]) => withWorkspaceName(toasts, report.workspaceId, open);
      // Owner, 2026-11-10: a teammate's Share it again says what changed in
      // its own toast, once — not as well in the read's change toasts.
      const sharedAgain = (report as typeof report & { sharing?: SharingNote | null }).sharing?.kind === "sharedAgain";
      if (!sharedAgain) for (const toast of named(definitionChangeToasts(report))) pushToast(toast);
      // GH #80: what publishing a local edit did.
      // WALKFIX-3 (item 4): the waiting toast once per pull request, gone
      // once the queue settled it.
      const step = waitingToastStep(waitingToasts.get(report.workspaceId)?.number ?? null, report);
      const before = waitingToasts.get(report.workspaceId);
      if (step.dismiss && before) dismissToast(before.id);
      if (step.shown == null) waitingToasts.delete(report.workspaceId);
      for (const { waitingFor, ...toast } of named(publishToasts(report))) {
        if (waitingFor == null) {
          pushToast(toast);
        } else if (step.push) {
          waitingToasts.set(report.workspaceId, { number: waitingFor, id: pushToast(toast) });
        }
      }
      // 1.175.0 (C1): sharing stopped, or its pull request was closed.
      for (const toast of named(sharingToasts(report as typeof report & { sharing?: SharingNote | null }))) {
        pushToast(toast);
      }
      // 1.175.0 (C4): this computer's creation pull request wasn't needed.
      const firstReport = report as typeof report & { publish?: { sharedFirst?: SharedFirst | null } | null };
      for (const { pullRequest, url, ...toast } of named(sharedFirstToasts(firstReport))) {
        pushToast({
          ...toast,
          // C4 round 2: one that isn't ours here opens its own recorded address.
          ...(url
            ? { action: { label: "Open pull request", onClick: () => void openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e))) } }
            : {}),
          ...(pullRequest != null
            ? {
                action: {
                  label: "Open pull request",
                  onClick: () =>
                    void workspaceDefinitionOpenPullRequest(report.workspaceId, pullRequest).catch((e) =>
                      pushToast({ kind: "warn", title: `Couldn't open pull request #${pullRequest}`, details: String(e) }),
                    ),
                },
              }
            : {}),
        });
      }
      // 1.173.0 (C3): a shared setting both sides changed asks, if the
      // person is here; the Inbox row waits otherwise.
      onRefreshForConflicts(report);
      // GH #82: shared notes and project skills — from other Macs, and
      // what this Mac published.
      //
      // GH #160: a toast about a pull request carries it, and the action is wired
      // here — `libraryToasts` is a function of the report and holds no callback.
      for (const { pullRequest, ...toast } of libraryToasts(report)) {
        pushToast(
          pullRequest
            ? {
                ...toast,
                action: {
                  label: "Open pull request",
                  onClick: () =>
                    void workspaceDefinitionOpenPullRequest(
                      report.workspaceId,
                      pullRequest.number,
                    ).catch((e) =>
                      pushToast({
                        kind: "warn",
                        title: `Couldn't open pull request #${pullRequest.number}`,
                        details: String(e),
                      }),
                    ),
                },
              }
            : toast,
        );
      }
      // GH #102: the one refusal in there that needs doing — a push the
      // branch refused with no pull request possible — becomes a block on the
      // Library page instead, and goes when a later report is clean.
      observeLibraryRefusal(report.workspaceId, report.moment, report.library);
      // GH #96: a skill a teammate removed on the branch. Once the mirror has
      // dropped it, this report is the only record that it went and who took
      // it, so the Library's row can say the copy here is the last one — and any
      // later report that it is back forgets that (review 1: the row used to say
      // "Removed" for the rest of the session).
      for (const update of report.library?.updates ?? []) {
        if (update.kind !== "skill") continue;
        const library = useLibrary.getState();
        if (update.action === "removed") {
          library.noteRemovedUpstream(report.workspaceId, {
            name: update.name,
            author: update.author,
            // GH #144: and when it landed on the branch, so the row says the age.
            changedAt: update.changedAt,
          });
        } else {
          library.forgetRemovedUpstream(report.workspaceId, update.name);
        }
      }
      // A promoted note left the personal layer: reload those slices even
      // with Knowledge closed, so reopening it never shows a note that's gone.
      for (const slice of promotionInvalidations(report)) {
        void useMemory.getState().refresh(slice.scope, slice.workspaceId, true);
      }
      if (report.changes.length > 0) void useWorkspaces.getState().refresh();
      if (status.observe(report)) void useDoctor.getState().refresh();
    });
    const unlistenEdited = onWorkspaceDefinitionEdited((workspaceId) => {
      status.forget(workspaceId);
      void useDoctor.getState().refresh();
    });
    // 1.173.0 (E3, from E1's review): a Next improvement direction field
    // held by a refresh asks by itself too, as C3's settings do.
    const unlistenDirection = onNiDirection((e) => onDirectionForConflicts(e.workspaceId, e.area));
    return () => {
      scheduler.stop();
      definitionSchedulerRef.current = null;
      void unlisten.then((off) => off());
      void unlistenEdited.then((off) => off());
      void unlistenDirection.then((off) => off());
    };
  }, []);
  // The Doctor's definition row is the active workspace's: reload it on a
  // switch (only once the Doctor has loaded — it fetches on first open).
  useEffect(() => {
    if (activeId && useDoctor.getState().report) {
      void useDoctor.getState().refresh();
    }
  }, [activeId]);
  useEffect(() => {
    definitionSchedulerRef.current?.sync(
      [...warmed].filter(
        (id) => !cwdMissing[id] && workspaces.some((w) => w.id === id),
      ),
    );
  }, [warmed, workspaces, cwdMissing]);

  // v1.40.2: idle pre-warm of remaining workspaces after the active
  // one is mounted. Without this, every first-switch to a fresh
  // workspace pays the TileGrid + card-host mount cost on the click
  // frame — visible as a sluggish initial flip. We sort candidates by
  // lastOpenedAt-desc so the next likely workspace warms first; the
  // effect re-runs after each `warmed` update and schedules the next
  // candidate until either the list is exhausted or WARMED_CAP is
  // reached. Each warm rides the same startTransition pipe as the
  // activeId effect, so React time-slices the work and never blocks
  // user input.
  useEffect(() => {
    if (!activeId || !warmed.has(activeId)) return;
    if (warmed.size >= WARMED_CAP) return;
    const candidates = workspaces
      .filter((w) => !warmed.has(w.id))
      .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
    if (candidates.length === 0) return;
    const next = candidates[0].id;

    const hasIdleCb =
      typeof (window as Window).requestIdleCallback === "function";
    const handle = hasIdleCb
      ? window.requestIdleCallback(
          () => {
            startTransition(() => {
              setWarmed((s) => {
                if (s.has(next)) return s;
                if (s.size >= WARMED_CAP) return s;
                const out = new Set(s);
                out.add(next);
                return out;
              });
            });
          },
          { timeout: 2000 },
        )
      : window.setTimeout(() => {
          startTransition(() => {
            setWarmed((s) => {
              if (s.has(next)) return s;
              if (s.size >= WARMED_CAP) return s;
              const out = new Set(s);
              out.add(next);
              return out;
            });
          });
        }, 500);
    return () => {
      if (hasIdleCb && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(handle);
      } else {
        window.clearTimeout(handle);
      }
    };
  }, [workspaces, warmed, activeId]);

  useEffect(() => {
    setWarmed((s) => {
      const validIds = new Set(workspaces.map((w) => w.id));
      const filtered = [...s].filter((id) => validIds.has(id));
      if (filtered.length === s.size) return s;
      // Stop watchers for removed workspaces
      for (const id of s) {
        if (!validIds.has(id)) {
          unwatchWorkspace(id).catch(() => {});
          forgetFolderChanges(id);
          // v1.17.0: keep LRU tracker in sync with warmed lifecycle.
          delete lastActiveAtRef.current[id];
        }
      }
      return new Set(filtered);
    });
  }, [workspaces]);

  // Forward window-level errors to the Rust log file
  useEffect(() => {
    function onError(e: ErrorEvent) {
      logError(`window.error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`).catch(() => {});
    }
    function onRejection(e: PromiseRejectionEvent) {
      logError(`unhandled rejection: ${String(e.reason)}`).catch(() => {});
    }
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // v1.5.7 (Bug #1): listen for warm-path CLI activations
  // (`atelier <path>`). The single-instance plugin callback in lib.rs
  // mutates workspaces.json directly; this listener re-syncs the
  // frontend store + switches active.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onWorkspaceActivated((workspaceId) => {
      const store = useWorkspaces.getState();
      store
        .refresh()
        .then(() => store.setActive(workspaceId))
        .catch(() => {});
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Phase 3: queued background/manual work starts asynchronously. Surface
  // terminal queue failures globally; successful starts already refresh via
  // `agent://run-started`, so this toast is only a concise confirmation.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onWriterQueueChanged((event) => {
      useKanban.getState().clearWriterQueueReceipt(event.id);
      pushToast({
        kind: event.status === "failed" ? "error" : "info",
        title:
          event.status === "failed"
            ? "Queued work failed"
            : "Queued work started",
        body: event.error ?? event.label,
      });
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // 1.175.0 (B2): what this Mac allowed of a repository's checks and install
  // step is re-read whenever it can have changed.
  useEffect(() => {
    void useChecksConsent.getState().bootstrapListeners();
  }, []);

  // G8 fixes (1.170.0, m2): a release through a pull request the poller
  // finished while nothing was waiting on it — "Released vX", with the
  // project's install step offered (never run by the poller itself).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onReleasePrReleased(async (event) => {
      // 1.173.0 (B4): the release's own tag (an area's is `site-v…`).
      const tag = event.result.tag ?? `v${event.result.shippedVersion}`;
      // 1.175.0 B2: an install step this Mac hasn't allowed isn't offered as
      // a press that runs it — Review opens the sheet with the two versions.
      const heldInstall = event.installScript
        ? await installHeldAfter(event.workspaceId, { tag, installScript: event.installScript })
        : null;
      const words = releasedByPollerWords(event, heldInstall?.held);
      pushToast({
        kind: "info",
        title: words.title,
        body: words.body,
        action: heldInstall
          ? heldInstall.action
          : event.installScript
          ? {
              label: "Run the install step",
              onClick: () => {
                shipReleaseInstall(event.workspaceId, tag)
                  .then((said) => pushToast({ kind: "info", title: `${tag}'s install step started`, body: said }))
                  .catch((cause: unknown) =>
                    pushErrorToast(`${tag}'s install step didn't start`, cause),
                  );
              },
            }
          : // 1.174.0 (DR4, state 8): with no step to run, its pull request.
            event.result.releasePr?.url
            ? {
                label: "Open on GitHub",
                onClick: () => {
                  const url = event.result.releasePr!.url!;
                  void openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e)));
                },
              }
            : undefined,
      });
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Forward Tauri native drag-drop events as a CustomEvent so panes can route
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onWindowDrop((e) => {
      if (e.windowLabel !== "main") return;
      window.dispatchEvent(
        new CustomEvent("atelier:window-drop", {
          detail: { paths: e.paths, x: e.position[0], y: e.position[1] },
        }),
      );
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Subscribe to agent run lifecycle: refresh that workspace's runs and toast on completion
  useEffect(() => {
    let unStarted: (() => void) | null = null;
    let unDone: (() => void) | null = null;
    let cancelled = false;

    onAgentRunStarted((e) => {
      useAgents.getState().refreshRun(e.workspaceId, e.runId).catch(() => {});
    })
      .then((u) => {
        if (cancelled) u();
        else unStarted = u;
      })
      .catch(() => {});

    onAgentRunDone((e) => {
      // Find the workspace for this run by scanning the agent store
      const state = useAgents.getState();
      let foundWs: string | null = null;
      for (const [wsId, ws] of Object.entries(state.byWorkspace)) {
        if (ws.runs.some((r) => r.id === e.runId)) {
          foundWs = wsId;
          break;
        }
      }
      if (foundWs) {
        state.refreshRun(foundWs, e.runId).catch(() => {});
      }
      // v1.22.0: codex provider quota exhaustion lands in `e.error` as the
      // upstream OpenAI API error body (codex emits a top-level JSONL `error`
      // event before exiting 1 — see CODEX_CLI_SURFACE.md §7 Q7). Swap the
      // generic "Agent run failed" toast for a specific quota toast when the
      // error string matches a known quota pattern.
      const isCodexQuotaError =
        e.status === "error" &&
        typeof e.error === "string" &&
        /rate[ _-]?limit|insufficient_quota|quota/i.test(e.error);
      if (isCodexQuotaError) {
        // QoL 1.168 block 8 (A4/A5): plain words; the raw error behind Details.
        pushToast({
          kind: "error",
          title: "Codex reached your ChatGPT usage limit",
          body: "start the run again once the limit resets; Plyloft doesn't retry it by itself.",
          details: e.error ?? undefined,
        });
      } else {
        // QoL 1.168 block 8 (A4): the Inbox's words; the exit code only
        // behind Details.
        const titleBase =
          e.status === "done"
            ? "The run finished"
            : e.status === "error"
            ? "The run failed"
            : e.status === "killed"
            ? "The run was stopped"
            : "The run ended";
        pushToast({
          kind: e.status === "done" ? "info" : e.status === "killed" ? "info" : "error",
          title: titleBase,
          body:
            e.status === "error"
              ? "History shows what it did."
              : e.status === "killed"
              ? "You stopped it."
              : undefined,
          ...(e.exitCode != null ? { details: `Exit code ${e.exitCode}` } : {}),
        });
      }
      // Native system notification (out-of-app), gated on global + per-agent toggles.
      const ws = foundWs ? state.byWorkspace[foundWs] : null;
      const agent = ws ? ws.agents.find((a) => a.id === e.agentId) ?? null : null;
      const run = ws ? ws.runs.find((r) => r.id === e.runId) ?? null : null;
      const globallyEnabled = useSettings.getState().settings.behavior
        .notifyOnAgentDone;
      // QoL 1.168 (Challenger 4): a card's run is told by the card notifier,
      // in the card's words, once — not here as well.
      if (runBelongsToCard(e.runId)) return;
      maybeNotifyRunDone(e, agent, globallyEnabled, run).catch(() => {});
    })
      .then((u) => {
        if (cancelled) u();
        else unDone = u;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (unStarted) unStarted();
      if (unDone) unDone();
    };
  }, []);

  // v1.34.0: macOS dock-icon badge = total "wants you" count across all
  // workspaces. Recomputes on a 1s tick mirroring the sidebar threshold
  // (SILENCE_MS = 10s — see src/lib/attention.ts). `setBadgeCount(undefined)`
  // clears the badge. Reads stores via getState() so the tick is the only
  // re-render driver — no zustand subscription firing on every tile output.
  //
  // v1.63.0: NEVER paused while hidden — the dock badge is exactly the
  // signal that matters when the window is hidden. It just slows to a 5s
  // cadence (nobody needs 1Hz badge granularity with the tiles invisible);
  // the visibility flip re-runs the effect, so resume refreshes immediately.
  useEffect(() => {
    let cancelled = false;
    const win = getCurrentWindow();
    // Windows (W4): no badge count there; the taskbar button and the tray
    // icon carry a dot and the tray's tooltip the count, sent when it changes.
    const onWindows = isWindows();
    let sentCount: number | null = null;
    function setBadge(total: number) {
      if (!onWindows) {
        win.setBadgeCount(total > 0 ? total : undefined).catch(() => {});
        return;
      }
      if (sentCount === total) return;
      sentCount = total;
      invoke("window_set_attention", { count: total }).catch(() => {});
    }
    function tick() {
      if (cancelled) return;
      // UX-4.4: the one attention signal — the number on the sidebar's
      // Inbox row, counted the same way (lib/needsYou.ts).
      // PR #347 walk: a closed or ended Builder session is not waiting —
      // its runtime goes even when its terminal never saw the exit.
      dropEndedBuilderSessions();
      const cardsByWs = useKanban.getState().byWorkspace;
      const now = Date.now();
      const waiting = waitingSessions({
        tilesByWorkspace: useTiles.getState().byWorkspace,
        builders: useBuilder.getState().byCard,
        cardTitle: (ws, id) => cardsByWs[ws]?.cards.find((c) => c.id === id)?.title ?? null,
        now,
        trustAsking: useBuilder.getState().trustAsking,
        sessionBlocks: useBuilder.getState().sessionBlocks,
        // Round 3 (M1): counted as the Inbox counts it.
        card: (ws, id) => cardsByWs[ws]?.cards.find((c) => c.id === id) ?? null,
        loaded: (ws) => cardsByWs[ws]?.loaded === true,
        sentAt: useBuilder.getState().sentAt,
        submittedAt: useBuilder.getState().submittedAt,
        doneAt: useBuilder.getState().doneAt,
        // (Challenger, P-B) a Builder at its prompt during its self-check or
        // Finish and check is not waiting for the person.
        finishing: finishingNow,
        // N14 walk F14: an intake that ended while its card still plans.
        intakesStopped: stoppedIntakesNow(),
        // Plan with two AIs: a plan that waits for the person, or is paused.
        plans: Object.values(usePlanExchange.getState().open),
        tileSeen: useTileSeen.getState().seen,
      });
      // UX P1 point 4 (P-B): the Board, the card and the sidebar read the
      // same waiting Builders, held 3 s so a card does not hop columns.
      useBuilderWaiting.getState().update(waiting, now);
      // The feed as the sidebar reads it (`useShownFeed`): solo mode leaves
      // out the pull requests waiting for review there, and here too.
      // P-A (UX P1 point 2): reconciled with what the loaded cards say, as
      // the sidebar's count is (`lib/inboxReconcile.ts`).
      const loaded = liveInboxCards(cardLiveSourcesNow(), now);
      const feed = reconcileFeed({
        feed: feedForMode(useInbox.getState().feed, useWorkMode.getState().mode === "solo"),
        loaded,
        waitingCards: new Set(waitingCardKeys(waiting)),
      });
      // QoL 1.168 (F6, D7): what is on screen is seen — the open card's
      // rows, the turns of the tiles in front. Counted from the next tick.
      const onScreen = onScreenNow();
      const tilesSeen = tilesSeenOnScreen(waiting, onScreen);
      if (tilesSeen.length > 0) useTileSeen.getState().markSeen(tilesSeen);
      const cardSeen = cardRowsSeenOnScreen(feed, onScreen).filter((id) => !cardRowsSentSeen.has(id));
      if (cardSeen.length > 0) {
        for (const id of cardSeen) cardRowsSentSeen.add(id);
        void useInbox.getState().markSeen(cardSeen);
      }
      // QoL 1.168 (F3): a card that newly needs its person, where they are
      // not looking, gets a system notification.
      notifyCardsNeedingYou(feed, onScreen, now);
      // QoL 1.168 (Challenger 4): what a burst held, as one banner.
      flushNotifyGate(now, useWorkspaces.getState().activeId);
      // UX P-B Mac walk 1: one card, one row, as the Inbox draws it.
      const total = attentionCounts(feed, foldWaitingIntoCardRows(waiting, feed, loaded)).total;
      // v1.154.1 (walk G1), UX P-F: which Builders wait on their CLI's trust
      // question, Claude's bypass warning or its usage limit.
      void pollSessionBlocks(now);
      // N14 walk F14: which intake conversations ended (card open or not).
      void pollEndedIntakes(now);
      setBadge(total);
      // A session that just ended a turn where the person is not looking gets a
      // system notification (store/waitingNotifier.ts).
      notifyNewlyWaiting(now);
    }
    tick();
    const id = setInterval(tick, visible ? 1000 : 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
      setBadge(0);
    };
  }, [visible]);

  // QoL 1.168 S3: the Mac menu's Check for Updates… and Help items, and the
  // Windows tray's Check for Updates…. Not under Setup (it covers the shell).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onMenuHelp((action) => {
      // Under Setup only what draws above it or outside the app answers:
      // Check for updates (its sheet is above Setup, so a copy that can't
      // finish Setup can still be updated) and the user guide (the browser).
      // New in this version and Getting started draw in the shell Setup
      // covers, so they wait until Setup closes.
      if (setupIsOpen() && action !== "check-updates" && action !== "guide") return;
      runHelpAction(action);
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // QoL walk of block 6: Help › Keyboard Shortcuts opens the sheet — the way
  // to it on every keyboard layout (an Italian ⌘? is macOS's Help search).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onMenuShortcuts(() => {
      if (setupIsOpen()) return;
      const ui = useUi.getState();
      if (!ui.shortcutsOpen && !visibleModalOpen()) ui.setShortcutsOpen(true);
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Global keyboard shortcuts (capture phase so xterm.js doesn't eat them).
  // UX-3.7: which shortcut a key press is comes from the one list in
  // lib/shortcuts.ts — the ⌘/ sheet draws the same list — and this switch is
  // only what each one does.
  useEffect(() => {
    const MODE_BY_SHORTCUT: Partial<Record<ShortcutId, CenterMode>> = {
      // v1.67.0 (UX revamp step 3a): ⌘⌥1–4 switch the center stage mode;
      // v1.80.0 (P2-2): ⌘⌥5 History (Activity); GH #96: ⌘⌥6 the Library.
      // Matched on `e.code` — with Option held, macOS rewrites `e.key`.
      modeInbox: "inbox",
      modeBoard: "board",
      modeCode: "code",
      modeTerminals: "terminals",
      modeHistory: "activity",
      modeLibrary: "library",
    };
    // C5 (Challenger): where the browser has the keyboard's layout map
    // (Windows' WebView2), the sheet's chord is named before any "/".
    void learnKeyboardLayout();
    function onKey(e: KeyboardEvent) {
      // 1.169.0 (C5): learn which key types "/" on this keyboard, for the
      // shortcut sheet's chord.
      noteTypedKey(e);
      // Windows (W4): Ctrl+Shift+Q quits — the window's close only hides it
      // to the tray, and there is no app menu. The Mac's ⌘Q is its menu's.
      // Both go through the quit guard (S1-2, `lib.rs::request_quit`).
      if (isQuitChord(e)) {
        e.preventDefault();
        e.stopPropagation();
        invoke("app_quit").catch(() => {});
        return;
      }
      // Windows: a terminal keeps the plain Ctrl chords its shell needs.
      const inTerminal =
        e.target instanceof Element && e.target.closest(".xterm") !== null;
      // Focus is in Code's editor text: its ⌘/ (Toggle comment, QoL 3.4 E6)
      // and its ⌘S (QoL 1.168 E4) are the editor's own.
      const inEditor =
        e.target instanceof Element && e.target.closest(".cm-editor") !== null;
      const id = matchShortcut(e, { inTerminal, inEditor });
      if (!id) return;
      // OB-4: while Setup is over the app, the shell under it is inert — no
      // shortcut reaches it (⌘K, ⌘,, a mode switch). The key is still
      // swallowed, so ⌘W never falls through to closing the window.
      // (1.178.0 A3: only Setup — a missing Plyloft account covers nothing.)
      if (setupIsOpen()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const ws = workspacesRef.current;
      const activeWs = activeIdRef.current;
      const env = envRef.current;
      let handled = false;

      const mode = MODE_BY_SHORTCUT[id];
      if (mode) {
        if (activeWs) {
          // U12; the center Panel is gated by gridVisible — this makes it visible.
          goToCenterMode(activeWs, mode);
          handled = true;
        }
      } else if (id === "workspaceN") {
        const target = ws[parseInt(e.key, 10) - 1];
        if (target) {
          // A settings page holding changes nobody else has is asked first:
          // switching workspace unmounts it (card #94 review, F13).
          // QoL 1.168 (A1): the keyboard goes into that workspace's page.
          leavePage(() => {
            void useWorkspaces.getState().setActive(target.id);
            focusActivePane(target.id);
          });
          handled = true;
        }
      } else if (id === "newShell" || id === "newClaude" || id === "newCodex") {
        // QoL 1.168 (D1, A1, D3): a new tile opens on Terminals with the
        // keyboard in it; ⌘T opens the kind Settings chooses.
        const wsRow = activeWs ? workspacesRef.current.find((w) => w.id === activeWs) : null;
        if (activeWs && wsRow) {
          if (id === "newShell") {
            openDefaultTile(activeWs, wsRow.cwd, env);
            handled = true;
          } else if (id === "newClaude" && env?.claudePath) {
            openNewTile(activeWs, wsRow.cwd, "claude", env);
            handled = true;
          } else if (id === "newCodex" && env?.codexPath) {
            // With Codex's own checks (an update under way, an incomplete
            // install), whether or not its Terminals page is mounted yet.
            openNewTile(activeWs, wsRow.cwd, "codex", env);
            handled = true;
          }
        } else if (activeWs) {
          handled = true;
        }
      } else if (
        id === "nextTile" ||
        id === "previousTile" ||
        id === "nextTilePage" ||
        id === "previousTilePage" ||
        id === "expandTile" ||
        id === "closeTile"
      ) {
        // QoL 1.168 (D8, M5): tiles by keyboard, while Terminals is on
        // screen; what happens elsewhere is `tileChordAction`'s.
        const ui = useUi.getState();
        const onTerminals =
          !!activeWs &&
          effectiveCenterMode(ui.centerMode, activeWs) === "terminals" &&
          !ui.settingsOverlayOpen &&
          !visibleModalOpen();
        const what = tileChordAction(id, { onTerminals, windows: isWindows(), inTerminal });
        if (what.act && activeWs) {
          if (id === "nextTile" || id === "previousTile" || id === "nextTilePage" || id === "previousTilePage") {
            focusAdjacentTile(activeWs, id === "nextTile" || id === "nextTilePage" ? 1 : -1);
          } else if (id === "expandTile") {
            const current = currentTileId(activeWs);
            if (current) toggleExpandTile(activeWs, current);
          } else {
            requestCloseCurrentTile(activeWs);
          }
        }
        handled = what.swallow;
      } else if (id === "comparePass") {
        // 1.177.0 Compare: while Terminals shows its relay bar; the bar of
        // the active workspace answers. Elsewhere the key does nothing.
        const ui = useUi.getState();
        if (
          activeWs &&
          effectiveCenterMode(ui.centerMode, activeWs) === "terminals" &&
          !ui.settingsOverlayOpen &&
          !visibleModalOpen() &&
          useCompare.getState().byWorkspace[activeWs]?.on
        ) {
          // A held key repeats: only the first press asks.
          if (!e.repeat) window.dispatchEvent(new CustomEvent(COMPARE_PASS_EVENT, { detail: { workspaceId: activeWs } }));
          handled = true;
        }
      } else if (id === "newCard") {
        // QoL 1.168 (C6): New card from anywhere, as ⌘K › New card….
        if (activeWs && !visibleModalOpen() && !useUi.getState().settingsOverlayOpen) {
          usePlanExchange.getState().armNewCardPlan(null);
          useUi.getState().selectCard(activeWs, null, false);
          openCenterMode(activeWs, "board");
          if (!useUi.getState().gridVisible) useUi.getState().setGridVisible(true);
          requestBoardNewTask(activeWs);
          handled = true;
        }
      } else if (id === "resume") {
        // QoL 1.168 (D8): Resume… from anywhere, as New ▾ › Resume….
        if (activeWs && (env?.claudePath || env?.codexPath) && !visibleModalOpen()) {
          openResume(activeWs);
          handled = true;
        }
      } else if (id === "closeTab") {
        // Always swallow Cmd-W so it never falls through to OS window-close.
        // QoL 1.168 S1-1: in Code it closes the active file through the
        // tab's × path (a dirty file asks first); in Terminals it restores
        // an expanded tile; anywhere else it does nothing — never a hidden
        // editor tab.
        handled = true;
        if (activeWs) {
          const ui = useUi.getState();
          const editorState = useEditor.getState().byWorkspace[activeWs];
          const action = closeTabAction({
            mode: effectiveCenterMode(ui.centerMode, activeWs),
            settingsOpen: ui.settingsOverlayOpen,
            modalOpen: visibleModalOpen(),
            expandedTile: !!useTiles.getState().byWorkspace[activeWs]?.expandedTileId,
            activeFile: !!editorState?.activePath,
          });
          if (action === "closeFile" && editorState?.activePath) {
            void closeEditorTab(activeWs, editorState.activePath);
          } else if (action === "collapseTile") {
            // Just collapse the expansion — don't kill the PTY on Cmd-W
            useTiles.getState().setExpanded(activeWs, null);
            // The Mac keeps its behaviour: the key is not cancelled here.
            // Windows cancels it below, so it never reaches a terminal.
            if (!isWindows()) return;
          }
        }
      } else if (id === "save" || id === "saveAll") {
        // QoL 1.168 E4: in Code only. ⌘S inside the text is the editor's own
        // (it says when a write fails on the tab); elsewhere in Code — the
        // tab bar, the file tree — it saves the active file here.
        const ui = useUi.getState();
        const action = saveKeyAction(id, {
          mode: activeWs ? effectiveCenterMode(ui.centerMode, activeWs) : "",
          settingsOpen: ui.settingsOverlayOpen,
          modalOpen: visibleModalOpen(),
          inEditorText: inEditor,
        });
        if (action === "editor") return;
        if (activeWs && action !== "ignore") {
          if (action === "saveAll") void saveAllInWorkspace(activeWs);
          else void saveActiveFile(activeWs);
          handled = true;
        }
      } else if (id === "sidebar") {
        // UX-3.4: hides or shows the sidebar (the overlay below 1000 px).
        toggleSidebar();
        handled = true;
      } else if (id === "settings") {
        // v1.73.0 (step 5b-3): Settings lives in the shell now.
        useUi.getState().setSettingsOverlayOpen(true);
        handled = true;
      } else if (id === "text") {
        // UX-3.6: ⌘K on its "In files" scope (was the search modal).
        if (activeWs) {
          useUi.getState().openPalette("text");
          handled = true;
        }
      } else if (id === "history") {
        // v1.25.0 (Cycle G2): history search (cards · runs · transcripts ·
        // snapshots · brainstorms). UX-3.6: ⌘K on its History scope.
        useUi.getState().openPalette("history");
        handled = true;
      } else if (id === "notes") {
        // v0.5.0 toggled the right panel. GH #95 (ADR 0005): the panel is
        // retired; the shortcut opened Knowledge, a center mode. GH #96: the
        // Library replaced it, and Knowledge's deep links open its Notes page.
        if (activeWs) {
          openLibraryPage(activeWs, "notes");
          handled = true;
        }
      } else if (id === "palette" || id === "files") {
        // Suppressed while another modal (a ConfirmDialog, a sheet) is
        // on screen — a VISIBLE one (GH #95 review 2: a confirm inside a
        // hidden sticky host must not swallow the shortcut). The palette
        // uses .palette-backdrop so its own presence doesn't suppress it.
        if (!visibleModalOpen()) togglePalette(id === "palette" ? "commands" : "files");
        handled = true;
      } else if (id === "shortcuts") {
        // UX-3.7: the ⌘/ sheet — the same list this handler matches with.
        const ui = useUi.getState();
        if (ui.shortcutsOpen) ui.setShortcutsOpen(false);
        else if (!visibleModalOpen()) ui.setShortcutsOpen(true);
        handled = true;
      }

      // Windows: a chord Ply claims never reaches a terminal, handled or not —
      // xterm would send it on as a control byte (Ctrl+3 is ESC, Ctrl+4 is
      // SIGQUIT).
      // QoL 1.168 (M5): except the tile chords — off Terminals (a card's
      // session) they are the terminal's, unanswered.
      // 1.177.0 (N3): Compare's chord, unanswered (Compare off), stays the program's.
      if (handled || (inTerminal && isWindows() && !TILE_CHORDS.has(id) && id !== "comparePass")) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const releaseSheet = useUi((s) => s.releaseSheet);
  const settingsLoaded = useSettings((s) => s.loaded);
  // OB-4 (ONBOARDING_SPEC §3.3): Setup opens by itself once settings are
  // loaded, while this Mac has not seen this Setup (`setupVersion`): a fresh
  // install at step 1, an existing user once over the running app (D1), or
  // someone who quit mid-setup on their step. Gated on `settingsLoaded` so
  // the unloaded store's defaults can't open it for an existing user.
  const setupOpen = useSetup((s) => s.open);
  // 1.178.0 (A3): only Setup covers the shell. Signed out of Plyloft is an
  // ordinary state — no Sign-in screen; Setup's step 2 and Settings › Plan
  // offer the sign-in, which only teams need.
  const shellCovered = setupOpen;
  useSignedInToast();
  const launchChecked = useRef(false);
  useEffect(() => {
    if (!settingsLoaded || launchChecked.current) return;
    // SETUP_AUTO_OPEN (on since OB-17); tests can force it off.
    const auto = setupAutoOpens();
    const onboarding = useSettings.getState().settings.onboarding;
    const setupCase = auto ? launchCase(onboarding) : null;
    // 1.178.0 (A3, D6): a Mac that closed Setup 1 has nothing new to see —
    // Setup 2's only new step, the Plyloft account, is optional — so this
    // Setup is stamped without opening, signed in or not.
    if (auto && stampsWithoutOpening(onboarding)) {
      void useSettings
        .getState()
        .update((cur) => ({
          ...cur,
          onboarding: closedOnboarding(
            cur.onboarding,
            knownStepId(cur.onboarding?.currentStep) ?? "ready",
            new Date().toISOString(),
          ),
        }))
        .catch((e) => console.warn("setup: version not stamped", e));
    }
    launchChecked.current = true;
    if (setupCase) useSetup.getState().openSetup(setupCase);
    setupOpenedAtLaunchRef.current = setupCase !== null;
    flushWelcome();
  }, [settingsLoaded, flushWelcome]);
  // Load agent stores + kanban cards + swarms for *newly*-warmed workspaces
  // (so tile drops, sidebar lookups, and off-screen run-done auto-advance all
  // see fresh state). v1.31.0: refetch only ids not already in `refreshedRef`
  // — re-running the whole fan-out for every warmed workspace on each
  // `warmed`/`workspaces`/`cwdMissing` change burst IPC onto the switch and
  // helped freeze the UI. Live updates after the initial load are kept fresh
  // by startKanbanSubscriptions / startSwarmSubscriptions / the agent-run
  // listeners — this effect only handles first-warm population.
  useEffect(() => {
    for (const id of warmed) {
      if (refreshedRef.current.has(id)) continue;
      const ws = workspaces.find((w) => w.id === id);
      if (!ws) continue;
      if (cwdMissing[id]) continue;
      refreshedRef.current.add(id);
      useAgents.getState().refresh(id, ws.cwd).catch(() => {});
      useKanban.getState().loadFromDisk(id).catch(() => {});
      // v1.27.3 hotfix: preload swarms per warmed workspace so any
      // component that reads `useSwarms.byWorkspace[wsId].swarms`
      // (LinkedBrainstormBanner's render gate, the kanban-tile 💭
      // badge) sees populated data on first paint. Pre-v1.27.3, this
      // was lazily loaded by `SwarmTab` on its first mount only — open
      // a card whose `linkedBrainstormId` points at a real swarm
      // without ever visiting the Swarms tab and the banner silently
      // never rendered.
      useSwarms.getState().refresh(id).catch(() => {});
      useCoordination.getState().refresh(id).catch(() => {});
    }
    // Drop ids that are no longer warmed (LRU-evicted or workspace removed)
    // so a future re-warm reloads their stores from disk.
    for (const id of refreshedRef.current) {
      if (!warmed.has(id)) refreshedRef.current.delete(id);
    }
  }, [warmed, workspaces, cwdMissing]);

  // Reset tiles + kanban for workspaces that disappear
  useEffect(() => {
    const validIds = new Set(workspaces.map((w) => w.id));
    const tileWs = Object.keys(useTiles.getState().byWorkspace);
    for (const id of tileWs) {
      if (!validIds.has(id)) {
        useTiles.getState().reset(id);
      }
    }
    const kanbanWs = Object.keys(useKanban.getState().byWorkspace);
    for (const id of kanbanWs) {
      if (!validIds.has(id)) {
        useKanban.getState().reset(id);
      }
    }
    const coordinationWs = Object.keys(useCoordination.getState().byWorkspace);
    for (const id of coordinationWs) {
      if (!validIds.has(id)) {
        useCoordination.getState().remove(id);
      }
    }
    // GH #96: where the Library was, per workspace.
    for (const id of Object.keys(useLibrary.getState().byWorkspace)) {
      if (!validIds.has(id)) useLibrary.getState().reset(id);
    }
    // GH #102: and the blocks that were waiting on its pages.
    for (const id of Object.keys(useErrorBlocks.getState().byWorkspace)) {
      if (!validIds.has(id)) useErrorBlocks.getState().reset(id);
    }
  }, [workspaces]);

  return (
    <div className="app-shell app-shell-v2">
      {error && (
        <div className="error-banner">
          {/* 1.174.0 (A7, P32): calm, the warning on its icon. */}
          <span className="error-banner-icon" aria-hidden="true">
            <Icon name="warning" size="sm" />
          </span>
          <span>
            <FailureText failure={error} />
          </span>
        </div>
      )}
      {/* OB-4: the shell is always rendered — Setup draws over it, never
          instead of it (unmounting a warmed workspace's hosts disposes its
          xterms and kills their PTYs). While Setup is up everything under it
          is inert and hidden from assistive tech. The wrapper is always here
          (display: contents), so opening Setup never changes the tree above
          the shell. */}
      <div className="app-shell-under" inert={shellCovered} aria-hidden={shellCovered || undefined}>
      <NewWorkspaceShell
        env={env}
        warmed={warmed}
        workspaces={workspaces}
        activeId={activeId}
      />
      {/* Getting started (TU-4): the Guide panel and the coach-mark,
          beside the shell — never in place of a host. Inside
          the inert wrapper, and hidden while Setup or Sign in is up (§9). */}
      <TutorialLayer covered={shellCovered} />
      {/* TU-6: the Quick tour's marks and the first-visit tips. */}
      <QuickTourLayer covered={shellCovered} />
      {/* TU-8: Help's New in this version and Get help. */}
      <HelpSheets />
      {/* The old "Ply" left beside Plyloft after the rename: asks to remove it. */}
      <LegacyInstallPrompt />
      <SettingsOverlay />
      {/* UX-3.6: the one search surface — ⌘K, ⌘P, ⌘⇧F, ⌘⇧H. */}
      <CommandPalette
        activeWorkspaceId={activeId}
        claudeAvailable={Boolean(env?.claudePath)}
        env={env}
        onOpenInstalledSelfCheck={() => setInstalledSelfCheckOpen(true)}
      />
      <ShortcutsSheet />
      {/* QoL 11.3: a run's output or a brainstorm, from History or ⌘⇧H. */}
      <HistoryItemSheet />
      {/* QoL 7.2 (B2): the one Add a project sheet (switcher, ⌘K, the
          zero-project screen). */}
      <AddProjectSheetHost />
      {/* 1.174.0 (DR3): the one Release sheet — every Release… opens it. */}
      {releaseSheet && (
        <ReleaseSheet
          key={`${releaseSheet.workspaceId}:${releaseSheet.areaId ?? ""}:${(releaseSheet.cardIds ?? []).join(",")}`}
          ask={releaseSheet}
          onClose={() => useUi.getState().setReleaseSheet(null)}
        />
      )}
      {installedSelfCheckOpen && (
        <InstalledSelfCheckObserver
          activeWorkspaceId={activeId}
          onClose={() => setInstalledSelfCheckOpen(false)}
        />
      )}
      </div>
      {/* OB-4 (ONBOARDING_SPEC §3.1): Setup, over the shell. */}
      {setupOpen && <SetupOverlay />}
      <ToastStack overSetup={shellCovered} />
      {/* GH #281: every yes/no question, as the confirm Sheet, over the rest
          — Setup included. */}
      <div className="ux-setup-above">
        {/* UX-3.8: runs the update checks and draws the install dialog; the
            "available" notice is the sidebar's status row. Launch A2: above
            Setup, whose footer offers "Install update". */}
        <UpdatePrompt />
        <ConfirmSheetHost />
        {/* 1.176.0 R6: the guided Repair of Claude Code and Codex. */}
        <RepairSheetHost />
        <SettingConflictHost />
        {/* 1.175.0 (B2): "Run the install step on this Mac?" */}
        <InstallConsentSheet />
        {/* 1.173.0 (E3): Next improvement's direction sheet (E5 builds the full editor). */}
        <NiDirectionSheetHost />
        <AdoptDirectionSheetHost />
        <PutOnGithubHost />
        {/* F1 (1.172.1): the project folder's changes sheet. */}
        <FolderChangesSheet />
        {/* Windows (W4): the window's close asks — keep running or quit —
            above Setup too. */}
        <WindowsCloseSheet />
        {/* QoL 1.168 S1-2: before a quit or the updater's relaunch, when
            something would be lost — above Setup too. */}
        <QuitGuardSheet />
      </div>
    </div>
  );
}

export default App;
