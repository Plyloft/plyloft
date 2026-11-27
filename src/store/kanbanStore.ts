import { create } from "zustand";
import { pushToast } from "./toastStore";
import { machineWords } from "../lib/platform";
import { teamAllowed, useAccount } from "./accountStore";
import { showPlanRefusal } from "./planPrompts";
import { FOLLOW_UP_ASK_EMPTY, followUpAskEmpty } from "../lib/followUp";
import { COPY_BRIEF_EMPTY, copyBriefEmpty } from "../lib/cardPresentation";
import { BUILD_WAITS as PLAN_BUILD_WAITS } from "../lib/planExchangeView";
import { usePlanExchange } from "./planExchangeStore";
import { kanbanOpenPrLinks, projectFolderCheck, type OpenPrLink } from "../lib/openPrLinks";
import { BOARD_NO_ACCESS, NO_FRESHNESS, noRepositoryAccess, refreshDue, type BoardFreshness } from "../lib/boardFreshness";
import {
  boardNoticeInTurn,
  boardUnreadableNotice,
  boardUnreadableNotices,
  boardUnreadableTitle,
  showInTurn,
} from "../lib/unreadableNotices";
import {
  kanbanLoad,
  kanbanCardCreate,
  kanbanCardFollowUp,
  kanbanCardDelete,
  kanbanCardDeleteGithub,
  kanbanCardPatch,
  kanbanCardUseIssueRemainder,
  kanbanCardSetRunState,
  kanbanClearRunHistory,
  kanbanCardAdvanceToInProgress,
  kanbanCardArchive,
  kanbanCardSetBoardOrder,
  kanbanCardSetBlockedBy,
  cardPrRefresh,
  cardPrMerge,
  cardBringUpToDate,
  cardPrPushUpdate,
  cardSetPrAutoFix,
  cardPrAutoFixBegin,
  cardPrAutoFixStop,
  cardPrSetAutoMerge,
  kanbanCardSetBuilderVendorPref,
  kanbanCardSetBuilderPermissions,
  kanbanCardSetModels,
  cardLineCommentAdd,
  cardLineCommentUpdate,
  cardLineCommentRemove,
  cardLineCommentsMarkSent,
  kanbanCardAddLaterRequest,
  kanbanCardRemoveLaterRequest,
  kanbanCardRestore,
  kanbanGithubReconcile,
  kanbanGithubRefresh,
  onWorktreeBaseNotice,
  onWorktreeSetupStarted,
  kanbanCardClaim,
  kanbanCardClaimState,
  kanbanCardDeviceClaim,
  kanbanCardForkToImplementation,
  kanbanAttachmentAddFromBytes,
  kanbanAttachmentAddFromPath,
  kanbanAttachmentRemove,
  kanbanAttachmentReveal,
  kanbanAttachmentOpen,
  kanbanAttachmentGcCard,
  kanbanSwarmGcCard,
  onKanbanChanged,
  swarmAbort,
  swarmCardSlotStatus,
  swarmTemplateUnboundRoles,
  agentRunQueue,
  agentRunRequest,
  agentRunKill,
  cardComposeDispatchPrompt,
  onAgentRunDone,
  onSwarmMailbox,
  swarmGet,
  type CardAttachment,
  type CardPatch,
  type CardForkResult,
  type KanbanCard,
  type LineCommentDraft,
  type LaterRequestSource,
  type KanbanColumnId,
  type PrMergeResult,
  type UpToDateResult,
  type PushUpdateResult,
  type PrAutoFixBegin,
  type PrAutoFixStopReason,
  type CardDeleteOutcome,
  type RunStatePatch,
  type SwarmStatus,
  type WorktreeChoice,
  type WriterQueueReceipt,
} from "../ipc";
import { deleteOutcomeToast, runToKill } from "../lib/cardDeleteSheet";
import { isWorktreeSetupFailure, setupRefusalNotice, setupStartedToast } from "../lib/worktreeSetup";
import { offerWorktreeEnvCopy } from "./worktreeSetupFlow";
import { useAgents } from "./agentStore";
import { useIntake } from "./intakeStore";
import { useWorkspaces } from "./workspaceStore";
import type { WorkspaceModels } from "../lib/workspaceModels";
import { useSwarms } from "./swarmStore";
import { useIdentity } from "./identityStore";
import { confirmChoice, confirmSheet } from "../store/confirmStore";
import {
  cardInWorkspace,
  claimBeforeStart,
  deviceStepBeforeStart,
  otherDeviceReading,
  otherDeviceSheet,
  raceSheet,
  TAKE_OVER_FAILED,
  type OtherDeviceChoice,
  secondClaimMessage,
  secondClaimBody,
  secondClaimPullRequest,
  type StartClaim,
} from "../lib/cardClaim";
import { cardExecutionRefusalMessage } from "../lib/cardExecutionError";
import { swarmTemplateInUse } from "../lib/cardLifecycle";
import {
  localBranchIsClear,
  localBranchNoticeSay,
  localBranchStateKey,
  localBranchSyncToast,
  folderUpdateSaid,
  folderUpdateSettled,
  projectFolderAsk,
  type LocalBranchPress,
  type LocalBranchToast,
  prunedWorktreesToast,
  syncFinishedToast,
  trashCleanupToast,
  worktreeBaseNoticeToast,
} from "../lib/worktreeBase";
import { observeLocalBranch, useErrorBlocks } from "./errorBlockStore";
import { openWebLink, projectFolderBringUpToDate, type FolderUpdate } from "../ipc";
import { linkDidNotOpen } from "../lib/linkToast";
import { answeredAsk, openFolderChanges, useProjectFolder } from "./projectFolderStore";
import type { ToastAction } from "./toastStore";
import { needsSetUp, projectFolderWords, startSettingUpOnce } from "../lib/projectSetup";
import { autoSetUpForStart } from "../lib/autoSetUp";
import { setUpAction, useUi } from "./uiStore";
import { currentAreaFor } from "../lib/cardArea";
// B2–B3 join: loads the area store, which hands `currentAreaFor` its reading.
import "./areaStore";
import { ensureCardArea } from "./cardAreaStore";
import {
  githubCardWriteBlocked,
  TEAM_BOARD_READ_ONLY_MESSAGE,
  touchesGithubOwnedCardField,
} from "../lib/teamGateCardWrites";
import { causeText, pushErrorToast } from "../lib/errorToast";
import { causeSentence } from "../lib/plainError";

export type { KanbanCard, KanbanColumnId, RunHistoryEntry } from "../ipc";

export const KANBAN_COLUMNS: ReadonlyArray<{
  id: KanbanColumnId;
  label: string;
}> = [
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "Working" },
  { id: "complete", label: "Done" },
];

interface WorkspaceKanbanState {
  cards: KanbanCard[];
  loaded: boolean;
  /** 1.176.2 (E1): the board file couldn't be read. `cards` is empty only
   *  because nothing was read: the Board says so (with Try again) instead of
   *  drawing the first-card invitation. */
  loadFailed?: boolean;
  /** The raw reason, for the Board's Details. */
  loadError?: string;
}

