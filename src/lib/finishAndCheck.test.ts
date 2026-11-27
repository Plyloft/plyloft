// UX P1 point 3 (P-B): Finish and check pressed early asks a plain question
// in two cases, and nothing once the Builder's turn is over.
// Run with Node 22+:
//   node --experimental-strip-types src/lib/finishAndCheck.test.ts
import assert from "node:assert/strict";
import { earlyFinishSheet, workSavedToastWords } from "./finishAndCheck.ts";
import { NO_CHECKS_TO_RUN } from "./buildBoth.ts";
import {
  BUILDER_SESSION_WORDS,
  FINISH_AGAIN_LABEL,
  FINISH_BUSY_LABEL,
  FINISH_LABEL,
  FINISH_TITLE,
  WORK_SAVED_LABEL,
} from "./cardLifecycle.ts";

const NOW = 1_700_000_000_000;
const base = { vendor: "claude" as const, startedAt: NOW - 60_000 };

// The words of the press (owner decision D1) and of the state after it.
assert.equal(FINISH_LABEL, "Finish and check");
assert.equal(FINISH_AGAIN_LABEL, "Finish and check again");
assert.equal(FINISH_BUSY_LABEL, "Saving and checking…");
assert.equal(
  FINISH_TITLE,
  "Saves the Builder's work, runs your checks and has it reviewed. The session stays open.",
);
assert.equal(WORK_SAVED_LABEL, "Your turn");
assert.deepEqual(BUILDER_SESSION_WORDS, {
  working: "Working",
  question: "Asks you something",
  stopped: "Your turn",
  quiet: "Your turn",
});

// Still working (output just now, no prompt in view).
assert.deepEqual(earlyFinishSheet({ ...base, lastOutputAt: NOW - 500, promptBoxIdle: false }, NOW), {
  title: "Claude is still working. Finish now?",
  body: "Plyloft saves the work as it is now, tests it and has it reviewed. Anything Claude does after this waits for the next Finish and check.",
  confirmLabel: "Finish now",
  cancelLabel: "Keep working",
  cautious: true,
});
// Quiet without a prompt in view is not its turn over either; (Challenger)
// the card says "Maybe waiting for you" then, so the sheet does not say it
// "is still working".
assert.equal(earlyFinishSheet({ ...base, vendor: "codex", lastOutputAt: NOW - 60_000 }, NOW)?.title, "Codex may still be working. Finish now?");
// 1.174.3: resumed with nothing sent in: Now says nothing has started, so no
// "still working". A question in view still asks.
assert.equal(earlyFinishSheet({ ...base, lastOutputAt: NOW - 500, promptBoxIdle: false }, NOW, true), null);
assert.equal(
  earlyFinishSheet({ ...base, lastOutputAt: NOW - 500, promptBoxIdle: true, questionInView: true }, NOW, true)?.title,
  "Claude asked you something. Finish anyway?",
);

// A question waits (an approval in view).
assert.deepEqual(
  earlyFinishSheet({ ...base, lastOutputAt: NOW - 500, promptBoxIdle: true, questionInView: true }, NOW),
  {
    title: "Claude asked you something. Finish anyway?",
    body: "Its question stays unanswered. Plyloft saves the work as it is now and tests it.",
    confirmLabel: "Finish anyway",
    cancelLabel: "Answer first",
    cautious: true,
  },
);

// Its turn over at its prompt: no sheet, the press goes on.
assert.equal(earlyFinishSheet({ ...base, lastOutputAt: NOW - 30_000, promptBoxIdle: true, turnIdle: true }, NOW), null);
// At its prompt (before the turn scan settles): no sheet, as before P-B.
assert.equal(earlyFinishSheet({ ...base, lastOutputAt: NOW - 30_000, promptBoxIdle: true }, NOW), null);
// No session attached here: nothing to ask about.
assert.equal(earlyFinishSheet(null, NOW), null);

console.log("finishAndCheck: ok");

// 1.168.1 B3: the toast after Finish and check says checks are running only
// when the project has some.
{
  const none = workSavedToastWords(false, true);
  assert.equal(none.title, "Work saved");
  assert.equal(none.body, NO_CHECKS_TO_RUN);
  assert.doesNotMatch(none.body, /checks are running/);
  assert.doesNotMatch(workSavedToastWords(true, true).body, /checks are running/);
  assert.match(workSavedToastWords(true, true).body, /The Reviewer reviews this round/);
  assert.equal(workSavedToastWords(false, false).body, "Your checks are running. The result goes back to the Builder.");
  assert.match(workSavedToastWords(true, false).body, /^Your checks are running\. The Reviewer reviews/);
}
