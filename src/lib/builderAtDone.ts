// G11 (1.170.0): the Builder session follows the pull request. Nothing asks
// "Keep this card's Builder session open?" after a ship any more: while the
// card's pull request is open its session stays (a failed check, a review or
// an edit of the pull request goes to it); once the pull request is merged —
// the card is Done — Plyloft closes it, with Undo in the toast. A ship on
// this Mac closes it at once, with Undo too. Pure; the tests are
// `src/test/builderAtDone.test.tsx`.
import type { KanbanCard } from "../ipc";

type SessionCard = Pick<KanbanCard, "id"> & Partial<Pick<KanbanCard, "builder" | "pr" | "archived">>;

/** One Builder session of one card: a resumed session is another one. */
export function sessionKey(cardId: string, ptyId: string): string {
  return `${cardId}\u0000${ptyId}`;
}

/** The sessions that follow their card's open pull request. */
export function followingSessions(cards: readonly SessionCard[]): string[] {
  return cards
    .filter((c) => c.pr?.state === "open" && c.builder?.ptyId)
    .map((c) => sessionKey(c.id, c.builder!.ptyId!));
}

/** The sessions to close at Done: a session that followed the pull request
 *  (seen while it was open) on a card whose pull request is merged now. A
 *  session opened after the merge (Resume on a Done card) is the person's
 *  own and is never closed by Plyloft. */
export function closingAtDone(
  cards: readonly SessionCard[],
  following: { has(key: string): boolean },
): { cardId: string; ptyId: string }[] {
  return cards
    .filter((c) => c.pr?.state === "merged" && c.builder?.ptyId && following.has(sessionKey(c.id, c.builder.ptyId)))
    .map((c) => ({ cardId: c.id, ptyId: c.builder!.ptyId! }));
}

/** 1.171.0 B walk: when the work typed into a session reached the pull
 *  request — the snapshot (Finish and check) that is its head, or the one
 *  Plyloft sent to it. Typing before that is done work, not a session in
 *  use: a fix round (type, Finish and check, Send the fixes, Merge) closes
 *  at Done like any other. Null when no snapshot is on it. */
export function workOnPrSince(card: SessionCard): number | null {
  const pr = card.pr;
  if (!pr) return null;
  const heads = [pr.headSha, pr.pushedHead].filter((h): h is string => Boolean(h));
  // An empty sha names no commit: it never matches a head.
  const on = (sha: string) => sha.length > 0 && heads.some((h) => h.startsWith(sha) || sha.startsWith(h));
  const snapshots = card.builder?.snapshots ?? [];
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (on(snapshots[i].sha)) return snapshots[i].at;
  }
  return null;
}

/** G11 (Challenger): a session Plyloft leaves open at Done, saying
 *  nothing — its turn isn't over (or no scan said so yet), a question is in
 *  view, or the person typed into it since it began following (`since`). */
export function sessionInUse(
  rt: { turnIdle?: boolean; questionInView?: boolean } | undefined,
  typedAt: number | undefined,
  since: number,
): boolean {
  if (!rt) return false;
  return rt.turnIdle !== true || rt.questionInView === true || (typedAt !== undefined && typedAt >= since);
}

// The toast's words are `deliveryWords.ts::sessionClosedLine` (1.171.0 B2).
