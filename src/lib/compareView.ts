// 1.177.0 Compare: what the relay bar shows, from facts. Pure — no store,
// no Tauri, no clock (callers pass `now`) — so node tests it:
//
//     node --experimental-strip-types src/lib/compareView.test.ts
//
// The bar passes the last finished answer of a Claude Code tile to a Codex
// tile (or back). This file decides which side is offered, the line's words,
// the button and why it is off. Every guard before a write is here
// (`deliveryGate`): Plyloft never writes into a tile unless each one is
// positively known; unknown is a refusal with its reason, never a retry.
import type { CompareAnswer, CompareAsksUnknown, ComparePasteParts, CompareTurnAsks } from "./compareIpc.ts";
import { agoWords } from "./copyWords.ts";
import { plainForKeys } from "./builderInject.ts";
import { relativeTo, samePath } from "./paths.ts";
import {
  COMPARE_ASK_LEAD,
  COMPARE_CODEX_SEARCH_OPEN,
  COMPARE_NO_PAIR,
  COMPARE_NOTE_LABEL,
  COMPARE_NOTE_MAX,
  COMPARE_NOTHING_YET,
  ambiguousQuietWords,
  PLAN_UNREAD_WORDS,
  PLAN_WAITING_WORDS,
  conversationUnknownWords,
  earlierTurnWords,
  answeredWords,
  compareOtherVendor,
  fromLabelWords,
  passButtonWords,
  passCountWords,
  passedToWords,
  putInBoxWords,
  QUESTION_EDITED_WORDS,
  QUESTION_PLAN_FEEDBACK_WORDS,
  questionLabelWords,
  questionNotYoursWords,
  questionPassedOnlyWords,
  questionStartUnknownWords,
  sourceWorkingWords,
  targetAsksWords,
  targetDraftWords,
  targetEndedWords,
  targetUnknownWords,
  targetWorkingWords,
  tileClosedWords,
  otherPassOpenWords,
  pairTileClosedWords,
  type CompareAsk,
  type CompareVendor,
} from "./compareWords.ts";

/** What the store and the screen say about one Claude or Codex tile. `null`
 *  is "not known": it refuses, it never passes. */
export interface TileFacts {
  id: string;
  vendor: CompareVendor;
  /** The header's title. */
  label: string;
  /** Running, with a PTY. */
  live: boolean;
  /** Its process ended (done, error, killed, crashed). */
  ended: boolean;
  /** A question or permission waits on the member. */
  question: boolean | null;
  /** The member typed text into its box. */
  draft: boolean | null;
  /** The prompt box is drawn and idle (scanned). */
  promptIdle: boolean | null;
  /** A turn is running. */
  working: boolean | null;
  /** Codex's transcript search is drawn over its box. */
  overlay?: boolean;
  /** Codex only: its screen went back to the start screen after a turn was
   *  on it (`/new`) — the files can't say so before the first new message. */
  newConversation?: boolean;
  /** How long the tile has printed nothing (ms); null or absent: not known. */
  quietMs?: number | null;
  /** The box as the live screen reads it this instant (no store flag); absent
   *  when the screen wasn't read. */
  draftNow?: boolean | null;
  /** Claude: the live screen proves its last turn is over (absent when the
   *  screen wasn't read). */
  turnOverOnScreen?: boolean | null;
  /** 1.177.1: the live screen positively shows the CLI's idle box, ready for
   *  text (`tileScreen.boxProof`); absent: the screen wasn't read — no proof. */
  readyBox?: boolean | null;
  /** 1.177.1: the live screen's bottom is the CLI's box (false: something
   *  else is drawn there, a menu Plyloft doesn't know included). */
  boxDrawn?: boolean | null;
  /** Round 3 (M2), Codex: its box and idle footer, nothing running, no prompt
   *  just asked above it (`BoxProof.idleShape`). */
  boxIdle?: boolean | null;
  /** Round 5, Codex: `BoxProof.askedShape` (a prompt row is the last thing at
   *  the first column above the box). */
  boxAsked?: boolean | null;
  /** How long ago the member last typed into the tile (ms; Infinity: never;
   *  absent or null: not read). */
  inputQuietMs?: number | null;
  /** Round 9, Claude: its box and mode line, nothing running on screen
   *  (`BoxProof.boxMode`), whatever sits above the box. */
  boxMode?: boolean | null;
  /** Round 7: the tile printed nothing since the member's last keys — their
   *  echo may not be drawn yet. */
  echoPending?: boolean | null;
}

/** Round 7 (final walk 2, step 8b): keys typed into the target this recently
 *  may not be drawn yet (the CLI's echo, xterm's parse): no write until they
 *  are, so a paste never lands behind them. */
export const INPUT_SETTLE_MS = 1_000;
/** …and while nothing at all was printed since those keys, up to this long. */
export const ECHO_WAIT_MS = 5_000;

/** Round 5: a prompt row above Codex's box is a turn just started only
 *  while the member typed into the tile within this long: by then a started
 *  turn shows `• Working` and its rollout has it. Older, it is an earlier
 *  prompt's row left at the top of the screen. */
export const JUST_ASKED_QUIET_MS = 3_000;

/** F1: how long a tile's screen must be still before a transcript turn that
 *  reads "open" is no longer believed to be running. */
export const STALE_OPEN_QUIET_MS = 5_000;

/**
 * F1, Claude only. The screen is the authority on what Claude does NOW; the
 * transcript on what its last finished answer IS. A turn Claude's transcript
 * leaves open — a prompt Claude took back on Esc (the transcript ends on that
 * user entry), a turn a sign-in or API error ended (1.177.1, item 4) — is not
 * running when the screen positively proves its last turn over
 * (`turnOverOnScreen`, `tileScreen.claudeTurnOver`: the box and its footer
 * drawn, a turn's end — `· done`, `⎿ Interrupted`, the error — the last row
 * above it, no running sign anywhere), nothing asks, and nothing on screen
 * says it works. Never Codex: its rollout always closes a turn
 * (`task_complete`, `turn_aborted`), and its screen can't prove it idle (a
 * long silent patch hides its status row) — review B1.
 */
