import type { KanbanCard } from "../ipc";
import { machineWords } from "../lib/platform";
import { Details } from "./ux";

/** Windows walk 2026-10-20 (Try it spec §4.5): what the card says when its
 *  Ship kept its copy — a program still had the folder open. */
export const KEPT_COPY_WORDS =
  "Plyloft kept this card's copy on this Mac because a program still has it open. Plyloft removes it when you close the card's Builder session.";

/**
 * Under the card's Now: the copy a Ship couldn't move to the trash, in plain
 * words, with what Windows (or the Mac) said behind Details. Gone once a
 * later try moved it (`kept_copy::retry`).
 */
export function KeptCopyLine({ card }: { card: KanbanCard }) {
  const kept = card.keptCopy;
  if (!kept) return null;
  return (
    <div className="ux-kept-copy" data-ply-kept-copy="">
      <p className="ux-card-muted">{machineWords(KEPT_COPY_WORDS)}</p>
      <Details>
        <p className="ux-card-muted">
          <code>{kept.path}</code>
        </p>
        <p className="ux-card-muted">{kept.reason}</p>
      </Details>
    </div>
  );
}
