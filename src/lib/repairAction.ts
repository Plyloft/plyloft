// 1.176.0 R4: a guided Repair's terminal steps run in Setup's runner
// (`repair-install.*`, `repair-chown.*`, `repair-npm-remove.*`). They are
// their own family: never a Setup step's install, update or sign-in, so
// Setup's AI, Git and GitHub steps and its step line leave them alone.
// Dependency-free, so the node tests of `aiTools.ts` and `setupRun.ts` load it.

/** A Repair's run, not one of Setup's own. */
export function isRepairAction(id: string): boolean {
  return id.startsWith("repair-");
}

/** The guided terminal's neutral line for a Repair's run. */
export const REPAIR_RUNNING_LINE = "A repair is running.";
export const REPAIR_ENDED_LINE = "The repair step ended.";
