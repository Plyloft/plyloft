// UX-5.7: the Board's search and filters — one predicate the columns and
// the List both use, so they always show the same cards. Pure.
import type { KanbanCard } from "../ipc.ts";
import type { AttentionColumn } from "./boardSemantics.ts";
import type { BoardBuilder } from "./boardList.ts";

export interface BoardFilter {
  /** "Find a card": words of the title or the notes, or an issue number. */
  query: string;
  /** The Needs you quick filter (the Board had it before the columns). */
  needsYouOnly: boolean;
  /** P-A: the cards' state words (`presentCard(...).headline`), so the
   *  filter offers what the cards say; empty = all. */
  states: readonly string[];
  /** Who builds it, empty = all. */
  builders: readonly BoardBuilder[];
}

export const EMPTY_BOARD_FILTER: BoardFilter = {
  query: "",
  needsYouOnly: false,
  states: [],
  builders: [],
};

export function boardFilterActive(filter: BoardFilter): boolean {
  return (
    filter.query.trim() !== "" ||
    filter.needsYouOnly ||
    filter.states.length > 0 ||
    filter.builders.length > 0
  );
}

/** How many filters (not the search) are on — the filter button's count. */
export function boardFilterCount(filter: BoardFilter): number {
  return (filter.needsYouOnly ? 1 : 0) + filter.states.length + filter.builders.length;
}

/** Every word of the query is in the title or the notes; "#42" or "42"
 *  also finds issue #42. Case and accents do not matter. */
export function boardQueryMatches(
  card: Pick<KanbanCard, "title" | "notes" | "ghIssueNumber">,
  query: string,
): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  const issue = /^#?(\d+)$/.exec(q);
  if (issue && card.ghIssueNumber === Number(issue[1])) return true;
  const haystack = fold(`${card.title}\n${card.notes ?? ""}`);
  return q.split(/\s+/).every((word) => haystack.includes(word.replace(/^#/, "")));
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** What the filter reads of a card, derived once by the caller. */
export interface BoardFilterFacts {
  column: AttentionColumn;
  /** The card's headline (`presentCard`). */
  state: string;
  builder: BoardBuilder;
}

export function boardCardMatches(
  card: Pick<KanbanCard, "title" | "notes" | "ghIssueNumber">,
  facts: BoardFilterFacts,
  filter: BoardFilter,
): boolean {
  if (filter.needsYouOnly && facts.column !== "needs-you") return false;
  if (filter.states.length > 0 && !filter.states.includes(facts.state)) return false;
  if (filter.builders.length > 0 && !filter.builders.includes(facts.builder)) return false;
  return boardQueryMatches(card, filter.query);
}
