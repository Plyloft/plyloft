/** Bounded, display-oriented dirty state for the target workspace checkout. */
export interface TargetDirtyState {
  totalCount: number;
  paths: string[];
  truncated: boolean;
}

export const TARGET_DIRTY_ERROR_PREFIX = "PLY_TARGET_DIRTY_V1:";

/** Decode only Ply's stable typed error payload—never infer dirty state from
 * human-facing error copy. */
export function decodeTargetDirtyError(
  error: unknown,
): TargetDirtyState | null {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "";
  if (!raw.startsWith(TARGET_DIRTY_ERROR_PREFIX)) return null;
  try {
    const parsed = JSON.parse(
      raw.slice(TARGET_DIRTY_ERROR_PREFIX.length),
    ) as Partial<TargetDirtyState>;
    if (
      !Number.isInteger(parsed.totalCount) ||
      (parsed.totalCount ?? -1) < 0 ||
      !Array.isArray(parsed.paths) ||
      !parsed.paths.every((path) => typeof path === "string") ||
      typeof parsed.truncated !== "boolean"
    ) {
      return null;
    }
    return {
      totalCount: parsed.totalCount!,
      paths: parsed.paths,
      truncated: parsed.truncated,
    };
  } catch {
    return null;
  }
}

/** P40 (1.174.0 TX5, T30): the toast when the project folder's changes stop
 *  a ship, and its press, which opens the 1.172.1 changes sheet. */
export const TARGET_DIRTY_TITLE = "Your project folder has changes that aren't saved";
export const SHOW_THEM = "Show them";

/** T31: the same toast's body. It points at its own press, Show them; the
 *  card's error block keeps `targetDirtyMessage`, whose presses differ. */
export function targetDirtyToastBody(state: TargetDirtyState): string {
  const one = state.totalCount === 1;
  const bounded =
    state.truncated && state.paths.length < state.totalCount
      ? ` Showing the first ${state.paths.length}.`
      : "";
  const them = one ? "it" : "them";
  return `${state.totalCount} changed file${one ? "" : "s"} in your project folder ${one ? "isn't" : "aren't"} saved in a commit, so Plyloft won't ship into it.${bounded} ${SHOW_THEM} opens ${them}, and Claude can save ${them} for you; then ship again.`;
}

export function targetDirtyMessage(state: TargetDirtyState): string {
  const bounded =
    state.truncated && state.paths.length < state.totalCount
      ? ` Showing the first ${state.paths.length}.`
      : "";
  return `Your project folder has ${state.totalCount} changed file${state.totalCount === 1 ? "" : "s"} that ${state.totalCount === 1 ? "isn't" : "aren't"} in a commit, so Plyloft won't ship into it.${bounded} Commit ${state.totalCount === 1 ? "it" : "them"} or undo ${state.totalCount === 1 ? "it" : "them"}, then ship again.`;
}
