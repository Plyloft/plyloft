// 1.174.0 (DR3, D1(b)): the Release sheet's words and rules
// (mockups/release.html states 1–5, the refusals of state 9).
//     node --experimental-strip-types src/lib/releaseSheet.test.ts
import assert from "node:assert/strict";
import type { ReleaseScope } from "../ipc.ts";
import {
  CARDS_SHOWN,
  RELEASE_MENU_ASKS,
  RELEASE_MENU_NOTHING,
  RELEASE_MENU_READING,
  alsoReadyHeading,
  areaOfTag,
  areaRefusalFix,
  progressLede,
  progressNote,
  progressSteps,
  releasePageUrl,
  releasedWords,
  releasingRowWords,
  stopAsks,
  stopConfirmWords,
  stopOffered,
  stoppedReleaseWords,
  areaChoiceWords,
  behindLine,
  boardReleaseItem,
  decodeStopped,
  divergedLine,
  footWords,
  initialTicks,
  kindHint,
  newSinceWords,
  nothingNewWords,
  onItsWayWords,
  onlyAreaWithSomething,
  otherChangeHint,
  pressSummary,
  readyCardHint,
  releaseLede,
  releaseOpener,
  scopeCardHint,
  scopeHasSomething,
  stoppedWords,
  tagOf,
  takenTag,
  takenWords,
  technicalLines,
  versionHint,
  versionSourceLine,
  whatsInCount,
  whatsInFold,
  withoutChecksLine,
} from "./releaseSheet.ts";

const NOW = Date.UTC(2026, 9, 31, 12);
const DAY = 86_400_000;
const card = (n: number, pr: number | null, daysAgo: number) => ({
  cardId: `c${n}`,
  title: `Card ${n}`,
  prNumber: pr,
  at: NOW - daysAgo * DAY,
  commits: [`s${n}`],
});
const scope = (over: Partial<ReleaseScope> = {}): ReleaseScope => ({
  workspaceId: "ws",
  area: "site",
  name: "Site",
  tagPrefix: "site-",
  targetBranch: "main",
  throughGithub: true,
  head: "7c1e9a2aa",
  fetchProblem: null,
  countProblem: null,
  partial: false,
  folder: "site",
  sinceTag: "site-v3.0.1",
  sinceAt: NOW - 12 * DAY,
  cards: [card(1, 382, 3), card(2, 385, 2), card(3, 388, 1), card(4, 390, 0)],
  cardsTotal: 4,
  otherChanges: [
    { sha: "a", title: "Bump astro to 5.14", prNumber: 386, author: "dependabot", at: NOW - 5 * DAY },
    { sha: "b", title: "Fix a typo in the footer", prNumber: null, author: "test-owner", at: NOW - 4 * DAY },
  ],
  otherTotal: 2,
  readyCardIds: ["r1"],
  localAhead: 0,
  localBehind: 0,
  diverged: false,
  currentVersion: "3.0.1",
  versionSource: "site/package.json",
  fileVersion: "3.0.1",
  tagVersion: "3.0.1",
  versionOnGithub: true,
  versions: [
    { kind: "patch", version: "3.0.2", tag: "site-v3.0.2", taken: false },
    { kind: "minor", version: "3.1.0", tag: "site-v3.1.0", taken: false },
    { kind: "major", version: "4.0.0", tag: "site-v4.0.0", taken: false },
  ],
  refusal: null,
  inFlight: null,
  busy: false,
  ...over,
});
const empty = scope({ cards: [], cardsTotal: 0, otherChanges: [], otherTotal: 0, readyCardIds: [] });

assert.equal(alsoReadyHeading("main"), "Also ready, not on main yet");

