/**
 * G7 (1.170.0): "Fix failing checks by itself" — follow the card's pull
 * request until its checks on GitHub pass. Pure: what the loop does next
 * for one card, from the card, its Builder session and where the loop is;
 * and every word it says. `prAutoFixStore.ts` drives it; `pr_auto_fix.rs`
 * keeps the record (the tries per head, where it stopped).
 *
 * Owner, 2026-10-26: opt-in (the card's switch, the workspace's default in
 * Settings, both off); only failed checks on GitHub — a reviewer's request
 * for changes and a conflict stay a press (Fix with the Builder); three
 * tries per pull request at most; it never answers a prompt in the
 * Builder's session and never starts when that session is closed or busy —
 * it says so. It never turns on auto-merge and never merges.
 *
 * One try: the failed logs go to the Builder (when it is at its prompt with
 * its turn over) → the Builder's turn ends → Finish and check → Verify
 * passes and the Challenger's review settles → Push update. The checks on
 * GitHub then run on the pushed commit; a new failure is the next try.
 */
import type { KanbanCard, PrAutoFixStop, PrAutoFixStopReason, PrStatus } from "../ipc.ts";
import { challengerRequestedChanges, challengerReviewing } from "./cardLifecycle.ts";
import { autoFixWaitingLine } from "./checksConsent.ts";

/** Owner, 2026-10-26 (`pr_auto_fix.rs::MAX_ATTEMPTS`). */
export const AUTO_FIX_MAX_ATTEMPTS = 3;
/** A Builder busy when the checks fail is given this long to come back to
 *  its prompt before the loop says it couldn't start. */
export const AUTO_FIX_BUSY_GRACE_MS = 2 * 60_000;
/** How long the Builder may work on one try. */
export const AUTO_FIX_WORK_MAX_MS = 60 * 60_000;
/** How long Finish and check (its self-check included) may take to save. */
export const AUTO_FIX_FINISH_MAX_MS = 20 * 60_000;
/** How long Verify and the Challenger may take on the saved fix. */
export const AUTO_FIX_CHECK_MAX_MS = 60 * 60_000;
/** A saved fix with no checks running on it this long after the save goes
 *  to Push update (a project with no checks set up). */
export const AUTO_FIX_NO_VERIFY_MS = 30_000;
/** The Builder's turn must end at least this long after the fix went in. */
const TURN_SETTLE_MS = 1_000;
/** Walk 7: how long the Builder's turn must stay over before Finish and
 *  check runs — a moment between two of Codex's steps looks like the end. */
export const AUTO_FIX_TURN_QUIET_MS = 5_000;
/** G7 fixes (Minor 2): no turn started this long after the paste, with
 *  the composer not idle (the paste sits there, its Enter lost — Codex on
 *  Windows): it didn't reach the Builder. */
export const AUTO_FIX_DELIVER_MS = 2 * 60_000;
/** G7 fixes (Minor 1): Verify passed and no review of the fix started this
 *  long after the save: the Challenger couldn't review it. */
export const AUTO_FIX_REVIEW_START_MS = 2 * 60_000;

/** The card's own words. */
export const AUTO_FIX_SWITCH_LABEL = "Fix failing checks by itself";
export const AUTO_FIX_SWITCH_HINT =
  "When checks fail on GitHub, the Builder gets the failed logs, then Plyloft runs Finish and check and pushes the fix — up to 3 tries. Only while the Builder's session is open and waiting at its prompt; it never answers its questions. Reviews and conflicts stay yours.";
/** 1.175.0 F10 (I11): the switch's row under the card's Change…, today's
 *  words shortened (mockup card-page.html §4). */
export const AUTO_FIX_PICK_HINT =
  "When checks fail on GitHub, the Builder gets the failed logs, then Plyloft runs Finish and check and pushes the fix, up to 3 tries. Reviews and conflicts stay yours.";
/** Settings › Board and worktrees. */
export const AUTO_FIX_DEFAULT_LABEL = AUTO_FIX_SWITCH_LABEL;
export const AUTO_FIX_DEFAULT_HINT =
  "The default for this project's cards, for checks that fail from the moment you turn it on; each card can turn it on or off. When checks fail on GitHub, the card's open Builder session gets the failed logs, then Plyloft runs Finish and check and pushes the fix — up to 3 tries. It never merges and never answers the Builder's questions.";

