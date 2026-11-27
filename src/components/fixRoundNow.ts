// 1.175.0 F5: the quiet press beside Now in a round Plyloft sent — "Don't
// check by itself" while the Builder fixes, Stop while the check it started
// by itself re-reads. Kept out of CardDetailPanel.tsx (one call there), so
// F8/F10's reshaping of Now only moves that call.
import type { KanbanCard } from "../ipc";
import { DONT_CHECK_LABEL, DONT_CHECK_TITLE, STOP_CHECK_LABEL, STOP_CHECK_TITLE } from "../lib/fixRoundCheck";
import { useBuilder } from "../store/builderStore";
import { dontCheckThisRound, fixRoundFactsOf, stopCheckByItself } from "../store/fixRoundStore";
import type { SecondaryAction } from "./CardStateHeader";

/** Now's quiet press for the round, or undefined. `rule`: the card's
 *  presentation rule (`builder-fixing`, `finishing`). */
export function fixRoundSecondary(card: KanbanCard, rule: string): SecondaryAction | undefined {
  const facts = fixRoundFactsOf(card);
  if (!facts) return undefined;
  if (rule === "builder-fixing" && facts.byItself && !facts.checking) {
    return { label: DONT_CHECK_LABEL, title: DONT_CHECK_TITLE, onAction: () => dontCheckThisRound(card.id) };
  }
  if (rule === "finishing" && facts.checking && useBuilder.getState().selfCheck[card.id]) {
    return { label: STOP_CHECK_LABEL, title: STOP_CHECK_TITLE, onAction: () => void stopCheckByItself(card.id) };
  }
  return undefined;
}
