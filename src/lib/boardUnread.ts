// 1.176.2 (E1, A3-70): a board whose file couldn't be read is said to be
// unread — never drawn as an empty board with an invitation to start one.
import { plainError } from "./plainError.ts";
import type { UxError } from "./uxError.ts";

/** The Board's own block for a read that failed: the cause in words, the
 *  file untouched. `raw` is the backend's text (Details, when it isn't
 *  already a sentence). The Try again button sits beside the block. */
export function boardUnreadError(raw: string): UxError {
  const shown = plainError("The board couldn't be read", raw, {
    untouched: "Nothing was changed. The board's file is as it was.",
    todo: "Try again.",
    actions: [],
  });
  // Details is pointed at only when there is one.
  return shown.details ? { ...shown, todo: "Try again. If it keeps failing, Details says why." } : shown;
}
