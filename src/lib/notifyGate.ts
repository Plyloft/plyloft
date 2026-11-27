/**
 * QoL 1.168 (Challenger 4): one gate every Plyloft notification from the
 * window goes through — the session notifier and the card notifier — so they
 * don't speak twice:
 *
 * - one card is told about at most once a `CARD_COOLDOWN_MS`, whichever
 *   notifier tells it (its Builder waiting, its row ready to ship);
 * - at most `BURST_MAX` banners in any `BURST_MS`; the rest wait, and once
 *   there is room again one banner says "N more updates" and opens the
 *   Inbox (`flushGate`).
 *
 * Pure: the gate is a value.
 */
export const CARD_COOLDOWN_MS = 60_000;
export const BURST_MAX = 3;
export const BURST_MS = 30_000;

export type Gate = {
  cardSentAt: ReadonlyMap<string, number>;
  /** When each banner of the last `BURST_MS` went out. */
  banners: readonly number[];
  /** Updates held back since the last banner there was room for. */
  held: number;
};

export const EMPTY_GATE: Gate = { cardSentAt: new Map(), banners: [], held: 0 };

function recent(banners: readonly number[], now: number): number[] {
  return banners.filter((at) => now - at < BURST_MS);
}

/** May a notification about `cardKey` (`<workspace>::<card>`, or null for
 *  one about no card) go out now? A card told about within the cooldown is
 *  dropped (its news is out); past the burst it is held, to be counted. */
export function admit(gate: Gate, cardKey: string | null, now: number): { ok: boolean; next: Gate } {
  const cardSentAt = new Map(gate.cardSentAt);
  for (const [k, at] of cardSentAt) if (now - at >= CARD_COOLDOWN_MS) cardSentAt.delete(k);
  if (cardKey != null && cardSentAt.has(cardKey)) return { ok: false, next: { ...gate, cardSentAt } };
  const banners = recent(gate.banners, now);
  if (cardKey != null) cardSentAt.set(cardKey, now);
  if (banners.length >= BURST_MAX) return { ok: false, next: { cardSentAt, banners, held: gate.held + 1 } };
  return { ok: true, next: { cardSentAt, banners: [...banners, now], held: gate.held } };
}

/** Once there is room again, the held updates as one banner's count. */
export function flushGate(gate: Gate, now: number): { summary: number | null; next: Gate } {
  if (gate.held === 0) return { summary: null, next: gate };
  const banners = recent(gate.banners, now);
  if (banners.length >= BURST_MAX) return { summary: null, next: { ...gate, banners } };
  return { summary: gate.held, next: { ...gate, banners: [...banners, now], held: 0 } };
}

/** The held updates' banner. */
export function heldWords(n: number): { title: string; body: string } {
  return { title: n === 1 ? "1 more update" : `${n} more updates`, body: "Open the Inbox to see them." };
}
