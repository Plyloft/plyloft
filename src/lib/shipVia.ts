// G1 (1.170.0): Ship it puts the card on GitHub. On a project whose
// `origin` can take a pull request (1.169.1 R10: `CardOutcome.hasRemote`),
// the card's Ship it opens the pull request and merges it when its checks
// pass (`card_ship` with `ship_it`, resolved by Rust's `resolve_ship_press`);
// the land on this Mac is Ship ▾ › Only on this Mac. A workspace
// can keep Ship it on this Mac (Settings › Shipping › How Ship it ships —
// Build and release until 1.173.0 — `Workspace.shipVia`); a project with no pull request to open
// ships here as before. Pure: node runs `shipVia.test.ts`.

import type { ShipPress } from "./cardLifecycle.ts";
import { targetHere } from "./worktreeBase.ts";
import { SHIP_CHOICE_AUTO_MERGE, SHIP_CHOICE_ONLY_HERE, SHIP_CHOICE_PR_ONLY } from "./deliveryWords.ts";

/** How a workspace's Ship it ships (`Workspace.shipVia`). */
export type ShipVia = "github" | "local";

/** What `card_ship` is asked to do. `ship_it` is the card's Ship it, as the
 *  workspace and the project say; `pr_only` a pull request that doesn't
 *  merge by itself; `pr` a pull request that follows the workspace's
 *  remembered choice (`mergeWhenChecksPass`, Ship ▾'s first two choices);
 *  `merge_live` a land on this Mac. */
export type ShipMode = "merge_live" | "pr" | "ship_it" | "pr_only";

/** Ship ▾'s land on this Mac, on a project whose Ship it goes to GitHub. */
export const ONLY_HERE_LABEL = SHIP_CHOICE_ONLY_HERE;
/** The label inside a sentence ("ship it only on this Mac"): only its first
 *  letter lowered, so `machineWords` still reads "this PC" on Windows. */
export function onlyHereInline(): string {
  return ONLY_HERE_LABEL.charAt(0).toLowerCase() + ONLY_HERE_LABEL.slice(1);
}
/** Ship ▾'s pull request without auto-merge (1.171.0 B3: the second choice). */
export const PR_ONLY_LABEL = SHIP_CHOICE_PR_ONLY;

/** The primary's title where Ship it goes to GitHub. */
export const SHIP_IT_GITHUB_TITLE = "Opens a pull request on GitHub and merges it when the checks pass.";
/** 1.171.0 A3 (owner D2: no Publish in 1.171): where a land on this Mac
 *  leaves the change, by the target's real name — "It's in main on this Mac
 *  only; GitHub doesn't have it." Never "until you publish it": there is no
 *  Publish press. */
export function onlyHereTruth(target?: string | null): string {
  return `It's in ${targetHere(target)} only; GitHub doesn't have it.`;
}
/** Ship ▾ › Only on this Mac's line (1.169.1 R13's "not on GitHub yet"),
 *  by the target's real name (G10: "main on this Mac"). */
export function onlyHereHint(target?: string | null): string {
  return `Merges the card into ${targetHere(target)}. ${onlyHereTruth(target)}`;
}
/** Ship ▾'s pull request only: its line. */
export const PR_ONLY_HINT = "Opens the pull request and leaves the merge to you.";
/** Ship ▾'s merge when checks pass: its line. */
export const AUTO_MERGE_HINT = "Opens the pull request and merges it once GitHub's checks pass.";

/** Whether the card's Ship it opens a pull request: the project can take
 *  one (`hasRemote === true`; unknown while the result loads) and the
 *  workspace isn't set to ship here. An unknown `shipVia` (a later build's)
 *  reads as the default, as in Rust. */
export function shipItGoesToGitHub(
  shipVia: string | null | undefined,
  prOffered: boolean | null | undefined,
): boolean {
  return prOffered === true && shipVia !== "local";
}

/** The mode a failed press is tried again with. Ship it is always asked as
 *  `ship_it`: Rust ships it as the workspace says, here or on GitHub. */
export function shipPressMode(press: ShipPress): ShipMode {
  switch (press) {
    case "pr":
      return "pr";
    case "pr-only":
      return "pr_only";
    case "only-here":
      return "merge_live";
    case "ship-it":
      return "ship_it";
  }
}

/** The press a mode came from (1.171.0 B3, CP-27: by id, so the words can
 *  change): a land is Ship it on a project whose Ship it lands here, Only
 *  on this Mac where it goes to GitHub. */
