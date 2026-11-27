// 1.173.0 A3: the words of copies without a card. Run with:
//
//     node --experimental-strip-types src/lib/copyWords.test.ts

import assert from "node:assert/strict";
import {
  agoWords,
  copyChangedWords,
  copyPrWords,
  copyStartChip,
  copyTerminalWords,
  copyTileMark,
  madeCardWords,
  copyBriefPlaceholder,
  plainCopyError,
  prSheetLede,
  prSheetTitle,
  startedLocallyWords,
  startsFromWords,
  throwAwayAsk,
  NEW_COPY_LEDE,
  COPIES_STATUS,
  COPIES_EMPTY,
  newCopyOpeningHint,
  throwAwayHeldWords,
  copyTrustRefusedLine,
  copyTrustSheetHint,
  copyTrustTileLine,
  CARD_TRUST_TILE_LINE,
  copyOpenLabel,
  isCardFolder,
  notInCopyWords,
} from "./copyWords.ts";
import { fromCopyNow } from "./cardPage.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

// How long ago, in the mockup's words.
assert.equal(agoWords(NOW - 10_000, NOW), "just now");
assert.equal(agoWords(NOW - 2 * MIN, NOW), "2 min ago");
assert.equal(agoWords(NOW - 60 * MIN, NOW), "1 h ago");
assert.equal(agoWords(NOW - 25 * 60 * MIN, NOW), "yesterday");
assert.equal(agoWords(NOW - 3 * 24 * 60 * MIN, NOW), "3 days ago");
assert.equal(agoWords(NOW + 5_000, NOW), "just now", "a clock a little ahead is now");

// Where it starts: "on GitHub" only when origin is GitHub.
assert.equal(startsFromWords({ target: "main", fromGitHub: true, readAt: NOW - 2 * MIN }, NOW), "main on GitHub · read 2 min ago");
assert.equal(startsFromWords({ target: "main", fromGitHub: true }, NOW), "main on GitHub");
// WALKFIX-3: a branch GitHub no longer has is said as C5 says it.
{
  const gone =
    "w1175-dev isn't on GitHub any more. Cards went there, and the shared setup lived there. Choose where cards go now; Plyloft moves the shared setup to that branch. Until then no card can start.";
  assert.equal(startsFromWords({ target: "w1175-dev", fromGitHub: true, readAt: NOW - 3 * MIN, gone }, NOW), gone);
}
assert.equal(startsFromWords({ target: "staging", fromGitHub: false }, NOW), "staging on this Mac");
// 1.174.0 E2 (Challenger 1): this Mac's main strictly ahead of GitHub's — the
// copy starts from it.
assert.equal(startsFromWords({ target: "main", fromGitHub: true, readAt: NOW - 2 * MIN, startsLocal: true }, NOW), "main on this Mac");
assert.equal(startsFromWords({ target: "", fromGitHub: true }, NOW), null);
assert.equal(startsFromWords(null, NOW), null);