export function claudeTurnEnded(f: TileFacts): boolean {
  return f.vendor === "claude" && f.turnOverOnScreen === true && f.working !== true && f.question === false;
}

/** `claudeTurnEnded`, and the tile printed nothing but its own resize
 *  redraws for `STALE_OPEN_QUIET_MS`: what a Send into that open turn needs
 *  (a prompt whose drawing is held back draws nothing for a moment). The
 *  line's words take `claudeTurnEnded` alone. */
export function openTurnStale(f: TileFacts): boolean {
  return claudeTurnEnded(f) && f.quietMs != null && f.quietMs >= STALE_OPEN_QUIET_MS;
}

/** What Compare knows of a tile's answer: a Codex tile whose screen says it
 *  started a new conversation is "ambiguous" with no answer, whatever the
 *  backend still reads from the old conversation's file. */
export function answerSeen(f: TileFacts | null | undefined, answer: CompareAnswer | null | undefined): CompareAnswer | null | undefined {
  if (f?.vendor === "codex" && f.newConversation === true) {
    return { vendor: "codex", conversation: "ambiguous", turn: "none", cut: false };
  }
  return answer;
}

/** One finished pass, newest first in the history. In memory only. */
export interface Pass {
  n: number;
  from: CompareVendor;
  to: CompareVendor;
  ask: CompareAsk;
  withNote: boolean;
  at: number;
  mode: "send" | "put";
  /** The exact text that was pasted (`comparePreparePaste`). */
  sent: string;
  /** The answer it carried, to pass again. */
  answer: string;
  answerKind?: "text" | "plan";
  cut: boolean;
  /** 1.179.0: the member's question given with it, before any cut (memory
   *  only), so *Pass it again* carries the same question. */
  question?: string;
  /** That question was already cut when it was read (`turnAsks.cut`). */
  questionCut?: boolean;
  /** The pasted text held the question (it wasn't left out for room). */
  withQuestion?: boolean;
  /** A Put: when its tile first finished an answer after it, so the turn
   *  that took it is known (`questionFor`, an edited Put). */
  answeredAt?: number;
}

export type GateAction = "send" | "put";

/** Why `f` can't take a paste now, or null when every guard holds. */
export function deliveryGate(
  to: CompareVendor,
  f: TileFacts,
  answer: CompareAnswer | null | undefined,
  action: GateAction,
): string | null {
  answer = answerSeen(f, answer);
  if (f.ended) return targetEndedWords(to);
  if (!f.live) return targetUnknownWords(to);
  if (f.question === true) {
    // Claude on its plan menu: its own answer is the open plan.
    if (to === "claude" && answer?.planPending === true && answer.turn === "open") return PLAN_WAITING_WORDS;
    return targetAsksWords(to);
  }
  // An ambiguous conversation takes a Put (the screen guards decide) but
  // not a Send, which needs the transcript to say no turn is open.
  if (action === "send" && answer?.conversation === "ambiguous") return conversationUnknownWords(to);
  // Send needs a conversation Plyloft can place: `none` can't prove that no
  // turn is open.
  if (action === "send" && answer && answer.conversation !== "known" && answer.conversation !== "unstarted") {
    return targetUnknownWords(to);
  }
  if (f.working === true) return targetWorkingWords(to);
  // Review round 1 (H1): Codex's rollout closes every turn it ends, so a turn
  // it leaves open is work — for a Put too. Its screen can't say so (a long
  // silent patch shows its box with nothing above it). Claude's transcript
  // can leave a turn open that isn't running (Esc before any output, an
  // error): its screen decides a Put, as before.
  if (to === "codex" && answer?.conversation === "known" && answer.turn === "open") return targetWorkingWords(to);
  // Review round 6 (M1): Claude's transcript turn open is work for a Put too,
  // unless the screen proves that turn over (Esc's orphan entry, a turn an
  // error ended: their end row over the box). A plan on its menu asked above.
  if (to === "claude" && answer?.conversation === "known" && answer.turn === "open" && f.turnOverOnScreen !== true) {
    return targetWorkingWords(to);
  }
  if (f.overlay === true) return COMPARE_CODEX_SEARCH_OPEN;
  // 1.177.1 (item 18): what the screen's bottom shows is not the CLI's box
  // (a menu or picker Plyloft doesn't know, a half-drawn frame): it can't
  // tell — never "text you typed", which a menu's marked row read as.
  if (f.boxDrawn === false) return targetUnknownWords(to);
  if (f.draft === true) return targetDraftWords(to);
  // Round 7: the member's keys just went into the tile and the screen read
  // may not show them yet — not a race to win: wait until they are drawn.
  if (
    f.inputQuietMs != null &&
    (f.inputQuietMs < INPUT_SETTLE_MS || (f.echoPending === true && f.inputQuietMs < ECHO_WAIT_MS))
  ) {
    return targetUnknownWords(to);
  }
  // A working state the screen can't say (Claude's turn start is off the page)
  // counts as not working when the screen proves the turn over (4/16), or the
  // backend knows the conversation and no turn is open in it.
  const workingKnown =
    f.working !== null ||
    (to === "claude" && f.turnOverOnScreen === true) ||
    (answer?.conversation === "known" && answer.turn !== "open");
  if (f.question === null || f.draft === null || !workingKnown || f.promptIdle !== true) {
    return targetUnknownWords(to);
  }
  // 1.177.1 (item 18): only on positive proof of the CLI's idle box — its
  // shape, its idle footer, nothing running. An unknown screen refuses.
  // Round 3 (M2): Codex's box with a slash command's output above it
  // (`/status`) is ready when its rollout says the conversation is known and
  // its last turn is closed: an open turn refused above (H1), and a turn that
  // has just started shows "Working" or the member's prompt right above the
  // box. Anywhere the rollout can't say (a fresh tile, `/new`, ambiguous),
  // the stricter rule stands: a turn's end, the banner or nothing above.
  // Round 5 (final walk, step 6): after a resize an earlier prompt's row
  // stayed at the top over the `/status` card — the same shape as a prompt
  // just asked; only the member's own recent typing can make it one.
  const codexShape =
    f.boxIdle === true ||
    (f.boxAsked === true && f.inputQuietMs != null && f.inputQuietMs >= JUST_ASKED_QUIET_MS);
  const codexIdleProof = to === "codex" && codexShape && answer?.conversation === "known" && answer.turn === "done";
  // Round 9 (narrow capture walk): Claude's box and mode line with nothing
  // running on screen, whatever sits above it (a plan left above after Esc,
  // a turn closed with a background shell) — on the transcript's word that no
  // turn is open, or the screen's proof that the last one ended.
  const claudeModeProof =
    to === "claude" &&
    f.boxMode === true &&
    (f.turnOverOnScreen === true || (answer?.conversation === "known" && answer.turn !== "open"));
  if (f.readyBox !== true && !codexIdleProof && !claudeModeProof) return targetUnknownWords(to);
  if (!answer) return targetUnknownWords(to);
  // Send submits: the transcript must say no turn is open either.
  // (an unclaimed Codex tile, "ambiguous", is a valid target: the screen guards decide)
  // …unless the screen has been still and idle long enough to say that open
  // turn is not running (F1, `openTurnStale`: every fact positively known).
  if (action === "send" && answer.conversation === "known" && answer.turn === "open" && !openTurnStale(f)) {
    return targetWorkingWords(to);
  }
  return null;
}

