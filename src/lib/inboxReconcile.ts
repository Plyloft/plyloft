/**
 * UX P1 point 2 (P-A): how the Inbox and the Board are kept from
 * disagreeing. Rust decides which rows exist, their ids and what was seen
 * (`inbox.rs::derive_card_events`); for a card whose board is loaded,
 * `presentCard(...).inbox` is the truth about its group. The record-only
 * groups are held equal on both sides by the shared fixtures
 * (`attention.fixtures.json`); what Rust never sees — a "Not right" sent to
 * the Builder, a ship press that failed, a question in a live session — is
 * reconciled here, one card at a time:
 *
 * - a Rust row for such a card in another group is shown in the card's
 *   group (hidden instead when the card already has its live session's row,
 *   so one ask is one row); a Rust row when the card's group is none is
 *   hidden and not counted;
 * - a card that needs the person and has no row gets one, with a stable id
 *   (`card:<rule>:<card>:<round>`) kept in the same seen file;
 * - a cold workspace keeps Rust's rows unchanged.
 *
 * Every count built from the feed reads the reconciled one (`useNeedsYou`):
 * the sidebar's Inbox row, the switcher, the dock, the Inbox page. Pure.
 */
import type { InboxEvent, InboxFeed, KanbanCard } from "../ipc.ts";
import { OPEN_CARD_ACTION, SHIP_IT_ACTION, boardNextPress, type CardPresentation } from "./cardPresentation.ts";
import { isFailureRow } from "./inboxView.ts";
import type { WaitingSession } from "./needsYou.ts";

/** The row's words when the card's rule says them (P-A). */
export type PresentedWords = {
  detail: string;
  action: string | null;
  /** UX P-A Mac walk 2: the action ships the card ("Ship it"). */
  ship?: boolean;
};

/** The card's own words for its row, when its rule says them. */
function wordsOf(inbox: { detail: string | null; action: string | null; ship?: boolean }): PresentedWords | undefined {
  if (!inbox.detail) return undefined;
  return { detail: inbox.detail, action: inbox.action, ...(inbox.ship ? { ship: true } : {}) };
}

/**
 * UX P-B Mac walk 2: a row of a loaded card never falls back to Rust's
 * generic "The work is done · review it" with Review (UX P1's "never seen"
 * list): the card's presentation says what it is. Null when Rust's row has
 * words of its own (changes requested, a serious finding, a conflict).
 */
function genericRowWords(ev: InboxEvent, presentation: CardPresentation): PresentedWords | undefined {
  if (ev.kind !== "review_needed" || ev.detail != null) return undefined;
  return { detail: presentation.headline, action: OPEN_CARD_ACTION };
}

/**
 * 1.173.0 (F1, owner decision 2): a loaded card's Needs you row says what its
 * Board card says — the headline ("Checks failed", "Session closed") and the
 * Board's one press (`boardNextPress`: See what failed, Resume, Finish and
 * check…), Open card when the Board shows none. On hold says the headline
 * and the card's primary (Paused when Plyloft closed → Resume). The row
 * ships only where the Board's press is Ship it. Running rows keep their
 * words.
 */
export function cardRowWords(presentation: CardPresentation, group: InboxEvent["group"]): PresentedWords | undefined {
  // A row the card's column doesn't hold (G5's Bring this computer up to
  // date on a Done card) keeps its own words.
  // 1.175.0 B2: the checks wait for this Mac's OK — the row says so (and
  // that the round fixing checks by itself waits for it) and opens the card,
  // where the two versions are; Allow and run is pressed there.
  if (group === "needs_you" && presentation.rule === "checks-ok" && presentation.inbox.detail) {
    return { detail: presentation.inbox.detail, action: OPEN_CARD_ACTION };
  }
  if (group === "needs_you" && presentation.column === "needs-you") {
    // Challenger 5: the press is the Board's, always. Only when the Board's
    // press is Ship it does the row's Ship it open the card's Ship step
    // (QoL 1.168 S1-4); a card whose result isn't read yet says See the
    // review here as there.
    const press = boardNextPress(presentation) ?? OPEN_CARD_ACTION;
    return { detail: presentation.headline, action: press, ...(press === SHIP_IT_ACTION ? { ship: true } : {}) };
  }
  if (group === "on_hold" && presentation.column === "waiting") {
    return { detail: presentation.headline, action: presentation.action.label.trim() || OPEN_CARD_ACTION };
  }
  return undefined;
}

