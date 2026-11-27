// G1 (1.170.0): Ship it puts the card on GitHub.
//     node --experimental-strip-types src/lib/shipVia.test.ts
import assert from "node:assert/strict";
import {
  ONLY_HERE_LABEL,
  PR_ONLY_LABEL,
  SHIP_GUIDE_URL,
  SHIP_IT_GITHUB_TITLE,
  SHIP_IT_UNREADABLE_TAIL,
  SHIP_NEEDS_GH_WORDS,
  SHIP_NEEDS_SIGN_IN_WORDS,
  SHIP_NOTICE_BODY,
  SHIP_NOTICE_QUESTION,
  PR_ONLY_HINT,
  SHIP_CHOICE_LABELS,
  currentShipChoice,
  isShipPress,
  shipAnywayHandedOverTitle,
  shipChoiceHint,
  shipChoiceMode,
  shipChoiceRemembers,
  shipChoicesOffered,
  shipPressErrorName,
  shipPressLabel,
  shipAnywayTitle,
  shipItGoesToGitHub,
  shipNeedsGitHub,
  shipNoticeAnswer,
  shipNoticeDue,
  shipPressIsGitHub,
  shipPressMode,
  shipPressOf,
  shipViaChoice,
  shipViaHint,
  shipWithoutAutoMergeMode,
} from "./shipVia.ts";
import { cardActionError } from "./cardPage.ts";
import { GITHUB_SIGN_IN_ACTION } from "./plainError.ts";
import { errorForMachine } from "./uxError.ts";
import { readFileSync } from "node:fs";
import { presentCard } from "./cardPresentation.ts";
import { PRESENTATION_FIXTURES } from "./cardPresentation.fixtures.ts";

// The default goes to GitHub where a pull request can be opened.
assert.equal(shipItGoesToGitHub(undefined, true), true);
assert.equal(shipItGoesToGitHub(null, true), true);
assert.equal(shipItGoesToGitHub("github", true), true);
assert.equal(shipItGoesToGitHub("somewhere-new", true), true, "a later build's value reads as the default");
assert.equal(shipItGoesToGitHub("local", true), false);
assert.equal(shipItGoesToGitHub(undefined, false), false, "no pull request to open: here");
assert.equal(shipItGoesToGitHub("github", null), false, "not read yet: the plain words");

// Presses and modes, both ways. 1.171.0 B3 (CP-27): presses are ids; the
// card names them with `shipPressLabel`.
assert.equal(shipPressMode("ship-it"), "ship_it", "Ship it is tried again as Ship it — Rust decides where");
assert.equal(shipPressMode("pr"), "pr");
assert.equal(shipPressMode("pr-only"), "pr_only");
assert.equal(shipPressMode("only-here"), "merge_live");
assert.equal(shipPressOf("merge_live", true), "only-here");
assert.equal(shipPressOf("merge_live", false), "ship-it");
assert.equal(shipPressOf("ship_it", true), "ship-it");
assert.equal(shipPressOf("pr_only", true), "pr-only");
assert.equal(shipPressOf("pr", false), "pr");
assert.equal(shipPressLabel("ship-it"), "Ship it");
assert.equal(shipPressLabel("pr"), "On GitHub, merge when checks pass");
assert.equal(shipPressLabel("pr-only"), PR_ONLY_LABEL);
assert.equal(shipPressLabel("only-here"), ONLY_HERE_LABEL);
// Challenger 2: an error's title names a pull request press "The pull request".
assert.equal(shipPressErrorName("pr"), "The pull request");
assert.equal(shipPressErrorName("pr-only"), "The pull request");
assert.equal(shipPressErrorName("ship-it"), "Ship it");
assert.equal(shipPressErrorName("only-here"), ONLY_HERE_LABEL);
assert.equal(shipPressIsGitHub("ship-it", true), true);
assert.equal(shipPressIsGitHub("ship-it", false), false);
assert.equal(shipPressIsGitHub("only-here", true), false);
assert.equal(shipPressIsGitHub("pr-only", false), true);
for (const p of ["ship-it", "pr", "only-here", "pr-only"]) assert.ok(isShipPress(p), p);
assert.ok(!isShipPress("Merge"));
assert.ok(!isShipPress("Ship it"), "a label is not a press id");

