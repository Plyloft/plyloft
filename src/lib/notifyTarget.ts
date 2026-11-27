/**
 * QoL 1.168 (F5): a click on a notification lands where it is about.
 *
 * The desktop notification plugin carries no click action, but a click
 * brings Plyloft to the front. So a notification sent while the person is
 * truly away (the window hidden or not in front, not a native dialog of
 * Plyloft's own) and that the system lets through (`notification_access`
 * says allowed) leaves its target here. When the window next comes to the
 * front (`decideOnFocus`):
 *
 * - within `AUTO_OPEN_MS`, that is the click: the target opens (the card, the
 *   session, the tile expanded, the Inbox);
 * - later, up to `TARGET_MS`, it may have been anything: a toast offers
 *   "From the notification: <name> · Open" instead of moving the person;
 * - later still, nothing.
 *
 * The newest notification wins; one decided is gone; the person moving to
 * another workspace or mode themselves drops it (`dropTarget`).
 */
import { cardIdOfSessionKey, parseLaneKey } from "./buildBoth.ts";
import type { BuildLaneId } from "../ipc";

export type NotifyTarget = (
  | { kind: "card"; workspaceId: string; cardId: string }
  | { kind: "session"; workspaceId: string; cardId: string; lane?: BuildLaneId }
  | { kind: "tile"; workspaceId: string; tileId: string }
  /** Several at once: the Inbox, where they all are. */
  | { kind: "inbox"; workspaceId: string }
) & {
  /** What the offer toast names: the card's title, the tile's label. */
  name?: string;
};

/** A return to the front this soon after the notification is its click. */
export const AUTO_OPEN_MS = 20_000;
/** Up to this long, a return is offered the target in a toast. */
export const TARGET_MS = 2 * 60_000;

export type TargetSlot = { target: NotifyTarget; at: number } | null;

let slot: TargetSlot = null;

/** A notification went out while the person was away. */
export function armTarget(target: NotifyTarget, now: number): void {
  slot = { target, at: now };
}

/** The person moved on themselves: the notification is not news any more. */
export function dropTarget(): void {
  slot = null;
}

export type FocusDecision = { kind: "open"; target: NotifyTarget } | { kind: "offer"; target: NotifyTarget } | null;

/** Pure: what a return to the front does with the slot. */
export function decideOnFocus(s: TargetSlot, now: number): FocusDecision {
  if (!s || now < s.at) return null;
  const age = now - s.at;
  if (age <= AUTO_OPEN_MS) return { kind: "open", target: s.target };
  if (age <= TARGET_MS) return { kind: "offer", target: s.target };
  return null;
}

/** Plyloft came to the front: decide, and empty the slot. */
export function takeOnFocus(now: number): FocusDecision {
  const s = slot;
  slot = null;
  return decideOnFocus(s, now);
}

/** Whether the person is away from Plyloft — the window hidden or not in
 *  front — and not just in one of its own native dialogs. */
export function personAway(doc: { hidden: boolean; hasFocus(): boolean } | null, dialogOpen: boolean): boolean {
  if (!doc || dialogOpen) return false;
  return doc.hidden || !doc.hasFocus();
}

/** The target of a session notification (`waitingNotify.ts` ids:
 *  `tile:<id>` or `builder:<session key>`). */
export function sessionTarget(id: string, workspaceId: string, name?: string): NotifyTarget | null {
  const named = name ? { name } : {};
  if (id.startsWith("tile:")) return { kind: "tile", workspaceId, tileId: id.slice("tile:".length), ...named };
  if (id.startsWith("builder:")) {
    const key = id.slice("builder:".length);
    // SL-6: a build of a card built by both has its lane in the key.
    const lane = parseLaneKey(key);
    return lane
      ? { kind: "session", workspaceId, cardId: lane.cardId, lane: lane.lane, ...named }
      : { kind: "session", workspaceId, cardId: cardIdOfSessionKey(key), ...named };
  }
  return null;
}
