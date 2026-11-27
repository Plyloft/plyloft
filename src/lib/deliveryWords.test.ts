// 1.171.0 A1: the delivery words pass ux-check's JARGON, and the ones that
// name this computer read "this PC" on Windows through machineWords.
//     node --experimental-strip-types src/lib/deliveryWords.test.ts
import assert from "node:assert/strict";
import * as W from "./deliveryWords.ts";
import {
  ALL_DELIVERY_WORDS,
  DELIVERY_STAGE_WORDS,
  PLYLOFT_MERGES_WHEN_OPEN,
  shippedOnlyHereHelper,
  yourTurnHelper,
  MACHINE_WORDED,
  ON_GITHUB_WAITING,
  ON_THIS_MACHINE,
  PLYLOFT_MERGES_WHILE_OPEN,
  SESSION_WORDS,
  SHIP_CHOICE_ONLY_HERE,
  SHIPPED_ONLY_HERE,
  clashesWithLabel,
  pausedLabel,
} from "./deliveryWords.ts";
import { ONLY_HERE_LABEL } from "./shipVia.ts";
import { FINISH_AGAIN_LABEL } from "./cardLifecycle.ts";
import { machineWords } from "./platform.ts";

const { JARGON } = (await import(new URL("../../scripts/ux-check.mjs", import.meta.url).href)) as {
  JARGON: [string, RegExp][];
};

// The parameterised words, as B and C will show them.
assert.equal(clashesWithLabel("main"), "Clashes with main");
assert.equal(clashesWithLabel("origin/develop"), "Clashes with develop", "never origin/…");
assert.equal(clashesWithLabel(null), "Clashes with your main branch");
assert.equal(clashesWithLabel("  "), "Clashes with your main branch");
assert.equal(pausedLabel("15:00"), "Paused · your plan's limit resets at 15:00");
assert.equal(pausedLabel(null), "Paused · your plan's limit resets soon");
assert.equal(pausedLabel(), "Paused · your plan's limit resets soon");
assert.equal(pausedLabel(" "), "Paused · your plan's limit resets soon");
assert.deepEqual(Object.values(SESSION_WORDS), ["Working", "Asks you something", "Your turn", "Closed"]);
assert.equal(shippedOnlyHereHelper("main"), "main on this Mac has it; GitHub doesn't.");
assert.equal(shippedOnlyHereHelper("origin/develop"), "develop on this Mac has it; GitHub doesn't.");
assert.equal(shippedOnlyHereHelper(null), "Your main branch on this Mac has it; GitHub doesn't.");
assert.equal(yourTurnHelper("Claude"), "Claude says it's done. Check it, or tell it what's missing.");
assert.equal(DELIVERY_STAGE_WORDS.plyloftMergesWhenOpen, PLYLOFT_MERGES_WHEN_OPEN);
assert.equal(Object.keys(DELIVERY_STAGE_WORDS).length, 7);

