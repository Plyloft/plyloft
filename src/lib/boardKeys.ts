// QoL 1.168 (block 10, C6): the Board by keyboard. With a card focused:
//   ↑ / ↓ (or K / J)  the card above or below, in its column
//   ← / →             the card beside it, in the next column that has one
//   Enter             opens it (the card is a button)
//   ⌥↑ / ⌥↓           moves it up or down its column (with Undo)
//   ⌥← / ⌥→           asks to move it to the column beside — answered as a
//                     drag there is: a card's column follows its work, so
//                     the Board says why it stays (Done fills on ship)
//   Shift+F10, the menu key   its menu (Open, Move…, Archive, Delete)
// The same refusals as dragging: every move goes through
// `deriveBoardDropDecision`. Pure, so node can test it.

import {
  ATTENTION_COLUMNS,
  type AttentionColumn,
  type BoardDropTarget,
} from "./boardSemantics.ts";

export type BoardKeyAction =
  | "up"
  | "down"
  | "left"
  | "right"
  | "moveUp"
  | "moveDown"
  | "moveLeft"
  | "moveRight"
  | "menu";

export interface BoardKeyPress {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const ARROWS: Record<string, "up" | "down" | "left" | "right"> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** What a key press on a focused Board card asks for, or null. */
export function boardKeyAction(e: BoardKeyPress): BoardKeyAction | null {
  if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey)) {
    return "menu";
  }
  if (e.metaKey || e.ctrlKey) return null;
  const arrow = ARROWS[e.key];
  if (arrow) {
    if (e.shiftKey) return null;
    if (!e.altKey) return arrow;
    return arrow === "up" ? "moveUp" : arrow === "down" ? "moveDown" : arrow === "left" ? "moveLeft" : "moveRight";
  }
  if (e.altKey || e.shiftKey) return null;
  const k = e.key.toLowerCase();
  if (k === "j") return "down";
  if (k === "k") return "up";
  return null;
}

export interface BoardSpot {
  col: number;
  row: number;
}

/** Where the focus goes from `at` on a Board whose columns hold `counts`
 *  cards, or null to stay. Left and right skip empty columns and land on
 *  the same row, or the last card of a shorter column. */
export function boardFocusStep(
  counts: readonly number[],
  at: BoardSpot,
  dir: "up" | "down" | "left" | "right",
): BoardSpot | null {
  if (dir === "up") return at.row > 0 ? { col: at.col, row: at.row - 1 } : null;
  if (dir === "down") return at.row < (counts[at.col] ?? 0) - 1 ? { col: at.col, row: at.row + 1 } : null;
  const step = dir === "left" ? -1 : 1;
  for (let c = at.col + step; c >= 0 && c < counts.length; c += step) {
    if (counts[c] > 0) return { col: c, row: Math.min(at.row, counts[c] - 1) };
  }
  return null;
}

/** The place a keyboard move asks for, as a drop target, or null when
 *  there is nowhere to go (the top of the column, the last column). Up and
 *  down are a drop just above the card before it or just below the card
 *  after it; left and right the top of the column beside. */
export function boardMoveTarget(
  from: AttentionColumn,
  index: number,
  length: number,
  action: "moveUp" | "moveDown" | "moveLeft" | "moveRight",
): BoardDropTarget | null {
  if (action === "moveUp") return index > 0 ? { kind: "column", column: from, index: index - 1 } : null;
  if (action === "moveDown") return index < length - 1 ? { kind: "column", column: from, index: index + 2 } : null;
  const at = ATTENTION_COLUMNS.findIndex((c) => c.id === from);
  const next = ATTENTION_COLUMNS[at + (action === "moveLeft" ? -1 : 1)];
  return at === -1 || !next ? null : { kind: "column", column: next.id, index: 0 };
}
