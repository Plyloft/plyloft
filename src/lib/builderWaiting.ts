/**
 * UX P1 point 4 (P-B): a Builder waiting on the person goes to Needs you.
 *
 * The Inbox already counts a waiting Builder (`needsYou.ts::waitingSessions`);
 * the Board's column and every card surface's words read the same derivation,
 * indexed by card here — one function decides "waiting" for the count, the
 * Inbox row and the column. A session not attached in this window is not
 * judged, as in the Inbox (open question 9).
 *
 * "Quiet" is ten seconds of silence, so a card could hop between columns.
 * The hold keeps it waiting until the session is no longer waiting *and*
 * three seconds have passed; a new wait (or another kind of wait) shows at
 * once. Pure: the store (`store/builderWaitingStore.ts`) applies it on the
 * app's one-second attention tick.
 */
import type { BuildLaneId } from "../ipc.ts";
import type { BuilderWaitingState, WaitingSession } from "./needsYou.ts";

/** How long a card stays waiting after its session stopped waiting. */
export const BUILDER_WAITING_HOLD_MS = 3_000;

export type BuilderWaitingEntry = {
  state: BuilderWaitingState;
  vendor: "claude" | "codex";
  /** One of the two builds of a card built by both (SL-6). */
  lane?: BuildLaneId;
  /** Set once the session stopped waiting: the entry goes at this time. */
  releaseAt: number | null;
};

/** Keyed by `workspaceId::cardId`. */
export type BuilderWaitingByCard = Readonly<Record<string, BuilderWaitingEntry>>;

export function builderWaitingKey(workspaceId: string, cardId: string): string {
  return `${workspaceId}::${cardId}`;
}

/** The waiting Builders of `waitingSessions`, one per card. A card's own
 *  Builder wins over its builds; of two builds, the first listed. */
export function waitingBuildersByCard(
  waiting: readonly WaitingSession[],
): Map<string, Omit<BuilderWaitingEntry, "releaseAt">> {
  const out = new Map<string, Omit<BuilderWaitingEntry, "releaseAt">>();
  for (const s of waiting) {
    if (s.target.kind !== "card" || s.session == null || s.question != null) continue;
    const key = builderWaitingKey(s.workspaceId, s.target.cardId);
    const lane = s.target.lane;
    const prev = out.get(key);
    if (prev && (prev.lane == null || lane != null)) continue;
    out.set(key, {
      state: s.session,
      vendor: s.vendor ?? (s.agent === "Codex" ? "codex" : "claude"),
      ...(lane ? { lane } : {}),
    });
  }
  return out;
}

function sameEntry(a: BuilderWaitingEntry, b: BuilderWaitingEntry): boolean {
  return a.state === b.state && a.vendor === b.vendor && a.lane === b.lane && a.releaseAt === b.releaseAt;
}

/**
 * The next waiting set: a card waiting now is in it at once, in its current
 * state; one that stopped waiting stays, unchanged, until `holdMs` after
 * it stopped. Returns `prev` itself when nothing changed, so a store that
 * keeps it does not redraw every second.
 */
export function holdBuilderWaiting(
  prev: BuilderWaitingByCard,
  waitingNow: ReadonlyMap<string, Omit<BuilderWaitingEntry, "releaseAt">>,
  now: number,
  holdMs: number = BUILDER_WAITING_HOLD_MS,
): BuilderWaitingByCard {
  const next: Record<string, BuilderWaitingEntry> = {};
  let changed = false;
  for (const [key, entry] of waitingNow) {
    const e: BuilderWaitingEntry = { ...entry, releaseAt: null };
    next[key] = e;
    const old = prev[key];
    if (!old || !sameEntry(old, e)) changed = true;
  }
  for (const [key, old] of Object.entries(prev)) {
    if (waitingNow.has(key)) continue;
    const releaseAt = old.releaseAt ?? now + holdMs;
    if (now >= releaseAt) {
      changed = true;
      continue;
    }
    next[key] = old.releaseAt === releaseAt ? old : { ...old, releaseAt };
    if (old.releaseAt !== releaseAt) changed = true;
  }
  return changed ? next : prev;
}