export function shipPressOf(mode: ShipMode, toGitHub: boolean): ShipPress {
  switch (mode) {
    case "pr":
      return "pr";
    case "pr_only":
      return "pr-only";
    case "ship_it":
      return "ship-it";
    case "merge_live":
      return toGitHub ? "only-here" : "ship-it";
  }
}

/** A press as the card names it (in an error's title, "press … again").
 *  Only on this Mac says "this Mac": the card draws it through
 *  `machineWords` (`errorForMachine`). */
export function shipPressLabel(press: ShipPress): string {
  switch (press) {
    case "ship-it":
      return "Ship it";
    case "pr":
      return SHIP_CHOICE_AUTO_MERGE;
    case "pr-only":
      return PR_ONLY_LABEL;
    case "only-here":
      return ONLY_HERE_LABEL;
  }
}

/** 1.171.0 B3 (Challenger 2): the name an error's title gives a press —
 *  "The pull request" for Ship ▾'s pull request choices (its title then
 *  reads "The pull request didn't open."); `shipPressLabel` stays the name
 *  in "press … again". */
export const PR_ERROR_NAME = "The pull request";
export function shipPressErrorName(press: ShipPress): string {
  return press === "pr" || press === "pr-only" ? PR_ERROR_NAME : shipPressLabel(press);
}

/** Rust's `PR_OPEN_FAILED` (`card_ship`): the branch was pushed, then
 *  `gh pr create` failed or didn't finish. */
export const PR_OPEN_FAILED_WORDS = "opening the pull request failed:";
/** The way on — the error's and Now's one retry: the same ship again,
 *  which opens the pull request. */
export const OPEN_PR_RETRY_LABEL = "Open the pull request";

/** What `gh pr create` said, when a ship's push reached GitHub and its pull
 *  request didn't open; null for any other error. */
export function prOpenFailure(raw: string): string | null {
  const at = raw.indexOf(PR_OPEN_FAILED_WORDS);
  return at < 0 ? null : raw.slice(at + PR_OPEN_FAILED_WORDS.length).trim();
}

// ── Ship ▾ (1.171.0 B3, LG-04) ──────────────────────────────────────────
// One menu in every mode: the primary Ship it does what the project's How
// Ship it ships says, and the ▾ lists the three ways it can ship, the
// current one ticked. A project that can't take a pull request has no ▾
// (the land here is the primary). The workspace's remembered "merge when
// checks pass" (`mergeWhenChecksPass`, kept) is read only by a `pr` ship —
// merge when checks pass on a project kept on this Mac — so only that press
// writes it (on) first; Ship it to GitHub and pull request only don't need
// it. While the last commit has no approved review, the two pull request
// choices are one: Open the pull request anyway (I merge it).

/** The three ways Ship ▾ ships. */
export type ShipChoice = "auto-merge" | "pr-only" | "only-here";

export const SHIP_CHOICE_LABELS: Readonly<Record<ShipChoice, string>> = {
  "auto-merge": SHIP_CHOICE_AUTO_MERGE,
  "pr-only": SHIP_CHOICE_PR_ONLY,
  "only-here": SHIP_CHOICE_ONLY_HERE,
};

/** The choices Ship ▾ lists, in its order: all three, or only the land
 *  here where no pull request can be opened (`noPullRequest`). */
export function shipChoicesOffered(noPullRequest: boolean): ShipChoice[] {
  return noPullRequest ? ["only-here"] : ["auto-merge", "pr-only", "only-here"];
}

/** The choice Ship it makes now (the ticked one): the land here on a
 *  workspace kept on this Mac or a project with no pull request to open;
 *  merge when checks pass where Ship it goes to GitHub; none while the
 *  project isn't read yet. */
export function currentShipChoice(
  shipVia: string | null | undefined,
  prOffered: boolean | null | undefined,
): ShipChoice | null {
  if (shipVia === "local" || prOffered === false) return "only-here";
  return prOffered === true ? "auto-merge" : null;
}

/** The mode a choice ships with. Merge when checks pass is Ship it where it
 *  goes to GitHub, else a `pr` ship with the choice remembered on; the land
 *  here is always `merge_live`. */
export function shipChoiceMode(choice: ShipChoice, toGitHub: boolean): ShipMode {
  switch (choice) {
    case "auto-merge":
      return toGitHub ? "ship_it" : "pr";
    case "pr-only":
      return "pr_only";
    case "only-here":
      // Never `ship_it`: on a project not read yet, Rust may open a pull
      // request for it.
      return "merge_live";
  }
}