// 1.171.0 B2: before and after Ship it.
assert.equal(
  W.shipItSentence(true, "main"),
  "Ship it puts it on GitHub as a pull request and merges it with main once GitHub's checks pass.",
);
assert.equal(W.shipItSentence(false, "origin/develop"), "Ship it adds it to develop on this Mac; GitHub doesn't get it.");
assert.equal(W.shipItSentence(false, null), "Ship it adds it to your main branch on this Mac; GitHub doesn't get it.");
assert.equal(
  W.prOpenedToastLine("https://github.com/me/app/pull/12", "github"),
  "On GitHub: pull request #12 · it merges by itself once GitHub's checks pass. You can keep working.",
);
// 1.171.0 re-walk (step 3): the card has its own Merge too.
assert.equal(
  W.shipAnywaySentence("walk-ux-1171"),
  "It goes to GitHub as a pull request that doesn't merge by itself: you merge it with walk-ux-1171 when it's ready, here or on GitHub.",
);
assert.equal(W.prOpenedToastLine(null, "you"), "On GitHub: its pull request · you merge it when it's ready, here or on GitHub. You can keep working.");
// 1.172.0 B3 (B2 Challenger leftover): the toast says who really merges it.
assert.equal(
  W.prOpenedToastLine("https://github.com/me/app/pull/12", "plyloft"),
  "On GitHub: pull request #12 · Plyloft merges it once GitHub's checks pass, while it's open on this Mac. You can keep working.",
);
assert.match(machineWords(W.prOpenedToastLine(null, "plyloft"), "windows"), /while it's open on this PC\./);
assert.equal(W.prOpenedMerger(false, { autoMerge: true }), "you");
assert.equal(W.prOpenedMerger(true, { plyloftAutoMerge: true }), "plyloft");
assert.equal(W.prOpenedMerger(true, { autoMerge: true }), "github");
assert.equal(W.prOpenedMerger(true, { autoMerge: false, autoMergeRefused: "auto-merge is not allowed" }), "you");
assert.equal(W.prOpenedMerger(true, null), "github");
assert.equal(W.prOpenedMerger(true, {}), "github");
assert.equal(W.sessionClosedLine("Notes", "merged"), "“Notes” is merged, so its Builder session was closed.");
assert.equal(W.sessionClosedLine("Notes", "shipped"), "“Notes” shipped, so its Builder session was closed.");
assert.equal(W.liveSentence("main"), "It's in main on GitHub. If your site deploys from main, it's on its way live.");
assert.equal(W.liveSentence(null), "It's in your main branch on GitHub. If your site deploys from it, it's on its way live.");
assert.equal(W.quitMergeNote(0), null);
assert.equal(W.ifYouQuitMergeNote(0), null);
assert.equal(W.ifYouQuitMergeNote(1), "If you quit, 1 pull request waits for Plyloft to merge it when it's open again.");
assert.equal(W.ifYouQuitMergeNote(2), "If you quit, 2 pull requests wait for Plyloft to merge them when it's open again.");
assert.equal(W.quitMergeNote(1), "1 pull request waits for Plyloft to merge it. It merges when Plyloft is open again.");
assert.equal(W.quitMergeNote(3), "3 pull requests wait for Plyloft to merge them. They merge when Plyloft is open again.");

// Nothing escapes the checks below: every string export, and every string
// in an object export (the stage and session records), is in ALL_DELIVERY_WORDS.
for (const [name, value] of Object.entries(W)) {
  if (typeof value === "string") assert.ok(ALL_DELIVERY_WORDS.includes(value), `${name} is in ALL_DELIVERY_WORDS`);
  else if (value && typeof value === "object" && !Array.isArray(value))
    for (const [k, v] of Object.entries(value))
      if (typeof v === "string") assert.ok(ALL_DELIVERY_WORDS.includes(v), `${name}.${k} is in ALL_DELIVERY_WORDS`);
}

// No banned word in any of them, on either platform.
const helpers = [
  shippedOnlyHereHelper("main"),
  shippedOnlyHereHelper(null),
  W.shipItSentence(true, "main"),
  W.shipItSentence(false, "main"),
  W.shipItSentence(true, null),
  W.shipItSentence(false, null),
  W.prOpenedToastLine("https://github.com/me/app/pull/12", "github"),
  W.prOpenedToastLine("https://github.com/me/app/pull/12", "you"),
  W.prOpenedToastLine(null, "github"),
  W.prOpenedToastLine("https://github.com/me/app/pull/12", "plyloft"),
  W.sessionClosedLine("Notes", "merged"),
  W.sessionClosedLine("Notes", "shipped"),
  W.liveSentence("main"),
  // 1.171.0 B3 (CP-17): Send the fixes to GitHub's line, both card kinds.
  W.sendFixesLine(12),
  W.liveSentence(null),
  W.quitMergeNote(1)!,
  W.quitMergeNote(2)!,
  W.ifYouQuitMergeNote(1)!,
  W.ifYouQuitMergeNote(2)!,
  // 1.171.0 C1 (CF1): the fix round.
  W.fixingHeadline("Claude", 3),
  W.fixingHeadline("Codex", 1),
  W.fixingHeadline("Claude", 0),
  W.fixingHeadline("Claude", "changes"),
  W.fixingSentence("Claude"),
  W.fixesDoneHeadline("Claude"),
  W.fixesDoneSentence("Codex", true),
  W.fixesDoneSentence("Claude", false),
  // 1.171.0 C2 (CF3, CF16): the waits after Finish and check.
  W.selfCheckWaitSentence(),
  W.selfCheckWhat("Claude", true),
  W.selfCheckWhat("Codex", false),
  W.reviewWaitSentence("Codex", "Claude", false),
  W.reviewWaitSentence("Claude", "Codex", true),
  W.waitTitle("Claude is re-reading its work", 80_000),
];
const shown = [
  ...ALL_DELIVERY_WORDS,
  clashesWithLabel("main"),
  clashesWithLabel(null),
  pausedLabel("15:00"),
  pausedLabel(null),
  yourTurnHelper("Claude"),
  yourTurnHelper("Codex"),
  ...helpers,
];
assert.equal(new Set(shown).size, shown.length, "no line twice");
for (const line of shown) {
  for (const p of ["mac", "windows"] as const) {
    const text = machineWords(line, p);
    for (const [word, re] of JARGON) {
      re.lastIndex = 0;
      assert.ok(!re.test(text), `"${text}" uses the banned word ${word}`);
    }
  }
}
// "Waiting" only ever as waiting *for* something, never a state of its own.
assert.match(ON_GITHUB_WAITING, /waiting for /);

// "this Mac" goes through machineWords: "this PC" on Windows.
assert.equal(machineWords(ON_THIS_MACHINE, "windows"), "On this PC");
assert.equal(machineWords(SHIPPED_ONLY_HERE, "windows"), "Shipped · only on this PC");
assert.equal(machineWords(SHIP_CHOICE_ONLY_HERE, "windows"), "Only on this PC");
assert.equal(machineWords(PLYLOFT_MERGES_WHILE_OPEN, "windows"), "Plyloft merges it while it's open on this PC");
assert.equal(machineWords(shippedOnlyHereHelper("main"), "windows"), "main on this PC has it; GitHub doesn't.");
assert.equal(machineWords(W.shipItSentence(false, "main"), "windows"), "Ship it adds it to main on this PC; GitHub doesn't get it.");
for (const line of shown) {
  const names = /\bMac\b/.test(line);
  if (!helpers.includes(line))
    assert.equal(MACHINE_WORDED.includes(line), names, `MACHINE_WORDED lists exactly the lines naming the Mac: ${line}`);
  if (names) assert.doesNotMatch(machineWords(line, "windows"), /\bMac\b/, line);
  assert.equal(machineWords(line, "mac"), line, "the Mac reads the words as written");
}

assert.equal(
  machineWords(W.sendFixesLine(12), "windows"),
  "Your latest fixes are only on this PC. Send them to pull request #12 so GitHub checks them again.",
);

// 1.171.0 C1 (CF1): the fix round, in the AI's name.
assert.equal(W.fixingHeadline("Claude", 3), "Claude is fixing 3 findings");
assert.equal(W.fixingHeadline("Codex", 1), "Codex is fixing 1 finding");
assert.equal(W.fixingHeadline("Claude", 0), "Claude is fixing the findings");
assert.equal(W.fixingHeadline("Claude", "changes"), "Claude is working on your changes");
assert.equal(W.fixesDoneHeadline("Claude"), "Claude finished the fixes");
assert.ok(W.fixesDoneSentence("Codex", true).includes(FINISH_AGAIN_LABEL), "names the press Now offers");
assert.ok(W.fixesDoneSentence("Codex", true).includes(W.agreeWithBuilderLabel("Codex")), "and the way on when it disagrees");
assert.doesNotMatch(W.fixesDoneSentence("Codex", true), /says they're done|are done/, "a turn over is not the work done");
assert.ok(W.fixesDoneSentence("Claude", false).includes(FINISH_AGAIN_LABEL));
assert.ok(W.fixingSentence("Claude").includes(FINISH_AGAIN_LABEL));

// Ship ▾'s land here is the same word in shipVia.
assert.equal(ONLY_HERE_LABEL, SHIP_CHOICE_ONLY_HERE);

// 1.171.0 C3 (CF2, CF18, CF25, CP-9, CP-10): when the two AIs disagree.
assert.equal(W.agreeWithBuilderLabel("Claude"), "Agree with Claude, keep it as it is");
assert.equal(W.agreeWithBuilderLabel("Codex"), "Agree with Codex, keep it as it is");
assert.equal(W.SHIP_WITHOUT_CHANGES_LABEL, "Ship without these changes");
assert.match(W.SHIP_WITHOUT_CHANGES_TITLE, /Nothing is shipped yet/, "it moves the card on; it doesn't ship");
assert.match(W.agreeWithBuilderTitle("Codex"), /Codex disagrees/);
assert.equal(W.FINISH_WITHOUT_REVIEW_LABEL, "Check without the Reviewer");
// Its hint says what really happens: checks run, no self-check, no
// review — and (owner 2026-10-27) the card is unreviewed: its pull request
// never merges by itself and says the review was skipped.
assert.match(W.FINISH_WITHOUT_REVIEW_HINT, /checks still run/);
assert.match(W.FINISH_WITHOUT_REVIEW_HINT, /doesn't re-read its work/);
assert.match(W.FINISH_WITHOUT_REVIEW_HINT, /never merges by itself/);
assert.match(W.FINISH_WITHOUT_REVIEW_HINT, /says the review was skipped/);
// 1.174.0 C5 (T47): merged with Merge on the card or on GitHub.
assert.match(W.FINISH_WITHOUT_REVIEW_HINT, /you merge it yourself, with Merge on the card or on GitHub,/);
assert.equal(W.approvedWord(0), "Approved");
assert.equal(W.approvedWord(1), "Approved (1 small note)");
assert.equal(W.approvedWord(2), "Approved (2 small notes)");
assert.equal(W.SMALL_NOTE_MARK, "Small note · nothing to do");
// Challenger 6: who overrode, one helper for the facts and the result.
assert.equal(W.overriddenByWho(null, "me@x.com"), "you");
assert.equal(W.overriddenByWho(" Me@X.com ", "me@x.com"), "you");
assert.equal(W.overriddenByWho("ana@x.com", "me@x.com"), "ana@x.com");
assert.equal(W.overriddenByWho("ana@x.com", null), "ana@x.com");
assert.equal(W.overriddenWord(null, null), W.OVERRIDDEN_WORD);
assert.equal(W.overriddenWord("ana@x.com", "me@x.com"), "Overridden by ana@x.com");
for (const line of [
  W.agreeWithBuilderLabel("Claude"),
  W.agreeWithBuilderTitle("Claude"),
  W.fixesDoneSentence("Claude", true),
  W.approvedWord(2),
]) {
  for (const [word, re] of JARGON) {
    re.lastIndex = 0;
    assert.ok(!re.test(line), `${word} in “${line}”`);
  }
}

console.log("deliveryWords: ok");

// 1.171.0 C2 (CF3, CF16): the wait after Finish and check — what happens,
// for how long, and that the person can leave.
assert.equal(W.LEAVE_LINE, "You can leave this; Plyloft tells you when it's done.");
// 1.175.0 F9 (UX-8): the word says what the Builder does; Now's title says
// who; the sentence says what comes next.
assert.equal(W.CHECKING_WORK_LABEL, "Re-reading its work");
assert.equal(W.selfCheckWhat("Claude", true), "Claude is re-reading its work");
assert.equal(W.selfCheckWhat("Codex", false), "Codex re-reads its work once it's done with what it's doing");
assert.equal(
  W.selfCheckWaitSentence(),
  "Then your checks run and the Reviewer reviews it. You can leave this; Plyloft tells you when it's done.",
);
assert.equal(
  W.reviewWaitSentence("Codex", "Claude", true),
  "Codex is reviewing Claude's work without changing it, and your checks are running. You can leave this; Plyloft tells you when it's done.",
);
assert.equal(W.waitTitle("Running checks", 80_000), "Running checks · 1m 20s");
assert.equal(W.waitTitle("Running checks", 9_400), "Running checks · 9s");
assert.equal(W.waitTitle("Reviewing", 2 * 3600_000 + 5 * 60_000), "Reviewing · 2h 5m");
assert.equal(W.waitTitle("Re-reading its work", null), "Re-reading its work");
assert.equal(W.waitTitle("Re-reading its work", 300), "Re-reading its work");
// The state word is no "Waiting" (ux-check's state rule).
assert.ok(!/^Waiting\b/.test(W.CHECKING_WORK_LABEL));
