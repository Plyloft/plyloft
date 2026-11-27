// 1.175.0 (C1, SC-2): the words of the "Shared setup" row, its sheets, the
// Board's notice and the toasts (src/lib/sharedSetup.ts).
// Run with Node 22+:  node --experimental-strip-types src/lib/sharedSetup.test.ts
import assert from "node:assert/strict";
import {
  closedLine,
  dayOf,
  declinedNotice,
  leftOpenLine,
  removedNotice,
  removedStatusLine,
  shareAgainSheet,
  sharedFirstToasts,
  sharedSetupRow,
  sharingToasts,
  stopOutcomeToast,
  stopSharingSheet,
  KEPT_LOCAL_TOAST,
  STOP_FAILED,
  type SharedSetup,
} from "./sharedSetup.ts";
import { adoptionBanner, type AdoptionStatus } from "./adoption.ts";
import { adoptionKind, adoptionSummary } from "./boardNotices.ts";
import { statusLine } from "./repositoryPage.ts";
import { sharedSetupRow as rowFor, unreadableSetupLine } from "./sharedSetup.ts";
import { publishToasts } from "./definitionRefresh.ts";

const NOW = 1_762_700_000;
const TWO_H = NOW - 2 * 3600;
const online = { offline: false, nowSecs: NOW };
const shared: SharedSetup = {
  state: "shared",
  branch: "staging",
  readOnly: false,
  author: "example-teammate",
  pending: [],
  pullRequest: null,
};
const day = dayOf(TWO_H);
assert.match(day, /^\d{1,2} [A-Z][a-z]{2}$/, "9 Nov");
assert.equal(dayOf(new Date(2026, 10, 9, 12).getTime() / 1000), "9 Nov");

// ── The row's states (mockup scenes 1.1, 1.3, 1.4, 1.5, 1.6) ──────────
assert.equal(sharedSetupRow(null, "mbadv/lyra", online), null, "never shared: no row");
assert.deepEqual(sharedSetupRow(shared, "mbadv/lyra", online), {
  hint: "This project's setup is shared: .atelier/workspace.json on staging, in mbadv/lyra. Everyone who opens this repository gets it, and a change published from one computer reaches the others.",
  action: "stop",
});
assert.deepEqual(
  sharedSetupRow({ ...shared, pullRequest: { number: 231, url: "https://github.com/mbadv/lyra/pull/231" } }, "mbadv/lyra", online),
  {
    hint: "Still shared: stopping waits in pull request #231. staging refused a direct push; the setup stays shared until that pull request merges.",
    action: "openPullRequest",
    pullRequest: 231,
  },
);
assert.deepEqual(sharedSetupRow({ ...shared, readOnly: true }, "mbadv/lyra", online), {
  hint: "This project's setup is shared: .atelier/workspace.json on staging, in mbadv/lyra. Stopping needs write access to mbadv/lyra. Ask example-teammate.",
  action: null,
});
assert.equal(
  sharedSetupRow({ ...shared, readOnly: true, author: null }, "mbadv/lyra", online)?.hint,
  "This project's setup is shared: .atelier/workspace.json on staging, in mbadv/lyra. Stopping needs write access to mbadv/lyra.",
);
assert.deepEqual(sharedSetupRow(shared, "mbadv/lyra", { offline: true, nowSecs: NOW }), {
  hint: "This project's setup is shared: .atelier/workspace.json on staging, in mbadv/lyra. Can't be stopped while offline — Plyloft needs the repository.",
  action: "stop",
  disabled: true,
});
// Not shared: who stopped, and the way back.
assert.deepEqual(
  sharedSetupRow({ state: "notShared", who: null, at: TWO_H, here: true, readOnly: false }, "mbadv/lyra", online),
  { hint: `Not shared: this project's setup is kept on this Mac. You stopped sharing it on ${day}.`, action: "shareAgain" },
);
assert.deepEqual(
  sharedSetupRow({ state: "notShared", who: "example-teammate", at: TWO_H, here: false, readOnly: false }, "mbadv/lyra", online),
  { hint: `Not shared: this project's setup is kept on this Mac. example-teammate stopped sharing it on ${day}.`, action: "shareAgain" },
);
assert.deepEqual(
  sharedSetupRow({ state: "notShared", who: null, at: TWO_H, here: false, readOnly: false }, "mbadv/lyra", online),
  { hint: "Not shared: this project's setup is kept on this Mac.", action: "shareAgain" },
  "nobody to name",
);
assert.equal(
  sharedSetupRow({ state: "notShared", who: "example-teammate", at: TWO_H, here: false, readOnly: true }, "mbadv/lyra", online)?.action,
  null,
  "a read-only member can't share it again",
);
// Removed, not chosen yet: the notice's two answers.
assert.deepEqual(
  sharedSetupRow({ state: "removed", branch: "staging", who: "example-teammate", at: TWO_H, readOnly: false }, "mbadv/lyra", online),
  {
    hint: "The shared setup was removed from staging by example-teammate 2 h ago. This Mac still has the values it read last.",
    action: "choose",
  },
);
assert.deepEqual(
  sharedSetupRow({ state: "removed", branch: "staging", who: null, at: null, readOnly: false }, "mbadv/lyra", online),
  { hint: "The shared setup is no longer on staging. This Mac still has the values it read last.", action: "choose" },
);
assert.equal(
  sharedSetupRow({ state: "removed", branch: "staging", who: null, at: null, readOnly: true }, "mbadv/lyra", online)?.action,
  null,
);

