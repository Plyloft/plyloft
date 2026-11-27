import assert from "node:assert/strict";

import type { BuilderReview, KanbanCard } from "../ipc.ts";
import { verdictDetailsNote, verdictOwed, verdictShownAsWork } from "./challengerReview.ts";
import {
  acknowledgeVerdict,
  deliverVerdict,
  VERDICT_ACK_ATTEMPTS,
  VERDICT_ACK_RETRY_MS,
  verdictAckRetryIn,
  scheduleVerdictAck,
  verdictSentByHand,
  type VerdictAckTimers,
  verdictNeedsAcknowledging,
  verdictNeedsSending,
  verdictSendsItself,
  type VerdictDelivery,
  type VerdictDeliveryDeps,
} from "./verdictDelivery.ts";
import { OVERLAY_ALREADY_OPEN, OVERLAY_TOOK_PASTE, PASTE_STILL_UNSENT } from "./builderInject.ts";

// GH #135: the verdict reaches the Builder even when the card was closed
// while the review settled — and reaches it exactly once. This drives the
// coordinator itself and counts what it wrote and what it recorded; the
// store is only the wiring that supplies these deps.

/** One card, one session, one in-memory delivery record — the store's
 *  half, small enough to run here. Counts every PTY write and every
 *  attempt to record a delivery. */
function world(over: { verdictAt?: number; idle?: boolean; session?: boolean } = {}) {
  const review: BuilderReview = {
    snapshotN: 7,
    provider: "codex",
    degraded: false,
    status: "done",
    verdict: "changes_requested",
    builderHandoff: "- F3 — P1",
    at: 42,
  };
  const card: KanbanCard = {
    id: "c1",
    workspaceId: "ws",
    title: "t",
    columnId: "in_progress",
    createdAt: 1,
    updatedAt: 1,
    builder: {
      vendor: "claude",
      bypass: false,
      sessionLost: false,
      startedAt: 1,
      snapshots: [{ n: 7, sha: "e", at: 2 }],
      review,
      undeliveredVerdict: { snapshotN: 7, at: over.verdictAt ?? 42 },
    },
  };
  const state = {
    card,
    /** The attached session, or null when the card has none. */
    ptyId: over.session === false ? null : ("pty-1" as string | null),
    idle: over.idle ?? true,
    record: null as VerdictDelivery | null,
    writes: [] as string[],
    acks: [] as Array<{ snapshotN: number; at: number }>,
    toasts: [] as Array<{ kind: string; title: string }>,
    /** Set to make the next N acknowledgements fail. */
    ackFails: 0,
    writeFails: false,
    /** Resolves the in-flight write, when `holdWrite` is on. */
    releaseWrite: null as (() => void) | null,
    holdWrite: false,
    /** The clock the coordinator reads: tests move it by hand, so a
     *  spaced retry is exercised without waiting for one. */
    now: 1_000_000,
    /** The PTY that is attached, when it is not the one the card names —
     *  the transient a resume opens. */
    attached: null as string | null,
    /** Holds the *first* acknowledgement to enter, when on — later ones
     *  run straight through, so a missing guard shows up as two in flight
     *  rather than as a deadlock. */
    holdAck: false,
    releaseAck: null as (() => void) | null,
    acksInFlight: 0,
    maxAcksInFlight: 0,
  };
  // The card carries `ptyId` too: it is what `verdictOwed` matches a
  // delivery against, so a new session counts as not having received it.
  const syncPty = () => {
    card.builder!.ptyId = state.ptyId;
  };
  syncPty();
  const deps: VerdictDeliveryDeps = {
    owed: () => verdictOwed(state.card.builder, state.record),
    session: () => {
      const pty = state.attached ?? state.ptyId;
      return pty ? { ptyId: pty, idle: state.idle } : null;
    },
    write: async (_pty, text) => {
      if (state.writeFails) throw new Error("pty closed");
      if (state.holdWrite) {
        await new Promise<void>((resolve) => {
          state.releaseWrite = resolve;
        });
      }
      state.writes.push(text);
    },
    acknowledge: async (snapshotN, at) => {
      state.acksInFlight += 1;
      state.maxAcksInFlight = Math.max(state.maxAcksInFlight, state.acksInFlight);
      try {
        if (state.holdAck) {
          state.holdAck = false;
          await new Promise<void>((resolve) => {
            state.releaseAck = resolve;
          });
        }
        if (state.ackFails > 0) {
          state.ackFails -= 1;
          throw new Error("the board could not be written");
        }
        state.acks.push({ snapshotN, at });
        // The backend clears the record; the card reloads without it.
        if (
          state.card.builder!.undeliveredVerdict?.snapshotN === snapshotN &&
          state.card.builder!.undeliveredVerdict?.at === at
        ) {
          state.card.builder!.undeliveredVerdict = null;
        }
      } finally {
        state.acksInFlight -= 1;
      }
    },
    record: (d) => {
      state.record = d;
    },
    notify: (kind, title) => state.toasts.push({ kind, title }),
    now: () => state.now,
  };
  return { state, deps, syncPty, review };
}