/** A feed row, with the card's words when a rule gives them. */
export type ReconciledEvent = InboxEvent & { presented?: PresentedWords };

export const CARD_ROW_PREFIX = "card:";

/** The stable id of a row the frontend adds for a card. */
export function cardRowId(card: Pick<KanbanCard, "id" | "builder">, rule: string): string {
  const round = (card.builder?.snapshots ?? []).reduce((n, s) => Math.max(n, s.n), 0);
  return `${CARD_ROW_PREFIX}${rule}:${card.id}:${round}`;
}

export type ReconcileInput = {
  feed: InboxFeed | null;
  /** The loaded boards' cards, each with its presentation. A workspace not
   *  in here is cold: its rows stay as Rust made them. */
  loaded: ReadonlyMap<string, ReadonlyArray<{ card: KanbanCard; presentation: CardPresentation }>>;
  /** Cards that already have a live session's row (`waitingSessions`). */
  waitingCards: ReadonlySet<string>;
};

function key(workspaceId: string, cardId: string): string {
  return `${workspaceId}::${cardId}`;
}

export function reconcileFeed(input: ReconcileInput): InboxFeed | null {
  const { feed } = input;
  if (!feed) return feed;
  const byKey = new Map<string, { card: KanbanCard; presentation: CardPresentation }>();
  for (const [ws, entries] of input.loaded) for (const e of entries) byKey.set(key(ws, e.card.id), e);

  let changed = false;
  const events: ReconciledEvent[] = [];
  const hasRow = new Set<string>();
  const moved = new Set<string>();
  // F1 (one count): one row per loaded card in a group — the Board shows the
  // card once, so a failed run and failed checks are one Needs you row.
  const rowed = new Set<string>();
  const once = (k: string, group: InboxEvent["group"]): boolean => {
    const g = `${k}::${group}`;
    if (rowed.has(g)) return false;
    rowed.add(g);
    return true;
  };
  for (const ev of feed.events) {
    const entry = ev.cardId && ev.group !== "shipped" ? byKey.get(key(ev.workspaceId, ev.cardId)) : undefined;
    const inbox = entry?.presentation.inbox;
    if (!entry || !inbox || !inbox.live) {
      if (ev.cardId && ev.group !== "shipped") hasRow.add(key(ev.workspaceId, ev.cardId));
      if (entry && !once(key(ev.workspaceId, ev.cardId!), ev.group)) {
        changed = true;
        continue;
      }
      const words = entry
        ? cardRowWords(entry.presentation, ev.group) ?? genericRowWords(ev, entry.presentation)
        : undefined;
      if (words) changed = true;
      events.push(words ? { ...ev, presented: words } : ev);
      continue;
    }
    const k = key(ev.workspaceId, ev.cardId!);
    if (inbox.group === null) {
      changed = true;
      continue;
    }
    // The card's row is its live session's: Rust's row for it folds into
    // that one — in another group, or (UX P-B Mac walk 1) in the same one,
    // as "Changes requested" beside "Claude is waiting for your answer".
    if ((ev.group !== inbox.group || inbox.sessionRow) && input.waitingCards.has(k)) {
      changed = true;
      continue;
    }
    hasRow.add(k);
    // A row moved to another group says what the card says: Rust's words
    // were for the group it left ("review it" is not a Running row).
    const presented =
      cardRowWords(entry.presentation, inbox.group) ??
      (inbox.detail
        ? wordsOf(inbox)
        : ev.group !== inbox.group
          ? { detail: entry.presentation.headline, action: null }
          : genericRowWords(ev, entry.presentation));
    if (ev.group !== inbox.group && moved.has(k)) {
      // (Challenger) Rust may have two rows for the card (a failed run and
      // failed checks); moved into the card's group in the card's words,
      // they would be the same row twice.
      changed = true;
      continue;
    }
    if (ev.group !== inbox.group) moved.add(k);
    if (!once(k, inbox.group)) {
      changed = true;
      continue;
    }
    if (ev.group !== inbox.group || presented) {
      changed = true;
      events.push({ ...ev, group: inbox.group, ...(presented ? { presented } : {}) });
    } else {
      events.push(ev);
    }
  }

  // A card that needs the person and has no row gets one.
  const seen = feed.cardSeen ?? {};
  for (const [ws, entries] of input.loaded) {
    for (const { card, presentation } of entries) {
      const inbox = presentation.inbox;
      if (!inbox.live || (inbox.group !== "needs_you" && inbox.group !== "on_hold")) continue;
      const k = key(ws, card.id);
      if (hasRow.has(k) || input.waitingCards.has(k)) continue;
      const id = cardRowId(card, presentation.rule);
      changed = true;
      events.push({
        id,
        kind: "review_needed",
        group: inbox.group,
        workspaceId: ws,
        workspaceName: feed.events.find((e) => e.workspaceId === ws)?.workspaceName ?? "",
        cardId: card.id,
        runId: null,
        title: card.title,
        detail: null,
        url: null,
        at: card.updatedAt,
        seenAt: seen[id] ?? null,
        seenEligible: true,
        presented: cardRowWords(presentation, inbox.group) ?? wordsOf(inbox),
      });
    }
  }
  // F1 (Challenger 2): one row per card and group in every workspace, cold
  // ones too — Rust can row one card several times (failed checks, the
  // auto-fix stop, a request for changes, a conflict). A failure is the row
  // kept, so the card still reads as failed.
  const deduped = onePerCard(events);
  if (deduped !== events) return { ...feed, events: deduped };
  return changed ? { ...feed, events } : feed;
}

