// 1.175.0 F8: the one note under Now's primary, drawn. `lib/nowNote.ts`
// picks it by rank among the notes that apply; each note draws its own
// line and presses here. Moved out of `CardDetailPanel.tsx` (its cap).
import type { KanbanCard } from "../ipc";
import { nowNoteId } from "../lib/nowNote";
import { machineWords } from "../lib/platform";
import { autoFixOffered } from "../lib/prAutoFixOffer";
import { putOnGithubNote } from "../lib/putOnGithub";
import { usePutOnGithub } from "../store/putOnGithubStore";
import { useWorkspaces } from "../store/workspaceStore";
import { AutoFixOffer, useTurnedOnShown } from "./AutoFixOffer";
import { CardShipNote } from "./PutOnGithubSheet";

export function CardNowNote({
  card,
  actionId,
  noPullRequestWords,
  onlyHere,
}: {
  card: KanbanCard;
  /** Now's primary (`statePresentation.actionId`). */
  actionId: string | null | undefined;
  /** R10: Ready to ship where pull requests can't open says why. */
  noPullRequestWords: string | null | undefined;
  /** F3: the project has no remote at all (`OutcomePresentationSummary.onlyHere`). */
  onlyHere: boolean | null | undefined;
}) {
  const ws = useWorkspaces((s) => s.workspaces.find((w) => w.id === card.workspaceId));
  const turnedOn = useTurnedOnShown(card);
  const justPut = usePutOnGithub((s) => s.justPut[card.workspaceId] ?? null);
  const ship = actionId === "ship";
  const id = nowNoteId({
    // F3: whether GitHub is connected only changes its press, which
    // `CardShipNote` reads.
    putOnGithub: ship && putOnGithubNote({ noRemote: onlyHere === true, githubConnected: false, justPut }) !== null,
    noPullRequest: ship && !!noPullRequestWords?.trim(),
    // F7 (I9): under Fix with the Builder; after Turn on, its line with
    // Undo whatever the primary becomes (walk 7), until the try ends.
    autoFixOffer: turnedOn || (actionId === "pr-fix" && autoFixOffered(card, ws)),
  });
  switch (id) {
    case "putOnGithub":
      return <CardShipNote workspaceId={card.workspaceId} project={ws?.name ?? ""} words={null} noRemote={onlyHere === true} />;
    case "noPullRequest":
      return (
        <p className="ux-card-muted" data-ply-no-remote="now">
          {machineWords(noPullRequestWords!)}
        </p>
      );
    case "autoFixOffer":
      return <AutoFixOffer card={card} />;
    default:
      return null;
  }
}