const owedNow = (w: ReturnType<typeof world>) => w.deps.owed()!;

/** Bookings on a clock the test turns by hand: `run()` fires the one
 *  booking there is, as a real timer would when its delay elapses. */
function bookings() {
  let booked: { delayMs: number; fire: () => void } | null = null;
  const timers: VerdictAckTimers = {
    set: (_card, delayMs, fire) => {
      booked = { delayMs, fire };
    },
    clear: () => {
      booked = null;
    },
  };
  return {
    timers,
    get delay() {
      return booked?.delayMs ?? null;
    },
    run() {
      const due = booked;
      booked = null;
      due?.fire();
    },
  };
}
/** `Array.prototype.at` is newer than this project's `lib` target. */
const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];

// The review settled with no session mounted: the card owes the verdict,
// and it is sent once when the card is next opened.
{
  const w = world({ session: false });
  w.syncPty();
  const closed = owedNow(w);
  assert.equal(closed.delivery, "unsent", "recorded unsent");
  assert.equal(await deliverVerdict("c1", closed, w.deps, "auto"), "no-session");
  assert.deepEqual(w.state.writes, [], "nothing is written with no session");
  assert.deepEqual(w.state.toasts, [], "and Plyloft does not natter about it");

  // The card is opened: the session attaches and the verdict goes in once.
  w.state.ptyId = "pty-1";
  w.syncPty();
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "auto"), "sent");
  assert.equal(w.state.writes.length, 1);
  assert.match(w.state.writes[0], /The Reviewer \(Codex\).*requests changes/s);
  assert.deepEqual(w.state.acks, [{ snapshotN: 7, at: 42 }]);
  assert.equal(w.state.card.builder!.undeliveredVerdict, null, "the card owes it no longer");

  // Opened again: nothing is owed, so nothing is written.
  assert.equal(w.deps.owed(), null);
  assert.equal(w.state.writes.length, 1, "once, never twice");
}

// Two sends racing — the automatic one and the human's press — write once.
{
  const w = world();
  w.state.holdWrite = true;
  const owed = owedNow(w);
  const first = deliverVerdict("c1", owed, w.deps, "auto");
  const second = deliverVerdict("c1", owed, w.deps, "press");
  assert.equal(await second, "in-flight", "the second finds the first running");
  // Owner-side review: the press is answered, not swallowed.
  assert.match(last(w.state.toasts)?.title ?? "", /already going in/);
  w.state.releaseWrite!();
  assert.equal(await first, "sent");
  assert.equal(w.state.writes.length, 1);

  // The guard is released: a later send is not blocked by the finished one
  // — it simply finds nothing owed.
  assert.equal(await deliverVerdict("c1", owed, w.deps, "press"), "not-owed");
  assert.equal(w.state.writes.length, 1);
}

// Superseded while the Builder was busy: a verdict that waited for the
// prompt is not written once the card stops owing it. (It waits outside
// the Builder's pending queue precisely so this is possible.)
{
  const w = world({ idle: false });
  const owed = owedNow(w);
  assert.equal(await deliverVerdict("c1", owed, w.deps, "auto"), "busy");
  assert.deepEqual(w.state.writes, [], "nothing is written into a Builder mid-turn");
  assert.deepEqual(w.state.toasts, [], "and Plyloft says nothing it was not asked");

  // A newer review settles (or the human accepts the pushback): the
  // backend drops the record, and the waiting verdict is simply not owed.
  w.state.card.builder!.undeliveredVerdict = null;
  w.state.idle = true;
  assert.equal(await deliverVerdict("c1", owed, w.deps, "auto"), "not-owed");
  assert.deepEqual(w.state.writes, [], "an overridden verdict never reaches the Builder");
}