// ── The Stop sharing sheet (scene 1.2): focus on "Keep sharing" ───────
const stop = stopSharingSheet("staging", []);
assert.equal(stop.title, "Stop sharing this project's setup?");
assert.equal(
  stop.body,
  "Plyloft removes .atelier/workspace.json from staging on GitHub, in one small commit. It stays in that branch's history.",
);
assert.deepEqual(stop.items, [
  "Each computer keeps the values it has now, as its own. From then on, a change made on one doesn't reach the others.",
  "Your teammates see that the shared setup was removed, and choose to keep theirs or share it again.",
  "The Board and its cards stay where they are.",
]);
assert.equal(
  stop.note,
  "If staging doesn't take a direct push, the removal goes as a pull request, and the setup stays shared until it merges.",
);
assert.equal(stop.confirmLabel, "Stop sharing");
assert.equal(stop.cancelLabel, "Keep sharing");
assert.equal(stop.destructive, true, "the one filled button is the red one, and the focus is on the other");
assert.equal(
  stopSharingSheet("staging", ["verifyPipeline", "integrationBranch"]).items?.[3],
  "2 changes not published yet stay on this Mac: Checks before shipping, Cards go to.",
);
assert.equal(
  stopSharingSheet("staging", ["name"]).items?.[3],
  "1 change not published yet stays on this Mac: Name.",
);

// ── Share it again (scene 1.7): focus on "Not now" ────────────────────
const again = shareAgainSheet(
  { state: "removed", branch: "staging", who: "example-teammate", at: TWO_H, readOnly: false },
  "mbadv/lyra",
  NOW,
);
assert.equal(again.title, "Share this project's setup again?");
assert.equal(
  again.body,
  "example-teammate stopped sharing it 2 h ago. Sharing again commits .atelier/workspace.json to mbadv/lyra with this Mac's name, color and project settings, for everyone who opens the repository.",
);
assert.equal(again.confirmLabel, "Share it again");
assert.equal(again.cancelLabel, "Not now");
assert.equal(again.focusCancel, true);
assert.ok(
  shareAgainSheet({ state: "notShared", who: null, at: TWO_H, here: true, readOnly: false }, "mbadv/lyra", NOW).body.startsWith(
    `You stopped sharing it on ${day}. Sharing again commits`,
  ),
);
assert.ok(
  shareAgainSheet({ state: "removed", branch: "staging", who: null, at: null, readOnly: false }, "mbadv/lyra", NOW).body.startsWith(
    "Sharing again commits .atelier/workspace.json to mbadv/lyra",
  ),
  "nobody to name",
);

