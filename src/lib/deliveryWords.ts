// 1.171.0 A1 (PLAN §3 Block A, §9; REPORT T12): the words for where a card's
// change is and how it ships, written once so Blocks B and C import them
// instead of each pinning its own copy. Every line passes ux-check's JARGON
// (`deliveryWords.test.ts`).
//
// CALLERS: every line here that says "this Mac" is kept as the Mac text,
// like `ONLY_HERE_LABEL` in shipVia.ts, and MUST be wrapped in
// `machineWords(…)` (src/lib/platform.ts) where it is shown, so Windows reads
// "this PC". `MACHINE_WORDED` lists the fixed ones; the functions that say
// "this Mac" (`shippedOnlyHereHelper`) are named in their comment. Pure: node
// runs `deliveryWords.test.ts`.

import { targetName } from "./worktreeBase.ts";

// ── Where the change is ─────────────────────────────────────────────────

/** The change is on this computer only, not shipped yet. */
export const ON_THIS_MACHINE = "On this Mac";
/** Its pull request is open and its checks are running. */
export const ON_GITHUB_WAITING = "On GitHub · waiting for checks";
/** Its pull request merges by itself (GitHub's auto-merge). */
export const ON_GITHUB_MERGES_BY_ITSELF = "On GitHub · merges when checks pass";
/** The merge is Plyloft's own (`PrStatus.plyloftAutoMerge`) and the app is
 *  open: shown while it runs (Board column Working, owner D6). It merges
 *  only while the app is open. */
export const PLYLOFT_MERGES_WHILE_OPEN = "Plyloft merges it while it's open on this Mac";
/** The merge is Plyloft's own and the app was closed while it was due:
 *  shown with On hold (owner D6), e.g. on the card when Plyloft starts
 *  again or in the quit warning. */
export const PLYLOFT_MERGES_WHEN_OPEN = "merges when Plyloft is open";
/** Shipped, and on GitHub. */
export const SHIPPED_ON_GITHUB = "Shipped · on GitHub";
/** Shipped on this computer only: not on GitHub. */
export const SHIPPED_ONLY_HERE = "Shipped · only on this Mac";
/** The helper under `SHIPPED_ONLY_HERE`, by the target's real name ("main on
 *  this Mac has it; GitHub doesn't."). Says "this Mac": wrap in machineWords. */
export function shippedOnlyHereHelper(target: string | null | undefined): string {
  const name = targetName(target);
  const lead = target?.trim() ? name : name.charAt(0).toUpperCase() + name.slice(1);
  return `${lead} on this Mac has it; GitHub doesn't.`;
}

/** Where a card's change is, for the path line (B1), the Board and toasts. */
export type DeliveryStage =
  | "onThisMachine"
  | "waitingForChecks"
  | "mergesByItself"
  | "plyloftMerges"
  | "plyloftMergesWhenOpen"
  | "shippedOnGitHub"
  | "shippedOnlyHere";

/** Each stage's word. Those naming this Mac: wrap in machineWords. */
export const DELIVERY_STAGE_WORDS: Readonly<Record<DeliveryStage, string>> = {
  onThisMachine: ON_THIS_MACHINE,
  waitingForChecks: ON_GITHUB_WAITING,
  mergesByItself: ON_GITHUB_MERGES_BY_ITSELF,
  plyloftMerges: PLYLOFT_MERGES_WHILE_OPEN,
  plyloftMergesWhenOpen: PLYLOFT_MERGES_WHEN_OPEN,
  shippedOnGitHub: SHIPPED_ON_GITHUB,
  shippedOnlyHere: SHIPPED_ONLY_HERE,
};

// ── Before and after Ship it (B2) ───────────────────────────────────────

/** 1.171.0 B2 (DL-04, CP-7): what Ship it will do, said on a card Ready to
 *  ship before it is pressed — by where it goes and the target's real name.
 *  The one on this computer says "this Mac": wrap in machineWords. */
