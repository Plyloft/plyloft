/**
 * 1.171.0 D3 (FR-5): a card's copy starts from the last commit, so changes
 * in the project folder that aren't saved in Git are not in it — and the
 * person, seeing them in Code, thinks the Builder lost their work. The card
 * says so while it is being worked on. Pure: no React, no store.
 */

/** The card's line; null when the folder has nothing unsaved, or when it
 *  is on another branch than the one the card started from (`target`, the
 *  card's base branch; null when unknown) — those changes were never going
 *  to be in it. The branch is named either way. */
export function startedWithoutLine(
  unsaved: { files: number; branch: string | null },
  target: string | null,
): string | null {
  const n = unsaved.files;
  if (!Number.isFinite(n) || n <= 0 || !unsaved.branch) return null;
  if (target && target.replace(/^origin\//, "") !== unsaved.branch) return null;
  const what = n === 1 ? "1 file or folder" : `${n} files or folders`;
  return `Started from the last saved version of your project. Your project folder, on ${unsaved.branch}, has changes in ${what} that aren't saved in Git, so this card doesn't have them.`;
}

/** Whether the card asks: its copy exists and is still being worked on. */
export function asksAboutUnsavedWork(card: {
  worktreePath?: string | null;
  archived?: boolean | null;
  prReview?: unknown;
  landed: boolean;
}): boolean {
  return Boolean(card.worktreePath) && !card.archived && !card.prReview && !card.landed;
}