// ── The Board's notice (scene 1.6) ────────────────────────────────────
assert.deepEqual(removedNotice({ branch: "staging", who: "example-teammate", at: TWO_H, pending: 0 }, NOW), {
  title: "The shared setup was removed from staging",
  body: "example-teammate removed .atelier/workspace.json 2 h ago. This Mac still has the values it read last. Plyloft changes nothing until you choose.",
});
assert.ok(
  removedNotice({ branch: "staging", who: "example-teammate", at: TWO_H, pending: 2 }, NOW).body.endsWith(
    "Plyloft changes nothing until you choose. Your 2 changes not published yet stay on this Mac.",
  ),
);
assert.ok(
  removedNotice({ branch: "staging", who: "example-teammate", at: TWO_H, pending: 1 }, NOW).body.endsWith(
    "Your change not published yet stays on this Mac.",
  ),
);
assert.deepEqual(removedNotice({ branch: "staging", who: null, at: null, pending: 0 }, NOW), {
  title: "The shared setup is no longer on staging",
  body: ".atelier/workspace.json was there when this Mac last read it. This Mac still has the values it read last. Plyloft changes nothing until you choose.",
});

const status: AdoptionStatus = {
  githubRepo: "mbadv/lyra",
  hasDefinition: false,
  boardRepo: "mbadv/lyra",
  action: { kind: "setupRemoved", branch: "staging", who: "example-teammate", at: TWO_H, pending: 0 },
};
const banner = adoptionBanner(status, true, null, null, NOW);
assert.equal(banner?.kind, "removed");
assert.equal(banner?.title, "The shared setup was removed from staging");
assert.equal(banner?.keep, "Keep it on this Mac");
assert.equal(banner?.move, "Share it again…");
assert.equal(adoptionSummary(banner!), "the shared setup was removed");
assert.equal(adoptionKind("removed"), "setup");

// ── The shared pages' status line until the person chooses ────────────
const line = { branch: "staging", author: null, changedAt: null, readOnly: false, repository: "mbadv/lyra", offline: false, local: true };
assert.deepEqual(statusLine({ ...line, removedFrom: "staging" }, NOW), {
  state: "empty",
  kind: "local",
  text: "The shared setup was removed from staging, so these rows are this Mac's own for now. Choose what to do in Project › General.",
});
assert.equal(removedStatusLine("main").startsWith("The shared setup was removed from main,"), true);
assert.equal(
  (statusLine(line, NOW) as { text: string }).text,
  "This repository shares no settings, so these are this Mac's own. Saved as you change them.",
  "never shared, or kept here: as before",
);

// ── The toasts ────────────────────────────────────────────────────────
assert.deepEqual(stopOutcomeToast({ kind: "stopped", branch: "staging" }), {
  kind: "info",
  title: "Stopped sharing this project's setup",
  body: "Removed .atelier/workspace.json from staging in one commit. This Mac keeps its values.",
});
assert.deepEqual(stopOutcomeToast({ kind: "pullRequest", branch: "staging", number: 231, url: "u" }), {
  kind: "warn",
  title: "Waiting for pull request #231 to merge",
  body: "staging refused a direct push, so Plyloft opened a pull request that removes the shared setup. It stays shared until that merges.",
  pullRequest: 231,
});
assert.deepEqual(STOP_FAILED, {
  title: "Couldn't stop sharing",
  body: "Nothing changed on GitHub, and the setup is still shared. Details has the reason.",
});
assert.deepEqual(KEPT_LOCAL_TOAST, {
  kind: "info",
  title: "This project's setup is this Mac's own now",
  body: "Nothing was written to GitHub.",
});
assert.deepEqual(sharingToasts({}), []);
assert.deepEqual(sharingToasts({ sharing: null }), []);
assert.deepEqual(sharingToasts({ sharing: { kind: "stopped", branch: "staging" } }), [
  stopOutcomeToast({ kind: "stopped", branch: "staging" }),
]);
assert.deepEqual(sharingToasts({ sharing: { kind: "stoppedBy", who: "example-teammate" } }), [
  {
    kind: "info",
    title: "example-teammate stopped sharing this project's setup",
    body: "This Mac keeps the values it read last, as its own.",
  },
]);
assert.equal(sharingToasts({ sharing: { kind: "stoppedBy", who: null } })[0].title, "The shared setup was removed");
assert.deepEqual(sharingToasts({ sharing: { kind: "removalClosed", number: 231 } }), [
  { kind: "warn", title: "Pull request #231 was closed without merging", body: "The setup stays shared." },
]);