export type AutoFixCard = Pick<
  KanbanCard,
  | "id"
  | "workspaceId"
  | "archived"
  | "pr"
  | "prUrl"
  | "shipStatus"
  | "prReview"
  | "checksHold"
  | "prAutoFix"
  | "builder"
  | "worktreePath"
  | "verifyStatus"
  | "verifyHistory"
>;

/** The card follows its pull request: its own switch, else the
 *  workspace's default. Never a card that reviews someone's pull request.
 *  `defaultSince`: since when the workspace's default is on (null: off) —
 *  G7 fixes (Minor 5): it covers only failures first seen after that
 *  (`PrStatus.failingSince`); an older failure is the card's own switch's.
 *  Mirrors `pr_auto_fix.rs::enabled`. */
export function autoFixOn(
  card: Pick<KanbanCard, "prReview" | "prAutoFix"> & { pr?: PrStatus | null },
  defaultSince: number | null,
): boolean {
  if (card.prReview) return false;
  if (card.prAutoFix != null) return card.prAutoFix;
  if (defaultSince == null) return false;
  if (card.pr?.checks === "failing") return card.pr.failingSince != null && card.pr.failingSince >= defaultSince;
  return true;
}

/** The workspace's default as `autoFixOn` takes it: since when it is on,
 *  null while off; on in a file from before the time was kept: 0 (every
 *  failure). Mirrors `WorkspaceStore::fix_failing_checks_since`. */
export function autoFixDefaultSince(
  ws: { fixFailingChecks?: boolean; fixFailingChecksSince?: number | null } | null | undefined,
): number | null {
  return ws?.fixFailingChecks ? ws.fixFailingChecksSince ?? 0 : null;
}

/** G7 fixes (M1): a stop recorded before a try was counted for its head —
 *  the session closed, busy, asking or not shown, the plan said no. It
 *  clears on its own once that clears (the next try replaces it). Never the
 *  tries running out. Mirrors `pr_auto_fix.rs::soft_stop`. */
export function autoFixSoftStop(
  record: { heads?: string[] } | null | undefined,
  stop: Pick<PrAutoFixStop, "reason" | "head">,
): boolean {
  return stop.reason !== "exhausted" && !(record?.heads ?? []).includes(stop.head);
}

/** The head with failed checks for the loop: open, read, failed on the
 *  head it has now (not the head before a push), no conflict. Mirrors
 *  `pr_auto_fix.rs::failing_head`. */
export function autoFixFailingHead(pr: PrStatus | null | undefined): string | null {
  if (!pr || pr.state !== "open" || pr.checks !== "failing" || pr.mergeable === "conflicting") return null;
  if (pr.awaitingChecks || pr.checkedAt == null) return null;
  return pr.headSha || null;
}

/** The tries so far on this pull request. */
export function autoFixTries(pr: PrStatus | null | undefined): number {
  return pr?.autoFix?.heads?.length ?? 0;
}

/** Where it stopped, while the pull request is still at that head. Mirrors
 *  `pr_auto_fix.rs::stopped_now`. */
export function autoFixStoppedNow(pr: PrStatus | null | undefined): { reason: string; detail: string | null } | null {
  const stop = pr?.autoFix?.stopped;
  if (!pr || pr.state !== "open" || !stop || pr.headSha !== stop.head) return null;
  // A stop from before a try shows only while that head still fails.
  if (autoFixSoftStop(pr.autoFix, stop) && autoFixFailingHead(pr) !== stop.head) return null;
  return { reason: stop.reason, detail: stop.detail ?? null };
}

/** What the Builder's session looks like now, from its terminal. */
export type AutoFixSession = {
  /** The card's session is attached to its terminal in this window. */
  attached: boolean;
  /** G7 fixes (M1): not attached, but the card's session is live in
   *  Plyloft (its card isn't shown, so its terminal can't be read). */
  live: boolean;
  /** At its prompt, nothing typed. */
  promptIdle: boolean;
  /** Its turn is over (no turn running, no question in view). */
  turnIdle: boolean;
  /** When the turn last came to an end. */
  turnIdleAt: number | null;
  /** A question, a permission or trust prompt, a usage limit: Plyloft
   *  never answers it. */
  asking: boolean;
  /** Plyloft messages still held for the prompt, or the person's `!`/`/`
   *  draft in it. */
  held: boolean;
};