interface KanbanStoreShape {
  byWorkspace: Record<string, WorkspaceKanbanState>;
  /** P3-1: session-only receipt for unattended single-agent work that the
   *  backend queued behind another writer. Records describe a wait; they
   *  are not persisted and do not resurrect work after restart. */
  writerQueueByCard: Record<
    string,
    WriterQueueReceipt & { workspaceId: string }
  >;
  clearWriterQueueReceipt: (receiptId: string) => void;
  /** v1.57.0 (Cycle 3): per-workspace "Syncing…" indicator while a GitHub
   *  reconcile is in flight. */
  syncing: Record<string, boolean>;
  /** 1.172.1 (F2, Challenger 2): per workspace, while the read-only refresh
   *  (Get new issues, the timer) is in flight — `syncing` without it is a
   *  Sync, which also writes. Not persisted. */
  reading: Record<string, boolean>;
  /** QoL 14.1 (C19): per workspace, the last read of a GitHub-backed board
   *  (Sync or refresh) this session. Not persisted. */
  freshness: Record<string, BoardFreshness>;
  /** QoL 14.1 (Challenger): per workspace, how many Syncs (the push-and-pull
   *  reconcile, not the refresh) finished this session — what a read that
   *  follows each Sync keys on. */
  syncRound: Record<string, number>;
  /** U28: this session's read of which issues an open pull request closes,
   *  per workspace and issue number. Display only. */
  openPrLinks: Record<string, Record<number, OpenPrLink>>;
  readOpenPrLinks: (workspaceId: string) => Promise<void>;
  /** QoL 14.1 (C19): read the board's issues again, read only (no push, no
   *  fetch, no prune). Silent: a failure is recorded in `freshness`, never a
   *  toast, so a timer can call it. No-op for a non-GitHub workspace and
   *  while a Sync or refresh is in flight. */
  refreshGithub: (workspaceId: string) => Promise<void>;
  /** v1.57.0 (Cycle 3): per-workspace transient set of issue numbers whose
   *  backing GitHub issue vanished on the last reconcile — drives the
   *  "issue missing" badge. Not persisted; recomputed each reconcile. */
  missingIssues: Record<string, number[]>;
  /** v1.57.0 (Cycle 3): reconcile a GitHub-backed board against the live
   *  issues (push-then-pull). No-op (resolves) for non-GitHub workspaces.
   *  Best-effort: a failure toasts and leaves the board as-is. */
  /** `manual`: the person pressed Sync, so a Sync with nothing else to say
   *  still says it finished (P-D2 Mac walk). */
  reconcileGithub: (workspaceId: string, opts?: { manual?: boolean }) => Promise<void>;
  /** v1.57.0 (Cycle 3): one-click Claim — assign the current user to the
   *  card's backing issue so the next move-to-In-Progress passes the gate. */
  claimCard: (workspaceId: string, cardId: string) => Promise<void>;
  /** GH #66: before a start that creates the card's worktree (Start build,
   *  a move to In Progress), ask "Already claimed by X. Claim it too?" when
   *  someone else holds the card, and claim it on Yes. Resolves false when
   *  the user declined; true otherwise, including when there is nothing to
   *  ask (local board, unclaimed, mine, GitHub unreachable — the backend
   *  claim gate still decides). Reads the live issue: the synced assignees
   *  can be older than a claim made on another Mac. */
  confirmClaimBeforeStart: (
    workspaceId: string,
    cardId: string,
  ) => Promise<boolean>;
  /** GH #117: the claim step of Start build. As `confirmClaimBeforeStart`,
   *  and an unassigned issue is claimed in the same press (`claimed`).
   *  Throws when the claim fails, so Start build reports it once. */
  claimBeforeBuild: (workspaceId: string, cardId: string) => Promise<StartClaim>;
  /** "Use as brief": the card's issue remainder joins its notes. */
  adoptIssueRemainder: (cardId: string) => Promise<void>;
  /** `force=true` re-reads from disk even when already loaded. Used for
   *  the initial mount load and — since v1.33.0 — as the reconcile path
   *  for the `kanban://changed` backend event. It is a pure read: the
   *  whole-board `kanban_save` overwrite that made stale reloads dangerous
   *  was removed in v1.33.0. */
  loadFromDisk: (workspaceId: string, force?: boolean) => Promise<void>;
  reset: (workspaceId: string) => void;
  addCard: (
    workspaceId: string,
    title: string,
    notes?: string,
    columnId?: KanbanColumnId,
    /** 1.173.0 (B3): the area it is made in; absent: the current area
     *  (`currentAreaFor`), `null`: none. */
    area?: string | null,
  ) => Promise<KanbanCard>;
  /** N19: `Follow up` on a shipped card — a new To do card with this
   *  title and brief, linked both ways (`kanban_card_follow_up`). The
   *  shipped card gains only the link. Toasts and rethrows on a refusal. */
  followUp: (
    workspaceId: string,
    originalCardId: string,
    title: string,
    notes: string,
  ) => Promise<KanbanCard>;
  /** v1.39.0 (Recon-fork cycle, Increment 2): one-click create an
   *  implementation card from a completed recon audit. New card lands
   *  in Todo with the audit's `summary_md` preloaded as `knowledge`.
   *  Returns the partial-success result so the caller can surface a
   *  follow-up toast on intake failure. */
  forkToImplementation: (
    workspaceId: string,
    parentCardId: string,
    opts: {
      runIntake: boolean;
      suggestedSwarmTemplateId?: string | null;
      workspaceCwd: string;
    },
  ) => Promise<CardForkResult>;
  updateCard: (cardId: string, patch: CardPatch) => Promise<void>;
  /**
   * v1.28.0 (Cycle I-2): opts object replaces the prior `alsoKillRun: boolean`
   * positional argument so the FE can also opt into aborting a linked swarm
   * before the cascade GC. Both fields default to false.
   *  - `alsoKillRun`: stop the card's linked agent run before the delete.
   *    GH #116: the tick is the authority, not `lastRunStatus` — see
   *    `runToKill`.
   *  - `alsoAbortSwarm`: abort any linked brainstorm/card swarm before GC,
   *    so the backend doesn't refuse the gc_card call for a still-running swarm.
   *
   * v1.77.0: resolves `false` when the backend refuses the delete (the error
   * toast + board reload happen in here) — callers must not announce success.
   */
  removeCard: (
    cardId: string,
    opts?: CardDeleteOpts,
  ) => Promise<boolean>;
  /**
   * v1.77.0: the "Close issue & delete" path for GitHub-backed cards. Same
   * cascade opts as `removeCard`, but NOT optimistic: the card only leaves
   * FE state after the backend confirms the issue close + local delete.
   * Resolves `false` on refusal (error toast already shown).
   */
  removeCardGithub: (
    cardId: string,
    opts?: CardDeleteOpts,
  ) => Promise<boolean>;
  // G4 (launch D8): `attachAgent` / `attachSwarmTemplate` went with the
  // card's agent and swarm template pickers, their only callers.
  /**
   * Move a card to a new column. Side effects:
   *   - Todo → In Progress + agentConfigId set: starts an agent run; sets
   *     linkedRunId and lastRunStatus="running".
   *   - Manual drag in any other direction: just updates the column.
   */
  moveCard: (
    cardId: string,
    toColumn: KanbanColumnId,
    /** Launch G1 (Challenger P3-3): `redispatch` runs a card already in In
     *  progress again without the hop through To do. */
    opts?: { redispatch?: boolean },
  ) => Promise<void>;
  /** UX-5.3: the Board's drag within a column. Writes `boardOrder` only
   *  (optimistic; a refusal reloads the board). Never starts, stops or
   *  ships work — unlike `moveCard`, which the Board no longer calls. */
  setBoardOrder: (cardId: string, boardOrder: number | null) => Promise<void>;
  /** UX-7.1: the cards this card waits for (the whole list). Rejects with
   *  the backend's words (a cycle, the card itself) and reloads. */
  setBlockedBy: (cardId: string, blockedBy: string[]) => Promise<void>;
  /** SL-1: read the card's pull request from GitHub now and take the card
   *  as written (merged → Done, closed → back to review). Rejects with gh's
   *  or GitHub's words; the card is left as it was. */
  refreshPr: (workspaceId: string, cardId: string) => Promise<void>;
  /** SL-3: Merge the card's open PR on GitHub; the card as read after it is
   *  merged into state. A refusal is in the result, not thrown. */
  /** G1–G3 Challenger (2): `githubHead` for Merge what's on GitHub now. */
  mergePr: (workspaceId: string, cardId: string, githubHead?: string | null) => Promise<PrMergeResult>;
  /** SL-3: turn "Merge when checks pass" on or off for the card's open PR. */
  setPrAutoMerge: (workspaceId: string, cardId: string, on: boolean) => Promise<PrMergeResult>;
  /** G5: Bring this computer up to date on a merged card; the card as
   *  written after it is merged into state. Why it couldn't is in the result. */
  bringUpToDate: (workspaceId: string, cardId: string) => Promise<UpToDateResult>;
  /** SL-2: Push update — the card's verified snapshot to its open PR's
   *  branch, never forced; the card as read after it. A refusal is in the
   *  result, not thrown. `auto`: the G7 loop's push, gated in Rust (B6). */
  pushPrUpdate: (workspaceId: string, cardId: string, auto?: boolean) => Promise<PushUpdateResult>;
  /** G7: the card's own "Fix failing checks by itself" switch; the card as
   *  written. Rejects with the backend's words. */
  setPrAutoFix: (workspaceId: string, cardId: string, on: boolean) => Promise<void>;
  /** G7: count a try for the failing `head` (`card_pr_auto_fix_begin`). */
  beginPrAutoFix: (workspaceId: string, cardId: string, head: string) => Promise<PrAutoFixBegin>;
  /** G7: record why it stopped on `head` (`card_pr_auto_fix_stop`). */
  stopPrAutoFix: (
    workspaceId: string,
    cardId: string,
    head: string,
    reason: PrAutoFixStopReason,
    detail?: string | null,
  ) => Promise<void>;
  /** The Builder vendor chosen on the card before a build, saved with the
   *  card (null clears it back to the Settings default). Optimistic; only
   *  `builderVendorPref` is taken from the reply, so a reply that crosses a
   *  Start build never drops the session. A refusal reloads and rejects. */
  setBuilderVendorPref: (
    workspaceId: string,
    cardId: string,
    vendor: "claude" | "codex" | null,
  ) => Promise<void>;
  /** 1.168.1 (E2): the card's own models (null clears them back to the
   *  workspace's). Optimistic; only `models` (and the Builder's Build with
   *  both choice it may replace) is taken from the reply, as
   *  `setBuilderVendorPref` does. A refusal reloads and rejects. */
  setCardModels: (workspaceId: string, cardId: string, models: WorkspaceModels | null) => Promise<void>;
  /** 1.171.0 (D1): how the card's Builder asks (null clears it back to the
   *  Settings default). Optimistic, as `setBuilderVendorPref`; a refusal
   *  reloads and rejects. */
  setBuilderPermissions: (
    workspaceId: string,
    cardId: string,
    permissions: "editsCopy" | "asks" | "neverAsks" | null,
  ) => Promise<void>;
  /** SL-5: the card's line comments. Each write takes only
   *  `lineComments` from the reply (as `setBuilderVendorPref` does), so a
   *  reply that crosses another write never drops it. Rejects with the
   *  backend's words; nothing is changed then. */
  addLineComment: (workspaceId: string, cardId: string, draft: LineCommentDraft) => Promise<void>;
  updateLineComment: (workspaceId: string, cardId: string, commentId: string, body: string) => Promise<void>;
  removeLineComment: (workspaceId: string, cardId: string, commentId: string) => Promise<void>;
  markLineCommentsSent: (workspaceId: string, cardId: string, commentIds: string[]) => Promise<void>;
  /** 1.172.0 (A1): the card's later requests. Each write takes only
   *  `laterRequests` from the reply, as the line comments do. Rejects with
   *  the backend's words; nothing is changed then. */
  addLaterRequest: (
    workspaceId: string,
    cardId: string,
    text: string,
    source: Exclude<LaterRequestSource, "other">,
  ) => Promise<void>;
  removeLaterRequest: (workspaceId: string, cardId: string, requestId: string) => Promise<void>;
  /** v1.5.x: clear the system-managed runHistory on a card. */
  clearRunHistory: (cardId: string) => Promise<void>;
  /** v1.10.0 Cycle A: archive a Complete-column card. Routes through the
   *  backend `kanban_card_archive` IPC so the per-card worktree (if any)
   *  is pruned to its root's `.trash/` before `archived: true`
   *  lands. The returned card is merged into local state. */
  archiveCard: (cardId: string, opts?: { auto?: boolean }) => Promise<void>;
  /** UX-5.8: back from the archive (auto-archived or shipped cards only). */
  /** QoL 1.168 S1-3: resolves the card as it came back (null: not found). */
  restoreCard: (cardId: string) => Promise<KanbanCard | null>;
  /** v1.10.0: drag-drop / paste path. Bytes round-trip through Rust to
   *  land on disk; the returned CardAttachment is merged into the card. */
  addAttachmentFromBytes: (
    cardId: string,
    name: string,
    bytes: Uint8Array,
  ) => Promise<CardAttachment>;
  /** v1.10.0: file-picker path. Backend copies the absolute path into
   *  the attachments dir under a fresh uuid. */
  addAttachmentFromPath: (
    cardId: string,
    sourcePath: string,
  ) => Promise<CardAttachment>;
  /** v1.10.0: detach + delete an attachment. */
  removeAttachment: (cardId: string, attachmentId: string) => Promise<void>;
  /** v1.10.0: reveal an attachment in Finder. */
  revealAttachment: (storedPath: string) => Promise<void>;
  /** v1.10.0: open an attachment in the user's default app. */
  openAttachment: (storedPath: string) => Promise<void>;
}

let counter = 0;
const newCardId = () =>
  `card-${Date.now().toString(36)}-${(counter++).toString(36)}`;

function findCard(
  byWorkspace: Record<string, WorkspaceKanbanState>,
  cardId: string,
): { card: KanbanCard; workspaceId: string } | null {
  for (const [wsId, ws] of Object.entries(byWorkspace)) {
    const found = ws.cards.find((c) => c.id === cardId);
    if (found) return { card: found, workspaceId: wsId };
  }
  return null;
}

/** Frontend mirror of the backend admission rule. This runs before every
 * optimistic create/patch; Rust remains authoritative. */
function cardWriteRefusal(
  workspaceId: string,
  touchesGithubOwnedField: boolean,
): string | null {
  const workspace = useWorkspaces
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return `Workspace '${workspaceId}' not found.`;
  return githubCardWriteBlocked(
    workspace.kanbanSyncMode ?? "local",
    teamAllowed(useAccount.getState().gates),
    touchesGithubOwnedField,
  )
    ? TEAM_BOARD_READ_ONLY_MESSAGE
    : null;
}

function showCardWriteRefusal(message: string): void {
  pushToast({
    kind: "warn",
    title:
      message === TEAM_BOARD_READ_ONLY_MESSAGE
        ? "Board is read-only"
        : "Card change blocked",
    body: message,
  });
}

/** What a card delete may do beyond removing the card.
 *  - `alsoKillRun`: stop the card's linked agent run before the delete.
 *    GH #116: the tick is the authority, not `lastRunStatus` — see
 *    `runToKill`.
 *  - `alsoAbortSwarm`: abort any linked brainstorm/card swarm before GC.
 *  - `worktree` (GH #116): the confirm sheet's answer about the card's
 *    Builder worktree. Omitted, the backend removes the folder and its
 *    branch only when that loses nothing. */
export type CardDeleteOpts = {
  alsoKillRun?: boolean;
  alsoAbortSwarm?: boolean;
  worktree?: WorktreeChoice;
};

/** GH #116: say what happened to the card's Builder folder, when that is
 *  not what was asked for. A removal that failed never blocked the
 *  delete, so it is reported here rather than raised. The wording is
 *  `deleteOutcomeToast`'s, which has its own tests. */
function reportWorktreeOutcome(
  outcome: CardDeleteOutcome,
  choice: WorktreeChoice | undefined,
): void {
  const toast = deleteOutcomeToast(outcome, choice);
  if (toast) pushToast(toast);
}

/** v1.77.0: shared pre-delete cascade for `removeCard`/`removeCardGithub` —
 *  kill the linked running agent run and/or abort linked swarms, per the
 *  delete dialog's checkboxes. Returns the linked swarm ids collected BEFORE
 *  the card leaves FE state (the backend gc_card call needs them). */
