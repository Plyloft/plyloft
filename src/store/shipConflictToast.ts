import { cardInWorkspace } from "../lib/cardClaim";
import { shipConflictToast } from "../lib/shipConflict";
import { useBuilder } from "./builderStore";
import { useKanban } from "./kanbanStore";
import { pushToast } from "./toastStore";

/**
 * UX P1 point 7 (P-E): the one toast of a local ship stopped on a conflict,
 * raised by both press sites (Ship it on the card's result, Merge in the
 * review panel) once the board has re-read the card, so the target branch
 * it names is the one the conflict recorded. On a card with a Builder its
 * action is "Ask the Builder"; on one without, the body says how by hand.
 */
export function announceShipConflict(workspaceId: string, cardId: string, paths: readonly string[]): void {
  const card = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId);
  const onAsk =
    card?.builder && !card.archived
      ? () => void useBuilder.getState().resolveShipConflict(workspaceId, cardId)
      : null;
  pushToast(shipConflictToast(paths, card?.shipConflict?.branch, onAsk));
}
