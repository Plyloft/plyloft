// 1.171.0 D2 (owner D11): the cursor goes to the terminal at first open only.
// Run with Node 22+: node --experimental-strip-types src/lib/sessionFocus.test.ts
import assert from "node:assert/strict";
import { firstSessionOpen, markSessionOpened, resetSessionFocus, sessionFocusNoteHolds, sessionFocusWords } from "./sessionFocus.ts";

resetSessionFocus();
assert.equal(firstSessionOpen("c1", "run"), true, "first open moves the cursor");
assert.equal(firstSessionOpen("c1", "run"), true, "until a terminal took it, it is still the first");
markSessionOpened("c1", "run");
assert.equal(firstSessionOpen("c1", "run"), false, "a later open does not");
assert.equal(firstSessionOpen("c1", "intake"), true, "the conversation is its own first open");
assert.equal(firstSessionOpen("c2", "run"), true, "each card has its own");
resetSessionFocus();
assert.equal(firstSessionOpen("c1", "run"), true, "reset forgets");

assert.equal(sessionFocusWords("run"), "The cursor is in the session now: what you type goes there.");
assert.equal(sessionFocusWords("intake"), "The cursor is in the conversation now: what you type goes there.");

console.log("sessionFocus: ok");

// 1.172.0 walk (E1): the note goes once the session closes or is hidden.
const open = { cardId: "c1", runOpen: true, intakeOpen: false };
assert.equal(sessionFocusNoteHolds({ cardId: "c1", section: "run" }, open), true);
assert.equal(sessionFocusNoteHolds({ cardId: "c1", section: "run" }, { ...open, runOpen: false }), false, "closed or hidden");
assert.equal(sessionFocusNoteHolds({ cardId: "c1", section: "intake" }, open), false, "the conversation isn't open");
assert.equal(sessionFocusNoteHolds({ cardId: "c2", section: "run" }, open), false, "another card's");
assert.equal(sessionFocusNoteHolds({ cardId: "c1", section: null }, open), false, "nothing said");