/** Where one try is (in memory; after a relaunch the record keeps the
 *  head tried, so it isn't tried again, and the card's own presses stay). */
export type AutoFixPhase =
  | { step: "sending"; head: string; attempt: number; at: number }
  | {
      step: "working";
      head: string;
      attempt: number;
      at: number;
      snapshots: number;
      /** G7 fixes (Minor 2): a turn was seen under way after the paste. */
      turnStarted?: boolean;
    }
  | { step: "finishing"; head: string; attempt: number; at: number; snapshots: number }
  | { step: "checking"; head: string; attempt: number; at: number; snapshotN: number; snapshotAt: number }
  | { step: "pushing"; head: string; attempt: number; at: number }
  | { step: "pushed"; head: string; attempt: number; at: number };

export type AutoFixAction =
  | { do: "wait" }
  /** Note that the session was busy from now (the grace starts). */
  | { do: "note-busy" }
  /** Count a try for `head`, then send the failed logs. */
  | { do: "begin"; head: string }
  | { do: "finish" }
  /** G7 fixes (Minor 2): the Builder's turn started after the paste. */
  | { do: "note-turn" }
  /** 1.175.0 B2: the fix is saved and its checks wait for this computer's
   *  OK (`card.checksHold`): no try is spent and the wait has no time limit;
   *  the check step's clock starts again from now. */
  | { do: "hold" }
  | { do: "push" }
  | { do: "stop"; head: string; reason: PrAutoFixStopReason }
  /** Forget the try in memory (GitHub moved on, the switch went off, the
   *  pull request closed or merged). Writes nothing. */
  | { do: "forget" };

export type AutoFixInput = {
  card: AutoFixCard;
  /** Since when the workspace's default is on (null: off). */
  workspaceDefault: number | null;
  session: AutoFixSession;
  phase: AutoFixPhase | null;
  /** When the session was first seen busy for the failing head. */
  busySince: number | null;
  now: number;
};

function snapshotsOf(card: AutoFixCard): { n: number; sha: string; at: number }[] {
  return card.builder?.snapshots ?? [];
}

/** A snapshot the pull request doesn't have yet (what Push update would
 *  send) — the person's round, not the loop's to start on. */
function unpushedRound(card: AutoFixCard): boolean {
  const snaps = snapshotsOf(card);
  const last = snaps[snaps.length - 1];
  const pr = card.pr;
  if (!last || !pr) return false;
  const pushed = pr.pushedHead ?? "";
  return last.sha !== pr.headSha && !(pushed && (pushed.startsWith(last.sha) || last.sha.startsWith(pushed)));
}

/** Verify on the saved fix: passed (or nothing to run), failed, or still to come. */
function verifyOn(card: AutoFixCard, snapshotAt: number, now: number): "passed" | "failed" | "waiting" {
  const history = card.verifyHistory ?? [];
  const latest = [...history].reverse().find((e) => e.endedAt >= snapshotAt);
  const running = card.verifyStatus === "queued" || card.verifyStatus === "running";
  if (latest && !running) {
    if (latest.status === "failed") return "failed";
    if (latest.status === "passed" || latest.status === "skipped") return "passed";
  }
  if (!running && (card.verifyStatus === "none" || card.verifyStatus === "skipped" || card.verifyStatus == null)) {
    // A project with no checks set up runs none: the push gate decides.
    return now - snapshotAt >= AUTO_FIX_NO_VERIFY_MS ? "passed" : "waiting";
  }
  return "waiting";
}

/**
 * What the loop does next for one card. One action at a time: the driver
 * runs it, records what came of it, and asks again.
 */