// ── Round 2: this computer's settings pull requests left open ─────────
assert.equal(leftOpenLine(undefined), "");
assert.equal(leftOpenLine([]), "");
// Round 4: "is still open" only where GitHub was just asked.
assert.equal(
  leftOpenLine([15]),
  "Pull request #15, opened from this Mac for a shared setting, may still be open on GitHub. Close it there if it is no longer wanted.",
);
assert.equal(
  leftOpenLine([12, 15, 18]),
  "Pull requests #12, #15 and #18, opened from this Mac for shared settings, may still be open on GitHub. Close them there if they are no longer wanted.",
);
assert.equal(
  leftOpenLine([15], true),
  "Pull request #15, opened from this Mac for a shared setting, is still open on GitHub. Close it there if it is no longer wanted.",
);
assert.equal(
  leftOpenLine([12, 15], true),
  "Pull requests #12 and #15, opened from this Mac for shared settings, are still open on GitHub. Close them there if they are no longer wanted.",
);
assert.equal(stopOutcomeToast({ kind: "stopped", branch: "staging", leftOpen: [12, 15] }).details, leftOpenLine([12, 15], true));
assert.equal("details" in stopOutcomeToast({ kind: "stopped", branch: "staging", leftOpen: [] }), false);
assert.equal(sharingToasts({ sharing: { kind: "stopped", branch: "staging", leftOpen: [15] } })[0].details, leftOpenLine([15], true));
assert.ok(
  sharedSetupRow({ state: "notShared", who: null, at: TWO_H, here: true, readOnly: false, leftOpen: [15] }, "mbadv/lyra", online)?.hint.endsWith(
    `You stopped sharing it on ${day}. ${leftOpenLine([15])}`,
  ),
);
assert.ok(
  sharedSetupRow({ state: "removed", branch: "staging", who: null, at: null, readOnly: false, leftOpen: [12, 15] }, "mbadv/lyra", online)?.hint.endsWith(
    `This Mac still has the values it read last. ${leftOpenLine([12, 15])}`,
  ),
);

// ── Round 3: closed at the press, once the file is really gone ────────
assert.equal(closedLine(undefined), "");
assert.equal(closedLine([15]), "Pull request #15, opened from this Mac for a shared setting, was closed.");
assert.equal(
  closedLine([12, 15]),
  "Pull requests #12 and #15, opened from this Mac for shared settings, were closed.",
);
assert.deepEqual(stopOutcomeToast({ kind: "stopped", branch: "staging", closed: [12, 15], leftOpen: [18] }), {
  kind: "info",
  title: "Stopped sharing this project's setup",
  body: "Removed .atelier/workspace.json from staging in one commit. This Mac keeps its values. Pull requests #12 and #15, opened from this Mac for shared settings, were closed.",
  details: leftOpenLine([18], true),
});
assert.equal(
  sharingToasts({ sharing: { kind: "stopped", branch: "staging", closed: [15] } })[0].body,
  "Removed .atelier/workspace.json from staging in one commit. This Mac keeps its values. Pull request #15, opened from this Mac for a shared setting, was closed.",
);
// The removal that only waits in its pull request closes nothing, and says nothing of them.
assert.equal(
  stopOutcomeToast({ kind: "pullRequest", branch: "staging", number: 231, url: "u" }).body.includes("closed"),
  false,
);