// A newer verdict replaces the one the press was offered for: the older
// message is not written over it.
{
  const w = world();
  const stale = owedNow(w);
  w.state.card.builder!.review = { ...w.review, snapshotN: 8, at: 99, verdict: "approve" };
  w.state.card.builder!.undeliveredVerdict = { snapshotN: 8, at: 99 };
  assert.equal(await deliverVerdict("c1", stale, w.deps, "press"), "not-owed");
  assert.deepEqual(w.state.writes, []);
  // The current one goes.
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "press"), "sent");
  assert.deepEqual(w.state.acks, [{ snapshotN: 8, at: 99 }]);
}

// The write fails: the card says why, the press is offered again, and Ply
// does not retry it by itself.
{
  const w = world();
  w.state.writeFails = true;
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "auto"), "failed");
  assert.deepEqual(w.state.acks, [], "a write that did not land is not recorded as delivered");
  const failed = owedNow(w);
  assert.deepEqual([failed.delivery, failed.deliveryError], ["failed", "pty closed"]);
  assert.deepEqual([verdictNeedsSending(failed), verdictSendsItself(failed)], [true, false]);
  assert.equal(last(w.state.toasts)?.kind, "error");

  // The press sends it again, and this time it lands.
  w.state.writeFails = false;
  assert.equal(await deliverVerdict("c1", failed, w.deps, "press"), "sent");
  assert.equal(w.state.writes.length, 1);
}

// The write lands but the card cannot be told: never a second write, and
// the acknowledgement is retried on its own — without writing again.
{
  const w = world();
  w.state.ackFails = 1;
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "auto"), "sent");
  assert.equal(w.state.writes.length, 1);
  assert.deepEqual(w.state.acks, [], "the record did not take");
  let unrecorded = owedNow(w);
  assert.equal(unrecorded.delivery, "unrecorded");
  assert.equal(verdictNeedsSending(unrecorded), false, "the Builder has it: no second write");
  assert.equal(await deliverVerdict("c1", unrecorded, w.deps, "auto"), "not-owed", "and no send retries it");
  assert.equal(w.state.writes.length, 1);

  // The attempts are spaced: the renders that follow a failure — and they
  // come in bursts — do not spend them all in the same instant.
  assert.equal(verdictNeedsAcknowledging(unrecorded, w.state.now), false, "not yet");
  assert.equal(await acknowledgeVerdict("c1", unrecorded, w.deps), false);
  assert.equal(owedNow(w).ackAttempts, 1, "still the one attempt");
  w.state.now += VERDICT_ACK_RETRY_MS;
  assert.equal(verdictNeedsAcknowledging(owedNow(w), w.state.now), true);

  // And a burst that does arrive after the interval spends one attempt,
  // not four: the retry is guarded the way the write is.
  w.state.ackFails = 2;
  unrecorded = owedNow(w);
  const burst = await Promise.all(
    [0, 1, 2, 3].map(() => acknowledgeVerdict("c1", unrecorded, w.deps)),
  );
  assert.deepEqual(burst, [false, false, false, false], "one attempt, three found it running");
  assert.equal(owedNow(w).ackAttempts, 2, "the first attempt plus this one");
  assert.equal(w.state.writes.length, 1, "and no retry writes into the Builder");
  w.state.ackFails = 0;

  // Storage recovers: the acknowledgement goes through with no PTY write.
  w.state.now += VERDICT_ACK_RETRY_MS;
  unrecorded = owedNow(w);
  assert.equal(await acknowledgeVerdict("c1", unrecorded, w.deps), true);
  assert.deepEqual(w.state.acks, [{ snapshotN: 7, at: 42 }]);
  assert.equal(w.state.writes.length, 1, "still once");
  assert.equal(w.deps.owed(), null);
}

