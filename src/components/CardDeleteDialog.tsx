import { useRef, useState, type ReactNode } from "react";
import { useKanban, type KanbanCard } from "../store/kanbanStore";
import { useSwarms } from "../store/swarmStore";
import { openCenterMode, useUi } from "../store/uiStore";
import { pushToast } from "../store/toastStore";
import { deferCardRemoval } from "../store/boardStore";
import { sayArchived } from "../lib/leaveCard";
import { CBtn, Details, Sheet } from "./ux";
import {
  kanbanCardWorktreeState,
  type CardWorktreeState,
  type WorktreeChoice,
} from "../ipc";
import {
  deleteBlockedReason,
  deleteBranchNote,
  deleteChoices,
  deleteCommitLines,
  deleteFolderLine,
  DELETE_KEEPS_HISTORY,
  deleteNote,
  deleteRecoveryNote,
  deleteWarning,
  killRunDefault,
  stillReading,
} from "../lib/cardDeleteSheet";
import { machineWords } from "../lib/platform";
import { deleteClaimWarning } from "../lib/cardClaim";
import { claimLoginNow } from "./CardClaimChip";
import { pushErrorToast } from "../lib/errorToast";

/**
 * v1.31.0: shared card-delete flow.
 *
 * Card deletion has non-trivial cascade logic — an intake-active guard,
 * detection of a still-running agent run and/or a linked running
 * swarm/brainstorm, and an opt-out modal with checkboxes so the user can
 * refuse to kill collateral state. That flow used to live inline in
 * `CardDetailPanel` as the only delete entry point. v1.31.0 adds a
 * right-click "Delete card" item on the Kanban board (`KanbanBoard.tsx`),
 * which must behave *identically*. Rather than duplicate ~60 lines of
 * cascade detection + modal across two call sites that would inevitably
 * drift, the flow is extracted here as a hook both consume.
 *
 * Usage:
 *   const { requestDelete, dialog } = useCardDelete();
 *   ...
 *   <button onClick={() => requestDelete(card)}>Delete card</button>
 *   {dialog}
 */

type DeleteDialogState = {
  // The card being deleted is captured at requestDelete() time so the
  // dialog and performDelete don't depend on a `card` prop that may
  // change (or vanish) while the modal is open.
  card: KanbanCard;
  hasRunningRun: boolean;
  hasRunningSwarm: false | { kind: "brainstorm" | "card" };
  killRun: boolean;
  abortSwarm: boolean;
  // v1.77.0: the GH-backed "Close issue & delete" path round-trips GitHub,
  // so the dialog stays open with the buttons disabled while it runs.
  busy: boolean;
  // GH #116: the card's Builder worktree, read while the sheet is open.
  // `null` until it arrives — the destructive buttons wait for it, so no
  // delete can run before we know what it would remove.
  worktree: CardWorktreeState | null;
};

/** Long card titles (paths, pasted errors) made the modal body unreadable. */
function truncateTitle(title: string, max = 100): string {
  return title.length <= max ? title : `${title.slice(0, max - 1)}…`;
}

export type UseCardDelete = {
  /**
   * Open the delete-confirm dialog for `card`. No-op (shows an error
   * toast) if the card has an active intake conversation.
   */
  requestDelete: (card: KanbanCard) => void;
  /** The confirm-modal JSX. Render it somewhere in the consumer's tree. */
  dialog: ReactNode;
};

