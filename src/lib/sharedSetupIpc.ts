// 1.175.0 (C1, SC-2): the calls behind `sharedSetup.ts` (`stop_sharing.rs`).
// Here, not in `ipc.ts`, which is at its size ceiling. "Share it again" is
// the existing Share (`workspaceAdoptionShare`): the one path that creates
// the file.
import { invoke } from "@tauri-apps/api/core";
import type { StopOutcome } from "./sharedSetup";

/** *Stop sharing*: remove `.atelier/workspace.json` from the integration
 *  branch in one commit — or, where the branch refuses the push, open the
 *  pull request that removes it. Rejects with the reason; nothing changed. */
export function workspaceStopSharing(workspaceId: string) {
  return invoke<StopOutcome>("workspace_stop_sharing", { workspaceId });
}

/** "Keep it on this Mac" on the removed-setup notice. Writes nothing to
 *  GitHub. */
export function workspaceKeepSetupLocal(workspaceId: string) {
  return invoke<void>("workspace_keep_setup_local", { workspaceId });
}

/** C2: "Propose it again" — the conversion of the older file, on a press:
 *  forgets that it was declined and publishes `.atelier/workspace.json`
 *  (a pull request where the branch refuses the push). */
export function workspaceProposeConversionAgain(workspaceId: string) {
  return invoke<unknown>("workspace_propose_conversion_again", { workspaceId });
}

/** C2: the "stays in its older file" notice was on screen; it isn't shown
 *  again (Settings › Project › General keeps the sentence and the button). */
export function workspaceConversionNoticeSeen(workspaceId: string) {
  return invoke<void>("workspace_conversion_notice_seen", { workspaceId });
}

/** C5: "Move to {new}" — GitHub renamed the branch the shared setup lives
 *  on; the setup is moved there (one commit), and published. */
export function workspaceMoveSharedSetup(workspaceId: string, to: string) {
  return invoke<void>("workspace_move_shared_setup", { workspaceId, to });
}

/** C5: what "Use the team's values" did (`move_shared_setup::TeamValuesUsed`). */
export interface TeamValuesUsed {
  dropped: string[];
  leftOpen: number[];
}

/** C5: "Use the team's values" — a member who can't write drops this
 *  computer's changes that wait; nothing goes to GitHub. */
export function workspaceUseTeamValues(workspaceId: string) {
  return invoke<TeamValuesUsed>("workspace_use_team_values", { workspaceId });
}
