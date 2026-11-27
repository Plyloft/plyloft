import { closingAtDone, followingSessions, sessionInUse, sessionKey, workOnPrSince } from "../lib/builderAtDone";
import { sessionClosedLine } from "../lib/deliveryWords";
import { builderTypedAt, useBuilder } from "./builderStore";
import { useKanban } from "./kanbanStore";
import { pushToast, UNDO_TOAST_MS, useToasts } from "./toastStore";

/**
 * G11 (1.170.0): Plyloft closes a card's Builder session once the card is
 * Done — its pull request merged (watched here, for every loaded board) or
 * the card shipped on this Mac (`OutcomeScreen`'s Ship) — with Undo in
 * the toast. The close waits for the toast: while it shows, Undo keeps the
 * session as it is (nothing to resume — after a ship here its folder may be
 * gone); once it has gone without Undo, the session closes. A session in
 * use — its turn running, a question in view, or typed into since it began
 * following — is left open and nothing is said, both before the toast and
 * again before the close. Session-only:
 * nothing here is persisted (sessions don't outlive Plyloft).
 */

/** The cards whose close waits for its toast. */
const pending = new Set<string>();
/** Sessions seen following an open pull request (`sessionKey`), and since
 *  when. */
const following = new Map<string, number>();
const POLL_MS = 250;
/** How long the toast waits for the one on screen (the ship's own "Shipped"
 *  line) before it covers it: an Undo takes the screen at once, and a plain
 *  toast it covers is gone. */
const SCREEN_WAIT_MS = 6500;

/** `run` once nothing is on screen, or after `SCREEN_WAIT_MS` at most. */
function whenScreenFree(run: () => void): void {
  if (useToasts.getState().toasts.length === 0) {
    run();
    return;
  }
  const since = Date.now();
  const timer = setInterval(() => {
    if (useToasts.getState().toasts.length > 0 && Date.now() - since < SCREEN_WAIT_MS) return;
    clearInterval(timer);
    run();
  }, POLL_MS);
}

function cardOf(workspaceId: string, cardId: string) {
  return useKanban.getState().byWorkspace[workspaceId]?.cards.find((c) => c.id === cardId) ?? null;
}

/** G11: the session follows this card's pull request (Ship just opened it). */
export function followBuilderSession(cardId: string, ptyId: string | null | undefined): void {
  if (ptyId) startFollowing(sessionKey(cardId, ptyId));
}

function startFollowing(key: string): void {
  if (!following.has(key)) following.set(key, Date.now());
}

/** The session is the card's live one and in use (`sessionInUse`). */
function inUse(cardId: string, ptyId: string, since: number): boolean {
  const rt = useBuilder.getState().byCard[cardId];
  if (rt && rt.ptyId !== ptyId) return false;
  return sessionInUse(rt, builderTypedAt(cardId), since);
}

/** Close the card's open Builder session with Undo, naming the card
 *  (1.171.0 B2, DL-37): "“Notes” is merged, so its Builder session was
 *  closed." — `why`: its pull request merged, or it shipped on this Mac. The toast waits for the one on screen (a ship's "Shipped"
 *  line); the close happens once it has gone without Undo, and only if the
 *  session is still the one it was and not in use. `since`: when the
 *  session began following (a ship here: now). */
export function closeBuilderWithUndo(
  workspaceId: string,
  cardId: string,
  why: "merged" | "shipped" = "merged",
  since: number = Date.now(),
): void {
  const card = cardOf(workspaceId, cardId);
  const ptyId = card?.builder?.ptyId;
  if (!card || !ptyId || pending.has(cardId)) return;
  pending.add(cardId);
  whenScreenFree(() => askToClose(workspaceId, cardId, sessionClosedLine(card.title, why), ptyId, since));
}

function askToClose(workspaceId: string, cardId: string, line: string, ptyId: string, since: number): void {
  // In use: left open, nothing said.
  if (inUse(cardId, ptyId, since)) {
    pending.delete(cardId);
    return;
  }
  let undone = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const settle = () => {
    if (timer) clearInterval(timer);
    timer = null;
    pending.delete(cardId);
  };
  const toastId = pushToast({
    kind: "info",
    title: line,
    action: {
      label: "Undo",
      ttlMs: UNDO_TOAST_MS,
      onClick: () => {
        undone = true;
        settle();
      },
    },
  });
  timer = setInterval(() => {
    const { toasts, queue } = useToasts.getState();
    if (toasts.some((t) => t.id === toastId) || queue.some((t) => t.id === toastId)) return;
    settle();
    if (undone) return;
    // The session it was about: not one that ended or was opened again.
    if (cardOf(workspaceId, cardId)?.builder?.ptyId !== ptyId) return;
    if (inUse(cardId, ptyId, since)) return;
    void useBuilder.getState().close(workspaceId, cardId);
  }, POLL_MS);
}

let stop: (() => void) | null = null;

/** G11: watch every loaded board for a pull request merged under a session
 *  that followed it. Once, from App. */
export function startBuilderAtDone(): () => void {
  if (stop) return stop;
  const check = () => {
    for (const [workspaceId, board] of Object.entries(useKanban.getState().byWorkspace)) {
      if (!board?.loaded) continue;
      for (const key of followingSessions(board.cards)) startFollowing(key);
      for (const { cardId, ptyId } of closingAtDone(board.cards, following)) {
        const key = sessionKey(cardId, ptyId);
        // 1.171.0 B walk: what was typed before the fix that is on the
        // pull request is done work (a merge from the card's Merge after a
        // fix round closed nothing: the typing counted as "in use").
        const card = board.cards.find((c) => c.id === cardId);
        const sent = card ? workOnPrSince(card) : null;
        const since = Math.max(following.get(key) ?? Date.now(), sent ?? 0);
        following.delete(key);
        closeBuilderWithUndo(workspaceId, cardId, "merged", since);
      }
    }
  };
  check();
  const off = useKanban.subscribe(check);
  stop = () => {
    off();
    stop = null;
  };
  return stop;
}

/** Tests: start again. */
export function resetBuilderAtDoneForTests(): void {
  stop?.();
  pending.clear();
  following.clear();
}
