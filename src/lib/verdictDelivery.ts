import { codexScreenHelp, isCodexOverlayError, PASTE_STILL_UNSENT } from "./builderInject.ts";
import type { VerdictOwed } from "./challengerReview.ts";

/**
 * GH #135: delivering a settled Challenger verdict to the Builder.
 *
 * Two steps that can fail apart: the write into the PTY, and recording on
 * the card that the Builder has it. `state` is the write; `acked` is the
 * record. A write that landed is never repeated — that is what "once,
 * never twice" rests on — but an unrecorded one is told to the card again,
 * because a card that still owes a verdict sends it once more after a
 * restart.
 *
 * The verdict is never held for the prompt. GH #129's `Back to the
 * Builder` queues, because the human pressed and wants it to go; this one
 * is sent by Ply, so a message waiting in the queue could still be written
 * after the review it belongs to was superseded or its findings overridden
 * — instructing the Builder to change files nobody is asking about any
 * more. Instead nothing is written until the Builder is at its prompt, and
 * what the card owes is read again in the same breath as the write.
 *
 * Pure — no Tauri, no store import — so it is unit-tested under node.
 */

/** One delivery of one settled verdict (`BuilderReview.at`) into one
 *  Builder session (`ptyId`). In memory: a new session has not had it. */
export interface VerdictDelivery {
  at: number;
  ptyId: string;
  /** The PTY write. 1.171.0 C2 (K3): `sending` while it is under way — a
   *  paste into a slow PTY (Windows' ConPTY) takes a moment, and the card
   *  must not say the Builder hasn't got what its terminal already shows. */
  state: "sending" | "sent" | "failed";
  /** Why the write failed. */
  error?: string;
  /** The card was told the Builder has it. */
  acked?: boolean;
  /** How many times Ply has tried to tell the card. */
  ackAttempts?: number;
  /** When the last attempt to record it was made. */
  ackAttemptAt?: number;
  /** Why the last attempt to record it failed. */
  ackError?: string;
  /** The human pressed Send while the Builder was mid-turn, so the write
   *  that failed is to be tried again at the prompt. Only ever set on a
   *  `failed` delivery: an unsent one already goes by itself. */
  retryRequested?: boolean;
}

/** 1.171.0 C2 (Challenger 6): how long a write into the Builder may take
 *  before it counts as failed (a ConPTY paste takes seconds, not minutes). */
export const VERDICT_WRITE_TIMEOUT_MS = 60_000;

/** Attempts to record one delivery before Ply stops trying and says so.
 *  Bounded, because the retry runs on the card's renders. */
export const VERDICT_ACK_ATTEMPTS = 5;
/** And spaced, so the attempts are not all spent in the same instant: a
 *  board that cannot be written now is usually writable a moment later,
 *  and renders arrive far faster than that. */
export const VERDICT_ACK_RETRY_MS = 2000;

/** The delivery that counts for this verdict in this session, or null. */
export function verdictDeliveryFor(
  delivery: VerdictDelivery | null | undefined,
  at: number,
  ptyId: string | null | undefined,
): VerdictDelivery | null {
  if (!delivery || !ptyId) return null;
  return delivery.at === at && delivery.ptyId === ptyId ? delivery : null;
}

/** Whether a press to send the verdict is offered: the Builder has not had
 *  it, or the write failed and can be tried again. A write that landed is
 *  never offered again — not even when Ply could not record it. */
export function verdictNeedsSending(owed: VerdictOwed | null | undefined): boolean {
  return owed != null && (owed.delivery === "unsent" || owed.delivery === "failed");
}

/** Whether Ply sends it unasked, once the card is open with a live session
 *  at its prompt. A verdict nothing has tried yet — or one whose failed
 *  write the human asked for again while the Builder was mid-turn, which
 *  is the same press, kept until the prompt comes. A failure nobody asked
 *  about again is not retried, so a PTY that keeps refusing is not written
 *  to in a loop. */
export function verdictSendsItself(owed: VerdictOwed | null | undefined): boolean {
  if (owed?.delivery === "unsent") return true;
  return owed?.delivery === "failed" && owed.retryRequested;
}