export function autoFixNext(input: AutoFixInput): AutoFixAction {
  const { card, session, phase, now } = input;
  const pr = card.pr;
  const open = pr?.state === "open" && Boolean(card.prUrl) && card.shipStatus !== "shipped" && !card.archived;
  if (!open || !autoFixOn(card, input.workspaceDefault)) return phase ? { do: "forget" } : { do: "wait" };

  if (!phase) {
    const head = autoFixFailingHead(pr);
    if (!head || !card.builder || !card.worktreePath) return { do: "wait" };
    const record = pr!.autoFix;
    const stop = record?.stopped?.head === head ? record.stopped : null;
    const tried = record?.heads?.includes(head) ?? false;
    // A stop after a try (or the tries running out) stands on this head.
    if (stop && !autoFixSoftStop(record, stop)) return { do: "wait" };
    // A round the pull request doesn't have yet is the person's (Push update).
    if (unpushedRound(card)) return { do: "wait" };
    // A try counted for this head, and nothing in this window follows it
    // (Plyloft closed between the count and the paste, or mid-try): say so.
    if (tried) return { do: "stop", head, reason: "not_delivered" };
    // Out of tries: counted (and said) by the record, before any session check.
    if (autoFixTries(pr) >= AUTO_FIX_MAX_ATTEMPTS) return { do: "begin", head };
    // G7 fixes (M1): a stop before a try clears on its own — said once,
    // and the try starts once the session is ready.
    const said = stop?.reason ?? null;
    const say = (reason: PrAutoFixStopReason): AutoFixAction =>
      said === reason ? { do: "wait" } : { do: "stop", head, reason };
    if (!session.attached) return say(session.live ? "not_shown" : "session_closed");
    if (session.asking) return say("question");
    if (!session.promptIdle || !session.turnIdle || session.held) {
      if (said === "session_busy") return { do: "wait" };
      if (input.busySince == null) return { do: "note-busy" };
      return now - input.busySince >= AUTO_FIX_BUSY_GRACE_MS ? { do: "stop", head, reason: "session_busy" } : { do: "wait" };
    }
    return { do: "begin", head };
  }

  // GitHub has another head (someone pushed, or the loop's push landed).
  if (pr!.headSha !== phase.head) return { do: "forget" };

  switch (phase.step) {
    case "sending":
    case "pushing":
      // The driver is in the middle of it.
      return { do: "wait" };
    case "working": {
      const timedOut = now - phase.at >= AUTO_FIX_WORK_MAX_MS;
      if (!session.attached) {
        // G7 fixes (M1): its card isn't shown — followed again once it is.
        if (session.live) return timedOut ? { do: "stop", head: phase.head, reason: "timed_out" } : { do: "wait" };
        return { do: "stop", head: phase.head, reason: "session_closed" };
      }
      if (session.asking) return { do: "stop", head: phase.head, reason: "question" };
      const endedSince = session.turnIdleAt != null && session.turnIdleAt >= phase.at + TURN_SETTLE_MS;
      const quiet = session.turnIdleAt != null && now - session.turnIdleAt >= AUTO_FIX_TURN_QUIET_MS;
      const over = session.promptIdle && session.turnIdle && !session.held && endedSince && quiet;
      if (over) return { do: "finish" };
      if (!phase.turnStarted) {
        if (!session.turnIdle || endedSince) return { do: "note-turn" };
        // G7 fixes (Minor 2): the paste sits in the composer, never sent.
        if (!session.promptIdle && now - phase.at >= AUTO_FIX_DELIVER_MS) {
          return { do: "stop", head: phase.head, reason: "not_delivered" };
        }
      }
      return timedOut ? { do: "stop", head: phase.head, reason: "timed_out" } : { do: "wait" };
    }
    case "finishing": {
      // The self-check runs in the session: a question there stops it too.
      if (session.attached && session.asking) return { do: "stop", head: phase.head, reason: "question" };
      return now - phase.at >= AUTO_FIX_FINISH_MAX_MS ? { do: "stop", head: phase.head, reason: "timed_out" } : { do: "wait" };
    }
    case "checking": {
      if (challengerRequestedChanges(card.builder)) return { do: "stop", head: phase.head, reason: "changes_requested" };
      // 1.175.0 B2: nothing ran, so nothing failed and nothing timed out.
      if (card.checksHold) return { do: "hold" };
      const verify = verifyOn(card, phase.snapshotAt, now);
      if (verify === "failed") return { do: "stop", head: phase.head, reason: "verify_failed" };
      const reviewing = challengerReviewing(card.builder) || Boolean(card.builder?.waitingReview);
      if (verify === "passed" && !reviewing) {
        // G7 fixes (Minor 1): only a fix the Challenger approved, or whose
        // review the person chose to skip, is pushed.
        const review = card.builder?.review;
        if (review && review.snapshotN === phase.snapshotN) {
          if ((review.status === "done" && review.verdict === "approve") || review.status === "skipped") {
            return { do: "push" };
          }
          return { do: "stop", head: phase.head, reason: "review_failed" };
        }
        if (now - phase.at >= AUTO_FIX_REVIEW_START_MS) return { do: "stop", head: phase.head, reason: "review_failed" };
        return { do: "wait" };
      }
      return now - phase.at >= AUTO_FIX_CHECK_MAX_MS ? { do: "stop", head: phase.head, reason: "timed_out" } : { do: "wait" };
    }
    case "pushed":
      // Until GitHub shows the pushed commit as the head (then: forget).
      return { do: "wait" };
  }
}