async function preDeleteCascade(
  card: KanbanCard,
  opts?: CardDeleteOpts,
): Promise<string[]> {
  const killRunId = runToKill(card, opts);
  if (killRunId) {
    try {
      await agentRunKill(killRunId);
    } catch (e) {
      console.error("kanban: kill linked run failed:", e);
    }
  }
  // v1.28.0 (Cycle I-2): collect linked swarm ids before the FE drops
  // the card from state — the backend gc_card call needs them.
  const linkedSwarmIds = [
    card.linkedBrainstormId ?? null,
    card.linkedSwarmId ?? null,
  ].filter((v): v is string => Boolean(v));
  if (opts?.alsoAbortSwarm ?? false) {
    for (const swarmId of linkedSwarmIds) {
      try {
        await swarmAbort(swarmId);
      } catch (e) {
        // Swarm may already be in a terminal state — abort errors are
        // not fatal to the delete cascade.
        console.warn(`kanban: swarm abort ${swarmId} on card delete:`, e);
      }
    }
  }
  return linkedSwarmIds;
}

/** v1.77.0: shared post-delete GC — the per-card attachments dir (v1.10.0)
 *  and linked swarm dirs (v1.28.0). Best-effort: failures log and continue;
 *  the backend refuses running swarms, Adhoc, and still-referenced ids. */
async function postDeleteGc(
  workspaceId: string,
  cardId: string,
  linkedSwarmIds: string[],
): Promise<void> {
  try {
    await kanbanAttachmentGcCard(workspaceId, cardId);
  } catch (e) {
    console.warn("kanban: attachment GC on card delete failed:", e);
  }
  if (linkedSwarmIds.length > 0) {
    try {
      const result = await kanbanSwarmGcCard(workspaceId, cardId, linkedSwarmIds);
      if (result.refusedRunning.length > 0) {
        console.warn(
          "kanban: swarm GC refused (still running):",
          result.refusedRunning,
        );
      }
    } catch (e) {
      console.warn("kanban: swarm GC on card delete failed:", e);
    }
  }
}

/** v1.33.0: replace one card in state with the server-authoritative copy
 *  returned by a backend command — the reconcile step after every
 *  optimistic mutation. No-op if the workspace or card is gone. */
function reconcileCard(workspaceId: string, card: KanbanCard): void {
  useKanban.setState((s) => {
    const ws = s.byWorkspace[workspaceId];
    if (!ws) return s;
    return {
      byWorkspace: {
        ...s.byWorkspace,
        [workspaceId]: {
          ...ws,
          cards: ws.cards.map((c) => (c.id === card.id ? card : c)),
        },
      },
    };
  });
}

/** SL-5: the card's line comments as the backend wrote them, and nothing
 *  else from that reply. */
function takeLineComments(workspaceId: string, cardId: string, written: KanbanCard): void {
  const current = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId);
  if (current) reconcileCard(workspaceId, { ...current, lineComments: written.lineComments ?? [] });
}

function takeLaterRequests(workspaceId: string, cardId: string, written: KanbanCard): void {
  const current = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId);
  if (current) reconcileCard(workspaceId, { ...current, laterRequests: written.laterRequests ?? [] });
}

/** GH #66 / GH #117: the claim step before a start that creates the card's
 *  worktree, on the live issue (the synced assignees can be older than a
 *  claim made on another Mac). Local boards and started cards pass. */
async function claimStep(
  get: () => KanbanStoreShape,
  workspaceId: string,
  cardId: string,
  claimUnclaimed: boolean,
): Promise<StartClaim> {
  // Scoped to the workspace: `gh-issue-<n>` ids repeat across repositories.
  const card = cardInWorkspace(get().byWorkspace, workspaceId, cardId);
  if (!card) return "go";
  const ws = useWorkspaces
    .getState()
    .workspaces.find((w) => w.id === workspaceId);
  if (ws?.kanbanSyncMode !== "githubIssues") return "go";
  // Only a start that advances the card creates a worktree.
  if (card.columnId !== "todo" && card.worktreePath) {
    // 1.173.0 (C2): one another of this person's computers took over asks
    // again before it is built here; the claim is already held.
    try {
      const read = await kanbanCardClaimState(workspaceId, cardId);
      reconcileCard(workspaceId, read.card);
    } catch (e) {
      console.warn("kanban: claim marker read failed; starting", e);
      return "go";
    }
    return await deviceStep(get, workspaceId, cardId);
  }
  const claimed = await claimBeforeStart(
    {
      readHolder: async () => {
        const read = await kanbanCardClaimState(workspaceId, cardId);
        reconcileCard(workspaceId, read.card);
        return read.holder;
      },
      claim: async (confirmed) => {
        const outcome = await kanbanCardClaim(workspaceId, cardId, confirmed);
        reconcileCard(workspaceId, outcome.card);
        return outcome;
      },
      confirmSecondClaim: async (logins) =>
        await confirmSheet({
          title: secondClaimMessage(logins),
          body: secondClaimBody(secondClaimOpenPr(get, card)),
          confirmLabel: "Claim it too",
          cautious: true,
        }),
      // 1.175.0 (D1): a teammate claimed it a moment before this press.
      confirmAfterRace: async (raced) => {
        const answer = await confirmChoice(raceSheet(raced, card.title, card.ghIssueNumber));
        // "Open on GitHub" (the name couldn't be taken off): the issue's page.
        if (answer === "alt" && ws.githubOwnerRepo && card.ghIssueNumber) {
          const page = `https://github.com/${ws.githubOwnerRepo}/issues/${card.ghIssueNumber}`;
          void openWebLink(page).catch((e: unknown) => pushToast(linkDidNotOpen(page, e)));
        }
        return answer === "confirm";
      },
    },
    claimUnclaimed,
  );
  if (claimed === "cancel") return claimed;
  return (await deviceStep(get, workspaceId, cardId)) === "cancel" ? "cancel" : claimed;
}

/** 1.175.0 D4 (TM-8): the open pull request "Claim it too?" names — this
 *  computer's own, else the teammate's the Board already read for the issue. */
function secondClaimOpenPr(
  get: () => KanbanStoreShape,
  card: { workspaceId: string; ghIssueNumber?: number | null; pr?: { number: number; state: string } | null; prUrl?: string | null },
) {
  const linked = card.ghIssueNumber ? (get().openPrLinks[card.workspaceId]?.[card.ghIssueNumber] ?? null) : null;
  return secondClaimPullRequest(card, linked);
}

/** 1.173.0 (C2): the device half of the claim step — scene 1's sheet on a
 *  card another of this person's computers took, else this computer's
 *  claim marker on the issue. Reads the card as the live read left it. */
async function deviceStep(
  get: () => KanbanStoreShape,
  workspaceId: string,
  cardId: string,
): Promise<"go" | "cancel"> {
  const card = cardInWorkspace(get().byWorkspace, workspaceId, cardId);
  if (!card?.ghIssueNumber) return "go";
  const activeLogin = await useIdentity.getState().loadGithubLogin();
  const chosen = useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId)?.githubAccount ?? null;
  const login = chosen || activeLogin || null;
  return deviceStepBeforeStart({
    reading: otherDeviceReading(card, login),
    markedHere: Boolean(card.ghClaim && card.ghClaimHere),
    ask: async (reading): Promise<OtherDeviceChoice> => {
      const answer = await confirmChoice(otherDeviceSheet(reading, card.title, Date.now(), (t) => machineWords(t)));
      return answer === "confirm" ? "take-over" : answer === "alt" ? "here-too" : "cancel";
    },
    write: async (takeOver) => {
      reconcileCard(workspaceId, await kanbanCardDeviceClaim(workspaceId, cardId, takeOver));
    },
    takeOverFailed: (e) =>
      pushToast({ kind: "error", ...TAKE_OVER_FAILED, details: String((e as Error)?.message ?? e) }),
  });
}

/** v1.33.0: set a card's backend-owned run-link fields via the granular
 *  `kanban_card_set_run_state` command, then reconcile. The dispatch path
 *  and the run-completion listeners use this — it replaces the old
 *  `refreshThenPatch`, which reloaded the whole board to dodge the
 *  whole-board-`kanban_save` clobber. With field-scoped patches there is
 *  nothing left to clobber. */
async function persistRunState(
  workspaceId: string,
  cardId: string,
  patch: RunStatePatch,
): Promise<void> {
  try {
    const updated = await kanbanCardSetRunState(workspaceId, cardId, patch);
    reconcileCard(workspaceId, updated);
  } catch (e) {
    console.error("kanban: set run state failed:", e);
  }
}

/** E3: which lasting local-branch state a Sync nobody pressed last said,
 *  per workspace (`localBranchNoticeSay`). Browser storage — a convenience
 *  of this Mac's: lost, the state is said once more, nothing else. */
const LOCAL_BRANCH_SAID = "plyloft.localBranchSaid.";
function readLocalBranchSaid(workspaceId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(LOCAL_BRANCH_SAID + workspaceId) ?? null;
  } catch {
    return null;
  }
}
function writeLocalBranchSaid(workspaceId: string, key: string | null): void {
  try {
    if (key === null) globalThis.localStorage?.removeItem(LOCAL_BRANCH_SAID + workspaceId);
    else globalThis.localStorage?.setItem(LOCAL_BRANCH_SAID + workspaceId, key);
  } catch {
    /* storage refused: the state is said again next time */
  }
}

/** E3: a local-branch toast with its presses wired. */
export function pushLocalBranchToast(workspaceId: string, toast: LocalBranchToast): string {
  const { presses = [], ...words } = toast;
  const [first, second] = presses.map((p) => localBranchAction(workspaceId, p.kind, p.label));
  return pushToast({
    ...words,
    ...(first ? { action: first } : {}),
    ...(second ? { secondaryAction: second } : {}),
  });
}

/** E3: a press a local-branch toast or its notice offers. "Sync again" is
 *  the Board's Sync. F1 (1.172.1): "Bring it up to date" moves the project
 *  folder forward (`bringFolderUpToDate`); "I don't work here" stops the ask
 *  for the workspace, "Tell me again" brings it back; the files (Show the
 *  files, or changes in the way) open the changes sheet. */
export function localBranchAction(
  workspaceId: string,
  kind: LocalBranchPress,
  label: string,
): ToastAction {
  return {
    label,
    onClick: () => {
      switch (kind) {
        case "sync-again":
          void useKanban.getState().reconcileGithub(workspaceId, { manual: true }).catch(() => {});
          return;
        case "bring-up-to-date":
          void bringFolderUpToDate(workspaceId);
          return;
        case "dont-work-here":
        case "work-here":
          void setDontWorkHere(workspaceId, kind === "dont-work-here");
          return;
        case "show-files":
          openFolderChanges(workspaceId);
          return;
      }
    },
  };
}

/** F1: *I don't work here* (or *Tell me again*), persisted per workspace. */
async function setDontWorkHere(workspaceId: string, on: boolean): Promise<void> {
  try {
    await useWorkspaces.getState().setDontWorkHere(workspaceId, on);
  } catch (e) {
    pushErrorToast("Couldn't change it", e);
    return;
  }
  if (on) {
    pushToast({
      kind: "info",
      title: "Plyloft won't ask about your project folder again",
      // ux-allow: names the Settings page by its own title
      body: "Code and terminals opened there still say which version they show. Settings › Project › Cards' copies can turn the ask back on.",
      action: {
        label: "Open Settings",
        onClick: () => useUi.getState().openSettingsSection("worktrees", { workspaceId }),
      },
    });
  }
}

/** F1 (1.172.1): *Bring it up to date*. Only the folder's own branch, only
 *  forward, from its own GitHub copy — never a switch, a rewrite or a push
 *  (`project_folder_bring_up_to_date`). Changes in the way open the sheet.
 *  Afterwards the ask counts as answered and a quiet Sync reads the folder
 *  again. */