/** How long until the card is to be told, again, about a write that
 *  landed: 0 when it is due now, null when there is nothing to tell or the
 *  attempts ran out. Bounded by `VERDICT_ACK_ATTEMPTS` and spaced by
 *  `VERDICT_ACK_RETRY_MS`; it never writes into the PTY again.
 *
 *  The caller schedules on this rather than waiting for the card to
 *  re-render: a Builder that has gone quiet produces no renders, and an
 *  unrecorded delivery would otherwise sit at "still recording" for good. */
export function verdictAckRetryIn(
  owed: VerdictOwed | null | undefined,
  now: number,
): number | null {
  if (owed?.delivery !== "unrecorded" || owed.ackAttempts >= VERDICT_ACK_ATTEMPTS) return null;
  if (owed.ackAttemptAt == null) return 0;
  return Math.max(0, owed.ackAttemptAt + VERDICT_ACK_RETRY_MS - now);
}

/** Whether the card is to be told now. */
export function verdictNeedsAcknowledging(
  owed: VerdictOwed | null | undefined,
  now: number,
): boolean {
  return verdictAckRetryIn(owed, now) === 0;
}

export interface VerdictDeliveryDeps {
  /** What the card owes *now*, with this session's delivery folded in. */
  owed(): VerdictOwed | null;
  /** The card's live session and whether it is at its prompt, or null. */
  /** `draft`: 1.174.5: what the person typed is what it waits on. */
  session(): { ptyId: string; idle: boolean; draft?: boolean } | null;
  /** Write into the PTY now. */
  write(ptyId: string, text: string): Promise<void>;
  /** Record on the card that the Builder has this verdict. */
  acknowledge(snapshotN: number, at: number): Promise<void>;
  /** Keep this session's delivery. */
  record(delivery: VerdictDelivery): void;
  now(): number;
  notify(kind: "info" | "warn" | "error", title: string, body: string): void;
  /** Tests: the write's bound (`VERDICT_WRITE_TIMEOUT_MS`). */
  writeTimeoutMs?: number;
}

export type VerdictSendOutcome =
  /** Another send of this card's verdict is already running. */
  | "in-flight"
  /** The card does not owe this verdict any more, or owes it no longer. */
  | "not-owed"
  /** No Builder session to write into. */
  | "no-session"
  /** The Builder is mid-turn; it goes in when it is back at its prompt. */
  | "busy"
  | "sent"
  | "failed";

/** Cards whose verdict is being written. Held across the write only —
 *  never across a wait for the Builder's prompt, which could be minutes
 *  and would keep a newer verdict from going. */
const sending = new Set<string>();
/** Cards whose delivery is being recorded. The retry runs on the card's
 *  renders, which come in bursts, and without this a single hiccup would
 *  spend every attempt in the same millisecond. */
const acking = new Set<string>();

const NO_SESSION_TITLE = "The Builder session is not open";

/**
 * Send `asked` into the card's Builder, once.
 *
 * `reason` is who asked: `auto` is Ply, which says nothing when it cannot
 * act and tries again on the next render; `press` is the human, who is
 * owed an answer either way.
 */
export async function deliverVerdict(
  cardId: string,
  asked: VerdictOwed,
  deps: VerdictDeliveryDeps,
  reason: "auto" | "press",
): Promise<VerdictSendOutcome> {
  if (sending.has(cardId)) {
    // The human is owed an answer either way (owner-side review).
    if (reason === "press") {
      deps.notify("info", "The verdict is already going in", "Plyloft is writing it into the Builder now.");
    }
    return "in-flight";
  }
  sending.add(cardId);
  try {
    return await sendOnce(cardId, asked, deps, reason);
  } finally {
    sending.delete(cardId);
  }
}

