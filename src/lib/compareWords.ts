// 1.177.0 Compare: every word of the relay bar, in one place (re-exported
// from lib/words.ts). Pure. Run with:
//
//     node --experimental-strip-types src/lib/compareView.test.ts

export type CompareVendor = "claude" | "codex";

/** The short vendor name, as the tile headers say it. */
export function compareVendorName(v: CompareVendor): string {
  return v === "claude" ? "Claude" : "Codex";
}
export function compareOtherVendor(v: CompareVendor): CompareVendor {
  return v === "claude" ? "codex" : "claude";
}

export const COMPARE_TOGGLE = "Compare";
export const COMPARE_TOGGLE_TITLE =
  "Pass the last answer of a Claude tile to a Codex tile, or the other way round, under the tiles.";
export const COMPARE_NO_PAIR = "Open a Claude Code tile and a Codex tile to compare them.";
export const COMPARE_NOTHING_YET =
  "Nothing to pass yet. When Claude or Codex finishes an answer, you can pass it to the other.";
export const COMPARE_CLAUDE_TILE = "Claude tile";
export const COMPARE_CODEX_TILE = "Codex tile";
export const COMPARE_NO_TILE_CHOSEN = "Choose a tile";
export const COMPARE_SWAP_TITLE = "Pass the other tile's answer instead";
export const COMPARE_SWAP = "Swap";

export function tileClosedWords(v: CompareVendor): string {
  return `${compareVendorName(v)}'s tile is closed.`;
}
export function answeredWords(v: CompareVendor, ago: string): string {
  return `${compareVendorName(v)} answered ${ago}`;
}
export function sourceWorkingWords(v: CompareVendor): string {
  return `${compareVendorName(v)} is working. This is its last finished answer.`;
}
export function passCountWords(n: number): string {
  return n === 0 ? "Nothing passed yet" : n === 1 ? "1 pass" : `${n} passes`;
}
export function passButtonWords(to: CompareVendor): string {
  return `Pass to ${compareVendorName(to)} →`;
}
export function passedToWords(to: CompareVendor): string {
  return `Passed to ${compareVendorName(to)}. It's working on it.`;
}
export function putInBoxWords(to: CompareVendor): string {
  return `It's in ${compareVendorName(to)}'s box. Press Enter there to send it.`;
}

// Blocked.
export function targetAsksWords(to: CompareVendor): string {
  return `${compareVendorName(to)} is asking you something. Answer it in its tile first.`;
}
export function targetWorkingWords(to: CompareVendor): string {
  return `${compareVendorName(to)} is working. You can pass this when it's done.`;
}
export function targetDraftWords(to: CompareVendor): string {
  return `${compareVendorName(to)}'s box has text you typed. Send it or clear it first.`;
}
export function targetUnknownWords(to: CompareVendor): string {
  return `Can't tell if ${compareVendorName(to)} is ready. Click its tile and try again.`;
}
export function conversationUnknownWords(v: CompareVendor): string {
  // Codex's `/new` can't be followed: more messages don't help it.
  if (v === "codex") return CODEX_UNKNOWN_WORDS;
  return `Can't tell which conversation this ${compareVendorName(v)} tile is in. Send it one message first.`;
}
export const CODEX_UNKNOWN_WORDS =
  "Can't tell which conversation Codex's tile is in. Close it and open a new Codex tile to compare.";
export const PLAN_WAITING_WORDS =
  "Claude is waiting for your answer to its plan. To send it this instead, press Esc in its tile, then pass.";
export function ambiguousQuietWords(v: CompareVendor): string {
  if (v === "codex") return CODEX_UNKNOWN_WORDS;
  return `Can't tell which conversation ${compareVendorName(v)}'s tile is in.`;
}
export const COMPARE_BACK = "Back";
export function earlierTurnWords(v: CompareVendor): string {
  return `${compareVendorName(v)}'s last turn ended without an answer. This is the one before it.`;
}
export function noteCutsWords(): string {
  return "With your note, the answer is cut at 16,000 characters. Send again to pass it cut, or shorten the note.";
}
export function targetEndedWords(to: CompareVendor): string {
  return `${compareVendorName(to)}'s session has ended. Open it again first.`;
}
/** Codex's transcript search is open over its box (the existing words of
 *  `builderInject.OVERLAY_ALREADY_OPEN`). */
export const COMPARE_CODEX_SEARCH_OPEN = "Codex's transcript search was open, so Plyloft didn't type it in.";
export function notReachedWords(to: CompareVendor): string {
  return `That didn't reach ${compareVendorName(to)}. Nothing was sent.`;
}
export function reachedNotSentWords(to: CompareVendor): string {
  return `It reached ${compareVendorName(to)}'s box, but Plyloft couldn't send it. Press Enter in its tile.`;
}
export function newerAnswerWords(from: CompareVendor): string {
  return `${compareVendorName(from)} answered again. Read it, then send.`;
}
export const COMPARE_SHOW_IT = "Show it";

// The composer.
export function composerTitleWords(from: CompareVendor, to: CompareVendor, kind: "text" | "plan" | undefined): string {
  return `${compareVendorName(from)}'s ${kind === "plan" ? "plan" : "answer"} to ${compareVendorName(to)}`;
}
export function charsWords(n: number): string {
  return `${n.toLocaleString("en-US")} characters`;
}
export const COMPARE_CUT_WORDS = "Cut at 16,000 characters.";
export const COMPARE_SHOW = "Show";
export const COMPARE_HIDE = "Hide";
export const COMPARE_CANCEL = "Cancel";
export function askHeading(to: CompareVendor): string {
  return `Ask ${compareVendorName(to)} to`;
}
export const COMPARE_NOTE_PLACEHOLDER = "Add a note of your own (optional)";
export const COMPARE_NOTE_MAX = 4000;
export function sendWords(to: CompareVendor): string {
  return `Send to ${compareVendorName(to)}`;
}
export const COMPARE_PUT_IN_BOX = "Put it in its box";

export type CompareAsk = "review-plan" | "carry-out" | "check-work" | "answer-review" | "just-pass";
export const COMPARE_ASKS: readonly CompareAsk[] = ["review-plan", "carry-out", "check-work", "answer-review", "just-pass"];

export const COMPARE_ASK_LABEL: Readonly<Record<CompareAsk, string>> = {
  "review-plan": "Review this plan",
  "carry-out": "Carry it out",
  "check-work": "Check this work",
  "answer-review": "Answer this review",
  "just-pass": "Just pass it",
};

/** What is pasted before the answer, by ask (prompt text for the AI). */
export const COMPARE_ASK_LEAD: Readonly<Record<CompareAsk, string | undefined>> = {
  "review-plan": "Review this plan. Say what is missing or wrong before any code is written.",
  "carry-out": "Carry out this plan.",
  "check-work": "Check this work against what was asked. Say what is wrong or missing.",
  "answer-review": "This is a review of your last answer. Answer it, and change your plan where the review is right.",
  "just-pass": undefined,
};

export function fromLabelWords(v: CompareVendor): string {
  return v === "claude" ? "From Claude Code:" : "From Codex:";
}
export const COMPARE_NOTE_LABEL = "My note:";

// History.
export const COMPARE_HISTORY_LABEL = "Passes";
export const COMPARE_WITH_NOTE = "with your note";
export const COMPARE_PASS_AGAIN = "Pass it again";
export function historyDirection(from: CompareVendor, to: CompareVendor): string {
  return `${compareVendorName(from)} → ${compareVendorName(to)}`;
}
