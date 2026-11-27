// GH #226: press "Reapply mine on top" — the one call and the one toast every
// surface that offers it shares (the Knowledge panel's toast, Settings › Team).
import { teamLibraryReapply, type ReapplyChoice, type ReapplyReport } from "../ipc";
import { reapplyToast } from "../lib/teamLibraryRecovery";
import { pushToast } from "../store/toastStore";
import { pushErrorToast } from "../lib/errorToast";

/** Run the reapply and say how it ended. Null when the call itself failed
 *  (no clone, a rebase already under way…); the toast carries why. */
export async function runTeamLibraryReapply(
  /** QoL 13.3: the member's choice for each file a collision named. */
  choices?: Record<string, ReapplyChoice>,
): Promise<ReapplyReport | null> {
  try {
    const report = await teamLibraryReapply(choices);
    pushToast(reapplyToast(report));
    return report;
  } catch (e) {
    pushErrorToast("Couldn't reapply your team library changes", e);
    return null;
  }
}
