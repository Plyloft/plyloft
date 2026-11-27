import { invoke } from "@tauri-apps/api/core";
import type { KanbanCard } from "../ipc";
import { pushToast } from "../store/toastStore";
import { useKanban } from "../store/kanbanStore";
import {
  changedAgainNotice,
  COPY_MINE_LABEL,
  droppedNotice,
  keptMineNotice,
  notRecordedNotice,
  type EditConflict,
  type EditResolved,
} from "./editConflict";

// 1.175.0 (D3): the card's notice was answered — *Use GitHub's* or *Keep
// mine* for its title or its brief (`issue_edit.rs::card_edit_conflict_resolve`).

/** Answer the question as it was shown (`conflict.theirs`). The backend
 *  reads the issue again first: if GitHub's version changed since, nothing
 *  is written and the question shows the new one. */
export function cardEditConflictResolve(workspaceId: string, cardId: string, conflict: EditConflict, keep: "github" | "mine") {
  return invoke<{ outcome: EditResolved; card: KanbanCard }>("card_edit_conflict_resolve", {
    workspaceId,
    cardId,
    part: conflict.part,
    keep,
    shown: conflict.theirs,
  });
}

/** The press: answer, read the card again, and say what happened. */
export async function answerEditConflict(
  card: Pick<KanbanCard, "workspaceId" | "id" | "title" | "notes" | "ghIssueNumber">,
  conflict: EditConflict,
  keep: "github" | "mine",
): Promise<void> {
  const mine = conflict.part === "title" ? card.title : (card.notes ?? "");
  let outcome: EditResolved;
  try {
    outcome = (await cardEditConflictResolve(card.workspaceId, card.id, conflict, keep)).outcome;
  } catch (e) {
    pushToast(notRecordedNotice(String((e as Error | null)?.message ?? e)));
    return;
  }
  await useKanban.getState().loadFromDisk(card.workspaceId, true);
  if (outcome === "changed_again") {
    pushToast(changedAgainNotice(conflict.part));
  } else if (outcome === "kept_mine") {
    pushToast(keptMineNotice(conflict, card.ghIssueNumber, Date.now()));
  } else if (outcome === "kept_github") {
    pushToast({
      ...droppedNotice(conflict.part),
      // What the member wrote is one press away, nowhere else.
      action: { label: COPY_MINE_LABEL, onClick: () => void navigator.clipboard?.writeText(mine) },
    });
  }
}
