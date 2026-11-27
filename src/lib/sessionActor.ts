// CL-7 (Clarity idea 4): who is working, said truly. The card's Now callout
// and the sidebar's session rows name the actor — "Claude · building · 4m",
// "Claude · needs your answer", "Codex · reviewing · 2m" — from what the app
// already knows about the live session: the Builder runtime the attached
// xterm keeps (last output, the prompt-box scan, the turn-over scan) and the
// card's own record (the review, the checks). Nothing here polls or reads a
// PTY. Plyloft's own phases (checks, shipping) have no vendor actor and keep
// their words. The Board does not use this: its tiles keep "Working · 6m".
//
// Pure — no React, no stores — so node runs it (`sessionActor.test.ts`).
import type { KanbanCard } from "../ipc.ts";
import { deriveTileAttention, type TileAttention } from "./attention.ts";
import { liveBuilderSessionState } from "./cardLifecycle.ts";
import { shortDuration } from "./boardSemantics.ts";
import { laneOf, laneStage, laneStageWords, laneVendorName, type LaneStage } from "./buildBoth.ts";
import { SESSION_WORDS } from "./deliveryWords.ts";

export type Vendor = "claude" | "codex";

/** What the attached xterm knows of a live session (`BuilderRuntime`). */
export type LiveSession = {
  ptyId: string;
  vendor: Vendor;
  startedAt: number;
  lastOutputAt?: number;
  promptBoxIdle?: boolean;
  /** The last scan found the turn over at an idle prompt. */
  turnIdle?: boolean;
  /** When `turnIdle` last turned true. */
  turnIdleAt?: number;
  /** CL-11: an approval in view (`BuilderRuntime.questionInView`). */
  questionInView?: boolean;
  /** SP-4 round 3: when the last settled prompt-box scan ran, cleared by
   *  the next output (`BuilderRuntime.lastSettledScanAt`). */
  lastSettledScanAt?: number;
  /** A settled scan found the turn over, and no scan or submit since says
   *  otherwise (`BuilderRuntime.turnIdleSettled`); output keeps it. */
  turnIdleSettled?: boolean;
  /** Resume started this session (`BuilderRuntime.resumedAt`). */
  resumedAt?: number;
};

/** The words and the dot beside them. `spoken` is the words without the
 *  clock — for an accessible name that must not change every minute. */
export type ActorWords = {
  words: string;
  spoken: string;
  dot: "running" | "done" | "aborted" | "empty";
  /** CL-11 (walk b): what the live session is doing, for the line under
   *  the title — so "Claude · waiting for you" never sits above "Claude is
   *  working". Absent where no live session is read (reviews, checks, a
   *  lane's stage words). */
  session?: ActorSession;
};

/** The live session's state behind an actor's words. */
export type ActorSession = "building" | "stopped" | "question" | "quiet" | "saved" | "resumed";

const NAME: Record<Vendor, string> = { claude: "Claude", codex: "Codex" };

const lower = (w: string): string => w.charAt(0).toLowerCase() + w.slice(1);

/** UX P1 point 3 (P-B): the session's state after its vendor's name, the
 *  Builder header's words in lower case. 1.171.0 C2 (CF8): the five
 *  session words ("Claude · working · 4m", "Claude · asks you something",
 *  "Claude · your turn"); a session gone quiet, or whose work Finish and
 *  check saved, is the person's turn too. */
export const ACTOR_WORDS = {
  working: lower(SESSION_WORDS.working),
  question: lower(SESSION_WORDS.asks),
  stopped: lower(SESSION_WORDS.yourTurn),
  quiet: lower(SESSION_WORDS.yourTurn),
  saved: lower(SESSION_WORDS.yourTurn),
} as const;

/** "4m", "2h" — nothing under a minute, so a turn just begun is "building". */
function clock(ms: number | null): string | null {
  if (ms == null || ms < 60_000) return null;
  return shortDuration(ms);
}