// ── C2 (SC-1): a declined conversion ──────────────────────────────────
assert.deepEqual(declinedNotice(214, "example-teammate"), {
  title: "The shared setup stays in its older file",
  body: "Plyloft proposed moving it to .atelier/workspace.json in pull request #214, and example-teammate closed it without merging. Plyloft won't propose it again by itself. Everything works as before on this Mac.",
});
assert.equal(
  declinedNotice(214, null).body,
  "Plyloft proposed moving it to .atelier/workspace.json in pull request #214, and it was closed without merging. Plyloft won't propose it again by itself. Everything works as before on this Mac.",
);
const declinedBanner = adoptionBanner(
  { githubRepo: "mbadv/lyra", hasDefinition: true, boardRepo: "mbadv/lyra", action: { kind: "conversionDeclined", pullRequest: 214, who: null } },
  true,
);
assert.equal(declinedBanner?.kind, "declined");
assert.equal(declinedBanner?.title, "The shared setup stays in its older file");
assert.equal(declinedBanner?.move, "Propose it again");
assert.equal(adoptionSummary(declinedBanner!), "the shared setup stays in its older file");
assert.equal(adoptionKind("declined"), "setup");
// The row: the same sentence and the same button.
assert.deepEqual(sharedSetupRow({ state: "declined", pullRequest: 214, who: null, readOnly: false }, "mbadv/lyra", online), {
  hint: declinedNotice(214, null).body,
  action: "propose",
});
assert.equal(sharedSetupRow({ state: "declined", pullRequest: 214, who: null, readOnly: true }, "mbadv/lyra", online)?.action, null);
// The toast when the conversion's pull request is found closed.
const closedReport = {
  moment: "open",
  publish: { branch: "main", published: [], commit: null, overrides: [], pullRequest: null, pullRequestFields: [], closedPullRequests: [214, 220], conversionDeclined: 214, error: null, offline: false },
};
assert.deepEqual(publishToasts(closedReport), [
  {
    kind: "warn",
    title: "Pull request #214 was closed without merging",
    body: "The shared setup stays in its older file. Plyloft won't propose the change again by itself.",
  },
  { kind: "warn", title: "Pull request #220 was closed without merging", body: "Your value was dropped; the repository’s is back." },
]);

// ── Round 5: the older file read on a folder whose history can't be read ──
assert.deepEqual(sharedSetupRow({ state: "olderFile", readOnly: false }, "mbadv/lyra", online), {
  hint: "This project's setup is in its older file. Plyloft can't read this folder's whole history, so it doesn't move it to .atelier/workspace.json by itself.",
  action: "propose",
  label: "Propose moving it",
});
assert.equal(sharedSetupRow({ state: "olderFile", readOnly: true }, "mbadv/lyra", online)?.action, null);
assert.equal("label" in sharedSetupRow({ state: "declined", pullRequest: 214, who: null, readOnly: false }, "mbadv/lyra", online)!, false);

// ── C4 (SC-4): the setup arrived from another computer first ─────────
assert.deepEqual(sharedFirstToasts({}), []);
assert.deepEqual(sharedFirstToasts({ publish: { sharedFirst: { number: 215, url: "u", who: "example-teammate", outcome: "closed" } } }), [
  {
    kind: "info",
    title: "example-teammate shared this project's setup first",
    body: "This Mac follows it now. Plyloft closed pull request #215, which it had opened from this Mac: it isn't needed any more.",
    pullRequest: 215,
  },
]);
assert.deepEqual(sharedFirstToasts({ publish: { sharedFirst: { number: 215, url: "u", who: null, outcome: "refused" } } }), [
  {
    kind: "warn",
    title: "Someone shared this project's setup first",
    body: "This Mac follows it now. Plyloft couldn't close pull request #215, which it had opened from this Mac; close it on GitHub.",
    pullRequest: 215,
  },
]);

// ── C5 (SC-5): the shared setup's branch is gone from GitHub ──────────
const gone = (renamedTo: string | null, readOnly = false) =>
  adoptionBanner(
    { githubRepo: "mbadv/lyra", hasDefinition: true, boardRepo: "mbadv/lyra", action: { kind: "branchGone", branch: "staging", renamedTo, readOnly, author: "example-teammate" } },
    true,
  );
assert.deepEqual(gone("develop"), {
  kind: "branchGone",
  title: "staging is called develop on GitHub now",
  body: "Cards went to staging, and the shared setup still names it. Move both to develop: one small commit there, and new cards start from develop on every computer.",
  move: "Move to develop",
  moveTo: "develop",
});
assert.deepEqual(gone(null), {
  kind: "branchGone",
  title: "staging isn't on GitHub any more",
  body: "Cards went there, and the shared setup lived there. Choose where cards go now; Plyloft moves the shared setup to that branch. Until then no card can start.",
  move: "Choose where cards go",
});
assert.deepEqual(gone("develop", true), {
  kind: "branchGone",
  title: "staging is called develop on GitHub now",
  body: "Cards went to staging, and the shared setup still names it. Ask example-teammate to move the shared setup. This Mac keeps the values it read last.",
});
assert.equal(adoptionSummary(gone(null)!), "staging isn't on GitHub any more");

