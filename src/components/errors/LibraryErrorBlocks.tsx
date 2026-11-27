import { LocalBranchBlock } from "./LocalBranchBlock";
import { PublishRefusedBlock } from "./PublishRefusedBlock";
import type { Scope } from "../../lib/uxScope";

/**
 * UX language card 7 (GH #102): the blocks that belong on a Library page.
 *
 * One component so a Library surface adds one line, not one per error: the
 * Skills page and a skill's own page each render this once, and every block
 * decides for itself whether it has anything to say. Nothing is drawn when
 * there is no error, so a quiet Library is unchanged.
 */
export function LibraryErrorBlocks({
  workspaceId,
  name,
  scope,
}: {
  workspaceId: string;
  /** A skill's own page: only what concerns that skill. */
  name?: string;
  /** That skill's scope. The refusal is about the checkout, so only a
   *  repository row can be the copy standing in the way (review 1). */
  scope?: Scope;
}) {
  return (
    <>
      <LocalBranchBlock workspaceId={workspaceId} on="library" name={name} scope={scope} />
      {/* The push the branch refused is the checkout's queue, so on a skill's
          own page only a repository copy can be what is waiting in it. */}
      {(!name || scope === "repository") && (
        <PublishRefusedBlock workspaceId={workspaceId} on="skills" name={name} />
      )}
    </>
  );
}