async function sendOnce(
  cardId: string,
  asked: VerdictOwed,
  deps: VerdictDeliveryDeps,
  reason: "auto" | "press",
): Promise<VerdictSendOutcome> {
  // Read again, inside the guard: a review that settled since the render
  // that offered this send must not have an older verdict written over it,
  // and one this session already delivered must not be written twice.
  const owed = deps.owed();
  if (!owed || owed.at !== asked.at || !verdictNeedsSending(owed)) return "not-owed";
  const session = deps.session();
  if (!session) {
    if (reason === "press") {
      deps.notify(
        "warn",
        NO_SESSION_TITLE,
        "Resume its session on the card; Plyloft sends the verdict as soon as the session is back.",
      );
    }
    return "no-session";
  }
  if (!session.idle) {
    if (reason === "press") {
      // A failed write is not retried on its own, so the press has to be
      // kept: without this the promise below is one Ply does not keep.
      // It lives on the delivery, so it goes with the verdict and the
      // session it belongs to — a superseded verdict takes it with it.
      if (owed.delivery === "failed") {
        deps.record({
          at: owed.at,
          ptyId: owed.deliveredPtyId ?? session.ptyId,
          state: "failed",
          error: owed.deliveryError ?? undefined,
          retryRequested: true,
        });
      }
      deps.notify(
        "info",
        session.draft ? "The verdict is waiting" : "The Builder is working",
        session.draft
          ? "Send or clear what you typed in the Builder's prompt, and it goes in by itself."
          : "The verdict goes in by itself as soon as the Builder is back at its prompt.",
      );
    }
    return "busy";
  }
  const base = { at: owed.at, ptyId: session.ptyId };
  // 1.171.0 C2 (K3): from the first byte the Builder is getting it; the card
  // says so (never "doesn't have it yet") until the write lands or fails.
  deps.record({ ...base, state: "sending" });
  // (Challenger 6) A write that never settles must not leave `sending` for
  // good: after `VERDICT_WRITE_TIMEOUT_MS` it counts as failed. If it lands
  // after all, it is recorded then — never written a second time.
  const writing = deps.write(session.ptyId, owed.message);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`The write into the Builder session didn't finish within ${Math.round((deps.writeTimeoutMs ?? VERDICT_WRITE_TIMEOUT_MS) / 1000)} seconds.`));
    }, deps.writeTimeoutMs ?? VERDICT_WRITE_TIMEOUT_MS);
  });
  try {
    await Promise.race([writing, timeout]);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error ?? "");
    const why = text.trim() || "The review could not be written into the Builder session.";
    // 1.172.0 E2: Codex's transcript search took it — it goes in again by
    // itself once the search is closed (the session reads as busy while it
    // is open, so nothing is typed meanwhile).
    deps.record({ ...base, state: "failed", error: why, ...(isCodexOverlayError(why) ? { retryRequested: true } : {}) });
    if (timedOut) {
      void writing.then(
        () => {
          const now = deps.owed();
          if (now && now.at === owed.at && now.delivery === "failed" && now.deliveredPtyId === base.ptyId) {
            deps.record({ ...base, state: "sent", acked: false, ackAttempts: 0 });
            void withAckGuard(cardId, () => recordDelivered(base, owed.snapshotN, 0, deps));
          }
        },
        () => undefined,
      );
    }
    // 1.171.0 C2 (Challenger 1, CF11): only findings have a press to send
    // them again; any other review goes in when the session is resumed, and
    // Technical details say so — no toast promising a press that isn't there.
    if (owed.findings) {
      deps.notify(
        "error",
        "The Reviewer's findings did not reach the Builder",
        codexScreenHelp(why, isCodexOverlayError(why)) ?? `${sentence(why)} Send the findings to the Builder sends them again.`,
      );
    }
    return "failed";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // The write landed. Record that first, so a session that goes now still
  // counts as having had it, then tell the card — through the same guard
  // the retry uses, because recording it re-renders the card and its
  // effect would otherwise start a second attempt on top of this one.
  deps.record({ ...base, state: "sent", acked: false, ackAttempts: 0 });
  await withAckGuard(cardId, () => recordDelivered(base, owed.snapshotN, 0, deps));
  return "sent";
}

/** `text` as a sentence: reasons come from PTY and IPC errors, which end
 *  however they end. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Run `attempt` unless this card's delivery is already being recorded. */
async function withAckGuard(cardId: string, attempt: () => Promise<boolean>): Promise<boolean> {
  if (acking.has(cardId)) return false;
  acking.add(cardId);
  try {
    return await attempt();
  } finally {
    acking.delete(cardId);
  }
}

/** Where the caller keeps its timers. Injected, so the schedule below is
 *  driven by a test rather than by waiting for real seconds to pass. */
export interface VerdictAckTimers {
  /** Book `fire` in `delayMs`, replacing any booking this card had. */
  set(cardId: string, delayMs: number, fire: () => void): void;
  clear(cardId: string): void;
}

