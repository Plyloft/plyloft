/**
 * QoL 1.168: what the person is looking at is seen.
 *
 * - F6: a card's page open over its Board marks that card's unseen Needs you
 *   rows seen, as opening its Inbox row does — the person who works from the
 *   Board read the review there. (1.173.0 F1: seen is not resolved; the row
 *   still counts until the card resolves it — seen keeps notifications quiet.)
 * - D7: a Claude or Codex tile whose turn ended while its workspace's
 *   Terminals were in front (the tile on the grid, or the one expanded) is a
 *   turn seen: it stops counting as needing the person.
 *
 * `onScreen` is null while Plyloft is hidden or not in front, so nothing is
 * seen then. Pure: App's tick calls it with the stores' state.
 */
import type { InboxFeed } from "../ipc";
import type { WaitingSession } from "./needsYou.ts";

export type OnScreen = {
  workspaceId: string;
  /** The workspace's centre mode (`effectiveCenterMode`). */
  mode: string;
  /** The card whose page is open over the Board, if any. */
  cardId: string | null;
  /** The tile expanded over the grid, if any: then only it is on screen. */
  expandedTileId: string | null;
} | null;

/** F6: the card rows the open card page shows the person. */
export function cardRowsSeenOnScreen(feed: InboxFeed | null, onScreen: OnScreen): string[] {
  if (!feed || !onScreen || onScreen.mode !== "board" || !onScreen.cardId) return [];
  const out: string[] = [];
  for (const e of feed.events) {
    if (e.workspaceId !== onScreen.workspaceId || e.cardId !== onScreen.cardId) continue;
    if (e.group !== "needs_you") continue;
    if (!e.seenEligible || e.seenAt != null) continue;
    out.push(e.id);
  }
  return out;
}

/** D7: the tiles' finished turns in front of the person. */
export function tilesSeenOnScreen(
  waiting: readonly WaitingSession[],
  onScreen: OnScreen,
): { tileId: string; episode: string }[] {
  if (!onScreen || onScreen.mode !== "terminals") return [];
  const out: { tileId: string; episode: string }[] = [];
  for (const s of waiting) {
    if (s.workspaceId !== onScreen.workspaceId || s.target.kind !== "tile") continue;
    if (s.episode == null || s.muted) continue;
    if (onScreen.expandedTileId != null && onScreen.expandedTileId !== s.target.tileId) continue;
    out.push({ tileId: s.target.tileId, episode: s.episode });
  }
  return out;
}

