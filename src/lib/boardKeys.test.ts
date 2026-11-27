// QoL 1.168 (block 10, C6): the Board by keyboard.
import assert from "node:assert/strict";
import { boardFocusStep, boardKeyAction, boardMoveTarget } from "./boardKeys.ts";
import { reorderKey } from "./boardSemantics.ts";

const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

assert.equal(boardKeyAction(k("ArrowDown")), "down");
assert.equal(boardKeyAction(k("j")), "down");
assert.equal(boardKeyAction(k("K")), "up");
assert.equal(boardKeyAction(k("ArrowLeft")), "left");
assert.equal(boardKeyAction(k("ArrowRight", { altKey: true })), "moveRight");
assert.equal(boardKeyAction(k("ArrowUp", { altKey: true })), "moveUp");
assert.equal(boardKeyAction(k("F10", { shiftKey: true })), "menu");
assert.equal(boardKeyAction(k("ContextMenu")), "menu");
// ⌘ and Ctrl chords are the app's (⌘K, ⌘⇧N…); Shift+arrow, typing are not ours.
assert.equal(boardKeyAction(k("ArrowDown", { metaKey: true })), null);
assert.equal(boardKeyAction(k("j", { ctrlKey: true })), null);
assert.equal(boardKeyAction(k("ArrowDown", { shiftKey: true })), null);
assert.equal(boardKeyAction(k("J", { shiftKey: true })), null);
assert.equal(boardKeyAction(k("Enter")), null, "Enter is the card button's own");
assert.equal(boardKeyAction(k("x")), null);

// Focus: within a column, then across, skipping empty columns.
const counts = [3, 0, 2, 1];
assert.deepEqual(boardFocusStep(counts, { col: 0, row: 0 }, "down"), { col: 0, row: 1 });
assert.equal(boardFocusStep(counts, { col: 0, row: 2 }, "down"), null);
assert.equal(boardFocusStep(counts, { col: 0, row: 0 }, "up"), null);
assert.deepEqual(boardFocusStep(counts, { col: 0, row: 2 }, "right"), { col: 2, row: 1 }, "skips the empty column, clamps the row");
assert.deepEqual(boardFocusStep(counts, { col: 3, row: 0 }, "left"), { col: 2, row: 0 });
assert.equal(boardFocusStep(counts, { col: 3, row: 0 }, "right"), null);
assert.equal(boardFocusStep(counts, { col: 0, row: 1 }, "left"), null);

// Moves as drop targets.
assert.deepEqual(boardMoveTarget("needs-you", 2, 4, "moveUp"), { kind: "column", column: "needs-you", index: 1 });
assert.equal(boardMoveTarget("needs-you", 0, 4, "moveUp"), null);
assert.deepEqual(boardMoveTarget("needs-you", 1, 4, "moveDown"), { kind: "column", column: "needs-you", index: 3 });
assert.equal(boardMoveTarget("needs-you", 3, 4, "moveDown"), null);
assert.deepEqual(boardMoveTarget("working", 0, 1, "moveRight"), { kind: "column", column: "waiting", index: 0 });
assert.deepEqual(boardMoveTarget("waiting", 0, 1, "moveRight"), { kind: "column", column: "done", index: 0 });
assert.equal(boardMoveTarget("done", 0, 1, "moveRight"), null);
assert.equal(boardMoveTarget("needs-you", 0, 1, "moveLeft"), null);

// …which put the card one place up or down, as a drop there does.
const col = ["a", "b", "c", "d"].map((id, i) => ({ id, boardOrder: (i + 1) * 1000, createdAt: 0 }));
const up = boardMoveTarget("needs-you", 2, 4, "moveUp")!;
const upKey = reorderKey(col[2], col, up.kind === "column" ? up.index : -1)!;
assert.ok(upKey > 1000 && upKey < 2000, "c lands between a and b");
const down = boardMoveTarget("needs-you", 1, 4, "moveDown")!;
const downKey = reorderKey(col[1], col, down.kind === "column" ? down.index : -1)!;
assert.ok(downKey > 3000 && downKey < 4000, "b lands between c and d");

console.log("boardKeys: all assertions passed");
