// QoL 1.168 G1: the update sheet's words. Run with Node 22+:
//   node --experimental-strip-types src/lib/updateWords.test.ts
import assert from "node:assert/strict";
import { NOTHING_RUNNING, type RunningCounts } from "./closeChoice.ts";
import {
  DOWNLOAD_URL,
  WHEN_DONE_LABEL,
  scheduledRowText,
  updateConfirmBody,
  updateFailedError,
  updateWaitLine,
  whenDoneHint,
} from "./updateWords.ts";
import { quitSheetWords } from "./quitGuard.ts";

const c = (over: Partial<RunningCounts>): RunningCounts => ({ ...NOTHING_RUNNING, ...over });

// Nothing open: said so.
assert.equal(
  updateConfirmBody(NOTHING_RUNNING, NOTHING_RUNNING),
  "Installing quits Plyloft and opens the new version. Nothing is running, so nothing stops.",
);

// Every live session and terminal is counted, not only Builders; the work in
// flight is named apart.
assert.equal(
  updateConfirmBody(c({ sessions: 1, builds: 1 }), c({ sessions: 3, terminals: 2, builds: 1 })),
  "Installing quits Plyloft and opens the new version. Right now 1 session and 1 build are working: that work stops halfway, and a turn in progress is lost. 3 open sessions and 2 terminals close. Claude and Codex keep their conversations, and each card offers Resume.",
);
assert.equal(
  updateConfirmBody(NOTHING_RUNNING, c({ sessions: 1 })),
  "Installing quits Plyloft and opens the new version. 1 open session closes. Claude and Codex keep their conversations, and each card offers Resume.",
);
assert.equal(
  updateConfirmBody(NOTHING_RUNNING, c({ terminals: 1 })),
  "Installing quits Plyloft and opens the new version. 1 terminal closes.",
);

// No jargon in anything the sheet says.
const said = [
  updateConfirmBody(c({ sessions: 2, runs: 1, reviews: 1 }), c({ sessions: 4, terminals: 1 })),
  WHEN_DONE_LABEL,
  whenDoneHint(true),
  whenDoneHint(false),
  scheduledRowText("1.169.0"),
];
for (const phase of ["check", "download", "install", "relaunch"] as const) {
  for (const stalled of [false, true]) {
    const e = updateFailedError({ phase, stalled, reason: "raw text", version: "1.169.0" });
    said.push(e.title, e.happened, e.untouched, e.todo, ...e.actions.map((a) => a.label));
    // The raw error is the Details, never the sentence.
    assert.equal(e.details, "raw text");
    assert.ok(!`${e.title} ${e.happened}`.includes("raw text"));
    assert.ok(e.actions.length <= 2);
  }
}
for (const line of said) {
  assert.doesNotMatch(line, /worktree|terminal pane|transcript|terminate|relaunch/i, line);
}

// A download that fails offers Try again and the download page.
{
  const e = updateFailedError({ phase: "download", stalled: false, reason: "x", version: "1.169.0" });
  assert.equal(e.title, "Plyloft couldn't download the update.");
  assert.deepEqual(e.actions.map((a) => a.id), ["retry", "download"]);
  assert.match(e.untouched, /keeps working/);
  assert.equal(DOWNLOAD_URL, "https://www.plyloft.com/download");
}
// A check by hand that failed names no version.
{
  const e = updateFailedError({ phase: "check", stalled: false, reason: "x", version: null });
  assert.equal(e.title, "Plyloft couldn't check for updates.");
  assert.deepEqual(e.actions.map((a) => a.id), ["retry"]);
}
// A stalled download says so.
assert.equal(
  updateFailedError({ phase: "download", stalled: true, reason: "x", version: "2.0.0" }).title,
  "The download stopped.",
);
// Mac: the hint names the quit; Windows: it doesn't.
assert.match(whenDoneHint(true), /until you quit Plyloft/);
assert.doesNotMatch(whenDoneHint(false), /quit/);

// 1.176.4 (owner): why a scheduled update waits, in one line, with the quit
// sheet's words for the same states.
assert.equal(updateWaitLine(NOTHING_RUNNING), null);
assert.equal(updateWaitLine(c({ waiting: 1 })), "Waiting: 1 session asks you something.");
assert.equal(updateWaitLine(c({ waiting: 2 })), "Waiting: 2 sessions ask you something.");
assert.equal(updateWaitLine(c({ sessions: 1 })), "Waiting: 1 session is working.");
assert.equal(updateWaitLine(c({ sessions: 2, builds: 1 })), "Waiting: 2 sessions and 1 build are working.");
assert.equal(updateWaitLine(c({ shipping: true })), "Waiting: a card is shipping.");
assert.equal(
  updateWaitLine(c({ sessions: 1, waiting: 1 })),
  "Waiting: 1 session is working · 1 session asks you something.",
);
// The quit sheet says the same thing about the same counts.
for (const counts of [c({ waiting: 1 }), c({ waiting: 3 }), c({ sessions: 1 }), c({ sessions: 2, waiting: 1, runs: 1 })]) {
  const lede = quitSheetWords({ files: [], working: counts }, "update", { askWorking: true, workingAcknowledged: false }).lede;
  assert.equal(updateWaitLine(counts), `Waiting: ${lede.charAt(0).toLowerCase()}${lede.slice(1)}`);
}

console.log("updateWords tests passed");
