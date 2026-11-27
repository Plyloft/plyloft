export type BoardSelectionSnapshot = {
  workspaceId: string;
  selectedCardId: string | null;
};

/**
 * Return the Board card that should regain focus for a selection transition.
 * Workspace switches are not card-close transitions: the active Board view is
 * reused across workspaces, so carrying an opener across that boundary would
 * steal focus in the newly active workspace.
 */
export function boardFocusReturnCard(
  previous: BoardSelectionSnapshot,
  current: BoardSelectionSnapshot,
): string | null {
  if (previous.workspaceId !== current.workspaceId) return null;
  if (previous.selectedCardId === null || current.selectedCardId !== null) {
    return null;
  }
  return previous.selectedCardId;
}