export function shipItSentence(toGitHub: boolean, target: string | null | undefined): string {
  const name = targetName(target);
  return toGitHub
    ? `Ship it puts it on GitHub as a pull request and merges it with ${name} once GitHub's checks pass.`
    : `Ship it adds it to ${name} on this Mac; GitHub doesn't get it.`;
}

/** 1.171.0 C3 walk fix (owner 2026-10-27): what the primary does on a card
 *  Ready to ship whose review was skipped (or is missing) — it opens the
 *  pull request and never merges by itself (`SHIP_ANYWAY_LABEL`). */
export function shipAnywaySentence(target: string | null | undefined): string {
  return `It goes to GitHub as a pull request that doesn't merge by itself: you merge it with ${targetName(target)} when it's ready, here or on GitHub.`;
}

/** 1.172.0 B3 (B2 Challenger leftover): who merges a pull request Ship
 *  just opened — GitHub by itself (its auto-merge on), Plyloft itself only
 *  while it's open (`PrStatus.plyloftAutoMerge`: the base branch requires
 *  no checks), or the person (asked for none, or GitHub refused it). */
export type PrMerger = "github" | "plyloft" | "you";

/** The merger of a pull request Ship just opened: `wanted` — the press
 *  asked for it to merge by itself (Ship it, or the pull request with
 *  "Merge when checks pass"); `pr` — the card's record as Ship left it.
 *  A record that says nothing yet keeps what the press asked for. */
export function prOpenedMerger(
  wanted: boolean,
  pr: { autoMerge?: boolean; plyloftAutoMerge?: boolean; autoMergeRefused?: string | null } | null | undefined,
): PrMerger {
  if (!wanted) return "you";
  if (pr?.plyloftAutoMerge) return "plyloft";
  if (pr?.autoMerge) return "github";
  if (pr?.autoMergeRefused) return "you";
  return "github";
}

/** 1.171.0 B2 (DL-06): the toast once Ship opened the pull request — where
 *  it is and who merges it, never the bare link (it is under Open on
 *  GitHub). 1.172.0 B3: who merges it is the true one (`prOpenedMerger`);
 *  Plyloft's own merge says "this Mac" (the toast store draws it through
 *  `machineWords`). */
export function prOpenedToastLine(prUrl: string | null | undefined, merger: PrMerger): string {
  const number = prUrl ? /\/pull\/(\d+)/.exec(prUrl)?.[1] : undefined;
  const which = number ? `pull request #${number}` : "its pull request";
  switch (merger) {
    case "github":
      return `On GitHub: ${which} · it merges by itself once GitHub's checks pass. You can keep working.`;
    case "plyloft":
      return `On GitHub: ${which} · Plyloft merges it once GitHub's checks pass, while it's open on this Mac. You can keep working.`;
    default:
      return `On GitHub: ${which} · you merge it when it's ready, here or on GitHub. You can keep working.`;
  }
}

/** 1.171.0 B2 (DL-37): the toast when Plyloft closes a done card's Builder
 *  session (with Undo), naming the card: its pull request merged, or it
 *  shipped on this computer. */
export function sessionClosedLine(cardTitle: string, why: "merged" | "shipped"): string {
  return `“${cardTitle}” ${why === "merged" ? "is merged" : "shipped"}, so its Builder session was closed.`;
}

/** 1.171.0 B2 (DL-07, FR-20): on a card shipped on GitHub — Plyloft doesn't
 *  know how the project goes live, and says so plainly. */
export function liveSentence(target: string | null | undefined): string {
  const name = targetName(target);
  // "your main branch" once, then "it": never the stand-in twice.
  return `It's in ${name} on GitHub. If your site deploys from ${target?.trim() ? name : "it"}, it's on its way live.`;
}

/** 1.171.0 B2 (K4): said where Plyloft is quitting while pull requests wait
 *  for Plyloft's own merge (`plyloftAutoMerge`): it never holds the quit
 *  back. Null when none wait. */
export function quitMergeNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 pull request waits for Plyloft to merge it. It merges when Plyloft is open again."
    : `${count} pull requests wait for Plyloft to merge them. They merge when Plyloft is open again.`;
}