// Acknowledgement that keeps failing is bounded, and says so at the end.
{
  const w = world();
  w.state.ackFails = 99;
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "auto"), "sent");
  let attempts = 1;
  for (;;) {
    w.state.now += VERDICT_ACK_RETRY_MS;
    if (!verdictNeedsAcknowledging(owedNow(w), w.state.now)) break;
    assert.equal(await acknowledgeVerdict("c1", owedNow(w), w.deps), false);
    attempts += 1;
    assert.ok(attempts <= VERDICT_ACK_ATTEMPTS + 1, "it does not retry for ever");
  }
  assert.equal(attempts, VERDICT_ACK_ATTEMPTS);
  assert.equal(owedNow(w).ackAttempts, VERDICT_ACK_ATTEMPTS);
  assert.equal(w.state.writes.length, 1, "no retry ever wrote into the Builder again");
  assert.equal(
    last(w.state.toasts)?.title,
    "The Builder has the verdict, but Plyloft could not record it",
  );
  // And nothing offers to send it again.
  assert.equal(verdictNeedsSending(owedNow(w)), false);
}

// The human presses with no session, or on a Builder mid-turn: they are
// answered either way, where Ply's own attempt stays quiet.
{
  const w = world({ session: false });
  w.syncPty();
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "press"), "no-session");
  assert.equal(last(w.state.toasts)?.title, "The Builder session is not open");

  const busy = world({ idle: false });
  assert.equal(await deliverVerdict("c1", owedNow(busy), busy.deps, "press"), "busy");
  assert.equal(last(busy.state.toasts)?.title, "The Builder is working");
  assert.deepEqual(busy.state.writes, []);
}

// A session that went and came back has not received it: the record is
// per session, so the verdict is sent into the new one.
{
  const w = world();
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "auto"), "sent");
  // Pretend the acknowledgement never reached the card (a lost board
  // write), then the human resumes: a new session, a new delivery.
  w.state.card.builder!.undeliveredVerdict = { snapshotN: 7, at: 42 };
  w.state.ptyId = "pty-2";
  w.syncPty();
  const again = owedNow(w);
  assert.equal(again.delivery, "unsent", "a new session has not had it");
  assert.equal(await deliverVerdict("c1", again, w.deps, "auto"), "sent");
  assert.equal(w.state.writes.length, 2, "one write per session that needed it");
}

// An acknowledgement is recorded against the session the write went into,
// never the one attached now: a resume must not leave the new session
// marked as holding a verdict it was never given.
{
  const w = world();
  w.state.ackFails = 1;
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "auto"), "sent");
  const unrecorded = owedNow(w);
  assert.deepEqual([unrecorded.delivery, unrecorded.deliveredPtyId], ["unrecorded", "pty-1"]);
  w.state.now += VERDICT_ACK_RETRY_MS;
  // The human resumes while the record is still unacknowledged. The card
  // now names pty-2, which never had it, so nothing is owed against
  // pty-1's record and the verdict is simply unsent again.
  w.state.ptyId = "pty-2";
  w.syncPty();
  assert.equal(owedNow(w).delivery, "unsent");
  assert.equal(owedNow(w).deliveredPtyId, null);
  assert.equal(await acknowledgeVerdict("c1", unrecorded, w.deps), false, "nothing to record");
  assert.deepEqual(w.state.acks, [], "pty-2 is never recorded as having had it");
  // It is sent into the new session instead.
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "auto"), "sent");
  assert.equal(w.state.writes.length, 2);
  assert.deepEqual(w.state.acks, [{ snapshotN: 7, at: 42 }]);
}

// A delivery is recorded against the session the write went into, even
// when another is already attached — the store hands the coordinator only
// the session the card names, and the coordinator does not depend on it.
{
  const w = world();
  w.state.ackFails = 1;
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "auto"), "sent");
  assert.equal(owedNow(w).deliveredPtyId, "pty-1");
  // A resume attaches pty-2 while the card still names pty-1.
  w.state.attached = "pty-2";
  w.state.now += VERDICT_ACK_RETRY_MS;
  assert.equal(await acknowledgeVerdict("c1", owedNow(w), w.deps), true);
  // Recorded against pty-1: the card carried on naming it, so pty-2 is
  // never marked as holding a verdict it was never given.
  w.state.card.builder!.undeliveredVerdict = { snapshotN: 7, at: 42 };
  assert.equal(verdictOwed(w.state.card.builder, w.state.record)!.delivery, "sent");
  w.state.card.builder!.ptyId = "pty-2";
  assert.equal(
    verdictOwed(w.state.card.builder, w.state.record)!.delivery,
    "unsent",
    "pty-2 has not had it",
  );
}

