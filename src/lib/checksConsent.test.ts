// 1.175.0 B2 (SEC-4): the words of the checks' and the install step's OK
// (`STRINGS-sharing.md`, B2), and which step the two lists mark.
import assert from "node:assert/strict";
import {
  ALLOW_AND_RUN,
  CHECKS_OK_COVERS,
  INSTALL_OK_COVERS,
  othersWaitingLine,
  CHECKS_OK_ACTION_TITLE,
  CHECKS_OK_LABEL,
  NO_CONSENT,
  autoFixWaitingLine,
  changedSteps,
  checksApprovalNote,
  checksListHeadings,
  checksOkInboxDetail,
  checksOkSentence,
  installApprovalNote,
  installHeldFor,
  installHeldSentence,
  installRowDetail,
  installRowTitle,
  installSheetHint,
  installSheetLede,
  isChecksHold,
  publishConsequences,
  stepChangeSentences,
  stepChanges,
  stepWords,
  type CheckStep,
  type ChecksView,
} from "./checksConsent.ts";
import { inboxRowWords, isInstallOkRow } from "./inboxView.ts";

const NOW = 1_800_000_000_000;
const script = (text: string): CheckStep => ({ claude: false, text });
const claude = (text: string, args?: string): CheckStep => ({ claude: true, text, args: args ?? null });

const approved = [script("./scripts/check.sh"), script("npm test")];
const current = [...approved, claude("/ppvp", "then tidy the release folder")];
const changed: ChecksView = {
  needsOk: true,
  firstTime: false,
  approved,
  current,
  hash: "h",
  who: "example-teammate",
  changedAt: NOW - 2 * 3_600_000,
};
const first: ChecksView = { ...changed, firstTime: true, approved: [], who: null, changedAt: null, current: approved };

// ── Now ──
assert.equal(CHECKS_OK_LABEL, "The checks need your OK");
assert.equal(ALLOW_AND_RUN, "Allow and run");
assert.equal(CHECKS_OK_ACTION_TITLE, "Lets the repository's checks run on this Mac from now on, then runs them.");
assert.equal(
  checksOkSentence(changed, NOW),
  "example-teammate changed this repository's checks 2 h ago. Allow them on this Mac? The Builder's work is saved, and nothing has run.",
);
assert.equal(
  checksOkSentence({ ...changed, who: null, changedAt: null }, NOW),
  "Someone changed this repository's checks. Allow them on this Mac? The Builder's work is saved, and nothing has run.",
);
assert.equal(
  checksOkSentence(first, NOW),
  "This repository's checks haven't run on this Mac before. Allow them here? The Builder's work is saved, and nothing has run.",
);
// With the round that fixes checks by itself, it is the fix that is saved.
assert.equal(
  checksOkSentence(changed, NOW, true),
  "example-teammate changed this repository's checks 2 h ago. Allow them on this Mac? The fix is saved, and nothing has run.",
);
assert.deepEqual(checksListHeadings(changed), { approved: "Allowed on this Mac", current: "Now in the repository" });
assert.deepEqual(checksListHeadings(first), { approved: null, current: "The repository's checks" });

// A step per line; a Claude step says so in its own words.
assert.equal(stepWords(script("./scripts/check.sh")), "./scripts/check.sh");
assert.equal(stepWords(claude("/ppvp", "then tidy the release folder")), "Claude runs /ppvp “then tidy the release folder”");
assert.equal(stepWords(claude("/ppvp")), "Claude runs /ppvp");

