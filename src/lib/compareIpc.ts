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
};

/** The pieces in the frontend's own words (Rust `compare::PasteParts`). */
export type ComparePasteParts = {
  lead?: string;
  fromLabel: string;
  answer: string;
  note?: string;
  noteLabel: string;
};

/** The tile's conversation looked at again, then its last finished answer. */
export function compareTileAnswer(ptyId: string): Promise<CompareAnswer> {
  return invoke<CompareAnswer>("compare_tile_answer", { ptyId });
}

/** One text, cleaned and capped at 16,000 characters, starting with a space;
 *  an empty string when the answer is blank once cleaned. */
export function comparePreparePaste(parts: ComparePasteParts): Promise<string> {
  return invoke<string>("compare_prepare_paste", { parts });
}
