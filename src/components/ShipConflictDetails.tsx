import type { KanbanCard } from "../ipc";
import { shipConflictOf } from "../lib/shipConflict";
import { targetName } from "../lib/worktreeBase";
import { Details } from "./ux";

/**
 * UX P1 point 7 (P-E): Details of a ship stopped on a conflict — the
 * conflicting files (the Windows walk saw the page didn't name them) and how
 * to resolve it by hand. Closed by default, under the sentence that says
 * what happened.
 */
export function ShipConflictDetails({ card }: { card: KanbanCard }) {
  if (!shipConflictOf(card) && card.reviewStatus !== "conflict_blocked") return null;
  return (
    <div className="ux-ship-conflict-details" data-ply-ship-conflict-details="">
      <Details>
        <ShipConflictFiles card={card} />
      </Details>
    </div>
  );
}

/** 1.175.0 F8: the same files and words, for the Details inside Now (the
 *  conflict is Now; nothing under it says it again). */
export function ShipConflictFiles({ card }: { card: KanbanCard }) {
  const conflict = shipConflictOf(card);
  if (!conflict && card.reviewStatus !== "conflict_blocked") return null;
  const branch = conflict?.branch?.trim() ? conflict.branch : targetName(null);
  const paths = conflict?.paths ?? [];
  return (
    <div data-ply-ship-conflict-details="">
        {paths.length > 0 ? (
          <ul className="ux-ship-conflict-files" aria-label="Conflicting files">
            {paths.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>Git didn't name the files.</p>
        )}
        <p>
          {conflict?.sync
            ? `To resolve it yourself, merge ${branch} into the card's branch in its copy, then press Finish and check.`
            : `To resolve it yourself, merge ${branch} into the card's branch in its copy, then ship again.`}
        </p>
    </div>
  );
}
