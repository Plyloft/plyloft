// 1.176.3 (error buttons): the controls that 1.176.2's error words wanted.
// One place for what each one needs to know: whether pressing it can help,
// and what it opens. A button is never drawn when it could not help.
import { pushToast, type ToastAction } from "../store/toastStore";
import { useKanban } from "../store/kanbanStore";
import { useUi, openCardStep, effectiveCenterMode } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { causeText } from "./errorToast";
import { markedPathGone } from "./backendMarks";

export const OPEN_THE_CARD = "Open the card";
export const OPEN_PROGRAM_FOLDERS_LABEL = "Open Program folders";
export const CARD_NOT_ON_BOARD = "That card isn't on the Board any more.";
export const READ_IT_AGAIN = "Read it again";
export const TRY_AGAIN = "Try again";
export const READING_BUSY = "Reading…";

/** A failure that reading again cannot change: the folder or file is not
 *  there, is not a folder, or the folder is not a repository. A retry would
 *  only fail the same way, so no button is drawn for it. Anything else (a
 *  busy disk, a refused permission the person can fix, a tool that answered
 *  late) may be different next time. */
export function retryCanHelp(cause: unknown): boolean {
  const raw = causeText(cause);
  // The backend says it in a typed mark (`path_gone.rs`); the words below
  // are only the fallback for an error that comes without one.
  if (markedPathGone(raw)) return false;
  return !/os error (?:2|3|267)\b|ENOENT|ENOTDIR|no such file or directory|cannot find the (?:file|path)|not a directory|not a git repository|workspace cwd does not exist|workspace not found/i.test(
    raw,
  );
}

/** Whether this card's own page is the one on screen (its project active,
 *  the Board showing, the card open over it). */
export function cardPageIsOpen(workspaceId: string, cardId: string): boolean {
  const ui = useUi.getState();
  return (
    useWorkspaces.getState().activeId === workspaceId &&
    effectiveCenterMode(ui.centerMode, workspaceId) === "board" &&
    ui.selectedCardId[workspaceId] === cardId
  );
}

/** "Open the card" for a refusal about one card, or nothing: not when the
 *  card is already the one open, and not when its project is gone. */
export function openTheCardAction(workspaceId: string, cardId: string): ToastAction | undefined {
  if (!useWorkspaces.getState().workspaces.some((w) => w.id === workspaceId)) return undefined;
  if (cardPageIsOpen(workspaceId, cardId)) return undefined;
  return {
    label: OPEN_THE_CARD,
    onClick: () => {
      // The toast stays until dismissed: the card may have gone meanwhile.
      const there = useKanban.getState().byWorkspace[workspaceId]?.cards.some((c) => c.id === cardId && !c.archived);
      if (!there) {
        pushToast({ kind: "info", title: CARD_NOT_ON_BOARD });
        return;
      }
      openCardStep(workspaceId, cardId, "ship");
    },
  };
}

/** Settings › Look and feel › Editor and terminals › Program folders, the
 *  way Repair, Diagnostics and Setup open it. */
export function openProgramFolders(): void {
  useUi.getState().openSettingsSection("editor-terminals", { row: "Program folders", focus: true });
}

export const openProgramFoldersAction: ToastAction = { label: OPEN_PROGRAM_FOLDERS_LABEL, onClick: openProgramFolders };
