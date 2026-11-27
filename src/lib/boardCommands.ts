export const BOARD_NEW_TASK_EVENT = "ply:board-new-task";

export type BoardNewTaskTarget = "pending" | "hero" | "todo";

/**
 * Keep palette routing inside the Board without guessing while persisted
 * cards are still loading. A request made during that window remains in
 * component state and is delivered once the real empty/non-empty state is
 * known.
 */
export function boardNewTaskTarget(
  loaded: boolean,
  activeCardCount: number,
): BoardNewTaskTarget {
  if (!loaded) return "pending";
  return activeCardCount === 0 ? "hero" : "todo";
}

/** 1.171.0 (E2; walk 2026-10-27 #2): said under the empty Board's field once
 *  New card was pressed — the press is seen, and the next step is plain. */
export const NEW_CARD_HERO_HINT = "Write it here, then press Enter.";
/** 1.174.0 (A6, G16; mockups/board.html 6): the hero's button says what it
 *  does — it makes a card; Start build starts it. */
export const HERO_MAKE_THE_CARD = "Make the card";
export const HERO_MAKE_THE_CARD_TITLE = "Make a card from this; nothing starts until you press Start build";

/** 1.171.0 (E2): read out when a card made in a column lands there. */
export function cardArrivedWords(title: string, column: string): string {
  return `Card “${title}” added to ${column}.`;
}

export function requestBoardNewTask(workspaceId: string): void {
  // The command first switches the center to Board. Defer one frame so a
  // previously-unmounted Board can subscribe before the focus request fires.
  requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent<{ workspaceId: string }>(BOARD_NEW_TASK_EVENT, {
        detail: { workspaceId },
      }),
    );
  });
}

/** QoL 1.168 (block 10, Challenger item 4): ⌘K › Review a pull request…
 *  — the Board's ⋯ item, from anywhere: the Board opens its sheet. */
export const BOARD_PR_REVIEW_EVENT = "ply:board-pr-review";

export function requestBoardPrReview(workspaceId: string): void {
  requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent<{ workspaceId: string }>(BOARD_PR_REVIEW_EVENT, {
        detail: { workspaceId },
      }),
    );
  });
}