export interface PairResolved<T extends { id: string; vendor: CompareVendor } = TileFacts> {
  claude: T | null;
  codex: T | null;
  claudeOptions: T[];
  codexOptions: T[];
}

/** The pair from the member's choice: exactly one tile of a kind pairs by
 *  itself, more than one needs the choice, a choice that closed is gone.
 *  1.179.0: any tile with an id and a kind (the pair markers place them
 *  without reading a screen). */
export function resolvePair<T extends { id: string; vendor: CompareVendor } = TileFacts>(
  tiles: readonly T[],
  claudeId: string | null,
  codexId: string | null,
): PairResolved<T> {
  const claudeOptions = tiles.filter((t) => t.vendor === "claude");
  const codexOptions = tiles.filter((t) => t.vendor === "codex");
  const pick = (options: T[], id: string | null) =>
    options.find((t) => t.id === id) ?? (options.length === 1 ? options[0] : null);
  return { claude: pick(claudeOptions, claudeId), codex: pick(codexOptions, codexId), claudeOptions, codexOptions };
}

export interface Picker {
  vendor: CompareVendor;
  options: Array<{ id: string; label: string }>;
  selectedId: string | null;
}

export interface BarInput {
  tiles: readonly TileFacts[];
  claudeId: string | null;
  codexId: string | null;
  /** A paired tile closed (the pair was undone). */
  closed: CompareVendor | null;
  answers: Partial<Record<CompareVendor, CompareAnswer>>;
  history: readonly Pass[];
  /** The member flipped the direction on offer. */
  flipped: boolean;
  /** The last send or put, until its target answers. */
  sent: { to: CompareVendor; at: number; mode: "send" | "put"; chars?: number } | null;
  /** The sent-to tile printed within the quiet window (live read). */
  sentOutputActive?: boolean;
  /** 1.177.1: the answer to the last pass, held (`ReturnHeld`). */
  held?: ReturnHeld | null;
  now: number;
  /** 1.179.0 two-pair mode: the pair's name (its place's); absent with one
   *  pair. A kind with no tile left in its place says where to open one. */
  pairName?: string | null;
  /** 1.179.0: the other pair's composer is open (one at a time): its name. */
  otherComposer?: string | null;
}

export type BarKind = "no-pair" | "choose" | "nothing" | "ready" | "sent" | "blocked";

export interface BarView {
  kind: BarKind;
  /** The line's first words: who answered, or the state. */
  line: string;
  /** The reason the button is off (blocked), shown in the line. */
  note: string | null;
  pickers: Picker[];
  from: CompareVendor | null;
  to: CompareVendor | null;
  button: { label: string; disabled: boolean; reason: string | null } | null;
  /** The tile "Show it" focuses. */
  showIt: string | null;
  count: string;
  passes: number;
  /** A quiet swap shows when both tiles have an answer. */
  canSwap: boolean;
  /** Muted, after the main sentence: a tile whose conversation Plyloft can't place. */
  muted: string | null;
}

const hasAnswer = (a: CompareAnswer | undefined): a is CompareAnswer & { answer: string } =>
  Boolean(a && typeof a.answer === "string" && a.answer.trim().length > 0);

/** After a pass, the "sent" state ends when the target answered since, or —
 *  an answer that never comes (a Put nobody sent, an ambiguous Codex) —
 *  when its box is seen idle and empty again after a short while, or the
 *  tile can't take text any more. */
export const SENT_SEND_MS = 8_000;
export const SENT_PUT_MS = 1_500;

/** A stamp more than this ahead of the clock is not believed. */
export const FUTURE_SKEW_MS = 60_000;
/** The answer's finish time, or undefined when absent or ahead of the clock. */
export function stampOf(a: CompareAnswer | undefined, now: number): number | undefined {
  const t = a?.finishedAtMs;
  return t != null && t <= now + FUTURE_SKEW_MS ? t : undefined;
}

