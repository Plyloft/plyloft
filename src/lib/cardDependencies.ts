// C7 (UX-7.1 … 7.3): card dependencies — a card waits for other cards of its
// workspace (`KanbanCard.blockedBy`). Pure, so node runs it
// (`src/lib/cardDependencies.test.ts`); the backend mirrors the same rules in
// `kanban.rs` (`unshipped_blockers`, `start_refusal_message`,
// `blocking_cycle`) and stays the authority: it refuses a held start and a
// cycle whatever the page shows.
//
// The rules:
// - A blocker holds a card back until it lands (its pull request merged, or
//   shipped on this Mac). 1.174.0 A2: a pull request still open is sent,
//   not landed — the card waits for it to merge ("Waits for “A” to merge").
//   An archived blocker holds no one back; a deleted one leaves every
//   Blocked by (the backend prunes it; an id with no card is ignored here).
// - Only a card that has not started is held (Todo, drafting or ready): its
//   Plan and Start are off, with the reason, and it sits in Waiting.
// - When its last blocker lands it is ready — in Needs you, "Ready to start"
//   — and nothing starts it: Ply never starts paid work on its own.
// - A dependency that would close a cycle is refused when it is written.
import type { CardPresentationState, KanbanCard } from "../ipc.ts";
import { cardDelivery, cardLanded } from "./cardLifecycle.ts";

export { cardLanded };

type DepCard = Pick<
  KanbanCard,
  "id" | "title" | "blockedBy" | "archived" | "shipStatus" | "reviewStatus" | "ghIssueNumber" | "columnId"
> &
  Partial<Pick<KanbanCard, "pr" | "prUrl">>;

/** The blockers still holding `card` back, in its order. */
export function unshippedBlockers<T extends DepCard>(card: DepCard, cards: readonly T[]): T[] {
  const out: T[] = [];
  for (const id of card.blockedBy ?? []) {
    const blocker = cards.find((c) => c.id === id);
    if (blocker && !blocker.archived && !cardLanded(blocker)) out.push(blocker);
  }
  return out;
}

/** The blockers `card` names that are still cards on this board. */
export function blockersOf<T extends DepCard>(card: DepCard, cards: readonly T[]): T[] {
  return (card.blockedBy ?? [])
    .map((id) => cards.find((c) => c.id === id))
    .filter((c): c is T => Boolean(c));
}

/** 1.174.0 (C2, BCI-11): the facts line says "Blocked by" only when the
 *  card names a blocker that is still a card here — never "Nothing · Add";
 *  a blocker is added under Change…. */
export function blockedByShown(card: DepCard, cards: readonly DepCard[]): boolean {
  return blockersOf(card, cards).length > 0;
}

/** The press under Change… that picks a card to wait for. */
export const ADD_BLOCKER_LABEL = "Add a blocker";

/** The cards that wait for `card`. */
export function dependentsOf<T extends DepCard>(card: DepCard, cards: readonly T[]): T[] {
  return cards.filter((c) => c.id !== card.id && (c.blockedBy ?? []).includes(card.id));
}

/** States in which a card has not started, so a blocker holds it. */
const HOLDABLE: ReadonlySet<CardPresentationState> = new Set(["draft", "ready"]);

/** UX-7.2: the card is held — it has not started, and a blocker has not
 *  landed. */
export function isHeld(card: DepCard, cards: readonly DepCard[], state: CardPresentationState): boolean {
  return (
    !card.archived &&
    card.columnId === "todo" &&
    HOLDABLE.has(state) &&
    unshippedBlockers(card, cards).length > 0
  );
}

/** How a blocker is named: its issue, else its title in quotes. */
export function blockerName(card: Pick<KanbanCard, "title" | "ghIssueNumber">): string {
  return card.ghIssueNumber ? `#${card.ghIssueNumber}` : `“${card.title}”`;
}

/** The disabled Start's reason (the backend says the same words). */
export function startRefusal(
  blockers: readonly (Pick<KanbanCard, "title"> &
    Partial<Pick<KanbanCard, "pr" | "prUrl" | "shipStatus" | "reviewStatus">>)[],
): string | null {
  if (blockers.length === 0) return null;
  // 1.174.0 A2: blockers all in open pull requests merge (as blockedByLine).
  const merge = blockers.every(inOpenPr);
  const first = blockers[0].title;
  if (blockers.length === 1) return merge ? `Starts when “${first}” merges.` : `Starts when “${first}” ships.`;
  return merge
    ? `Starts when “${first}” and ${blockers.length - 1} more merge.`
    : `Starts when “${first}” and ${blockers.length - 1} more ship.`;
}

/** A blocker sent, not landed, its pull request read open. */
function inOpenPr(b: Partial<Pick<KanbanCard, "pr" | "prUrl" | "shipStatus" | "reviewStatus">>): boolean {
  return cardDelivery({ shipStatus: b.shipStatus ?? "unshipped", reviewStatus: b.reviewStatus ?? null, ...b }) === "sent" && b.pr?.state === "open";
}

/** The Board card's fact line and the List's Status: "Blocked by #12".
 *  1.174.0 A2 (P7): a blocker in a pull request still open (sent, not
 *  landed) is waited for until it merges: "Waits for “A” to merge". */
export function blockedByLine(
  blockers: readonly (Pick<KanbanCard, "title" | "ghIssueNumber" | "shipStatus" | "reviewStatus"> &
    Partial<Pick<KanbanCard, "pr" | "prUrl">>)[],
): string | null {
  if (blockers.length === 0) return null;
  const first = blockerName(blockers[0]);
  if (blockers.every(inOpenPr)) {
    return blockers.length === 1
      ? `Waits for ${first} to merge`
      : `Waits for ${first} and ${blockers.length - 1} more to merge`;
  }
  return blockers.length === 1
    ? `Blocked by ${first}`
    : `Blocked by ${first} and ${blockers.length - 1} more`;
}

/** Would `cardId` waiting for `blockerId` close a cycle — does the blocker,
 *  through its own blockers, already wait for the card? */
export function wouldCycle(cards: readonly DepCard[], cardId: string, blockerId: string): boolean {
  if (blockerId === cardId) return true;
  const stack = [blockerId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === cardId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const c = cards.find((x) => x.id === id);
    if (c) stack.push(...(c.blockedBy ?? []));
  }
  return false;
}

/** UX-7.3: the cards the picker offers — this workspace's, not the card
 *  itself, not archived, not already a blocker, not one that would close a
 *  cycle — matching the search in the title or `#n`. */
export function blockerCandidates<T extends DepCard>(
  card: DepCard,
  cards: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  const already = new Set(card.blockedBy ?? []);
  return cards.filter(
    (c) =>
      c.id !== card.id &&
      !c.archived &&
      !already.has(c.id) &&
      !wouldCycle(cards, card.id, c.id) &&
      (q === "" ||
        c.title.toLowerCase().includes(q) ||
        (c.ghIssueNumber != null && String(c.ghIssueNumber).startsWith(q))),
  );
}