// Which step differs, by position.
assert.deepEqual(stepChanges(approved, current), [{ n: 3, kind: "new", claude: true }]);
assert.deepEqual(stepChangeSentences(changed), ["Step 3 is new. It starts a Claude session in this card's copy with nobody watching."]);
assert.deepEqual([...changedSteps(changed)], [3]);
assert.deepEqual(
  stepChangeSentences({ firstTime: false, approved, current: [script("./scripts/other.sh")] }),
  ["Step 1 changed.", "Step 2 was removed."],
);
assert.deepEqual([...changedSteps({ firstTime: false, approved, current: [script("./scripts/other.sh")] })], [1]);
// The same command with other words after it is a changed step.
assert.deepEqual(
  stepChangeSentences({ firstTime: false, approved: [claude("/ppvp")], current: [claude("/ppvp", "and delete the logs")] }),
  ["Step 1 changed. It starts a Claude session in this card's copy with nobody watching."],
);
assert.deepEqual(stepChanges(approved, approved), []);
// The first time there is nothing to compare; a Claude step is still said.
assert.deepEqual(stepChangeSentences(first), []);
assert.deepEqual(
  stepChangeSentences({ firstTime: true, approved: [], current }),
  ["Step 3 starts a Claude session in this card's copy with nobody watching."],
);
assert.equal(changedSteps(first).size, 0);

// A run held for the OK is not a failed run: nothing goes to the Builder.
assert.equal(isChecksHold({ kind: "failed", reason: "The checks need your OK" }), true);
assert.equal(isChecksHold({ kind: "failed", reason: "exit code 1" }), false);
assert.equal(isChecksHold({ kind: "passed" }), false);
assert.equal(isChecksHold(null), false);

// ── The round that fixes checks by itself, the Inbox ──
assert.equal(
  autoFixWaitingLine(1, 3),
  "Fixing the failed checks by itself (try 1 of 3): waiting for your OK to run this repository's checks.",
);
assert.equal(checksOkInboxDetail(false), "The checks need your OK");
assert.equal(checksOkInboxDetail(true), "The checks need your OK · fixing checks by itself waits for it");

// ── The install step ──
assert.equal(installRowTitle("v1.4.0"), "v1.4.0's install step needs your OK");
assert.equal(installRowTitle(null), "The install step needs your OK");
assert.equal(installRowDetail("example-teammate"), "example-teammate changed “After a release, run”");
assert.equal(
  installSheetLede({ who: "example-teammate", changedAt: NOW - 2 * 3_600_000, approved: "scripts/install.sh" }, NOW),
  "example-teammate changed “After a release, run” 2 h ago. It runs on this Mac after a release, with nobody watching.",
);
assert.equal(
  installSheetLede({ who: null, changedAt: null, approved: null }, NOW),
  "“After a release, run” hasn't run on this Mac before. It runs on this Mac after a release, with nobody watching.",
);
assert.equal(
  installSheetHint("v1.4.0"),
  "Allow and run lets it run on this Mac from now on, and runs it for v1.4.0. The release itself is done either way.",
);
assert.equal(
  installSheetHint(null),
  "Allow and run lets it run on this Mac from now on, and runs it. The release itself is done either way.",
);
assert.equal(
  installHeldSentence("example-teammate"),
  "Its install step hasn't run: example-teammate changed it, so it needs your OK on this Mac.",
);
const waiting = { needsOk: true, who: "example-teammate", waiting: { tag: "v1.4.0", at: 1 } };
assert.deepEqual(installHeldFor({ tag: "v1.4.0", installScript: "scripts/deploy-all.sh" }, waiting), { who: "example-teammate" });
assert.deepEqual(installHeldFor({ tag: "v1.4.0", installScript: "x" }, { ...waiting, who: null }), { who: "Someone" });
// Another release's wait, a step already allowed, a project with no step: not held.
assert.equal(installHeldFor({ tag: "v1.5.0", installScript: "x" }, waiting), null);
assert.equal(installHeldFor({ tag: "v1.4.0", installScript: "x" }, { ...waiting, needsOk: false }), null);
assert.equal(installHeldFor({ tag: "v1.4.0", installScript: "x" }, { ...waiting, waiting: null }), null);
assert.equal(installHeldFor({ tag: "v1.4.0", installScript: null }, waiting), null);
assert.equal(installHeldFor({ tag: "v1.4.0", installScript: "x" }, null), null);
// A card shipped by a merge here has no tag.
assert.deepEqual(installHeldFor({ tag: null, installScript: "x" }, { ...waiting, waiting: { at: 1 } }), { who: "example-teammate" });