/** The Windows close sheet's form of `quitMergeNote`, said as what a quit
 *  would leave (Challenger 4): its Quit is one of two choices. */
export function ifYouQuitMergeNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "If you quit, 1 pull request waits for Plyloft to merge it when it's open again."
    : `If you quit, ${count} pull requests wait for Plyloft to merge them when it's open again.`;
}

// ── Ship ▾ (B3) ─────────────────────────────────────────────────────────

/** The default choice where the project is on GitHub. */
export const SHIP_CHOICE_AUTO_MERGE = "On GitHub, merge when checks pass";
/** A pull request the person merges. */
export const SHIP_CHOICE_PR_ONLY = "On GitHub, pull request only (I merge it)";
/** A land on this computer. Same words as shipVia's `ONLY_HERE_LABEL`. */
export const SHIP_CHOICE_ONLY_HERE = "Only on this Mac";
/** Ship anyway, where Ship it goes to GitHub. */
export const SHIP_ANYWAY_LABEL = "Open the pull request anyway (I merge it)";
/** Ship with follow-up, beside the findings. */
export const SHIP_WITH_FOLLOW_UP_LABEL = "Ship now, fix these in a new card";

// ── The pull request ────────────────────────────────────────────────────

/** Replaces "Push update": sends the card's verified fix to its pull request. */
export const SEND_FIXES_LABEL = "Send the fixes to GitHub";
/** 1.171.0 B3 (CP-17, DL-18): the line beside Send the fixes to GitHub, on
 *  both card kinds — no "round" (the Activity keeps it). Says "this Mac":
 *  wrap in machineWords. */
export function sendFixesLine(prNumber: number): string {
  return `Your latest fixes are only on this Mac. Send them to pull request #${prNumber} so GitHub checks them again.`;
}
/** Someone else's commits are on the pull request's branch. */
export const SOMEONE_ELSE_CHANGED = "Someone else changed it on GitHub";
/** The pull request can be merged. */
export const READY_TO_MERGE = "Ready to merge";

/** The pull request conflicts with the card's target, by its real name
 *  ("Clashes with main"; "your main branch" when it isn't known). */
export function clashesWithLabel(target: string | null | undefined): string {
  return `Clashes with ${targetName(target)}`;
}

// ── Session words (C2) ──────────────────────────────────────────────────

/** The words an AI session is in — on the card, its session's header, the
 *  Terminals tiles and rows, the Board and the Inbox — plus the fifth,
 *  Paused (`pausedLabel`). Nothing else names a session's state (C2, CF8:
 *  "building", "Builder stopped", "Needs your answer", "Maybe waiting for
 *  you", "Ready" and "Work saved" are retired). */
export const SESSION_WORDS = {
  working: "Working",
  asks: "Asks you something",
  yourTurn: "Your turn",
  closed: "Closed",
} as const;
export type SessionWord = keyof typeof SESSION_WORDS;

/** The session stopped at the plan's usage limit (Claude Pro): `time` is
 *  when it resets, already formatted ("15:00"); unknown → "soon". */
export function pausedLabel(time?: string | null): string {
  return time?.trim()
    ? `Paused · your plan's limit resets at ${time.trim()}`
    : "Paused · your plan's limit resets soon";
}

/** Your turn's helper, by the AI's name ("Claude", "Codex"). */
export function yourTurnHelper(ai: string): string {
  return `${ai} says it's done. Check it, or tell it what's missing.`;
}

/** 1.174.3: Your turn's helper when a Resume shows the last turn was cut off
 *  (`BuilderRuntime.turnInterrupted`): "says it's done" would be false. */
export function interruptedTurnHelper(ai: string): string {
  return `${ai}'s last turn was interrupted. Tell it to carry on, or Finish and check what's there.`;
}

// ── Waits (C2) ──────────────────────────────────────────────────────────
//
// 1.171.0 C2 (CF3, CF16; owner D10: "Finish and check" stays, this line
// explains it): after Finish and check, Now's title is the card's state
// word with how long it has run ("Checking the work · 1m 20s") — never
// "Claude · building", which read as the press being ignored — and its
// sentence says what is happening and that the person can leave. The
// state word alone is what the live region and the Board say.