// The acknowledgement a send makes takes the same guard as the retry: the
// render that the recorded write triggers cannot start a second attempt
// on top of it.
{
  const w = world();
  w.state.holdAck = true;
  const send = deliverVerdict("c1", owedNow(w), w.deps, "auto");
  // The write has landed and been recorded; the card re-renders and its
  // effect reaches for the acknowledgement while the send's is in flight.
  while (!w.state.releaseAck) await new Promise((r) => setTimeout(r, 0));
  const second = acknowledgeVerdict("c1", owedNow(w), w.deps);
  assert.equal(await second, false, "it finds the send's own acknowledgement running");
  w.state.releaseAck!();
  assert.equal(await send, "sent");
  assert.equal(w.state.maxAcksInFlight, 1, "never two at once");
  assert.deepEqual(w.state.acks, [{ snapshotN: 7, at: 42 }], "recorded once");
  assert.equal(w.state.writes.length, 1);
}

// F4 (owner-side review): a press while the Builder is mid-turn promises
// the verdict goes in at the prompt. A failed write is not retried on its
// own, so that press is kept and honoured — and goes with its verdict.
{
  const w = world();
  w.state.writeFails = true;
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "auto"), "failed");
  assert.equal(verdictSendsItself(owedNow(w)), false, "a failure nobody asked about again waits");

  // The human presses Send, but the Builder has started working.
  w.state.writeFails = false;
  w.state.idle = false;
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "press"), "busy");
  assert.equal(last(w.state.toasts)?.title, "The Builder is working");
  const waiting = owedNow(w);
  assert.deepEqual([waiting.delivery, waiting.retryRequested], ["failed", true]);
  assert.equal(verdictSendsItself(waiting), true, "the press is kept for the prompt");
  assert.match(waiting.status, /It goes in when the Builder is done with what it's doing\.$/);
  assert.deepEqual(w.state.writes, [], "and nothing is written mid-turn");

  // The Builder comes back to its prompt: the press is honoured.
  w.state.idle = true;
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "auto"), "sent");
  assert.equal(w.state.writes.length, 1);
  assert.deepEqual(w.state.acks, [{ snapshotN: 7, at: 42 }]);
}

// That kept press belongs to its verdict: a newer one takes it away, and
// the failure it was for is not retried by itself afterwards.
{
  const w = world();
  w.state.writeFails = true;
  await deliverVerdict("c1", owedNow(w), w.deps, "auto");
  w.state.idle = false;
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "press"), "busy");
  assert.equal(verdictSendsItself(owedNow(w)), true);

  // A newer review settles while the Builder is still working.
  w.state.card.builder!.review = { ...w.review, snapshotN: 8, at: 99, verdict: "approve" };
  w.state.card.builder!.undeliveredVerdict = { snapshotN: 8, at: 99 };
  const now = owedNow(w);
  assert.deepEqual([now.at, now.delivery, now.retryRequested], [99, "unsent", false]);
  // And a second failure needs a second press: one press, one retry.
  w.state.idle = true;
  assert.equal(await deliverVerdict("c1", now, w.deps, "auto"), "failed");
  assert.equal(verdictSendsItself(owedNow(w)), false);
}

// F2 (owner-side review): the next acknowledgement attempt is a schedule
// the caller can book a timer on, not something that waits for a render.
{
  const w = world();
  assert.equal(verdictAckRetryIn(null, w.state.now), null);
  w.state.ackFails = 1;
  await deliverVerdict("c1", owedNow(w), w.deps, "auto");
  // One attempt has been made and failed: the next is due after the gap.
  assert.equal(verdictAckRetryIn(owedNow(w), w.state.now), VERDICT_ACK_RETRY_MS);
  assert.equal(verdictAckRetryIn(owedNow(w), w.state.now + 1500), 500);
  assert.equal(verdictAckRetryIn(owedNow(w), w.state.now + VERDICT_ACK_RETRY_MS), 0, "due");
  // Once it is recorded, nothing more is booked.
  w.state.now += VERDICT_ACK_RETRY_MS;
  assert.equal(await acknowledgeVerdict("c1", owedNow(w), w.deps), true);
  assert.equal(verdictAckRetryIn(w.deps.owed(), w.state.now), null, "nothing left to record");
}