// State 1: the ⋯'s words — on as soon as something is new, off with the
// true reason.
assert.equal(newSinceWords(scope()), "4 cards and 2 other changes on main since site-v3.0.1 · 1 more card ready");
assert.equal(newSinceWords(scope({ readyCardIds: [] })), "4 cards and 2 other changes on main since site-v3.0.1");
assert.equal(newSinceWords(scope({ sinceTag: null, readyCardIds: [] })), "4 cards and 2 other changes on main");
assert.deepEqual(releaseOpener(scope(), "Site", NOW), {
  hint: "4 cards and 2 other changes on main since site-v3.0.1 · 1 more card ready",
  off: false,
});
// Nothing new on main, but a card ready: on.
assert.deepEqual(releaseOpener(scope({ cards: [], cardsTotal: 0, otherChanges: [], otherTotal: 0 }), "Site", NOW), {
  hint: "1 card ready, not on main yet",
  off: false,
});
// Nothing at all: off, saying since when.
assert.deepEqual(releaseOpener(scope({ ...empty, sinceAt: NOW - DAY }), "Site", NOW), {
  hint: "Nothing new on main since site-v3.0.1, released yesterday.",
  off: true,
});
assert.equal(nothingNewWords({ ...empty, sinceTag: null, sinceAt: null }, "Site", NOW), "Nothing on main for Site yet.");
assert.equal(nothingNewWords({ ...empty, sinceTag: null, sinceAt: null }, null, NOW), "Nothing on main yet.");
assert.deepEqual(releaseOpener(scope({ refusal: "Site is held." }), "Site", NOW), { hint: "Site is held.", off: true });
assert.deepEqual(
  releaseOpener(scope({ inFlight: { tag: "site-v3.0.2", version: "3.0.2", prNumber: 391, prUrl: null, step: "open", problem: null } }), "Site", NOW),
  { hint: "site-v3.0.2 is on its way", off: false },
);
assert.equal(scopeHasSomething(empty), false);
assert.equal(scopeHasSomething(scope({ readyCardIds: [] })), true);

// State 2: the lede, What's in it, the rows.
assert.equal(
  releaseLede(scope(), "Site", NOW),
  "A new version of Site with everything on main since site-v3.0.1, released 12 days ago.",
);
assert.equal(
  releaseLede(scope({ sinceTag: null, sinceAt: null }), "Site", NOW),
  "Site hasn't been released yet. Its first version has everything on main so far.",
);
// Walk fix (DR3 early walk): with nothing new, the lede says so.
assert.equal(
  releaseLede(scope({ ...empty, sinceAt: NOW - DAY }), "Site", NOW),
  "Nothing new on main since site-v3.0.1, released yesterday.",
);
assert.equal(
  releaseLede(scope({ ...empty, sinceAt: NOW - DAY }), "Site", NOW, 1),
  "Nothing new on main since site-v3.0.1, released yesterday. A new version can still carry the ready card below.",
);
assert.equal(whatsInCount(scope()), "4 cards · 2 other changes");
assert.equal(whatsInCount(scope({ otherTotal: 0 })), "4 cards");
assert.equal(scopeCardHint(card(1, 382, 3), NOW), "Pull request #382 · merged 3 days ago");
assert.equal(scopeCardHint(card(1, null, 1), NOW), "Merged yesterday");
assert.equal(otherChangeHint(scope().otherChanges[0], NOW), "Pull request #386 by dependabot · merged 5 days ago");
assert.equal(otherChangeHint(scope().otherChanges[1], NOW), "Change by test-owner · 4 days ago");
// Four cards are listed; the other changes are folded.
const fold = whatsInFold(scope());
assert.equal(fold.shown.length, CARDS_SHOWN);
assert.equal(fold.fold, "2 other changes on main · not from a card");
assert.equal(fold.foldHasCards, false);
// More cards (state 3): two listed, the rest folded with the other changes.
const many = scope({ cardsTotal: 9, otherTotal: 14 });
assert.equal(whatsInFold(many).shown.length, 2);
assert.equal(whatsInFold(many).fold, "7 more cards and 14 other changes");
assert.equal(whatsInFold(scope({ otherTotal: 0, otherChanges: [] })).fold, null);
assert.equal(readyCardHint(false), "Checked and approved · goes into the release as its own change");
assert.equal(readyCardHint(true), "Checks skipped · goes into the release as its own change");

// Ticks: every ready card ticked by default (owner), on every plan.
assert.deepEqual(initialTicks(["r1", "r2"], undefined), ["r1", "r2"]);
assert.deepEqual(initialTicks(["r1", "r2"], ["r2"]), ["r2"]);
assert.deepEqual(initialTicks(["r1", "r2"], ["x"]), []);

