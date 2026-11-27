// 1.176.2 F2 (A5F-03): an outward press runs once at a time. The slot is
// taken synchronously, before the press's first await, so a double click,
// Enter held or two controls reaching the same press in one frame start one
// run; React state (a `busy` flag) can't do that, because a click already
// queued in the frame reads the state from before. Module-level, not a
// component ref: the card's Now and its Ship step are different mounts, and
// a surface closed and opened again mid-press is a new mount.
import { useSyncExternalStore } from "react";
import { pushToast } from "../store/toastStore";

/** key → when its press started (ms). */
const running = new Map<string, number>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

/** Runs `fn` unless a press with the same key is still running; the second
 *  press does nothing and resolves `undefined`, after calling `busy` with how
 *  long the running one has been going. The slot is freed however `fn` ends:
 *  returned, threw or was cancelled by an early return. */
export async function pressOnce<T>(
  key: string,
  fn: () => Promise<T>,
  busy?: (sinceMs: number) => void,
): Promise<T | undefined> {
  const at = running.get(key);
  if (at !== undefined) {
    busy?.(Date.now() - at);
    return undefined;
  }
  running.set(key, Date.now());
  changed();
  try {
    return await fn();
  } finally {
    running.delete(key);
    changed();
  }
}

/** Whether a press with this key is running now. */
export function pressRunning(key: string): boolean {
  return running.has(key);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a press with this key is running, kept current — a surface opened
 *  again mid-press shows it busy. */
export function usePressRunning(key: string): boolean {
  return useSyncExternalStore(subscribe, () => running.has(key));
}

/** A press made this long after the running one is the person's, not a
 *  double click: it is answered. */
export const STILL_RUNNING_AFTER_MS = 1000;

/** `busy` for `pressOnce`: an info toast saying `title`, for a press made
 *  more than a second after the running one (a double click stays quiet). */
export function sayStillRunning(title: string): (sinceMs: number) => void {
  return (sinceMs) => {
    if (sinceMs > STILL_RUNNING_AFTER_MS) pushToast({ kind: "info", title });
  };
}

/** The key of a card's Ship press. */
export function shipPressKey(workspaceId: string, cardId: string): string {
  return `ship:${workspaceId}:${cardId}`;
}

/** The key of a card pull request's Merge and Merge when checks pass (the
 *  card's Shipping section, its Now and the Inbox row share it). */
export function prMergePressKey(workspaceId: string, cardId: string): string {
  return `pr-merge:${workspaceId}:${cardId}`;
}

/** The key of a card's Send the fixes to GitHub (its Shipping section, its
 *  Now, a pull request review's panel and the fixing-by-itself loop share it). */
export function prPushPressKey(workspaceId: string, cardId: string): string {
  return `pr-push:${workspaceId}:${cardId}`;
}

/** The key of a project's Stop sharing. */
export function stopSharingPressKey(workspaceId: string): string {
  return `stop-sharing:${workspaceId}`;
}

/** The key of a project's Share it again. */
export function shareAgainPressKey(workspaceId: string): string {
  return `share-again:${workspaceId}`;
}

/** The key of a project's release press: per project, as the backend's ship
 *  lock and the drain are — whichever Release sheet, open or reopened. */
export function releasePressKey(workspaceId: string): string {
  return `release:${workspaceId}`;
}

/** What a press made while the same one runs says (STRINGS.md 1.176.2 F2). */
export const shippingStillRunning = (title: string) => `Shipping “${title}” is still running.`;
export const MERGE_STILL_RUNNING = "That merge is still running.";
export const PUSH_STILL_RUNNING = "Sending the fixes to GitHub is still running.";
export const STOP_SHARING_STILL_RUNNING = "Stop sharing is still running.";
export const SHARE_AGAIN_STILL_RUNNING = "Sharing the setup again is still running.";
export const RELEASE_STILL_RUNNING = "The release is still running.";

/** Test-only: every slot freed. A test whose press never settles (an IPC
 *  left unanswered) would otherwise hold its key into the next test; in the
 *  app every press settles (its sheets answer, its IPCs time out). */
export function resetPressesForTests(): void {
  running.clear();
  changed();
}
