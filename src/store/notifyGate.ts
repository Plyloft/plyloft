import { sendNative } from "../lib/agentNotifier";
import { admit, EMPTY_GATE, flushGate, heldWords, type Gate } from "../lib/notifyGate";
import { armTarget, personAway, type NotifyTarget } from "../lib/notifyTarget";
import { nativeDialogOpen } from "../lib/nativeDialog";
import { notificationsAllowed } from "./notificationAccessCache";

/**
 * QoL 1.168 (Challenger 3, 4): the one way the window sends a notification —
 * through the shared gate (`lib/notifyGate.ts`: one card once a minute,
 * whichever notifier; a burst held and counted) — and the one place a sent
 * one leaves its target for a click (`lib/notifyTarget.ts`): only while the
 * person is away and the system lets notifications through.
 */
let gate: Gate = EMPTY_GATE;

function away(): boolean {
  return personAway(typeof document === "undefined" ? null : document, nativeDialogOpen());
}

function send(words: { title: string; body: string }, target: NotifyTarget | null): void {
  const wasAway = away();
  void sendNative(words.title, words.body)
    .then((sent) => {
      if (sent && wasAway && target && notificationsAllowed()) armTarget(target, Date.now());
    })
    .catch(() => {});
}

export function gatedNotify(
  n: { cardKey: string | null; title: string; body: string; target: NotifyTarget | null },
  now: number = Date.now(),
): void {
  const { ok, next } = admit(gate, n.cardKey, now);
  gate = next;
  if (ok) send(n, n.target);
}

/** From App's tick: the updates a burst held, as one banner opening the
 *  Inbox once there is room. */
export function flushNotifyGate(now: number, inboxWorkspace: string | null): void {
  const { summary, next } = flushGate(gate, now);
  gate = next;
  if (summary == null) return;
  send(heldWords(summary), inboxWorkspace ? { kind: "inbox", workspaceId: inboxWorkspace } : null);
}

export function resetNotifyGateForTests(): void {
  gate = EMPTY_GATE;
}
