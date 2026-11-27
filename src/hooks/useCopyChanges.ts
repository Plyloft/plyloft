// Moved out of `CardDetailPanel.tsx` unchanged (1.175.0, its cap).
import { useEffect, useState } from "react";
import { cardCopyChanges, type ChangedFiles, type KanbanCard } from "../ipc";

/** 1.173.0 A3: what a card made from a copy holds since its base
 *  (`card_copy_changes`), read while `wanted` and again when the card
 *  changes; null for any other card. */
export function useCopyChanges(card: KanbanCard, wanted: boolean): ChangedFiles | null {
  const [changes, setChanges] = useState<ChangedFiles | null>(null);
  const fromCopy = Boolean(card.fromCopy) && wanted;
  useEffect(() => {
    if (!fromCopy) {
      setChanges(null);
      return;
    }
    let live = true;
    cardCopyChanges(card.workspaceId, card.id)
      .then((c) => live && setChanges(c ?? null))
      .catch(() => live && setChanges(null));
    return () => {
      live = false;
    };
  }, [fromCopy, card.workspaceId, card.id, card.updatedAt]);
  return changes;
}