export async function bringFolderUpToDate(workspaceId: string): Promise<void> {
  const report = useErrorBlocks.getState().byWorkspace[workspaceId]?.localState ?? null;
  const key = report ? localBranchStateKey(report) : null;
  let update: FolderUpdate;
  try {
    update = await projectFolderBringUpToDate(workspaceId);
  } catch (e) {
    pushToast({
      kind: "warn",
      title: "Couldn't bring your project folder up to date",
      body: "Nothing changed, and your cards aren't affected.",
      details: String(e),
    });
    return;
  }
  const said = folderUpdateSaid(update);
  if (said.openSheet) {
    openFolderChanges(workspaceId);
    return;
  }
  if (said.toast) pushToast(said.toast);
  // Challenger 1: only a move (or nothing to bring) answers the ask; a
  // refusal leaves it on the Board.
  if (!folderUpdateSettled(update)) return;
  useProjectFolder.getState().markAnswered(workspaceId, key);
  void useKanban.getState().reconcileGithub(workspaceId).catch(() => {});
}

/** QoL 14.1 (Challenger): Syncs and refreshes in flight per workspace —
 *  `syncing` stays true until the last of them ends. */
const syncsInFlight = new Map<string, number>();
type SetKanban = (fn: (s: KanbanStoreShape) => Partial<KanbanStoreShape>) => void;
function beginSync(set: SetKanban, workspaceId: string) {
  syncsInFlight.set(workspaceId, (syncsInFlight.get(workspaceId) ?? 0) + 1);
  set((s) => ({ syncing: { ...s.syncing, [workspaceId]: true } }));
}
function endSync(set: SetKanban, workspaceId: string) {
  const left = Math.max(0, (syncsInFlight.get(workspaceId) ?? 1) - 1);
  if (left === 0) syncsInFlight.delete(workspaceId);
  else syncsInFlight.set(workspaceId, left);
  if (left === 0) set((s) => ({ syncing: { ...s.syncing, [workspaceId]: false } }));
}

/** Round 4 (T1): the restored GitHub Issues boards whose first read hasn't
 *  gone through yet, each with its timer. */
const restoredReads = new Map<string, number>();
/** The Board's own tick (`KanbanBoard.tsx`). */
const RESTORED_READ_TICK_MS = 30_000;

function stopRestoredRead(workspaceId: string): void {
  const timer = restoredReads.get(workspaceId);
  if (timer != null) window.clearInterval(timer);
  restoredReads.delete(workspaceId);
}

/** Tests only: forget the reads still being retried. */
export function stopRestoredReadsForTests(): void {
  for (const id of [...restoredReads.keys()]) stopRestoredRead(id);
}

/** 1.175.0 (R2, T1): a board opened from its last saved copy is one save
 *  behind, and on GitHub Issues nothing of it is sent to GitHub before its
 *  issues were read once (`github_sync::pull_first_if_restored`). That read
 *  is asked at once and, while it fails (offline, GitHub's limit), again on
 *  the Board's tick with the Board's back-off (`refreshDue`) — whether or
 *  not the Board of that project is ever on screen. It stops at the first
 *  read that went through (a Sync counts), or when the project is gone or
 *  no longer on GitHub Issues. */
function readRestoredBoard(workspaceId: string): void {
  if (restoredReads.has(workspaceId)) return;
  const armedAt = Date.now();
  let asked = false;
  const tick = () => {
    const kanban = useKanban.getState();
    const f = kanban.freshness[workspaceId] ?? NO_FRESHNESS;
    if (!f.failed && f.at != null && f.at >= armedAt) return stopRestoredRead(workspaceId);
    const projects = useWorkspaces.getState();
    if (projects.loaded) {
      const ws = projects.workspaces.find((w) => w.id === workspaceId);
      if (ws?.kanbanSyncMode !== "githubIssues") return stopRestoredRead(workspaceId);
    }
    if (asked && !refreshDue(f, Date.now(), "timer")) return;
    asked = true;
    void kanban.refreshGithub(workspaceId).then(() => {
      const after = useKanban.getState().freshness[workspaceId] ?? NO_FRESHNESS;
      if (!after.failed && after.at != null && after.at >= armedAt) stopRestoredRead(workspaceId);
    });
  };
  restoredReads.set(workspaceId, window.setInterval(tick, RESTORED_READ_TICK_MS));
  tick();
}

/** 1.175.0 (R2): say, once, that this board's file couldn't be read and what
 *  Plyloft did. The fallback of `sayUnreadableBoardsAtLaunch`, for a board
 *  first read after the launch: the backend hands each trouble out once, so
 *  nothing is said twice. */
async function sayBoardUnreadable(workspaceId: string): Promise<void> {
  try {
    const notice = await boardUnreadableNotice(workspaceId);
    if (!notice) return;
    const ws = useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId);
    showInTurn([boardNoticeInTurn(workspaceId, ws?.name, notice)]);
    if (notice.restored && ws?.kanbanSyncMode === "githubIssues") readRestoredBoard(workspaceId);
  } catch (e) {
    console.warn(`board notice of ${workspaceId} failed:`, e);
  }
}

/** Round 4 (T1): at launch, beside the project-list notice, say every board
 *  whose file couldn't be read — the launch reads every listed board, so a
 *  damaged one is restored (or set aside) whether or not its project is
 *  opened — and start the first GitHub read of each restored GitHub Issues
 *  board, said now or at an earlier launch. Never throws. */
export async function sayUnreadableBoardsAtLaunch(): Promise<void> {
  try {
    const { notices, awaitingRead } = await boardUnreadableNotices();
    // One after the other, each acknowledged once it is on screen (W3): a
    // quit while the others wait their turn shows them at the next launch.
    showInTurn(notices.map((notice) => boardNoticeInTurn(notice.workspaceId, notice.projectName ?? undefined, notice)));
    // Round 6 (W2): every restored GitHub Issues board still waiting for its
    // read — the ones just said, and one said at an earlier launch, whose
    // writes are held again and which nothing else would read until its
    // Board is opened.
    for (const workspaceId of awaitingRead) readRestoredBoard(workspaceId);
  } catch (e) {
    console.warn("board notices at launch failed:", e);
  }
}

