/**
 * QoL 1.168 (F3): a system notification when a card needs its person — the
 * moments someone walks away for: Finish and check ends (ready to ship,
 * changes requested, checks failed), a ship finishes or fails. A pull
 * request's checks failing on GitHub is told by Rust's poller
 * (`pr_status::notify`), so its rows are left out here.
 *
 * Decided from the reconciled feed (`lib/inboxReconcile.ts`), the rows every
 * count reads, with the session notifier's rules (`waitingNotify.ts`):
 *
 * - the first look only records: what is already there is not news;
 * - a row is news once, when it first appears unseen (F1 gives every round
 *   its own id, so a second round is news again); a row older than
 *   `FRESH_MS` is not (a board loading late adds rows for old cards);
 * - not while the person looks at that workspace's Board (the card moves
 *   there, or its page is open);
 * - a workspace whose board loads at this look (a relaunch, a workspace
 *   warmed) brings rows the frontend adds for its cards: those are what
 *   already was, not news;
 * - one card is told about at most once a minute — by the shared gate
 *   (`notifyGate.ts`), whichever notifier tells it;
 * - more than `MAX_SEPARATE` at one look are one notification
 *   (`collapseNotices`: a Ship batch is not five banners).
 *
 * Pure: the tracker is a value.
 */
import type { InboxEvent, InboxFeed, InboxEventKind } from "../ipc";
import { CARD_ROW_PREFIX, type ReconciledEvent } from "./inboxReconcile.ts";
import { inboxRowWords, isFailureRow } from "./inboxView.ts";
import type { OnScreen } from "./seenOnScreen.ts";

/** A row older than this when it first shows is not news. */
export const FRESH_MS = 10 * 60_000;

/** The card rows a notification is about: what Finish and check, a ship or a
 *  run of the card ends on. Not the pull request's (Rust tells those). */
const CARD_KINDS: ReadonlySet<InboxEventKind> = new Set(["review_needed", "card_failed", "verify_failed"]);

export type CardNotice = {
  /** The row's id: the episode. */
  id: string;
  workspaceId: string;
  cardId: string;
  /** The card's title, for the click's offer toast. */
  cardTitle: string;
  title: string;
  body: string;
};

export type CardTracker = {
  /** The row ids seen at the last look; null before the first. */
  ids: ReadonlySet<string> | null;
  /** The workspaces whose boards were loaded at the last look. */
  loaded: ReadonlySet<string>;
};

export const EMPTY_CARD_TRACKER: CardTracker = { ids: null, loaded: new Set() };

/** More notices than this at one look are one notification. */
export const MAX_SEPARATE = 2;

function newsworthy(e: InboxEvent): boolean {
  if (!e.cardId) return false;
  if (e.group === "shipped") return e.kind === "shipped";
  // F1: Failed folded into Needs you.
  if (e.group !== "needs_you") return false;
  return CARD_KINDS.has(e.kind) && e.seenEligible && e.seenAt == null;
}

/** The notification's words: the Inbox row's, then where. */
export function cardNotification(e: ReconciledEvent, workspaceName: string): { title: string; body: string } {
  const where = `${workspaceName || "A workspace"} · ${e.title}`;
  if (e.group === "shipped") return { title: "Shipped", body: e.detail ? `${where} · ${e.detail}` : where };
  const detail = e.presented?.detail ?? inboxRowWords(e).detail;
  return {
    title: detail ?? (isFailureRow(e) ? "Something failed" : "A card needs you"),
    body: where,
  };
}

export function cardsToNotify(
  tracker: CardTracker,
  feed: InboxFeed | null,
  onScreen: OnScreen,
  now: number,
  workspaceName: (id: string) => string,
  /** The workspaces whose boards are loaded now. */
  loaded: ReadonlySet<string> = new Set(),
): { notify: CardNotice[]; next: CardTracker } {
  // No feed yet: nothing is known, and the first look waits for one.
  if (!feed) return { notify: [], next: tracker };
  const rows = feed.events.filter(newsworthy);
  const ids = new Set(rows.map((e) => e.id));
  if (tracker.ids === null) return { notify: [], next: { ids, loaded } };
  const notify: CardNotice[] = [];
  for (const e of rows) {
    if (tracker.ids.has(e.id)) continue;
    if (e.id.startsWith(CARD_ROW_PREFIX) && !tracker.loaded.has(e.workspaceId)) continue;
    if (e.at == null || now - e.at > FRESH_MS) continue;
    if (onScreen && onScreen.workspaceId === e.workspaceId && onScreen.mode === "board") continue;
    // One notice per card per look: its first row says it.
    if (notify.some((n) => n.workspaceId === e.workspaceId && n.cardId === e.cardId)) continue;
    notify.push({
      id: e.id,
      workspaceId: e.workspaceId,
      cardId: e.cardId!,
      cardTitle: e.title,
      ...cardNotification(e, workspaceName(e.workspaceId)),
    });
  }
  return { notify, next: { ids, loaded } };
}

/** One look's notices as notifications: each on its own, or — past
 *  `MAX_SEPARATE` — one that counts them and opens the Inbox. */
export function collapseNotices(
  notices: readonly CardNotice[],
): { title: string; body: string; card: CardNotice | null }[] {
  if (notices.length <= MAX_SEPARATE) return notices.map((n) => ({ title: n.title, body: n.body, card: n }));
  const names = notices.map((n) => n.body.split(" · ").slice(1).join(" · ")).filter(Boolean);
  return [{ title: noticesTitle(notices), body: names.join(", "), card: null }];
}

/** "3 cards: 2 shipped, 1 needs you". */
export function noticesTitle(notices: readonly Pick<CardNotice, "title">[]): string {
  const shipped = notices.filter((n) => n.title === "Shipped").length;
  const rest = notices.length - shipped;
  const parts: string[] = [];
  if (shipped > 0) parts.push(`${shipped} shipped`);
  if (rest > 0) parts.push(rest === 1 ? "1 needs you" : `${rest} need you`);
  return `${notices.length} cards: ${parts.join(", ")}`;
}