// Version: patch first (owner), its hint; the source line.
assert.equal(versionHint(scope().versions[0], scope()), "Fixes and small changes");
assert.equal(versionHint(scope().versions[1], scope()), "Something new");
assert.equal(versionHint(scope().versions[2], scope()), "A change that breaks something people rely on");
assert.equal(
  versionHint({ kind: "asIs", version: "1.0.0", tag: "site-v1.0.0", taken: false }, scope()),
  "What site/package.json says now",
);
assert.equal(
  versionHint({ kind: "first", version: "0.1.0", tag: "site-v0.1.0", taken: false }, scope()),
  "A first version that isn't final yet",
);
assert.equal(
  versionHint({ kind: "patch", version: "3.0.2", tag: "site-v3.0.2", taken: true }, scope()),
  "site-v3.0.2 is already a tag on GitHub.",
);
assert.equal(
  versionSourceLine(scope(), "Site"),
  "Site’s version file, site/package.json, says 3.0.1 on GitHub; the latest tag is site-v3.0.1.",
);
assert.equal(versionSourceLine(scope({ versionSource: "tag" }), "Site"), "The latest tag is site-v3.0.1.");
assert.equal(versionSourceLine(scope({ versionSource: null, sinceTag: null }), "Site"), null);
assert.equal(tagOf("site-", "v3.0.9"), "site-v3.0.9");
assert.equal(takenTag(scope({ versions: [{ kind: "patch", version: "3.0.2", tag: "site-v3.0.2", taken: true }] }), "site-v3.0.2"), true);
assert.equal(takenWords("site-v3.0.2", true), "site-v3.0.2 is already a tag on GitHub. Choose another version.");

// How far it goes (state 2, 3): the default named, the install step only
// when there is one.
const kinds = { throughGithub: true, branch: "main", chosenDefault: false, owner: "Site" };
assert.equal(kindHint("local", kinds), "Makes the new version on this Mac, from this Mac’s main. Nothing goes to GitHub.");
assert.equal(
  kindHint("local", { ...kinds, installScript: "npm run deploy:local" }),
  "Makes the new version on this Mac, from this Mac’s main, and runs the install step (npm run deploy:local). Nothing goes to GitHub.",
);
// 1.175.0 B2 (round 2): an install step that waits for this Mac's OK isn't promised.
assert.equal(
  kindHint("local", { ...kinds, installScript: "scripts/deploy-all.sh", installWaits: true }),
  "Makes the new version on this Mac, from this Mac’s main, then asks before it runs the install step (scripts/deploy-all.sh), which this Mac hasn't allowed yet. Nothing goes to GitHub.",
);
assert.equal(
  kindHint("push_only", { ...kinds, chosenDefault: true }),
  "Site’s default (Settings › Cards › Shipping). A release pull request on GitHub, merged when its checks pass, then tagged.",
);
assert.equal(kindHint("github", kinds), "The same, then a release page on GitHub with what’s in it.");
assert.equal(
  behindLine("main", 4),
  "This Mac’s main is 4 changes behind main on GitHub. Plyloft brings it up to date first; nothing is sent to GitHub.",
);
assert.equal(
  divergedLine("main"),
  "This Mac’s main and GitHub’s both have changes the other doesn’t. Release on GitHub instead, or bring them together in Code first.",
);

// The one line that says what happens, and the foot.
assert.equal(
  pressSummary({ tag: "site-v3.0.2", branch: "main", kind: "push_only", throughGithub: true, ticked: 1, skipVerify: false }),
  "Plyloft makes site-v3.0.2 from main on GitHub with 1 more card, runs your checks on it, and opens a release pull request. GitHub merges it when its checks pass; then Plyloft tags it.",
);
assert.equal(
  pressSummary({ tag: "site-v3.0.2", branch: "main", kind: "local", throughGithub: true, ticked: 0, skipVerify: false }),
  "Plyloft makes site-v3.0.2 on this Mac from this Mac’s main, runs your checks on it, and tags it. Nothing goes to GitHub.",
);
assert.equal(footWords(scope(), 1), "Cards go to main · 6 changes, 1 more card");
assert.equal(footWords(empty, 0), "Cards go to main");

// State 2b: the technical words stay under Details.
assert.deepEqual(technicalLines(scope(), "site-v3.0.2", "push_only"), [
  "Made from main on GitHub, at 7c1e9a2 · cards go to main",
  "Release branch plyloft/release-site-v3.0.2",
  "Tag site-v3.0.2, on the merge",
  "Since site-v3.0.1 · only changes in the site folder",
]);
{
  const lines = technicalLines(scope(), "site-v3.0.2", "push_only", "site and test, from site.yml and test.yml");
  assert.equal(lines[lines.length - 1], "Checks site and test, from site.yml and test.yml");
}
assert.equal(technicalLines(scope(), "site-v3.0.2", "local", "site, from site.yml").length, 3, "no Checks line when kept on this Mac");
assert.deepEqual(technicalLines(scope({ folder: "" }), "site-v3.0.2", "local"), [
  "Made from this Mac’s main · cards go to main",
  "Tag site-v3.0.2",
  "Since site-v3.0.1",
]);
assert.equal(
  withoutChecksLine("site-v3.0.2", "local"),
  "The tag becomes site-v3.0.2-unverified, and it’s never put on GitHub with a release page.",
);