function said(
  parts: string[],
  dot: ActorWords["dot"],
  elapsed: string | null = null,
  session?: ActorSession,
): ActorWords {
  const spoken = parts.join(" · ");
  const words = { words: elapsed ? `${spoken} · ${elapsed}` : spoken, spoken, dot };
  return session ? { ...words, session } : words;
}

/** The live session's attention, the same rule as every tile and the
 *  Builder header (`deriveTileAttention`). */
export function liveAttention(live: LiveSession, now: number): TileAttention | null {
  return deriveTileAttention(
    {
      kind: live.vendor,
      status: "running",
      startedAt: live.startedAt,
      lastOutputAt: live.lastOutputAt,
      promptBoxIdle: live.promptBoxIdle,
      questionInView: live.questionInView,
    },
    now,
  );
}

/** Round 2 (F1): the session's output is the person typing at its prompt,
 *  or the tail of a turn that just ended — its turn over, nothing submitted
 *  since. The echo of keys (and a turn's last lines) refresh its last
 *  output, so its silence alone would say "building". An Enter (or a paste
 *  of Plyloft's) after the scan that found the turn over is a new turn
 *  until the next scan says otherwise.
 *
 *  SP-4: a settled scan (taken after the output's settle, and no output
 *  since) that found the turn over is the truth — "waiting for you" at once. Output that arrived after
 *  that scan is the person typing only when a key went in since the turn
 *  ended; otherwise it is the session's own work (Codex keeps its prompt
 *  box in view while it works, so a stale scan still reads idle) —
 *  building, never "waiting for you". */
export function typingAtPrompt(
  live: LiveSession,
  sentAt: number | null | undefined,
  submittedAt: number | null | undefined,
): boolean {
  if (live.turnIdle !== true || live.promptBoxIdle !== true) return false;
  const turnIdleAt = live.turnIdleAt ?? 0;
  if (submittedAt != null && submittedAt >= turnIdleAt) return false;
  // Only a settled scan counts (round 3): a max-wait scan mid-stream can
  // see Codex's composer while it streams an answer.
  const scanIsLatest = live.lastSettledScanAt != null && live.lastSettledScanAt >= (live.lastOutputAt ?? 0);
  if (scanIsLatest) return true;
  // SP-1 walk: Claude draws a prompt suggestion ("❯ Show me the final
  // diff", dim, not typed by anyone) into its input box a second or two
  // after its turn ends. That draw is output after the settled scan, with
  // no key sent: under the Codex rule below it read "Claude · building"
  // until the next settled scan. Claude never works with only its input
  // box in view — a running turn shows its spinner or "esc to interrupt",
  // which the next scan (at most the max wait away) reads as turnIdle
  // false — and a new turn starts from a submit, handled above. So for
  // Claude a SETTLED scan that found the turn over stands until a scan or
  // a submit says otherwise (Challenger: a max-wait scan of a half-redrawn
  // frame mid-stream never does). Codex keeps its composer in view while
  // it streams (SP-4): its output after the scan is its own work.
  if (live.vendor === "claude" && live.turnIdleSettled === true) return true;
  return sentAt != null && sentAt >= turnIdleAt;
}

/** 1.174.3: a resumed session draws its old conversation and sits at its
 *  prompt: `claude --resume` and `codex resume` start no turn on their own. So
 *  its output is no work until something went in since the Resume (keys, a
 *  paste of Plyloft's). The Now line read "working" for those seconds. It says
 *  nothing of how the last turn ended: a session lost mid-turn looks the same,
 *  so only a scan's turn-over leads to Finish and check. */
export function resumedWithoutTurn(
  live: { resumedAt?: number },
  sentAt: number | null | undefined,
  submittedAt: number | null | undefined,
): boolean {
  if (live.resumedAt == null) return false;
  return (sentAt ?? 0) < live.resumedAt && (submittedAt ?? 0) < live.resumedAt;
}

