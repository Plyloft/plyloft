import { ErrorBlock } from "../ux";
import { publishRefusedError, refusalConcerns, refusalTitlesFor } from "../../lib/uxError";
import { useErrorBlocks } from "../../store/errorBlockStore";

/**
 * UX language card 7 (GH #102): the read-only refusal in the error shape — the
 * branch refused the push and no pull request could carry it either.
 *
 * The second case the card asks for, on different ground: there is **no** way
 * out Ply can take, so the block has no actions at all (PATTERNS.md §3, "none
 * when there is nothing to do") and the words carry the whole answer. It was a
 * warn toast that said it once, at the moment of a publish, and went — which
 * is exactly what BOARDS.md §5 forbids for something that needs doing.
 */
export function PublishRefusedBlock({
  workspaceId,
  on = "skills",
  name,
}: {
  workspaceId: string;
  /**
   * Which Library page is asking (GH #101 review 1). The refusal is one per
   * workspace, and the Library has two pages that can raise it: each draws only
   * the refusals whose queued kinds are its own, so an instructions refusal does
   * not block Skills and a skill's does not appear under Instructions.
   */
  on?: "skills" | "instructions";
  /**
   * A skill's own page: drawn only when a change about that skill is among what
   * is still queued, and about those alone — the other titles belong on the
   * list. Which titles are its is `refusalTitlesFor` (a publish, a removal,
   * `Make available to both`, `Align`).
   */
  name?: string;
}) {
  const refusal = useErrorBlocks(
    (s) => s.byWorkspace[workspaceId]?.publishRefused ?? null,
  );
  if (!refusal || !refusalConcerns(refusal, on)) return null;
  if (name !== undefined) {
    const mine = refusalTitlesFor(refusal.titles, name);
    if (mine.length === 0) return null;
    return <ErrorBlock error={publishRefusedError({ ...refusal, titles: mine })} />;
  }
  return <ErrorBlock error={publishRefusedError(refusal)} />;
}