/** The leave line every wait after Finish and check ends with. */
export const LEAVE_LINE = "You can leave this; Plyloft tells you when it's done.";

/** The state word while the Builder re-reads its own work and Plyloft
 *  saves this version (the Board, the List, the Inbox, the live region). */
// 1.175.0 F9 (UX-8): "Checking the work" read as the checks running,
// which start after; the word says what the Builder does.
export const CHECKING_WORK_LABEL = "Re-reading its work";

/** What the self-check is doing — Now's title during it (`waitLine`):
 *  `delivered` once the checklist reached the AI; before, it is finishing
 *  what it was doing first. */
export function selfCheckWhat(ai: string, delivered: boolean): string {
  return delivered ? `${ai} is re-reading its work` : `${ai} re-reads its work once it's done with what it's doing`;
}

/** Now's sentence during the self-check: what comes next, as the title
 *  already says what is happening (F9, mockup words.html §1). The
 *  Reviewer isn't named: which AI reviews is known only once it starts. */
export function selfCheckWaitSentence(): string {
  return `Then your checks run and the Reviewer reviews it. ${LEAVE_LINE}`;
}

/** Now's sentence while Plyloft saves this version, between the
 *  self-check and the checks. */
export const SAVING_WAIT_SENTENCE = `Plyloft is saving this version, then runs your checks and the Reviewer reviews it. ${LEAVE_LINE}`;

/** 1.171.0 C3 walk fix: the same wait after "Check without the
 *  Reviewer" — no Challenger this time (`FINISH_WITHOUT_REVIEW_HINT`). */
/** Finish and check's title while that press runs (Challenger 4). */
export const FINISH_WITHOUT_REVIEW_TITLE = "Saves the Builder's work and runs your checks. The Reviewer doesn't review it this time.";
export const SAVING_WITHOUT_REVIEW_SENTENCE = `Plyloft is saving this version, then runs your checks. The Reviewer doesn't review it this time. ${LEAVE_LINE}`;
/** 1.171.0 re-walk (step 3): the checks' wait after that press says it too
 *  — the press is over by then, so the card's review record (skipped for
 *  this round) carries it. */
export const NO_REVIEW_THIS_TIME = "The Reviewer doesn't review it this time.";
export function checksRunningWithoutReviewSentence(running: string): string {
  return `${running} ${NO_REVIEW_THIS_TIME} ${LEAVE_LINE}`;
}

/** Now's sentence during the review, by the AIs' names; `checksToo` while
 *  the checks run beside it. */
export function reviewWaitSentence(reviewer: string, builder: string, checksToo: boolean): string {
  return `${reviewer} is reviewing ${builder}'s work without changing it${checksToo ? ", and your checks are running" : ""}. ${LEAVE_LINE}`;
}

/** 1.171.0 C2 ("Errori a metà flusso"): Finish and check's self-check
 *  stopped before it went on — Plyloft quit during it (`quit`), or the
 *  session ended. The card says what happened and offers Finish and check
 *  again, which saves the work as it is (no session: no re-read). */
export const CHECK_STOPPED_LABEL = "Finish and check stopped";
export function checkStoppedSentence(ai: string, quit: boolean): string {
  const what = quit
    ? `Plyloft closed while ${ai} was re-reading its work`
    : `${ai}'s session ended while it was re-reading its work`;
  return `${what}, so nothing was saved or checked yet. Finish and check again saves the work as it is, runs your checks and has it reviewed; Resume opens the session first if you want ${ai} to re-read it.`;
}

/** Now's title for a wait: the state word and how long it has run
 *  ("Checking the work · 1m 20s"); no time when it is not known. */