/** The phase once Finish and check saved a new snapshot (null: not yet). */
export function autoFixSaved(
  phase: AutoFixPhase,
  card: Pick<KanbanCard, "builder">,
  now: number,
): AutoFixPhase | null {
  if (phase.step !== "finishing") return null;
  const snaps = card.builder?.snapshots ?? [];
  if (snaps.length <= phase.snapshots) return null;
  const last = snaps[snaps.length - 1];
  return { step: "checking", head: phase.head, attempt: phase.attempt, at: now, snapshotN: last.n, snapshotAt: last.at };
}

/** The card's line while a try runs (the pull request block). `waitsForOk`
 *  (1.175.0 B2): the fix's checks wait for this computer's OK. */
export function autoFixRunningLine(phase: AutoFixPhase, waitsForOk = false): string {
  const tryWords = `try ${phase.attempt} of ${AUTO_FIX_MAX_ATTEMPTS}`;
  if (waitsForOk && (phase.step === "finishing" || phase.step === "checking")) {
    return autoFixWaitingLine(phase.attempt, AUTO_FIX_MAX_ATTEMPTS);
  }
  switch (phase.step) {
    case "sending":
      return `Fixing the failed checks by itself (${tryWords}): sending the failed logs to the Builder.`;
    case "working":
      return `Fixing the failed checks by itself (${tryWords}): the Builder is working on it.`;
    case "finishing":
    case "checking":
      return `Fixing the failed checks by itself (${tryWords}): checking the fix (Finish and check).`;
    case "pushing":
      return `Fixing the failed checks by itself (${tryWords}): pushing the fix.`;
    case "pushed":
      return `Fixing the failed checks by itself (${tryWords}): pushed; checks on GitHub run on it again.`;
  }
}

/** G7 fixes (M1): the card's line and the Inbox row while its Builder is
 *  live but its card isn't shown (a wait, not a stop). */
export const AUTO_FIX_NOT_SHOWN_WORDS = "Open the card so Plyloft can follow its Builder";

/** Why it stopped, in words — the card's line and the Inbox row. */
export function autoFixStoppedWords(reason: string): string {
  const couldnt = "Couldn't fix the checks by itself";
  switch (reason) {
    case "exhausted":
      return `Stopped fixing checks after ${AUTO_FIX_MAX_ATTEMPTS} tries`;
    case "session_closed":
      return `${couldnt}: the Builder session is closed`;
    case "session_busy":
      return `${couldnt}: the Builder was busy with something else`;
    case "question":
      return `${couldnt}: the Builder asks you something`;
    case "gather_failed":
      return `${couldnt}: Plyloft couldn't read what failed on GitHub`;
    case "not_delivered":
      return `${couldnt}: the failed logs didn't reach the Builder`;
    case "no_change":
      return `${couldnt}: the Builder didn't change anything`;
    case "finish_failed":
      return `${couldnt}: Finish and check didn't go through`;
    case "verify_failed":
      return `${couldnt}: the fix failed this computer's checks`;
    case "changes_requested":
      return `${couldnt}: the Reviewer asked for changes to the fix`;
    case "push_refused":
      return `${couldnt}: the fix wasn't pushed`;
    case "timed_out":
      return `${couldnt}: it took too long`;
    case "not_shown":
      return AUTO_FIX_NOT_SHOWN_WORDS;
    case "plan_required":
      return `${couldnt}: your plan doesn't include it`;
    case "team_account_mismatch":
      return `${couldnt}: you're signed in with another account than your Team plan's`;
    case "licence":
      return `${couldnt}: Plyloft couldn't check your plan`;
    case "network":
      return `${couldnt}: Plyloft couldn't connect to check your plan`;
    case "review_failed":
      return `${couldnt}: the Reviewer couldn't review the fix`;
    default:
      return `${couldnt}`;
  }
}