export function sentOver(
  sent: { to: CompareVendor; at: number; mode: "send" | "put"; chars?: number },
  target: TileFacts | undefined,
  targetAnswer: CompareAnswer | undefined,
  now: number,
  /** The target is still printing (ConPTY replaying a long paste as keys). */
  outputActive = false,
  /** 1.179.0: the OTHER tile's answer (the one the pass came from). */
  otherAnswer?: CompareAnswer,
): boolean {
  if (hasAnswer(targetAnswer) && (stampOf(targetAnswer, now) ?? 0) > sent.at) return true;
  if (!target || target.ended) return true;
  if (outputActive) return false;
  // 1.179.0 (walk: a Put cleared with Ctrl+U, never sent): a Put whose
  // target's box is not known to hold text any more, and that isn't working,
  // is over once the other tile has finished a newer answer than the pass —
  // the member moved on, and that answer is offered again. Text still seen in
  // the box keeps the line (it is there to send).
  if (
    sent.mode === "put" &&
    hasAnswer(otherAnswer) &&
    (stampOf(otherAnswer, now) ?? 0) > sent.at &&
    target.working !== true &&
    target.draft !== true &&
    target.draftNow !== true
  ) {
    return true;
  }
  const after = now - sent.at >= (sent.mode === "send" ? SENT_SEND_MS : SENT_PUT_MS);
  if (!after) return false;
  // The target stopped: it asks something (a refused command leaves it
  // waiting), or its box is idle and empty — either way it isn't working on it.
  if (target.question === true && target.working !== true) return true;
  // 1.179.0: Claude's "not working" as the guard reads it (`deliveryGate`'s
  // `workingKnown`): its live read gives `working: null` when the prompt that
  // started its last turn scrolled off the page (`liveWorking`, a long
  // answer above), and the store's settled "not working" can't outvote that
  // unknown (`factsOfTile`'s `orOf`). The screen's proof that the last turn
  // ended, or the transcript's word that no turn is open, says it is not.
  const notWorking =
    target.working === false ||
    (target.working === null &&
      target.vendor === "claude" &&
      (target.turnOverOnScreen === true || (targetAnswer?.conversation === "known" && targetAnswer.turn !== "open")));
  // Round 5 (final walk, step 9): a Send whose text sits in the box unsent
  // (Esc landed before its Enter, or the CLI put it back) is a Put now: the
  // line says it is in the box (`bar`) for as long as it is, as a Put's does.
  return (
    notWorking &&
    target.draft === false &&
    target.promptIdle === true &&
    target.question === false
  );
}

/** 1.177.1: after a pass into `into` (at `at`), waiting for the first
 *  answer that tile finishes after it. `sawWork`: the tile was seen working
 *  since. Memory only. */
export interface ReturnPending {
  into: CompareVendor;
  at: number;
  sawWork: boolean;
}

/** 1.177.1: the answer to a pass, held: the tile that answered (`from`) and
 *  that answer, as it was read. Offered back (`from` → the other) until a
 *  pass succeeds, the member swaps, the pair changes, Compare goes off or
 *  (1.179.0) its tile finishes a newer answer of its own (`heldLapsed`).
 *  Memory only, never logged. */
export interface ReturnHeld {
  from: CompareVendor;
  answer: CompareAnswer & { answer: string };
}

/**
 * 1.177.1: whether `answer`, just read from `vendor`'s tile, is the answer to
 * the pass waited for: that tile, an answer with text, finished after the
 * pass (and not ahead of the clock). Only the newest finished answer of a
 * tile is read, so of two answers it finishes between two reads the first is
 * never seen (a known limit).
 */
export function answerToPass(
  pending: ReturnPending | null | undefined,
  vendor: CompareVendor,
  answer: CompareAnswer | null | undefined,
  now: number,
): ReturnHeld | null {
  if (!pending || pending.into !== vendor || !answer || !hasAnswer(answer)) return null;
  if (answer.conversation === "ambiguous") return null;
  const at = stampOf(answer, now);
  return at !== undefined && at > pending.at ? { from: vendor, answer } : null;
}

/** Review round 1 (H2): a held answer that may still change — Claude's plan
 *  in a turn still open (on its approval menu, or approved and being carried
 *  out): the member may keep planning (plan v2), and the turn's own final
 *  answer is still to come. A finished turn's answer, and every Codex answer
 *  (its rollout gives a finished turn's message only), is final. */
export function heldIsProvisional(held: ReturnHeld): boolean {
  return held.from === "claude" && held.answer.turn === "open" && held.answer.answerKind === "plan";
}

/**
 * 1.179.0 (owner, 2026-11-27): a final held answer lapses when its tile
 * finishes a newer answer that is not the answer to a pass — the member moved
 * on in that tile (asked it something of their own), and offering the old
 * answer back would pass what they no longer mean. Newer: a read of THAT tile
 * whose answer finished strictly after the held one (`finishedAtMs`), or,
 * where either time is missing or not believed, a different text. Only once
 * that answer is finished: a read with its turn still open, ambiguous, or
 * without an answer never lapses it; nor does a read while a pass into that
 * tile is waited for (`pending`), whose answer `answerToPass` holds instead.
 * The backend reads only a tile's newest finished answer, so while the held
 * answer is still its tile's newest, every read gives back that same answer
 * (the same time, the same text): never later than itself.
 */
export function heldLapsed(
  held: ReturnHeld | null,
  vendor: CompareVendor,
  answer: CompareAnswer | null | undefined,
  now: number,
  pending: ReturnPending | null = null,
): boolean {
  if (!held || held.from !== vendor || heldIsProvisional(held)) return false;
  if (pending?.into === vendor) return false;
  if (!answer || !hasAnswer(answer) || answer.conversation === "ambiguous") return false;
  if (answer.turn === "open") return false;
  const at = stampOf(answer, now);
  const heldAt = held.answer.finishedAtMs;
  if (at !== undefined && heldAt !== undefined) return at > heldAt;
  return answer.answer !== held.answer.answer;
}

/** Review round 1 (H2): the held answer after a read of `vendor`'s tile: a
 *  provisional one is replaced by a newer read from the same tile (plan v2,
 *  or the turn's final answer, which then stays); a final one is never
 *  replaced — a later, separate answer of that tile is not the answer to the
 *  pass — and 1.179.0: it lapses then (`heldLapsed`), so the bar offers what
 *  it would with nothing held. */
export function nextHeld(
  held: ReturnHeld | null,
  vendor: CompareVendor,
  answer: CompareAnswer | null | undefined,
  now: number,
  pending: ReturnPending | null = null,
): ReturnHeld | null {
  if (!held || held.from !== vendor) return held;
  if (!heldIsProvisional(held)) return heldLapsed(held, vendor, answer, now, pending) ? null : held;
  if (!answer || !hasAnswer(answer) || answer.conversation === "ambiguous") return held;
  const at = stampOf(answer, now);
  if (at === undefined || at < (held.answer.finishedAtMs ?? 0)) return held;
  if (at === held.answer.finishedAtMs && answer.answer === held.answer.answer && answer.turn === held.answer.turn) return held;
  return { from: vendor, answer };
}

