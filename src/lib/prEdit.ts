/**
 * 1.170.0 G4: Edit title and description of the card's open pull request.
 * Pure, for its tests; the sheet is `components/PrEditSheet.tsx`.
 */

export const PR_EDIT_LABEL = "Edit title and description";
export const PR_EDIT_TITLE = "Edit title and description";
export const PR_EDIT_SAVE = "Save on GitHub";
/** G4 Challenger 8: Save refused — GitHub's text changed since the sheet
 *  opened (Rust: `pr_draft.rs::EDIT_CHANGED_REFUSAL`, the same words). */
export const PR_EDIT_CHANGED =
  "The pull request changed on GitHub since you opened this. Close and open it again.";

/** GitHub's title limit (Rust: `pr_draft.rs::EDIT_TITLE_MAX_CHARS`). */
export const PR_EDIT_TITLE_MAX = 256;

/** Save is offered once GitHub's text was read, the title is not empty or
 *  too long, and something changed. */
export function prEditSaveable(
  loaded: { title: string; body: string } | null,
  title: string,
  body: string,
): boolean {
  if (!loaded) return false;
  const t = title.trim();
  if (t.length === 0 || [...t].length > PR_EDIT_TITLE_MAX) return false;
  return t !== loaded.title.trim() || body !== loaded.body;
}

/** The press is offered on the card's own open pull request (not a pull
 *  request it reviews), and off while a push or a merge runs. */
export function prEditOffered(card: { prUrl?: string | null; prReview?: unknown }, open: boolean): boolean {
  return open && Boolean(card.prUrl) && card.prReview == null;
}
