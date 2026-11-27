/**
 * UX language card 2: the life of a Repository page's draft.
 *
 * A page holds changes nobody else has until Publish sends them. One save
 * carries every changed field, and it can take a while — the channel waits
 * behind a refresh of the repository. What may happen during that wait is
 * the whole of this module, because getting it wrong loses someone's work
 * in a way nothing on screen admits (card #94 review, F1 and F3):
 *
 * - an edit made while the save is out is **refused**, because the draft it
 *   would join is about to be answered by what that save carried, and there
 *   is no baseline to judge it against until then;
 * - `Discard` is refused for the same span: it would drop what the save is
 *   still carrying. Once the save is done it is the person's again, and it
 *   is their way out of a page waiting on a read that keeps failing;
 * - when the save lands, only the keys it carried go, and only while they
 *   still hold what was sent;
 * - when it fails, the draft stays whole, so the person can try again;
 * - and either way the page stays still until a read **succeeds**. The save
 *   applies its fields on this Mac before it queues them, so until Ply has
 *   read them back the values an edit would be judged against are the ones
 *   from before: an edit taken then is pruned against a baseline about to
 *   move, and vanishes when a read finally arrives. A read that failed
 *   brings no values, so it settles nothing.
 *
 * It is one reducer over the events a page sees — an edit, a discard, a
 * save beginning, a save settling, a read completing — so the page is a
 * dispatcher and every branch, the failed read included, is an input a
 * test supplies rather than a decision the page makes on its own with
 * nothing to check it (card #94 review, F3).
 */

import { clearSent, pruneDraft, readField, type Draft, type FieldKey, type Values } from "./repositoryPage.ts";

/** `idle` takes edits. `publishing` is waiting for the save; `settling` is
 *  waiting for a read that succeeds. Neither takes edits. */
export type DraftPhase = "idle" | "publishing" | "settling";

export interface DraftSession {
  draft: Draft;
  phase: DraftPhase;
  /** What the save carried, to clear when it lands. */
  sent: Draft | null;
  /** 1.175.0 (C3, SC-3): per drafted field, the value in use when it was
   *  first edited — what the person changed *from*. The save carries it as
   *  that field's base, so a value a teammate published meanwhile is asked
   *  about, never written over. Absent for a field not drafted. */
  bases: Draft;
  /** C3: the fields the last save carried, until the next edit — the bar
   *  says how many went out beside the ones waiting for a choice. */
  published: string[] | null;
}

/** Everything that can happen to a page's draft. */
export type DraftEvent =
  /** A control was changed. */
  | { kind: "edit"; values: Values | null; next: Partial<Record<FieldKey, unknown>> }
  /** `Discard`, on the bar or in the leaving question. */
  | { kind: "discard" }
  /** Publish was pressed: the save takes the draft as it is now. */
  | { kind: "publishBegan" }
  /** The save came back. */
  | { kind: "publishSaved" }
  | { kind: "publishFailed" }
  /** A read of this repository's settings completed. One that failed
   *  brings no values: the page learns nothing and keeps still. */
  | { kind: "read"; ok: true; values: Values | null }
  | { kind: "read"; ok: false }
  /** What the page is showing changed without a read of its own — a
   *  rename from the sidebar, an accent picked there. Draft keys the
   *  values have caught up with go, but nothing is settled by it: only a
   *  read says what a save did. */
  | { kind: "valuesChanged"; values: Values | null }
  /** A This-Mac save was refused. The keys it tried go back to what is on
   *  disk; one edited again since has its own save on the way and keeps
   *  the newer value. */
  | { kind: "localSaveFailed"; tried: Partial<Record<FieldKey, unknown>> }
  /** The page now belongs to another workspace, or another scope. */
  | { kind: "reset" };

export function emptySession(): DraftSession {
  return { draft: {}, phase: "idle", sent: null, bases: {}, published: null };
}

/** `bases` for `draft`: a key keeps the base it has, a key new to the draft
 *  takes the value in use now, a key no longer drafted loses it. */