/** 1.177.1: after a pass, its "sent" state ended with no answer to it and
 *  its target never seen working: the text left the box without a turn (the
 *  member cleared it). The answer waited for is no longer the pass's. */
export function passDropped(
  pending: ReturnPending | null | undefined,
  sent: { to: CompareVendor; at: number },
  target: TileFacts | undefined,
  targetAnswer: CompareAnswer | undefined,
  now: number,
): boolean {
  if (!pending || pending.into !== sent.to || pending.at !== sent.at || pending.sawWork) return false;
  if (hasAnswer(targetAnswer) && (stampOf(targetAnswer, now) ?? 0) > sent.at) return false;
  // Only a box seen idle and empty: text still there may yet be sent.
  return target !== undefined && !target.ended && target.draft === false && target.working === false && target.question === false;
}

/** The direction on offer: the newest finished answer's tile is the source;
 *  the member's flip swaps it when both have one. 1.177.1: an answer held
 *  for a pass is offered back first, whatever either tile answered since. */
export function directionOnOffer(
  answers: Partial<Record<CompareVendor, CompareAnswer>>,
  flipped: boolean,
  now: number = Date.now(),
  held: ReturnHeld | null = null,
): { from: CompareVendor; to: CompareVendor; both: boolean } | null {
  if (held && hasAnswer(held.answer)) {
    const to = compareOtherVendor(held.from);
    return { from: held.from, to, both: hasAnswer(answers[to]) };
  }
  const c = hasAnswer(answers.claude);
  const x = hasAnswer(answers.codex);
  if (!c && !x) return null;
  if (c !== x) {
    const from: CompareVendor = c ? "claude" : "codex";
    return { from, to: compareOtherVendor(from), both: false };
  }
  const newest: CompareVendor =
    (stampOf(answers.codex, now) ?? 0) > (stampOf(answers.claude, now) ?? 0) ? "codex" : "claude";
  const from = flipped ? compareOtherVendor(newest) : newest;
  return { from, to: compareOtherVendor(from), both: true };
}

/** The held answer the bar may offer: none for a Codex tile that started a
 *  new conversation since (`/new`). */
export function heldOffered(
  held: ReturnHeld | null | undefined,
  factsOf: (v: CompareVendor) => TileFacts,
): ReturnHeld | null {
  if (!held || !hasAnswer(held.answer)) return null;
  const f = factsOf(held.from);
  return f.vendor === "codex" && f.newConversation === true ? null : held;
}

export function bar(input: BarInput): BarView {
  const view = barOf(input);
  // 1.179.0: one composer at a time — while the other pair's is open, this
  // bar's pass waits for it (a reason of its own stays: it is truer).
  if (input.otherComposer && view.button && !view.button.disabled) {
    const reason = otherPassOpenWords(input.otherComposer);
    return { ...view, button: { ...view.button, disabled: true, reason } };
  }
  return view;
}