export const useKanban = create<KanbanStoreShape>((set, get) => ({
  byWorkspace: {},
  writerQueueByCard: {},
  syncing: {},
  reading: {},
  freshness: {},
  syncRound: {},
  openPrLinks: {},
  readOpenPrLinks: async (workspaceId) => {
    try {
      const list = await kanbanOpenPrLinks(workspaceId);
      const byIssue: Record<number, OpenPrLink> = {};
      for (const link of Array.isArray(list) ? list : []) byIssue[link.issue] = link;
      set((s) => ({ openPrLinks: { ...s.openPrLinks, [workspaceId]: byIssue } }));
    } catch (e) {
      // A read that says a link is gone replaces it; a failed one keeps what
      // the last read said, as the Board's cards do (its line says the read
      // failed). The card page reads its own.
      console.warn(`board: open pull requests of ${workspaceId} not read`, e);
    }
  },
  missingIssues: {},

  clearWriterQueueReceipt: (receiptId) =>
    set((state) => ({
      writerQueueByCard: Object.fromEntries(
        Object.entries(state.writerQueueByCard).filter(
          ([, receipt]) => receipt.id !== receiptId,
        ),
      ),
    })),

  reconcileGithub: async (workspaceId, opts) => {
    const ws = useWorkspaces
      .getState()
      .workspaces.find((w) => w.id === workspaceId);
    if (ws?.kanbanSyncMode !== "githubIssues") return;
    beginSync(set, workspaceId);
    const triedAt = Date.now();
    try {
      const summary = await kanbanGithubReconcile(workspaceId);
      set((s) => ({
        freshness: { ...s.freshness, [workspaceId]: { at: Date.now(), triedAt, failed: false } },
        syncRound: { ...s.syncRound, [workspaceId]: (s.syncRound[workspaceId] ?? 0) + 1 },
      }));
      // GH #66: Sync is when a `gh auth switch` should show on claim chips.
      void useIdentity.getState().loadGithubLogin(true);
      set((s) => ({
        missingIssues: { ...s.missingIssues, [workspaceId]: summary.missing },
      }));
      // Cards start from the fetched default branch: the pass also moved
      // (or refused to move) the local target branch up to origin.
      //
      // GH #102: the refusal of GH #88 needs doing, so it is not a toast's
      // to carry. `observeLocalBranch` puts the block on the page it concerns
      // — and takes it down when the fast-forward finally goes through — and
      // announces it once; every other outcome still toasts as it did.
      //
      // E3 (owner, 2026-10-28): a lasting state (behind with changes in the
      // folder, open elsewhere, both moved, couldn't update) stays on
      // Settings › Board and worktrees; a Sync nobody pressed says it once
      // per workspace, branch and state, not at every launch.
      let saidSomething = false;
      if (summary.localBranch) {
        const report = summary.localBranch;
        const refused = observeLocalBranch(workspaceId, report);
        // Round 2 (Challenger 3): kept until the branch is fine — an offline
        // launch says nothing about it, so it leaves the notice and the key.
        if (localBranchStateKey(report)) useErrorBlocks.getState().setLocalState(workspaceId, report);
        else if (localBranchIsClear(report)) useErrorBlocks.getState().setLocalState(workspaceId, null);
        const branchToast = refused ? null : localBranchSyncToast(report);
        const { say, remember } = localBranchNoticeSay(
          report,
          readLocalBranchSaid(workspaceId),
          opts?.manual === true,
        );
        if (!refused && remember !== undefined) writeLocalBranchSaid(workspaceId, remember);
        // F1 (1.172.1): the folder's ask stays quiet after *I don't work
        // here*, and once answered with *Bring it up to date* — even on a
        // pressed Sync (the Board and Settings still keep it).
        const ask = projectFolderAsk(report);
        const quietAsk =
          ask != null &&
          (ws?.dontWorkHere === true || (localBranchStateKey(report) ?? "") === (answeredAsk(workspaceId) ?? "\u0001"));
        const speak = branchToast != null && say && !quietAsk;
        if (branchToast && speak) pushLocalBranchToast(workspaceId, branchToast);
        saidSomething = refused || speak;
      }
      const pruneToast = prunedWorktreesToast(
        summary.prunedWorktrees ?? 0,
        summary.keptMergedWorktrees,
      );
      if (pruneToast) pushToast(pruneToast);
      const trashToast = trashCleanupToast(summary.trashFreedBytes ?? 0);
      if (trashToast) pushToast(trashToast);
      const finished = syncFinishedToast(summary, {
        manual: opts?.manual === true,
        saidSomething: saidSomething || pruneToast != null || trashToast != null,
      });
      if (finished) pushToast(finished);
      // The backend emits kanban://changed, which forces a reload; still
      // reload here so a manual Sync reflects immediately even if the event
      // is coalesced.
      await get().loadFromDisk(workspaceId, true);
    } catch (e) {
      // QoL 14.1 (Challenger): a failed Sync is a failed read too, so the
      // header says so and the refresh's back-off takes over from it.
      const noAccess = noRepositoryAccess(e);
      set((s) => ({
        freshness: {
          ...s.freshness,
          [workspaceId]: { ...(s.freshness[workspaceId] ?? NO_FRESHNESS), triedAt, failed: true, noAccess },
        },
      }));
      pushToast({
        kind: "error",
        title: "The Board wasn't brought up to date",
        // 1.176.2 (E1, A3-17): the cause in words when Plyloft knows it.
        body: noAccess
          ? BOARD_NO_ACCESS
          : `${causeSentence(e)} The Board shows what Plyloft read last, and Plyloft tries again by itself.`,
        details: String((e as Error)?.message ?? e),
      });
    } finally {
      endSync(set, workspaceId);
    }
  },

  refreshGithub: async (workspaceId) => {
    const ws = useWorkspaces
      .getState()
      .workspaces.find((w) => w.id === workspaceId);
    if (ws?.kanbanSyncMode !== "githubIssues") return;
    if (get().syncing[workspaceId]) return;
    const triedAt = Date.now();
    const before = get().freshness[workspaceId] ?? NO_FRESHNESS;
    beginSync(set, workspaceId);
    set((s) => ({
      reading: { ...s.reading, [workspaceId]: true },
      freshness: { ...s.freshness, [workspaceId]: { ...before, triedAt } },
    }));
    try {
      const summary = await kanbanGithubRefresh(workspaceId);
      set((s) => ({
        missingIssues: { ...s.missingIssues, [workspaceId]: summary.missing },
        freshness: { ...s.freshness, [workspaceId]: { at: Date.now(), triedAt, failed: false } },
      }));
      if (summary.created + summary.patched > 0) await get().loadFromDisk(workspaceId, true);
    } catch (e) {
      console.warn(`board refresh of ${workspaceId} failed:`, e);
      set((s) => ({
        freshness: { ...s.freshness, [workspaceId]: { ...before, triedAt, failed: true, noAccess: noRepositoryAccess(e) } },
      }));
    } finally {
      set((s) => ({ reading: { ...s.reading, [workspaceId]: false } }));
      endSync(set, workspaceId);
    }
  },

  claimCard: async (workspaceId, cardId) => {
    // Scoped to the workspace: `gh-issue-<n>` ids repeat across repositories.
    const card = cardInWorkspace(get().byWorkspace, workspaceId, cardId);
    if (!card) return;
    try {
      // GH #66: the backend reads the live assignees and only asks back when
      // someone else holds the issue; a second claim is confirmed here.
      let outcome = await kanbanCardClaim(card.workspaceId, cardId);
      reconcileCard(card.workspaceId, outcome.card);
      if (!outcome.claimed && outcome.holder.kind === "others") {
        const yes = await confirmSheet({
          title: secondClaimMessage(outcome.holder.logins),
          body: secondClaimBody(secondClaimOpenPr(get, card)),
          confirmLabel: "Claim it too",
          cautious: true,
        });
        if (!yes) return;
        outcome = await kanbanCardClaim(card.workspaceId, cardId, true);
        reconcileCard(card.workspaceId, outcome.card);
      }
      pushToast({
        kind: "info",
        title: outcome.holder.kind === "mine" ? "Already yours" : "Claimed",
        body: card.title,
      });
    } catch (e) {
      pushErrorToast("The card wasn't claimed", e, { then: "Nobody's name was put on it. Try again." });
      throw e;
    }
  },

  confirmClaimBeforeStart: async (workspaceId, cardId) => {
    try {
      return (await claimStep(get, workspaceId, cardId, false)) !== "cancel";
    } catch (e) {
      pushErrorToast("The card wasn't claimed", e, { then: "Nobody's name was put on it, and the build didn't start. Try again." });
      return false;
    }
  },

  claimBeforeBuild: (workspaceId, cardId) =>
    claimStep(get, workspaceId, cardId, true),

  adoptIssueRemainder: async (cardId) => {
    const found = findCard(get().byWorkspace, cardId);
    if (!found) return;
    const { workspaceId } = found;
    const refusal = cardWriteRefusal(workspaceId, true);
    if (refusal) {
      showCardWriteRefusal(refusal);
      return;
    }
    try {
      const updated = await kanbanCardUseIssueRemainder(workspaceId, cardId);
      reconcileCard(workspaceId, updated);
    } catch (e) {
      console.error("kanban adoptIssueRemainder failed:", e);
      pushErrorToast("Use as brief failed", e);
    }
  },

  loadFromDisk: async (workspaceId, force = false) => {
    const existing = get().byWorkspace[workspaceId];
    if (!force && existing?.loaded) return;
    try {
      // `?? []` guards against a null IPC result (e.g. the headless
      // runtime-smoke harness where the Tauri backend is absent).
      const cards = (await kanbanLoad(workspaceId)) ?? [];
      // The "In Review" column was retired; the backend's
      // `#[serde(alias = "in_review")]` on `Complete` already maps legacy
      // values during deserialize, but defend at the FE boundary too so a
      // stale on-disk value never surfaces in the type-narrowed UI.
      const normalized = cards.map((c) =>
        (c.columnId as string) === "in_review"
          ? { ...c, columnId: "complete" as KanbanColumnId }
          : c,
      );
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { cards: normalized, loaded: true },
        },
      }));
      // 1.175.0 (R2): a board file that couldn't be read is opened from its
      // last saved copy, or set aside. The cards are shown either way, and
      // the backend says what happened once: asked at this window's first
      // load of the board (the backend reads a board file once a session).
      if (!existing?.loaded) void sayBoardUnreadable(workspaceId);
    } catch (e) {
      console.error("kanban load failed:", e);
      // A board this Plyloft refuses (a newer one saved it) or couldn't set
      // aside: the file is untouched, and the reason is behind Details.
      // The toast can come at launch, over another workspace: name it.
      const name = useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId)?.name;
      pushErrorToast(boardUnreadableTitle(name), e);
      // A board already on screen stays as it was. On a first read, mark it
      // loaded so the UI doesn't spin — and failed, so the Board doesn't pass
      // an unread board off as an empty one (1.176.2, E1).
      if (existing?.loaded) return;
      set((s) => ({
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { cards: [], loaded: true, loadFailed: true, loadError: causeText(e) },
        },
      }));
    }
  },

  reset: (workspaceId) =>
    set((s) => {
      const next = { ...s.byWorkspace };
      delete next[workspaceId];
      return {
        byWorkspace: next,
        writerQueueByCard: Object.fromEntries(
          Object.entries(s.writerQueueByCard).filter(
            ([, receipt]) => receipt.workspaceId !== workspaceId,
          ),
        ),
      };
    }),

  forkToImplementation: async (workspaceId, parentCardId, opts) => {
    // v1.39.0: FE picks the new card id (consistent with addCard /
    // kanbanCardCreate convention). Backend rejects duplicates, so two
    // concurrent forks can't clobber each other. The result struct
    // carries the persisted card plus the intake-start outcome — the
    // card is ALWAYS created even when intake fails (partial success);
    // see the IPC's CardForkResult shape.
    const cardId = newCardId();
    const result = await kanbanCardForkToImplementation(
      workspaceId,
      parentCardId,
      cardId,
      {
        runIntake: opts.runIntake,
        suggestedSwarmTemplateId: opts.suggestedSwarmTemplateId ?? null,
        workspaceCwd: opts.workspaceCwd,
      },
    );
    // Insert the created card into local state. Backend emits
    // kanban://changed too, which triggers loadFromDisk — but the
    // immediate insert keeps the FE snappy for the
    // "navigate to new card" follow-up.
    set((s) => {
      const ws = s.byWorkspace[workspaceId] ?? { cards: [], loaded: true };
      // Guard against double-insert if the kanban://changed reload
      // raced us.
      if (ws.cards.some((c) => c.id === result.card.id)) return s;
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { ...ws, cards: [...ws.cards, result.card] },
        },
      };
    });
    // v1.39.2: push the intake PTY id into the intake store so the
    // IntakeConversation component mounts on the new card. The manual
    // intake flow does this inside `useIntake.start()`; the fork flow
    // bypasses that path so the kanbanStore action mirrors it.
    if (result.intakeStarted && result.intakePtyId) {
      useIntake.getState().setPtyId(result.card.id, result.intakePtyId);
    }
    pushToast({
      kind: "info",
      title: "Forked",
      body: `Created "${result.card.title}" in Not started.`,
    });
    if (opts.runIntake && !result.intakeStarted) {
      // Partial-success path: card created, intake failed to start.
      // Surface a second toast so the user knows to retry manually.
      pushToast({
        kind: "warn",
        title: "Planning didn't start",
        body:
          result.intakeError ??
          "The new card was made, but its planning conversation didn't start. Try again from the card.",
      });
    }
    return result;
  },

  addCard: async (workspaceId, title, notes, columnId, area) => {
    // v1.33.0: card creation is a granular backend command. The FE picks
    // the id so the optimistic insert and the reconciled card share it.
    const refusal = cardWriteRefusal(workspaceId, true);
    if (refusal) {
      showCardWriteRefusal(refusal);
      throw new Error(refusal);
    }
    const cardId = newCardId();
    const now = Date.now();
    const column = columnId ?? "todo";
    // 1.173.0 (B3): made in the current area (B2's picker) unless asked.
    const cardArea = area === undefined ? currentAreaFor(workspaceId) : area;
    const optimistic: KanbanCard = {
      id: cardId,
      workspaceId,
      title,
      notes: notes ?? null,
      columnId: column,
      area: cardArea,
      createdAt: now,
      updatedAt: now,
    };
    set((s) => {
      const ws = s.byWorkspace[workspaceId] ?? { cards: [], loaded: true };
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { ...ws, cards: [...ws.cards, optimistic] },
        },
      };
    });
    try {
      const created = await kanbanCardCreate(
        workspaceId,
        cardId,
        title,
        notes ?? null,
        column,
        cardArea,
      );
      reconcileCard(workspaceId, created);
      return created;
    } catch (e) {
      console.error("kanban addCard failed:", e);
      pushErrorToast("The card wasn't made", e, { then: "Nothing was added to the Board. Try again." });
      // Roll the optimistic insert back out.
      set((s) => {
        const ws = s.byWorkspace[workspaceId];
        if (!ws) return s;
        return {
          byWorkspace: {
            ...s.byWorkspace,
            [workspaceId]: {
              ...ws,
              cards: ws.cards.filter((c) => c.id !== cardId),
            },
          },
        };
      });
      throw e;
    }
  },

  followUp: async (workspaceId, originalCardId, title, notes) => {
    const refusal = cardWriteRefusal(workspaceId, true);
    if (refusal) {
      showCardWriteRefusal(refusal);
      throw new Error(refusal);
    }
    let created: KanbanCard;
    try {
      created = await kanbanCardFollowUp(workspaceId, originalCardId, newCardId(), title, notes);
    } catch (e) {
      pushErrorToast("The follow-up card wasn't made", e, { then: "The shipped card is as it was." });
      throw e;
    }
    // The backend emits kanban://changed too; these keep the page snappy
    // for opening the new card at once.
    set((s) => {
      const ws = s.byWorkspace[workspaceId] ?? { cards: [], loaded: true };
      const link = { cardId: created.id, title: created.title, at: created.followsUp?.at ?? created.createdAt };
      const cards = ws.cards.map((c) =>
        c.id === originalCardId && !(c.followedUpBy ?? []).some((f) => f.cardId === created.id)
          ? { ...c, followedUpBy: [...(c.followedUpBy ?? []), link] }
          : c,
      );
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { ...ws, cards: cards.some((c) => c.id === created.id) ? cards : [...cards, created] },
        },
      };
    });
    return created;
  },

  updateCard: async (cardId, patch) => {
    const found = findCard(get().byWorkspace, cardId);
    if (!found) return;
    const { workspaceId } = found;
    const refusal = cardWriteRefusal(
      workspaceId,
      touchesGithubOwnedCardField(patch),
    );
    if (refusal) {
      showCardWriteRefusal(refusal);
      return;
    }
    // Optimistic merge so the UI updates instantly.
    set((s) => {
      const ws = s.byWorkspace[workspaceId];
      if (!ws) return s;
      const cards = ws.cards.map((c) =>
        c.id === cardId ? { ...c, ...patch, updatedAt: Date.now() } : c,
      );
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { ...ws, cards },
        },
      };
    });
    // v1.33.0: persist as a field-scoped patch. The backend ignores any
    // key that isn't a user-editable `CardPatch` field (run/verify/ship
    // state), so this can never clobber backend-owned data or another
    // card. Reconcile with the server-authoritative card on success.
    try {
      const updated = await kanbanCardPatch(workspaceId, cardId, patch);
      reconcileCard(workspaceId, updated);
    } catch (e) {
      console.error("kanban updateCard failed:", e);
      pushErrorToast("The change to the card wasn't saved", e, { then: "The card shows what's saved. Make the change again." });
      // Resync from disk so the FE doesn't keep a rejected optimistic state.
      await get().loadFromDisk(workspaceId, true);
    }
  },

  removeCard: async (cardId, opts) => {
    const found = findCard(get().byWorkspace, cardId);
    if (!found) return false;
    const { workspaceId } = found;
    const linkedSwarmIds = await preDeleteCascade(found.card, opts);
    // Optimistic removal.
    set((s) => {
      const ws = s.byWorkspace[workspaceId];
      if (!ws) return s;
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: {
            ...ws,
            cards: ws.cards.filter((c) => c.id !== cardId),
          },
        },
      };
    });
    // v1.33.0: card deletion is a granular backend command — was the FE
    // dropping the card from the vec and `kanban_save`ing the whole board.
    let outcome: CardDeleteOutcome;
    try {
      outcome = await kanbanCardDelete(workspaceId, cardId, opts?.worktree);
    } catch (e) {
      console.error("kanban removeCard failed:", e);
      pushErrorToast("The card wasn't deleted", e, { then: "It's still on the Board. Try again." });
      await get().loadFromDisk(workspaceId, true);
      return false;
    }
    reportWorktreeOutcome(outcome, opts?.worktree);
    await postDeleteGc(workspaceId, cardId, linkedSwarmIds);
    return true;
  },

  removeCardGithub: async (cardId, opts) => {
    const found = findCard(get().byWorkspace, cardId);
    if (!found) return false;
    const { workspaceId } = found;
    const linkedSwarmIds = await preDeleteCascade(found.card, opts);
    // v1.77.0: NOT optimistic — closing the issue round-trips GitHub, and a
    // refused close must leave the board visually untouched (the flicker of
    // remove-then-reload was half of the original double-message bug).
    let outcome: CardDeleteOutcome;
    try {
      outcome = await kanbanCardDeleteGithub(workspaceId, cardId, opts?.worktree);
    } catch (e) {
      console.error("kanban removeCardGithub failed:", e);
      pushErrorToast("The card wasn't deleted", e, { then: "It's still on the Board. Try again." });
      return false;
    }
    set((s) => {
      const ws = s.byWorkspace[workspaceId];
      if (!ws) return s;
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: {
            ...ws,
            cards: ws.cards.filter((c) => c.id !== cardId),
          },
        },
      };
    });
    reportWorktreeOutcome(outcome, opts?.worktree);
    await postDeleteGc(workspaceId, cardId, linkedSwarmIds);
    return true;
  },


  clearRunHistory: async (cardId) => {
    const found = findCard(get().byWorkspace, cardId);
    if (!found) return;
    try {
      await kanbanClearRunHistory(found.workspaceId, cardId);
    } catch (e) {
      console.error("kanban clearRunHistory failed:", e);
      return;
    }
    // Optimistic state update so the accordion empties immediately.
    set((s) => {
      const ws = s.byWorkspace[found.workspaceId];
      if (!ws) return s;
      const cards = ws.cards.map((c) =>
        c.id === cardId ? { ...c, runHistory: [], updatedAt: Date.now() } : c,
      );
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [found.workspaceId]: { ...ws, cards },
        },
      };
    });
  },

  restoreCard: async (cardId) => {
    const found = findCard(get().byWorkspace, cardId);
    if (!found) return null;
    const updated = await kanbanCardRestore(found.workspaceId, cardId);
    reconcileCard(found.workspaceId, updated);
    return updated;
  },

  archiveCard: async (cardId, opts) => {
    const found = findCard(get().byWorkspace, cardId);
    if (!found) return;
    try {
      const updated = await kanbanCardArchive(
        found.workspaceId,
        cardId,
        opts?.auto ?? false,
      );
      reconcileCard(found.workspaceId, updated);
    } catch (e) {
      console.error("kanban archiveCard failed:", e);
      throw e;
    }
  },

  setBoardOrder: async (cardId, boardOrder) => {
    const found = findCard(get().byWorkspace, cardId);
    if (!found) return;
    const { workspaceId } = found;
    reconcileCard(workspaceId, {
      ...found.card,
      boardOrder: boardOrder ?? undefined,
    });
    try {
      const updated = await kanbanCardSetBoardOrder(workspaceId, cardId, boardOrder);
      reconcileCard(workspaceId, updated);
    } catch (e) {
      pushErrorToast("The card didn't move", e, { then: "It's back where it was. Drag it again." });
      await get().loadFromDisk(workspaceId, true);
    }
  },

  refreshPr: async (workspaceId, cardId) => {
    const updated = await cardPrRefresh(workspaceId, cardId);
    reconcileCard(workspaceId, updated);
  },

  mergePr: async (workspaceId, cardId, githubHead) => {
    const result = await cardPrMerge(workspaceId, cardId, githubHead);
    reconcileCard(workspaceId, result.card);
    return result;
  },

  bringUpToDate: async (workspaceId, cardId) => {
    const result = await cardBringUpToDate(workspaceId, cardId);
    reconcileCard(workspaceId, result.card);
    return result;
  },

  setPrAutoMerge: async (workspaceId, cardId, on) => {
    const result = await cardPrSetAutoMerge(workspaceId, cardId, on);
    reconcileCard(workspaceId, result.card);
    return result;
  },

  pushPrUpdate: async (workspaceId, cardId, auto = false) => {
    const result = await cardPrPushUpdate(workspaceId, cardId, auto);
    reconcileCard(workspaceId, result.card);
    return result;
  },

  setPrAutoFix: async (workspaceId, cardId, on) => {
    reconcileCard(workspaceId, await cardSetPrAutoFix(workspaceId, cardId, on));
  },

  beginPrAutoFix: async (workspaceId, cardId, head) => {
    const result = await cardPrAutoFixBegin(workspaceId, cardId, head);
    reconcileCard(workspaceId, result.card);
    return result.begin;
  },

  stopPrAutoFix: async (workspaceId, cardId, head, reason, detail) => {
    reconcileCard(workspaceId, await cardPrAutoFixStop(workspaceId, cardId, head, reason, detail));
  },

  setBlockedBy: async (cardId, blockedBy) => {
    const found = findCard(get().byWorkspace, cardId);
    if (!found) return;
    const { workspaceId } = found;
    try {
      const updated = await kanbanCardSetBlockedBy(workspaceId, cardId, blockedBy);
      reconcileCard(workspaceId, updated);
    } catch (e) {
      await get().loadFromDisk(workspaceId, true);
      throw e;
    }
  },

  setBuilderVendorPref: async (workspaceId, cardId, vendor) => {
    const withPref = (pref: "claude" | "codex" | null | undefined) => {
      const current = cardInWorkspace(get().byWorkspace, workspaceId, cardId);
      if (current) reconcileCard(workspaceId, { ...current, builderVendorPref: pref ?? null });
    };
    withPref(vendor);
    try {
      const updated = await kanbanCardSetBuilderVendorPref(workspaceId, cardId, vendor);
      withPref(updated.builderVendorPref);
    } catch (e) {
      await get().loadFromDisk(workspaceId, true);
      throw e;
    }
  },

  setBuilderPermissions: async (workspaceId, cardId, permissions) => {
    const withChoice = (choice: "editsCopy" | "asks" | "neverAsks" | null | undefined) => {
      const current = cardInWorkspace(get().byWorkspace, workspaceId, cardId);
      if (current) reconcileCard(workspaceId, { ...current, builderPermissions: choice ?? null });
    };
    withChoice(permissions);
    try {
      const updated = await kanbanCardSetBuilderPermissions(workspaceId, cardId, permissions);
      withChoice(updated.builderPermissions);
    } catch (e) {
      await get().loadFromDisk(workspaceId, true);
      throw e;
    }
  },

  setCardModels: async (workspaceId, cardId, models) => {
    const take = (next: KanbanCard | null, change: WorkspaceModels | null) => {
      const current = cardInWorkspace(get().byWorkspace, workspaceId, cardId);
      if (!current) return;
      const builder =
        next && current.builder
          ? { ...current.builder, chosenModel: next.builder?.chosenModel ?? null }
          : current.builder;
      reconcileCard(workspaceId, { ...current, models: change, builder });
    };
    take(null, models);
    try {
      const updated = await kanbanCardSetModels(workspaceId, cardId, models);
      take(updated, updated.models ?? null);
    } catch (e) {
      await get().loadFromDisk(workspaceId, true);
      throw e;
    }
  },

  addLineComment: async (workspaceId, cardId, draft) => {
    takeLineComments(workspaceId, cardId, await cardLineCommentAdd(workspaceId, cardId, draft));
  },
  updateLineComment: async (workspaceId, cardId, commentId, body) => {
    takeLineComments(
      workspaceId,
      cardId,
      await cardLineCommentUpdate(workspaceId, cardId, commentId, body),
    );
  },
  removeLineComment: async (workspaceId, cardId, commentId) => {
    takeLineComments(workspaceId, cardId, await cardLineCommentRemove(workspaceId, cardId, commentId));
  },
  markLineCommentsSent: async (workspaceId, cardId, commentIds) => {
    takeLineComments(
      workspaceId,
      cardId,
      await cardLineCommentsMarkSent(workspaceId, cardId, commentIds),
    );
  },
  addLaterRequest: async (workspaceId, cardId, text, source) => {
    takeLaterRequests(workspaceId, cardId, await kanbanCardAddLaterRequest(workspaceId, cardId, text, source));
  },
  removeLaterRequest: async (workspaceId, cardId, requestId) => {
    takeLaterRequests(workspaceId, cardId, await kanbanCardRemoveLaterRequest(workspaceId, cardId, requestId));
  },

  moveCard: async (cardId, toColumn, opts) => {
    const found = findCard(get().byWorkspace, cardId);
    if (!found) return;
    const card = found.card;
    const redispatch =
      opts?.redispatch === true && toColumn === "in_progress" && card.columnId === "in_progress";
    if (card.columnId === toColumn && !redispatch) return;

    // v1.85.0 (team tier): a GH-backed board without a valid team key is
    // read-only — a local column write would silently diverge from the
    // issues. The escape is Settings → Kanban backing → Switch to Local.
    const refusal = cardWriteRefusal(card.workspaceId, true);
    if (refusal) {
      showCardWriteRefusal(refusal);
      return;
    }

    // v1.7.0: block dispatch-triggering moves while intake is active.
    // Without this guard, the swarm/agent would dispatch using the legacy
    // concat path (title + notes + knowledge) while the intake agent is
    // still asking the user clarifying questions — exactly the failure
    // mode the intake protocol exists to prevent.
    if (
      card.intakeStatus === "active" &&
      card.columnId === "todo" &&
      toColumn === "in_progress"
    ) {
      throw new Error(
        "Finish or stop planning before starting this card.",
      );
    }

    // Plan with two AIs, P1: the build waits for the card's exchange while
    // it runs or waits for the member (the backend refuses it too, on the
    // shared start path).
    if (
      card.columnId === "todo" &&
      toColumn === "in_progress" &&
      usePlanExchange.getState().openFor(card.workspaceId, card.id)
    ) {
      throw new Error(PLAN_BUILD_WAITS);
    }

    // N19: a follow-up card whose brief still asks "What should change
    // now:" with nothing after it doesn't start from the Board either (the
    // backend refuses it too, `KanbanStore::start_refusal`).
    if (card.columnId === "todo" && toColumn === "in_progress" && followUpAskEmpty(card, card.notes ?? "")) {
      pushToast({ kind: "warn", title: FOLLOW_UP_ASK_EMPTY, body: `Write it in “${card.title}”'s brief, then start it.` });
      return;
    }
    // 1.174.0 C4: nor a card made from a copy whose brief is empty.
    if (toColumn === "in_progress" && copyBriefEmpty(card, card.notes ?? "")) {
      pushToast({ kind: "warn", title: COPY_BRIEF_EMPTY, body: `Write it in “${card.title}”'s brief, then start it.` });
      return;
    }

    // v1.10.0 Cycle A: Todo → InProgress is an atomic backend operation
    // that ALSO creates a per-card git worktree. The returned card carries
    // `worktreePath` + `branchName`; for any other transition we patch the
    // `columnId` field directly.
    if (redispatch) {
      // Already In progress, with its worktree: straight to the dispatch.
    } else if (card.columnId === "todo" && toColumn === "in_progress") {
      // v1.57.0 (Cycle 3): on a GitHub-backed board the backend gates this
      // transition on the claim (issue assignee). A rejection is a HARD block
      // — falling back to a local `updateCard` would also flip the issue's
      // status label to in-progress without a real claim. So for GH-backed
      // workspaces we surface the error and abort instead of moving the card.
      const ws = useWorkspaces
        .getState()
        .workspaces.find((w) => w.id === card.workspaceId);
      const ghBacked = ws?.kanbanSyncMode === "githubIssues";
      // 1.173.0 (B3): a card with no area to start in asks first, before
      // any claim or worktree (the backend refuses it too).
      if (!(await ensureCardArea(card.workspaceId, cardId, "start"))) return;
      // U32: on a GitHub board the claim comes next and would stay behind.
      if (ghBacked) {
        const refusal = await projectFolderCheck(card.workspaceId).catch(() => null);
        if (refusal) {
          pushToast({ kind: "error", title: "Build not started", body: projectFolderWords(refusal) });
          return;
        }
      }
      // GH #66: a card someone else claimed asks before its worktree exists.
      if (
        ghBacked &&
        !(await get().confirmClaimBeforeStart(card.workspaceId, cardId))
      ) {
        return;
      }
      try {
        // SL-4: asked before the worktree exists, so the answer counts for
        // it; v1.154.1 (K1): a repository not set up is refused first —
        // n16: and is then set up once, and the move tried once more (the
        // question asked then, before the worktree).
        const updated = await startSettingUpOnce(
          async () => {
            await offerWorktreeEnvCopy(card.workspaceId, cardId);
            return kanbanCardAdvanceToInProgress(card.workspaceId, cardId);
          },
          () => autoSetUpForStart(card.workspaceId, cardId),
        );
        reconcileCard(card.workspaceId, updated);
      } catch (e) {
        // A plan refusal (a Team gate): nothing moved and nothing may move
        // by hand either (no fallback below); it is said its own way.
        if (showPlanRefusal(e)) return;
        // SL-4: the card moved and has its worktree, but the setup failed:
        // nothing is dispatched into it. The card shows the output with
        // Retry and Start anyway.
        if (isWorktreeSetupFailure(e)) {
          await get().loadFromDisk(card.workspaceId, true);
          const notice = setupRefusalNotice(e);
          pushToast({
            kind: "error",
            title: notice?.title ?? "Setup failed",
            body: notice?.body ?? "Nothing was started. Open the card to see the output, then Retry or Start anyway.",
            details: String((e as Error)?.message ?? e),
          });
          return;
        }
        if (ghBacked) {
          pushToast({
            kind: "error",
            title: "Move blocked",
            details: String((e as Error)?.message ?? e),
            ...(needsSetUp(e)
              ? {
                  body: "Set up this repository, then move the card again.",
                  action: setUpAction(card.workspaceId),
                }
              : {}),
          });
          throw e;
        }
        // Plan with two AIs, P1: the backend refused the start because the
        // card's exchange runs or waits (this window may not have read it
        // yet). A refusal, not a failure: no move by hand around it.
        if (String((e as Error)?.message ?? e).includes(PLAN_BUILD_WAITS)) throw e;
        console.error("kanban: advance to in_progress failed:", e);
        // Fall back so the card still moves; the worktree can be
        // retried from the Worktrees panel (Cycle B). n16: kept for a
        // repository the start couldn't set up on its own (a folder that
        // isn't a git repository, a feature branch checked out, shared
        // settings) — a local board's move there has always run without a
        // worktree, and a folder with no git has no other way to run.
        await get().updateCard(cardId, { columnId: toColumn });
      }
    } else {
      await get().updateCard(cardId, { columnId: toColumn });
    }

    // Todo → In Progress kicks off either a swarm or a single-agent run.
    // R10: backend defends against both being set; UI mutual exclusion above
    // makes that impossible in practice, but if someone constructs the JSON
    // by hand, swarm wins.
    const isStartTransition =
      (redispatch || card.columnId === "todo") &&
      toColumn === "in_progress" &&
      card.lastRunStatus !== "running";
    if (!isStartTransition) return;

    // v1.10.x Cycle A: re-read the post-advance card so the dispatch
    // path sees the freshly-stamped `worktreePath`. The local `card`
    // var was captured before kanbanCardAdvanceToInProgress ran.
    const advanced = findCard(get().byWorkspace, cardId)?.card ?? card;
    const worktreeCwd = advanced.worktreePath ?? null;

    // v1.36.0 (memory Increment 2): the FE no longer assembles the
    // dispatch prompt locally. The backend's
    // `card_compose_dispatch_prompt` is the single source of truth —
    // it concats title + notes + knowledge (or uses the
    // intake-finalized dispatchPrompt), appends attachments, AND
    // prepends the workspace memory-injection block. This eliminates
    // the FE↔backend lockstep that CLAUDE.md previously flagged
    // ("Card-driven Kanban runs use card content as the prompt …
    // kanbanStore.moveCard builds [title, notes, knowledge].filter
    // (present).join …"). If the backend call fails we fall back to
    // the legacy concat so dispatch is never blocked on a memory
    // hiccup; this fallback is best-effort and does NOT inject
    // memory — but at v1.36.0 ship this code path effectively never
    // fires (the IPC has no failure mode short of the card vanishing
    // between move and compose, which is a vanishingly rare race).
    let goalOrPrompt: string;
    try {
      goalOrPrompt = await cardComposeDispatchPrompt(
        card.workspaceId,
        cardId,
      );
    } catch (e) {
      // 1.175.0 (B3 round 2): a card of a GitHub issue carries the issue's
      // text, which only the backend hands over (quoted, its hidden parts
      // marked). No local assembly for it: the start fails with this error.
      if (card.ghIssueNumber) throw e;
      console.warn(
        "kanban.moveCard: card_compose_dispatch_prompt failed; falling back to local assembly without memory injection:",
        e,
      );
      if (card.dispatchPrompt && card.dispatchPrompt.trim().length > 0) {
        goalOrPrompt = card.dispatchPrompt;
      } else {
        const parts: string[] = [card.title];
        if (card.notes) parts.push(card.notes);
        if (card.knowledge) parts.push(card.knowledge);
        goalOrPrompt = parts.join("\n\n");
      }
      const atts = card.attachments ?? [];
      if (atts.length > 0) {
        const lines = atts.map((a) => `- ${a.storedPath}`);
        goalOrPrompt = `${goalOrPrompt}\n\nAttached files:\n${lines.join("\n")}`;
      }
    }

    // G4 (launch D8): a swarm starts again only on a card that already ran
    // one. A template on a card that never did is dropped by the backend
    // when the card starts, and nothing is dispatched for it here.
    const swarmTemplateId = swarmTemplateInUse(card) ? card.swarmTemplateId : null;
    if (swarmTemplateId) {
      // v1.30.0 (parallel swarms): if the workspace is already at its
      // card-swarm cap, do NOT dispatch — leave the card In Progress with
      // linkedSwarmId null. The In Progress column is the queue; the backend
      // pump auto-starts the card when a running swarm frees a slot, and the
      // "Queued" badge surfaces the wait. The pre-check is best-effort: if it
      // fails, fall through and let the backend gate decide.
      try {
        const slot = await swarmCardSlotStatus(card.workspaceId);
        if (slot.runningCardSwarms + slot.suspendedCardSwarms >= slot.cap) {
          // G4: only a card that ran a swarm gets here, and it still links
          // that old swarm — which keeps it out of the queue the pump reads
          // (`card_is_queue_eligible`). Unlink it, so it really waits.
          // Known limit (no new persisted field in G4): once unlinked, the
          // card no longer records that it ran a swarm. Moved back to Todo
          // before the pump starts it, its template then reads as never
          // run and is dropped at the next start — it is built by the
          // Builder, never by a new swarm.
          if (card.linkedSwarmId || card.lastRunStatus) {
            await persistRunState(card.workspaceId, cardId, {
              linkedSwarmId: null,
              linkedRunId: null,
              lastRunStatus: null,
            });
          }
          pushToast({
            kind: "info",
            title: "Card queued",
            body: `This project already runs ${slot.cap} multi-AI ${slot.cap === 1 ? "card" : "cards"}, its limit. This card starts by itself when one finishes.`,
          });
          return;
        }
      } catch (e) {
        console.error("kanban: card-swarm slot check failed:", e);
      }
      // v1.53.0 (Team Mode Phase 2.4): role-binding preflight. If
      // this template references any role that the current
      // workspace hasn't bound to an agent, refuse to dispatch and
      // surface the missing role names. Catches the footgun where
      // a teammate-authored shared swarm template references role
      // ids that haven't been bound on this user's machine yet —
      // without the gate, the dispatch would fail mid-stream with
      // a confusing error. The same gate also catches a personal
      // template that was never bound (rare but possible).
      try {
        const wsCwd =
          useWorkspaces
            .getState()
            .workspaces.find((w) => w.id === card.workspaceId)?.cwd ?? null;
        const unbound = await swarmTemplateUnboundRoles(
          swarmTemplateId,
          card.workspaceId,
          wsCwd,
        );
        if (unbound.length > 0) {
          const roleNames = unbound.map((u) => u.role).join(", ");
          const suggestionLines = unbound
            .filter((u) => u.suggestedAgentName)
            .map((u) => `  ${u.role} → ${u.suggestedAgentName}`)
            .join("\n");
          // GH #171: Settings › Role bindings is retired, so the toast no
          // longer sends anyone there. A built-in template binds its own
          // roles on first run; a shared one naming a role this workspace
          // has no agent for cannot run here.
          const body = suggestionLines
            ? `This multi-AI template names roles this workspace has no agent for:\n${suggestionLines}\n\n(Suggestions from .atelier/agents/.) Choose a built-in template, or run the card with the Builder.`
            : `This multi-AI template names roles this workspace has no agent for: ${roleNames}. Choose a built-in template, or run the card with the Builder.`;
          pushToast({
            kind: "warn",
            title: "The multi-AI run needs its roles set",
            body,
          });
          await persistRunState(card.workspaceId, cardId, {
            lastRunStatus: null,
            linkedSwarmId: null,
            linkedRunId: null,
          });
          return;
        }
      } catch (e) {
        // Preflight is best-effort. If it fails, fall through and
        // let the backend gate the dispatch with whatever error
        // it would have raised — keep the kanban responsive.
        console.error("kanban: unbound-roles preflight failed:", e);
      }
      try {
        // v1.5.8: pass the card's swarmTemplateId through. Without this,
        // the kanban-driven swarm path always fell back to swarmStore's
        // "feature" default — silently misrouting cards that explicitly
        // requested refactor / ux-audit / coordinator-feature templates.
        const swarm = await useSwarms
          .getState()
          .start(
            card.workspaceId,
            goalOrPrompt,
            swarmTemplateId,
            worktreeCwd,
            "card",
            cardId,
          );
        // v1.33.0: backend-owned run-link fields — set via the granular
        // `set_run_state` command, not a whole-card patch.
        await persistRunState(card.workspaceId, cardId, {
          linkedSwarmId: swarm.id,
          linkedRunId: null,
          lastRunStatus: "running",
        });
      } catch (e) {
        // v1.30.0: an over-cap rejection can still race in here between the
        // pre-check and dispatch — treat that as "queued", not "failed".
        if (String(e).includes("start automatically when a slot frees")) {
          // G4: as at the pre-check — the old swarm's link would keep it
          // out of the queue (same known limit as there).
          await persistRunState(card.workspaceId, cardId, {
            linkedSwarmId: null,
            linkedRunId: null,
            lastRunStatus: null,
          });
          pushToast({
            kind: "info",
            title: "Card queued",
            body: "This project already runs as many multi-AI cards as it can. This card starts by itself when one finishes.",
          });
          return;
        }
        const executionRefusal = cardExecutionRefusalMessage(e);
        if (executionRefusal) {
          pushToast({
            kind: "warn",
            title: "Card work is waiting",
            body: executionRefusal,
          });
          return;
        }
        console.error("kanban: swarm start failed:", e);
        pushErrorToast("The card didn't start", e);
        await persistRunState(card.workspaceId, cardId, {
          lastRunStatus: "failed",
        });
      }
    } else if (card.agentConfigId) {
      try {
        const ws = useWorkspaces
          .getState()
          .workspaces.find((w) => w.id === card.workspaceId);
        const agentList =
          useAgents.getState().byWorkspace[card.workspaceId]?.agents ?? [];
        const agent = agentList.find((a) => a.id === card.agentConfigId);
        if (!ws || !agent) {
          console.warn("kanban: agent or workspace missing on move");
          return;
        }
        const request = {
          agentId: agent.id,
          scope: agent.scope,
          workspaceId: card.workspaceId,
          projectCwd: worktreeCwd ?? ws.cwd,
          promptOverride: goalOrPrompt,
          cardId,
        };
        const result = await agentRunRequest(request);
        if (result.kind === "busy") {
          const receipt = await agentRunQueue(request);
          set((state) => ({
            writerQueueByCard: {
              ...state.writerQueueByCard,
              [cardId]: { ...receipt, workspaceId: card.workspaceId },
            },
          }));
          pushToast({
            kind: "info",
            title: "Card queued",
            body: `Another writer is active in this card's copy. Queue position ${receipt.position}.`,
          });
          return;
        }
        const run = result.run;
        set((state) => {
          if (!state.writerQueueByCard[cardId]) return state;
          const next = { ...state.writerQueueByCard };
          delete next[cardId];
          return { writerQueueByCard: next };
        });
        await persistRunState(card.workspaceId, cardId, {
          linkedRunId: run.id,
          lastRunStatus: "running",
        });
      } catch (e) {
        const executionRefusal = cardExecutionRefusalMessage(e);
        if (executionRefusal) {
          pushToast({
            kind: "warn",
            title: "Card work did not start",
            body: executionRefusal,
          });
          return;
        }
        console.error("kanban: agentRunStart failed:", e);
        pushErrorToast("The card didn't start", e);
        await persistRunState(card.workspaceId, cardId, {
          lastRunStatus: "failed",
        });
      }
    }
  },

  addAttachmentFromBytes: async (cardId, name, bytes) => {
    const found = findCard(get().byWorkspace, cardId);
    if (!found) throw new Error("card not found");
    const att = await kanbanAttachmentAddFromBytes(
      found.workspaceId,
      cardId,
      name,
      bytes,
    );
    set((s) => {
      const ws = s.byWorkspace[found.workspaceId];
      if (!ws) return s;
      const cards = ws.cards.map((c) =>
        c.id === cardId
          ? {
              ...c,
              attachments: [...(c.attachments ?? []), att],
              updatedAt: Date.now(),
            }
          : c,
      );
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [found.workspaceId]: { ...ws, cards },
        },
      };
    });
    return att;
  },

  addAttachmentFromPath: async (cardId, sourcePath) => {
    const found = findCard(get().byWorkspace, cardId);
    if (!found) throw new Error("card not found");
    const att = await kanbanAttachmentAddFromPath(
      found.workspaceId,
      cardId,
      sourcePath,
    );
    set((s) => {
      const ws = s.byWorkspace[found.workspaceId];
      if (!ws) return s;
      const cards = ws.cards.map((c) =>
        c.id === cardId
          ? {
              ...c,
              attachments: [...(c.attachments ?? []), att],
              updatedAt: Date.now(),
            }
          : c,
      );
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [found.workspaceId]: { ...ws, cards },
        },
      };
    });
    return att;
  },

  removeAttachment: async (cardId, attachmentId) => {
    const found = findCard(get().byWorkspace, cardId);
    if (!found) return;
    await kanbanAttachmentRemove(found.workspaceId, cardId, attachmentId);
    set((s) => {
      const ws = s.byWorkspace[found.workspaceId];
      if (!ws) return s;
      const cards = ws.cards.map((c) =>
        c.id === cardId
          ? {
              ...c,
              attachments: (c.attachments ?? []).filter(
                (a) => a.id !== attachmentId,
              ),
              updatedAt: Date.now(),
            }
          : c,
      );
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [found.workspaceId]: { ...ws, cards },
        },
      };
    });
  },

  revealAttachment: async (storedPath) => {
    await kanbanAttachmentReveal(storedPath);
  },

  openAttachment: async (storedPath) => {
    await kanbanAttachmentOpen(storedPath);
  },
}));