// 1.171.0 B3 (LG-04): one Ship ▾ in every mode — three choices, the current
// one ticked; only the land here where no pull request can be opened.
assert.deepEqual(shipChoicesOffered(false), ["auto-merge", "pr-only", "only-here"]);
assert.deepEqual(shipChoicesOffered(true), ["only-here"]);
assert.deepEqual(
  shipChoicesOffered(false).map((c) => SHIP_CHOICE_LABELS[c]),
  ["On GitHub, merge when checks pass", "On GitHub, pull request only (I merge it)", "Only on this Mac"],
);
assert.equal(currentShipChoice(undefined, true), "auto-merge");
assert.equal(currentShipChoice("github", true), "auto-merge");
assert.equal(currentShipChoice("local", true), "only-here", "kept on this Mac");
assert.equal(currentShipChoice(undefined, false), "only-here", "no pull request to open");
assert.equal(currentShipChoice(undefined, null), null, "not read yet: nothing ticked");
assert.equal(shipChoiceMode("auto-merge", true), "ship_it");
assert.equal(shipChoiceMode("auto-merge", false), "pr", "a pull request with the choice remembered on");
assert.equal(shipChoiceMode("pr-only", true), "pr_only");
assert.equal(shipChoiceMode("pr-only", false), "pr_only");
assert.equal(shipChoiceMode("only-here", true), "merge_live");
assert.equal(shipChoiceMode("only-here", false), "merge_live", "never ship_it: Rust might open a pull request");
assert.equal(shipChoiceRemembers("auto-merge"), true);
assert.equal(shipChoiceRemembers("pr-only"), false);
assert.equal(shipChoiceRemembers("only-here"), null);
assert.equal(shipChoiceHint("pr-only"), PR_ONLY_HINT);
assert.match(shipChoiceHint("only-here", "main"), /main on this Mac/);