/** One row per workspace, card and group; a failure wins the place of the
 *  card's first row. Rows with no card, and ships, are left as they are. */
export function onePerCard<E extends InboxEvent>(events: readonly E[]): E[] {
  const at = new Map<string, number>();
  const out: E[] = [];
  let dropped = false;
  for (const ev of events) {
    if (!ev.cardId || ev.group === "shipped" || ev.group === "news") {
      out.push(ev);
      continue;
    }
    const k = `${ev.workspaceId}::${ev.cardId}::${ev.group}`;
    const i = at.get(k);
    if (i === undefined) {
      at.set(k, out.length);
      out.push(ev);
      continue;
    }
    dropped = true;
    if (isFailureRow(ev) && !isFailureRow(out[i])) out[i] = ev;
  }
  return dropped ? out : (events as E[]);
}

/**
 * UX P-B Mac walk 1: one card, one row. A waiting Builder's row
 * ("Claude has stopped") whose card's presentation does not speak for the
 * session (its rule is not 6–9: "Challenger requests changes", checks
 * failed) folds into the card's own row of the reconciled feed — the card's
 * presentation decides the words. A Builder whose card has no Needs you
 * row keeps its session row, so the wait is never lost; a session
 * row its card speaks for (`inbox.sessionRow`) is the card's row already.
 * Tiles, the trust question, intakes and plans are untouched. Returns
 * `waiting` itself when nothing folds.
 */
export function foldWaitingIntoCardRows<W extends WaitingSession>(
  waiting: readonly W[],
  feed: InboxFeed | null,
  loaded: ReconcileInput["loaded"],
): readonly W[] {
  if (!feed || waiting.length === 0) return waiting;
  const rowed = new Set<string>();
  for (const e of feed.events) {
    if (e.cardId && e.group === "needs_you") rowed.add(key(e.workspaceId, e.cardId));
  }
  const presented = new Map<string, CardPresentation>();
  for (const [ws, entries] of loaded) for (const e of entries) presented.set(key(ws, e.card.id), e.presentation);
  const out = waiting.filter((s) => {
    if (s.target.kind !== "card" || s.session == null) return true;
    const k = key(s.workspaceId, s.target.cardId);
    const p = presented.get(k);
    if (!p || p.inbox.sessionRow) return true;
    return !rowed.has(k);
  });
  return out.length === waiting.length ? waiting : out;
}