function barOf(input: BarInput): BarView {
  const pair = resolvePair(input.tiles, input.claudeId, input.codexId);
  const count = passCountWords(input.history.length);
  const pickers: Picker[] = [];
  const pickerFor = (vendor: CompareVendor, options: TileFacts[], selected: TileFacts | null) => {
    if (options.length > 1) {
      pickers.push({
        vendor,
        options: options.map((t) => ({ id: t.id, label: t.label })),
        selectedId: selected?.id ?? null,
      });
    }
  };
  pickerFor("claude", pair.claudeOptions, pair.claude);
  pickerFor("codex", pair.codexOptions, pair.codex);
  const base = {
    pickers,
    from: null,
    to: null,
    button: null,
    showIt: null,
    note: null,
    count,
    passes: input.history.length,
    canSwap: false,
    muted: null as string | null,
  };
  const closedWords = (v: CompareVendor | null) =>
    v && (v === "claude" ? pair.claude : pair.codex) === null && (v === "claude" ? pair.claudeOptions : pair.codexOptions).length === 0
      ? tileClosedWords(v)
      : null;
  if (pair.claudeOptions.length === 0 || pair.codexOptions.length === 0) {
    // 1.179.0: a pair of two-pair mode always had both tiles in its place.
    if (input.pairName) {
      const gone: CompareVendor = pair.claudeOptions.length === 0 ? "claude" : "codex";
      return { ...base, kind: "no-pair", line: pairTileClosedWords(gone, input.pairName) };
    }
    return { ...base, kind: "no-pair", line: closedWords(input.closed) ?? COMPARE_NO_PAIR };
  }
  if (!pair.claude || !pair.codex) {
    return { ...base, kind: "choose", line: input.closed ? tileClosedWords(input.closed) : "" };
  }
  const claude = pair.claude;
  const codex = pair.codex;
  const factsOf = (v: CompareVendor) => (v === "claude" ? claude : codex);
  const answers: typeof input.answers = {
    claude: answerSeen(claude, input.answers.claude) ?? undefined,
    codex: answerSeen(codex, input.answers.codex) ?? undefined,
  };
  // 1.177.1: an answer held for a pass, unless its Codex tile started a new
  // conversation since (that answer is no longer the tile's).
  const held = heldOffered(input.held, factsOf);
  const dir = directionOnOffer(answers, input.flipped, input.now, held);

  // After a pass, until its target answers (or its box is seen empty and
  // idle again): the line says whose turn it is.
  const sentTo = input.sent?.to ?? null;
  if (
    input.sent &&
    sentTo &&
    !sentOver(input.sent, factsOf(sentTo), answers[sentTo], input.now, input.sentOutputActive === true, answers[compareOtherVendor(sentTo)])
  ) {
    const back = compareOtherVendor(sentTo);
    // A Put whose target is now working was sent by the member (Enter there).
    // …and its box reads empty: the text was sent, not only a draft being typed over.
    const sf = factsOf(sentTo);
    // The box as the screen reads it now: the store's draft flag is only
    // refreshed when the output settles, never while the tile works (F3).
    const box = sf.draftNow ?? sf.draft;
    // Round 3 (walk step 8): a Send whose text is back in an idle box (Esc
    // landed between the paste and its Enter) says where the text is as soon
    // as a live read after the pass shows it there with nothing working or
    // asking — once the paste itself is settled (no replay still printing).
    // The live screen's box only: the store's draft flag can be older.
    const unsent =
      input.sent.mode === "send" &&
      input.now > input.sent.at &&
      input.sentOutputActive !== true &&
      sf.working === false &&
      sf.question === false &&
      sf.draftNow === true;
    const working = (input.sent.mode === "send" && !unsent) || (sf.working === true && box === false);
    const line = working ? passedToWords(sentTo) : putInBoxWords(sentTo);
    return {
      ...base,
      kind: "sent",
      line,
      from: sentTo,
      to: back,
      button: { label: passButtonWords(back), disabled: true, reason: line },
    };
  }

  if (!dir) {
    // A tile Plyloft can't place in a conversation: say so (a fresh one is
    // "unstarted", and has nothing to pass yet).
    const ambiguous = (["claude", "codex"] as const).find((v) => answers[v]?.conversation === "ambiguous");
    // 1.179.0: Claude's newest plan can't be read, so nothing of it is
    // offered; say why rather than "nothing yet".
    if (answers.claude?.planUnread === true) return { ...base, kind: "nothing", line: PLAN_UNREAD_WORDS };
    return { ...base, kind: "nothing", line: ambiguous ? conversationUnknownWords(ambiguous) : COMPARE_NOTHING_YET };
  }
  const { from, to } = dir;
  // Either tile's conversation Plyloft can't place is said quietly, whatever is offered.
  const ambiguousVendor = (['claude', 'codex'] as const).find((v) => answers[v]?.conversation === 'ambiguous') ?? null;
  const source = held && held.from === from ? held.answer : answers[from]!;
  const sourceFacts = factsOf(from);
  // The source is mid-turn when the screen says it works, or its transcript
  // turn is open — on a permission menu too (F4) — unless the answer on offer
  // is that turn's own plan waiting for its menu, or the screen has been
  // still and idle long enough to say the open turn isn't running (F1).
  // 1.177.1 (item 4/16): words only, so the screen's proof counts at once.
  const sourceBusy =
    sourceFacts.working === true ||
    (source.turn === "open" && source.planPending !== true && !claudeTurnEnded(sourceFacts));
  // A held answer is said with its own age, whatever its tile does now.
  const line = held
    ? answeredWords(from, stampOf(source, input.now) != null ? agoWords(stampOf(source, input.now)!, input.now) : "earlier")
    : sourceBusy
    ? sourceWorkingWords(from)
    : source.fromEarlierTurn
      ? earlierTurnWords(from)
      : answeredWords(from, stampOf(source, input.now) != null ? agoWords(stampOf(source, input.now)!, input.now) : "earlier");
  const reason = deliveryGate(to, factsOf(to), answers[to], "put");
  return {
    ...base,
    kind: reason ? "blocked" : "ready",
    line,
    note: reason,
    from,
    to,
    button: { label: passButtonWords(to), disabled: reason !== null, reason },
    showIt: reason ? factsOf(to).id : null,
    canSwap: dir.both,
    muted: ambiguousVendor ? ambiguousQuietWords(ambiguousVendor) : null,
  };
}

// ── 1.179.0 Two pairs ────────────────────────────────────────────────────
// A pair is implied by its place: the project folder, or one copy. Two
// Codex tiles in one folder can't be told apart (their conversations are
// claimed by folder), so a second pair needs a place of its own.

/** The project folder's place. A copy's place is its id. */
export const PROJECT_PLACE = "project";

/** What a place needs of a copy (`CopyView`). */
export interface CopyPlace {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  state?: string;
}

/** A place, as the bars are ordered: the project first, then copies by age. */
export interface PlaceDef {
  id: string;
  name: string;
}

function trimSeparators(path: string, win: boolean): string {
  return path.replace(win ? /[\\/]+$/ : /\/+$/, "");
}

/** The place a folder is in: the active copy whose folder holds it, else the
 *  project. On Windows the same folder shows as `C:\` and `c:\`, with either
 *  separator: compared as the app compares paths there (`paths.ts`). */
export function placeOfCwd(cwd: string | null | undefined, copies: readonly CopyPlace[], win: boolean): string {
  if (!cwd) return PROJECT_PLACE;
  const at = trimSeparators(cwd, win);
  for (const c of copies) {
    if ((c.state !== undefined && c.state !== "active") || !c.path) continue;
    const root = trimSeparators(c.path, win);
    if (root && (samePath(at, root, win) || relativeTo(at, root, win) !== null)) return c.id;
  }
  return PROJECT_PLACE;
}

/** The places in bar order: the project (named after it), then the active
 *  copies, oldest first. */
export function placesOf(projectName: string, copies: readonly CopyPlace[]): PlaceDef[] {
  const active = copies.filter((c) => (c.state === undefined || c.state === "active") && !!c.path);
  return [
    { id: PROJECT_PLACE, name: projectName },
    ...[...active].sort((a, b) => a.createdAt - b.createdAt).map((c) => ({ id: c.id, name: c.name })),
  ];
}

export interface PairsInput {
  /** The workspace's Claude and Codex tiles (not closing), with their place. */
  tiles: readonly { id: string; vendor: CompareVendor; place: string }[];
  places: readonly PlaceDef[];
  /** The single pair's choice (`WsCompare.claudeId`/`codexId`). */
  single: { claudeId: string | null; codexId: string | null };
  /** The places that hold a pair of two-pair mode now (`WsCompare.pairs`). */
  held: readonly string[];
}

/** One bar: its place (`""` with one pair), its name, its dot. */
export interface PairPlace {
  place: string;
  name: string;
  slot: "a" | "b";
  /** The Claude and Codex tiles the bar picks from. */
  tileIds: string[];
}