/** The session's own state in words, from its attention: busy is
 *  "building" with how long this turn has run (from the session's start or
 *  the last submit, whichever is later), at its prompt (a question, its
 *  turn over, or the person typing there) is "waiting for you", silent
 *  without a prompt in view is "quiet — may be waiting". */
function attentionWords(
  live: LiveSession,
  attention: TileAttention | null,
  startedAt: number,
  sentAt: number | null | undefined,
  submittedAt: number | null | undefined,
  now: number,
): ActorWords | null {
  const who = NAME[live.vendor];
  const turnIdle = live.turnIdle === true;
  switch (attention) {
    case "working":
      if (typingAtPrompt(live, sentAt, submittedAt)) return said([who, ACTOR_WORDS.stopped], "done", null, "stopped");
      // No scan has found its turn over, so it claims no finish ("resumed").
      if (resumedWithoutTurn(live, sentAt, submittedAt)) return said([who, ACTOR_WORDS.stopped], "done", null, "resumed");
      return said(
        [who, ACTOR_WORDS.working],
        "running",
        clock(now - Math.max(startedAt, submittedAt ?? 0)),
        "building",
      );
    case "asking-you":
      // At its prompt with its turn over is the Builder header's done dot;
      // a question is its amber one.
      return said([who, turnIdle ? ACTOR_WORDS.stopped : ACTOR_WORDS.question], turnIdle ? "done" : "aborted", null, turnIdle ? "stopped" : "question");
    case "wants-you":
      return said([who, ACTOR_WORDS.quiet], "aborted", null, "quiet");
    default:
      return null;
  }
}

/** The fields of a card the actor is read from (structural: a `KanbanCard`
 *  fits, and so does a test's literal). */
export type ActorCard = Pick<KanbanCard, "lastRunStatus"> &
  Partial<Pick<KanbanCard, "verifyStatus" | "buildBoth" | "worktreeSetup">> & {
    builder?:
      | (Pick<NonNullable<KanbanCard["builder"]>, "vendor" | "startedAt"> &
          Partial<Pick<NonNullable<KanbanCard["builder"]>, "ptyId" | "review" | "snapshots" | "lastReviewedRevision">>)
      | null;
  };

/**
 * Who is working on a card's single Builder session, in words — or null
 * when nothing can be said truly (no session, or one this window has not
 * attached and so cannot read).
 *
 * - A Challenger review running: "Codex · reviewing · 2m" (its start is
 *   the review's `at`). It outranks the Builder, which waits for it.
 * - Plyloft's checks: "Running checks" — no vendor actor.
 * - The live session: its state (`liveBuilderSessionState`, the Builder
 *   header's rule) with the vendor named — "Claude · building · 4m" while
 *   it works (the clock runs from the session's start or the last message
 *   submitted into it, whichever is later: this turn), "Claude · stopped" at
 *   its prompt, "Claude · needs your answer" on a question, "Claude · work
 *   saved" once Finish and check saved its work and nothing was sent since.
 */
export function cardActor(input: {
  card: ActorCard;
  /** The runtime attached to the card's `builder.ptyId`; null when none. */
  live: LiveSession | null;
  /** When work last went into the session, keys included (`useBuilder.sentAt`). */
  sentAt?: number | null;
  /** When a message was last submitted into it (`useBuilder.submittedAt`). */
  submittedAt?: number | null;
  /** When Build done last went through here (`useBuilder.doneAt`). */
  doneAt?: number | null;
  now: number;
}): ActorWords | null {
  const { card, now } = input;
  const builder = card.builder ?? null;
  const review = builder?.review ?? null;
  if (review?.status === "running") {
    return said([NAME[review.provider], "reviewing"], "running", clock(now - review.at));
  }
  if (card.verifyStatus === "queued" || card.verifyStatus === "running") {
    return said(["Running checks"], "running");
  }
  if (!builder?.ptyId) return null;
  const live = input.live && input.live.ptyId === builder.ptyId ? input.live : null;
  if (!live) return null;
  const attention = liveAttention(live, now);
  const state = liveBuilderSessionState(
    card as Pick<KanbanCard, "builder" | "lastRunStatus">,
    attention,
    input.sentAt ?? null,
    input.doneAt ?? null,
    live.turnIdle === true,
  );
  const who = NAME[builder.vendor];
  // P-A: on the state's id, never on its words (point 3 renames them).
  if (state.id === "saved") return said([who, ACTOR_WORDS.saved], "done", null, "saved");
  if (state.id === "stopped") return said([who, ACTOR_WORDS.stopped], "done", null, "stopped");
  return attentionWords(live, attention, builder.startedAt, input.sentAt, input.submittedAt, now);
}

