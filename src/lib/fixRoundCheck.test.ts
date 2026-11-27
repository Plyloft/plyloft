// 1.175.0 F5 (UX-5; owner I6, I7): Finish and check by itself after a fix
// round Plyloft sent. The rule (`fixRoundCheck.ts`), every row of "Quali
// giri", every case of mockup §1c, the cap, the card's switch over the
// setting, and the words.
import assert from "node:assert/strict";
import {
  AFTER_FIX_ROUND_HINT,
  AFTER_FIX_ROUND_SETTING_HINT,
  FIX_ROUND_CAP,
  FIX_ROUND_RECHECK_MS,
  FIX_ROUND_SETTLE_MS,
  checkingByItselfSentence,
  fixRoundCheckOn,
  fixRoundCountAfterReview,
  fixRoundFactsFrom,
  fixRoundHeldWords,
  fixRoundNext,
  fixRoundQualifies,
  fixRoundReviewer,
  fixingByItselfSentence,
  type FixRoundInput,
} from "./fixRoundCheck.ts";

const SENT = 1_000_000;
const ended = SENT + FIX_ROUND_SETTLE_MS + 5_000;

function input(over: Partial<FixRoundInput> = {}, session: Partial<FixRoundInput["session"]> = {}): FixRoundInput {
  return {
    on: true,
    round: { kind: "findings", ptyId: "p1", sentAt: SENT, turnStarted: true },
    ptyId: "p1",
    session: { attached: true, turnIdle: true, turnIdleAt: ended, asking: false, interrupted: false, draft: false, ...session },
    finishing: false,
    selfChecks: 0,
    changed: true,
    now: ended + 60_000,
    ...over,
  };
}

// ── "Quali giri": which rounds check by themselves ──────────────────────
const builder = {
  vendor: "claude",
  ptyId: "p1",
  startedAt: 0,
  snapshots: [],
  review: { snapshotN: 1, status: "done", verdict: "changes_requested" },
} as never;
for (const kind of ["findings", "checks", "pr"] as const) {
  assert.equal(fixRoundQualifies({ builder, prReview: null }, kind), true, `${kind}: by itself`);
}
// The person's own changes (Not right, Send to the Builder) and the first
// build are never a Plyloft round (`noteFixRoundSent(card, null)`); a card
// that reviews somebody else's pull request never qualifies.
assert.equal(fixRoundQualifies({ builder, prReview: null }, null), false, "Not right / Send to the Builder");
assert.equal(fixRoundQualifies({ builder: null, prReview: null }, "findings"), false, "no Builder: the first build");
assert.equal(fixRoundQualifies({ builder, prReview: { number: 1 } as never }, "findings"), false, "review card");
// Walk 5.4: the verdict delivered was an approval — what the Builder does
// next is the person's (a change they queued), never Plyloft's round.
const approved = { ...(builder as object), review: { snapshotN: 1, status: "done", verdict: "approve" } } as never;
assert.equal(fixRoundQualifies({ builder: approved, prReview: null }, "findings"), false, "an approval is no fix round");
assert.equal(fixRoundQualifies({ builder: approved, prReview: null }, "checks"), true, "failed checks: still Plyloft's");

// ── The card's switch over the setting ─────────────────────────────────
assert.equal(fixRoundCheckOn({ prReview: null, fixRoundCheck: null }, true), true, "absent: the setting (on)");
assert.equal(fixRoundCheckOn({ prReview: null, fixRoundCheck: undefined }, false), false, "absent: the setting (off)");
assert.equal(fixRoundCheckOn({ prReview: null, fixRoundCheck: false }, true), false, "the card waits");
assert.equal(fixRoundCheckOn({ prReview: null, fixRoundCheck: true }, false), true, "the card checks");
assert.equal(fixRoundCheckOn({ prReview: { number: 1 } as never, fixRoundCheck: true }, true), false, "never a review card");

// ── A clean finish starts it, once ──────────────────────────────────────
assert.deepEqual(fixRoundNext(input()), { do: "start" });
// The turn must have started after the round went in, then ended.
assert.deepEqual(fixRoundNext(input({ round: { kind: "findings", ptyId: "p1", sentAt: SENT } }, { turnIdleAt: SENT - 10 })), { do: "wait" });
assert.deepEqual(fixRoundNext(input({ round: { kind: "findings", ptyId: "p1", sentAt: SENT } }, { turnIdle: false })), { do: "note-turn" });
assert.deepEqual(fixRoundNext(input({ round: { kind: "findings", ptyId: "p1", sentAt: SENT } })), { do: "note-turn" }, "ended after the round: it ran");
assert.deepEqual(fixRoundNext(input({}, { turnIdle: false })), { do: "wait" }, "still working");
assert.deepEqual(fixRoundNext(input({}, { turnIdleAt: SENT })), { do: "wait" }, "an idle from before the round");
// Whether anything changed is asked once, before the start.
assert.deepEqual(fixRoundNext(input({ changed: undefined })), { do: "ask-changed" });

// ── §1c: it waits, and says why ─────────────────────────────────────────
assert.deepEqual(fixRoundNext(input({}, { interrupted: true })), { do: "hold", reason: "interrupted" }, "Esc");
assert.deepEqual(fixRoundNext(input({}, { draft: true })), { do: "hold", reason: "draft" }, "text in the prompt: never typed into");
// Walk 5.4: "Claude changed nothing" was said of a copy read too early (a
// turn that looked over while the edit was still landing). A "nothing" is
// read once more, a moment later, before the card says so; a turn that
// went on and ended again since the read is read again.
const NOW = ended + 60_000;
const readNothing = (at: number, again = false) =>
  input({ changed: false, round: { kind: "findings", ptyId: "p1", sentAt: SENT, turnStarted: true, changedRead: { at, idleAt: ended, again } } });