// F2 (owner-side review): the acknowledgement retry runs off its own
// booking, not off the card's renders — and books itself again, spaced,
// until the card is told or the attempts run out.
{
  const w = world();
  const book = bookings();
  // Every record re-books, as the store wires it.
  const record = w.deps.record;
  w.deps.record = (d) => {
    record(d);
    scheduleVerdictAck("c1", w.deps, book.timers);
  };

  w.state.ackFails = 99;
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "auto"), "sent");
  assert.equal(w.state.writes.length, 1);
  assert.equal(w.state.acks.length, 0, "the card could not be told");
  assert.equal(owedNow(w).ackAttempts, 1);

  // Nothing renders from here on: the booking is what keeps it going.
  for (let attempt = 2; attempt <= VERDICT_ACK_ATTEMPTS; attempt += 1) {
    assert.equal(book.delay, VERDICT_ACK_RETRY_MS, `attempt ${attempt} is booked, spaced`);
    w.state.now += VERDICT_ACK_RETRY_MS;
    book.run();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(owedNow(w).ackAttempts, attempt);
    assert.equal(w.state.writes.length, 1, "and never writes into the Builder again");
  }
  // The bound holds: nothing is booked once the attempts ran out.
  assert.equal(book.delay, null, "no booking after the last attempt");
  assert.equal(
    last(w.state.toasts)?.title,
    "The Builder has the verdict, but Plyloft could not record it",
  );
}

// A booking that comes good records the delivery and books nothing more.
{
  const w = world();
  const book = bookings();
  const record = w.deps.record;
  w.deps.record = (d) => {
    record(d);
    scheduleVerdictAck("c1", w.deps, book.timers);
  };
  w.state.ackFails = 1;
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "auto"), "sent");
  assert.equal(book.delay, VERDICT_ACK_RETRY_MS);
  w.state.now += VERDICT_ACK_RETRY_MS;
  book.run();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(w.state.acks, [{ snapshotN: 7, at: 42 }], "recorded, off its own booking");
  assert.equal(book.delay, null, "and nothing more is booked");
  assert.equal(w.deps.owed(), null);
  assert.equal(w.state.writes.length, 1);
}

// A booking whose verdict was superseded while it waited does nothing.
{
  const w = world();
  const book = bookings();
  const record = w.deps.record;
  w.deps.record = (d) => {
    record(d);
    scheduleVerdictAck("c1", w.deps, book.timers);
  };
  w.state.ackFails = 1;
  await deliverVerdict("c1", owedNow(w), w.deps, "auto");
  w.state.card.builder!.review = { ...w.review, snapshotN: 8, at: 99, verdict: "approve" };
  w.state.card.builder!.undeliveredVerdict = { snapshotN: 8, at: 99 };
  assert.equal(book.delay, VERDICT_ACK_RETRY_MS, "a booking stood for the old verdict");
  // Recording anything now cancels it: the booking existed for a verdict
  // the card no longer owes, and nothing re-books it.
  scheduleVerdictAck("c1", w.deps, book.timers);
  assert.equal(book.delay, null, "the stale booking is cancelled, not left to fire");

  w.state.now += VERDICT_ACK_RETRY_MS;
  book.run();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(w.state.acks, [], "the old verdict is not recorded against the new one");
}

// The line never contradicts the status: it says the Builder has not had
// the verdict only while that is true.
{
  const w = world();
  assert.equal(owedNow(w).line, "Claude doesn't have the findings yet");
  w.state.ackFails = 1;
  await deliverVerdict("c1", owedNow(w), w.deps, "auto");
  const had = owedNow(w);
  assert.equal(had.line, "Claude has the findings");
  assert.match(had.status, /^Sent to the Builder/);
}

