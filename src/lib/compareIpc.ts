import { invoke } from "@tauri-apps/api/core";

// 1.177.0 Compare: a tile's last finished answer and the cleaned text that
// goes into the other tile (`compare.rs`), kept out of `ipc.ts` for its
// line cap. Types and thin wrappers only; the words live in the frontend.

/** What `compare_tile_answer` gives (Rust `compare::CompareAnswer`). An
 *  absent field is `undefined`. `vendor` is absent only with
 *  `conversation: "none"` (not a recorded Claude or Codex tile). `turn`
 *  is the current turn; `answer` the newest finished one beside it. */
export type CompareAnswer = {
  vendor?: "claude" | "codex";
  /** `unstarted`: a Codex tile whose conversation hasn't begun (none
   *  claimed, none it could be in). `ambiguous`: there are candidates and
   *  Plyloft can't tell which is this tile's. */
  conversation: "known" | "ambiguous" | "unstarted" | "none";
  title?: string;
  turn: "open" | "done" | "none";
  answer?: string;
  answerKind?: "text" | "plan";
  finishedAtMs?: number;
  /** The answer's length in characters, as given (after any cut). */
  chars?: number;
  /** Cut at 16,000 characters, ending in the cut line. */
  cut: boolean;
  /** The newest turn ended without an answer of its own (stopped, an API
   *  or usage-limit error, a Codex turn with no message): `answer` is an
   *  earlier turn's. Always present. */
  fromEarlierTurn?: boolean;
  /** Claude: the answer is the open turn's own plan, still waiting for its
   *  approval menu. Absent when not. */
  planPending?: boolean;
  /** 1.179.0, Claude: its newest turn ended on a plan the transcript can't
   *  give back, so no answer is offered (never an older plan). Absent when
   *  not. */
  planUnread?: boolean;
  /** 1.179.0, "Include my question": the member's own messages of the
   *  answer's turn, raw (text Compare passed is still in them: the window
   *  takes it out against its passes). Memory only: never logged, never
   *  persisted. Absent when there is no answer. */
  turnAsks?: CompareTurnAsks;
};

/** Rust `compare::TurnAsks`. `known`: the messages in order, together at
 *  most 16,000 characters (`cut`: more were there, and are left out).
 *  `unknown`: the question must be left out, for `why`. */
export type CompareTurnAsks =
  | { status: "known"; messages: CompareTurnAsk[]; cut: boolean }
  | { status: "unknown"; why: CompareAsksUnknown };

/** One message of the member's (Rust `compare::Ask`). */
export type CompareTurnAsk = {
  text: string;
  /** When the CLI's file stamped it (ms since the epoch), when it says. */
  atMs?: number;
  kind: "prompt" | "queued" | "steer" | "plan-feedback" | "feedback";
};

/** Why the question is left out (Rust `compare::AsksUnknown`). */
export type CompareAsksUnknown =
  | "start-not-read"
  | "command"
  | "not-typed"
  | "queued-start"
  | "feedback-unread"
  | "compacted"
  | "unknown-message";

/** The pieces in the frontend's own words (Rust `compare::PasteParts`). */
export type ComparePasteParts = {
  lead?: string;
  fromLabel: string;
  answer: string;
  note?: string;
  noteLabel: string;
  /** 1.179.0: the member's words, passed text already taken out. Absent or
   *  blank: no question block, and the text exactly as before. */
  question?: string;
  /** `My question to Claude:` / `My question to Codex:`. */
  questionLabel?: string;
  /** `turnAsks.cut`: the question goes with its cut line whatever its room. */
  questionCut?: boolean;
};

/** What `compare_prepare_paste` gives (Rust `compare::PreparedPaste`): the
 *  text written and what it holds, so the preview and the write match. */
export type ComparePreparedPaste = {
  /** What is written; empty when the answer is blank once cleaned. */
  text: string;
  /** The question exactly as it goes (cleaned, cut), without its label;
   *  absent when none was given, it was blank, or it was left out. */
  question?: string;
  questionCut: boolean;
  /** A question was given but left out for room. */
  questionLeftOut: boolean;
  /** The lead, labels and note made the backend cut the answer. */
  answerCut: boolean;
};

/** The tile's conversation looked at again, then its last finished answer. */
export function compareTileAnswer(ptyId: string): Promise<CompareAnswer> {
  return invoke<CompareAnswer>("compare_tile_answer", { ptyId });
}

/** One text, cleaned and capped at 16,000 characters, starting with a space
 *  (`text` empty when the answer is blank once cleaned), and what it holds. */
export function comparePreparePaste(parts: ComparePasteParts): Promise<ComparePreparedPaste> {
  return invoke<ComparePreparedPaste>("compare_prepare_paste", { parts });
}