/** What a choice asks of the workspace's `mergeWhenChecksPass` (null:
 *  nothing). The ship writes it only for a `pr` ship, the one that reads
 *  it (`ShipRunner`'s `remember`). */
export function shipChoiceRemembers(choice: ShipChoice): boolean | null {
  return choice === "auto-merge" ? true : choice === "pr-only" ? false : null;
}

/** A choice's line under its label. `target`: the branch it lands on. */
export function shipChoiceHint(choice: ShipChoice, target?: string | null): string {
  switch (choice) {
    case "auto-merge":
      return AUTO_MERGE_HINT;
    case "pr-only":
      return PR_ONLY_HINT;
    case "only-here":
      return onlyHereHint(target);
  }
}

// ── Ships that never merge by themselves (G1 Challenger 1, 4) ───────────
// Nothing unreviewed, shipped over a request for changes nobody resolved or
// with its findings in a follow-up merges by itself; a human's decision
// (findings dismissed, a pushback accepted) does (owner, 2026-10-15): where
// Ship it goes to GitHub, Ship anyway and Ship with follow-up open the pull
// request and leave the merge to the person. Rust forces it too
// (`ship_auto_merge_guarded`).

/** The mode Ship anyway / Ship with follow-up ship with: the pull request
 *  alone where Ship it goes to GitHub, Ship it (a land here) otherwise. */
export function shipWithoutAutoMergeMode(toGitHub: boolean): ShipMode {
  return toGitHub ? "pr_only" : "ship_it";
}

/** Ship anyway's title, where the last commit was not reviewed. */
export function shipAnywayTitle(toGitHub: boolean): string {
  return toGitHub
    ? "Opens a pull request for this card as it is and leaves the merge to you. The receipt and the pull request say the last commit was not reviewed."
    : "Ship this card as it is. The receipt and a pull request body say the last commit was not reviewed.";
}

/** Ship anyway's title, where the findings went to a follow-up and were not
 *  re-checked. */
export function shipAnywayHandedOverTitle(toGitHub: boolean): string {
  return toGitHub
    ? "Opens a pull request without the Reviewer re-checking these findings and leaves the merge to you. The receipt and the pull request say they were not re-checked."
    : "Ship without the Reviewer re-checking these findings. The receipt and the PR body say they were not re-checked.";
}

/** Whether the press talks to GitHub (R11's reading of its refusal). */
export function shipPressIsGitHub(press: ShipPress, toGitHub: boolean): boolean {
  return press === "pr" || press === "pr-only" || (press === "ship-it" && toGitHub);
}

// ── The one-time notice ─────────────────────────────────────────────────

/** The guide's section on how Ship it ships (`USER_GUIDE.md`, "How Ship it
 *  ships", published at /docs/guide/). */
export const SHIP_GUIDE_URL = "https://www.plyloft.com/docs/guide/#how-ship-it-ships";

export const SHIP_NOTICE_TITLE = "Ship it now puts the card on GitHub";
/** 1.171.0 A3: no "Only on this Mac" as the way on — a land here strands the
 *  change off GitHub, and the next Ship it stops on it (DL-10). */
export const SHIP_NOTICE_BODY =
  "Ship it now puts the card on GitHub: it opens a pull request and merges it when the checks pass.";
export const SHIP_NOTICE_GUIDE_LABEL = "How Ship it ships";

/** The notice as the confirm sheet asks it (`confirmChoice`): Ship it goes
 *  on, Cancel ships nothing (1.171.0 A3: no Only on this Mac here). */
export const SHIP_NOTICE_QUESTION = {
  title: SHIP_NOTICE_TITLE,
  body: SHIP_NOTICE_BODY,
  confirmLabel: "Ship it",
  cancelLabel: "Cancel",
  link: { label: SHIP_NOTICE_GUIDE_LABEL, url: SHIP_GUIDE_URL },
} as const;

/** Whether this press asks the notice first: Ship it, going to GitHub, on a
 *  workspace that hasn't answered it. Once per workspace. */
export function shipNoticeDue(mode: ShipMode, toGitHub: boolean, seen: boolean | null | undefined): boolean {
  return mode === "ship_it" && toGitHub && seen !== true;
}

/** What the notice's answer does: the mode to ship with (null: nothing is
 *  shipped), and whether it counts as seen. Closing it (Escape) is neither. */