// G2 walk (Mac): the same line whatever the kind; a version on its way;
// a done release without its number says "its release pull request".
assert.equal(withoutChecksLine("v1.0.1", "push_only"), withoutChecksLine("v1.0.1", "github"));
assert.equal(
  versionHint({ kind: "asIs", version: "1.0.0", tag: "v1.0.0", taken: true, onItsWay: true }, scope()),
  "GitHub already has a release branch for v1.0.0: a release of it is open or left over there. Choose another version.",
);
assert.equal(
  versionHint(
    { kind: "asIs", version: "1.0.0", tag: "v1.0.0", taken: true, onItsWay: true },
    scope({ inFlight: { tag: "v1.0.0", version: "1.0.0", prNumber: 142, prUrl: null, step: "open", problem: null } }),
  ),
  "A release of v1.0.0 is already on its way on GitHub.",
);
assert.equal(
  releasedWords({ tag: "v1.0.1", cards: 0, otherChanges: 1, prNumber: null, page: false, throughPr: true }).lede,
  "1 other change, merged as its release pull request and tagged v1.0.1.",
);

// State 9: one release of an area at a time.
assert.equal(
  onItsWayWords({ tag: "site-v3.0.2", version: "3.0.2", prNumber: 391, prUrl: null, step: "open", problem: null }, "Site"),
  "site-v3.0.2 is on its way (release pull request #391). Only one release of Site at a time.",
);

// State 4: which area.
const app = scope({ area: "app", name: "App", targetBranch: "staging", sinceTag: "app-v1.4.0", cardsTotal: 1, otherTotal: 0, readyCardIds: [] });
const blog = scope({ ...empty, area: "blog", name: "Blog", sinceTag: "blog-v0.3.0" });
const docs = scope({ area: "docs", name: "Docs", refusal: "Docs has no version file of its own: Settings › Areas › Docs sets one." });
assert.deepEqual(areaChoiceWords(app, "App", NOW), { words: "1 card on staging since app-v1.4.0", act: true });
assert.deepEqual(areaChoiceWords(blog, "Blog", NOW), { words: "Nothing new for Blog since blog-v0.3.0.", act: false });
assert.equal(areaChoiceWords(docs, "Docs", NOW).act, false);
assert.equal(onlyAreaWithSomething([app, blog, docs])?.area, "app");
assert.equal(onlyAreaWithSomething([app, scope()]), null);

// The fix of a refused area: Open Areas when the refusal is the version
// file's, or names Areas (ship.rs's `others_version_file_words`).
assert.equal(areaRefusalFix("Docs has no version file of its own. Add one in Settings › Project › Areas."), "areas");
assert.equal(areaRefusalFix("Its version file is another area's: change it in Settings › Project › Areas."), "areas");
assert.equal(areaRefusalFix("Site's areas are held."), null);
assert.equal(areaRefusalFix(null), null);

// The Board's ⋯ (state 1).
const areas = [
  { id: "site", name: "Site" },
  { id: "app", name: "App" },
];
assert.deepEqual(boardReleaseItem({ scopes: null, failed: false }, areas, areas[0], NOW), {
  label: "Release Site…",
  hint: RELEASE_MENU_READING,
  off: true,
  areaId: "site",
});
assert.deepEqual(boardReleaseItem({ scopes: [scope(), app], failed: false }, areas, areas[0], NOW), {
  label: "Release Site…",
  hint: "4 cards and 2 other changes on main since site-v3.0.1 · 1 more card ready",
  off: false,
  areaId: "site",
});
assert.deepEqual(boardReleaseItem({ scopes: [scope(), app], failed: false }, areas, null, NOW), {
  label: "Release…",
  hint: RELEASE_MENU_ASKS,
  off: false,
  areaId: undefined,
});
assert.equal(boardReleaseItem({ scopes: [scope(), blog], failed: false }, areas, null, NOW).label, "Release Site…");
assert.deepEqual(boardReleaseItem({ scopes: [blog, blog], failed: false }, areas, null, NOW), {
  label: "Release…",
  hint: RELEASE_MENU_NOTHING,
  off: true,
  areaId: undefined,
});
// Without areas: the project's, by its own label.
assert.deepEqual(boardReleaseItem({ scopes: [scope({ area: null, name: null })], failed: false }, [], null, NOW), {
  label: "Release…",
  hint: "4 cards and 2 other changes on main since site-v3.0.1 · 1 more card ready",
  off: false,
  areaId: null,
});
// A reading that failed leaves it on: the sheet says what it can't read.
assert.equal(boardReleaseItem({ scopes: null, failed: true }, [], null, NOW).off, false);