export function waitTitle(word: string, elapsedMs: number | null): string {
  if (elapsedMs == null || elapsedMs < 1000) return word;
  const total = Math.floor(elapsedMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const time = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  return `${word} · ${time}`;
}

// ── The fix round (C1) ──────────────────────────────────────────────────
//
// 1.171.0 C1 (CF1): a Builder working on what it was sent back — the
// Challenger's findings, or the person's Not right — is at work, like a
// running build; once its turn is over, Now's press is Finish and check
// again. By the AI's name ("Claude", "Codex").

/** While it works: `what` is how many findings it was sent (0: not known),
 *  or "changes" for the person's own (Not right). */
export function fixingHeadline(ai: string, what: number | "changes"): string {
  if (what === "changes") return `${ai} is working on your changes`;
  if (what <= 0) return `${ai} is fixing the findings`;
  return `${ai} is fixing ${what} finding${what === 1 ? "" : "s"}`;
}

/** The sentence under `fixingHeadline`. */
export function fixingSentence(ai: string): string {
  return `${ai} is working on them in its session. When it's done, Finish and check again tests the fixes and has them reviewed.`;
}

/** Its turn is over after the fixes. */
export function fixesDoneHeadline(ai: string): string {
  return `${ai} finished the fixes`;
}

// ── When the two AIs disagree (C3) ─────────────────────────────────────
//
// 1.171.0 C3 (CF2, CF18, CP-9): the one override — the Challenger's
// requested changes recorded as overridden by the person, the card on to
// Ready to ship, nothing committed — is named by the case it is pressed in.

/** The Builder had the findings and its turn is over (or it is still on
 *  them): it may disagree, and the person sides with it. By the AI's name. */
export function agreeWithBuilderLabel(ai: string): string {
  return `Agree with ${ai}, keep it as it is`;
}
/** Its title: what the press does. */
export function agreeWithBuilderTitle(ai: string): string {
  return `If ${ai} disagrees with the findings and you agree with ${ai}: nothing is changed, the card moves to Ready to ship and the record says you overrode the review. Nothing is shipped yet.`;
}
/** The findings never reached the Builder (or it isn't asked): the person
 *  ships the card as it is, over them. */
export const SHIP_WITHOUT_CHANGES_LABEL = "Ship without these changes";
export const SHIP_WITHOUT_CHANGES_TITLE =
  "You decide the findings don't matter. Nothing is changed: the card moves to Ready to ship and the record says you overrode the review. Nothing is shipped yet.";
/** The facts line, Activity and the result once it was pressed (either
 *  label): the person's decision, not a skipped review. Where who pressed
 *  it is known, `overriddenWord` says it. */
export const OVERRIDDEN_WORD = "Overridden by you";
/** Who overrode the review, as the person reading reads it (Challenger 6):
 *  "you" when the record names them (`overriddenBy` is the identity's
 *  email, `settings.identity.userEmail`) or names nobody, else the name it
 *  records — a teammate's. One helper for the facts line, Activity, Now,
 *  The result and the ship step. */
export function overriddenByWho(by: string | null | undefined, me: string | null | undefined): string {
  const who = by?.trim();
  const self = me?.trim();
  if (!who || (self && who.toLowerCase() === self.toLowerCase())) return "you";
  return who;
}
/** "Overridden by you", "Overridden by ana@example.com". */
export function overriddenWord(by: string | null | undefined, me: string | null | undefined): string {
  return `Overridden by ${overriddenByWho(by, me)}`;
}

/** The sentence under `fixesDoneHeadline`; the primary is Finish and check
 *  again (`FINISH_AGAIN_LABEL`). Its turn being over is not the work being
 *  right (Challenger C1-1): it says both ways on. `findings`: the
 *  Challenger's (the Agree press is offered); false: the person's own changes. */
export function fixesDoneSentence(ai: string, findings: boolean): string {
  return findings
    ? `${ai}'s turn is over. If it fixed them, Finish and check again tests the fixes and has them reviewed; if it disagrees with a finding and you side with it, press ${agreeWithBuilderLabel(ai)}.`
    : `${ai}'s turn is over. If it made them, Finish and check again tests the changes and has them reviewed; if something's missing, tell ${ai} in the session.`;
}

/** 1.171.0 C3 (CF18, CP-10): Finish and check's ▾ — the old "Skip review"
 *  toggle, one press. What it really does: the checks run; the Builder's
 *  self-check and the Challenger's review don't; and (owner 2026-10-27)
 *  the card is unreviewed like any other — `mergeReviewGap` /
 *  `builder.rs::unreviewed_ship_summary` — so its pull request never
 *  merges by itself and says the review was skipped. */
export const FINISH_WITHOUT_REVIEW_LABEL = "Check without the Reviewer";
/** U15: Finish and check on a card whose session is closed. */
export const FINISH_CLOSED_SESSION_HINT =
  "No session needed: it saves the card's copy as it is, runs any checks set up and has it reviewed.";
export const FINISH_WITHOUT_REVIEW_HINT =
  "Your checks still run; the Builder doesn't re-read its work and the Reviewer doesn't review it. Like any unreviewed change, it never merges by itself: you merge it yourself, with Merge on the card or on GitHub, and the pull request says the review was skipped.";

// ── One approval word (C3) ──────────────────────────────────────────────
//
// 1.171.0 C3 (CF25, CP-9): an approving review is "Approved" everywhere —
// the card's facts, Activity, Now, the session's line, The result and a
// pull request card — with its small notes counted. A small note is a
// finding that doesn't block: it needs nothing done to ship.

export const APPROVED_WORD = "Approved";
/** "Approved", "Approved (1 small note)", "Approved (2 small notes)". */
export function approvedWord(notes: number): string {
  return notes > 0 ? `${APPROVED_WORD} (${smallNotesWords(notes)})` : APPROVED_WORD;
}
/** "1 small note", "2 small notes". */
export function smallNotesWords(notes: number): string {
  return `${notes} small note${notes === 1 ? "" : "s"}`;
}
/** The mark after a finding that doesn't block. */
export const SMALL_NOTE_MARK = "Small note · nothing to do";

// ── For the tests and the call sites ────────────────────────────────────

/** The words that name this computer: pass them through `machineWords`. */
export const MACHINE_WORDED: readonly string[] = [
  ON_THIS_MACHINE,
  PLYLOFT_MERGES_WHILE_OPEN,
  SHIPPED_ONLY_HERE,
  SHIP_CHOICE_ONLY_HERE,
];

/** Every fixed line above, for the JARGON test. */
export const ALL_DELIVERY_WORDS: readonly string[] = [
  FINISH_CLOSED_SESSION_HINT,
  ON_THIS_MACHINE,
  ON_GITHUB_WAITING,
  ON_GITHUB_MERGES_BY_ITSELF,
  PLYLOFT_MERGES_WHILE_OPEN,
  PLYLOFT_MERGES_WHEN_OPEN,
  SHIPPED_ON_GITHUB,
  SHIPPED_ONLY_HERE,
  SHIP_CHOICE_AUTO_MERGE,
  SHIP_CHOICE_PR_ONLY,
  SHIP_CHOICE_ONLY_HERE,
  SHIP_ANYWAY_LABEL,
  SHIP_WITH_FOLLOW_UP_LABEL,
  SEND_FIXES_LABEL,
  SOMEONE_ELSE_CHANGED,
  READY_TO_MERGE,
  SHIP_WITHOUT_CHANGES_LABEL,
  SHIP_WITHOUT_CHANGES_TITLE,
  OVERRIDDEN_WORD,
  FINISH_WITHOUT_REVIEW_LABEL,
  FINISH_WITHOUT_REVIEW_HINT,
  APPROVED_WORD,
  SMALL_NOTE_MARK,
  LEAVE_LINE,
  CHECKING_WORK_LABEL,
  SAVING_WAIT_SENTENCE,
  SAVING_WITHOUT_REVIEW_SENTENCE,
  FINISH_WITHOUT_REVIEW_TITLE,
  NO_REVIEW_THIS_TIME,
  checksRunningWithoutReviewSentence("Plyloft is running the checks."),
  shipAnywaySentence("main"),
  CHECK_STOPPED_LABEL,
  ...Object.values(SESSION_WORDS),
];
