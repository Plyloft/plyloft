// 1.171.0 C2 (CF3, CF16; owner D10): when the card's wait after Finish and
// check started, so Now's title can say the state word with how long it has
// run ("Claude is re-reading its work · 1m 20s", "Challenger reviewing · 3m 5s") in
// place of the session's "Claude · working", which read as the press being
// ignored. The word alone is what the live region and the Board say; the
// sentence (`presentCard`) says what is happening and that the person can
// leave.
//
// Pure: node runs `waitLine.test.ts`.
import type { CardPresentationState, KanbanCard } from "../ipc.ts";
import type { PresentationRule } from "./cardPresentation.ts";
import { selfCheckWhat } from "./deliveryWords.ts";

export type WaitLine = {
  /** The state word (the card's headline). */
  what: string;
  /** When the wait started; null when not known (no time is said). */
  since: number | null;
};

/** The card's wait after Finish and check, or null when it waits on
 *  nothing (or another rule speaks). */
export function waitLine(input: {
  rule: PresentationRule;
  state: CardPresentationState;
  /** The card's headline (`presentCard(...).headline`). */
  headline: string;
  card: Pick<KanbanCard, "builder">;
  /** The self-check Finish and check waits on (`SessionFacts.selfCheck`). */
  selfCheck?: { since: number; delivered: boolean } | null;
}): WaitLine | null {
  const builder = input.card.builder ?? null;
  if (input.rule === "finishing") {
    // 1.175.0 F9: during the self-check the title says who does what
    // ("Claude is re-reading its work · 1m 20s"); the Board keeps the word.
    const ai = builder?.vendor === "codex" ? "Codex" : "Claude";
    const what = input.selfCheck ? selfCheckWhat(ai, input.selfCheck.delivered) : input.headline;
    return { what, since: input.selfCheck?.since ?? null };
  }
  if (input.rule !== "base") return null;
  const review = builder?.review ?? null;
  if (input.state === "challenger-reviewing" && review?.status === "running") {
    return { what: input.headline, since: review.at };
  }
  if (input.state === "checking") {
    // The checks start right after the save that recorded the last version
    // (`useVerify.start` follows `builder_done`); the verify job's own
    // `startedAt` is its current step's, so the save is the whole run's start.
    const snapshots = builder?.snapshots ?? [];
    return { what: input.headline, since: snapshots[snapshots.length - 1]?.at ?? null };
  }
  return null;
}