export function shipNoticeAnswer(answer: "confirm" | "cancel" | "alt" | "alt2" | "dismiss"): {
  mode: ShipMode | null;
  seen: boolean;
} {
  switch (answer) {
    case "confirm":
      return { mode: "ship_it", seen: true };
    case "alt":
      return { mode: "merge_live", seen: true };
    case "cancel":
      return { mode: null, seen: true };
    default:
      return { mode: null, seen: false };
  }
}

// ── A pull request with no GitHub CLI or no sign-in ─────────────────────

/** Rust's `SHIP_NEEDS_GH_WORDS`: refused before anything was pushed. */
export const SHIP_NEEDS_GH_WORDS =
  "A pull request needs the GitHub command, and it isn't installed on this computer, so nothing was pushed.";
/** Rust's `SHIP_NEEDS_SIGN_IN_WORDS`. */
export const SHIP_NEEDS_SIGN_IN_WORDS =
  "A pull request needs a GitHub sign-in on this computer, and there is none for this project, so nothing was pushed.";
/** 1.174.1 P5 (T5): the two above as the card says them — "this Mac",
 *  which its error block draws through `machineWords`. The two above stay
 *  Rust's words: `shipNeedsGitHub` finds them in the refusal. */
export const SHIP_NEEDS_GH_SHOWN =
  "A pull request needs the GitHub command, and it isn't installed on this Mac, so nothing was pushed.";
export const SHIP_NEEDS_SIGN_IN_SHOWN =
  "A pull request needs a GitHub sign-in on this Mac, and there is none for this project, so nothing was pushed.";

/** Install the GitHub command: opens Setup's GitHub step. */
export const GH_INSTALL_ACTION = { id: "github-install", label: "Install the GitHub command", primary: true } as const;
/** The land on this Mac: the way on only where the project's GitHub address
 *  isn't a repository's (no other way on; 1.171.0 A3). */
export const SHIP_HERE_ACTION = { id: "ship-here", label: ONLY_HERE_LABEL } as const;

/** Rust's `SHIP_IT_UNREADABLE_TAIL` (G1 Challenger 8): Ship it refused on
 *  a GitHub address that isn't a repository's, with Only on this Mac
 *  as the way on. */
export const SHIP_IT_UNREADABLE_TAIL = "Nothing was pushed. To merge the card here instead, use Only on this Mac.";

/** Which of the refusals a ship's error is, or null. Read from where the
 *  backend's words start (a skill card's own reason may come first). */
export function shipNeedsGitHub(raw: string): "gh-missing" | "sign-in" | "unreadable" | null {
  if (raw.includes(SHIP_NEEDS_GH_WORDS)) return "gh-missing";
  if (raw.includes(SHIP_NEEDS_SIGN_IN_WORDS)) return "sign-in";
  if (raw.includes(SHIP_IT_UNREADABLE_TAIL)) return "unreadable";
  return null;
}

/** Whether a failed press is one of the ship presses (by id). */
export function isShipPress(action: string): action is ShipPress {
  return action === "ship-it" || action === "pr" || action === "pr-only" || action === "only-here";
}

// ── Settings › Shipping › How Ship it ships (1.173.0 G1) ─────────────────

export const SHIP_VIA_ROW_LABEL = "How Ship it ships";
export const SHIP_VIA_CHOICES: { value: ShipVia; label: string }[] = [
  { value: "github", label: "On GitHub" },
  { value: "local", label: ONLY_HERE_LABEL },
];

/** The row's choice: the workspace's, or GitHub (the default). */
export function shipViaChoice(shipVia: string | null | undefined): ShipVia {
  return shipVia === "local" ? "local" : "github";
}

/** The line under the row ("this Mac" is the caller's `machineWords`).
 *  `onGitHub` false: the project has no GitHub repository to ship to.
 *  1.174.0 (DS2, SL-5): on GitHub it says when the merge happens and how to
 *  keep it for yourself — the "Merge when checks pass" line it replaces; the
 *  section's mark says where the row is kept. */
export function shipViaHint(choice: ShipVia, onGitHub: boolean | null): string {
  if (onGitHub === false) return "This project isn't on GitHub, so Ship it merges the card on this Mac.";
  return choice === "local"
    ? "Ship it merges the card on this Mac only; GitHub doesn't have it. Kept on this Mac."
    : "Ship it opens a pull request on GitHub and merges it once GitHub's checks pass and the Reviewer approved. To merge it yourself, choose “pull request only” in Ship ▾.";
}
