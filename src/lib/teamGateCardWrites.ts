import type { CardPatch } from "../ipc";
import type { KanbanSyncMode } from "../store/workspaceStore";

export const TEAM_BOARD_READ_ONLY_MESSAGE =
  "This board is read-only: a board on GitHub Issues runs on the Team plan. See Settings › Setup and account › Plan, or press Move back in Settings › Project › General to keep working on a local board.";

/** The four CardPatch fields whose authoritative representation is a GitHub issue. */
export function touchesGithubOwnedCardField(patch: CardPatch): boolean {
  return (
    patch.title !== undefined ||
    patch.notes !== undefined ||
    patch.knowledge !== undefined ||
    patch.columnId !== undefined
  );
}

/** Shared Rust/TypeScript product predicate. Workspace existence is checked by callers. */
export function githubCardWriteBlocked(
  mode: KanbanSyncMode,
  teamAllowed: boolean,
  touchesGithubOwnedField: boolean,
): boolean {
  return (
    mode === "githubIssues" &&
    !teamAllowed &&
    touchesGithubOwnedField
  );
}