// Subscribe once at module load to advance cards on run completion and to
// keep every open kanban view in sync via the `kanban://changed` event.
let runDoneSubscribed = false;

/** v1.33.0: per-workspace debounce timers for the `kanban://changed`
 *  reload — collapse a burst of backend writes into one board reload. */
const kanbanReloadTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function startKanbanSubscriptions(): void {
  if (runDoneSubscribed) return;
  runDoneSubscribed = true;
  // A new card worktree started from local main (offline) or from origin
  // over a diverged local main — say so; the header keeps the base visible.
  onWorktreeBaseNotice((notice) => {
    const toast = worktreeBaseNoticeToast(notice);
    if (toast) pushToast(toast);
  }).catch((err) => {
    console.error("kanban: onWorktreeBaseNotice subscription failed:", err);
  });
  // SL-4: a setup command can take minutes; say what the start waits for.
  onWorktreeSetupStarted((e) => {
    const card = useKanban.getState().byWorkspace[e.workspaceId]?.cards.find((c) => c.id === e.cardId);
    const toast = setupStartedToast(e, card);
    if (toast) pushToast({ kind: "info", ...toast });
  }).catch((err) => {
    console.error("kanban: onWorktreeSetupStarted subscription failed:", err);
  });
  onAgentRunDone((e) => {
    const all = useKanban.getState().byWorkspace;
    for (const [wsId, ws] of Object.entries(all)) {
      for (const card of ws.cards) {
        if (card.linkedRunId !== e.runId) continue;
        const success = e.status === "done";
        // Successful runs in In Progress auto-advance to Complete (the
        // dedicated In Review column was retired in v1.10.x). v1.33.0: the
        // column move is a field-scoped `CardPatch`; the run status is a
        // `RunStatePatch` — each is its own atomic backend write, so
        // neither can clobber the run_history entry the backend just
        // appended. The old `refreshThenPatch` board reload is gone.
        if (success && card.columnId === "in_progress") {
          void useKanban.getState().updateCard(card.id, {
            columnId: "complete",
          });
        }
        void persistRunState(wsId, card.id, {
          lastRunStatus: success ? "success" : "failed",
        });
      }
    }
  }).catch((err) => {
    console.error("kanban: onAgentRunDone subscription failed:", err);
    runDoneSubscribed = false;
  });

  // v1.0 Swarm: when a swarm terminates, advance any card linked to it
  // per the §6.5 mapping. We listen to mailbox terminate events (mailbox is
  // the source of truth) and look up the swarm's terminal status to pick the
  // right column.
  onSwarmMailbox((entry) => {
    if (entry.kind !== "terminate") return;
    const matched: { cardId: string; workspaceId: string }[] = [];
    for (const [wsId, ws] of Object.entries(useKanban.getState().byWorkspace)) {
      for (const card of ws.cards) {
        if (card.linkedSwarmId === entry.swarmId) {
          matched.push({ cardId: card.id, workspaceId: wsId });
        }
      }
    }
    if (matched.length === 0) return;
    void swarmGet(entry.swarmId).then((swarm) => {
      if (!swarm) return;
      for (const m of matched) {
        applySwarmTerminalToCard(
          m.workspaceId,
          m.cardId,
          swarm.status,
          swarm.throttled ?? false,
        );
      }
    });
  }).catch((err) => {
    console.error("kanban: onSwarmMailbox subscription failed:", err);
  });

  // v1.33.0: the backend emits `kanban://changed` after every card
  // mutation (IPC commands + run-history append + swarm completion +
  // queue pump). Reload the affected workspace so a board open in another
  // view never goes stale. Debounced because a burst of backend writes
  // (e.g. a swarm finishing) can fire several events in quick succession;
  // a reload after the FE's own mutation is a harmless no-op since the
  // optimistic state already matches.
  onKanbanChanged((workspaceId) => {
    // Skip workspaces the FE has never loaded — nothing to keep fresh.
    if (!useKanban.getState().byWorkspace[workspaceId]) return;
    const pending = kanbanReloadTimers.get(workspaceId);
    if (pending) clearTimeout(pending);
    kanbanReloadTimers.set(
      workspaceId,
      setTimeout(() => {
        kanbanReloadTimers.delete(workspaceId);
        void useKanban.getState().loadFromDisk(workspaceId, true);
      }, 150),
    );
  }).catch((err) => {
    console.error("kanban: onKanbanChanged subscription failed:", err);
  });
}