/**
 * Book the card's next acknowledgement attempt, or cancel its booking when
 * there is nothing left to record. Call it whenever a delivery is
 * recorded — that is the only moment the answer can change.
 *
 * The schedule exists because the card's renders are not a clock: a
 * Builder that has gone quiet causes none, and an unrecorded delivery
 * would sit at "still recording" for good, with the card still owing a
 * verdict the Builder already has — which a restart would then send a
 * second time.
 */
export function scheduleVerdictAck(
  cardId: string,
  deps: VerdictDeliveryDeps,
  timers: VerdictAckTimers,
): void {
  timers.clear(cardId);
  const owed = deps.owed();
  const due = verdictAckRetryIn(owed, deps.now());
  // A delivery just written has made no attempt yet, so its answer is
  // "now": the booking lands behind the send's own attempt, finds the
  // guard held and does nothing. Harmless, and it is the honest answer —
  // suppressing it would leave a write whose inline attempt never ran
  // with no booking at all.
  if (due == null || !owed) return;
  timers.set(cardId, due, () => {
    // Read again rather than carrying the booked verdict: a booking is
    // only ever "see to whatever is due now", and `acknowledgeVerdict`
    // refuses anything that is not — a verdict superseded while we waited
    // is no longer unrecorded, so nothing happens.
    const fresh = deps.owed();
    if (fresh) void acknowledgeVerdict(cardId, fresh, deps);
  });
}

/**
 * Tell the card about a write that landed but was not recorded — after a
 * board that could not be written, say. It never writes into the PTY: the
 * Builder already has the verdict, and the only thing missing is the card
 * knowing it. False when nothing is owed, or the attempts ran out.
 */
export async function acknowledgeVerdict(
  cardId: string,
  asked: VerdictOwed,
  deps: VerdictDeliveryDeps,
): Promise<boolean> {
  return withAckGuard(cardId, async () => {
    const owed = deps.owed();
    if (!owed || owed.at !== asked.at || !verdictNeedsAcknowledging(owed, deps.now())) return false;
    // The session the write went into, as the card matched it — never the
    // one attached right now, which on a resume can already be the next
    // one. Recording a delivery against a session that never had it would
    // hide the verdict from the session that needs it.
    if (!owed.deliveredPtyId) return false;
    return recordDelivered(
      { at: owed.at, ptyId: owed.deliveredPtyId },
      owed.snapshotN,
      owed.ackAttempts,
      deps,
    );
  });
}

/** One attempt to record a delivered verdict on the card. Call it under
 *  `withAckGuard`: two at once spend two of the bounded attempts. */
/**
 * 1.172.0 E2 (round 2, Challenger 3): the verdict sat in Codex's message box
 * unsent (`PASTE_STILL_UNSENT`) and the person pressed Enter in `ptyId`; the
 * screen shows it taken. It is recorded as sent — the same record a write
 * that landed makes — so the card says "Sent to the Builder." and no press
 * pastes it again. False when this card's delivery isn't that one.
 */
export async function verdictSentByHand(
  cardId: string,
  ptyId: string,
  deps: VerdictDeliveryDeps,
): Promise<boolean> {
  const owed = deps.owed();
  if (!owed || owed.delivery !== "failed" || owed.deliveryError !== PASTE_STILL_UNSENT) return false;
  if (owed.deliveredPtyId !== ptyId) return false;
  const base = { at: owed.at, ptyId };
  deps.record({ ...base, state: "sent", acked: false, ackAttempts: 0 });
  return withAckGuard(cardId, () => recordDelivered(base, owed.snapshotN, 0, deps));
}

async function recordDelivered(
  base: { at: number; ptyId: string },
  snapshotN: number,
  attempts: number,
  deps: VerdictDeliveryDeps,
): Promise<boolean> {
  try {
    await deps.acknowledge(snapshotN, base.at);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error ?? "");
    const next = attempts + 1;
    deps.record({
      ...base,
      state: "sent",
      acked: false,
      ackAttempts: next,
      ackAttemptAt: deps.now(),
      ackError: text.trim() || "the card could not be written",
    });
    if (next >= VERDICT_ACK_ATTEMPTS) {
      deps.notify(
        "warn",
        "The Builder has the verdict, but Plyloft could not record it",
        "It is not sent again now; after a restart the card may send it once more.",
      );
    }
    return false;
  }
  deps.record({ ...base, state: "sent", acked: true, ackAttempts: attempts });
  return true;
}