function basesFor(draft: Draft, bases: Draft, values: Values | null): Draft {
  const out: Draft = {};
  for (const key of Object.keys(draft) as FieldKey[]) {
    out[key] = key in bases ? bases[key] : readField(key, values);
  }
  return out;
}

/** Whether the page may be edited at all right now: only with a baseline
 *  Ply has really read. */
export function editable(session: DraftSession): boolean {
  return session.phase === "idle";
}

/** Whether the draft may be dropped. Only the save itself holds this back
 *  — it is still carrying those values. */
export function discardable(session: DraftSession): boolean {
  return session.phase !== "publishing";
}

/**
 * The one rule. `accepted` says whether the page got what it asked for: an
 * edit refused while the page holds still leaves its control where it was
 * rather than pretending it took.
 *
 * The same session is returned when nothing moved, so a page can skip the
 * repaint.
 */
export function reduce(
  session: DraftSession,
  event: DraftEvent,
): { session: DraftSession; accepted: boolean } {
  switch (event.kind) {
    case "edit": {
      if (!editable(session)) return { session, accepted: false };
      const draft = pruneDraft(event.values, { ...session.draft, ...event.next });
      // C3: the first edit of a field fixes what it is changed from.
      const bases = basesFor(draft, session.bases, event.values);
      return { session: { ...session, draft, bases, published: null }, accepted: true };
    }
    case "discard": {
      if (!discardable(session)) return { session, accepted: false };
      if (Object.keys(session.draft).length === 0) return { session, accepted: true };
      return { session: { ...session, draft: {}, bases: {} }, accepted: true };
    }
    case "publishBegan": {
      if (session.phase !== "idle") return { session, accepted: false };
      return {
        session: { ...session, phase: "publishing", sent: { ...session.draft } },
        accepted: true,
      };
    }
    case "publishSaved": {
      const draft = clearSent(session.draft, session.sent ?? {});
      return {
        session: {
          draft,
          phase: "settling",
          sent: null,
          bases: basesFor(draft, session.bases, null),
          published: Object.keys(session.sent ?? {}),
        },
        accepted: true,
      };
    }
    case "publishFailed":
      return { session: { ...session, phase: "settling", sent: null }, accepted: true };
    case "read": {
      // A read that failed brings no values: nothing is pruned, and the
      // page is no wiser about what its save did than it was before.
      if (!event.ok) return { session, accepted: false };
      // A read is the one thing that ends the wait for what a save did.
      const phase: DraftPhase = session.phase === "settling" ? "idle" : session.phase;
      return rebased(session, event.values, phase);
    }
    case "valuesChanged":
      return rebased(session, event.values, session.phase);
    case "localSaveFailed": {
      const draft = clearSent(session.draft, event.tried);
      if (Object.keys(draft).length === Object.keys(session.draft).length) {
        return { session, accepted: true };
      }
      return { session: { ...session, draft, bases: basesFor(draft, session.bases, null) }, accepted: true };
    }
    case "reset":
      return { session: emptySession(), accepted: true };
  }
}

/** Draft keys the values have caught up with go — a local save read back,
 *  a field someone else published to the value drafted here, a control
 *  touched and put back (F6). The same session comes back when nothing
 *  moved, so a page can skip the repaint. */
function rebased(
  session: DraftSession,
  values: Values | null,
  phase: DraftPhase,
): { session: DraftSession; accepted: boolean } {
  const before = Object.keys(session.draft).length;
  const pruned = before === 0 ? session.draft : pruneDraft(values, session.draft);
  const draft = Object.keys(pruned).length === before ? session.draft : pruned;
  if (draft === session.draft && phase === session.phase) return { session, accepted: true };
  // C3: a key the values caught up with loses its base; the others keep
  // theirs through the read — what they were changed from doesn't move.
  const bases = draft === session.draft ? session.bases : basesFor(draft, session.bases, null);
  return { session: { ...session, draft, phase, bases }, accepted: true };
}

/** `reduce` for a caller that wants only the session. */
export function apply(session: DraftSession, event: DraftEvent): DraftSession {
  return reduce(session, event).session;
}