export function useCardDelete(): UseCardDelete {
  const removeCard = useKanban((s) => s.removeCard);
  const removeCardGithub = useKanban((s) => s.removeCardGithub);
  const archiveCard = useKanban((s) => s.archiveCard);
  const [state, setState] = useState<DeleteDialogState | null>(null);
  // Destructive: focus opens on Cancel — never on the lead Delete, which
  // comes first in the foot (SHEET.md "ConfirmSheet").
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  function requestDelete(card: KanbanCard) {
    if (card.intakeStatus === "active") {
      // The original inline flow used `alert()` here, but native
      // `window.alert()` is silently auto-accepted by Tauri 2's
      // WKWebView (see the v1.29.0 note in CardDetailPanel) — it
      // renders nothing, so the guard message never reached the user
      // and the card just silently failed to delete. A toast is the
      // only surface that actually shows here.
      pushToast({
        kind: "error",
        title: "Cannot delete card",
        body: "This card's planning conversation is still going. Stop planning first, then delete.",
      });
      return;
    }
    const hasRunningRun = Boolean(
      card.lastRunStatus === "running" && card.linkedRunId,
    );
    const linkedSwarmId =
      card.linkedBrainstormId ?? card.linkedSwarmId ?? null;
    let hasRunningSwarm: DeleteDialogState["hasRunningSwarm"] = false;
    if (linkedSwarmId) {
      const linkedSwarm = useSwarms
        .getState()
        .byWorkspace[card.workspaceId]?.swarms.find(
          (s) => s.id === linkedSwarmId,
        );
      const running =
        linkedSwarm &&
        (linkedSwarm.status === "running" ||
          linkedSwarm.status === "suspended");
      if (running && linkedSwarm) {
        hasRunningSwarm = {
          kind: linkedSwarm.kind === "brainstorm" ? "brainstorm" : "card",
        };
      }
    }
    setState({
      card,
      hasRunningRun,
      hasRunningSwarm,
      // Default both side-effect checkboxes to ON — the common case is
      // "yes, kill collateral state too". The user must explicitly
      // uncheck to opt out (and trigger the backend's refuse-when-
      // running path for the still-running-swarm case).
      killRun: hasRunningRun,
      abortSwarm: Boolean(hasRunningSwarm),
      busy: false,
      worktree: null,
    });
    // GH #116: what deleting this card would take with it. The sheet is
    // already up — this fills in the warning (and unlocks the buttons)
    // when the answer lands, keyed to the card it was asked about.
    void kanbanCardWorktreeState(card.workspaceId, card.id)
      .then((worktree) =>
        setState((cur) =>
          cur && cur.card.id === card.id
            ? {
                ...cur,
                worktree,
                killRun: killRunDefault(cur, worktree),
              }
            : cur,
        ),
      )
      .catch((e: unknown) => {
        console.error("kanban: reading the card's worktree failed:", e);
        // Unknown is not "safe": the sheet asks rather than guess.
        setState((cur) =>
          cur && cur.card.id === card.id
            ? {
                ...cur,
                worktree: {
                  disposition: "ask",
                  path: null,
                  branch: null,
                  dirtyFiles: 0,
                  unpushedCommits: 0,
                  liveSession: false,
                  unreadable: true,
                  busy: null,
                  cardBranch: null,
                  cardBranchCommits: 0,
                },
              }
            : cur,
        );
      });
  }

  /** Shared post-delete cleanup: leave the card-detail surface only if it
   *  was showing the card we just deleted, then land on Board mode. */
  function afterDelete(d: DeleteDialogState) {
    const ui = useUi.getState();
    if (ui.selectedCardId[d.card.workspaceId] === d.card.id) {
      ui.selectCard(d.card.workspaceId, null, false);
      // v1.71.0 (step 5b-1): kanban tab retired — land on Board mode.
      openCenterMode(d.card.workspaceId, "board");
    }
  }

  /** v1.77.0: the GH-backed path — close the issue, then delete. UX-5.9:
   *  like the local delete, the card leaves at once with an Undo and the
   *  issue is closed only when the Undo window ends; a refusal then toasts
   *  its reason (removeCardGithub) and the card is back on the Board. */
  function performCloseAndDelete(
    d: DeleteDialogState,
    worktree: WorktreeChoice,
  ) {
    setState(null);
    afterDelete(d);
    deferCardRemoval({
      cardId: d.card.id,
      kind: "delete",
      title: "Card deleted",
      body: `${truncateTitle(d.card.title)} · closes issue #${d.card.ghIssueNumber}`,
      commit: () =>
        removeCardGithub(d.card.id, {
          alsoKillRun: d.killRun,
          alsoAbortSwarm: d.abortSwarm,
          worktree,
        }),
    });
  }

  /** v1.77.0: the in-dialog Archive fallback for GH-backed cards — the
   *  card hides locally, the issue stays untouched on GitHub. */
  async function performArchive(d: DeleteDialogState) {
    setState({ ...d, busy: true });
    try {
      await archiveCard(d.card.id);
    } catch (e) {
      pushErrorToast("The card wasn't archived", e, { then: "It's still in its column. Try again." });
      setState({ ...d, busy: false });
      return;
    }
    setState(null);
    afterDelete(d);
    // 1.175.0 (D2): archived, and the member's own name is off the issue.
    await sayArchived(d.card.workspaceId, d.card.id, truncateTitle(d.card.title));
  }

  /** UX-5.9: the card leaves the Board at once and the toast offers Undo
   *  for 8 s; the delete — final: it takes the worktree as chosen and the
   *  attachments — runs only when that window ends. A refusal then is
   *  toasted by removeCard, which reloads the board. */
  function performDelete(d: DeleteDialogState, worktree: WorktreeChoice) {
    setState(null);
    afterDelete(d);
    deferCardRemoval({
      cardId: d.card.id,
      kind: "delete",
      title: "Card deleted",
      body: truncateTitle(d.card.title),
      commit: () =>
        removeCard(d.card.id, {
          alsoKillRun: d.killRun,
          alsoAbortSwarm: d.abortSwarm,
          worktree,
        }),
    });
  }

  /** The sheet's one confirm: the GH-backed path closes the issue first,
   *  both carry the same answer about the card's Builder worktree. */
  function confirmDelete(d: DeleteDialogState, worktree: WorktreeChoice) {
    return d.card.ghIssueNumber != null
      ? performCloseAndDelete(d, worktree)
      : performDelete(d, worktree);
  }

  // v1.77.0: a card backed by a GitHub issue can't be hard-deleted locally
  // (it would resurrect on reconcile) — the dialog says so upfront and offers
  // the two real options instead of failing after the confirm.
  const ghBacked = state ? state.card.ghIssueNumber != null : false;

  // GH #116: the card's Builder worktree. `null` while it is being read —
  // no destructive button is live until it lands, so nothing is removed
  // before we know what removing it would cost. `ask` means the folder
  // holds work that exists nowhere else: the sheet offers the two
  // explicit choices instead of the single Delete.
  const wt = state?.worktree ?? null;
  const reading = state != null && stillReading(wt);
  const warning = deleteWarning(wt);
  const recovery = deleteRecoveryNote(wt);
  const folder = deleteFolderLine(wt);
  const branchNote = deleteBranchNote(wt);
  const commitLines = deleteCommitLines(wt);
  // The kill-run box is part of the decision: with it ticked, the delete
  // stops the card's own run before it starts, so the sheet is not
  // blocked by it.
  const killRun = state?.killRun ?? false;
  const note = deleteNote(wt, killRun);
  const blocked = deleteBlockedReason(wt, killRun);
  const choices = deleteChoices(wt, ghBacked, killRun);
  // A run the read found but the card's mirrored status did not: the box
  // must still be there, or the sheet would block with nothing to tick.
  const showKillRun =
    (state?.hasRunningRun ?? false) || wt?.busy?.kind === "run";

  // GH #276: over work that exists only here, the choice that loses it
  // is the sheet's lead action — on the left, apart from Cancel and the
  // safe choice — so the foot stays one row. A lone Delete stays the
  // primary on the right.
  const split = choices.length > 1;
  const choiceButton = (c: (typeof choices)[number]) => (
    <CBtn
      key={c.choice}
      tone={c.destructive ? "danger" : "ghost"}
      className={c.destructive ? "ux-danger-fill" : undefined}
      disabled={state?.busy || reading}
      onClick={() => state && void confirmDelete(state, c.choice)}
    >
      {state?.busy && c.destructive
        ? ghBacked
          ? "Closing issue…"
          : "Deleting…"
        : reading
          ? "Checking…"
          : c.label}
    </CBtn>
  );

  // U9: a teammate's claim, before the press that closes their issue.
  const claimWarning =
    state && ghBacked ? deleteClaimWarning(state.card.ghAssignees, claimLoginNow(state.card.workspaceId)) : null;

  const dialog = state ? (
    <Sheet
      title="Delete card?"
      lede={`“${truncateTitle(state.card.title)}”`}
      size={split && ghBacked ? "review" : "confirm"}
      onClose={() => setState(null)}
      canDismiss={!state.busy}
      initialFocusRef={cancelRef}
      leadAction={split ? choices.filter((c) => c.destructive).map(choiceButton) : undefined}
      actions={
        <>
          <CBtn ref={cancelRef} disabled={state.busy} onClick={() => setState(null)}>
            {blocked ? "Close" : "Cancel"}
          </CBtn>
          {ghBacked && (
            <CBtn
              disabled={state.busy}
              onClick={() => void performArchive(state)}
              title="Hide the card locally; the GitHub issue stays untouched"
            >
              Archive
            </CBtn>
          )}
          {/* GH #116: over work that exists only here, the single Delete
              is replaced by the two explicit choices. Nothing unpushed is
              ever removed without the second one, and no button is live
              until the worktree read lands. */}
          {(split ? choices.filter((c) => !c.destructive) : choices).map(choiceButton)}
        </>
      }
    >
      {ghBacked && (
        <p className="ux-sheet-hint">
          This card is backed by GitHub issue #{state.card.ghIssueNumber}.
          Deleting it here also closes the issue — otherwise the next sync
          would recreate the card. Archiving hides the card locally and
          leaves the issue untouched.
        </p>
      )}
      {claimWarning && <p className="ux-sheet-text">{claimWarning}</p>}
      {blocked && <p className="ux-sheet-alert">{machineWords(blocked)}</p>}
      {warning && <p className="ux-sheet-text">{machineWords(warning)}</p>}
      {branchNote && <p className="ux-sheet-text">{machineWords(branchNote)}</p>}
      {note && <p className="ux-sheet-hint">{machineWords(note)}</p>}
      {!blocked && <p className="ux-sheet-hint">{DELETE_KEEPS_HISTORY}</p>}
      {/* GH #276: where the folder is and what the trash keeps — the
          second layer, behind Details. */}
      {(folder || recovery || commitLines.length > 0) && (
        <Details>
          {commitLines.map((line, i) => (
            <span key={`commit-${i}`} className="ux-details-line">
              {line}
            </span>
          ))}
          {folder && <span className="ux-details-line">{folder}</span>}
          {recovery && <span className="ux-details-line">{recovery}</span>}
        </Details>
      )}
      {showKillRun && (
        <label className="ux-sheet-check">
          <input
            type="checkbox"
            checked={state.killRun}
            disabled={state.busy}
            onChange={(e) => setState({ ...state, killRun: e.target.checked })}
          />
          Also kill the running agent on this card
        </label>
      )}
      {state.hasRunningSwarm && (
        <label className="ux-sheet-check">
          <input
            type="checkbox"
            checked={state.abortSwarm}
            disabled={state.busy}
            onChange={(e) =>
              setState({ ...state, abortSwarm: e.target.checked })
            }
          />
          Also abort the linked {state.hasRunningSwarm.kind} that is still
          running
        </label>
      )}
      {state.hasRunningSwarm && !state.abortSwarm && (
        <p className="ux-sheet-hint">
          {machineWords(
            `Left running, the ${state.hasRunningSwarm.kind} keeps its folder on this Mac.`,
          )}
        </p>
      )}
    </Sheet>
  ) : null;

  return { requestDelete, dialog };
}