// DR2's Stop: `{ stopped }` from releaseTheArea, shipBatch or shipCard.
const stopped = { stopped: { tag: "site-v3.0.2", version: "3.0.2", onGithub: null, here: null, github: true } };
assert.deepEqual(decodeStopped(stopped), stopped.stopped);
assert.equal(decodeStopped("ship aborted"), null);
assert.equal(decodeStopped({ unpublished: {} }), null);
assert.deepEqual(stoppedWords(stopped.stopped), {
  title: "site-v3.0.2 is stopped",
  body: "Nothing went to GitHub, and the release was taken back.",
});
assert.equal(
  stoppedWords({ ...stopped.stopped, onGithub: "Its pull request's auto-merge is off; the pull request stays open." }).body,
  "Its pull request's auto-merge is off; the pull request stays open.",
);
assert.equal(stoppedWords({ ...stopped.stopped, github: false }).body, "The release was taken back.");

// ── DR4: on its way, Stop, done, errors (states 6–9, 11) ──────────────────
{
  const base = { tag: "site-v3.0.2", branch: "main", kind: "push_only" as const, throughPr: true };
  const at = (step: Parameters<typeof progressSteps>[0]["step"], pr = {}) =>
    progressSteps({ ...base, step, pr: { number: 391, waiting: null, outdated: false, ...pr } }).map((s) => [s.state, s.label]);
  // State 6, left: made here, checks running, the rest to come.
  assert.deepEqual(at("building"), [
    ["done", "Made on this Mac from main on GitHub"],
    ["running", "Running your checks on it"],
    ["todo", "Open the release pull request on GitHub"],
    ["todo", "Merge it when GitHub’s checks pass"],
    ["todo", "Tag it site-v3.0.2"],
  ]);
  // State 6, right: the pull request waits for GitHub's checks.
  assert.deepEqual(at("merging"), [
    ["done", "Made on this Mac from main on GitHub"],
    ["done", "Your checks passed on it"],
    ["done", "Release pull request #391 opened on GitHub"],
    ["running", "Waiting for GitHub’s checks"],
    ["todo", "Tag it site-v3.0.2"],
  ]);
  assert.equal(
    progressSteps({ ...base, step: "open", pr: { number: 391, waiting: null, outdated: false } })[3].sub,
    "GitHub merges it when they pass",
  );
  assert.equal(
    progressSteps({ ...base, step: "open", pr: { number: 391, waiting: null, outdated: false, plyloftMerges: true } })[3].sub,
    "Plyloft merges it when they pass",
  );
  // State 7, right: behind main.
  assert.deepEqual(at("open", { outdated: true })[3], ["warn", "Behind main on GitHub"]);
  // State 8: every step behind it.
  assert.deepEqual(
    progressSteps({ ...base, kind: "github", step: "tagged", done: true, pr: { number: 391, waiting: null, outdated: false } }).map((s) => s.state),
    ["done", "done", "done", "done", "done"],
  );
  assert.equal(progressSteps({ ...base, kind: "github", step: null, done: true })[4].label, "Tagged site-v3.0.2 · release page made");
  // Stopped while it was being made (a quit).
  assert.equal(progressSteps({ ...base, step: "building", stopped: true, pr: { number: null, waiting: "Plyloft quit.", outdated: false } })[1].state, "failed");
  // Kept on this Mac.
  assert.deepEqual(
    progressSteps({ ...base, kind: "local", throughPr: false, step: null }).map((s) => s.state),
    ["running", "todo"],
  );

  // What Stop does now, and what Close leaves.
  assert.equal(progressNote({ ...base, step: "building" }), "Nothing is on GitHub yet. Stop takes it back.");
  assert.equal(
    progressNote({ ...base, step: "merging", pr: { outdated: false } }),
    "You can close this and quit Plyloft: GitHub merges it by itself, and Plyloft tags it the next time it’s open.",
  );
  assert.equal(
    progressNote({ ...base, step: "merging", pr: { outdated: false, plyloftMerges: true } }),
    "Plyloft merges it once the checks pass, only while Plyloft is open on this Mac.",
  );
  assert.equal(
    progressNote({ ...base, step: "open", pr: { outdated: true } }),
    "Update the release brings main’s new changes into it, checks it again and sends it. They’ll be in site-v3.0.2 too.",
  );
  // Stop: until merged; it asks once the release is on GitHub (state 7).
  assert.equal(stopOffered("merging"), true);
  assert.equal(stopOffered("merged"), false);
  assert.equal(stopAsks("building"), false);
  assert.equal(stopAsks("open"), true);
  assert.deepEqual(stopConfirmWords("site-v3.0.2", 391), {
    title: "Stop site-v3.0.2?",
    body: "Plyloft turns off its merging by itself and forgets the release here. Release pull request #391 stays open on GitHub: close it there if you don’t want it. Nothing was tagged.",
  });
  assert.equal(
    progressLede({ branch: "main", mergedCards: 4, otherChanges: 2, ticked: ["Blog: RSS feed for posts"] }),
    "4 cards and 2 other changes from main, and Blog: RSS feed for posts.",
  );
  assert.equal(progressLede({ branch: "main", mergedCards: 4, otherChanges: 2, ticked: [] }), "4 cards and 2 other changes from main.");
  // State 8: done.
  assert.deepEqual(releasedWords({ tag: "site-v3.0.2", cards: 5, otherChanges: 2, prNumber: 391, page: true, throughPr: true }), {
    title: "site-v3.0.2 is released",
    lede: "5 cards and 2 other changes, merged as release pull request #391 and tagged site-v3.0.2. The release page is on GitHub.",
  });
  assert.equal(
    releasedWords({ tag: "v3.0.2", cards: 1, otherChanges: 0, prNumber: null, page: false, throughPr: false }).lede,
    "1 card, made and tagged on this Mac.",
  );
  assert.equal(
    releasePageUrl("https://github.com/acme/app/pull/391", "site-v3.0.2"),
    "https://github.com/acme/app/releases/tag/site-v3.0.2",
  );
  // State 9: one that can't go on by itself.
  assert.deepEqual(stoppedReleaseWords("site-v3.0.2", "Release pull request #391 was closed on GitHub without merging.", "main"), {
    title: "site-v3.0.2 can't go on by itself",
    lede: "Release pull request #391 was closed on GitHub without merging. Nothing was tagged, and nothing in it is lost: the changes are still on main.",
  });
  // DR4 round 1: GitHub's checks failed — the merge step warns.
  assert.deepEqual(at("merging", { checksFailed: true, waiting: "Checks failed on GitHub for #391 (test)." })[3], ["warn", "GitHub’s checks failed"]);
  // Before the record: even "made" is under way.
  assert.deepEqual(
    progressSteps({ ...base, step: null, making: true }).slice(0, 2).map((s) => [s.state, s.label]),
    [["running", "Making it on this Mac from main on GitHub"], ["todo", "Run your checks on it"]],
  );
  // Stop with its branch pushed and no pull request yet.
  assert.equal(
    stopConfirmWords("site-v3.0.2", null, "plyloft/release-site-v3.0.2").body,
    "Plyloft forgets the release here. Its branch plyloft/release-site-v3.0.2 stays on GitHub; no pull request was opened. Nothing was tagged.",
  );
  // A stopped release with cards of its own: they are still ready.
  assert.equal(
    stoppedReleaseWords("site-v3.0.2", "Closed.", "main", 1).lede,
    "Closed. Nothing was tagged, and nothing in it is lost: the changes are still on main, and the ready cards are still ready.",
  );
  assert.equal(releasingRowWords("site-v3.0.2", "merging", null, true), "site-v3.0.2 is waiting · GitHub's checks failed");
  // State 11: the sidebar's row.
  assert.equal(releasingRowWords("site-v3.0.2", "building", null), "Releasing site-v3.0.2 · checks running");
  assert.equal(releasingRowWords("site-v3.0.2", "merging", null), "Releasing site-v3.0.2 · waiting for GitHub's checks");
  assert.equal(releasingRowWords("site-v3.0.2", "open", "closed"), "site-v3.0.2 stopped");
  assert.equal(areaOfTag([{ id: "app", tagPrefix: "" }, { id: "site", tagPrefix: "site-" }], "site-v3.0.2"), "site");
  assert.equal(areaOfTag([{ id: "app", tagPrefix: "" }, { id: "site", tagPrefix: "site-" }], "v1.4.0"), null);
}

console.log("releaseSheet: ok");
