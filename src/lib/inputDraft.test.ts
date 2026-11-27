// QoL 1.168 (walk lane 1, step 4): a dim placeholder or suggestion in the
// CLI's input row is not a draft; the member's own typing is.
//     node --experimental-strip-types src/lib/inputDraft.test.ts
import assert from "node:assert/strict";
import { faintFg, inputRowHasDraft, type InputCell } from "./attention.ts";

/** A row: plain text, then dim text (`dim` from that index on). */
function row(text: string, dimFrom = text.length, cursorAt = -1): InputCell[] {
  return Array.from(text).map((ch, i) => ({ ch, plain: i < dimFrom && i !== cursorAt }));
}

// Claude's placeholder on a fresh tile, the cursor block over its first letter.
assert.equal(inputRowHasDraft(row('❯ Try "refactor <filepath>"', 2, 2)), false);
// Claude's suggestion after a turn, dim.
assert.equal(inputRowHasDraft(row("❯ what word did I ask you to remember?", 2)), false);
// A bare prompt.
assert.equal(inputRowHasDraft(row("❯ ")), false);
// The member typed "d" (the cursor after it).
assert.equal(inputRowHasDraft(row("❯ d ", 4, 3)), true);
// Codex: its placeholder is dim, a draft is plain.
assert.equal(inputRowHasDraft(row("› Ask Codex to do anything", 2)), false);
assert.equal(inputRowHasDraft(row("› fix the tests")), true);
// The box's own side rules are no text.
assert.equal(inputRowHasDraft(row("│ ❯           │")), false);
// No chevron: nothing to judge.
assert.equal(inputRowHasDraft(row("hello")), false);
// Faint greys are the CLI's; the default colour and light text are typing.
assert.equal(faintFg({ kind: "default" }), false);
assert.equal(faintFg({ kind: "rgb", rgb: 0xffffff }), false, "Claude's explicit white");
assert.equal(faintFg({ kind: "rgb", rgb: 0x999999 }), true, "Claude's 153 grey");
assert.equal(faintFg({ kind: "rgb", rgb: 0x000000 }), false, "typed text on a light theme");
assert.equal(faintFg({ kind: "palette", index: 232 }), false, "the ramp's near black");
assert.equal(faintFg({ kind: "rgb", rgb: 0x505050 }), true);
assert.equal(faintFg({ kind: "rgb", rgb: 0xd77757 }), false, "a colour is not grey");
assert.equal(faintFg({ kind: "palette", index: 8 }), true);
assert.equal(faintFg({ kind: "palette", index: 244 }), true);
assert.equal(faintFg({ kind: "palette", index: 254 }), false);
assert.equal(faintFg({ kind: "palette", index: 2 }), false);
assert.equal(faintFg({ kind: "palette", index: 102 }), true, "the cube's grey 135,135,135");
console.log("inputDraft: all assertions passed");