// A copy that didn't start from GitHub's tip says so; GitHub's tip says nothing.
assert.match(startedLocallyWords("localOffline", "main") ?? "", /GitHub couldn't be reached, so the copy started from main on this Mac/);
assert.match(startedLocallyWords("localAhead", "main") ?? "", /changes GitHub doesn't have yet/);
assert.equal(startedLocallyWords("origin", "main"), null);
assert.equal(startedLocallyWords("localNoRemote", "main"), null);

// The tile head and the row.
assert.equal(copyTileMark("inbox-empty-state"), "Copy · inbox-empty-state");
assert.equal(copyStartChip({ baseBranch: "main", createdAt: NOW - 60 * MIN }, NOW), "from main · 1 h ago");
assert.equal(copyTerminalWords([], 0), "No terminal open");
assert.equal(copyTerminalWords(["claude"], 1), "Claude open");
assert.equal(copyTerminalWords(["claude", "shell"], 2), "2 terminals open");
assert.equal(copyTerminalWords([], 1), "A terminal open", "counted by the backend, not on this page");
assert.equal(
  copyChangedWords({ count: 3, files: ["src/components/InboxPanel.tsx", "src/lib/inboxView.ts", "src/lib/inboxView.test.ts"] }),
  "3 files changed: InboxPanel.tsx, inboxView.ts, inboxView.test.ts",
);
assert.equal(copyChangedWords({ count: 7, files: ["a", "b", "c", "d", "e"] }), "7 files changed: a, b, c, d, e and 2 more");
assert.equal(copyChangedWords({ count: 1, files: ["a.txt"] }), "1 file changed: a.txt");
assert.equal(copyChangedWords({ count: 0, files: [] }), "nothing changed");
assert.equal(copyChangedWords({ count: 0, files: [], unreadable: true }), "its changes can't be read now");
assert.equal(copyPrWords({ number: 41, url: "u" }), "Pull request #41 open · nobody reviewed it here");
assert.equal(copyPrWords({ number: 41, url: "u", state: "merged" }), "Pull request #41 merged");

// Scene 4.
assert.equal(prSheetTitle("inbox-empty-state"), "Open a pull request for inbox-empty-state");
assert.equal(prSheetLede(3, "main"), "Plyloft saves the 3 changed files, sends this copy to GitHub and opens a pull request for main.");
assert.equal(prSheetLede(1, "staging"), "Plyloft saves the changed file, sends this copy to GitHub and opens a pull request for staging.");

// Throw away asks only for saved changes that exist nowhere else.
assert.equal(throwAwayAsk(0), null);
assert.equal(throwAwayAsk(1)?.body.startsWith("1 saved change will be deleted with the copy after 7 days in the Trash."), true);
assert.equal(throwAwayAsk(3)?.body.startsWith("3 saved changes will be deleted with the copy after 7 days in the Trash."), true);

// Make it a card (walk fix b): the words say where the Board puts it.
// 1.174.0 C4 (P17): the brief is empty, so the toast says to write it.
assert.equal(
  madeCardWords("Fix it", false).body,
  "“Fix it” is in Not started, with the work from its copy. Say what the Builder should do, then Start build.",
);
assert.match(madeCardWords("Fix it", false, "Claim it and say what the Builder should do, then Start build.").body, /from its copy\. Claim it/);
assert.equal(madeCardWords("Fix it", true).body, "“Fix it” is in Working, on its copy.");
assert.equal(copyBriefPlaceholder("win-copy-1"), "What should the Builder do with the work in “win-copy-1”?");
// Walk fix (a): the card page's Now line.
assert.equal(
  fromCopyNow("walk-copy-2", { count: 1, files: ["two.txt"] }),
  "Made from the copy “walk-copy-2”, with the work done there. 1 file changed: two.txt. Start build carries on with it; then the Reviewer and your checks look at it.",
);
assert.equal(fromCopyNow("x", null).includes("Verify"), false, "T22: your checks, not Verify");
assert.equal(fromCopyNow("x", null).includes("file"), false, "before the read: no count");
// Walk fix (d).
assert.equal(throwAwayHeldWords(0), null);
assert.equal(throwAwayHeldWords(1), "Close its terminal first.");
assert.equal(throwAwayHeldWords(2), "Close its terminals first.");

// The engine's errors, plainly; the raw text behind Details.
const off = plainCopyError(new Error("/x/.plyloft-worktrees/copy-1 is not this copy's folder"));
assert.equal(off.body, "The copy's folder isn't where Plyloft left it, so nothing was changed.");
assert.match(off.details ?? "", /is not this copy's folder/);
assert.match(plainCopyError('not a copy: "card-1"').body, /isn't one of this project's copies/);
assert.match(plainCopyError("couldn't push the branch to the remote: rejected").body, /couldn't be sent to GitHub/);
assert.match(plainCopyError("opening the pull request failed: boom").body, /didn't open/);
assert.equal(plainCopyError("That copy is in the Trash. Bring it back first.").body, "That copy is in the Trash. Bring it back first.");

// No engine words on screen, and "pull request", never "PR".
for (const words of [NEW_COPY_LEDE, COPIES_STATUS, prSheetLede(2, "main"), copyPrWords({ number: 1, url: "" })]) {
  assert.doesNotMatch(words, /worktree|\bPR\b|\bHEAD\b|origin|diff/i, words);
}

// Challenger round 1: a refused commit is said plainly, ahead of git's own
// `fatal:` rule, the hook's words behind Details.
const hook = plainCopyError("Couldn't save the copy's changes: A hook in this project refused the commit:\nfatal: lint");
assert.equal(hook.body, "The copy's changes couldn't be saved, so nothing was sent to GitHub. Details says why.");
assert.match(hook.details ?? "", /lint/);
assert.match(plainCopyError("This copy is being sent to GitHub. Try again once that has finished.").body, /being sent to GitHub/);
// 1.174.0 E3 (G11, P42): true for someone who never made one, too.
assert.equal(COPIES_EMPTY, "No copies yet. New › In a new copy… opens a terminal in one.");
assert.match(newCopyOpeningHint(true), /from GitHub/);
assert.doesNotMatch(newCopyOpeningHint(false), /GitHub/);

// 1.174.0 E2 (P19, D12 a): the trust question, in the tile and the sheet.
assert.equal(
  copyTrustTileLine("claude"),
  "Claude asks this for every new copy: the folder is the copy Plyloft just made of your project. Choose “Yes, I trust this folder” in the terminal.",
);
assert.equal(
  copyTrustTileLine("codex"),
  "Codex asks this for every new copy: the folder is the copy Plyloft just made of your project. Choose to trust it in the terminal.",
);
assert.equal(copyTrustRefusedLine("claude"), "Claude needs the copy's folder trusted to work in it. Start fresh asks again.");
assert.equal(copyTrustRefusedLine("codex"), "Codex needs the copy's folder trusted to work in it. Start fresh asks again.");
assert.equal(copyTrustSheetHint("claude", false), "Claude will ask once to trust the copy's folder: choose “Yes, I trust this folder”.");
// Walk G3b: Claude keeps its trust on the project folder; a copy inside a
// trusted one isn't asked about, and an unknown answer promises nothing.
assert.equal(copyTrustSheetHint("claude", true), null);
assert.equal(copyTrustSheetHint("claude"), null);
assert.equal(copyTrustSheetHint("codex", true), "Codex will ask once to trust the copy's folder: choose to trust it.");
assert.equal(copyTrustSheetHint("codex"), "Codex will ask once to trust the copy's folder: choose to trust it.");
assert.equal(copyTrustSheetHint("shell"), null);

// E2 (P20, CP-2): "Not in the copy", its variants, and silence.
const sp = (over: object) => ({ target: "main", fromGitHub: true, ...over });
assert.equal(
  notInCopyWords(sp({ projectChanged: 3, localAhead: 1 })),
  "3 changed files in your project folder, and 1 saved step that main on this Mac has but GitHub doesn't. They stay where they are.",
);
assert.equal(notInCopyWords(sp({ projectChanged: 3, localAhead: 0 })), "3 changed files in your project folder aren't in it. They stay where they are.");
assert.equal(notInCopyWords(sp({ projectChanged: 1 })), "1 changed file in your project folder isn't in it. They stay where they are.");
assert.equal(notInCopyWords(sp({ projectChanged: 0, localAhead: 1 })), "1 saved step that main on this Mac has but GitHub doesn't isn't in it.");
assert.equal(notInCopyWords(sp({ localAhead: 2 })), "2 saved steps that main on this Mac has but GitHub doesn't aren't in it.");
// Strictly ahead of GitHub: the copy starts from this Mac's branch, with its
// steps (the backend counts steps only when diverged, but never trust both).
assert.equal(notInCopyWords(sp({ projectChanged: 2, localAhead: 3, startsLocal: true })), "2 changed files in your project folder aren't in it. They stay where they are.");
assert.equal(notInCopyWords(sp({ projectChanged: 0, localAhead: 0, startsLocal: true })), null);
// Not on GitHub: the copy starts from this Mac's branch, so its steps are in it.
assert.equal(notInCopyWords(sp({ fromGitHub: false, projectChanged: 2, localAhead: 4 })), "2 changed files in your project folder aren't in it. They stay where they are.");
assert.equal(notInCopyWords(sp({ fromGitHub: false, localAhead: 4 })), null);
// Clean, or nothing read: no row.
assert.equal(notInCopyWords(sp({ projectChanged: 0, localAhead: 0 })), null);
assert.equal(notInCopyWords(sp({})), null);
assert.equal(notInCopyWords(null), null);

console.log("copyWords: ok");

// 1.174.1 P1 (T1): a Codex tile in a card's folder, and which folders are a card's.
assert.equal(CARD_TRUST_TILE_LINE, "Codex asks to trust this repository, not only this card's folder: choose to trust it.");
assert.equal(isCardFolder("/Users/me/proj/.plyloft-worktrees/card-mh1x-0"), true);
assert.equal(isCardFolder("/Users/me/proj/.plyloft-worktrees/card-mh1x-0/src"), true);
assert.equal(isCardFolder("C:\\Users\\me\\proj\\.plyloft-worktrees\\card-mh1x-0\\", [], null, true), true);
// Windows walk: Codex prints the root in lower case; either separator, any case.
assert.equal(isCardFolder("c:\\ply-test\\repo\\.PLYLOFT-WORKTREES\\Card-mvxv4oqp-0", [], "C:\\ply-test\\repo", true), true);
assert.equal(isCardFolder("c:/elsewhere/WT/a", ["C:\\Elsewhere\\wt"], null, true), true);
assert.equal(isCardFolder("c:\\p\\src", ["C:\\P"], "C:/p/", true), false);
// On the Mac the path itself: case can differ on a case-sensitive disk.
assert.equal(isCardFolder("/elsewhere/WT/a", ["/elsewhere/wt"], null, false), false);
assert.equal(isCardFolder("/Users/me/proj/.atelier-worktrees/card-old"), true);
assert.equal(isCardFolder("/Users/me/proj/.plyloft-worktrees/copy-1a2b3c4d"), false);
assert.equal(isCardFolder("/Users/me/proj/.plyloft-worktrees"), false);
assert.equal(isCardFolder("/Users/me/proj"), false);
assert.equal(isCardFolder(null), false);
// The worktree a card records, wherever it is.
assert.equal(isCardFolder("/elsewhere/wt/a", ["/elsewhere/wt/"]), true);
assert.equal(isCardFolder("/elsewhere/wt-other", ["/elsewhere/wt", null]), false);
assert.equal(isCardFolder("/Users/me/proj", ["", null, undefined]), false);
// Challenger P1: a card that records the project folder itself makes no tile there a card's.
assert.equal(isCardFolder("/Users/me/proj/src", ["/Users/me/proj/"], "/Users/me/proj"), false);
assert.equal(isCardFolder("C:\\p\\src", ["C:\\p"], "C:\\p\\", true), false);
assert.equal(isCardFolder("/elsewhere/wt/a", ["/Users/me/proj", "/elsewhere/wt"], "/Users/me/proj"), true);

// 1.174.1 P4 (T4): the open press names what it opens.
assert.equal(copyOpenLabel("claude"), "Open Claude");
assert.equal(copyOpenLabel("codex"), "Open Codex");
assert.equal(copyOpenLabel("shell"), "Open a terminal");
