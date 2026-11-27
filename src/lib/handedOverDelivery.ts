/**
 * GH #129: delivering a request for changes a hand-over left unsent. The
 * card only says the findings were sent once they reached the Builder's
 * PTY: a message held for the prompt is `queued`, a write that fails or a
 * session that ends first is `failed`, and either can be sent again. Pure —
 * no Tauri import — so it is unit-tested under node.
 */

export type HandedOverDeliveryState = "queued" | "sent" | "failed";

/** One delivery of one hand-over (`HandedOverRequest.at`) into one Builder
 *  session (`ptyId`). In memory: a new session has not received it. */
export interface HandedOverDelivery {
  handedOverAt: number;
  ptyId: string;
  state: HandedOverDeliveryState;
  error?: string;
}

export interface DeliverDeps {
  /** The live session and whether it is at its prompt, or null. */
  session(): { ptyId: string; idle: boolean } | null;
  /** Write into the PTY now. */
  write(ptyId: string, text: string): Promise<void>;
  /** Hold `text` for the prompt: resolves once it is written, rejects when
   *  the write fails or the session ends first. */
  queue(text: string): Promise<void>;
  report(delivery: HandedOverDelivery): void;
}

export const SESSION_ENDED_ERROR = "The Builder session ended before the findings reached it.";

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.trim() || "The findings could not be written into the Builder session.";
}

/** Deliver `text` for the hand-over made at `handedOverAt`, reporting each
 *  step. Resolves with how it ended; `null` when no session is open. */
export async function deliverHandedOver(
  text: string,
  handedOverAt: number,
  deps: DeliverDeps,
): Promise<HandedOverDeliveryState | null> {
  const session = deps.session();
  if (!session) return null;
  const base = { handedOverAt, ptyId: session.ptyId };
  let pending: Promise<void>;
  if (session.idle) {
    pending = deps.write(session.ptyId, text);
  } else {
    deps.report({ ...base, state: "queued" });
    pending = deps.queue(text);
  }
  try {
    await pending;
  } catch (error) {
    deps.report({ ...base, state: "failed", error: reason(error) });
    return "failed";
  }
  deps.report({ ...base, state: "sent" });
  return "sent";
}

/** The delivery that counts for this hand-over in this session, or null. */
export function deliveryFor(
  delivery: HandedOverDelivery | null | undefined,
  handedOverAt: number,
  ptyId: string | null | undefined,
): HandedOverDelivery | null {
  if (!delivery || !ptyId) return null;
  return delivery.handedOverAt === handedOverAt && delivery.ptyId === ptyId ? delivery : null;
}

/** Per-card waiters for messages held until the Builder's prompt: taken
 *  as a batch when the held messages are flushed (or discarded), so a
 *  message queued after a flush began is not settled by it. */
export class HeldMessageWaiters {
  private byCard = new Map<string, Array<{ resolve: () => void; reject: (e: unknown) => void }>>();

  wait(cardId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const list = this.byCard.get(cardId) ?? [];
      list.push({ resolve, reject });
      this.byCard.set(cardId, list);
    });
  }

  /** Take the card's current waiters; settle them with the result. */
  take(cardId: string): (error?: unknown) => void {
    const list = this.byCard.get(cardId) ?? [];
    this.byCard.delete(cardId);
    return (error?: unknown) => {
      for (const waiter of list) {
        if (error === undefined) waiter.resolve();
        else waiter.reject(error);
      }
    };
  }
}