// The one-time notice: Ship it to GitHub, not seen yet — only then.
assert.equal(shipNoticeDue("ship_it", true, undefined), true);
assert.equal(shipNoticeDue("ship_it", true, false), true);
assert.equal(shipNoticeDue("ship_it", true, true), false, "once per workspace");
assert.equal(shipNoticeDue("ship_it", false, false), false, "Ship it that lands here says nothing new");
assert.equal(shipNoticeDue("merge_live", true, false), false);
assert.equal(shipNoticeDue("pr_only", true, false), false);
assert.deepEqual(shipNoticeAnswer("confirm"), { mode: "ship_it", seen: true });
assert.deepEqual(shipNoticeAnswer("alt"), { mode: "merge_live", seen: true });
assert.deepEqual(shipNoticeAnswer("cancel"), { mode: null, seen: true });
assert.deepEqual(shipNoticeAnswer("dismiss"), { mode: null, seen: false }, "closed: asked again next time");
assert.equal(
  SHIP_NOTICE_BODY,
  "Ship it now puts the card on GitHub: it opens a pull request and merges it when the checks pass.",
);
// 1.171.0 A3: the notice offers no Only on this Mac (it strands the change).
assert.equal("altLabel" in SHIP_NOTICE_QUESTION, false);
assert.doesNotMatch(SHIP_NOTICE_BODY, /Only on this Mac/i);
assert.equal(SHIP_NOTICE_QUESTION.link.url, SHIP_GUIDE_URL);
// The guide has the section the link opens (Starlight's heading slug).
const guide = readFileSync(new URL("../../docs/onboarding/USER_GUIDE.md", import.meta.url), "utf8");
assert.match(guide, /^#+ How Ship it ships$/m);
assert.ok(SHIP_GUIDE_URL.endsWith("#how-ship-it-ships"));

// The two refusals before any push, with their ways on.
const prefix = "This skill card's library copy moved on. ";
assert.equal(shipNeedsGitHub(`${SHIP_NEEDS_GH_WORDS}\nGitHub CLI isn't installed…`), "gh-missing");
assert.equal(shipNeedsGitHub(`${prefix}${SHIP_NEEDS_SIGN_IN_WORDS}\nno oauth token`), "sign-in");
assert.equal(shipNeedsGitHub("gh: pull request create failed"), null);

const missing = cardActionError("Ship it", `${SHIP_NEEDS_GH_WORDS}\nGitHub CLI isn't installed`);
assert.equal(missing.title, "Ship it stopped: the GitHub command isn't installed on this Mac.");
// 1.174.1 P5 (T5): the card says this Mac (this PC on Windows); Rust's words
// stay what shipNeedsGitHub finds.
assert.equal(missing.happened, "A pull request needs the GitHub command, and it isn't installed on this Mac, so nothing was pushed.");
assert.equal(
  errorForMachine(missing, "windows").title,
  "Ship it stopped: the GitHub command isn't installed on this PC.",
);
assert.equal(
  errorForMachine(missing, "windows").happened,
  "A pull request needs the GitHub command, and it isn't installed on this PC, so nothing was pushed.",
);
// 1.171.0 A3: the way on is the GitHub one only — no Only on this Mac.
assert.deepEqual(missing.actions.map((a) => a.label), ["Install the GitHub command", "Dismiss"]);
assert.equal(missing.todo, "Install the GitHub command, then press Ship it again.");
assert.ok(missing.actions.length <= 2);
assert.match(missing.details ?? "", /isn't installed/);
const signIn = cardActionError("Ship it", `${SHIP_NEEDS_SIGN_IN_WORDS}\nno oauth token found for github.com`);
assert.equal(signIn.title, "Ship it stopped: GitHub isn't signed in on this Mac.");
assert.equal(signIn.happened, "A pull request needs a GitHub sign-in on this Mac, and there is none for this project, so nothing was pushed.");
assert.deepEqual(signIn.actions.map((a) => a.id), [GITHUB_SIGN_IN_ACTION.id, "dismiss"]);
assert.doesNotMatch(signIn.todo, /only on this Mac/i);
assert.doesNotMatch(signIn.todo, /publish/);

// G1 Challenger (8): Ship it on a GitHub address that isn't a repository's
// stops, with Only on this Mac as the way on (Rust's words).
{
  const raw = `This project's GitHub address isn't a repository Plyloft can read: https://github.com/o. ${SHIP_IT_UNREADABLE_TAIL}`;
  assert.equal(shipNeedsGitHub(raw), "unreadable");
  const shown = cardActionError("Ship it", raw);
  assert.equal(shown.title, "Ship it stopped: this project's GitHub address isn't a repository.");
  assert.equal(shown.happened, "This project's GitHub address isn't a repository Plyloft can read: https://github.com/o.");
  assert.deepEqual(shown.actions.map((a) => a.id), ["ship-here", "dismiss"]);
  assert.match(shown.todo, /only on this Mac; GitHub won't have it\.$/);
  assert.doesNotMatch(shown.todo, /publish/);
  const rust = readFileSync(new URL("../../src-tauri/src/commands.rs", import.meta.url), "utf8");
  // Rust builds the tail with `this_machine!()` so Windows says "this PC";
  // the Mac text is that concat with "this Mac".
  const [head, tail] = SHIP_IT_UNREADABLE_TAIL.split("this Mac");
  assert.ok(
    rust.includes(`concat!("${head}", crate::this_machine!(), "${tail}")`),
    "the same words as Rust's SHIP_IT_UNREADABLE_TAIL",
  );
}

// G1 Challenger (1, 4): Ship anyway and Ship with follow-up never merge by
// themselves — the pull request alone where Ship it goes to GitHub.
assert.equal(shipWithoutAutoMergeMode(true), "pr_only");
assert.equal(shipWithoutAutoMergeMode(false), "ship_it");
assert.match(shipAnywayTitle(true), /leaves the merge to you/);
assert.doesNotMatch(shipAnywayTitle(true), /merges it when the checks pass/);
assert.match(shipAnywayTitle(false), /^Ship this card as it is/);
assert.match(shipAnywayHandedOverTitle(true), /leaves the merge to you/);
assert.match(shipAnywayHandedOverTitle(false), /^Ship without the Reviewer/);

// Settings › Build and release › How Ship it ships.
assert.equal(shipViaChoice(undefined), "github");
assert.equal(shipViaChoice("local"), "local");
assert.equal(shipViaChoice("somewhere-new"), "github");
assert.equal(
  shipViaHint("github", true),
  "Ship it opens a pull request on GitHub and merges it once GitHub's checks pass and the Reviewer approved. To merge it yourself, choose “pull request only” in Ship ▾.",
);
assert.equal(shipViaHint("local", true), "Ship it merges the card on this Mac only; GitHub doesn't have it. Kept on this Mac.");
assert.match(shipViaHint("github", false), /isn't on GitHub, so Ship it merges the card on this Mac/);

// The card's Now: Ship it says where it goes, and ships as `ship_it`.
{
  const fx = PRESENTATION_FIXTURES.find((x) => x.name === "ready to ship (result read)")!;
  const live = (prOffered: boolean, shipVia: string | null) => ({
    ...fx.live,
    outcome: { ...fx.live.outcome!, prOffered },
    workspace: { ...fx.live.workspace, shipVia },
  });
  const github = presentCard(fx.card, live(true, null));
  assert.equal(github.action.label, "Ship it");
  assert.equal(github.action.shipMode, "ship_it");
  assert.equal(github.action.title, SHIP_IT_GITHUB_TITLE);
  const kept = presentCard(fx.card, live(true, "local"));
  assert.equal(kept.action.shipMode, undefined, "kept here: the plain Ship it");
  assert.match(kept.action.title, /^Merges this card into .+ on this Mac and runs/);
  const offGitHub = presentCard(fx.card, live(false, null));
  assert.equal(offGitHub.action.shipMode, undefined);
  // A Ship it that failed is tried again as Ship it, said where it goes.
  const failed = presentCard(fx.card, { ...live(true, null), shipFailure: "ship-it" });
  assert.equal(failed.action.label, "Try again");
  assert.equal(failed.action.shipMode, "ship_it");
  assert.match(failed.action.title, /pull request again/);
  const failedHere = presentCard(fx.card, { ...live(true, null), shipFailure: "only-here" });
  assert.equal(failedHere.action.shipMode, "merge_live");
  assert.match(failedHere.action.title, /^Merges this card into .+ on this Mac again/);
}

// 1.171.0 A3 (DL-02): a pull request closed without merging ships again
// with Ship it — `ship_it`, not Ship as a PR's `pr`.
{
  const fx = PRESENTATION_FIXTURES.find((x) => x.name === "its pull request was closed")!;
  const live = (prOffered: boolean | undefined, shipVia: string | null) => ({
    ...fx.live,
    outcome: {
      ...(fx.live.outcome ?? { loading: false, filesChanged: 2, shipBusy: false, noRemote: false, reviewFreshness: "none" as const }),
      prOffered,
    },
    workspace: { ...fx.live.workspace, shipVia },
  });
  const again = presentCard(fx.card, live(true, null));
  assert.equal(again.action.label, "Ship it again");
  assert.equal(again.action.shipMode, "ship_it");
  assert.equal(again.action.title, SHIP_IT_GITHUB_TITLE);
  assert.doesNotMatch(again.sentence ?? "", /Ship as a PR/);
  const unread = presentCard(fx.card, live(undefined, null));
  assert.equal(unread.action.shipMode ?? "ship_it", "ship_it", "unread: still Ship it (Rust decides)");
  assert.equal(unread.action.label, "Ship it again");
  // Unreviewed: a new pull request that leaves the merge to the person.
  const unreviewed = {
    ...fx.card,
    builder: {
      vendor: "claude",
      bypass: false,
      sessionLost: false,
      startedAt: 1,
      snapshots: [{ n: 1, sha: "aaaaaaaa1", at: 2 }],
    },
  } as typeof fx.card;
  const anyway = presentCard(unreviewed, { ...live(true, null), tip: { branchTip: "aaaaaaaa1" } } as Parameters<typeof presentCard>[1]);
  assert.equal(anyway.rule, "pr-closed", anyway.rule);
  assert.equal(anyway.action.shipMode, "pr_only");
  assert.equal(anyway.action.label, "Open the pull request anyway (I merge it)");
  assert.match(anyway.sentence, /^Pull request #5 was closed without merging\. The Reviewer has not reviewed round 1\. .+ leaves the merge to you/);
}

console.log("shipVia: ok");