export interface PairsView {
  mode: "single" | "two";
  pairs: PairPlace[];
  /** Two-pair mode: a third place holding both kinds, which gets no bar. */
  extra: string | null;
  /** Single: the pair spans two places while a second place could pair. */
  crossPlace: boolean;
  /** Into two-pair mode: the place the single pair's state goes to. */
  moveTo: string | null;
  /** Out of it: the pair whose state becomes the single pair's. */
  backFrom: string | null;
}

/**
 * The bars a workspace shows. One place holding both a Claude and a Codex
 * tile (or none): single-pair mode, exactly 1.178.0's bar over every tile.
 * A second such place: two pairs, one bar each, project first, then copies
 * by age — unless the single pair spans two places (a 1.178.0 pair across
 * folders), which stays the one pair (`crossPlace`). A pair of two-pair mode
 * keeps its bar while any of its tiles is open; with one bar left, it is
 * single-pair mode again on that pair. At most two bars: a third place is
 * named (`extra`).
 */
export function pairsOf(input: PairsInput): PairsView {
  const rank = new Map(input.places.map((p, i) => [p.id, i] as const));
  const nameOf = (id: string) => input.places.find((p) => p.id === id)?.name ?? "";
  const inPlace = (place: string) => input.tiles.filter((t) => t.place === place);
  const full = input.places
    .map((p) => p.id)
    .filter((id) => {
      const here = inPlace(id);
      return here.some((t) => t.vendor === "claude") && here.some((t) => t.vendor === "codex");
    });
  const byRank = (a: string, b: string) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER);
  const single = (over: Partial<PairsView> = {}): PairsView => ({
    mode: "single",
    pairs: [{ place: "", name: "", slot: "a", tileIds: input.tiles.map((t) => t.id) }],
    extra: null,
    crossPlace: false,
    moveTo: null,
    backFrom: null,
    ...over,
  });
  // A pair of two-pair mode stays while its place is there and holds a tile.
  const kept = input.held.filter((p) => rank.has(p) && inPlace(p).length > 0).sort(byRank).slice(0, 2);
  let chosen: string[];
  let moveTo: string | null = null;
  if (kept.length > 0) {
    chosen = [...kept];
    for (const p of full) if (chosen.length < 2 && !chosen.includes(p)) chosen.push(p);
    if (chosen.length < 2) return single({ backFrom: chosen[0] ?? null });
  } else {
    if (full.length < 2) return single();
    const c = input.single.claudeId ? input.tiles.find((t) => t.id === input.single.claudeId) : undefined;
    const x = input.single.codexId ? input.tiles.find((t) => t.id === input.single.codexId) : undefined;
    if (c && x && c.place !== x.place) return single({ crossPlace: true });
    // The single pair moves with its place, which gets a bar first.
    const own = c?.place ?? x?.place ?? null;
    chosen = own !== null && full.includes(own) ? [own] : [];
    for (const p of full) if (chosen.length < 2 && !chosen.includes(p)) chosen.push(p);
    moveTo = own !== null && chosen.includes(own) ? own : null;
  }
  chosen.sort(byRank);
  const third = full.find((p) => !chosen.includes(p)) ?? null;
  return {
    mode: "two",
    pairs: chosen.map((p, i) => ({ place: p, name: nameOf(p), slot: i === 0 ? "a" : "b", tileIds: inPlace(p).map((t) => t.id) })),
    extra: third !== null ? nameOf(third) : null,
    crossPlace: false,
    moveTo,
    backFrom: null,
  };
}

/** 1.179.0: Auto layout draws a pair's two tiles next to each other: the
 *  tiles of each pair's place in bar order, its paired Claude then Codex
 *  first, then the rest as they were. The visual order only (CSS `order`):
 *  the DOM order, and every terminal, stay. */
export function pairTileOrder(
  tiles: readonly { id: string; place: string }[],
  pairs: readonly { place: string; claudeId: string | null; codexId: string | null }[],
): Map<string, number> {
  const rank = (t: { id: string; place: string }, i: number): [number, number, number] => {
    const p = pairs.findIndex((x) => x.place === t.place);
    if (p < 0) return [pairs.length, 2, i];
    const pair = pairs[p];
    return [p, t.id === pair.claudeId ? 0 : t.id === pair.codexId ? 1 : 2, i];
  };
  const ranked = tiles.map((t, i) => ({ id: t.id, r: rank(t, i) }));
  ranked.sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2]);
  return new Map(ranked.map((x, i) => [x.id, i] as const));
}

/** The ask a pass starts on: a plan is reviewed; then the answer to what
 *  was last passed into the source tile; the member's click always wins. */
export function defaultAsk(
  answerKind: "text" | "plan" | undefined,
  lastPassIntoSource: CompareAsk | null,
  /** The source planned (a plan seen from it) after the last pass into it, or
   *  there is no pass into it at all: this text is the work that followed. */
  plannedSincePass = false,
): CompareAsk {
  if (answerKind === "plan") return "review-plan";
  if (plannedSincePass) return "check-work";
  if (lastPassIntoSource === "review-plan") return "answer-review";
  if (lastPassIntoSource === "carry-out") return "check-work";
  if (lastPassIntoSource === "answer-review") return "review-plan";
  return "just-pass";
}

/** Whether `vendor`'s tile planned (`planSeenAt`) after the newest pass into
 *  it, or planned and nothing was ever passed into it. */
export function plannedSincePass(
  history: readonly Pass[],
  vendor: CompareVendor,
  planSeenAt: number | undefined,
): boolean {
  if (planSeenAt === undefined) return false;
  const into = history.find((p) => p.to === vendor);
  return into === undefined || planSeenAt > into.at;
}

/** The ask of the newest pass into `vendor`'s tile (history is newest first). */
export function lastAskInto(history: readonly Pass[], vendor: CompareVendor): CompareAsk | null {
  return history.find((p) => p.to === vendor)?.ask ?? null;
}