/**
 * v1.0 R4: terminal-state → column mapping for swarm-driven cards.
 *
 * | Swarm status | Column        | Badge |
 * |--------------|---------------|-------|
 * | done         | complete      | ✓     |
 * | max_iter     | in_progress   | ✗     |
 * | failed       | in_progress   | ✗     |
 * | timed_out    | in_progress   | ✗     |
 * | aborted      | (no auto-move)| —     |
 */
function applySwarmTerminalToCard(
  workspaceId: string,
  cardId: string,
  status: SwarmStatus,
  throttled: boolean,
): void {
  const found = findCard(useKanban.getState().byWorkspace, cardId);
  if (!found) return;
  let nextColumn: KanbanColumnId | null;
  let nextStatus: "success" | "failed" | "aborted" | "rate_limited";
  // v1.31.0 (Cycle 1): a throttled run is distinct from a genuine failure
  // — the card reads "rate-limited" and stays queue-eligible for retry.
  const failStatus = throttled ? "rate_limited" : "failed";
  switch (status) {
    case "done":
      nextColumn = "complete";
      nextStatus = "success";
      break;
    case "max_iter":
    case "timed_out":
      nextColumn = "in_progress";
      nextStatus = failStatus;
      break;
    case "failed":
      nextColumn = "in_progress";
      nextStatus = failStatus;
      break;
    case "aborted":
      // Aborted by the user — stay put per §6.5. The badge shows
      // "aborted", distinct from a genuine failure (v1.30.0).
      nextColumn = null;
      nextStatus = "aborted";
      break;
    case "running":
      // Shouldn't reach here — defensive.
      nextColumn = null;
      nextStatus = "failed";
      break;
    case "suspended":
      // v1.1.0 (resumable swarms): Suspended is non-terminal. Don't move
      // the card; clear the running status so the badge shows "paused"
      // (mapped in R8). The guided resume action is a Part 3 state-machine
      // decision; the backend/store capability remains. Reaching here on a
      // status: "suspended" event is expected when a swarm is orphaned by
      // app exit and reconcile flips it to Suspended.
      nextColumn = null;
      nextStatus = "failed";
      break;
  }
  // v1.33.0: column move via a field-scoped `CardPatch`, run status via a
  // `RunStatePatch` — each an atomic backend write. Replaces the old
  // `refreshThenPatch` board reload that existed only to dodge the
  // whole-board clobber.
  if (nextColumn) {
    void useKanban.getState().updateCard(cardId, { columnId: nextColumn });
  }
  void persistRunState(workspaceId, cardId, { lastRunStatus: nextStatus });
}
