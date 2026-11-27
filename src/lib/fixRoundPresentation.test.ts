// 1.175.0 F5: Now's new states in a round that checks by itself, on the
// shared fixtures of the fix round (`cardPresentation.fixtures.ts`): the
// fixing sentence, the check started by itself, the reasons it waits, the
// check the person stopped — and today's words when the round is not one.
import assert from "node:assert/strict";
import { presentCard } from "./cardPresentation.ts";
import { PRESENTATION_FIXTURES } from "./cardPresentation.fixtures.ts";
import type { FixRoundFacts } from "./fixRoundCheck.ts";
import { CHECKING_WORK_LABEL } from "./deliveryWords.ts";

const fx = (name: string) => {
  const f = PRESENTATION_FIXTURES.find((x) => x.name === name);
  assert.ok(f, name);
  return f!;
};
const with_ = (name: string, fixRound: FixRoundFacts | null, session?: Record<string, unknown>) => {
  const f = fx(name);
  return presentCard(f.card, { ...f.live, fixRound, ...(session ? { session: { ...f.live.session!, ...session } } : {}) });
};
const facts = (over: Partial<FixRoundFacts> = {}): FixRoundFacts => ({ byItself: true, held: null, checking: null, stopped: false, ...over });

const FIXING = "changes requested, its Builder fixes them";
const FIXED = "changes requested, its Builder finished the fixes";

// While it fixes: the sentence says the check follows by itself.
const fixing = with_(FIXING, facts());
assert.equal(fixing.rule, "builder-fixing");
assert.match(fixing.sentence, /When it's done, Plyloft checks the fixes by itself: your checks run and Codex reviews them\.$/);
// Not a round that checks by itself: today's sentence.
assert.match(with_(FIXING, null).sentence, /Finish and check again tests the fixes and has them reviewed\.$/);
assert.match(with_(FIXING, facts({ byItself: false })).sentence, /Finish and check again tests the fixes/);

// The reasons it waits: their own words, the same press (Finish and check again).
const held = (reason: FixRoundFacts["held"]) => with_(FIXED, facts({ byItself: false, held: reason }));
assert.equal(held("interrupted").headline, "Claude stopped before it finished");
assert.equal(held("draft").sentence, "Plyloft didn't check by itself: there is text in the Builder's prompt. Send or clear what you typed, then press Finish and check again.");
assert.equal(held("nothing").headline, "Claude changed nothing");
assert.equal(held("cap").headline, "Codex asked for changes three times");
for (const reason of ["interrupted", "draft", "nothing", "cap"] as const) {
  assert.equal(held(reason).action.id, "finish-and-check", reason);
  assert.equal(held(reason).column, "needs-you", `${reason}: the card waits for the person`);
}
assert.equal(held("unknown").headline, "Claude finished the fixes", "can't tell: today's words");
// The person stopped the check.
const stopped = with_(FIXED, facts({ byItself: false, stopped: true }));
assert.equal(stopped.headline, "You stopped the check");
assert.equal(stopped.sentence, "Nothing was saved or checked yet. Finish and check again starts it over.");
assert.equal(stopped.action.id, "finish-and-check");

// The check started by itself: its own word and sentence, at work.
const checking = with_(FIXED, facts({ checking: { since: 1 } }), { finishing: true, state: "working", selfCheck: { since: 1, delivered: true } });
assert.equal(checking.rule, "finishing");
assert.equal(checking.headline, "Checking the fixes by itself");
assert.match(checking.sentence, /^Claude finished, so Plyloft started Finish and check: Claude re-reads its work, your checks run, then Codex reviews the fixes\./);
assert.notEqual(checking.column, "needs-you");
// Without it, the same moment is today's word (F9: "Re-reading its work").
const pressed = with_(FIXED, null, { finishing: true, state: "working", selfCheck: { since: 1, delivered: true } });
assert.equal(pressed.headline, CHECKING_WORK_LABEL);

console.log("fixRoundPresentation (F5): ok");