// The Inbox row rides the shared-setting kind and opens the sheet.
const installRow = { kind: "shared_setting_conflict", id: "install-ok:ws-1:v1.4.0", detail: installRowDetail("example-teammate") };
assert.equal(isInstallOkRow(installRow as never), true);
assert.equal(isInstallOkRow({ kind: "shared_setting_conflict", id: "setting:ws-1:versionFiles" } as never), false);
assert.deepEqual(inboxRowWords(installRow as never), {
  detail: "example-teammate changed “After a release, run”",
  action: "Decide",
});
assert.equal(inboxRowWords({ kind: "shared_setting_conflict", id: "setting:ws-1:x", detail: "d" } as never).action, "Choose");

// Round 2 (G5): the first time nobody changed anything — row, sheet, toast.
assert.equal(installRowDetail(null, true), "\u201cAfter a release, run\u201d hasn't run on this Mac before");
assert.equal(
  installSheetLede({ who: "example-teammate", changedAt: NOW, approved: null, firstTime: true }, NOW),
  "\u201cAfter a release, run\u201d hasn't run on this Mac before. It runs on this Mac after a release, with nobody watching.",
);
assert.deepEqual(installHeldFor({ tag: "v1.4.0", installScript: "x" }, { ...waiting, firstTime: true }), { who: "", firstTime: true });
assert.equal(
  installHeldSentence("", true),
  "Its install step hasn't run: it hasn't run on this Mac before, so it needs your OK here.",
);
// What the OK covers, and what else the press starts.
assert.equal(
  CHECKS_OK_COVERS,
  "Your OK is for these steps. What each script does is the repository's code: it can change without Plyloft asking again.",
);
assert.equal(
  INSTALL_OK_COVERS,
  "Your OK is for this path. What the script does is the repository's code: it can change without Plyloft asking again.",
);
assert.equal(othersWaitingLine(0), null);
assert.equal(othersWaitingLine(1), "Allow and run also runs the checks of 1 other card that waits for them.");
assert.equal(othersWaitingLine(3), "Allow and run also runs the checks of 3 other cards that wait for them.");

// ── Settings ──
assert.equal(
  checksApprovalNote(changed),
  "It changed and hasn't been allowed on this Mac yet: the next Finish and check asks you (Allow and run) before it runs.",
);
assert.equal(
  checksApprovalNote(first),
  "It hasn't been allowed on this Mac yet: the next Finish and check asks you (Allow and run) before it runs.",
);
assert.equal(checksApprovalNote({ ...changed, needsOk: false }), null);
assert.equal(checksApprovalNote(null), null);
assert.equal(
  installApprovalNote({ needsOk: true, approved: "scripts/install.sh" }),
  "It changed and hasn't been allowed on this Mac yet: the next release asks you (Allow and run) before it runs.",
);
assert.equal(
  installApprovalNote({ needsOk: true, approved: null }),
  "It hasn't been allowed on this Mac yet: the next release asks you (Allow and run) before it runs.",
);
assert.equal(installApprovalNote({ needsOk: false, approved: "x" }), null);
assert.deepEqual(publishConsequences(["name", "verifyPipeline", "installScript"]), [
  "Every other computer asks its person (Allow and run) before it runs the new checks.",
  "Every other computer asks its person (Allow and run) before it runs the new install step.",
]);
assert.deepEqual(publishConsequences(["name"]), []);

// The TS default: nothing recorded asks nothing (a 1.174.5 file).
assert.equal(NO_CONSENT.checks.needsOk, false);
assert.equal(NO_CONSENT.install.needsOk, false);
assert.equal(checksApprovalNote(NO_CONSENT.checks), null);

console.log("checksConsent: ok");