/** What goes to `comparePreparePaste`. The backend cleans and caps the
 *  text; the frontend never assembles what is pasted. */
export function pasteParts(
  from: CompareVendor,
  ask: CompareAsk,
  answer: string,
  note: string,
  /** 1.179.0: the member's question, passed text already taken out; absent
   *  (or blank) leaves the parts exactly as before. */
  question?: { text: string; cut: boolean } | null,
): ComparePasteParts {
  const trimmed = note.slice(0, COMPARE_NOTE_MAX).trim();
  const parts: ComparePasteParts = {
    lead: COMPARE_ASK_LEAD[ask],
    fromLabel: fromLabelWords(from),
    answer,
    note: trimmed === "" ? undefined : trimmed,
    noteLabel: COMPARE_NOTE_LABEL,
  };
  if (question && question.text.trim() !== "") {
    parts.question = question.text;
    parts.questionLabel = questionLabelWords(from);
    if (question.cut) parts.questionCut = true;
  }
  return parts;
}

/** 1.179.0 "Include my question": what the member asked in the answer's
 *  turn. `ok`: the words to include; `nothing`: the turn holds no words of
 *  theirs (`passed-only`: only text Compare passed; `no-words`: no message in
 *  words at all); `unknown`: the question is left out, for `why` (the
 *  backend's, `edited` for a pass that can't be told apart from the member's
 *  words, `not-read` when the answer came without its turn's messages). */
export type QuestionState =
  | { state: "ok"; text: string; cut: boolean }
  | { state: "nothing"; why: "passed-only" | "no-words" }
  | { state: "unknown"; why: CompareAsksUnknown | "edited" | "not-read" };

/** Lines only Compare writes: a pass's labels and its ask leads. Left in a
 *  message once the passes are taken out, they are a pass edited by hand or
 *  one made before the history was lost. */
const COMPARE_LABEL_LINES: ReadonlySet<string> = new Set(
  [
    fromLabelWords("claude"),
    fromLabelWords("codex"),
    questionLabelWords("claude"),
    questionLabelWords("codex"),
    ...Object.values(COMPARE_ASK_LEAD),
  ]
    .filter((l): l is string => typeof l === "string")
    .map((l) => plainForKeys(l).trim()),
);

/** Text as a turn's message and a pass are compared: the paste's own key
 *  normalisation (Windows replays a paste to Codex as plain keys), trimmed,
 *  so the pass's leading space (which Codex doesn't keep) doesn't count. */
const askNorm = (s: string): string => plainForKeys(s).trim();

/** Whether the turn whose answer finished at `finishedAtMs` is the one that
 *  took the Put `p`: made before that answer, and its tile finished no
 *  answer between the Put and this one. */
function turnTookPut(p: Pass, finishedAtMs: number | undefined): boolean {
  if (finishedAtMs === undefined) return p.answeredAt === undefined;
  return p.at < finishedAtMs && (p.answeredAt === undefined || p.answeredAt >= finishedAtMs);
}

/**
 * 1.179.0: the member's own question in `asks` (the answer's turn, as the
 * CLI's file has it), from the passes into that tile held in memory
 * (`passesInto`, newest first). A message equal to a pass is not theirs;
 * one that holds a pass and words of their own keeps only those words.
 * Uncertain is left out, never a part that looks whole: Compare's labels
 * left once the passes are out, or a Put the turn took that no message holds
 * verbatim (edited by hand), make it `unknown`.
 */
export function questionFor(
  asks: CompareTurnAsks | undefined,
  passesInto: readonly Pass[],
  finishedAtMs: number | undefined,
): QuestionState {
  if (!asks) return { state: "unknown", why: "not-read" };
  if (asks.status === "unknown") return { state: "unknown", why: asks.why };
  const norm = asks.messages.map((m) => askNorm(m.text));
  // Rule 12: a Put this turn took must be in one of its messages as it went.
  const put = passesInto.find((p) => p.mode === "put" && turnTookPut(p, finishedAtMs));
  if (put) {
    const text = askNorm(put.sent);
    if (text !== "" && !norm.some((m) => m.includes(text))) return { state: "unknown", why: "edited" };
  }
  // Longest first, so a pass that holds a shorter one is taken out whole.
  const passed = [...new Set(passesInto.map((p) => askNorm(p.sent)).filter((s) => s !== ""))].sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  let words = false;
  for (let i = 0; i < norm.length; i++) {
    const n = norm[i];
    if (n === "") continue;
    words = true;
    let pieces = [n];
    for (const p of passed) pieces = pieces.flatMap((s) => s.split(p));
    const rest = pieces.map((s) => s.trim()).filter((s) => s !== "");
    // Rule 11: Compare's labels with no pass that holds them.
    if (rest.some((r) => r.split("\n").some((line) => COMPARE_LABEL_LINES.has(line.trim())))) {
      return { state: "unknown", why: "edited" };
    }
    if (rest.length === 0) continue;
    // A message with nothing taken out goes as the member wrote it.
    kept.push(rest.length === 1 && rest[0] === n ? asks.messages[i].text.trim() : rest.join("\n\n"));
  }
  if (kept.length > 0) return { state: "ok", text: kept.join("\n\n"), cut: asks.cut };
  return { state: "nothing", why: words ? "passed-only" : "no-words" };
}

/** Why the switch is off and disabled, or null when there is a question. */
export function questionReasonWords(from: CompareVendor, q: QuestionState): string | null {
  if (q.state === "ok") return null;
  if (q.state === "nothing") return q.why === "passed-only" ? questionPassedOnlyWords(from) : questionNotYoursWords(from);
  switch (q.why) {
    case "start-not-read":
    case "queued-start":
    case "compacted":
    case "not-read":
      return questionStartUnknownWords(from);
    case "command":
    case "not-typed":
      return questionNotYoursWords(from);
    case "feedback-unread":
      return QUESTION_PLAN_FEEDBACK_WORDS;
    case "unknown-message":
    case "edited":
      return QUESTION_EDITED_WORDS;
  }
}

/** "21:04" — the app's 24-hour clock, as the command blocks show it. */
export function clockWords(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}