assert.deepEqual(fixRoundNext(readNothing(NOW - 500)), { do: "wait" }, "nothing, just read: a moment more");
assert.deepEqual(fixRoundNext(readNothing(NOW - FIX_ROUND_RECHECK_MS)), { do: "ask-changed", again: true }, "nothing: read once more");
assert.deepEqual(fixRoundNext(readNothing(NOW - FIX_ROUND_RECHECK_MS, true)), { do: "hold", reason: "nothing" }, "nothing twice: no file changed");
assert.deepEqual(
  fixRoundNext({ ...readNothing(NOW - 500, true), session: { ...input().session, turnIdleAt: ended + 30_000 } }),
  { do: "ask-changed" },
  "the turn ended again since the read: read again",
);
assert.deepEqual(fixRoundNext(input({ changed: null })), { do: "hold", reason: "unknown" }, "can't tell: waits");
assert.deepEqual(fixRoundNext(input({}, { asking: true, turnIdle: false })), { do: "hold", reason: "asks" }, "the Builder asks: never answered");

// ── The cap (owner I6): a third round waits; the count starts over ──────
assert.equal(FIX_ROUND_CAP, 2);
assert.deepEqual(fixRoundNext(input({ selfChecks: 1 })), { do: "start" });
assert.deepEqual(fixRoundNext(input({ selfChecks: 2 })), { do: "hold", reason: "cap" });
assert.equal(fixRoundCountAfterReview(2, { status: "done", verdict: "approve" }, true), 0, "an approval");
assert.equal(fixRoundCountAfterReview(1, { status: "done", verdict: "changes_requested" }, true), 1, "its own round asks again");
assert.equal(fixRoundCountAfterReview(2, { status: "done", verdict: "changes_requested" }, false), 0, "the person's own press");
assert.equal(fixRoundCountAfterReview(2, { status: "running", verdict: null }, false), 2, "not settled yet");

// ── Off, gone, or someone else's press: nothing by itself ───────────────
assert.deepEqual(fixRoundNext(input({ on: false })), { do: "forget" }, "switched off (Don't check by itself, or Waits for me)");
assert.deepEqual(fixRoundNext(input({}, { attached: false })), { do: "forget" }, "session closed");
assert.deepEqual(fixRoundNext(input({ ptyId: "p2" })), { do: "forget" }, "another session");
assert.deepEqual(fixRoundNext(input({ finishing: true })), { do: "forget" }, "Finish and check already pressed");

// ── What the card page reads ────────────────────────────────────────────
const card = { id: "c", prReview: null, fixRoundCheck: null };
const state = { rounds: {}, checking: {}, stopped: {} } as Parameters<typeof fixRoundFactsFrom>[0];
assert.equal(fixRoundFactsFrom(state, card, true), null);
assert.deepEqual(fixRoundFactsFrom({ ...state!, rounds: { c: {} } }, card, true), { byItself: true, held: null, checking: null, stopped: false });
assert.equal(fixRoundFactsFrom({ ...state!, rounds: { c: {} } }, card, false)?.byItself, false, "off: today's words");
assert.equal(fixRoundFactsFrom({ ...state!, rounds: { c: { held: "draft" } } }, card, true)?.byItself, false);
assert.equal(fixRoundFactsFrom({ ...state!, rounds: { c: {} } }, { ...card, prReview: { number: 1 } as never }, true), null);
assert.deepEqual(fixRoundFactsFrom({ ...state!, checking: { c: { since: 5 } } }, card, true)?.checking, { since: 5 });

// ── Words (STRINGS-immediacy.md F5) ─────────────────────────────────────
assert.equal(fixRoundReviewer("claude", null), "Codex");
assert.equal(fixRoundReviewer("codex", null), "Claude");
assert.equal(fixRoundReviewer("claude", "claude"), "Claude", "the last review's own");
assert.equal(
  fixingByItselfSentence("Claude", "Codex"),
  "Claude is working on them in its session. When it's done, Plyloft checks the fixes by itself: your checks run and Codex reviews them.",
);
assert.equal(
  checkingByItselfSentence("Claude", "Codex"),
  "Claude finished, so Plyloft started Finish and check: Claude re-reads its work, your checks run, then Codex reviews the fixes. You can leave this; Plyloft tells you when it's done.",
);
assert.deepEqual(fixRoundHeldWords("interrupted", "Claude", "Codex"), {
  label: "Claude stopped before it finished",
  helper: "Claude was interrupted, so Plyloft didn't check the fixes by itself. Tell it to carry on, or Finish and check what's there.",
});
assert.deepEqual(fixRoundHeldWords("draft", "Claude", "Codex"), {
  label: "Claude finished the fixes",
  helper: "Plyloft didn't check by itself: there is text in the Builder's prompt. Send or clear what you typed, then press Finish and check again.",
});
assert.equal(fixRoundHeldWords("nothing", "Claude", "Codex")?.label, "Claude changed nothing");
assert.equal(fixRoundHeldWords("asks", "Claude", "Codex")?.label, "Claude asks you something");
assert.deepEqual(fixRoundHeldWords("cap", "Claude", "Codex"), {
  label: "Codex asked for changes three times",
  helper: "Plyloft checked the fixes by itself twice and Codex still asks for changes, so this round waits for you. Read the review before going on.",
});
assert.equal(fixRoundHeldWords("unknown", "Claude", "Codex"), null, "today's words");
assert.match(AFTER_FIX_ROUND_HINT, /The first build and your own changes always wait for you\.$/);
assert.match(AFTER_FIX_ROUND_SETTING_HINT, /never ships and never answers the Builder's questions\.$/);

console.log("fixRoundCheck (F5): ok");