// 1.171.0 C2 (K3, Windows walk): "Round 1's approval has not reached the
// Builder" showed while the terminal already had the verdict — the paste
// into ConPTY was still under way, and the card said "unsent" until it
// resolved. From the first byte the delivery is `sending`: the card says
// the Builder has it, offers no press and owes nothing to the person.
{
  const w = world();
  w.state.holdWrite = true;
  const going = deliverVerdict("c1", owedNow(w), w.deps, "auto");
  await Promise.resolve();
  const during = owedNow(w);
  assert.equal(during.delivery, "sending");
  assert.equal(during.line, "Claude is getting the findings");
  assert.equal(during.status, "Plyloft is writing it into the session now.");
  assert.equal(verdictNeedsSending(during), false, "no press while it goes in");
  assert.equal(verdictSendsItself(during), false, "and no second write");
  assert.equal(verdictShownAsWork(during, w.review), false, "nothing for the person to handle");
  assert.equal(await deliverVerdict("c1", during, w.deps, "auto"), "in-flight");
  w.state.releaseWrite!();
  assert.equal(await going, "sent");
  assert.deepEqual(w.state.writes.length, 1, "written once");
  // Recorded: the backend cleared it, and nothing is owed.
  assert.equal(w.deps.owed(), null);
}
// 1.172 A3 (Windows walk 2026-10-27-211141): an approval's Technical details
// row follows the delivery — going in while it is written, then gone once
// the card has recorded it. Never "has the review. Going to the Builder now."
{
  const w = world();
  w.state.card.builder!.review = { ...w.review, verdict: "approve" };
  w.state.holdWrite = true;
  const going = deliverVerdict("c1", owedNow(w), w.deps, "auto");
  await Promise.resolve();
  assert.equal(
    verdictDetailsNote(owedNow(w)),
    "Claude is getting the review. Plyloft is writing it into the session now.",
  );
  w.state.releaseWrite!();
  assert.equal(await going, "sent");
  assert.equal(verdictDetailsNote(w.deps.owed()), null, "the row goes once it is recorded");
}
// A write that fails after it began is the person's again (Send again).
{
  const w = world();
  w.state.writeFails = true;
  assert.equal(await deliverVerdict("c1", owedNow(w), w.deps, "auto"), "failed");
  const failed = owedNow(w);
  assert.equal(failed.delivery, "failed");
  assert.equal(failed.line, "Claude doesn't have the findings yet");
  assert.equal(verdictShownAsWork(failed, w.review), true);
}
// An approval is never the person's to handle — not unsent, not sending,
// not failed: Plyloft delivers it at the next prompt and Technical details
// say so.
{
  const w = world();
  w.state.card.builder!.review = { ...w.review, verdict: "approve" };
  const unsent = owedNow(w);
  assert.equal(unsent.delivery, "unsent");
  assert.equal(verdictShownAsWork(unsent, w.state.card.builder!.review), false);
  assert.equal(verdictDetailsNote(unsent), "Claude doesn't have the review yet. The Builder has not received it. Plyloft sends it as soon as the Builder is done with what it's doing.");
  assert.ok(!/Round \d/.test(unsent.line), "no round number");
  w.state.writeFails = true;
  await deliverVerdict("c1", unsent, w.deps, "auto");
  assert.equal(verdictShownAsWork(owedNow(w), w.state.card.builder!.review), false, "a failed write of an approval is still no banner");
  // (Challenger 1) No toast promising a press that doesn't exist; the note
  // says Resume sends it (a new session hasn't had it).
  assert.deepEqual(w.state.toasts, []);
  assert.match(owedNow(w).status, /It goes in when you Resume the session\.$/);
}
// Findings whose write failed: the toast names the press that sends them.
{
  const w = world();
  w.state.writeFails = true;
  await deliverVerdict("c1", owedNow(w), w.deps, "auto");
  assert.deepEqual(last(w.state.toasts), { kind: "error", title: "The Reviewer's findings did not reach the Builder" });
}
// (Challenger 6) A write that never settles turns `sending` into `failed`
// after the bound; if it lands later it is recorded, never written twice.
{
  const w = world();
  w.state.holdWrite = true;
  w.deps.writeTimeoutMs = 20;
  const outcome = await deliverVerdict("c1", owedNow(w), w.deps, "auto");
  assert.equal(outcome, "failed");
  const stuck = owedNow(w);
  assert.equal(stuck.delivery, "failed");
  assert.match(stuck.deliveryError ?? "", /didn't finish within 0 seconds/);
  assert.equal(verdictShownAsWork(stuck, w.review), true, "the findings are the person's again");
  w.state.releaseWrite!();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(w.state.writes.length, 1, "written once");
  assert.equal(w.deps.owed(), null, "the late write is recorded as delivered");
}

// 1.172.0 E2 (Windows walk 2026-10-28): Codex's transcript search took the
// review's keys; the write resolved and the card said "Sent". Now the write
// rejects, and the delivery is "failed" — never "sent", never acknowledged.
for (const why of [OVERLAY_TOOK_PASTE, OVERLAY_ALREADY_OPEN, PASTE_STILL_UNSENT]) {
  const w = world();
  w.state.card.builder!.review = { ...w.review, verdict: "approve" };
  const records: string[] = [];
  const deps: VerdictDeliveryDeps = {
    ...w.deps,
    write: async () => {
      throw new Error(why);
    },
    record: (d) => {
      records.push(d.state);
      w.deps.record(d);
    },
  };
  assert.equal(await deliverVerdict("c1", owedNow(w), deps, "auto"), "failed");
  assert.deepEqual(records, ["sending", "failed"], "never recorded as sent");
  assert.equal(w.state.acks.length, 0, "the card is not told it was delivered");
  const failed = owedNow(w);
  assert.deepEqual([failed.delivery, failed.deliveryError], ["failed", why]);
  // (Challenger 1, round 2 Challenger 2) Only a search that was already
  // open — nothing typed — goes in again by itself once the session is back
  // at its prompt. A search that took part of it, or a message left in the
  // composer, waits for the person's press: a resend the moment the search
  // closed would land after the leftover.
  assert.equal(verdictSendsItself(failed), why === OVERLAY_ALREADY_OPEN, "goes in again by itself only when nothing was typed");
  assert.equal(failed.retryRequested, why === OVERLAY_ALREADY_OPEN);
  assert.equal(failed.sendLabel, "Send it again");
}
// Findings the search took: the toast says what to do there.
{
  const w = world();
  const deps: VerdictDeliveryDeps = {
    ...w.deps,
    write: async () => {
      throw new Error(OVERLAY_TOOK_PASTE);
    },
  };
  await deliverVerdict("c1", owedNow(w), deps, "auto");
  assert.deepEqual(last(w.state.toasts), { kind: "error", title: "The Reviewer's findings did not reach the Builder" });
}

// Round 2 (Challenger 1): the search open — the session reads as busy, so
// the card's renders send nothing; once it is closed (idle again), exactly
// one resend.
{
  const w = world();
  w.state.card.builder!.review = { ...w.review, verdict: "approve" };
  w.state.record = { at: 42, ptyId: "pty-1", state: "failed", error: OVERLAY_ALREADY_OPEN, retryRequested: true };
  w.state.idle = false;
  for (let i = 0; i < 3; i++) {
    const owed = owedNow(w);
    if (verdictSendsItself(owed)) assert.equal(await deliverVerdict("c1", owed, w.deps, "auto"), "busy");
  }
  assert.equal(w.state.writes.length, 0, "nothing typed while the search is open");
  w.state.idle = true;
  for (let i = 0; i < 3; i++) {
    const owed = w.deps.owed();
    if (owed && verdictSendsItself(owed)) await deliverVerdict("c1", owed, w.deps, "auto");
  }
  assert.equal(w.state.writes.length, 1, "exactly one resend");
}
// Round 2 (Challenger 3): left unsent, then the person's Enter took it — the
// card says "Sent to the Builder." and offers no press.
{
  const w = world();
  w.state.card.builder!.review = { ...w.review, verdict: "approve" };
  w.state.record = { at: 42, ptyId: "pty-1", state: "failed", error: PASTE_STILL_UNSENT };
  assert.equal(await verdictSentByHand("c1", "pty-2", w.deps), false, "another session's Enter");
  assert.equal(await verdictSentByHand("c1", "pty-1", w.deps), true);
  assert.equal(w.state.writes.length, 0, "nothing typed");
  assert.equal(w.state.acks.length, 1, "recorded on the card");
  assert.equal(w.deps.owed(), null, "owed nothing more");
  // A failure of another kind is not "sent by hand".
  const v = world();
  v.state.record = { at: 42, ptyId: "pty-1", state: "failed", error: "pty closed" };
  assert.equal(await verdictSentByHand("c1", "pty-1", v.deps), false);
}

console.log("verdict delivery tests passed");
