/**
 * 1.172.0 (A1): the words of a card's later requests — what the person told
 * the Builder after the first result (`KanbanCard.laterRequests`), listed
 * under What you want and read by the Challenger with the brief. Pure, so
 * the words are tested once (`laterRequests.test.ts`).
 */
import type { LaterRequest, LaterRequestSource } from "../ipc.ts";
import { dayWords } from "./cardPage.ts";

/** "Asked later (2)". */
export function laterRequestsHeading(n: number): string {
  return `Asked later (${n})`;
}

/** The line under the heading. */
export const LATER_REQUESTS_INTRO =
  "What you told the Builder after the first result. The Reviewer checks the work against these too.";

export const LATER_REQUEST_REMOVE_LABEL = "Remove";
export const LATER_REQUEST_REMOVE_TITLE =
  "The Builder already has it. Removed, the Reviewer no longer counts it as something you asked for.";

/** The Remove button's name: `Remove "<its first words>"`. */
export function laterRequestRemoveName(text: string): string {
  const words = text.trim().replace(/\s+/g, " ");
  const short = words.length > 40 ? `${words.slice(0, 40).trimEnd()}…` : words;
  return `Remove "${short}"`;
}

/** Where it was asked, in the button's own words; nothing for a source a
 *  newer app wrote. */
export function laterRequestSourceWords(source: LaterRequestSource): string | null {
  switch (source) {
    case "notRight":
      return "Not right";
    case "changes":
      return "Request changes";
    case "chat":
      return "Ask about this card";
    default:
      return null;
  }
}

/** "27 Oct, 21:14 · from Ask about this card". */
export function laterRequestMeta(r: Pick<LaterRequest, "at" | "source">, now: number): string {
  const d = new Date(r.at);
  const time = `${dayWords(r.at, now)}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const from = laterRequestSourceWords(r.source);
  return from ? `${time} · from ${from}` : time;
}
