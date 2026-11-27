// UX language card 7 (GH #102; BOARDS.md §5, PATTERNS.md §4): the one way to
// raise a toast about an error that needs doing.
//
// The rule the card fixes: **a toast never carries the only copy of something
// that needs action.** It says it happened and leads to the page —
// `Local staging can't be updated — nothing was changed.` · `Show` — and the
// block on that page stays until the condition is gone.
//
// `ux-check` does not police this (PATTERNS.md §9 is about classes), so the
// rule is held by this file being the only one that raises such a toast and by
// the source-contract half of `src/lib/uxError.test.ts`, which fails when
// another call site grows one back.

import { toastLine, type UxError } from "./uxError";
import { pushToast } from "../store/toastStore";
import { openCardStep, openLibraryPage, useUi } from "../store/uiStore";

/** The page that holds the block, so `Show` can lead there. */
export type ErrorWhere =
  /** The Library's Skills page of this workspace. */
  | { page: "library-skills"; workspaceId: string }
  /** The Library's Instructions page of this workspace (GH #101): a refusal
   *  about the two root instruction files is said there, not on Skills. */
  | { page: "library-instructions"; workspaceId: string }
  /**
   * Settings › This workspace › Worktrees.
   *
   * GH #152: with the workspace, like the two Library pages. That page draws the
   * **active** workspace's worktrees, so a refusal raised for another one led to
   * a page that said nothing until the member switched by hand.
   */
  | { page: "settings-worktrees"; workspaceId: string }
  /**
   * GH #151: the card's Ship step. A whole operation's refusal — Ship or Land
   * stopped by GH #88's fast-forward refusal — lives on the surface of the
   * operation that met it (PATTERNS.md §4), so `Show` opens the card there.
   */
  | { page: "card-ship"; workspaceId: string; cardId: string };

/** Land on the page the block is on. Nothing else: the block is already
 *  there, and opening a flow over it would hide the thing being announced. */
export function showErrorPage(where: ErrorWhere): void {
  switch (where.page) {
    case "library-skills":
      openLibraryPage(where.workspaceId, "skills");
      return;
    case "library-instructions":
      openLibraryPage(where.workspaceId, "instructions");
      return;
    case "settings-worktrees":
      useUi
        .getState()
        .openSettingsSection("worktrees", { workspaceId: where.workspaceId });
      return;
    case "card-ship":
      openCardStep(where.workspaceId, where.cardId, "ship");
      return;
  }
}

/**
 * Announce `error` and lead to the page that holds its block.
 *
 * Returns the toast's id, so a caller that raises the same condition twice can
 * dismiss the earlier one; callers that don't need it ignore it.
 */
export function announceError(error: UxError, where: ErrorWhere): string {
  return pushToast({
    kind: "warn",
    title: toastLine(error),
    // No body and no second action: the words that matter are on the page.
    action: { label: "Show", onClick: () => showErrorPage(where) },
  });
}