// C4 round 2: one that isn't ours here opens its own recorded address.
assert.deepEqual(sharedFirstToasts({ publish: { sharedFirst: { number: 215, url: "https://github.com/old/lyra/pull/215", who: null, outcome: "notOurs" } } }), [
  {
    kind: "info",
    title: "Someone shared this project's setup first",
    body: "This Mac follows it now. Pull request #215, which Plyloft had opened from this Mac, is no longer followed: it isn't in this repository as Plyloft left it.",
    url: "https://github.com/old/lyra/pull/215",
  },
]);

// WALKFIX-1 (walk): a shared file that can't be used is said on the row and
// on the pages' status line, never "shared … come from".
{
  const newer = { path: ".atelier/workspace.json", line: 4, message: "unknown variant `npm`, expected one of …" };
  const broken = { path: ".atelier/workspace.json", line: 2, message: "expected `,` or `}`" };
  const shared = { state: "shared" as const, branch: "w1175-int", readOnly: false, author: null, pending: [], pullRequest: null };
  const said =
    ".atelier/workspace.json on w1175-int was written by a newer Plyloft, so this Mac can't read all of it (line 4). Update Plyloft on this Mac. Until then it keeps using the last good copy and publishes nothing.";
  assert.equal(unreadableSetupLine(newer, "w1175-int", true), said);
  assert.equal(rowFor({ ...shared, unreadable: newer }, "o/r", { offline: false, nowSecs: 0 })?.hint, said);
  assert.equal(
    unreadableSetupLine(broken, "w1175-int", true),
    ".atelier/workspace.json on w1175-int can't be read (line 2). Plyloft keeps using the last good copy, and never writes over the file; fix it in the repository.",
  );
  const line = statusLine(
    { branch: "w1175-int", author: null, changedAt: null, readOnly: false, repository: "o/r", offline: false, local: false, unreadable: newer },
    0,
  );
  assert.equal(line.kind, "local");
  assert.equal(line.kind === "local" ? line.text : null, said);
  // While it reads: the row as before.
  assert.match(rowFor(shared, "o/r", { offline: false, nowSecs: 0 })?.hint ?? "", /^This project's setup is shared/);
}

// WALKFIX-3 (item 3): Share waiting in its pull request keeps the row, and
// the status line doesn't claim it shared before the merge.
{
  const waiting = { state: "waiting" as const, branch: "w1175-int", pullRequest: { number: 224, url: "u" }, readOnly: false };
  const view = rowFor(waiting, "o/r", { offline: false, nowSecs: 0 });
  assert.equal(
    view?.hint,
    "Not shared yet: sharing waits in pull request #224. w1175-int refused a direct push; the setup is shared once that pull request merges.",
  );
  assert.equal(view?.action, "openPullRequest");
  assert.equal(view?.pullRequest, 224);
  const line = statusLine(
    { branch: "w1175-int", author: null, changedAt: null, readOnly: false, repository: "o/r", offline: false, local: false, sharingWaits: 224 },
    0,
  );
  assert.equal(line.kind === "local" ? line.text : null, "Not shared yet: sharing waits in pull request #224. Until it merges, these rows are this Mac's own.");
}

// Owner, 2026-11-10: a teammate's Share it again, said once with what changed.
{
  const [t] = sharingToasts({
    sharing: { kind: "sharedAgain", who: "example-teammate", board: "githubIssues" },
    changes: [{ label: "Name" }, { label: "Areas" }],
    branch: "main",
  });
  assert.equal(t.title, "example-teammate shared this project's setup again");
  assert.equal(t.body, "It changed “Name” and “Areas”. Its board is on GitHub Issues. From .atelier/workspace.json on main.");
  const [same] = sharingToasts({ sharing: { kind: "sharedAgain", who: null }, changes: [], branch: "staging" });
  assert.equal(same.title, "Someone shared this project's setup again");
  assert.equal(same.body, "From .atelier/workspace.json on staging.", "no board line when it doesn't switch");
}

console.log("sharedSetup.test.ts: ok");
