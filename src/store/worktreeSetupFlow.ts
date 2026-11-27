import { worktreeEnvProposal, worktreeEnvProposalAnswer, workspaceDefinitionGet } from "../ipc";
import { needsSetUp, needsSetUpByWriter, projectFolderGone } from "../lib/projectSetup";
import { envProposalQuestion } from "../lib/worktreeSetup";
import { confirmChoice, useConfirmSheet } from "./confirmStore";
import { pushToast } from "./toastStore";

/**
 * SL-4: before a card's first worktree is made, ask once whether the main
 * checkout's git-ignored `.env` files go into card worktrees (the backend
 * says whether there is anything to ask: no copy list — a setup command
 * alone doesn't settle it — never answered on this Mac, the card has no
 * worktree yet). Copy them or Don't copy is
 * kept; a sheet closed without an answer keeps nothing. The start goes on
 * whatever it is. A repository that isn't set up is refused first (the
 * backend's `not_set_up` words, thrown for the start to say). A read that
 * fails otherwise, or no host on screen
 * to ask with, asks nothing — the next card asks again.
 */
export async function offerWorktreeEnvCopy(workspaceId: string, cardId: string): Promise<void> {
  if (useConfirmSheet.getState().hosts === 0) return;
  let found: string[];
  try {
    found = await worktreeEnvProposal(workspaceId, cardId);
  } catch (e) {
    // v1.154.1 (K1): a repository not set up is refused before the
    // question — the start that called this says it, with Set up.
    if (needsSetUp(e) || needsSetUpByWriter(e) || projectFolderGone(e)) throw e;
    console.warn("worktree setup: couldn't read the .env proposal:", e);
    return;
  }
  if (!Array.isArray(found) || found.length === 0) return;
  const shared = await workspaceDefinitionGet(workspaceId)
    .then((view) => view?.effective != null)
    .catch(() => false);
  const answer = await confirmChoice(envProposalQuestion(found, shared));
  // Only a real "Don't copy" is kept: a sheet closed without an answer asks
  // again on the next card.
  if (answer === "dismiss") return;
  const copy = answer === "confirm";
  try {
    await worktreeEnvProposalAnswer(workspaceId, copy, copy ? found : []);
  } catch (e) {
    pushToast({
      kind: "warn",
      title: "Couldn't keep your answer",
      body: copy
        ? "The files aren't copied into this card's copy; Plyloft asks again on the next card."
        : "Plyloft asks again on the next card.",
      details: String(e),
    });
  }
}
