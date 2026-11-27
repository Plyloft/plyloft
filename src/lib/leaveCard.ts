import { invoke } from "@tauri-apps/api/core";
import type { KanbanCard } from "../ipc";
import { pushToast } from "../store/toastStore";
import { useIdentity } from "../store/identityStore";
import { useWorkspaces } from "../store/workspaceStore";
import {
  archiveNameKeptNotice,
  archivedNotice,
  movedBackNotice,
  ownNameComesOff,
  startStoppedNotice,
  type NameOffOutcome,
} from "./cardClaim";

// 1.175.0 (D2; owner, 2026-11-09): leaving a card on a GitHub Issues board —
// Move back, Stop during the start, Archive — takes the member's own name
// off its issue (`leave_issue.rs`). The backend does it inside the gesture;
// here is what the gesture then says, in the words of `cardClaim.ts`.

/** What became of the member's name when the card was last left, once;
 *  `null` when nothing was asked of GitHub (a local board, a card that
 *  isn't theirs, one with a pull request). */
export async function cardNameOffOutcome(workspaceId: string, cardId: string): Promise<NameOffOutcome | null> {
  return (await invoke<NameOffOutcome | null>("card_name_off_outcome", { workspaceId, cardId })) ?? null;
}

/** 1.173.0 (C2), 1.175.0 (D2, TM-6): *Close the Builder session* and Stop
 *  during the start — this computer's claim marker comes off the card's
 *  issue only when the card's copy isn't on this computer. Nothing on a
 *  local board. */
export function kanbanCardDeviceRelease(workspaceId: string, cardId: string) {
  return invoke<void>("kanban_card_device_release", { workspaceId, cardId });
}

/** The issue the member's own name comes off when they leave `card`, or
 *  null — with the login the claim chip shows (the workspace's account,
 *  else the one signed in). Read outside React. */
export function nameOffIssueOf(
  card: Pick<KanbanCard, "workspaceId" | "columnId" | "ghIssueNumber" | "ghAssignees" | "pr" | "prUrl" | "prReview" | "shipStatus" | "reviewStatus">,
  gesture: "move-back" | "archive",
): number | null {
  const workspace = useWorkspaces.getState().workspaces.find((w) => w.id === card.workspaceId);
  const login = workspace?.githubAccount || useIdentity.getState().githubLogin || null;
  return ownNameComesOff(card, login, workspace?.kanbanSyncMode === "githubIssues", gesture);
}

async function outcomeOf(workspaceId: string, cardId: string): Promise<NameOffOutcome | null> {
  // The gesture went through; without an answer it says what it always said.
  return cardNameOffOutcome(workspaceId, cardId).catch(() => null);
}

/** Move back's toast: back at Ready to start, and what became of the name. */
export async function sayMovedBack(workspaceId: string, cardId: string): Promise<void> {
  pushToast(movedBackNotice(await outcomeOf(workspaceId, cardId)));
}

/** Stop during the start: said only when the member's name was on the issue. */
export async function sayStartStopped(workspaceId: string, cardId: string): Promise<void> {
  const notice = startStoppedNotice(await outcomeOf(workspaceId, cardId));
  if (notice) pushToast(notice);
}

/** After an archive was written: said only when GitHub didn't take the
 *  name off (the toast with Undo already said it comes off). */
export async function sayArchiveNameKept(workspaceId: string, cardId: string, title: string): Promise<void> {
  const notice = archiveNameKeptNotice(title, await outcomeOf(workspaceId, cardId));
  if (notice) pushToast(notice);
}

/** The delete sheet's Archive (no Undo): archived, and what became of the name. */
export async function sayArchived(workspaceId: string, cardId: string, title: string): Promise<void> {
  pushToast(archivedNotice(title, await outcomeOf(workspaceId, cardId)));
}