/**
 * SL-6: one build of a card built by both, named by its vendor. A build
 * whose session works here reads as the session does ("Codex · building ·
 * 3m", "Claude · waiting for you"); so does a finished build whose session
 * was sent new work after its Build done and is working on it (round 2,
 * F2). Any other stage keeps its words ("Codex · done · checks passed",
 * "Claude · checks running").
 */
export function laneActor(input: {
  card: Pick<KanbanCard, "worktreeSetup" | "buildBoth">;
  lane: "a" | "b";
  live: LiveSession | null;
  sentAt?: number | null;
  submittedAt?: number | null;
  now: number;
}): ActorWords {
  const lane = laneOf(input.card.buildBoth, input.lane);
  const who = laneVendorName(lane, input.lane);
  const stage: LaneStage = laneStage(input.card, input.lane);
  const live = lane && input.live && input.live.ptyId === lane.ptyId ? input.live : null;
  if (lane && live) {
    const attention = liveAttention(live, input.now);
    const startedAt = lane.startedAt ?? live.startedAt;
    if (stage === "working") {
      const words = attentionWords(live, attention, startedAt, input.sentAt, input.submittedAt, input.now);
      if (words) return words;
    }
    // Done, then sent new work, and working on it: building again.
    const reopened = lane.done != null && input.sentAt != null && input.sentAt > lane.done.at;
    if (reopened && attention === "working") {
      const words = attentionWords(live, attention, Math.max(startedAt, lane.done!.at), input.sentAt, input.submittedAt, input.now);
      if (words && words.dot === "running") return words;
    }
  }
  const word = laneStageWords(stage);
  const lower = word.charAt(0).toLowerCase() + word.slice(1);
  const dot: ActorWords["dot"] =
    stage === "working" || stage === "checking" || stage === "setting-up"
      ? "running"
      : stage === "checks-failed" || stage === "setup-failed" || stage === "session-ended" || stage === "stopped"
        ? "aborted"
        : stage === "not-started"
          ? "empty"
          : "done";
  return said([who, lower], dot);
}

/** CL-11 (walk): an actor's state without its vendor, as a state word
 *  beside a line that already names the build — "Waiting for you",
 *  "Building · 4m", "Done · checks passed". */
export function actorStateWords(actor: ActorWords): string {
  const at = actor.words.indexOf(" · ");
  const rest = at < 0 ? actor.words : actor.words.slice(at + 3);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** SL-6 (CL-7): the Now callout's line while both build — each build named
 *  by its vendor with what its session is doing, in lane order: "Claude ·
 *  building · 4m. Codex · waiting for you." */
export function bothLanesActorWords(input: {
  card: Pick<KanbanCard, "worktreeSetup" | "buildBoth">;
  live: { a: LiveSession | null; b: LiveSession | null };
  sentAt?: { a?: number | null; b?: number | null };
  submittedAt?: { a?: number | null; b?: number | null };
  now: number;
}): string {
  const lanes = (["a", "b"] as const).map(
    (lane) =>
      laneActor({
        card: input.card,
        lane,
        live: input.live[lane],
        sentAt: input.sentAt?.[lane] ?? null,
        submittedAt: input.submittedAt?.[lane] ?? null,
        now: input.now,
      }).words,
  );
  return `${lanes.join(". ")}.`;
}
