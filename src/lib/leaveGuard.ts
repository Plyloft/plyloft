/**
 * UX language card 2 (BOARDS.md §6 "Leaving a draft"): a page that holds
 * changes nobody else has asks once before the surface takes you elsewhere.
 *
 * The page registers a guard while it has a draft and clears it when the
 * draft goes or the page unmounts; the shell asks through `leavePage`
 * instead of switching entries or closing straight away. The guard answers
 * `false` to hold the move, shows its own confirmation, and calls `proceed`
 * itself if the person leaves.
 *
 * Only one page is mounted at a time, so one guard is enough. Pure, so
 * `repositoryPage.test.ts` runs it under node.
 */

export type LeaveGuard = (proceed: () => void) => boolean;

let guard: LeaveGuard | null = null;

export function setLeaveGuard(next: LeaveGuard | null): void {
  guard = next;
}

/** Clears `next`'s registration, and only its own: a page that unmounts
 *  after another one registered must not take the new guard down. */
export function clearLeaveGuard(own: LeaveGuard): void {
  if (guard === own) guard = null;
}

/** Runs `proceed` unless a page asks to keep you. */
export function leavePage(proceed: () => void): void {
  if (guard && !guard(proceed)) return;
  proceed();
}

/** Whether a page is holding something back (for tests and assertions). */
export function hasLeaveGuard(): boolean {
  return guard !== null;
}
